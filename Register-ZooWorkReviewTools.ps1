#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidatePattern('^agt_[a-zA-Z0-9_-]+$')]
    [string]$AgentId = 'agt_01m6vbnv09zg21bweqqwh0ppm3'
)

$ErrorActionPreference = 'Stop'
$token = if ($env:ZOOWORK_API_KEY) {
    ConvertTo-SecureString -String $env:ZOOWORK_API_KEY -AsPlainText -Force
} else {
    Read-Host 'Enter your ZooWork API key to register review tools' -AsSecureString
}
$request = @{
    Uri = "https://clawapi.ecap.gsmo.ai/service/v1/agents/$AgentId"
    Authentication = 'Bearer'
    Token = $token
    MaximumRedirection = 0
    TimeoutSec = 30
}

$text = @{ type = 'string' }
$positive = @{ type = 'integer'; minimum = 1 }
$reviewTools = @(
    @{
        name = 'campaign_reserve_asset'
        description = 'Check and reserve one eligible campaign asset before rendering. Use the returned status, fingerprint, and reserved output path.'
        input_schema = @{
            type = 'object'
            additionalProperties = $false
            required = @('source_path', 'market', 'version', 'placement', 'width', 'height', 'format', 'calendar_revision', 'market_notes_revision')
            properties = @{
                source_path = $text
                source_page = $positive
                market = $text
                version = $text
                placement = $text
                width = $positive
                height = $positive
                format = @{ type = 'string'; enum = @('png', 'jpg', 'jpeg', 'webp', 'pdf') }
                calendar_revision = $text
                market_notes_revision = $text
            }
        }
    },
    @{
        name = 'campaign_record_artifact'
        description = 'Verify a published private ZooWork artifact against its reserved campaign output and record the completed artifact ID.'
        input_schema = @{
            type = 'object'
            additionalProperties = $false
            required = @('fingerprint', 'artifact_id')
            properties = @{ fingerprint = $text; artifact_id = $text }
        }
    },
    @{
        name = 'campaign_audit'
        description = 'Append one campaign review decision, validation, hold, or retry to the local audit log.'
        input_schema = @{
            type = 'object'
            additionalProperties = $false
            required = @('step', 'event', 'details')
            properties = @{
                step = @{ type = 'string'; enum = @('ingest', 'classify', 'parse', 'match', 'act', 'log') }
                event = $text
                details = $text
                asset = $text
            }
        }
    }
)

$agent = Invoke-RestMethod @request
$version = $agent.status.config_version
if ($version -lt 1) { throw 'ZooWork did not return a usable configuration version.' }
$otherTools = @($agent.declared.custom_tools | Where-Object { $_ -and $_.name -cnotin $reviewTools.name })
$body = @{
    expected_config_version = $version
    custom_tools = @($otherTools + $reviewTools)
} | ConvertTo-Json -Depth 12 -Compress
$null = Invoke-RestMethod @request -Method Put -ContentType 'application/json; charset=utf-8' -Body $body
$saved = Invoke-RestMethod @request
if (@($reviewTools.name | Where-Object { $_ -cnotin $saved.declared.custom_tools.name }).Count) {
    throw 'ZooWork did not return all three saved review tools.'
}
[pscustomobject]@{
    AgentId = $AgentId
    ConfigVersion = $saved.status.config_version
    Tools = $reviewTools.name
    Verified = $true
}
