/**
 * EterX — Dependency Installer & Environment Generator
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ok, warn, fail, info, line } = require('./banner');
const { getProjectRoot } = require('./detect');

function runNpm(args, projectRoot) {
  const label = `npm ${args.join(' ')}`;
  console.log();
  info(`Running ${label}`);
  line();

  return new Promise((resolve) => {
    const proc = spawn('npm', args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, NODE_ENV: 'development' },
    });

    proc.on('error', (err) => {
      fail(`${label} could not start: ${err.message}`);
      resolve(false);
    });

    proc.on('close', (code) => {
      line();
      if (code === 0) {
        ok(`${label} completed`);
        resolve(true);
      } else {
        fail(`${label} exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

/**
 * Install npm dependencies with live output
 */
async function installDependencies(projectRoot) {
  const hasLockfile = fs.existsSync(path.join(projectRoot, 'package-lock.json'));
  const baseArgs = hasLockfile ? ['ci'] : ['install'];
  const installed = await runNpm(baseArgs, projectRoot);
  if (installed) return true;

  warn('Standard dependency setup failed. Retrying with --legacy-peer-deps for compatibility.');
  warn('This keeps setup moving on machines where npm blocks peer dependency mismatches.');
  return runNpm([...baseArgs, '--legacy-peer-deps'], projectRoot);
}

/**
 * Install extra provider packages that aren't in package.json
 */
async function installProviderPackages(selectedProviders, projectRoot) {
  // Collect npm packages from selected providers
  const existingPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const existingDeps = { ...existingPkg.dependencies, ...existingPkg.devDependencies };

  const needed = [];
  for (const provider of selectedProviders) {
    if (!provider.npm) continue;
    for (const pkg of provider.npm) {
      if (!existingDeps[pkg] && !needed.includes(pkg)) {
        needed.push(pkg);
      }
    }
  }

  if (needed.length === 0) {
    ok('All provider packages already in package.json');
    return true;
  }

  const installed = await runNpm(['install', '--save', ...needed], projectRoot);
  if (installed) return true;

  warn('Provider package install failed. Retrying with --legacy-peer-deps.');
  return runNpm(['install', '--save', '--legacy-peer-deps', ...needed], projectRoot);
}

/**
 * Generate .env.local from collected keys
 */
function generateEnvFile(config, projectRoot) {
  const lines = [
    '# ═══════════════════════════════════════════════════════',
    '# EterX Agent — Environment Configuration',
    `# Generated: ${new Date().toISOString()}`,
    '# ═══════════════════════════════════════════════════════',
    '',
  ];

  // Model provider keys
  lines.push('# ══ MODEL PROVIDERS ══');
  for (const [providerId, data] of Object.entries(config.providers || {})) {
    lines.push(`\n# --- ${data.name || providerId} ---`);
    if (data.keys && typeof data.keys === 'object') {
      for (const [envKey, value] of Object.entries(data.keys)) {
        if (value) lines.push(`${envKey}=${value}`);
      }
    }
    if (data.multiKeys && Array.isArray(data.multiKeys)) {
      data.multiKeys.forEach((key, i) => {
        if (key) lines.push(`${data.envPrefix}${i + 1}=${key}`);
      });
    }
    if (data.endpoint) {
      const urlKey = data.endpointEnvKey || `${providerId.toUpperCase()}_API_URL`;
      lines.push(`${urlKey}=${data.endpoint}`);
    }
  }

  // Service keys
  lines.push('\n# ══ SERVICES & INTEGRATIONS ══');
  for (const [serviceId, data] of Object.entries(config.services || {})) {
    lines.push(`\n# --- ${data.name || serviceId} ---`);
    if (data.keys && typeof data.keys === 'object') {
      for (const [envKey, value] of Object.entries(data.keys)) {
        if (value) lines.push(`${envKey}=${value}`);
      }
    }
    if (data.multiKeys && Array.isArray(data.multiKeys)) {
      data.multiKeys.forEach((key, i) => {
        if (key) lines.push(`${data.envPrefix}${i + 1}=${key}`);
      });
    }
  }

  // App config
  lines.push('\n# ══ APP CONFIG ══');
  lines.push(`NEXT_PUBLIC_APP_URL=http://localhost:${config.port || 3000}`);
  lines.push('');

  const envPath = path.join(projectRoot, '.env.local');
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
  ok(`.env.local written (${lines.length} lines)`);
  return envPath;
}

/**
 * Create local storage directories
 */
function setupLocalStorage(projectRoot) {
  const dirs = [
    '.workspaces',
    '.workspaces/memory',
    '.workspaces/memory/project_memory',
    '.workspaces/memory/session_memory',
    '.workspaces/memory/overlays',
    '.workspaces/dynamic_tools',
    '.workspaces/config',
  ];

  for (const dir of dirs) {
    const fullPath = path.join(projectRoot, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  // Create default config if not exists
  const configPath = path.join(projectRoot, '.workspaces', 'config', 'eterx.config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      version: '1.0.0',
      theme: 'dark',
      launchMode: 'web',
      port: 3000,
      autoStart: false,
      createdAt: new Date().toISOString(),
    }, null, 2));
  }

  ok('Local storage initialized');
}

/**
 * Create desktop shortcuts (Windows / Linux / macOS)
 */
function createDesktopShortcut(projectRoot, platform) {
  try {
    if (platform === 'win32') {
      // Create a .bat launcher in the project root
      const batContent = `@echo off\ntitle EterX Agent\ncd /d "${projectRoot}"\nnode setup\\launcher.js\n`;
      fs.writeFileSync(path.join(projectRoot, 'EterX.bat'), batContent);
      ok('Created EterX.bat launcher');

      // Try to create desktop shortcut via PowerShell
      try {
        const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
        const shortcutPath = path.join(desktop, 'EterX Agent.lnk');
        const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${shortcutPath.replace(/'/g, "''")}');$s.TargetPath='${path.join(projectRoot, 'EterX.bat').replace(/'/g, "''")}';$s.WorkingDirectory='${projectRoot.replace(/'/g, "''")}';$s.Description='EterX AI Agent';$s.Save()`;
        execSync(`powershell -Command "${ps}"`, { stdio: 'ignore' });
        ok('Desktop shortcut created');
      } catch { warn('Could not create desktop shortcut (non-critical)'); }
    } else if (platform === 'linux') {
      const desktopFile = `[Desktop Entry]
Name=EterX Agent
Comment=The Autonomous AI Agent System
Exec=node ${path.join(projectRoot, 'setup', 'launcher.js')}
Icon=${path.join(projectRoot, 'public', 'logo.png')}
Terminal=false
Type=Application
Categories=Development;AI;
`;
      const appsDir = path.join(process.env.HOME || '~', '.local', 'share', 'applications');
      if (!fs.existsSync(appsDir)) fs.mkdirSync(appsDir, { recursive: true });
      fs.writeFileSync(path.join(appsDir, 'eterx.desktop'), desktopFile);
      ok('Linux .desktop file created');
    } else if (platform === 'darwin') {
      const launchScript = `#!/bin/bash\ncd "${projectRoot}"\nnode setup/launcher.js\n`;
      fs.writeFileSync(path.join(projectRoot, 'eterx.sh'), launchScript, { mode: 0o755 });
      ok('macOS launcher script created');
    }
  } catch (e) {
    warn(`Desktop shortcut: ${e.message}`);
  }
}

module.exports = {
  installDependencies,
  installProviderPackages,
  generateEnvFile,
  setupLocalStorage,
  createDesktopShortcut,
};
