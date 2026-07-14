/**
 * EterX — Dependency Installer & Environment Generator
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ok, warn, fail, info, line, c, spinner } = require('./banner');
const { getProjectRoot } = require('./detect');

const isUnicodeSupported = () => {
  if (process.platform !== 'win32') return true;
  return Boolean(process.env.WT_SESSION) || // Windows Terminal
         process.env.TERM_PROGRAM === 'vscode' ||
         process.env.TERM === 'xterm-256color' ||
         process.env.TERM === 'alacritty';
};
const unicode = isUnicodeSupported();

const packages = [
  { name: 'next', label: 'Next.js Web Server Core', status: 'pending', pct: 0 },
  { name: 'react', label: 'React UI Renderer Engine', status: 'pending', pct: 0 },
  { name: 'electron', label: 'Electron Desktop Wrapper', status: 'pending', pct: 0 },
  { name: '@google/genai', label: 'Google Gemini AI Client', status: 'pending', pct: 0 },
  { name: 'openai', label: 'OpenAI API Connector', status: 'pending', pct: 0 },
  { name: '@anthropic-ai/sdk', label: 'Anthropic Claude API Connector', status: 'pending', pct: 0 },
  { name: 'framer-motion', label: 'GPU-Accelerated Transition Engine', status: 'pending', pct: 0 },
  { name: 'playwright-core', label: 'Isolated Browser Automator Engine', status: 'pending', pct: 0 },
];

function redrawProgress(firstDraw = false) {
  if (!firstDraw) {
    process.stdout.write(`\x1b[${packages.length}A`);
  }
  packages.forEach(p => {
    if (!firstDraw) {
      process.stdout.write('\r\x1b[K');
    }
    let icon = c.gray + (unicode ? '○' : '*') + ' [Waiting] ' + c.reset;
    if (p.status === 'downloading') {
      const pctStr = `${p.pct}%`.padStart(4);
      icon = `${c.brightYellow}${unicode ? '🔄' : 'o'} [${pctStr}] ` + c.reset;
    } else if (p.status === 'done') {
      icon = c.brightGreen + (unicode ? '✔' : '√') + ' [ Done  ] ' + c.reset;
    }
    process.stdout.write(`    ${icon} ${c.bold}${p.name.padEnd(18)}${c.reset} ${c.dim}${p.label}${c.reset}\n`);
  });
}

function runNpm(args, projectRoot, spin) {
  const label = `npm ${args.join(' ')}`;
  
  let logStream;
  try {
    const logDir = path.join(projectRoot, '.workspaces');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    logStream = fs.createWriteStream(path.join(logDir, 'setup.log'), { flags: 'a' });
    logStream.write(`\n[${new Date().toISOString()}] Running: ${label}\n`);
  } catch (e) {
    // ignore
  }

  return new Promise((resolve) => {
    const proc = spawn('npm', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, NODE_ENV: 'development' },
    });

    let lastProgressMsg = '';
    let lastProgressTime = Date.now();
    
    // Smooth countdown timer to simulate download updates in real-time like Steam/Play Store
    const progressInterval = setInterval(() => {
      let updated = false;
      packages.forEach(p => {
        if (p.status === 'downloading' && p.pct < 95) {
          p.pct += Math.floor(Math.random() * 3) + 1;
          if (p.pct > 95) p.pct = 95;
          updated = true;
        }
      });
      if (updated) {
        redrawProgress();
      }
    }, 150);

    const cleanup = () => {
      clearInterval(progressInterval);
      if (logStream) {
        try { logStream.end(); } catch (e) {}
      }
    };
    
    const handleData = (data) => {
      const text = data.toString();
      if (logStream) logStream.write(text);

      const lines = text.split(/\r?\n/);
      for (const lineText of lines) {
        const cleanLine = lineText.trim();
        if (!cleanLine) continue;

        if (cleanLine.toLowerCase().includes('deprecated') || 
            cleanLine.toLowerCase().includes('warn') || 
            cleanLine.toLowerCase().includes('deprecationwarning')) {
          continue;
        }

        // Trigger active downloading progress based on npm logs
        if (cleanLine.includes('reify:') || cleanLine.includes('extract:')) {
          const parts = cleanLine.split(':');
          const pkg = parts[parts.length - 1].trim();
          if (pkg) {
            const matched = packages.find(p => pkg.startsWith(p.name) || p.name.startsWith(pkg) || pkg.includes(p.name));
            if (matched && matched.status !== 'done') {
              matched.status = 'downloading';
              if (matched.pct < 20) matched.pct = 20;
              redrawProgress();
              lastProgressTime = Date.now();
            }
          }
        } else if (cleanLine.includes('tarball:')) {
          const pkg = cleanLine.substring(cleanLine.indexOf('tarball:') + 8).trim();
          if (pkg) {
            const matched = packages.find(p => pkg.startsWith(p.name) || p.name.startsWith(pkg) || pkg.includes(p.name));
            if (matched && matched.status === 'pending') {
              matched.status = 'downloading';
              matched.pct = 10;
              redrawProgress();
              lastProgressTime = Date.now();
            }
          }
        } else if (cleanLine.includes('added') && cleanLine.includes('packages')) {
          lastProgressMsg = cleanLine;
        } else if (cleanLine.includes('audited') && cleanLine.includes('packages')) {
          lastProgressMsg = cleanLine;
        }
      }
    };

    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);

    proc.on('error', (err) => {
      cleanup();
      if (logStream) {
        logStream.write(`Process error: ${err.message}\n`);
      }
      resolve(false);
    });

    proc.on('close', (code) => {
      cleanup();
      if (code === 0) {
        resolve(true);
      } else {
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
  const quietNetworkArgs = ['--no-audit', '--fund=false'];
  const plans = hasLockfile
    ? [
      ['ci', '--legacy-peer-deps', ...quietNetworkArgs],
      ['install', '--legacy-peer-deps', ...quietNetworkArgs],
    ]
    : [
      ['install', '--legacy-peer-deps', ...quietNetworkArgs],
    ];

  console.log();
  console.log(`  ${c.bold}${c.brightMagenta}Installing Libraries (Real-time Packages Download):${c.reset}`);
  packages.forEach(p => {
    p.status = 'pending';
    p.pct = 0;
  });
  redrawProgress(true); // first draw

  let success = false;
  for (let index = 0; index < plans.length; index += 1) {
    if (await runNpm(plans[index], projectRoot, null)) {
      success = true;
      break;
    }
  }

  if (!success) {
    // Try final forced install
    if (await runNpm(['install', '--legacy-peer-deps', '--force', ...quietNetworkArgs], projectRoot, null)) {
      success = true;
    }
  }

  // Complete all progress indicators
  packages.forEach(p => {
    p.status = 'done';
    p.pct = 100;
  });
  redrawProgress();

  console.log();
  if (success) {
    ok('Dependencies successfully installed.');
    return true;
  } else {
    fail('Dependency installation failed. Check .workspaces/setup.log for details.');
    return false;
  }
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
Comment=The Autonomous AI Agent
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
