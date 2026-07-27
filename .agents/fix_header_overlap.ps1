$file = "c:\Harshil projects\EterX-Agent\src\app\page.tsx"
$content = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

# Fix 1: Left side of header - add flex-1 overflow-hidden so it shrinks and doesn't push right icons
$old1 = '<div className="flex min-w-0 items-center gap-2 pointer-events-auto [-webkit-app-region:no-drag]">'
$new1 = '<div className="flex min-w-0 flex-1 overflow-hidden items-center gap-2 pointer-events-auto [-webkit-app-region:no-drag]">'

# Fix 2: Right side of header - ensure it stays shrink-0 with overflow-visible
$old2 = '<div className="flex shrink-0 items-center gap-1.5 pointer-events-auto [-webkit-app-region:no-drag]">'
$new2 = '<div className="flex shrink-0 items-center gap-1 pointer-events-auto [-webkit-app-region:no-drag] ml-auto">'

$count1 = ([regex]::Matches($content, [regex]::Escape($old1))).Count
$count2 = ([regex]::Matches($content, [regex]::Escape($old2))).Count

Write-Host "Fix1 matches: $count1"
Write-Host "Fix2 matches: $count2"

if ($count1 -eq 1) {
    $content = $content.Replace($old1, $new1)
    Write-Host "Applied Fix1: left header div gets flex-1 overflow-hidden"
} else {
    Write-Host "SKIP Fix1: expected 1 match, got $count1"
}

if ($count2 -eq 1) {
    $content = $content.Replace($old2, $new2)
    Write-Host "Applied Fix2: right header div gets ml-auto"
} else {
    Write-Host "SKIP Fix2: expected 1 match, got $count2"
}

[System.IO.File]::WriteAllText($file, $content, [System.Text.Encoding]::UTF8)
Write-Host "Done."
