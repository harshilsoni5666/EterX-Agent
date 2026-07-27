$file = "c:\Harshil projects\EterX-Agent\src\app\page.tsx"
$content = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

# Fix 3: Top bar outer container - add overflow-hidden so buttons don't bleed into window controls
$old3 = '<div className="pointer-events-none absolute top-0 left-0 right-[150px] h-[var(--eterx-shell-topbar-height)] z-[999] flex items-center">'
$new3 = '<div className="pointer-events-none absolute top-0 left-0 right-[150px] h-[var(--eterx-shell-topbar-height)] z-[999] flex items-center overflow-hidden">'

# Fix 4: Action buttons container - add min-w-0 overflow-hidden so they clip rather than overlap
$old4 = '<div className="pointer-events-auto flex items-center [-webkit-app-region:no-drag]">'
$new4 = '<div className="pointer-events-auto flex items-center gap-0 min-w-0 overflow-hidden [-webkit-app-region:no-drag]">'

$count3 = ([regex]::Matches($content, [regex]::Escape($old3))).Count
$count4 = ([regex]::Matches($content, [regex]::Escape($old4))).Count

Write-Host "Fix3 matches: $count3"
Write-Host "Fix4 matches: $count4"

if ($count3 -eq 1) {
    $content = $content.Replace($old3, $new3)
    Write-Host "Applied Fix3: top bar gets overflow-hidden"
} else {
    Write-Host "SKIP Fix3: expected 1 match, got $count3"
}

if ($count4 -eq 1) {
    $content = $content.Replace($old4, $new4)
    Write-Host "Applied Fix4: action buttons get min-w-0 overflow-hidden"
} else {
    Write-Host "SKIP Fix4: expected 1 match, got $count4 - checking all occurrences:"
    $lines = $content -split "`n"
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "pointer-events-auto flex items-center") {
            Write-Host "Line $($i+1): $($lines[$i])"
        }
    }
}

[System.IO.File]::WriteAllText($file, $content, [System.Text.Encoding]::UTF8)
Write-Host "Done."
