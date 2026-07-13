# EterX Agent source installer (Windows PowerShell)
#
# End users should normally install the EterX-<version>-win-<arch>.exe produced
# by `npm run desktop:build:win`. This script is the no-Git fallback for people
# who intentionally install from source.

[CmdletBinding()]
param(
    [string]$InstallDir = $(if ($env:ETERX_DIR) { $env:ETERX_DIR } else { Join-Path $env:USERPROFILE 'EterX' }),
    [string]$ArchiveUrl = $(if ($env:ETERX_ARCHIVE_URL) { $env:ETERX_ARCHIVE_URL } else { 'https://github.com/harshilsoni5666/EterX-agent-/archive/refs/heads/main.zip' })
)

$ErrorActionPreference = 'Stop'

function Write-Status([string]$Message) {
    Write-Host "  $Message" -ForegroundColor Cyan
}

function Test-SourceInstall([string]$Path) {
    return (Test-Path (Join-Path $Path 'package.json')) -and (Test-Path (Join-Path $Path 'setup.js'))
}

function Ensure-Node {
    try {
        $version = (& node --version 2>$null).Trim()
        if ($version) {
            Write-Host "  Node.js $version found" -ForegroundColor Green
            return
        }
    } catch {}

    Write-Status 'Node.js was not found. Installing the LTS release with winget...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'Node.js is required for a source install. Install Node.js 20+ from https://nodejs.org, then run this script again.'
    }

    & winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed.' }
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js was installed but is not available in this terminal. Open a new PowerShell window and run the script again.'
    }
}

function Install-SourceArchive {
    if (Test-SourceInstall $InstallDir) {
        Write-Status "Using existing source installation: $InstallDir"
        return
    }

    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("eterx-source-" + [Guid]::NewGuid().ToString('N'))
    $archive = Join-Path $staging 'eterx.zip'
    try {
        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        Write-Status 'Downloading the EterX source archive (no Git required)...'
        Invoke-WebRequest -Uri $ArchiveUrl -OutFile $archive -UseBasicParsing
        Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force

        $source = Get-ChildItem -LiteralPath $staging -Directory |
            Where-Object { Test-SourceInstall $_.FullName } |
            Select-Object -First 1
        if (-not $source) { throw 'The downloaded archive does not contain a valid EterX source installation.' }

        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Get-ChildItem -LiteralPath $source.FullName -Force | Copy-Item -Destination $InstallDir -Recurse -Force
        Write-Host "  Source installed at $InstallDir" -ForegroundColor Green
    } finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host '  EterX Agent source setup' -ForegroundColor Magenta
Write-Host '  For the one-click desktop app, use the EterX installer executable.' -ForegroundColor DarkGray
Write-Host ''

Ensure-Node
Install-SourceArchive
Set-Location -LiteralPath $InstallDir
$hadEnv = Test-Path '.env.local'

Write-Status 'Installing application dependencies and local workspace...'
& node setup.js --auto --no-doctor
if ($LASTEXITCODE -ne 0) { throw 'EterX setup failed. See .workspaces\setup.log for details.' }

if (-not $hadEnv -and $env:ETERX_SKIP_API -ne '1') {
    Write-Status 'Opening the optional API-key setup...'
    & node setup.js --api
}

Write-Host ''
Write-Host '  EterX source installation is ready.' -ForegroundColor Green
