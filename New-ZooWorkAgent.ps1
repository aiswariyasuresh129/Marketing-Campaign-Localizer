#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Model = 'litellm/gpt-5.6-terra'
)

$ErrorActionPreference = 'Stop'
$apiKey = if ($env:ZOOWORK_API_KEY) {
    ConvertTo-SecureString -String $env:ZOOWORK_API_KEY -AsPlainText -Force
} else {
    Read-Host 'Enter your ZooWork API key' -AsSecureString
}

$baseUrl = 'https://clawapi.ecap.gsmo.ai/service/v1'
$request = @{
    Authentication     = 'Bearer'
    Token              = $apiKey
    MaximumRedirection = 0
    TimeoutSec         = 15
}

$catalog = Invoke-RestMethod @request -Uri "$baseUrl/models"
$models = if ($catalog -is [array]) { $catalog } else { $catalog.models }
$selectable = $models | Where-Object { $_.model -and $_.selectable -ne $false }
if ($Model -cnotin $selectable.model) {
    throw "Model '$Model' is unavailable. Run again with -Model and one of these selectable models: $($selectable.model -join ', ')"
}

$body = @{
    resource = @{
        name   = 'marketing-campaign-localizer'
        model  = @{ primary = $Model }
        labels = @{ app = 'marketing-campaign-localizer' }
        persona = @{
            docs = @(
                @{
                    name = 'AGENTS.md'
                    content = 'Localize marketing campaign copy for the requested locale. Preserve brand voice, factual claims, required disclosures, and formatting. Adapt idioms and calls to action for the target audience. Ask for the target locale if it is missing and flag details that need local review.'
                }
            )
        }
    }
} | ConvertTo-Json -Depth 8 -Compress

$created = Invoke-RestMethod @request -Uri "$baseUrl/agents" -Method Post `
    -Headers @{ 'Idempotency-Key' = 'provision-marketing-campaign-localizer-1' } `
    -ContentType 'application/json' -Body $body
if (-not $created.agent_id) {
    throw 'ZooWork did not return an agent ID.'
}

Write-Host "ZooWork agent ID: $($created.agent_id)"
$agentUrl = "$baseUrl/agents/$([Uri]::EscapeDataString($created.agent_id))"
$agent = Invoke-RestMethod @request -Uri $agentUrl
if ($agent.status.desired_state -ne 'running') {
    $start = Invoke-RestMethod @request -Uri "$agentUrl/start" -Method Post
    foreach ($warning in $start.warnings) {
        Write-Warning $warning
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $agent = Invoke-RestMethod @request -Uri $agentUrl
        if ($agent.status.desired_state -eq 'running') {
            break
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
}

if ($agent.status.desired_state -ne 'running') {
    throw "ZooWork has not confirmed that $($created.agent_id) is running. Rerun with the same model to check again."
}

[pscustomobject]@{
    AgentId       = $created.agent_id
    Name          = $agent.declared.name
    Model         = $agent.declared.model.primary
    ConfigVersion = $agent.status.config_version
    State         = $agent.status.desired_state
}
