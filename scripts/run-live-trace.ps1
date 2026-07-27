param(
  [string]$TraceFile = (Join-Path (Get-Location) 'logs\syn-live.jsonl')
)

$traceDirectory = Split-Path -Parent $TraceFile
New-Item -ItemType Directory -Force -Path $traceDirectory | Out-Null
$env:ETERX_TRACE_FILE = [IO.Path]::GetFullPath($TraceFile)
Write-Host "EterX live trace: $env:ETERX_TRACE_FILE"
Write-Host 'Start the agent normally in this process. Use another terminal to tail the JSONL file.'
npm run dev
