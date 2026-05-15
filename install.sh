#!/bin/bash
# ═══════════════════════════════════════════════
# EterX Agent — One-Line Installer (Linux/macOS)
# Usage: curl -fsSL https://raw.githubusercontent.com/harshilsoni5666/EterX-agent-/main/install.sh | bash
# ═══════════════════════════════════════════════

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

REPO="https://github.com/harshilsoni5666/EterX-agent-.git"
INSTALL_DIR="${ETERX_DIR:-$HOME/EterX}"

echo ""
echo -e "${CYAN}${BOLD}"
echo "    ███████╗████████╗███████╗██████╗ ██╗  ██╗"
echo "    ██╔════╝╚══██╔══╝██╔════╝██╔══██╗╚██╗██╔╝"
echo "    █████╗     ██║   █████╗  ██████╔╝ ╚███╔╝ "
echo "    ██╔══╝     ██║   ██╔══╝  ██╔══██╗ ██╔██╗ "
echo "    ███████╗   ██║   ███████╗██║  ██║██╔╝ ██╗"
echo "    ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝"
echo -e "${NC}"
echo -e "    ${BOLD}⚡ The Autonomous AI Agent System${NC}"
echo ""

# ── Check Node.js ──
if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
    echo -e "  ${GREEN}✔${NC} Node.js $NODE_VER"
else
    echo -e "  ${YELLOW}⚠${NC} Node.js not found. Installing via nvm..."
    if ! command -v nvm &>/dev/null; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    fi
    nvm install 22
    nvm use 22
    echo -e "  ${GREEN}✔${NC} Node.js $(node --version) installed"
fi

# ── Check Git ──
if command -v git &>/dev/null; then
    echo -e "  ${GREEN}✔${NC} Git $(git --version | grep -oP '\d+\.\d+\.\d+')"
else
    echo -e "  ${YELLOW}⚠${NC} Git not found. Installing..."
    if command -v apt-get &>/dev/null; then
        sudo apt-get install -y git
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm git
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y git
    elif command -v brew &>/dev/null; then
        brew install git
    else
        echo -e "  ${RED}✖${NC} Cannot auto-install git. Please install manually."
        exit 1
    fi
fi

# ── Clone or Update ──
if [ -d "$INSTALL_DIR/.git" ]; then
    echo -e "  ${CYAN}ℹ${NC} Existing install found at $INSTALL_DIR"
    cd "$INSTALL_DIR"
    if [ "$ETERX_UPDATE" = "1" ]; then
        echo -e "  ${CYAN}ℹ${NC} ETERX_UPDATE=1 set. Pulling updates..."
        if git pull --rebase; then
            echo -e "  ${GREEN}✔${NC} Repository updated"
        else
            echo -e "  ${RED}✖${NC} Repository update failed. Check the git output above."
            exit 1
        fi
    else
        echo -e "  ${CYAN}ℹ${NC} Skipping code update. Set ETERX_UPDATE=1 to update source files."
    fi
else
    echo -e "  ${CYAN}ℹ${NC} Cloning EterX to $INSTALL_DIR..."
    if git clone "$REPO" "$INSTALL_DIR"; then
        echo -e "  ${GREEN}✔${NC} Repository cloned"
    else
        echo -e "  ${RED}✖${NC} Clone failed. Check the git output above."
        exit 1
    fi
    cd "$INSTALL_DIR"
fi

# ── Run Setup ──
echo ""
echo -e "  ${CYAN}ℹ${NC} Starting EterX setup wizard..."
echo ""
if [ -f ".env.local" ]; then
    node setup.js --auto
else
    node setup.js
fi
