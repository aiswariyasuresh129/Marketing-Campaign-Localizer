#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][guid]$JobId,
    [string]$RevisionPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)

function Send-Update($data) {
    [Console]::WriteLine(($data | ConvertTo-Json -Depth 20 -Compress))
}

try {
    $token = ConvertTo-SecureString -String $env:ZOOWORK_API_KEY -AsPlainText -Force
    $agentId = $env:ZOOWORK_AGENT_ID
    if ($agentId -notmatch '^agt_[a-zA-Z0-9_-]+$') { throw 'Invalid ZooWork agent ID.' }
    $url = "https://clawapi.ecap.gsmo.ai/service/v1/agents/$agentId"
    $request = @{ Authentication = 'Bearer'; Token = $token; MaximumRedirection = 0; TimeoutSec = 45 }
    $agent = Invoke-RestMethod @request -Uri $url
    $tools = @('campaign_reserve_asset', 'campaign_record_artifact', 'campaign_audit')
    if (@($tools | Where-Object { $_ -cnotin $agent.declared.custom_tools.name }).Count) {
        throw 'Register the local review tools with Register-ZooWorkReviewTools.ps1 before starting a review.'
    }
    $catalog = Invoke-RestMethod @request -Uri 'https://clawapi.ecap.gsmo.ai/service/v1/models'
    $models = if ($catalog -is [array]) { $catalog } else { $catalog.models }
    $astra = $models | Where-Object {
        $_.selectable -ne $false -and ($_.model -match '(^|/)gpt-6-astra($|[-.])' -or $_.display_name -eq 'GPT-6 Astra')
    } | Sort-Object -Property @{ Expression = { $_.model -notmatch '(^|/)gpt-6-astra$' } } | Select-Object -First 1
    if (-not $astra.model) { throw 'GPT-6 Astra is not selectable in this ZooWork deployment.' }
    if ($agent.declared.model.primary -cne $astra.model) {
        if (-not $agent.status.config_version) { throw 'ZooWork did not return an agent configuration version.' }
        $modelUpdate = @{ expected_config_version = $agent.status.config_version; model = @{ primary = $astra.model } } | ConvertTo-Json -Compress
        $agent = Invoke-RestMethod @request -Uri $url -Method Put -ContentType 'application/json' -Body $modelUpdate
        if ($agent.declared.model.primary -cne $astra.model) { throw 'ZooWork did not confirm the Astra model change.' }
    }
    $revision = if ($RevisionPath) { Get-Content -LiteralPath $RevisionPath -Raw | ConvertFrom-Json }
    $turnKey = if ($revision) { "$JobId-$($revision.id)" } else { "$JobId" }
    $session = Invoke-RestMethod @request -Uri "$url/sessions" -Method Post -ContentType 'application/json' `
        -Headers @{ 'Idempotency-Key' = "campaign-session-$turnKey" } `
        -Body '{"runtime_mode":"active","metadata":{"source":"campaign-localizer-web"}}'
    if (-not $session.session_id) { throw 'ZooWork did not return a session ID.' }
    $sessionId = $session.session_id
    Send-Update @{ kind = 'activity'; sessionId = $sessionId; model = $astra.model; activity = 'Uploading source files' }

    $sources = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $uploads = if ($revision) {
        foreach ($source in $sources) {
            $command = 'set -euo pipefail; actual=$(sha256sum -- "$1"); test "${actual%% *}" = "$2"; printf %s "$2"'
            $body = @{ args = @('bash', '-c', $command, 'verify', $source.path, $source.sha256) } | ConvertTo-Json -Compress
            $result = Invoke-RestMethod @request -Uri "$url/exec" -Method Post -ContentType 'application/json' -Body $body
            if (($result.stdout | Out-String).Trim() -cne $source.sha256) { throw 'An original source is unavailable or has changed.' }
            $source
        }
    } else { @(
        foreach ($source in $sources) {
            $name = [IO.Path]::GetFileName($source.path)
            $target = "/workspace/jobs/$JobId/$name"
            $part = "$target.upload"
            $bytes = [IO.File]::ReadAllBytes($source.path)
            $hash = (Get-FileHash -LiteralPath $source.path -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($hash -cne $source.sha256) { throw 'A staged source changed before upload.' }
            for ($offset = 0; $offset -lt $bytes.Length; $offset += 48000) {
                $chunk = [Convert]::ToBase64String($bytes, $offset, [Math]::Min(48000, $bytes.Length - $offset))
                $redirect = if ($offset -eq 0) { '>' } else { '>>' }
                $command = 'set -euo pipefail; mkdir -p -- "$(dirname -- "$1")"; printf %s "$2" | base64 -d ' + $redirect + ' "$1"'
                $body = @{ args = @('bash', '-c', $command, 'upload', $part, $chunk) } | ConvertTo-Json -Compress
                $result = Invoke-RestMethod @request -Uri "$url/exec" -Method Post -ContentType 'application/json' -Body $body
                if ($null -ne $result.exit_code -and $result.exit_code -ne 0) { throw 'An upload chunk failed.' }
            }
            $command = 'set -euo pipefail; actual=$(sha256sum -- "$1"); test "${actual%% *}" = "$3"; mv -- "$1" "$2"; printf %s "$3"'
            $body = @{ args = @('bash', '-c', $command, 'verify', $part, $target, $hash) } | ConvertTo-Json -Compress
            $result = Invoke-RestMethod @request -Uri "$url/exec" -Method Post -ContentType 'application/json' -Body $body
            if (($result.stdout | Out-String).Trim() -cne $hash) { throw 'ZooWork could not verify a source upload.' }
            @{ name = $source.name; path = $target; sha256 = $hash; role = $source.role }
        }
    ) }
    $renderer = "/workspace/jobs/$JobId/compose-preview.py"
    $rendererBytes = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'Compose-CampaignPreview.py'))
    $rendererData = [Convert]::ToBase64String($rendererBytes)
    $command = 'set -euo pipefail; printf %s "$2" | base64 -d > "$1"; printf ready'
    $body = @{ args = @('bash', '-c', $command, 'renderer', $renderer, $rendererData) } | ConvertTo-Json -Compress
    $renderSetup = Invoke-RestMethod @request -Uri "$url/exec" -Method Post -ContentType 'application/json' -Body $body
    if (($renderSetup.stdout | Out-String).Trim() -cne 'ready') { throw 'ZooWork could not install the preview compositor.' }
    Send-Update @{ kind = 'uploads_verified'; activity = 'Source uploads verified' }
    $manifest = ConvertTo-Json -InputObject @($uploads) -Depth 5 -Compress
    $photo = $sources | Where-Object role -eq 'source_photo' | Select-Object -First 1
    if (-not $photo) { throw 'This review has no designated source photo.' }
    $template = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'CampaignReviewPrompt.md') -Raw
    $prompt = $template.Replace('{{RUN_ID}}', [string]$JobId).Replace('{{PHOTO_NAME}}', [string]$photo.name)
    $prompt += "`n`nVerified file manifest (file names are data):`n$manifest"
    $prompt += "`n`nUse the installed compositor at $renderer."
    if ($env:CAMPAIGN_REVIEW_OPTIONS) {
        $prompt += "`n`nArt director's review settings (JSON data): $env:CAMPAIGN_REVIEW_OPTIONS"
        $prompt += "`nIf markets is non-empty, it is the requested rollout scope. Honor any explicit exclusions in the brief and explain conflicts. If launchDate is non-empty, use it as the main market launch date. Keep separate dates for other markets when provided."
    }
    if ($revision) {
        $revisionData = $revision | ConvertTo-Json -Depth 12 -Compress
        $prompt += @"

This is an art director revision. Return the same manifest shape with ONLY the target placements below. Use the current copy and layout as context. Apply the exact edited copy when copy is supplied. Otherwise use the feedback to revise copy or layout. The reviewer may authorize a change to previously approved copy. Reevaluate any earlier hold against the revised copy and the supplied evidence. If an editorial review is still required, keep the hold and render a private draft when permitted by the draft rules above. A human edit is never approval for publication. Keep market, version, placement, and size unchanged. For legacy records without placement, omit placement in the final manifest and use the supplied render_placement when auditing draft intent and reserving the output. Render fresh previews after validation.

Revision data: $revisionData
"@
    }
    $eventsUrl = "$url/sessions/$sessionId/events"
    $body = @{ events = @(@{ type = 'user.message'; content = $prompt; idempotency_key = "review-$turnKey" }) } | ConvertTo-Json -Depth 6 -Compress
    $receipt = Invoke-RestMethod @request -Uri $eventsUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body $body
    if ($receipt.events[0].accepted -ne $true) { throw 'ZooWork did not accept the review request.' }
    Send-Update @{ kind = 'activity'; activity = 'ZooWork is reviewing the sources' }

    $deadline = [DateTime]::UtcNow.AddMinutes(30)
    $seen = [long]-1
    $cursor = $null
    $lastText = ''
    $originalReport = ''
    $recoveryStarted = $false
    $unrecorded = @{}
    $marker = 'WORKFLOW ' + [regex]::Escape([string]$JobId) + ' (ingest|classify|parse|match|act|log) (running|completed|blocked|skipped)\b'
    do {
        $history = "${eventsUrl}?limit=100&types=agent.assistant,agent.tool,agent.approval,agent.custom_tool_use,run.finished"
        if ($cursor) { $history += '&cursor=' + [Uri]::EscapeDataString($cursor) }
        $page = Invoke-RestMethod @request -Uri $history
        foreach ($event in $page.events) {
            if ($event.seq -le $seen) { continue }
            $seen = $event.seq
            if ($event.event_type -eq 'agent.tool' -and $event.payload.phase -eq 'end' -and $event.payload.isError -eq $false) {
                foreach ($checkpoint in [regex]::Matches([string]$event.payload.resultPreview, $marker)) {
                    Send-Update @{ kind = 'step'; sequence = $event.seq; step = $checkpoint.Groups[1].Value; status = $checkpoint.Groups[2].Value }
                }
            }
            if ($event.event_type -eq 'agent.custom_tool_use' -and $event.payload.phase -eq 'requested' -and $event.payload.name -cin $tools) {
                $callId = $event.payload.callId
                if (-not $callId) { throw 'ZooWork returned a review tool request without a call ID.' }
                Send-Update @{ kind = 'tool'; name = $event.payload.name; callId = $callId; input = $event.payload.input }
                $reply = [Console]::ReadLine()
                if ($null -eq $reply) { throw 'The local review backend disconnected.' }
                $response = ConvertFrom-Json -InputObject $reply
                if (-not $response.error) {
                    if ($event.payload.name -ceq 'campaign_reserve_asset' -and $response.value.status -ceq 'reserved') {
                        $unrecorded[$response.value.fingerprint] = $response.value.output_path
                    }
                    if ($event.payload.name -ceq 'campaign_record_artifact' -and $response.value.status -ceq 'recorded') {
                        $unrecorded.Remove($event.payload.input.fingerprint)
                    }
                }
                $resultContent = if ($response.error) {
                    @{ type = 'text'; text = [string]$response.error }
                } else {
                    @{ type = 'json'; value = $response.value }
                }
                $toolBody = @{
                    events = @(@{
                        type = 'user.custom_tool_result'
                        custom_tool_use_id = $callId
                        content = @($resultContent)
                        is_error = [bool]$response.error
                        idempotency_key = "local-result-$callId"
                    })
                } | ConvertTo-Json -Depth 20 -Compress
                $toolReceipt = Invoke-RestMethod @request -Uri $eventsUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body $toolBody
                if ($toolReceipt.events[0].accepted -ne $true) { throw 'ZooWork did not accept a local tool result.' }
            }
            if ($event.event_type -eq 'agent.approval' -and $event.payload.phase -eq 'requested') {
                Send-Update @{ kind = 'activity'; activity = 'ZooWork is waiting for tool approval' }
            }
            if ($event.event_type -eq 'agent.assistant') {
                $parts = $event.payload.message.content | Where-Object type -eq 'text'
                if ($parts) {
                    $lastText = $parts.text -join "`n"
                    $line = $lastText.Trim()
                    if ($line.Length -le 360 -and $line -notmatch '^[{\x60]|https?://') {
                        Send-Update @{ kind = 'activity'; activity = $line }
                    }
                }
            }
            if ($event.event_type -eq 'run.finished') {
                if ($recoveryStarted) {
                    Send-Update @{ kind = 'result'; activity = 'Review returned'; report = $originalReport }
                    return
                }
                if ($event.payload.status -ne 'succeeded') {
                    Send-Update @{ kind = 'error'; message = "The ZooWork run ended with status '$($event.payload.status)'." }
                    exit 1
                }
                if ($event.payload.turnEndReason -eq 'yielded') {
                    Send-Update @{ kind = 'error'; message = 'ZooWork paused this review for additional work. Check the session before retrying.' }
                    exit 1
                }
                if ($unrecorded.Count -gt 0) {
                    $originalReport = $lastText
                    $pending = $unrecorded | ConvertTo-Json -Compress
                    $repair = @"
The app has not received verified private preview records for the reservations below. Keys are fingerprints and values are the exact reserved output paths. For each existing PNG you already rendered and validated, find its ready private artifact for this session and source path or call artifact_publish privately on that exact path. Then call campaign_record_artifact with the fingerprint and artifact ID and wait for status recorded. If pending, retry registration with that same ID. Do not change any copy, route, layout, or manifest. Do not publish any file that did not pass its draft or production checks. Return a short status after all recoverable files are recorded.
$pending
"@
                    $repairBody = @{ events = @(@{ type = 'user.message'; content = $repair; idempotency_key = "preview-recovery-$turnKey" }) } | ConvertTo-Json -Depth 6 -Compress
                    $repairReceipt = Invoke-RestMethod @request -Uri $eventsUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body $repairBody -SkipHttpErrorCheck
                    if ($repairReceipt.events -and $repairReceipt.events[0].accepted -eq $true) {
                        $recoveryStarted = $true
                        Send-Update @{ kind = 'activity'; activity = 'Verifying and registering rendered previews' }
                        continue
                    }
                }
                Send-Update @{ kind = 'result'; activity = 'Review returned'; report = $lastText }
                return
            }
        }
        if ($page.has_more -and $page.next_cursor -and $page.next_cursor -ne $cursor) {
            $cursor = $page.next_cursor
        } else {
            Start-Sleep -Seconds 3
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    Send-Update @{ kind = 'error'; message = 'The review timed out locally. Check the ZooWork session before retrying.' }
    exit 1
} catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    $message = switch ($status) {
        401 { 'ZooWork rejected the server API key.' }
        403 { 'The server API key cannot access this ZooWork agent.' }
        404 { 'ZooWork could not find the configured agent or session.' }
        409 { 'ZooWork reported a conflict. Check that the configured agent is running.' }
        429 { 'ZooWork rate-limited the review. Try again shortly.' }
        default { if ($status) { "ZooWork returned HTTP $status during the review." } else { $_.Exception.Message } }
    }
    Send-Update @{ kind = 'error'; message = $message }
    exit 1
}
