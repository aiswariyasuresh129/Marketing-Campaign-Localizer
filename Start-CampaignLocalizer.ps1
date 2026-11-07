[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$web = Join-Path $PSScriptRoot 'web'
$next = Join-Path $web 'node_modules/next/dist/bin/next'
$runtime = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies'

$node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) {
    $node = @(
        (Join-Path $env:ProgramFiles 'nodejs/node.exe')
        (Join-Path $runtime 'node/bin/node.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $node) {
    throw 'Node.js was not found. Install Node.js with npm and reopen PowerShell.'
}
if (-not (Test-Path -LiteralPath $next -PathType Leaf)) {
    throw "Dependencies are missing. In '$web', run npm ci, then run this launcher again."
}

$pwsh = $env:ZOOWORK_PWSH
if (-not $pwsh) {
    $pwsh = (Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}
if (-not $pwsh) {
    $pwsh = @(
        (Join-Path $env:ProgramFiles 'PowerShell/7/pwsh.exe')
        (Join-Path $runtime 'native/powershell/pwsh.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $pwsh) {
    throw 'PowerShell 7 was not found. Install it or set ZOOWORK_PWSH to its executable.'
}

$previousPath = $env:PATH
$previousWorker = $env:ZOOWORK_PWSH
$previousKey = $env:ZOOWORK_API_KEY
$previousAgent = $env:ZOOWORK_AGENT_ID
$usesEnvFile = Test-Path -LiteralPath (Join-Path $web '.env.local') -PathType Leaf

Push-Location -LiteralPath $web
try {
    $env:PATH = (@((Split-Path -Parent $node), (Split-Path -Parent $pwsh), $previousPath) |
        Where-Object { $_ }) -join ';'
    if (-not $usesEnvFile -or $previousWorker) { $env:ZOOWORK_PWSH = $pwsh }
    if (-not $previousAgent -and -not $usesEnvFile) {
        $env:ZOOWORK_AGENT_ID = 'agt_01m6vbnv09zg21bweqqwh0ppm3'
    }
    if (-not $previousKey -and -not $usesEnvFile) {
        $secret = Read-Host 'Enter your ZooWork API key' -AsSecureString
        if ($secret.Length -eq 0) { throw 'A ZooWork API key is required to start reviews.' }
        $env:ZOOWORK_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
        $secret.Dispose()
    }
    & $node $next dev --hostname 127.0.0.1 --port $Port
    if ($LASTEXITCODE -ne 0) { throw "The web server exited with code $LASTEXITCODE." }
} finally {
    $env:PATH = $previousPath
    $env:ZOOWORK_PWSH = $previousWorker
    $env:ZOOWORK_API_KEY = $previousKey
    $env:ZOOWORK_AGENT_ID = $previousAgent
    Pop-Location
}
