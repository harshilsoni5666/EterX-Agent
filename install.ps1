# ═══════════════════════════════════════════════
# EterX Agent — One-Line Installer (Windows PowerShell)
# Usage: irm https://raw.githubusercontent.com/harshilsoni5666/EterX-agent-/main/install.ps1 | iex
# ═══════════════════════════════════════════════

$ErrorActionPreference = "Stop"
$REPO = "https://github.com/harshilsoni5666/EterX-agent-.git"
$INSTALL_DIR = if ($env:ETERX_DIR) { $env:ETERX_DIR } else { "$env:USERPROFILE\EterX" }

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }

    foreach ($line in $output) {
        if ($null -ne $line -and "$line".Trim().Length -gt 0) {
            Write-Host "  $line" -ForegroundColor DarkGray
        }
    }

    if ($exitCode -ne 0) {
        throw "$FilePath $($Arguments -join ' ') failed with exit code $exitCode"
    }
}

Write-Host ""
Write-Host "    ███████╗████████╗███████╗██████╗ ██╗  ██╗" -ForegroundColor Cyan
Write-Host "    ██╔════╝╚══██╔══╝██╔════╝██╔══██╗╚██╗██╔╝" -ForegroundColor Cyan
Write-Host "    █████╗     ██║   █████╗  ██████╔╝ ╚███╔╝ " -ForegroundColor Cyan
Write-Host "    ██╔══╝     ██║   ██╔══╝  ██╔══██╗ ██╔██╗ " -ForegroundColor Cyan
Write-Host "    ███████╗   ██║   ███████╗██║  ██║██╔╝ ██╗" -ForegroundColor Cyan
Write-Host "    ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "    ⚡ The Autonomous AI Agent System" -ForegroundColor Magenta
Write-Host ""

# ── Check Node.js ──
$nodeExists = $null
try { $nodeExists = node --version 2>$null } catch {}

if ($nodeExists) {
    Write-Host "  ✔ Node.js $nodeExists" -ForegroundColor Green
} else {
    Write-Host "  ⚠ Node.js not found. Installing..." -ForegroundColor Yellow
    try {
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        Write-Host "  ✔ Node.js installed" -ForegroundColor Green
    } catch {
        Write-Host "  ✖ Auto-install failed. Download from https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}

# ── Check Git ──
$gitExists = $null
try { $gitExists = git --version 2>$null } catch {}

if ($gitExists) {
    Write-Host "  ✔ $gitExists" -ForegroundColor Green
} else {
    Write-Host "  ⚠ Git not found. Installing..." -ForegroundColor Yellow
    try {
        winget install Git.Git --accept-source-agreements --accept-package-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        Write-Host "  ✔ Git installed" -ForegroundColor Green
    } catch {
        Write-Host "  ✖ Auto-install failed. Download from https://git-scm.com" -ForegroundColor Red
        exit 1
    }
}

# ── Clone or Update ──
if (Test-Path "$INSTALL_DIR\.git") {
    Write-Host "  ℹ Existing install found at $INSTALL_DIR" -ForegroundColor Cyan
    Set-Location $INSTALL_DIR

    if ($env:ETERX_UPDATE -eq "1") {
        Write-Host "  ℹ ETERX_UPDATE=1 set. Pulling updates..." -ForegroundColor Cyan
        Invoke-Native git pull --rebase
        Write-Host "  ✔ Repository updated" -ForegroundColor Green
    } else {
        Write-Host "  ℹ Skipping code update. Set ETERX_UPDATE=1 to update source files." -ForegroundColor Cyan
    }
} else {
    Write-Host "  ℹ Cloning EterX to $INSTALL_DIR..." -ForegroundColor Cyan
    Invoke-Native git clone $REPO $INSTALL_DIR
    Set-Location $INSTALL_DIR
    Write-Host "  ✔ Repository cloned" -ForegroundColor Green
}

# ── Run Setup ──
Write-Host ""
Write-Host "  ℹ Starting EterX setup wizard..." -ForegroundColor Cyan
Write-Host ""
if (Test-Path ".env.local") {
    node setup.js --auto
} else {
    node setup.js
}
