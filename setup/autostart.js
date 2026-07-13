/**
 * EterX — Auto-Start, Desktop Integration & System Registration
 * Cross-platform: Windows (Registry + Start Menu), Linux (systemd + .desktop), macOS (LaunchAgent)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ok, warn, fail, info, c } = require('./banner');

const HOME = os.homedir();

/**
 * Register EterX to auto-start on system boot
 */
function registerAutoStart(projectRoot, enable = true) {
  const platform = process.platform;

  if (platform === 'win32') return registerAutoStartWindows(projectRoot, enable);
  if (platform === 'linux') return registerAutoStartLinux(projectRoot, enable);
  if (platform === 'darwin') return registerAutoStartMacOS(projectRoot, enable);
  warn(`Auto-start not supported on ${platform}`);
  return false;
}

// ── Windows: Startup folder shortcut ──
function registerAutoStartWindows(projectRoot, enable) {
  try {
    const startupDir = path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const shortcutPath = path.join(startupDir, 'EterX Agent.lnk');

    if (!enable) {
      if (fs.existsSync(shortcutPath)) { fs.unlinkSync(shortcutPath); ok('Auto-start disabled'); }
      return true;
    }

    const batPath = path.join(projectRoot, 'EterX.bat');
    if (!fs.existsSync(batPath)) {
      const batContent = `@echo off\ntitle EterX Agent\ncd /d "${projectRoot}"\nnode setup\\launcher.js --no-electron\n`;
      fs.writeFileSync(batPath, batContent);
    }

    const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${shortcutPath.replace(/'/g, "''")}');$s.TargetPath='${batPath.replace(/'/g, "''")}';$s.WorkingDirectory='${projectRoot.replace(/'/g, "''")}';$s.WindowStyle=7;$s.Description='EterX AI Agent';$s.Save()`;
    execSync(`powershell -Command "${ps}"`, { stdio: 'ignore' });
    ok('Auto-start enabled (Windows Startup folder)');
    return true;
  } catch (e) {
    warn(`Auto-start failed: ${e.message}`);
    return false;
  }
}

// ── Linux: systemd user service ──
function registerAutoStartLinux(projectRoot, enable) {
  try {
    const serviceDir = path.join(HOME, '.config', 'systemd', 'user');
    const servicePath = path.join(serviceDir, 'eterx.service');

    if (!enable) {
      try { execSync('systemctl --user disable eterx.service', { stdio: 'ignore' }); } catch {}
      if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
      ok('Auto-start disabled');
      return true;
    }

    if (!fs.existsSync(serviceDir)) fs.mkdirSync(serviceDir, { recursive: true });

    const nodePathResolved = execSync('which node', { encoding: 'utf8' }).trim();
    const service = `[Unit]
Description=EterX AI Agent
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${projectRoot}
ExecStart=${nodePathResolved} ${path.join(projectRoot, 'setup', 'launcher.js')} --no-electron
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(servicePath, service);
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    execSync('systemctl --user enable eterx.service', { stdio: 'ignore' });
    ok('Auto-start enabled (systemd user service)');
    return true;
  } catch (e) {
    warn(`Auto-start failed: ${e.message}`);
    return false;
  }
}

// ── macOS: LaunchAgent plist ──
function registerAutoStartMacOS(projectRoot, enable) {
  try {
    const agentsDir = path.join(HOME, 'Library', 'LaunchAgents');
    const plistPath = path.join(agentsDir, 'com.eterx.agent.plist');

    if (!enable) {
      try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' }); } catch {}
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
      ok('Auto-start disabled');
      return true;
    }

    if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });

    const nodePathResolved = execSync('which node', { encoding: 'utf8' }).trim();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.eterx.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePathResolved}</string>
    <string>${path.join(projectRoot, 'setup', 'launcher.js')}</string>
    <string>--no-electron</string>
  </array>
  <key>WorkingDirectory</key><string>${projectRoot}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(projectRoot, '.workspaces', 'eterx.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(projectRoot, '.workspaces', 'eterx-error.log')}</string>
</dict>
</plist>`;
    fs.writeFileSync(plistPath, plist);
    execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
    ok('Auto-start enabled (LaunchAgent)');
    return true;
  } catch (e) {
    warn(`Auto-start failed: ${e.message}`);
    return false;
  }
}

/**
 * Create Start Menu entry (Windows) / App launcher entry (Linux)
 */
function createStartMenuEntry(projectRoot) {
  if (process.platform === 'win32') {
    try {
      const menuDir = path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'EterX');
      if (!fs.existsSync(menuDir)) fs.mkdirSync(menuDir, { recursive: true });

      const batPath = path.join(projectRoot, 'EterX.bat');
      const shortcutPath = path.join(menuDir, 'EterX Agent.lnk');
      const iconPath = path.join(projectRoot, 'public', 'logo.png');

      const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${shortcutPath.replace(/'/g, "''")}');$s.TargetPath='${batPath.replace(/'/g, "''")}';$s.WorkingDirectory='${projectRoot.replace(/'/g, "''")}';$s.Description='EterX AI Agent';$s.Save()`;
      execSync(`powershell -Command "${ps}"`, { stdio: 'ignore' });
      ok('Start Menu entry created');
      return true;
    } catch (e) {
      warn(`Start Menu entry failed: ${e.message}`);
      return false;
    }
  }
  return false;
}

/**
 * Add `eterx` command to system PATH (global CLI)
 */
function registerCLI(projectRoot) {
  const platform = process.platform;

  if (platform === 'win32') {
    try {
      // Create eterx.cmd in project root. Route to eterx.js so commands
      // like `eterx start` and `eterx doctor` use the real CLI router.
      const cmdContent = `@echo off\ncd /d "${projectRoot}"\nnode eterx.js %*\n`;
      const cmdPath = path.join(projectRoot, 'eterx.cmd');
      fs.writeFileSync(cmdPath, cmdContent);

      // Add to user PATH
      const currentPath = execSync('powershell -Command "[Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"', { encoding: 'utf8' }).trim();
      if (!currentPath.includes(projectRoot)) {
        execSync(`powershell -Command "[Environment]::SetEnvironmentVariable('PATH', '${currentPath};${projectRoot}', 'User')"`, { stdio: 'ignore' });
        ok('Added "eterx" command to PATH');
      } else {
        ok('"eterx" command already in PATH');
      }
      return true;
    } catch (e) {
      warn(`CLI registration: ${e.message}`);
      return false;
    }
  } else {
    try {
      // Create eterx shell script
      const shContent = `#!/bin/bash\ncd "${projectRoot}"\nnode eterx.js "$@"\n`;
      const shPath = path.join(projectRoot, 'eterx');
      fs.writeFileSync(shPath, shContent, { mode: 0o755 });

      // Symlink to /usr/local/bin or ~/bin
      const binDir = fs.existsSync('/usr/local/bin') ? '/usr/local/bin' : path.join(HOME, '.local', 'bin');
      if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
      const linkPath = path.join(binDir, 'eterx');

      try { fs.unlinkSync(linkPath); } catch {}
      fs.symlinkSync(shPath, linkPath);
      ok(`Added "eterx" command → ${linkPath}`);
      return true;
    } catch (e) {
      warn(`CLI registration: ${e.message}`);
      return false;
    }
  }
}

/**
 * Unregister all system integrations
 */
function unregisterAll(projectRoot) {
  registerAutoStart(projectRoot, false);

  // Remove Start Menu
  if (process.platform === 'win32') {
    const menuDir = path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'EterX');
    if (fs.existsSync(menuDir)) { fs.rmSync(menuDir, { recursive: true, force: true }); ok('Removed Start Menu entry'); }

    const desktop = path.join(HOME, 'Desktop', 'EterX Agent.lnk');
    if (fs.existsSync(desktop)) { fs.unlinkSync(desktop); ok('Removed desktop shortcut'); }
  } else if (process.platform === 'linux') {
    const df = path.join(HOME, '.local', 'share', 'applications', 'eterx.desktop');
    if (fs.existsSync(df)) { fs.unlinkSync(df); ok('Removed .desktop file'); }
  }

  // Remove CLI
  if (process.platform === 'win32') {
    const cmdPath = path.join(projectRoot, 'eterx.cmd');
    if (fs.existsSync(cmdPath)) fs.unlinkSync(cmdPath);
  } else {
    try {
      const linkPath = path.join('/usr/local/bin', 'eterx');
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    } catch {}
    try {
      const linkPath = path.join(HOME, '.local', 'bin', 'eterx');
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    } catch {}
  }

  ok('All system integrations removed');
}

module.exports = { registerAutoStart, createStartMenuEntry, registerCLI, unregisterAll };
