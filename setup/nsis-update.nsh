!macro customInit
  # Older EterX clients already pass --updated and --force-run, but omit /S.
  # Make their next update silent too. Ordinary first-time installs keep the
  # assisted setup UI, and NSIS still handles installation scope and elevation.
  ${if} ${isUpdated}
    SetSilent silent
  ${endIf}
!macroend
