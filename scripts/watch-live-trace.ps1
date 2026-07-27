param(
  [string]$TraceFile = (Join-Path (Get-Location) 'logs\syn-live.jsonl')
)

if (-not (Test-Path -LiteralPath $TraceFile)) {
  Write-Host "Waiting for $TraceFile ..."
  while (-not (Test-Path -LiteralPath $TraceFile)) { Start-Sleep -Milliseconds 500 }
}

Get-Content -LiteralPath $TraceFile -Wait | ForEach-Object {
  try {
    $event = $_ | ConvertFrom-Json
    $summary = switch ($event.kind) {
      'synapse_injection' { "SYNAPSE state=$($event.state) conf=$($event.confidence) injected=$($event.decisionSurface.finalCount)"; break }
      'model_request' { "MODEL -> $($event.model) systemChars=$($event.systemInstruction.Length) messages=$($event.contents.Count)"; break }
      'monitor_event' { "MONITOR $($event.type) $($event.tool) $($event.text)"; break }
      default { "$($event.kind)" }
    }
    Write-Host "[$($event.ts)] $summary"
  } catch { Write-Host $_ }
}
