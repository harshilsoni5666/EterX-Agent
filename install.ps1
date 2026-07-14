# EterX public-source bootstrap installer for Windows.
#
# When this repository is public, users can run this directly from the README.
# It downloads the complete source tree, installs Node/npm dependencies with
# several recovery paths, initializes EterX, and launches the desktop app.

[CmdletBinding()]
param(
    [string]$InstallDir = $(if ($env:ETERX_DIR) { $env:ETERX_DIR } else { Join-Path $env:USERPROFILE 'EterX' }),
    [string]$RepoUrl = $(if ($env:ETERX_REPO_URL) { $env:ETERX_REPO_URL } else { 'https://github.com/harshilsoni5666/EterX-Agent.git' }),
    [string]$Branch = $(if ($env:ETERX_BRANCH) { $env:ETERX_BRANCH } else { 'main' }),
    [string]$ArchiveUrl = $env:ETERX_ARCHIVE_URL,
    [switch]$NoLaunch,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) {
    Write-Host "  [EterX] $Message" -ForegroundColor Cyan
}

function Write-Good([string]$Message) {
    Write-Host "  [EterX] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "  [EterX] $Message" -ForegroundColor Yellow
}

function Test-EterXSource([string]$Path) {
    return (Test-Path (Join-Path $Path 'package.json')) -and
        (Test-Path (Join-Path $Path 'setup.js')) -and
        (Test-Path (Join-Path $Path 'eterx.js')) -and
        (Test-Path (Join-Path $Path 'src'))
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($machine, $user, $env:Path) | Where-Object { $_ } | Select-Object -Unique
    $env:Path = $parts -join ';'
}

function Download-WithProgress([string]$Url, [string]$OutFile, [string]$Label, [hashtable]$Headers) {
    try {
        [void][Reflection.Assembly]::LoadWithPartialName("System.Net.Http")
    } catch {}
    
    $httpClient = New-Object System.Net.Http.HttpClient
    if ($Headers) {
        foreach ($key in $Headers.Keys) {
            $httpClient.DefaultRequestHeaders.TryAddWithoutValidation($key, $Headers[$key]) | Out-Null
        }
    }
    if (-not ($Headers -and $Headers.ContainsKey('User-Agent'))) {
        $httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("EterX-Installer") | Out-Null
    }

    try {
        $responseTask = $httpClient.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead)
        $response = $responseTask.Result
        $response.EnsureSuccessStatusCode() | Out-Null
        
        $totalBytes = $response.Content.Headers.ContentLength
        if ($null -eq $totalBytes) { $totalBytes = 0 }
        
        $inputStream = $response.Content.ReadAsStreamAsync().Result
        $outputStream = [System.IO.File]::Create($OutFile)
        $buffer = New-Object byte[] 65536
        
        $bytesRead = 0
        $totalRead = 0
        $width = 25
        
        while (($bytesRead = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $outputStream.Write($buffer, 0, $bytesRead)
            $totalRead += $bytesRead
            
            if ($totalBytes -gt 0) {
                $pct = [Math]::Round(($totalRead / $totalBytes) * 100)
                $filled = [Math]::Min($width, [Math]::Round(($totalRead / $totalBytes) * $width))
                $empty = $width - $filled
                $bar = ("█" * $filled) + ("░" * $empty)
                
                $mbRead = [Math]::Round($totalRead / 1MB, 1)
                $mbTotal = [Math]::Round($totalBytes / 1MB, 1)
                
                Write-Host -NoNewline "`r  [EterX] $Label [$bar] $pct% ($mbRead MB / $mbTotal MB)   "
            } else {
                $mbRead = [Math]::Round($totalRead / 1MB, 1)
                Write-Host -NoNewline "`r  [EterX] $Label [Downloading...] ($mbRead MB)   "
            }
        }
        
        $outputStream.Close()
        $inputStream.Close()
        Write-Host ""
    } finally {
        $httpClient.Dispose()
    }
}

function Get-NodeMajor {
    try {
        $version = (& node --version 2>$null).Trim()
        if ($version -match '^v?(\d+)') { return [int]$Matches[1] }
    } catch {}
    return 0
}

function Ensure-Node {
    $major = Get-NodeMajor
    if ($major -ge 20) {
        Write-Good "Node.js $(& node --version) is ready."
        return
    }

    Write-Step 'Node.js 20+ is required. Trying the Windows package manager...'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        foreach ($id in @('OpenJS.NodeJS.LTS', 'OpenJS.NodeJS')) {
            try {
                & winget install --id $id --exact --accept-source-agreements --accept-package-agreements --silent
                Refresh-ProcessPath
                if ((Get-NodeMajor) -ge 20) {
                    Write-Good "Installed Node.js $(& node --version)."
                    return
                }
            } catch {
                Write-Warn "Node install attempt with $id did not finish. Trying the next option..."
            }
        }
    }

    # Fallback: Portable Node.js download
    try {
        Write-Step 'Package manager failed. Downloading portable Node.js LTS...'
        $nodeStaging = Join-Path ([IO.Path]::GetTempPath()) ("eterx-node-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $nodeStaging -Force | Out-Null
        $nodeZip = Join-Path $nodeStaging 'node.zip'
        
        $nodeUrl = 'https://nodejs.org/dist/v20.15.1/node-v20.15.1-win-x64.zip'
        Download-WithProgress -Url $nodeUrl -OutFile $nodeZip -Label 'Portable Node.js'
        Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeStaging -Force
        
        $extractedNodeDir = Get-ChildItem -Path $nodeStaging -Directory | Where-Object { $_.Name -like 'node-*' } | Select-Object -First 1
        if ($extractedNodeDir) {
            $targetNodeDir = Join-Path $InstallDir 'node'
            if (Test-Path $targetNodeDir) { Remove-Item -LiteralPath $targetNodeDir -Recurse -Force -ErrorAction SilentlyContinue }
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
            Move-Item -Path $extractedNodeDir.FullName -Destination $targetNodeDir -Force
            
            $env:Path = "$targetNodeDir;" + $env:Path
            if ((Get-NodeMajor) -ge 20) {
                Write-Good "Portable Node.js configured at $targetNodeDir."
                return
            }
        }
    } catch {
        Write-Warn "Portable Node.js download failed: $($_.Exception.Message)"
    }

    throw 'Could not install Node.js automatically. Install Node.js 20+ from https://nodejs.org, then run this command again.'
}

function Get-ArchiveUrl {
    if ($ArchiveUrl) { return $ArchiveUrl }
    $base = $RepoUrl -replace '\.git$', ''
    return "$base/archive/refs/heads/$Branch.zip"
}

function Get-GitHubApiArchiveUrl {
    try {
        $uri = [Uri]$RepoUrl
        if ($uri.Host -notmatch '(^|\.)github\.com$') { return $null }
        $repo = $uri.AbsolutePath.Trim('/').Replace('.git', '')
        if (-not $repo.Contains('/')) { return $null }
        return "https://api.github.com/repos/$repo/zipball/$Branch"
    } catch {
        return $null
    }
}

function Prepare-InstallDirectory {
    if (Test-EterXSource $InstallDir) {
        if (Test-Path (Join-Path $InstallDir '.git')) {
            try {
                Write-Step 'Existing installation is a Git repository. Syncing with remote branch...'
                Push-Location $InstallDir
                
                # Configure git token if available for authenticated pull
                $url = & git remote get-url origin
                if ($env:ETERX_GITHUB_TOKEN -and $url -match 'github\.com' -and $url -notmatch '@github\.com') {
                    $authedUrl = $url -replace 'https://', "https://$($env:ETERX_GITHUB_TOKEN)@"
                    & git remote set-url origin $authedUrl
                }
                
                & git fetch --all
                & git checkout $Branch
                & git reset --hard "origin/$Branch"
                & git pull
                Pop-Location
                Write-Good "Successfully updated source at $InstallDir."
                return $true
            } catch {
                Write-Warn "Git sync failed: $($_.Exception.Message)"
            }
        }
        Write-Step 'Existing non-Git installation detected. Updating source files to the latest version...'
        if (Try-ArchiveDownload) {
            Write-Good 'Source files successfully updated!'
            return $true
        } else {
            Write-Warn 'Could not update source files; continuing with existing source.'
            return $true
        }
    }

    if (Test-Path $InstallDir) {
        $items = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
        if ($items.Count -gt 0) {
            if (-not $Force -and $env:ETERX_FORCE -ne '1') {
                throw "Install directory already contains unrelated files: $InstallDir. Choose ETERX_DIR or set ETERX_FORCE=1 to replace it."
            }
            Write-Warn "Replacing incomplete installation at $InstallDir..."
            Remove-Item -LiteralPath $InstallDir -Recurse -Force
        }
    }
    return $false
}

function Copy-SourceToInstall([string]$SourcePath) {
    if (-not (Test-EterXSource $SourcePath)) {
        throw 'Downloaded source is incomplete: package.json, setup.js, eterx.js, or src is missing.'
    }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Get-ChildItem -LiteralPath $SourcePath -Force | Copy-Item -Destination $InstallDir -Recurse -Force
    if (-not (Test-EterXSource $InstallDir)) { throw 'Source copy did not complete correctly.' }
    Write-Good "Complete EterX source installed at $InstallDir"
}

function Try-GitDownload {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Warn 'Git is not available; using the archive download fallback.'
        return $false
    }

    $url = $RepoUrl
    if ($env:ETERX_GITHUB_TOKEN -and $url -match 'github\.com') {
        $url = $url -replace 'https://', "https://$($env:ETERX_GITHUB_TOKEN)@"
    }

    $staging = Join-Path ([IO.Path]::GetTempPath()) ("eterx-git-" + [Guid]::NewGuid().ToString('N'))
    try {
        Write-Step 'Downloading the complete EterX source with Git...'
        & git clone --depth 1 --branch $Branch $url $staging
        if ($LASTEXITCODE -ne 0 -or -not (Test-EterXSource $staging)) {
            throw 'Git clone did not return a complete source tree.'
        }
        Copy-SourceToInstall $staging
        return $true
    } catch {
        Write-Warn "Git download failed: $($_.Exception.Message)"
        return $false
    } finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Try-ArchiveDownload {
    $staging = Join-Path ([IO.Path]::GetTempPath()) ("eterx-archive-" + [Guid]::NewGuid().ToString('N'))
    $archive = Join-Path $staging 'eterx.zip'
    try {
        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        $headers = @{ 'User-Agent' = 'EterX-Installer' }
        $url = Get-ArchiveUrl

        # A token lets the same script fetch a private GitHub source archive.
        # It is never printed or written to disk.
        if ($env:ETERX_GITHUB_TOKEN) {
            $apiUrl = Get-GitHubApiArchiveUrl
            if ($apiUrl) { $url = $apiUrl }
            $headers['Authorization'] = "Bearer $($env:ETERX_GITHUB_TOKEN)"
            $headers['Accept'] = 'application/vnd.github+json'
        }

        Write-Step 'Downloading the complete EterX source archive...'
        Download-WithProgress -Url $url -OutFile $archive -Label 'Source Archive' -Headers $headers
        Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force
        $source = Get-ChildItem -LiteralPath $staging -Directory |
            Where-Object { Test-EterXSource $_.FullName } |
            Select-Object -First 1
        if (-not $source) { throw 'The source archive was downloaded but did not contain EterX.' }
        Copy-SourceToInstall $source.FullName
        return $true
    } catch {
        Write-Warn "Archive download failed: $($_.Exception.Message)"
        return $false
    } finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Install-Source {
    if (Prepare-InstallDirectory) { return }
    if (Try-GitDownload) { return }
    if (Try-ArchiveDownload) { return }
    throw 'EterX source could not be downloaded. Check internet access, repository visibility, or set ETERX_GITHUB_TOKEN for private access.'
}

function Invoke-EterXSetup {
    Push-Location $InstallDir
    try {
        $nextCache = Join-Path $InstallDir '.next'
        if (Test-Path $nextCache) {
            Write-Step 'Clearing Next.js compilation cache...'
            Remove-Item -Path $nextCache -Recurse -Force -ErrorAction SilentlyContinue
        }
        $runtimeCache = Join-Path $env:APPDATA 'EterX\runtime'
        if (Test-Path $runtimeCache) {
            Write-Step 'Clearing Electron desktop runtime cache...'
            Remove-Item -Path $runtimeCache -Recurse -Force -ErrorAction SilentlyContinue
        }
        $npmCache = Join-Path $InstallDir 'node_modules\.cache'
        if (Test-Path $npmCache) {
            Remove-Item -Path $npmCache -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Step 'Installing all EterX libraries and creating local storage...'
        $env:NODE_NO_WARNINGS = '1'
        & node .\setup.js --auto --no-doctor
        if ($LASTEXITCODE -ne 0) { throw 'EterX setup failed.' }
    } finally {
        Pop-Location
    }
}

function Start-EterX {
    if ($NoLaunch -or $env:ETERX_NO_LAUNCH -eq '1') {
        Write-Good 'Installation complete. Launch skipped by request.'
        return
    }

    Write-Step 'Launching EterX desktop...'
    $node = (Get-Command node -ErrorAction Stop).Source
    Start-Process -FilePath $node -ArgumentList @('eterx.js', 'desktop') -WorkingDirectory $InstallDir
    Write-Good 'EterX is launching. Add your API key in Settings → API Keys if this is your first run.'
}

$width = 80
try {
    if ($Host.UI.RawUI.WindowSize.Width) {
        $width = $Host.UI.RawUI.WindowSize.Width
    }
} catch {}

Write-Host ""
if ($width -ge 65) {
    Write-Host "                ███████╗████████╗███████╗██████╗ ██╗  ██╗" -ForegroundColor Cyan
    Write-Host "                ██╔════╝╚══██╔══╝██╔════╝██╔══██╗╚██╗██╔╝" -ForegroundColor Cyan
    Write-Host "                █████╗     ██║   █████╗  ██████╔╝ ╚███╔╝ " -ForegroundColor Cyan
    Write-Host "                ██╔══╝     ██║   ██╔══╝  ██╔══██╗ ██╔██╗ " -ForegroundColor Cyan
    Write-Host "                ███████╗   ██║   ███████╗██║  ██║██╔╝ ██╗" -ForegroundColor Cyan
    Write-Host "                ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "                    The Autonomous AI Agent" -ForegroundColor Magenta
    Write-Host "                    ✦ Built by Harshil Soni" -ForegroundColor Gray
} elseif ($width -ge 52) {
    Write-Host "  ███████╗████████╗███████╗██████╗ ██╗  ██╗" -ForegroundColor Cyan
    Write-Host "  ██╔════╝╚══██╔══╝██╔════╝██╔══██╗╚██╗██╔╝" -ForegroundColor Cyan
    Write-Host "  █████╗     ██║   █████╗  ██████╔╝ ╚███╔╝ " -ForegroundColor Cyan
    Write-Host "  ██╔══╝     ██║   ██╔══╝  ██╔══██╗ ██╔██╗ " -ForegroundColor Cyan
    Write-Host "  ███████╗   ██║   ███████╗██║  ██║██╔╝ ██╗" -ForegroundColor Cyan
    Write-Host "  ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "    The Autonomous AI Agent" -ForegroundColor Magenta
    Write-Host "    ✦ Built by Harshil Soni" -ForegroundColor Gray
} else {
    Write-Host "  EterX Agent" -ForegroundColor Cyan
    Write-Host "  The Autonomous AI Agent" -ForegroundColor Magenta
    Write-Host "  ✦ Built by Harshil Soni" -ForegroundColor Gray
}
$sepLen = [Math]::Min($width - 4, 60)
if ($sepLen -lt 10) { $sepLen = 10 }
Write-Host "  $('━' * $sepLen)" -ForegroundColor Gray
Write-Host "  Destination Path : $InstallDir" -ForegroundColor Yellow
Write-Host "  Required Modules :" -ForegroundColor Gray
Write-Host "    - Core Engine & Local Workspace Storage" -ForegroundColor DarkGray
Write-Host "    - Next.js & React UI Modules" -ForegroundColor DarkGray
Write-Host "    - Electron Native Windows Wrapper" -ForegroundColor DarkGray
Write-Host "    - Gemini & Universal AI Provider Router" -ForegroundColor DarkGray
Write-Host "  $('━' * $sepLen)" -ForegroundColor Gray
Write-Host ""

try {
    Ensure-Node
    Install-Source
    Invoke-EterXSetup
    Start-EterX
} catch {
    Write-Host "`n  [EterX] Installation could not finish: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  Keep this window open, fix the reported prerequisite, then run the same command again.' -ForegroundColor Yellow
    throw
}
