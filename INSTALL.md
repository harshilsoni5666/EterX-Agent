# EterX-Agent

<p align="center">
  <a href="./README.md">Overview</a> &nbsp;•&nbsp;
  <b>Install</b> &nbsp;•&nbsp;
  <a href="./SECURITY.md">Security</a>
</p>

---

## Install Guide

EterX can be installed via our automated bootstrap scripts, built from source for development, or packaged as a standalone desktop app.

### Prerequisites
* **Node.js**: Version 20.0.0 or higher is required.
* **Operating System**: Windows 10/11, macOS, or Linux.

---

## 1. One-Click Bootstrap Install (Recommended)

The easiest way to install EterX is using our bootstrap installer. The script downloads the source tree, installs Node.js and npm dependencies (with a portable Node.js fallback if missing), initializes storage, and launches EterX.

### Windows (PowerShell)
Run the following command in a PowerShell terminal:
```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/harshilsoni5666/EterX-Agent/main/install.ps1 | iex"
```

### Linux & macOS (Bash)
Run the following command in a Bash terminal:
```bash
curl -sSL "https://raw.githubusercontent.com/harshilsoni5666/EterX-Agent/main/install.sh" | bash
```

---

## 2. From Source (Developers)

If you want to contribute or modify EterX, you can set up a local development environment.

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/harshilsoni5666/EterX-Agent.git
   cd EterX-Agent
   ```

2. **Run the Setup Wizard:**
   ```bash
   node ./setup.js --auto --no-doctor
   ```
   *Note: This will install npm dependencies, compile native bindings, and initialize local storage.*

3. **Start EterX in Development Mode:**
   ```bash
   node ./eterx.js desktop
   ```

---

## 3. Desktop Standalone Builds (Offline Distribution)

To package EterX as a standalone desktop executable for offline distribution, run the appropriate packaging script for your platform:

```bash
# Windows NSIS Installer
npm run desktop:build:win

# Linux AppImage & Debian Package
npm run desktop:build:linux

# macOS DMG & Zip (Build on macOS for proper code signing/notarization)
npm run desktop:build:mac
```

---

## Post-Install Setup

### API Key Configuration
After installing, you will need to link your API keys to enable provider routing.
Run the following CLI command to start the interactive API configuration:
```bash
eterx api
```
Alternatively, you can open the **Settings** panel in the Web UI or Desktop App and input your keys directly in the **API Keys** section.

### Desktop Data Location
To ensure privacy and avoid polluting your folders, EterX keeps all agent workspaces, logs, local memory graphs, and encrypted settings under:

* **Windows:** `%LOCALAPPDATA%\EterX` (typically `C:\Users\<username>\AppData\Local\EterX`)
* **macOS/Linux:** `~/.config/EterX` or `~/Library/Application Support/EterX`

No user data is stored in the source code directory or sent to external cloud storage.
