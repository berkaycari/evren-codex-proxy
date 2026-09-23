[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$defaultsPath = Join-Path $projectRoot 'config\defaults.json'
$localPath = Join-Path $projectRoot 'config\local.json'
$supported = @(
    'maxSessionTokens',
    'maxDailyTokens',
    'maxRequestsPerSession',
    'maxToolCallsPerSession',
    'maxEstimatedInputTokensPerCall',
    'maxOutputTokensPerCall',
    'toolOutputMaxChars',
    'sessionTtlMinutes',
    'pricingRefreshMinutes',
    'requestTimeoutMs'
)

function Read-JsonObject {
    param([Parameter(Mandatory = $true)][string]$Path)

    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $value -or $value -is [System.Array]) {
        throw "$Path must contain one JSON object."
    }
    return $value
}

function Read-PositiveInteger {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][long]$Current
    )

    while ($true) {
        $answer = Read-Host "$Label [$Current]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Current }
        $parsed = 0L
        if ([long]::TryParse($answer.Trim(), [ref]$parsed) -and $parsed -gt 0 -and $parsed -le [int]::MaxValue) {
            return $parsed
        }
        Write-Host 'Enter a positive whole number no greater than 2147483647.' -ForegroundColor Yellow
    }
}

$defaults = Read-JsonObject -Path $defaultsPath
$current = [ordered]@{}
foreach ($key in $supported) {
    $current[$key] = [long]$defaults.$key
}

if (Test-Path -LiteralPath $localPath) {
    $local = Read-JsonObject -Path $localPath
    foreach ($property in $local.PSObject.Properties) {
        if ($supported -notcontains $property.Name) {
            throw "Unsupported key in config/local.json: $($property.Name). Remove it before using this tool."
        }
        $parsed = 0L
        if (-not [long]::TryParse([string]$property.Value, [ref]$parsed) -or $parsed -le 0 -or $parsed -gt [int]::MaxValue) {
            throw "config/local.json value $($property.Name) must be a positive whole number."
        }
        $current[$property.Name] = $parsed
    }
}

Write-Host ''
Write-Host 'EVREN CODEX BRIDGE CONFIGURATION' -ForegroundColor Cyan
Write-Host ''
Write-Host ("Model                       {0}" -f $defaults.model)

$current.maxSessionTokens = Read-PositiveInteger 'Session token limit        ' $current.maxSessionTokens
$current.maxDailyTokens = Read-PositiveInteger 'Daily token limit          ' $current.maxDailyTokens
$current.maxEstimatedInputTokensPerCall = Read-PositiveInteger 'Estimated input/call limit ' $current.maxEstimatedInputTokensPerCall
$current.maxOutputTokensPerCall = Read-PositiveInteger 'Output token/call limit    ' $current.maxOutputTokensPerCall
$current.maxRequestsPerSession = Read-PositiveInteger 'Requests / session         ' $current.maxRequestsPerSession
$current.maxToolCallsPerSession = Read-PositiveInteger 'Tools / session            ' $current.maxToolCallsPerSession
$current.toolOutputMaxChars = Read-PositiveInteger 'Tool output max chars      ' $current.toolOutputMaxChars
$current.sessionTtlMinutes = Read-PositiveInteger 'Session TTL minutes        ' $current.sessionTtlMinutes
$current.pricingRefreshMinutes = Read-PositiveInteger 'Pricing refresh minutes    ' $current.pricingRefreshMinutes
$current.requestTimeoutMs = Read-PositiveInteger 'Request timeout ms         ' $current.requestTimeoutMs

$save = Read-Host 'Save configuration? [Y/n]'
if ($save -match '^[Nn]$') {
    Write-Host 'Configuration was not changed.'
    return
}
if (-not [string]::IsNullOrWhiteSpace($save) -and $save -notmatch '^[Yy]$') {
    throw 'Expected Y, N, or Enter.'
}

$configDirectory = Split-Path -Parent $localPath
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
$json = $current | ConvertTo-Json
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$temporaryPath = Join-Path $configDirectory ('.local.json.{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
$backupPath = "$localPath.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"

try {
    [System.IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, $utf8NoBom)
    if (Test-Path -LiteralPath $localPath) {
        [System.IO.File]::Replace($temporaryPath, $localPath, $backupPath)
    }
    else {
        Move-Item -LiteralPath $temporaryPath -Destination $localPath
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}

Write-Host "Configuration saved to $localPath" -ForegroundColor Green
if (Test-Path -LiteralPath $backupPath) {
    Write-Host "Previous configuration backed up at $backupPath"
}
Write-Host 'Environment variables still take precedence when the bridge starts.'
