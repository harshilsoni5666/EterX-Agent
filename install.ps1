[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'EterX\Source'),
  [string]$Branch = 'main',
  [int]$WaitForPid = 0,
  [switch]$NoLaunch,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:Repository = 'harshilsoni5666/EterX-Agent'
$script:LogDir = Join-Path $env:LOCALAPPDATA 'EterX\Installer'
$script:LogFile = Join-Path $script:LogDir 'install.log'
$script:DataDir = Join-Path $env:LOCALAPPDATA 'EterX\Data'
$script:TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("eterx-install-" + [guid]::NewGuid().ToString('N'))
$script:BackupDir = $null

New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null

function Write-Log([string]$Message) {
  Add-Content -LiteralPath $script:LogFile -Value "[$([DateTime]::UtcNow.ToString('o'))] $Message" -Encoding UTF8
}

function Write-Stage([int]$Number, [int]$Percent, [string]$Title, [string]$Detail) {
  $width = 34
  $filled = [Math]::Floor($Percent * $width / 100)
  $bar = ('#' * $filled) + ('-' * ($width - $filled))
  Write-Host ""
  Write-Host ("  [{0}] {1,3}%  {2}" -f $bar, $Percent, $Title) -ForegroundColor Cyan
  if ($Detail) { Write-Host "  $Detail" -ForegroundColor DarkGray }
  Write-Log "Stage $Number ($Percent%): $Title - $Detail"
}

function Get-NodeMajor {
  try {
    $version = (& node --version 2>$null).TrimStart('v')
    return [int]($version.Split('.')[0])
  } catch { return 0 }
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Install-NodeRuntime {
  if ((Get-NodeMajor) -ge 20) { return }
  Write-Host '  Node.js 20+ was not found. Installing the per-user LTS runtime...' -ForegroundColor Yellow
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw 'Node.js 20+ is required and Windows Package Manager (winget) is unavailable. Install Node.js LTS from https://nodejs.org and run this command again.'
  }
  & $winget.Source install --id OpenJS.NodeJS.LTS --exact --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "Node.js installation failed with exit code $LASTEXITCODE." }
  Refresh-ProcessPath
  if ((Get-NodeMajor) -lt 20) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\nodejs'
    if (Test-Path $candidate) { $env:Path = "$candidate;$env:Path" }
  }
  if ((Get-NodeMajor) -lt 20) { throw 'Node.js installed, but the current terminal could not locate it. Open a new terminal and rerun the installer.' }
}

function Download-File([string]$Url, [string]$Destination) {
  Add-Type -AssemblyName System.Net.Http
  $client = [Net.Http.HttpClient]::new()
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('EterX-Installer/1.0')
  try {
    $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode()
    $total = $response.Content.Headers.ContentLength
    $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $output = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $buffer = New-Object byte[] 1048576
      [long]$readTotal = 0
      while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $output.Write($buffer, 0, $read)
        $readTotal += $read
        if ($total -and $total -gt 0) {
          $pct = [Math]::Min(100, [Math]::Floor($readTotal * 100 / $total))
          $mb = [Math]::Round($readTotal / 1MB, 1)
          $totalMb = [Math]::Round($total / 1MB, 1)
          Write-Progress -Activity 'Downloading EterX source' -Status "$mb MB / $totalMb MB" -PercentComplete $pct
        }
      }
    } finally {
      $output.Dispose()
      $input.Dispose()
      Write-Progress -Activity 'Downloading EterX source' -Completed
    }
  } finally { $client.Dispose() }
}

function Copy-PreservedData([string]$From, [string]$To) {
  foreach ($name in @('.env.local')) {
    $source = Join-Path $From $name
    $destination = Join-Path $To $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
      Write-Log "Preserved $name"
    }
  }
  $workspaceSource = Join-Path $From '.workspaces'
  if ((Test-Path -LiteralPath $workspaceSource) -and -not (Test-Path -LiteralPath $script:DataDir)) {
    Copy-Item -LiteralPath $workspaceSource -Destination $script:DataDir -Recurse -Force
    Write-Log 'Migrated .workspaces to the device data directory'
  }
}

function Connect-DeviceData([string]$ApplicationRoot) {
  New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null
  $workspaceLink = Join-Path $ApplicationRoot '.workspaces'
  if (Test-Path -LiteralPath $workspaceLink) { Remove-Item -LiteralPath $workspaceLink -Recurse -Force }
  New-Item -ItemType Junction -Path $workspaceLink -Target $script:DataDir | Out-Null
  Write-Log "Connected application workspace to $script:DataDir"
}

function Stop-EterXProcesses([string]$ApplicationRoot) {
  if (-not (Test-Path -LiteralPath $ApplicationRoot)) { return }
  $normalizedRoot = [IO.Path]::GetFullPath($ApplicationRoot).TrimEnd('\') + '\'
  $currentId = $PID
  $stopped = 0
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    $executable = [string]$_.ExecutablePath
    $commandLine = [string]$_.CommandLine
    $belongsToEterX = ($executable.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) -or
      (($commandLine.IndexOf($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) -and
       ($commandLine -match 'electron|next[\\/]dist|setup[\\/]launcher'))
    if ($belongsToEterX -and $_.ProcessId -ne $currentId) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped++
    }
  }
  if ($stopped -gt 0) {
    Write-Host "  Closed $stopped running EterX process(es) before replacing application files." -ForegroundColor Yellow
    Start-Sleep -Milliseconds 900
  }
}

function Restore-PreviousInstall {
  if (-not $script:BackupDir -or -not (Test-Path -LiteralPath $script:BackupDir)) { return }
  Write-Host '  Restoring the previous working installation...' -ForegroundColor Yellow
  if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
  Move-Item -LiteralPath $script:BackupDir -Destination $InstallDir
  $script:BackupDir = $null
}

try {
  if ($WaitForPid -gt 0) {
    Write-Log "Waiting for updater parent process $WaitForPid to exit"
    Wait-Process -Id $WaitForPid -ErrorAction SilentlyContinue
  }
  Write-Host ''
  Write-Host '  ETERX  |  Professional Source Installer' -ForegroundColor White
  Write-Host '  Complete application, dependencies, repair, and update support' -ForegroundColor DarkGray

  Write-Stage 1 5 'Checking this device' 'Windows, storage path, and required runtime'
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable for this Windows user.' }
  Install-NodeRuntime
  Write-Host "  [OK] Node.js $(& node --version)" -ForegroundColor Green

  Write-Stage 2 15 'Preparing a safe download' "Branch: $Branch"
  New-Item -ItemType Directory -Force -Path $script:TempRoot | Out-Null
  $archive = Join-Path $script:TempRoot 'eterx.zip'
  $archiveUrl = "https://codeload.github.com/$script:Repository/zip/refs/heads/$Branch"
  Download-File -Url $archiveUrl -Destination $archive
  if ((Get-Item -LiteralPath $archive).Length -lt 1024) { throw 'Downloaded archive is unexpectedly small.' }

  Write-Stage 3 35 'Verifying and extracting' 'The existing installation is still untouched'
  $extractRoot = Join-Path $script:TempRoot 'extract'
  Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
  $source = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (-not $source -or -not (Test-Path (Join-Path $source.FullName 'package.json')) -or -not (Test-Path (Join-Path $source.FullName 'setup.js'))) {
    throw 'The downloaded package failed EterX integrity checks.'
  }

  Write-Stage 4 48 'Installing application files' $InstallDir
  Stop-EterXProcesses -ApplicationRoot $InstallDir
  $parent = Split-Path -Parent $InstallDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if (Test-Path -LiteralPath $InstallDir) {
    $script:BackupDir = "$InstallDir.previous-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
    Move-Item -LiteralPath $InstallDir -Destination $script:BackupDir
  }
  Move-Item -LiteralPath $source.FullName -Destination $InstallDir
  if ($script:BackupDir) { Copy-PreservedData -From $script:BackupDir -To $InstallDir }
  Connect-DeviceData -ApplicationRoot $InstallDir

  Write-Stage 5 58 'Installing libraries' 'Live details are recorded in the installer log'
  Push-Location $InstallDir
  try {
    & node setup.js --auto --source-install
    if ($LASTEXITCODE -ne 0) { throw "EterX setup failed with exit code $LASTEXITCODE." }
  } finally { Pop-Location }

  Write-Stage 6 96 'Finalizing shortcuts and update metadata' "User data: $script:DataDir"
  if ($script:BackupDir -and (Test-Path -LiteralPath $script:BackupDir)) {
    Remove-Item -LiteralPath $script:BackupDir -Recurse -Force
    $script:BackupDir = $null
  }

  Write-Stage 7 100 'EterX is ready' "Installed at $InstallDir"
  Write-Host ''
  Write-Host '  Updates: open a terminal and run  eterx update' -ForegroundColor Gray
  Write-Host "  Installer log: $script:LogFile" -ForegroundColor Gray

  if (-not $NoLaunch) {
    $launcher = Join-Path $InstallDir 'EterX.bat'
    if (Test-Path -LiteralPath $launcher) { Start-Process -FilePath $launcher -WorkingDirectory $InstallDir }
  }
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  try { Restore-PreviousInstall } catch { Write-Log "ROLLBACK FAILED: $($_.Exception.Message)" }
  Write-Host ''
  Write-Host '  Installation did not complete.' -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Your previous installation was preserved. Log: $script:LogFile" -ForegroundColor Yellow
  exit 1
} finally {
  if (Test-Path -LiteralPath $script:TempRoot) { Remove-Item -LiteralPath $script:TempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
