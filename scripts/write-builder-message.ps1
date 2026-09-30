param([Parameter(Mandatory = $true)][string]$Path)

$existing = Get-Content -LiteralPath $Path -Raw

if ($existing -match 'Updated agent builder UI') {
    $message = 'Added agent builder profile metadata, readiness details, import handling, and library UI'
} elseif ($existing -match 'Fixed custom agent runtime') {
    $message = 'Unified custom agent runtime tools, preserved chat continuity, and added host UI contracts'
} else {
    $message = 'Fixed Agent Builder composer layout, matched shared model controls, and moved attachment actions to the right side'
}

Set-Content -LiteralPath $Path -Value $message
