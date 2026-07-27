$cssFile = "c:\Harshil projects\EterX-Agent\src\app\globals.css"
$css = [System.IO.File]::ReadAllText($cssFile, [System.Text.Encoding]::UTF8)

# Add narrow-window fix BEFORE the existing compact laptop media query (line ~6812)
$insertBefore = "/* Compact laptops: 11-13 inch devices and narrow development windows. */"

$newCSS = @"

/* ── Narrow window overlap fix ──────────────────────────────────────────────
   When the app is used in a narrow window (< 900px wide), the topbar
   nav buttons (API, Models, Theme, Help, Updates) and the main-header
   right-side icon group can collide with each other and with the chat area.
   We prevent this by:
   1. Reducing topbar button padding and hiding less-critical labels.
   2. Clamping the main-header right icon group gap so icons don't overflow.
   ─────────────────────────────────────────────────────────────────────────── */
@media (max-width: 900px) {
  .eterx-topbar-btn {
    padding-left: 6px !important;
    padding-right: 6px !important;
    font-size: 12px !important;
  }

  /* Prevent the main header left+right sections from overlapping */
  .eterx-main-header {
    gap: 4px !important;
    padding-right: 8px !important;
    padding-left: 8px !important;
  }

  /* Right-side icon group: tighten gap */
  .eterx-header-icon-button {
    width: 30px !important;
    height: 30px !important;
  }
}

@media (max-width: 680px) {
  /* At very small widths, hide topbar text-nav buttons entirely to avoid overlap */
  .eterx-topbar-btn {
    display: none !important;
  }
}

"@

if ($css.Contains($insertBefore)) {
    $css = $css.Replace($insertBefore, $newCSS + $insertBefore)
    [System.IO.File]::WriteAllText($cssFile, $css, [System.Text.Encoding]::UTF8)
    Write-Host "SUCCESS: Narrow window CSS added."
} else {
    # Append to end of file if marker not found
    $css = $css + "`n" + $newCSS
    [System.IO.File]::WriteAllText($cssFile, $css, [System.Text.Encoding]::UTF8)
    Write-Host "SUCCESS: Appended narrow window CSS to end of file."
}
