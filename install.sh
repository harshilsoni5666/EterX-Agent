#!/usr/bin/env bash
# EterX public-source bootstrap installer for Linux and macOS.
# It fetches the complete source, installs dependencies with recovery paths,
# initializes EterX, and launches the desktop app.

set -u
set -o pipefail

INSTALL_DIR="${ETERX_DIR:-$HOME/EterX}"
REPO_URL="${ETERX_REPO_URL:-https://github.com/harshilsoni5666/EterX-Agent.git}"
BRANCH="${ETERX_BRANCH:-main}"
ARCHIVE_URL="${ETERX_ARCHIVE_URL:-}"
FORCE_INSTALL="${ETERX_FORCE:-0}"
NO_LAUNCH="${ETERX_NO_LAUNCH:-0}"

step() { printf '  \033[0;36m[EterX] %s\033[0m\n' "$1"; }
good() { printf '  \033[0;32m[EterX] %s\033[0m\n' "$1"; }
warn() { printf '  \033[1;33m[EterX] %s\033[0m\n' "$1" >&2; }
fail() { printf '  \033[0;31m[EterX] %s\033[0m\n' "$1" >&2; }

has_source() {
  [ -f "$1/package.json" ] && [ -f "$1/setup.js" ] && [ -f "$1/eterx.js" ] && [ -d "$1/src" ]
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    printf '0'
    return
  fi
  node --version 2>/dev/null | sed -E 's/^v?([0-9]+).*/\1/'
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then return 0; fi
  if command -v apt-get >/dev/null 2>&1; then
    step 'Installing curl and unzip with apt...'
    sudo apt-get update && sudo apt-get install -y curl unzip
  elif command -v dnf >/dev/null 2>&1; then
    step 'Installing curl and unzip with dnf...'
    sudo dnf install -y curl unzip
  elif command -v pacman >/dev/null 2>&1; then
    step 'Installing curl and unzip with pacman...'
    sudo pacman -Sy --noconfirm curl unzip
  elif command -v brew >/dev/null 2>&1; then
    step 'Installing curl and unzip with Homebrew...'
    brew install curl unzip
  else
    return 1
  fi
  command -v curl >/dev/null 2>&1
}

ensure_node() {
  local major
  major="$(node_major)"
  if [ "$major" -ge 20 ] 2>/dev/null; then
    good "Node.js $(node --version) is ready."
    return 0
  fi

  step 'Node.js 20+ is required. Trying automatic installation...'
  if [ "$(uname -s)" = 'Darwin' ] && command -v brew >/dev/null 2>&1; then
    brew install node@20 || brew install node
    if [ "$(node_major)" -ge 20 ] 2>/dev/null; then
      good "Installed Node.js $(node --version)."
      return 0
    fi
  fi

  if ! ensure_curl; then
    fail 'Could not install curl automatically. Install curl and Node.js 20+, then run this command again.'
    return 1
  fi

  # Try NVM
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl --fail --location --retry 3 https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash || true
  fi
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    nvm install 20 && nvm use 20
    if [ "$(node_major)" -ge 20 ] 2>/dev/null; then
      good "Installed Node.js $(node --version) via NVM."
      return 0
    fi
  fi

  # Fallback: Portable Node.js tarball download
  step 'NVM/Brew failed or unavailable. Downloading portable Node.js LTS...'
  local osarch platform url staging target_node archive
  osarch="$(uname -m)"
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
  url=""
  
  if [ "$platform" = "darwin" ]; then
    if [ "$osarch" = "arm64" ]; then
      url="https://nodejs.org/dist/v20.15.1/node-v20.15.1-darwin-arm64.tar.gz"
    else
      url="https://nodejs.org/dist/v20.15.1/node-v20.15.1-darwin-x64.tar.gz"
    fi
  elif [ "$platform" = "linux" ]; then
    if [ "$osarch" = "x86_64" ] || [ "$osarch" = "amd64" ]; then
      url="https://nodejs.org/dist/v20.15.1/node-v20.15.1-linux-x64.tar.xz"
    elif [ "$osarch" = "aarch64" ] || [ "$osarch" = "arm64" ]; then
      url="https://nodejs.org/dist/v20.15.1/node-v20.15.1-linux-arm64.tar.xz"
    fi
  fi

  if [ -n "$url" ]; then
    staging="$(mktemp -d "${TMPDIR:-/tmp}/eterx-node.XXXXXX")"
    archive="$staging/node.tar.gz"
    if curl --fail --location --retry 3 --progress-bar "$url" -o "$archive"; then
      mkdir -p "$staging/extract"
      if tar -xf "$archive" -C "$staging/extract" --strip-components=1; then
        target_node="$INSTALL_DIR/node"
        rm -rf "$target_node"
        mkdir -p "$INSTALL_DIR"
        mv "$staging/extract" "$target_node"
        export PATH="$target_node/bin:$PATH"
        if [ "$(node_major)" -ge 20 ] 2>/dev/null; then
          good "Portable Node.js configured at $target_node."
          rm -rf "$staging"
          return 0
        fi
      fi
    fi
    rm -rf "$staging"
  fi

  fail 'Could not install Node.js automatically. Install Node.js 20+ manually and run this script again.'
  return 1
}

archive_url() {
  if [ -n "$ARCHIVE_URL" ]; then
    printf '%s' "$ARCHIVE_URL"
    return
  fi
  printf '%s/archive/refs/heads/%s.zip' "${REPO_URL%.git}" "$BRANCH"
}

prepare_install_directory() {
  if has_source "$INSTALL_DIR"; then
    if [ -d "$INSTALL_DIR/.git" ] && command -v git >/dev/null 2>&1; then
      step "Existing installation is a Git repository. Syncing with remote branch..."
      (
        cd "$INSTALL_DIR" || exit 1

        # Check and update remote URL if it differs from REPO_URL
        local current_url
        current_url=$(git remote get-url origin | sed 's/\.git$//' | tr -d '[:space:]')
        local target_url
        target_url=$(echo "$REPO_URL" | sed 's/\.git$//' | tr -d '[:space:]')
        if [ "$current_url" != "$target_url" ]; then
          step "Updating remote URL from '$current_url' to '$REPO_URL'..."
          git remote set-url origin "$REPO_URL"
        fi

        # Configure git token if available for authenticated pull
        local remote_url
        remote_url="$(git remote get-url origin)"
        if [ -n "${ETERX_GITHUB_TOKEN:-}" ] && [[ "$remote_url" =~ "github.com" ]] && [[ ! "$remote_url" =~ "@github.com" ]]; then
          local authed_url="${remote_url/https:\/\//https://${ETERX_GITHUB_TOKEN}@}"
          git remote set-url origin "$authed_url"
        fi
        git fetch --all
        git checkout "$BRANCH"
        git reset --hard "origin/$BRANCH"
        git pull
      ) && {
        good "Successfully updated source at $INSTALL_DIR."
        return 0
      }
      warn "Git sync failed; continuing with existing source."
    fi
    good "Using existing EterX source: $INSTALL_DIR"
    return 0
  fi

  if [ -e "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    if [ "$FORCE_INSTALL" != '1' ]; then
      fail "Install directory contains unrelated files: $INSTALL_DIR"
      fail 'Set ETERX_DIR to another folder, or set ETERX_FORCE=1 to replace this incomplete install.'
      return 1
    fi
    warn "Replacing incomplete installation at $INSTALL_DIR..."
    rm -rf -- "$INSTALL_DIR"
  fi
  return 2
}

copy_source() {
  local source="$1"
  if ! has_source "$source"; then
    fail 'Downloaded source is incomplete: package.json, setup.js, eterx.js, or src is missing.'
    return 1
  fi
  mkdir -p "$INSTALL_DIR" || return 1
  cp -a "$source/." "$INSTALL_DIR/" || return 1
  has_source "$INSTALL_DIR" || return 1
  good "Complete EterX source installed at $INSTALL_DIR"
}

try_git_download() {
  if ! command -v git >/dev/null 2>&1; then
    warn 'Git is not available; using the archive download fallback.'
    return 1
  fi

  local url="$REPO_URL"
  if [ -n "${ETERX_GITHUB_TOKEN:-}" ] && [[ "$url" =~ "github.com" ]]; then
    url="${url/https:\/\//https://${ETERX_GITHUB_TOKEN}@}"
  fi

  local staging
  staging="$(mktemp -d "${TMPDIR:-/tmp}/eterx-git.XXXXXX")" || return 1
  step 'Downloading the complete EterX source with Git...'
  if git clone --depth 1 --branch "$BRANCH" "$url" "$staging/source" && copy_source "$staging/source"; then
    rm -rf -- "$staging"
    return 0
  fi
  rm -rf -- "$staging"
  warn 'Git download failed; trying the source archive instead.'
  return 1
}

extract_zip() {
  local archive="$1"
  local destination="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$archive" -d "$destination"
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$archive" "$destination" <<'PY'
import sys
import zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
PY
    return $?
  fi
  return 1
}

try_archive_download() {
  local staging archive source url
  staging="$(mktemp -d "${TMPDIR:-/tmp}/eterx-archive.XXXXXX")" || return 1
  archive="$staging/eterx.zip"
  url="$(archive_url)"

  if ! ensure_curl; then
    rm -rf -- "$staging"
    return 1
  fi

  step 'Downloading the complete EterX source archive...'
  if [ -n "${ETERX_GITHUB_TOKEN:-}" ] && [[ "$REPO_URL" =~ github\.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
    local repo="${BASH_REMATCH[1]}"
    url="https://api.github.com/repos/$repo/zipball/$BRANCH"
    curl --fail --location --retry 3 --progress-bar --header "Authorization: Bearer ${ETERX_GITHUB_TOKEN}" --header 'Accept: application/vnd.github+json' --header 'User-Agent: EterX-Installer' "$url" -o "$archive" || {
      rm -rf -- "$staging"; return 1;
    }
  else
    curl --fail --location --retry 3 --progress-bar "$url" -o "$archive" || { rm -rf -- "$staging"; return 1; }
  fi

  if ! extract_zip "$archive" "$staging"; then
    rm -rf -- "$staging"
    warn 'Could not extract the source archive. Install unzip or Python 3, then retry.'
    return 1
  fi

  source=''
  local candidate
  for candidate in "$staging"/*; do
    if [ -d "$candidate" ] && has_source "$candidate"; then
      source="$candidate"
      break
    fi
  done
  if [ -z "$source" ] || ! copy_source "$source"; then
    rm -rf -- "$staging"
    return 1
  fi
  rm -rf -- "$staging"
  return 0
}

install_source() {
  prepare_install_directory
  local preparation=$?
  if [ "$preparation" -eq 0 ]; then return 0; fi
  if [ "$preparation" -ne 2 ]; then return 1; fi
  try_git_download || try_archive_download || {
    fail 'EterX source could not be downloaded. Check internet access, repository visibility, or set ETERX_GITHUB_TOKEN for private access.'
    return 1
  }
}

run_setup() {
  cd "$INSTALL_DIR" || return 1
  if [ -d "$INSTALL_DIR/.next" ]; then
    step 'Clearing Next.js compilation cache...'
    rm -rf "$INSTALL_DIR/.next"
  fi
  
  local runtime_cache="$HOME/.config/EterX/runtime"
  if [ "$(uname -s)" = "Darwin" ]; then
    runtime_cache="$HOME/Library/Application Support/EterX/runtime"
  fi
  if [ -d "$runtime_cache" ]; then
    step 'Clearing Electron desktop runtime cache...'
    rm -rf "$runtime_cache"
  fi

  rm -rf "$INSTALL_DIR/node_modules/.cache"

  step 'Installing all EterX libraries and initializing local storage...'
  NODE_NO_WARNINGS=1 node ./setup.js --auto --no-doctor
}

launch_eterx() {
  if [ "$NO_LAUNCH" = '1' ]; then
    good 'Installation complete. Launch skipped by request.'
    return 0
  fi
  step 'Launching EterX desktop...'
  (
    cd "$INSTALL_DIR" || exit 1
    nohup node ./eterx.js desktop > "$INSTALL_DIR/.workspaces/launch.log" 2>&1 &
  )
  good 'EterX is launching. Add your API key in Settings → API Keys if this is your first run.'
}

cols=$(tput cols 2>/dev/null || echo 80)
if [ "$cols" -ge 65 ]; then
  printf '\033[0;36m'
  printf '                ███████╗████████╗███████╗██████╗ ██╗  ██╗\n'
  printf '                ██╔════╝╚══██╔══╝██╔════╝██╔══██╗╚██╗██╔╝\n'
  printf '                █████╗     ██║   █████╗  ██████╔╝ ╚███╔╝ \n'
  printf '                ██╔══╝     ██║   ██╔══╝  ██╔══██╗ ██╔██╗ \n'
  printf '                ███████╗   ██║   ███████╗██║  ██║██╔╝ ██╗\n'
  printf '                ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝\n'
  printf '\033[0m'
  printf '\n                    \033[0;35mThe Autonomous AI Agent\033[0m\n'
  printf '                    \033[0;90m✦ Built by\033[0m \033[1;37mHarshil Soni\033[0m\n'
elif [ "$cols" -ge 52 ]; then
  printf '\033[0;36m'
  printf '  ███████╗████████╗███████╗██████╗ ██╗  ██╗\n'
  printf '  ██╔════╝╚══██╔══╝██╔════╝██╔══██╗╚██╗██╔╝\n'
  printf '  █████╗     ██║   █████╗  ██████╔╝ ╚███╔╝ \n'
  printf '  ██╔══╝     ██║   ██╔══╝  ██╔══██╗ ██╔██╗ \n'
  printf '  ███████╗   ██║   ███████╗██║  ██║██╔╝ ██╗\n'
  printf '  ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝\n'
  printf '\033[0m'
  printf '\n    \033[0;35mThe Autonomous AI Agent\033[0m\n'
  printf '    \033[0;90m✦ Built by\033[0m \033[1;37mHarshil Soni\033[0m\n'
else
  printf '  \033[0;36mEterX Agent\033[0m\n'
  printf '  \033[0;35mThe Autonomous AI Agent\033[0m\n'
  printf '  \033[0;90m✦ Built by\033[0m \033[1;37mHarshil Soni\033[0m\n'
fi

# Dynamically size the separators
sep_len=$((cols - 4))
if [ "$sep_len" -gt 60 ]; then
  sep_len=60
elif [ "$sep_len" -lt 10 ]; then
  sep_len=10
fi

sep_bar=""
i=1
while [ "$i" -le "$sep_len" ] 2>/dev/null; do
  sep_bar="${sep_bar}━"
  i=$((i + 1))
done
if [ -z "$sep_bar" ]; then
  sep_bar="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

printf '  \033[0;90m%s\033[0m\n' "$sep_bar"
printf '  \033[0;33mDestination Path :\033[0m %s\n' "$INSTALL_DIR"
printf '  \033[0;90mRequired Modules :\033[0m\n'
printf '    - Core Engine & Local Workspace Storage\n'
printf '    - Next.js & React UI Modules\n'
printf '    - Electron Native Windows Wrapper\n'
printf '    - Gemini & Universal AI Provider Router\n'
printf '  \033[0;90m%s\033[0m\n\n' "$sep_bar"

ensure_node && install_source && run_setup && launch_eterx || {
  fail 'Installation could not finish. Fix the reported prerequisite, then run the same command again.'
  exit 1
}
