[CmdletBinding()]
param(
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$codexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Join-Path $env:USERPROFILE '.codex'
} else {
    $env:CODEX_HOME
}
$mainConfigPath = Join-Path $codexHome 'config.toml'
$profilePath = Join-Path $codexHome 'evren.config.toml'
$providerHeader = '[model_providers.evren]'
$providerBlock = @(
    $providerHeader
    'name = "EVREN Local Proxy"'
    'base_url = "http://127.0.0.1:8787/v1"'
    'wire_api = "responses"'
    'requires_openai_auth = false'
)
$profileContent = @(
    'model_provider = "evren"'
    'model = "deepseek-v4-flash"'
    ''
) -join [Environment]::NewLine

function Update-ProviderTable {
    param([AllowEmptyCollection()][string[]]$Lines)

    $start = -1
    $end = $Lines.Count
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $trimmed = $Lines[$i].Trim()
        $isEvrenHeader = $trimmed -match '^\[model_providers\.evren\]\s*(?:#.*)?$'
        if ($isEvrenHeader) {
            if ($start -ne -1) { throw 'Ana config içinde birden fazla model_providers.evren tablosu bulundu; otomatik değişiklik güvenli değil.' }
            $start = $i
            continue
        }
        if ($start -eq -1 -and $trimmed -match 'model_providers.*evren' -and $trimmed.StartsWith('[')) {
            throw 'EVREN provider tablosu standart olmayan TOML başlığıyla bulundu; güvenli otomatik değişiklik yerine manuel inceleme gerekli.'
        }
        if ($start -ne -1 -and $i -gt $start -and $trimmed -match '^\[\[?.+\]\]?\s*(?:#.*)?$') {
            $end = $i
            break
        }
    }

    $result = [System.Collections.Generic.List[string]]::new()
    if ($start -eq -1) {
        foreach ($line in $Lines) { $result.Add($line) }
        if ($result.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($result[$result.Count - 1])) { $result.Add('') }
        foreach ($line in $providerBlock) { $result.Add($line) }
        $result.Add('')
        return $result.ToArray()
    }

    for ($i = 0; $i -lt $start; $i++) { $result.Add($Lines[$i]) }
    foreach ($line in $providerBlock) { $result.Add($line) }
    $result.Add('')
    for ($i = $end; $i -lt $Lines.Count; $i++) { $result.Add($Lines[$i]) }
    return $result.ToArray()
}

$existingText = if (Test-Path -LiteralPath $mainConfigPath) {
    Get-Content -Raw -LiteralPath $mainConfigPath
} else {
    ''
}
$existingLines = if ($existingText.Length -eq 0) { @() } else { $existingText -split '\r?\n' }
$updatedLines = Update-ProviderTable -Lines $existingLines
$updatedText = ($updatedLines -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine

Write-Host 'Önerilen değişiklikler:' -ForegroundColor Cyan
Write-Host "  Ana config: $mainConfigPath"
Write-Host '  Yalnız [model_providers.evren] tablosu eklenecek/güncellenecek.'
Write-Host "  Ayrı profil: $profilePath"
Write-Host '  Global model/model_provider ve diğer profiller değiştirilmeyecek.'
Write-Host ''
Write-Host ($providerBlock -join [Environment]::NewLine) -ForegroundColor DarkGray
Write-Host ''
Write-Host $profileContent -ForegroundColor DarkGray

if (-not $Apply) {
    $answer = Read-Host 'Timestamp yedekleri alıp bu değişiklikleri uygulayayım mı? (E/H)'
    if ($answer -notmatch '^[EeYy]$') {
        Write-Host 'Değişiklik uygulanmadı.'
        return
    }
}

New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path -LiteralPath $mainConfigPath) {
    Copy-Item -LiteralPath $mainConfigPath -Destination "$mainConfigPath.$timestamp.bak"
}
if (Test-Path -LiteralPath $profilePath) {
    Copy-Item -LiteralPath $profilePath -Destination "$profilePath.$timestamp.bak"
}

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($mainConfigPath, $updatedText, $utf8NoBom)
[System.IO.File]::WriteAllText($profilePath, $profileContent, $utf8NoBom)

Write-Host 'Codex EVREN proxy profili hazır.' -ForegroundColor Green
Write-Host 'Kullanım: codex --profile evren'
Write-Host "Geri alma: ilgili .bak dosyasını config.toml üzerine kopyalayın ve $profilePath dosyasını kaldırın."
