#!/usr/bin/env sh
set -eu
umask 077

# XDG paths must be absolute; a relative value must never redirect installation
# or launcher registration into the caller's working directory.
case "${XDG_DATA_HOME:-}" in /*) ;; *) XDG_DATA_HOME="$HOME/.local/share" ;; esac
case "${XDG_STATE_HOME:-}" in /*) ;; *) XDG_STATE_HOME="$HOME/.local/state" ;; esac
case "${XDG_CACHE_HOME:-}" in /*) ;; *) XDG_CACHE_HOME="$HOME/.cache" ;; esac

REPOSITORY="harshilsoni5666/EterX-Agent"
API_URL="https://api.github.com/repos/$REPOSITORY/releases/latest"
OS="$(uname -s)"
MACHINE="$(uname -m)"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/eterx-bootstrap.XXXXXX")"
ACTIVE_DOWNLOAD_PID=""

case "$OS" in
  Darwin)
    PLATFORM="mac"
    STATE_ROOT="${HOME}/Library/Logs/EterX"
    CACHE_ROOT="${HOME}/Library/Caches/EterX/Installer"
    DEFAULT_INSTALL_DIR="${HOME}/Applications"
    ;;
  Linux)
    PLATFORM="linux"
    STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/EterX"
    CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/EterX/Installer"
    DEFAULT_INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/EterX"
    ;;
  *)
    printf '\n  EterX supports Windows, macOS, and Linux. Detected: %s\n' "$OS" >&2
    exit 1
    ;;
esac

case "$MACHINE" in
  x86_64|amd64)
    ARCH="x64"
    # electron-builder uses its canonical x64 artifact name on Linux.
    LINUX_ARCH="x64"
    LINUX_ARCH_FALLBACK="x86_64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    LINUX_ARCH="arm64"
    LINUX_ARCH_FALLBACK=""
    ;;
  *) printf '\n  EterX requires a 64-bit Intel/AMD or ARM device. Detected: %s\n' "$MACHINE" >&2; exit 1 ;;
esac

INSTALL_DIR="${ETERX_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
# Desktop-entry Exec paths must be absolute. Normalize a relative override so
# a caller cannot accidentally create a launcher that only works from the
# directory where the bootstrap was invoked.
case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac
LOG_FILE="$STATE_ROOT/install.log"
LOCK_DIR="$STATE_ROOT/.install.lock"
mkdir -p "$STATE_ROOT" "$CACHE_ROOT"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  old_pid=""
  [ -f "$LOCK_DIR/pid" ] && old_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && ! kill -0 "$old_pid" 2>/dev/null; then
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR"
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  printf '\n  Another EterX installer is already running. Finish it before starting another installation.\n' >&2
  exit 1
}

acquire_lock

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"; }
stage() {
  percent="$1" title="$2" detail="$3"
  width=32
  filled=$((percent * width / 100))
  empty=$((width - filled))
  bar="$(printf '%*s' "$filled" '' | tr ' ' '#')$(printf '%*s' "$empty" '' | tr ' ' '-')"
  printf '\n  [%s] %3s%%  %s\n  %s\n' "$bar" "$percent" "$title" "$detail"
  log "$percent% $title - $detail"
}
cleanup() {
  if [ -n "$ACTIVE_DOWNLOAD_PID" ]; then
    kill "$ACTIVE_DOWNLOAD_PID" 2>/dev/null || true
    wait "$ACTIVE_DOWNLOAD_PID" 2>/dev/null || true
    ACTIVE_DOWNLOAD_PID=""
  fi
  rm -rf "$TEMP_ROOT" "$LOCK_DIR"
}
on_exit() {
  code=$?
  trap - EXIT INT TERM HUP
  if [ "$code" -ne 0 ]; then
    log "FAILED with exit code $code"
    printf '\n  EterX installation did not complete.\n  Existing EterX user data was not changed. Log: %s\n' "$LOG_FILE" >&2
  fi
  cleanup
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

download() {
  url="$1" destination="$2"
  part="${destination}.part"
  status_file="${part}.status"
  error_file="${part}.error"
  header_file="${part}.headers"
  phase_file="${part}.phase"
  if [ -s "$destination" ]; then
    printf '  Reusing the cached %s; its SHA-256 will be verified before installation.\n' "$(basename "$destination")"
    log "Reusing cached download $(basename "$destination")"
    return 0
  fi
  # Keep the partial payload so a later installer run can resume it. Sidecars
  # are per-process and must be reset so stale status cannot report success.
  rm -f "$status_file" "$error_file" "$header_file" "$phase_file"
  remote_size=""

  # A HEAD request gives us a real percentage for large GitHub CDN assets. It
  # is only a display hint; a missing or chunked Content-Length never blocks
  # the download.
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --http1.1 --head \
      --connect-timeout 15 --max-time 45 \
      --header 'Accept: application/vnd.github+json' \
      --header 'X-GitHub-Api-Version: 2022-11-28' \
      --user-agent 'EterX-Bootstrap/4' "$url" > "$header_file" 2>/dev/null || true
    remote_size="$(awk 'BEGIN { IGNORECASE=1 } /^content-length:/ { gsub("\r", "", $2); value=$2 } END { print value }' "$header_file" 2>/dev/null || true)"
  fi

  : > "$status_file"
  printf 'Connecting to the release server' > "$phase_file"
  if command -v curl >/dev/null 2>&1; then
    (
      attempt=1
      max_attempts=6
      : > "$error_file"
      while [ "$attempt" -le "$max_attempts" ]; do
        printf 'Connecting (attempt %s of %s)' "$attempt" "$max_attempts" > "$phase_file"
        attempt_error="${error_file}.${attempt}"
        if [ -s "$part" ]; then
          if curl --fail --silent --show-error --location --http1.1 \
            --connect-timeout 20 --max-time 900 --speed-limit 1024 --speed-time 45 \
            --header 'Accept: application/vnd.github+json' \
            --header 'X-GitHub-Api-Version: 2022-11-28' \
            --user-agent 'EterX-Bootstrap/4' --continue-at - \
            "$url" --output "$part" > /dev/null 2> "$attempt_error"; then
            cat "$attempt_error" >> "$error_file" 2>/dev/null || true
            rm -f "$attempt_error"
            printf '0' > "$status_file"
            exit 0
          fi
        else
          if curl --fail --silent --show-error --location --http1.1 \
            --connect-timeout 20 --max-time 900 --speed-limit 1024 --speed-time 45 \
            --header 'Accept: application/vnd.github+json' \
            --header 'X-GitHub-Api-Version: 2022-11-28' \
            --user-agent 'EterX-Bootstrap/4' \
            "$url" --output "$part" > /dev/null 2> "$attempt_error"; then
            cat "$attempt_error" >> "$error_file" 2>/dev/null || true
            rm -f "$attempt_error"
            printf '0' > "$status_file"
            exit 0
          fi
        fi
        cat "$attempt_error" >> "$error_file" 2>/dev/null || true
        if grep -Eiq 'range|resume|offset|server does not support byte ranges' "$attempt_error" 2>/dev/null; then
          rm -f "$part"
        fi
        rm -f "$attempt_error"
        [ "$attempt" -ge "$max_attempts" ] && break
        case "$attempt" in
          1) delay=2 ;;
          2) delay=4 ;;
          3) delay=6 ;;
          *) delay=10 ;;
        esac
        printf 'Connection stalled; resuming in %s seconds' "$delay" > "$phase_file"
        sleep "$delay"
        attempt=$((attempt + 1))
      done
      printf '1' > "$status_file"
    ) &
  elif command -v wget >/dev/null 2>&1; then
    (
      attempt=1
      max_attempts=6
      : > "$error_file"
      while [ "$attempt" -le "$max_attempts" ]; do
        printf 'Connecting (attempt %s of %s)' "$attempt" "$max_attempts" > "$phase_file"
        if wget --continue --tries=1 --timeout=20 --read-timeout=45 --quiet \
          --user-agent='EterX-Bootstrap/4' -O "$part" "$url" > /dev/null 2>> "$error_file"; then
          printf '0' > "$status_file"
          exit 0
        fi
        [ "$attempt" -ge "$max_attempts" ] && break
        delay=$((attempt * 2))
        printf 'Connection stalled; resuming in %s seconds' "$delay" > "$phase_file"
        sleep "$delay"
        attempt=$((attempt + 1))
      done
      printf '1' > "$status_file"
    ) &
  else
    printf '  curl or wget is required to download EterX.\n' >&2
    return 1
  fi

  download_pid=$!
  ACTIVE_DOWNLOAD_PID="$download_pid"
  spinner='|/-\\'
  spinner_index=1
  elapsed_ticks=0
  while [ ! -s "$status_file" ]; do
    current_bytes=0
    [ -f "$part" ] && current_bytes="$(wc -c < "$part" | tr -d '[:space:]')"
    current_mb="$(awk -v bytes="$current_bytes" 'BEGIN { printf "%.1f", bytes / 1048576 }')"
    elapsed_seconds=$((elapsed_ticks / 4))
    if [ "$current_bytes" -eq 0 ]; then
      marker="$(printf '%s' "$spinner" | cut -c "$spinner_index")"
      phase="$(cat "$phase_file" 2>/dev/null || printf 'Connecting')"
      printf '\r\033[K  [%s]  ...  %s - waiting for release data (%ss)' "$marker" "$phase" "$elapsed_seconds"
      spinner_index=$((spinner_index % 4 + 1))
    elif printf '%s' "$remote_size" | grep -Eq '^[0-9]+$' && [ "$remote_size" -gt 0 ]; then
      percent=$((current_bytes * 100 / remote_size))
      [ "$percent" -gt 100 ] && percent=100
      filled=$((percent * 32 / 100))
      empty=$((32 - filled))
      bar="$(printf '%*s' "$filled" '' | tr ' ' '#')$(printf '%*s' "$empty" '' | tr ' ' '-')"
      printf '\r\033[K  [%s] %3s%%  Downloading %s (%s MB)' "$bar" "$percent" "$(basename "$destination")" "$current_mb"
    else
      marker="$(printf '%s' "$spinner" | cut -c "$spinner_index")"
      phase="$(cat "$phase_file" 2>/dev/null || printf 'Connecting')"
      phase="Downloading"
      printf '\r\033[K  [%s]  ...  %s %s (%s MB)' "$marker" "$phase" "$(basename "$destination")" "$current_mb"
      spinner_index=$((spinner_index % 4 + 1))
    fi
    elapsed_ticks=$((elapsed_ticks + 1))
    sleep 0.25
  done
  wait "$download_pid" 2>/dev/null || true
  ACTIVE_DOWNLOAD_PID=""
  printf '\r\033[K'
  if [ "$(cat "$status_file")" != "0" ]; then
    cat "$error_file" >&2 2>/dev/null || true
    rm -f "$status_file" "$error_file" "$header_file" "$phase_file"
    if [ -s "$part" ]; then
      printf '  Download paused for %s. Run the installer again to resume it.\n' "$(basename "$destination")" >&2
    else
      rm -f "$part"
      printf '  The release server did not deliver %s. Check access to github.com and try again.\n' "$(basename "$destination")" >&2
    fi
    return 1
  fi
  if [ ! -s "$part" ]; then
    rm -f "$part" "$status_file" "$error_file" "$header_file" "$phase_file"
    printf '  The release server returned an empty file for %s.\n' "$(basename "$destination")" >&2
    return 1
  fi
  mv -f "$part" "$destination"
  rm -f "$status_file" "$error_file" "$header_file" "$phase_file"
}

json_asset_url() {
  asset_pattern="$1"
  tr ',' '\n' < "$TEMP_ROOT/release.json" |
    sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    grep -E "$asset_pattern" |
    head -n 1
}

verify_checksum() {
  artifact="$1"
  artifact_name="$(basename "$artifact")"
  expected="$(awk -v name="$artifact_name" '$2 == name || $2 == "*" name { print tolower($1); exit }' "$TEMP_ROOT/SHA256SUMS.txt")"
  [ -n "$expected" ] || { printf '  Security manifest has no entry for %s.\n' "$artifact_name" >&2; return 1; }
  if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$artifact" | awk '{print tolower($1)}')"
  elif command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$artifact" | awk '{print tolower($1)}')"
  else printf '  A SHA-256 utility is required.\n' >&2; return 1
  fi
  if [ "$actual" != "$expected" ]; then
    rm -f "$artifact" "${artifact}.part"
    printf '  Security verification failed for %s. The cached copy was removed.\n' "$artifact_name" >&2
    return 1
  fi
  log "Verified SHA-256 $actual for $artifact_name"
}

macos_app_is_running() {
  app_bundle="$1"
  app_binary="$app_bundle/Contents/MacOS/EterX"
  ps -ax -o command= 2>/dev/null |
    grep -F "$app_binary" |
    grep -v grep >/dev/null 2>&1
}

wait_for_macos_app() {
  app_bundle="$1"
  attempts="${2:-48}"
  count=0
  while [ "$count" -lt "$attempts" ]; do
    if macos_app_is_running "$app_bundle"; then return 0; fi
    sleep 0.25
    count=$((count + 1))
  done
  return 1
}

macos_bundle_is_quarantined() {
  app_bundle="$1"
  command -v xattr >/dev/null 2>&1 || return 1
  xattr -lr "$app_bundle" 2>/dev/null | grep -q 'com\.apple\.quarantine'
}

show_macos_manual_approval() {
  app_bundle="$1"
  # Ask LaunchServices to perform the normal first-open assessment before
  # revealing the bundle. This makes macOS present its own approval UI when it
  # is available and ensures "Open Anyway" is populated in Privacy & Security.
  open "$app_bundle" >/dev/null 2>&1 || true
  if wait_for_macos_app "$app_bundle" 12; then return 0; fi
  open -R "$app_bundle" >/dev/null 2>&1 || true
  open 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension' >/dev/null 2>&1 ||
    open 'x-apple.systempreferences:com.apple.preference.security?General' >/dev/null 2>&1 || true
  printf '\n  macOS needs one-time approval for this unsigned public build.\n'
  printf '  1. In Finder, Control-click EterX and choose Open.\n'
  printf '  2. Choose Open again, or use Privacy & Security > Open Anyway.\n'
  if [ -r /dev/tty ]; then
    printf '  After approving EterX, press Return here to retry: '
    IFS= read -r approval_reply </dev/tty || true
    return 0
  fi
  return 1
}

request_macos_quarantine_approval() {
  app_bundle="$1"
  approval_choice=""

  case "${ETERX_MAC_APPROVAL:-ask}" in
    allow) approval_choice='Allow & Open' ;;
    manual) approval_choice='Manual Steps' ;;
    cancel) approval_choice='Cancel' ;;
    ask)
      if command -v osascript >/dev/null 2>&1; then
        if approval_choice=$(osascript - "$app_bundle" <<'APPLESCRIPT'
on run argv
  set appPath to item 1 of argv
  set promptText to "EterX is an unsigned open-source macOS build. This installer verified the published SHA-256 checksum before installing " & appPath & "." & return & return & "macOS marked this downloaded copy as quarantined. Allow the installer to remove that marker from this EterX copy only and open it?"
  set answer to display dialog promptText with title "Open EterX" buttons {"Cancel", "Manual Steps", "Allow & Open"} default button "Allow & Open" cancel button "Cancel" with icon caution
  return button returned of answer
end run
APPLESCRIPT
        ); then
          :
        else
          approval_choice='Cancel'
        fi
      elif [ -r /dev/tty ]; then
        printf '\n  The EterX archive passed SHA-256 verification, but macOS quarantined this unsigned build.\n'
        printf '  Allow this installer to remove quarantine from EterX only and open it? [y/N]: '
        IFS= read -r approval_reply </dev/tty || approval_reply=''
        case "$approval_reply" in y|Y|yes|YES) approval_choice='Allow & Open' ;; *) approval_choice='Manual Steps' ;; esac
      else
        approval_choice='Manual Steps'
      fi
      ;;
    *) approval_choice='Manual Steps' ;;
  esac

  case "$approval_choice" in
    'Allow & Open')
      if command -v xattr >/dev/null 2>&1 && xattr -dr com.apple.quarantine "$app_bundle"; then
        log "User approved quarantine removal for $app_bundle after SHA-256 verification."
        return 0
      fi
      printf '  macOS did not allow the quarantine marker to be removed.\n' >&2
      return 2
      ;;
    'Manual Steps') return 2 ;;
    *) return 3 ;;
  esac
}

ensure_macos_code_signature() {
  app_bundle="$1"
  [ -x /usr/bin/codesign ] || return 0

  # Preserve the package's original signature and Electron entitlements when
  # they are already valid. Re-signing every bundle here used to overwrite the
  # JIT/library entitlements that Electron needs on Apple Silicon.
  if /usr/bin/codesign --verify --deep --strict "$app_bundle" >/dev/null 2>&1; then
    log "Preserved the packaged macOS code signature for $app_bundle."
    return 0
  fi

  # Free public builds have no Developer ID. Give an otherwise unsigned bundle
  # a local ad-hoc signature while retaining the runtime permissions required by
  # Electron. This is not notarization and is never presented as publisher
  # identity; it only makes the local executable graph coherent on macOS.
  entitlements_file="$TEMP_ROOT/eterx-entitlements.plist"
  cat > "$entitlements_file" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
  <key>com.apple.security.device.camera</key>
  <true/>
</dict>
</plist>
PLIST
  # Sign the outer bundle first. Electron's packaged frameworks and helpers
  # normally already have their own correct signatures; keeping them intact is
  # safer than rewriting every nested executable.
  if /usr/bin/codesign --force --sign - --entitlements "$entitlements_file" "$app_bundle" >/dev/null 2>&1 &&
     /usr/bin/codesign --verify --deep --strict "$app_bundle" >/dev/null 2>&1; then
    log "Applied and verified an outer ad-hoc macOS signature with Electron entitlements."
    return 0
  fi

  # Older unsigned archives may also contain an unsigned helper. Repair that
  # legacy shape as a bounded fallback and verify the entire graph afterwards.
  if ! /usr/bin/codesign --force --deep --sign - --entitlements "$entitlements_file" "$app_bundle" >/dev/null 2>&1 ||
     ! /usr/bin/codesign --verify --deep --strict "$app_bundle" >/dev/null 2>&1; then
    printf '  The local EterX code signature could not be prepared or verified.\n' >&2
    return 1
  fi
  log "Applied and verified a legacy deep ad-hoc macOS signature with Electron entitlements."
}

install_macos() {
  archive="$1"
  extract_root="$TEMP_ROOT/app"
  mkdir -p "$extract_root" "$INSTALL_DIR"
  ditto -x -k "$archive" "$extract_root"
  # Keep this BSD/GNU find compatible; macOS does not provide GNU's
  # -maxdepth/-quit primaries. The temporary archive root contains only the
  # extracted application, so an unrestricted first match is deterministic.
  app_path="$(find "$extract_root" -type d -name 'EterX.app' -print | head -n 1)"
  [ -n "$app_path" ] || { printf '  EterX.app is missing from the release archive.\n' >&2; return 1; }

  target="$INSTALL_DIR/EterX.app"
  staging="$INSTALL_DIR/.EterX.app.staging.$$"
  previous="$INSTALL_DIR/.EterX.app.previous.$$"
  rm -rf "$staging" "$previous"
  ditto "$app_path" "$staging"
  app_executable="$staging/Contents/MacOS/EterX"
  [ -f "$app_executable" ] || { printf '  The EterX application executable is missing.\n' >&2; return 1; }
  chmod 755 "$app_executable"
  if ! ensure_macos_code_signature "$staging"; then
    rm -rf "$staging"
    return 1
  fi
  # Replacing a bundle while its old executable is still active can make
  # LaunchServices focus that process instead of starting the newly installed
  # version. Ask the existing app to quit and allow its normal AppData flush to
  # finish before the atomic swap. Never kill an unrelated process.
  if macos_app_is_running "$target"; then
    command -v osascript >/dev/null 2>&1 && osascript -e 'tell application id "com.eterx.agent" to quit' >/dev/null 2>&1 || true
    wait_count=0
    while macos_app_is_running "$target" && [ "$wait_count" -lt 60 ]; do
      sleep 0.25
      wait_count=$((wait_count + 1))
    done
    if macos_app_is_running "$target"; then
      printf '  Close the running EterX application, then run this installer again.\n' >&2
      return 1
    fi
  fi
  had_previous=0
  if [ -d "$target" ]; then
    mv "$target" "$previous"
    had_previous=1
  fi
  if ! mv "$staging" "$target"; then
    [ -d "$previous" ] && mv "$previous" "$target"
    return 1
  fi
  if [ "${ETERX_NO_LAUNCH:-0}" != "1" ]; then
    approval_pending=0
    if macos_bundle_is_quarantined "$target"; then
      if request_macos_quarantine_approval "$target"; then
        :
      else
        approval_code=$?
        if [ "$approval_code" -eq 2 ]; then
          if show_macos_manual_approval "$target"; then
            :
          else
            approval_pending=1
          fi
        else
          approval_pending=1
          printf '\n  EterX is installed. macOS approval was cancelled, so it was not opened.\n'
          printf '  Later, Control-click %s and choose Open.\n' "$target"
        fi
      fi
    fi

    launch_error="$TEMP_ROOT/macos-open.error"
    if [ "$approval_pending" -eq 0 ] && ! open "$target" 2>"$launch_error"; then
      printf '  EterX was installed, but macOS could not open it automatically. Launch it from Applications.\n' >&2
      [ ! -s "$launch_error" ] || cat "$launch_error" >&2
      log 'Installed successfully; automatic macOS launch was unavailable.'
      if [ "$had_previous" -eq 1 ] && [ -d "$previous" ]; then
        rm -rf "$target"
        mv "$previous" "$target"
        open "$target" >/dev/null 2>&1 || true
        printf '  The previous EterX version was restored.\n' >&2
      fi
      return 1
    elif [ "$approval_pending" -eq 0 ]; then
      log "Launched $target. Runtime diagnostics: $HOME/Library/Application Support/EterX/eterx-desktop.log"
      # `open` only confirms that LaunchServices accepted the request. Detect
      # an immediate Electron/runtime crash so a successful-looking installer
      # cannot leave the user with an application that never appears.
      if ! wait_for_macos_app "$target" 48; then
        # A retained quarantine marker means the user has not completed the
        # one-time macOS approval yet. Keep the verified installation in place
        # and report approval pending instead of mislabelling it as a crash.
        if macos_bundle_is_quarantined "$target"; then
          approval_pending=1
          show_macos_manual_approval "$target" || true
          printf '  EterX remains installed and will open after the one-time macOS approval.\n'
          log 'Installed successfully; first-open Gatekeeper approval is pending.'
        else
          diagnostic_log="$HOME/Library/Application Support/EterX/eterx-desktop.log"
          printf '  EterX was installed, but it closed during startup.\n' >&2
          if [ -f "$diagnostic_log" ]; then
            printf '  Recent runtime diagnostics:\n' >&2
            tail -n 20 "$diagnostic_log" >&2 2>/dev/null || true
          fi
          if [ "$had_previous" -eq 1 ] && [ -d "$previous" ]; then
            rm -rf "$target"
            mv "$previous" "$target"
            open "$target" >/dev/null 2>&1 || true
            printf '  The previous EterX version was restored and reopened.\n' >&2
          fi
          printf '  Full diagnostics: %s\n' "$diagnostic_log" >&2
          return 1
        fi
      fi
    fi
    if [ "$approval_pending" -eq 1 ]; then
      printf '  Installation complete; first-open approval is still pending.\n'
    fi
  fi
  rm -rf "$previous"
}

install_linux() {
  appimage="$1"
  icon_source="$2"
  app_root="$INSTALL_DIR/app"
  bin_root="${HOME}/.local/bin"
  desktop_root="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  icon_root="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
  mkdir -p "$app_root" "$bin_root" "$desktop_root" "$icon_root"

  target="$app_root/EterX.AppImage"
  staging="$app_root/.EterX.AppImage.staging.$$"
  previous="$app_root/.EterX.AppImage.previous.$$"
  cp "$appimage" "$staging"
  chmod 755 "$staging"
  [ -f "$target" ] && mv "$target" "$previous"
  if ! mv "$staging" "$target"; then
    [ -f "$previous" ] && mv "$previous" "$target"
    return 1
  fi
  rm -f "$previous"

  # Replace the launcher and icon atomically. A killed installer must never
  # leave a truncated desktop file or a half-written icon in the user's menu.
  link_staging="$bin_root/.eterx.$$"
  rm -f "$link_staging"
  cat > "$link_staging" <<EOF
#!/usr/bin/env sh
APPIMAGE="$target"
export APPIMAGE

# AppImages normally use FUSE. Minimal containers and several fresh Linux
# installations do not ship libfuse2; Electron's AppImage runtime supports a
# safe extract-and-run fallback for those machines.
if [ -e /dev/fuse ] && (command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1); then
  if ! command -v ldconfig >/dev/null 2>&1 || ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    exec "\$APPIMAGE" "\$@"
  fi
fi
export APPIMAGE_EXTRACT_AND_RUN=1
exec "\$APPIMAGE" "\$@"
EOF
  chmod 755 "$link_staging"
  mv -f "$link_staging" "$bin_root/eterx"

  icon_staging="$icon_root/.eterx.png.$$"
  cp "$icon_source" "$icon_staging"
  chmod 644 "$icon_staging"
  mv -f "$icon_staging" "$icon_root/eterx.png"

  desktop_staging="$desktop_root/.com.eterx.agent.desktop.$$"
  cat > "$desktop_staging" <<EOF
[Desktop Entry]
Type=Application
Name=EterX
Comment=Autonomous AI Agent
Exec="$bin_root/eterx"
Icon=eterx
Terminal=false
Categories=Development;Utility;
StartupWMClass=EterX
X-AppImage-Integrate=false
EOF
  chmod 644 "$desktop_staging"
  mv -f "$desktop_staging" "$desktop_root/com.eterx.agent.desktop"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$desktop_root" >/dev/null 2>&1 || true
  if [ "${ETERX_NO_LAUNCH:-0}" != "1" ]; then
    nohup "$bin_root/eterx" >/dev/null 2>&1 &
  fi
}

printf '\n  ETERX\n  Secure desktop installation for %s\n' "$OS"
stage 8 'Detecting this device' "$PLATFORM $ARCH | per-user installation"

stage 18 'Resolving the latest stable release' "GitHub: $REPOSITORY"
if ! download "$API_URL" "$TEMP_ROOT/release.json"; then
  log 'FAILED: latest release lookup failed'
  printf '\n  EterX installation did not complete. Existing user data was not changed.\n  Log: %s\n' "$LOG_FILE" >&2
  exit 1
fi

if [ "$PLATFORM" = "mac" ]; then
  artifact_url="$(json_asset_url "/EterX-[^/]+-mac-$ARCH\\.zip$" || true)"
else
  artifact_url="$(json_asset_url "/EterX-[^/]+-linux-$LINUX_ARCH\\.AppImage$" || true)"
  if [ -z "$artifact_url" ] && [ -n "$LINUX_ARCH_FALLBACK" ]; then
    artifact_url="$(json_asset_url "/EterX-[^/]+-linux-$LINUX_ARCH_FALLBACK\\.AppImage$" || true)"
  fi
fi
checksum_url="$(json_asset_url '/SHA256SUMS\.txt$' || true)"
[ -n "$artifact_url" ] || { printf '  The latest release has no %s %s package.\n' "$PLATFORM" "$ARCH" >&2; exit 1; }
[ -n "$checksum_url" ] || { printf '  The latest release has no checksum manifest.\n' >&2; exit 1; }

artifact="$CACHE_ROOT/$(basename "$artifact_url")"
stage 30 'Downloading the native application' "$(basename "$artifact")"
download "$artifact_url" "$artifact"
download "$checksum_url" "$TEMP_ROOT/SHA256SUMS.txt"
if [ "$PLATFORM" = "linux" ]; then
  icon_url="$(json_asset_url '/eterx-icon-512\.png$' || true)"
  [ -n "$icon_url" ] || { printf '  The latest release has no Linux launcher icon.\n' >&2; exit 1; }
  download "$icon_url" "$TEMP_ROOT/eterx-icon-512.png"
fi

stage 72 'Verifying release integrity' 'SHA-256 manifest validation'
verify_checksum "$artifact"
if [ "$PLATFORM" = "linux" ]; then verify_checksum "$TEMP_ROOT/eterx-icon-512.png"; fi

stage 84 'Installing EterX' "$INSTALL_DIR"
if [ "$PLATFORM" = "mac" ]; then
  install_macos "$artifact"
else
  install_linux "$artifact" "$TEMP_ROOT/eterx-icon-512.png"
fi

stage 100 'EterX is installed' 'Future updates are downloaded safely inside the app'
rm -f "$artifact" "${artifact}.part"
printf '\n  User data is stored separately and remains intact across updates.\n  Installer log: %s\n' "$LOG_FILE"
