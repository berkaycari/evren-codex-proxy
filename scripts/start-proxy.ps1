[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ─────────────────────────────────────────────────────────────
# EVREN CODEX BRIDGE - Terminal Theme
# ─────────────────────────────────────────────────────────────

$Host.UI.RawUI.WindowTitle = 'EVREN CODEX BRIDGE'

function global:prompt {
    $time = Get-Date -Format 'HH:mm:ss'
    $folder = Split-Path -Leaf (Get-Location)

    Write-Host '╭─[' -NoNewline -ForegroundColor DarkGray
    Write-Host ' EVREN ' -NoNewline -ForegroundColor Cyan
    Write-Host ']─[' -NoNewline -ForegroundColor DarkGray
    Write-Host $time -NoNewline -ForegroundColor Yellow
    Write-Host ']─[' -NoNewline -ForegroundColor DarkGray
    Write-Host $folder -NoNewline -ForegroundColor Green
    Write-Host ']' -ForegroundColor DarkGray

    Write-Host '╰─❯ ' -NoNewline -ForegroundColor Cyan
    return ' '
}

Clear-Host

Write-Host ''
Write-Host '╭──────────────────────────────────────────────────────────╮' -ForegroundColor DarkCyan
Write-Host '│' -NoNewline -ForegroundColor DarkCyan
Write-Host '                  EVREN CODEX BRIDGE                      ' -NoNewline -ForegroundColor Cyan
Write-Host '│' -ForegroundColor DarkCyan
Write-Host '├──────────────────────────────────────────────────────────┤' -ForegroundColor DarkCyan
Write-Host '│  LOCAL AI COMPATIBILITY PROXY                            │' -ForegroundColor DarkCyan
Write-Host '│  Proxy   : 127.0.0.1:8787                                │' -ForegroundColor DarkCyan
Write-Host '│  Model   : deepseek-v4-flash                             │' -ForegroundColor DarkCyan
Write-Host '│  Runtime : Codex → Proxy → EVREN                         │' -ForegroundColor DarkCyan
Write-Host '╰──────────────────────────────────────────────────────────╯' -ForegroundColor DarkCyan
Write-Host ''

$projectRoot = Split-Path -Parent $PSScriptRoot

# ─────────────────────────────────────────────────────────────
# EVREN API Key Loading
# Priority:
#   1. Current process environment
#   2. Local .env file
#   3. Clipboard fallback
# ─────────────────────────────────────────────────────────────

$envFile = Join-Path $projectRoot '.env'

# 1) Current process environment
if (-not [string]::IsNullOrWhiteSpace($env:EVREN_API_KEY)) {
    Write-Host "EVREN_API_KEY loaded from process environment (length: $($env:EVREN_API_KEY.Length))"
}

# 2) Local .env file
elseif (Test-Path -LiteralPath $envFile) {
    $keyLines = @(
        Get-Content -LiteralPath $envFile |
        Where-Object { $_ -match '^\s*EVREN_API_KEY\s*=' }
    )

    if ($keyLines.Count -gt 1) {
        throw '.env içinde birden fazla EVREN_API_KEY tanımı bulundu.'
    }

    if ($keyLines.Count -eq 1) {
        $keyValue = ($keyLines[0] -replace '^\s*EVREN_API_KEY\s*=\s*', '').Trim()

        # Optional surrounding quotes
        if (
            ($keyValue.StartsWith('"') -and $keyValue.EndsWith('"')) -or
            ($keyValue.StartsWith("'") -and $keyValue.EndsWith("'"))
        ) {
            $keyValue = $keyValue.Substring(1, $keyValue.Length - 2)
        }

        if (-not [string]::IsNullOrWhiteSpace($keyValue)) {
            $env:EVREN_API_KEY = $keyValue
            Write-Host "EVREN_API_KEY loaded from .env (length: $($env:EVREN_API_KEY.Length))"
        }
    }
}

# 3) Clipboard fallback
if ([string]::IsNullOrWhiteSpace($env:EVREN_API_KEY)) {
    $answer = Read-Host 'EVREN_API_KEY bulunamadı. Panodan güvenli biçimde almak ister misiniz? (E/H)'

    if ($answer -notmatch '^[EeYy]$') {
        throw 'EVREN_API_KEY ayarlanmadı. İşlem iptal edildi.'
    }

    try {
        $clipboardValue = (Get-Clipboard -Raw).Trim()

        if ([string]::IsNullOrWhiteSpace($clipboardValue)) {
            throw 'Pano boş; EVREN_API_KEY alınamadı.'
        }

        $env:EVREN_API_KEY = $clipboardValue
        Write-Host "EVREN_API_KEY loaded from clipboard (length: $($env:EVREN_API_KEY.Length))"
    }
    finally {
        Set-Clipboard -Value ' '
        $clipboardValue = $null
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    throw 'Bağımlılıklar eksik. Önce proje klasöründe npm.cmd install çalıştırın.'
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.js'))) {
    Write-Host 'Build bulunamadı; npm.cmd run build çalıştırılıyor.'
    & npm.cmd --prefix $projectRoot run build
    if ($LASTEXITCODE -ne 0) { throw 'Build başarısız oldu.' }
}

Push-Location $projectRoot
try {
    & npm.cmd start
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
