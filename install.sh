#!/usr/bin/env sh
set -eu

REPOSITORY="harshilsoni5666/EterX-Agent"
API_URL="https://api.github.com/repos/$REPOSITORY/releases/latest"
OS="$(uname -s)"
MACHINE="$(uname -m)"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/eterx-bootstrap.XXXXXX")"

case "$OS" in
  Darwin)
    PLATFORM="mac"
    STATE_ROOT="${HOME}/Library/Logs/EterX"
    DEFAULT_INSTALL_DIR="${HOME}/Applications"
    ;;
  Linux)
    PLATFORM="linux"
    STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/EterX"
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
mkdir -p "$STATE_ROOT"

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
cleanup() { rm -rf "$TEMP_ROOT" "$LOCK_DIR"; }
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

retry() {
  attempts=0
  until "$@"; do
    attempts=$((attempts + 1))
    [ "$attempts" -ge 4 ] && return 1
    delay=$((1 << attempts))
    printf '  Retrying in %s seconds...\n' "$delay"
    sleep "$delay"
  done
}

download() {
  url="$1" destination="$2"
  part="${destination}.part"
  status_file="${part}.status"
  error_file="${part}.error"
  header_file="${part}.headers"
  # Clear every sidecar from a previous interrupted attempt. A stale status
  # marker must never make a new download look successful before it starts.
  rm -f "$part" "$status_file" "$error_file" "$header_file"
  remote_size=""

  # A HEAD request gives us a real percentage for large GitHub CDN assets. It
  # is only a display hint; a missing or chunked Content-Length never blocks
  # the download.
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --http1.1 --head \
      --connect-timeout 60 --max-time 120 \
      --header 'Accept: application/vnd.github+json' \
      --header 'X-GitHub-Api-Version: 2022-11-28' \
      --user-agent 'EterX-Bootstrap/3' "$url" > "$header_file" 2>/dev/null || true
    remote_size="$(awk 'BEGIN { IGNORECASE=1 } /^content-length:/ { gsub("\r", "", $2); value=$2 } END { print value }' "$header_file" 2>/dev/null || true)"
  fi

  : > "$status_file"
  if command -v curl >/dev/null 2>&1; then
    (
      if retry curl --fail --silent --show-error --location --http1.1 \
      --retry 5 --retry-delay 3 --retry-max-time 900 \
      --connect-timeout 60 --max-time 1800 \
      --header 'Accept: application/vnd.github+json' \
      --header 'X-GitHub-Api-Version: 2022-11-28' \
      --user-agent 'EterX-Bootstrap/3' "$url" --output "$part" > /dev/null 2> "$error_file"; then
        printf '0' > "$status_file"
      else
        printf '1' > "$status_file"
      fi
    ) &
  elif command -v wget >/dev/null 2>&1; then
    (
      if retry wget --tries=5 --timeout=60 --read-timeout=1800 --quiet \
        --user-agent='EterX-Bootstrap/3' -O "$part" "$url" > /dev/null 2> "$error_file"; then
        printf '0' > "$status_file"
      else
        printf '1' > "$status_file"
      fi
    ) &
  else
    printf '  curl or wget is required to download EterX.\n' >&2
    return 1
  fi

  download_pid=$!
  spinner='|/-\\'
  spinner_index=1
  while [ ! -s "$status_file" ]; do
    current_bytes=0
    [ -f "$part" ] && current_bytes="$(wc -c < "$part" | tr -d '[:space:]')"
    current_mb="$(awk -v bytes="$current_bytes" 'BEGIN { printf "%.1f", bytes / 1048576 }')"
    if printf '%s' "$remote_size" | grep -Eq '^[0-9]+$' && [ "$remote_size" -gt 0 ]; then
      percent=$((current_bytes * 100 / remote_size))
      [ "$percent" -gt 100 ] && percent=100
      filled=$((percent * 32 / 100))
      empty=$((32 - filled))
      bar="$(printf '%*s' "$filled" '' | tr ' ' '#')$(printf '%*s' "$empty" '' | tr ' ' '-')"
      printf '\r\033[K  [%s] %3s%%  Downloading %s (%s MB)' "$bar" "$percent" "$(basename "$destination")" "$current_mb"
    else
      marker="$(printf '%s' "$spinner" | cut -c "$spinner_index")"
      printf '\r\033[K  [%s]  ...  Downloading %s (%s MB)' "$marker" "$(basename "$destination")" "$current_mb"
      spinner_index=$((spinner_index % 4 + 1))
    fi
    sleep 0.25
  done
  wait "$download_pid" 2>/dev/null || true
  printf '\r\033[K'
  if [ "$(cat "$status_file")" != "0" ]; then
    cat "$error_file" >&2 2>/dev/null || true
    rm -f "$part" "$status_file" "$error_file" "$header_file"
    printf '  Download failed for %s.\n' "$(basename "$destination")" >&2
    return 1
  fi
  mv -f "$part" "$destination"
  rm -f "$status_file" "$error_file" "$header_file"
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
  [ "$actual" = "$expected" ] || { printf '  Security verification failed for %s.\n' "$artifact_name" >&2; return 1; }
  log "Verified SHA-256 $actual for $artifact_name"
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
  # This archive has already passed the release SHA-256 check. Clear any
  # inherited browser/GitHub quarantine metadata so macOS does not allow the
  # outer app and then silently block its bundled runtime helper on first use.
  command -v xattr >/dev/null 2>&1 && xattr -dr com.apple.quarantine "$staging" 2>/dev/null || true
  if [ -d "$target" ]; then mv "$target" "$previous"; fi
  if ! mv "$staging" "$target"; then
    [ -d "$previous" ] && mv "$previous" "$target"
    return 1
  fi
  rm -rf "$previous"
  if [ "${ETERX_NO_LAUNCH:-0}" != "1" ]; then
    launch_error="$TEMP_ROOT/macos-open.error"
    if ! open "$target" 2>"$launch_error"; then
      printf '  EterX was installed, but macOS could not open it automatically. Launch it from Applications.\n' >&2
      [ ! -s "$launch_error" ] || cat "$launch_error" >&2
      log 'Installed successfully; automatic macOS launch was unavailable.'
    else
      log "Launched $target. Runtime diagnostics: $HOME/Library/Application Support/EterX/eterx-desktop.log"
    fi
  fi
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
  ln -s "$target" "$link_staging"
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
Exec="$target"
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
    nohup "$target" >/dev/null 2>&1 &
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

artifact="$TEMP_ROOT/$(basename "$artifact_url")"
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
printf '\n  User data is stored separately and remains intact across updates.\n  Installer log: %s\n' "$LOG_FILE"
