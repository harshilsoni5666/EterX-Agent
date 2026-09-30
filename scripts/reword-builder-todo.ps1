param([Parameter(Mandatory = $true)][string]$Path)

$content = Get-Content -LiteralPath $Path
$content = $content -replace '^pick 308c32a ', 'reword 308c32a '
$content = $content -replace '^pick 697b389 ', 'reword 697b389 '
$content = $content -replace '^pick 7500681 ', 'reword 7500681 '
$content | Set-Content -LiteralPath $Path
