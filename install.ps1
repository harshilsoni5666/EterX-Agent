[CmdletBinding()]
param(
  [ValidateSet('stable')][string]$Channel = 'stable'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:Repository = 'harshilsoni5666/EterX-Agent'
$script:ApiBase = "https://api.github.com/repos/$script:Repository"
$script:StateRoot = Join-Path $env:LOCALAPPDATA 'EterX\Installer'
$script:LogFile = Join-Path $script:StateRoot 'install.log'
$script:TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("eterx-bootstrap-" + [guid]::NewGuid().ToString('N'))

function Write-Log([string]$Message) {
  New-Item -ItemType Directory -Force -Path $script:StateRoot | Out-Null
  Add-Content -LiteralPath $script:LogFile -Value "[$([DateTime]::UtcNow.ToString('o'))] $Message" -Encoding UTF8
}

function Show-Stage([int]$Percent, [string]$Title, [string]$Detail) {
  $width = 32
  $filled = [Math]::Floor($Percent * $width / 100)
  $bar = ([string][char]0x2588 * $filled) + ([string][char]0x2591 * ($width - $filled))
  Write-Host ''
  Write-Host ("  [{0}] {1,3}%  {2}" -f $bar, $Percent, $Title) -ForegroundColor Cyan
  if ($Detail) { Write-Host "  $Detail" -ForegroundColor DarkGray }
  Write-Log "$Percent% $Title - $Detail"
}

function Invoke-WithRetry([scriptblock]$Operation, [string]$Description, [int]$Attempts = 4) {
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try { return & $Operation }
    catch {
      if ($attempt -eq $Attempts) { throw }
      $delay = [Math]::Min(12, [Math]::Pow(2, $attempt))
      Write-Log "$Description failed on attempt ${attempt}: $($_.Exception.Message)"
      Write-Host "  Retrying $Description in $delay seconds..." -ForegroundColor Yellow
      Start-Sleep -Seconds $delay
    }
  }
}

function Get-DeviceArchitecture {
  $architecture = [string]$env:PROCESSOR_ARCHITEW6432
  if (-not $architecture) { $architecture = [string]$env:PROCESSOR_ARCHITECTURE }
  if ($architecture -match 'ARM64') { return 'arm64' }
  if ([Environment]::Is64BitOperatingSystem) { return 'x64' }
  throw 'EterX requires a 64-bit Windows device.'
}

function Get-LatestRelease {
  $headers = @{
    Accept = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent' = 'EterX-Bootstrap/2'
  }
  return Invoke-WithRetry {
    Invoke-RestMethod -Uri "$script:ApiBase/releases/latest" -Headers $headers -MaximumRedirection 5
  } 'release lookup'
}

function Save-Download([string]$Url, [string]$Destination, [string]$Label) {
  Add-Type -AssemblyName System.Net.Http
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
  $client = [Net.Http.HttpClient]::new($handler)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('EterX-Bootstrap/2')
  try {
    Invoke-WithRetry {
      if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
      $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      $response.EnsureSuccessStatusCode()
      [long]$total = 0
      if ($null -ne $response.Content.Headers.ContentLength) {
        $total = [long]$response.Content.Headers.ContentLength
      }
      $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $buffer = New-Object byte[] 1048576
        [long]$received = 0
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $outputStream.Write($buffer, 0, $count)
          $received += $count
          if ($total -gt 0) {
            $percent = [Math]::Min(100, [Math]::Floor($received * 100 / $total))
            $receivedMb = [Math]::Round($received / 1MB, 1)
            $totalMb = [Math]::Round($total / 1MB, 1)
            Write-Progress -Activity $Label -Status "$receivedMb MB / $totalMb MB" -PercentComplete $percent
          }
        }
      } finally {
        $outputStream.Dispose()
        $inputStream.Dispose()
        Write-Progress -Activity $Label -Completed
      }
    } "download of $Label"
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Confirm-Checksum([string]$ArtifactPath, [string]$ChecksumsPath) {
  $artifactName = Split-Path -Leaf $ArtifactPath
  $line = Get-Content -LiteralPath $ChecksumsPath | Where-Object {
    $_ -match ("^[A-Fa-f0-9]{64}\s+\*?" + [regex]::Escape($artifactName) + '$')
  } | Select-Object -First 1
  if (-not $line) { throw "The release checksum manifest does not contain $artifactName." }
  $expected = ($line -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Security verification failed for $artifactName." }
  Write-Log "Verified SHA-256 $actual for $artifactName"
}

try {
  if (-not $env:LOCALAPPDATA) { throw 'Windows Local AppData is unavailable for this user.' }
  New-Item -ItemType Directory -Force -Path $script:TempRoot | Out-Null

  Write-Host ''
  Write-Host '  ETERX' -ForegroundColor White
  Write-Host '  Secure desktop installation for Windows' -ForegroundColor DarkGray

  $architecture = Get-DeviceArchitecture
  Show-Stage 8 'Detecting this device' "Windows $architecture | per-user installation"

  Show-Stage 18 'Resolving the latest stable release' "GitHub: $script:Repository"
  $release = Get-LatestRelease
  $assetPattern = "^EterX-.+-win-$architecture\.exe$"
  $installerAsset = @($release.assets) | Where-Object { $_.name -match $assetPattern } | Select-Object -First 1
  $checksumAsset = @($release.assets) | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
  if (-not $installerAsset) { throw "Release $($release.tag_name) has no Windows $architecture installer." }
  if (-not $checksumAsset) { throw "Release $($release.tag_name) has no SHA256SUMS.txt manifest." }

  $installerPath = Join-Path $script:TempRoot $installerAsset.name
  $checksumPath = Join-Path $script:TempRoot 'SHA256SUMS.txt'
  Show-Stage 30 'Downloading the native application' "$($release.tag_name) | $($installerAsset.name)"
  Save-Download $installerAsset.browser_download_url $installerPath 'Downloading EterX'
  Save-Download $checksumAsset.browser_download_url $checksumPath 'Downloading security manifest'

  Show-Stage 72 'Verifying release integrity' 'SHA-256 manifest validation'
  Confirm-Checksum $installerPath $checksumPath
  $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
  if ($signature.Status -eq 'Valid') {
    Write-Host "  Publisher signature: $($signature.SignerCertificate.Subject)" -ForegroundColor Green
  } elseif ($signature.Status -notin @('NotSigned', 'UnknownError')) {
    throw "The Windows publisher signature is not valid: $($signature.Status)."
  } else {
    Write-Host '  Publisher signature is not present; SHA-256 verification succeeded.' -ForegroundColor Yellow
    Write-Log 'Installer is not Authenticode-signed.'
  }

  Show-Stage 84 'Opening the EterX installer' 'Choose the application location and shortcut options'
  $process = Start-Process -FilePath $installerPath -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "The native installer exited with code $($process.ExitCode)." }

  Show-Stage 100 'EterX is installed' 'Future updates are downloaded safely inside the app'
  Write-Host ''
  Write-Host '  Your chats, settings, credentials, and workspaces are stored separately' -ForegroundColor Gray
  Write-Host '  in Local AppData and remain intact across updates.' -ForegroundColor Gray
  Write-Host "  Installer log: $script:LogFile" -ForegroundColor DarkGray
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  Write-Host ''
  Write-Host '  EterX installation did not complete.' -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  No existing EterX user data was changed. Log: $script:LogFile" -ForegroundColor Yellow
  exit 1
} finally {
  if (Test-Path -LiteralPath $script:TempRoot) {
    Remove-Item -LiteralPath $script:TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
