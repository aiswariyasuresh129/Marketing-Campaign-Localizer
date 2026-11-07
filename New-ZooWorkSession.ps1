#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$AgentId
)

$ErrorActionPreference = 'Stop'
$apiKey = if ($env:ZOOWORK_API_KEY) {
    ConvertTo-SecureString -String $env:ZOOWORK_API_KEY -AsPlainText -Force
} else {
    Read-Host 'Enter your ZooWork API key' -AsSecureString
}

$request = @{
    Uri                = "https://clawapi.ecap.gsmo.ai/service/v1/agents/$([Uri]::EscapeDataString($AgentId))/sessions"
    Method             = 'Post'
    Authentication     = 'Bearer'
    Token              = $apiKey
    MaximumRedirection = 0
    TimeoutSec         = 30
    Headers            = @{ 'Idempotency-Key' = "first-session-$AgentId" }
    ContentType        = 'application/json'
    Body               = '{"metadata":{"source":"marketing-campaign-localizer","conversation_id":"first-session"}}'
}

$session = Invoke-RestMethod @request
if (-not $session.session_id) {
    throw 'ZooWork did not return a session ID.'
}

[pscustomobject]@{
    AgentId   = $AgentId
    SessionId = $session.session_id
}
