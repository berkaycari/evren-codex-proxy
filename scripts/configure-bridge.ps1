[CmdletBinding()]
param(
    [ValidateSet('Standard', 'Coding', 'Custom')]
    [string]$Preset,
    [switch]$Save,
    [string]$ResultPath,
    [string]$CustomJson
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$defaultsPath = Join-Path $projectRoot 'config\defaults.json'
$localPath = Join-Path $projectRoot 'config\local.json'
$supported = @(
    'maxSessionTokens',
    'maxDailyTokens',
    'maxSessionCredits',
    'maxDailyCredits',
    'minCreditsRemaining',
    'maxRequestsPerSession',
    'maxToolCallsPerSession',
    'maxEstimatedInputTokensPerCall',
    'maxOutputTokensPerCall',
    'toolOutputMaxChars',
    'toolPollWarningThreshold',
    'maxConsecutiveToolPollInferences',
    'sessionTtlMinutes',
    'pricingRefreshMinutes',
    'requestTimeoutMs',
    'updateCheckEnabled'
)
$decimalSupported = @('maxSessionCredits', 'maxDailyCredits', 'minCreditsRemaining')

function Write-ConfigurationResult {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('saved', 'cancelled')]
        [string]$Outcome
    )

    if ([string]::IsNullOrWhiteSpace($ResultPath)) { return }
    $result = [ordered]@{ outcome = $Outcome }
    if (-not [string]::IsNullOrWhiteSpace($Preset)) { $result.preset = $Preset }
    $resultDirectory = Split-Path -Parent $ResultPath
    if (-not [string]::IsNullOrWhiteSpace($resultDirectory)) {
        New-Item -ItemType Directory -Force -Path $resultDirectory | Out-Null
    }
    $resultJson = $result | ConvertTo-Json -Compress
    $resultEncoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($ResultPath, $resultJson + [Environment]::NewLine, $resultEncoding)
}

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
        Write-Host '1 ile 2147483647 arasında pozitif bir tam sayı girin.' -ForegroundColor Yellow
    }
}

function Read-NonNegativeInteger {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][long]$Current
    )

    while ($true) {
        $answer = Read-Host "$Label [$Current]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Current }
        $parsed = 0L
        if ([long]::TryParse($answer.Trim(), [ref]$parsed) -and $parsed -ge 0 -and $parsed -le [int]::MaxValue) {
            return $parsed
        }
        Write-Host '0 ile 2147483647 arasında negatif olmayan bir tam sayı girin.' -ForegroundColor Yellow
    }
}

function Read-NonNegativeDecimal {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][double]$Current
    )

    while ($true) {
        $answer = Read-Host "$Label [$Current]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Current }
        $parsed = 0.0
        if ([double]::TryParse($answer.Trim(), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -and $parsed -ge 0 -and -not [double]::IsInfinity($parsed)) {
            return $parsed
        }
        Write-Host '0 veya daha büyük sonlu bir sayı girin; ondalık ayırıcı olarak nokta kullanın.' -ForegroundColor Yellow
    }
}

function Read-Boolean {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][bool]$Current
    )

    $default = if ($Current) { 'Açık' } else { 'Kapalı' }
    while ($true) {
        $answer = Read-Host "$Label [Açık/Kapalı, geçerli: $default]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Current }
        if ($answer -match '^(Açık|Acik|On|1)$') { return $true }
        if ($answer -match '^(Kapalı|Kapali|Off|0)$') { return $false }
        Write-Host 'Açık veya Kapalı yazın.' -ForegroundColor Yellow
    }
}

function Read-ArrowSelection {
    param(
        [Parameter(Mandatory = $true)][string[]]$Options,
        [Parameter(Mandatory = $true)][scriptblock]$RenderHeader
    )

    $selected = 0
    try { [Console]::CursorVisible = $false } catch {}
    try {
        while ($true) {
            try { [Console]::Clear() } catch { Write-Host "`e[2J`e[H" -NoNewline }
            & $RenderHeader
            Write-Host ''
            for ($index = 0; $index -lt $Options.Count; $index++) {
                $prefix = if ($index -eq $selected) { '>' } else { ' ' }
                if ($index -eq $selected) {
                    Write-Host ("{0} {1}" -f $prefix, $Options[$index]) -ForegroundColor Black -BackgroundColor Cyan
                }
                else {
                    Write-Host ("{0} {1}" -f $prefix, $Options[$index])
                }
            }

            $key = [Console]::ReadKey($true)
            if (($key.Modifiers -band [ConsoleModifiers]::Control) -and $key.Key -eq [ConsoleKey]::C) {
                throw [System.OperationCanceledException]::new('Ctrl+C')
            }
            switch ($key.Key) {
                'UpArrow' { $selected = ($selected + $Options.Count - 1) % $Options.Count }
                'DownArrow' { $selected = ($selected + 1) % $Options.Count }
                'Enter' { return $Options[$selected] }
                'Escape' { return $null }
            }
        }
    }
    finally {
        try { [Console]::CursorVisible = $true } catch {}
    }
}


function Apply-CustomJson {
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Target
    )

    $value = $Json | ConvertFrom-Json
    if ($null -eq $value -or $value -is [System.Array]) {
        throw 'CustomJson must contain one JSON object.'
    }

    foreach ($property in $value.PSObject.Properties) {
        if ($supported -notcontains $property.Name) {
            throw "Unsupported CustomJson key: $($property.Name)"
        }
    }

    foreach ($key in $supported) {
        $property = $value.PSObject.Properties[$key]
        if ($null -eq $property) {
            throw "CustomJson is missing required key: $key"
        }

        if ($key -eq 'updateCheckEnabled') {
            if ($property.Value -isnot [bool]) {
                throw 'CustomJson value updateCheckEnabled must be true or false.'
            }
            $Target[$key] = [bool]$property.Value
            continue
        }

        if ($decimalSupported -contains $key) {
            if ($property.Value -isnot [ValueType]) { throw "CustomJson value $key must be a finite non-negative number." }
            $parsedDecimal = [double]$property.Value
            if ($parsedDecimal -lt 0 -or [double]::IsNaN($parsedDecimal) -or [double]::IsInfinity($parsedDecimal)) {
                throw "CustomJson value $key must be a finite non-negative number."
            }
            $Target[$key] = $parsedDecimal
            continue
        }

        $parsed = 0L
        $minimum = if ($key -eq 'maxConsecutiveToolPollInferences') { 0 } else { 1 }
        if (-not [long]::TryParse([string]$property.Value, [ref]$parsed) -or $parsed -lt $minimum -or $parsed -gt [int]::MaxValue) {
            throw "CustomJson value $key must be a whole number of at least $minimum."
        }
        $Target[$key] = $parsed
    }
}

function Write-ConfigurationPreview {
    param(
        [Parameter(Mandatory = $true)][string]$SelectedPreset,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Values
    )

    $profileName = switch ($SelectedPreset) {
        'Standard' { 'STANDART' }
        'Coding' { 'KODLAMA' }
        default { 'ÖZEL' }
    }
    $hardCap = if ($Values.maxConsecutiveToolPollInferences -eq 0) { 'Kapalı' } else { $Values.maxConsecutiveToolPollInferences }
    Write-Host ("{0} PROFİLİ" -f $profileName) -ForegroundColor Cyan
    Write-Host ''
    Write-Host ("Oturum token limiti : {0}" -f $Values.maxSessionTokens)
    Write-Host ("Günlük token limiti : {0}" -f $Values.maxDailyTokens)
    Write-Host ("Oturum kredi limiti : {0}" -f $Values.maxSessionCredits)
    Write-Host ("Günlük kredi limiti : {0}" -f $Values.maxDailyCredits)
    Write-Host ("Minimum kalan kredi : {0}" -f $Values.minCreditsRemaining)
    Write-Host ("İstek / oturum      : {0}" -f $Values.maxRequestsPerSession)
    Write-Host ("Araç / oturum       : {0}" -f $Values.maxToolCallsPerSession)
    Write-Host ("Çıktı / istek       : {0}" -f $Values.maxOutputTokensPerCall)
    Write-Host ("Poll uyarı eşiği    : {0}" -f $Values.toolPollWarningThreshold)
    Write-Host ("Poll hard cap       : {0}" -f $hardCap)
}

$defaults = Read-JsonObject -Path $defaultsPath
$current = [ordered]@{}
foreach ($key in $supported) {
    $current[$key] = if ($key -eq 'updateCheckEnabled') {
        [bool]$defaults.$key
    } elseif ($decimalSupported -contains $key) {
        [double]$defaults.$key
    } else {
        [long]$defaults.$key
    }
}

if (Test-Path -LiteralPath $localPath) {
    $local = Read-JsonObject -Path $localPath
    foreach ($property in $local.PSObject.Properties) {
        if ($supported -notcontains $property.Name) {
            throw "Unsupported key in config/local.json: $($property.Name). Remove it before using this tool."
        }
        if ($property.Name -eq 'updateCheckEnabled') {
            if ($property.Value -isnot [bool]) { throw 'config/local.json value updateCheckEnabled must be true or false.' }
            $current[$property.Name] = [bool]$property.Value
            continue
        }
        if ($decimalSupported -contains $property.Name) {
            $parsedDecimal = [double]$property.Value
            if ($parsedDecimal -lt 0 -or [double]::IsNaN($parsedDecimal) -or [double]::IsInfinity($parsedDecimal)) {
                throw "config/local.json value $($property.Name) must be a finite non-negative number."
            }
            $current[$property.Name] = $parsedDecimal
            continue
        }
        $parsed = 0L
        $minimum = if ($property.Name -eq 'maxConsecutiveToolPollInferences') { 0 } else { 1 }
        if (-not [long]::TryParse([string]$property.Value, [ref]$parsed) -or $parsed -lt $minimum -or $parsed -gt [int]::MaxValue) {
            throw "config/local.json value $($property.Name) must be a whole number of at least $minimum."
        }
        $current[$property.Name] = $parsed
    }
}

Write-Host ''
Write-Host 'EVREN CODEX BRIDGE — YAPILANDIRMA' -ForegroundColor Cyan
Write-Host ''
Write-Host ("Model: {0}" -f $defaults.model)
Write-Host 'Presetler yerel güvenlik limitlerini değiştirir; model yeteneğini artırmaz.' -ForegroundColor Yellow
Write-Host ''

if ([string]::IsNullOrWhiteSpace($Preset)) {
    $selection = Read-ArrowSelection -Options @('Standart', 'Kodlama', 'Özel') -RenderHeader {
        Write-Host 'EVREN CODEX BRIDGE — YAPILANDIRMA' -ForegroundColor Cyan
        Write-Host ''
        Write-Host ("Model: {0}" -f $defaults.model)
        Write-Host ''
        Write-Host '↑/↓ ile seçin, Enter ile onaylayın, Esc ile çıkın.'
    }
    if ($null -eq $selection) {
        Write-ConfigurationResult -Outcome 'cancelled'
        return
    }
    $Preset = switch ($selection) {
        'Standart' { 'Standard' }
        'Kodlama' { 'Coding' }
        'Özel' { 'Custom' }
    }
}

Write-Host ("Seçilen profil: {0}" -f $Preset) -ForegroundColor Cyan

if ($Preset -eq 'Standard') {
    $current.maxSessionTokens = 1200000
    $current.maxDailyTokens = 10000000
    $current.maxRequestsPerSession = 60
    $current.maxToolCallsPerSession = 80
    $current.maxOutputTokensPerCall = 4096
}

if ($Preset -eq 'Coding') {
    $current.maxSessionTokens = 3000000
    $current.maxDailyTokens = 10000000
    $current.maxRequestsPerSession = 120
    $current.maxToolCallsPerSession = 140
    $current.maxOutputTokensPerCall = 4096
}

if ($Preset -eq 'Custom') {
    if (-not [string]::IsNullOrWhiteSpace($CustomJson)) {
        Apply-CustomJson -Json $CustomJson -Target $current
    }
    else {
        $current.maxSessionTokens = Read-PositiveInteger 'Oturum token limiti        ' $current.maxSessionTokens
        $current.maxDailyTokens = Read-PositiveInteger 'Günlük token limiti        ' $current.maxDailyTokens
        $current.maxSessionCredits = Read-NonNegativeDecimal 'Oturum kredi limiti (0 kapatır)' $current.maxSessionCredits
        $current.maxDailyCredits = Read-NonNegativeDecimal 'Günlük kredi limiti (0 kapatır)' $current.maxDailyCredits
        $current.minCreditsRemaining = Read-NonNegativeDecimal 'Minimum kalan kredi (0 kapatır)' $current.minCreditsRemaining
        $current.maxEstimatedInputTokensPerCall = Read-PositiveInteger 'Tahmini girdi/istek limiti ' $current.maxEstimatedInputTokensPerCall
        $current.maxOutputTokensPerCall = Read-PositiveInteger 'Çıktı token/istek limiti   ' $current.maxOutputTokensPerCall
        $current.maxRequestsPerSession = Read-PositiveInteger 'İstek / oturum             ' $current.maxRequestsPerSession
        $current.maxToolCallsPerSession = Read-PositiveInteger 'Araç / oturum              ' $current.maxToolCallsPerSession
        $current.toolOutputMaxChars = Read-PositiveInteger 'Araç çıktısı maks. karakter' $current.toolOutputMaxChars
        $current.toolPollWarningThreshold = Read-PositiveInteger 'Poll uyarı eşiği           ' $current.toolPollWarningThreshold
        $current.maxConsecutiveToolPollInferences = Read-NonNegativeInteger 'Poll hard cap (0 kapatır)  ' $current.maxConsecutiveToolPollInferences
        $current.sessionTtlMinutes = Read-PositiveInteger 'Oturum TTL (dakika)        ' $current.sessionTtlMinutes
        $current.pricingRefreshMinutes = Read-PositiveInteger 'Fiyat yenileme (dakika)    ' $current.pricingRefreshMinutes
        $current.requestTimeoutMs = Read-PositiveInteger 'İstek zaman aşımı (ms)     ' $current.requestTimeoutMs
        $current.updateCheckEnabled = Read-Boolean 'Anonim güncelleme denetimi ' $current.updateCheckEnabled
    }
}

if (-not $Save) {
    $saveAnswer = Read-ArrowSelection -Options @('Uygula', 'Vazgeç') -RenderHeader {
        Write-ConfigurationPreview -SelectedPreset $Preset -Values $current
        Write-Host ''
        Write-Host '↑/↓ ile seçin, Enter ile onaylayın, Esc ile çıkın.'
    }
    if ($null -eq $saveAnswer -or $saveAnswer -eq 'Vazgeç') {
        Write-Host 'Yapılandırma değiştirilmedi.'
        Write-ConfigurationResult -Outcome 'cancelled'
        return
    }
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

Write-Host "Yapılandırma kaydedildi: $localPath" -ForegroundColor Green
if (Test-Path -LiteralPath $backupPath) {
    Write-Host "Önceki yapılandırma yedeklendi: $backupPath"
}
Write-Host 'Bridge başlatıldığında environment değişkenleri önceliğini korur.'
Write-ConfigurationResult -Outcome 'saved'
