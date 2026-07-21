#!/usr/bin/env sh
set -eu

REPOSITORY="harshilsoni5666/EterX-Agent"
BRANCH="${ETERX_BRANCH:-main}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_DIR="${ETERX_INSTALL_DIR:-$DATA_HOME/eterx/source}"
ETERX_DATA_DIR="${ETERX_DATA_DIR:-$DATA_HOME/eterx/data}"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/eterx"
LOG_FILE="$LOG_DIR/install.log"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/eterx-install.XXXXXX")"
BACKUP_DIR=""

mkdir -p "$LOG_DIR"

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"; }
stage() {
  number="$1" percent="$2" title="$3" detail="$4"
  width=34 filled=$((percent * width / 100)) empty=$((width - filled))
  bar="$(printf '%*s' "$filled" '' | tr ' ' '#')$(printf '%*s' "$empty" '' | tr ' ' '-')"
  printf '\n  [%s] %3s%%  %s\n  %s\n' "$bar" "$percent" "$title" "$detail"
  log "Stage $number ($percent%): $title - $detail"
}
node_major() {
  command -v node >/dev/null 2>&1 || { printf '0'; return; }
  node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1
}
install_node() {
  major="$(node_major)"
  [ "${major:-0}" -ge 20 ] 2>/dev/null && return
  printf '  Node.js 20+ was not found. Installing the LTS runtime...\n'
  if command -v brew >/dev/null 2>&1; then brew install node@20
  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y nodejs npm
  elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sy --needed --noconfirm nodejs npm
  else
    printf '  Install Node.js 20+ from https://nodejs.org and rerun this command.\n' >&2
    exit 1
  fi
  major="$(node_major)"
  [ "${major:-0}" -ge 20 ] 2>/dev/null || { printf '  Installed Node.js is older than version 20.\n' >&2; exit 1; }
}
download() {
  url="$1" destination="$2"
  if command -v curl >/dev/null 2>&1; then curl --fail --location --retry 3 --retry-delay 2 --progress-bar "$url" --output "$destination"
  elif command -v wget >/dev/null 2>&1; then wget --tries=3 --show-progress -O "$destination" "$url"
  else printf '  curl or wget is required.\n' >&2; exit 1
  fi
}
restore_previous() {
  [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] || return 0
  printf '  Restoring the previous working installation...\n'
  rm -rf -- "$INSTALL_DIR"
  mv -- "$BACKUP_DIR" "$INSTALL_DIR"
  BACKUP_DIR=""
}
cleanup() { rm -rf -- "$TEMP_ROOT"; }
on_exit() {
  code=$?
  trap - EXIT INT TERM HUP
  if [ "$code" -ne 0 ]; then
    log "FAILED with exit code $code"
    restore_previous || true
    printf '\n  Installation did not complete. Your previous installation was preserved.\n  Log: %s\n' "$LOG_FILE" >&2
  fi
  cleanup
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

printf '\n  ETERX  |  Professional Source Installer\n  Complete application, dependencies, repair, and update support\n'
stage 1 5 'Checking this device' 'Operating system, storage path, and required runtime'
install_node
printf '  [OK] Node.js %s\n' "$(node --version)"

stage 2 15 'Downloading verified source' "Branch: $BRANCH"
archive="$TEMP_ROOT/eterx.zip"
download "https://codeload.github.com/$REPOSITORY/zip/refs/heads/$BRANCH" "$archive"
[ "$(wc -c < "$archive")" -gt 1024 ] || { printf 'Downloaded archive is unexpectedly small.\n' >&2; exit 1; }

stage 3 35 'Verifying and extracting' 'The existing installation is still untouched'
extract_root="$TEMP_ROOT/extract"
mkdir -p "$extract_root"
if command -v unzip >/dev/null 2>&1; then unzip -q "$archive" -d "$extract_root"
else printf '  unzip is required to extract EterX.\n' >&2; exit 1
fi
source_dir="$(find "$extract_root" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -f "$source_dir/package.json" ] && [ -f "$source_dir/setup.js" ] || { printf 'The package failed EterX integrity checks.\n' >&2; exit 1; }

stage 4 48 'Installing application files' "$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"
if [ -d "$INSTALL_DIR" ]; then BACKUP_DIR="$INSTALL_DIR.previous-$(date -u '+%Y%m%d%H%M%S')"; mv -- "$INSTALL_DIR" "$BACKUP_DIR"; fi
mv -- "$source_dir" "$INSTALL_DIR"
if [ -n "$BACKUP_DIR" ]; then
  [ -f "$BACKUP_DIR/.env.local" ] && cp -p "$BACKUP_DIR/.env.local" "$INSTALL_DIR/.env.local"
  if [ -d "$BACKUP_DIR/.workspaces" ] && [ ! -e "$ETERX_DATA_DIR" ]; then cp -a "$BACKUP_DIR/.workspaces" "$ETERX_DATA_DIR"; fi
fi
mkdir -p "$ETERX_DATA_DIR"
rm -rf -- "$INSTALL_DIR/.workspaces"
ln -s "$ETERX_DATA_DIR" "$INSTALL_DIR/.workspaces"

stage 5 58 'Installing libraries and building EterX' 'Detailed output is saved by the setup engine'
if ! (cd "$INSTALL_DIR" && node setup.js --auto --source-install); then exit 1; fi

stage 6 96 'Finalizing shortcuts and update metadata' "User data: $ETERX_DATA_DIR"
if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then rm -rf -- "$BACKUP_DIR"; BACKUP_DIR=""; fi

stage 7 100 'EterX is ready' "Installed at $INSTALL_DIR"
printf '\n  Updates: run  eterx update\n  Installer log: %s\n' "$LOG_FILE"
exit 0
