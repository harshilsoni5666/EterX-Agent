/**
 * EterX — Dependency Installer & Environment Generator
 */
const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ok, warn, fail, info, line, c, spinner } = require('./banner');
const { getProjectRoot } = require('./detect');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function desktopFieldEscape(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '\\ ')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n');
}

const isUnicodeSupported = () => {
  if (process.platform !== 'win32') return true;
  return Boolean(process.env.WT_SESSION) || // Windows Terminal
         process.env.TERM_PROGRAM === 'vscode' ||
         process.env.TERM === 'xterm-256color' ||
         process.env.TERM === 'alacritty';
};
const unicode = isUnicodeSupported();

const criticalPackages = [
  ['next', 'Next.js application runtime'],
  ['react', 'React user interface'],
  ['electron', 'Electron desktop runtime'],
  ['electron-updater', 'Desktop update client'],
  ['@google/genai', 'Google Gemini SDK'],
  ['openai', 'OpenAI SDK'],
  ['@anthropic-ai/sdk', 'Anthropic SDK'],
  ['playwright-core', 'Browser automation runtime'],
];

function progressLine(percent, label, final = false) {
  const width = Math.max(18, Math.min(38, (process.stdout.columns || 80) - 36));
  const filled = Math.round((percent / 100) * width);
  const bar = `${c.brightGreen}${'#'.repeat(filled)}${c.gray}${'-'.repeat(width - filled)}${c.reset}`;
  const text = `  [${bar}] ${String(percent).padStart(3)}%  ${label}`;
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${text}${final ? '\n' : ''}`);
  else if (final || percent === 0) console.log(text);
}

function stopRunningApplication(projectRoot) {
  if (process.platform !== 'win32') return 0;
  const escapedRoot = projectRoot.replace(/'/g, "''");
  const script = [
    `$root=[IO.Path]::GetFullPath('${escapedRoot}').TrimEnd('\\')+'\\'`,
    '$count=0',
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {',
    '  $exe=[string]$_.ExecutablePath; $cmd=[string]$_.CommandLine',
    '  $owned=$exe.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or (($cmd.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0) -and ($cmd -match "electron|next[\\\\/]dist|setup[\\\\/]launcher"))',
    `  if($owned -and $_.ProcessId -ne ${process.pid}) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $count++ }`,
    '}',
    '$count',
  ].join('; ');
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    }).trim();
    const count = Number.parseInt(output, 10) || 0;
    if (count > 0) warn(`Closed ${count} running EterX process(es) so locked libraries can be repaired.`);
    return count;
  } catch {
    return 0;
  }
}

function runNpm(args, projectRoot, displayLabel) {
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
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(npmCommand, args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, NODE_ENV: 'development' },
    });

    const startedAt = Date.now();
    const frames = ['|', '/', '-', '\\'];
    let frame = 0;
    progressLine(0, displayLabel || 'Resolving dependency graph');
    const progressInterval = process.stdout.isTTY ? setInterval(() => {
      const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      progressLine(0, `${frames[frame++ % frames.length]} ${displayLabel || 'Installing libraries'} (${elapsed}s)`);
    }, 120) : null;

    const cleanup = () => {
      if (progressInterval) clearInterval(progressInterval);
      if (logStream) {
        try { logStream.end(); } catch (e) {}
      }
    };
    
    const handleData = (data) => {
      const text = data.toString();
      if (logStream) logStream.write(text);

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
        progressLine(100, `${displayLabel || 'Libraries'} complete`, true);
        resolve(true);
      } else {
        if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
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
  console.log(`  ${c.bold}${c.brightMagenta}Installing the complete dependency set${c.reset}`);

  let success = false;
  for (let index = 0; index < plans.length; index += 1) {
    const attempt = plans.length > 1 ? `Dependency install (attempt ${index + 1}/${plans.length + 1})` : 'Dependency install';
    if (await runNpm(plans[index], projectRoot, attempt)) {
      success = true;
      break;
    }
  }

  if (!success) {
    warn('Normal installation attempts failed. Verifying npm cache before recovery.');
    try { execSync('npm cache verify', { cwd: projectRoot, stdio: 'ignore', timeout: 120000 }); } catch {}
    if (await runNpm(['install', '--legacy-peer-deps', ...quietNetworkArgs], projectRoot, 'Dependency recovery')) {
      success = true;
    }
  }

  console.log();
  if (success) {
    let valid = true;
    for (const [packageName, label] of criticalPackages) {
      try {
        const manifest = path.join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json');
        if (!fs.existsSync(manifest)) throw new Error('manifest not found');
        const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version || 'installed';
        ok(`${packageName.padEnd(20)} ${version.padEnd(12)} ${c.dim}${label}${c.reset}`);
      } catch {
        valid = false;
        fail(`${packageName} is missing after npm completed`);
      }
    }
    if (!valid) return false;
    ok('All required libraries are installed and verified.');
    return true;
  } else {
    fail('Dependency installation failed. Check .workspaces/setup.log for details.');
    return false;
  }
}

async function buildApplication(projectRoot, options = {}) {
  const buildLog = path.join(projectRoot, '.workspaces', 'setup.log');
  const temporaryBuildLog = path.join(projectRoot, '.eterx-build.log');
  const workspacePath = path.join(projectRoot, '.workspaces');
  let detachedWorkspaceTarget = null;
  try {
    const workspaceStat = fs.lstatSync(workspacePath);
    if (workspaceStat.isSymbolicLink()) {
      detachedWorkspaceTarget = fs.realpathSync(workspacePath);
      fs.unlinkSync(workspacePath);
    }
  } catch {}

  const restoreWorkspaceLink = () => {
    if (!detachedWorkspaceTarget) return;
    if (fs.existsSync(workspacePath)) {
      // Some server modules initialize harmless temp/config files while Next
      // evaluates routes. Merge those into durable data before recreating the
      // junction; never replace or delete the durable target itself.
      fs.cpSync(workspacePath, detachedWorkspaceTarget, { recursive: true, force: true });
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
    fs.symlinkSync(detachedWorkspaceTarget, workspacePath, process.platform === 'win32' ? 'junction' : 'dir');
  };

  return new Promise((resolve) => {
    progressLine(0, 'Compiling the production application');
    const nextCli = path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
    const proc = spawn(process.execPath, [nextCli, 'build'], {
      cwd: projectRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        ETERX_BUILD_TARGET: options.target === 'desktop' ? 'desktop' : 'source',
      },
    });
    const logStream = fs.createWriteStream(detachedWorkspaceTarget ? temporaryBuildLog : buildLog, { flags: 'a' });
    const startedAt = Date.now();
    const frames = ['|', '/', '-', '\\'];
    let frame = 0;
    const timer = process.stdout.isTTY ? setInterval(() => {
      progressLine(0, `${frames[frame++ % frames.length]} Compiling production app (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }, 120) : null;
    const capture = (chunk) => logStream.write(chunk);
    proc.stdout.on('data', capture);
    proc.stderr.on('data', capture);
    proc.on('error', (error) => logStream.write(`\nBuild process error: ${error.message}\n`));
    proc.on('close', (code) => {
      if (timer) clearInterval(timer);
      logStream.end(() => {
        try {
          restoreWorkspaceLink();
          if (detachedWorkspaceTarget && fs.existsSync(temporaryBuildLog)) {
            fs.appendFileSync(buildLog, fs.readFileSync(temporaryBuildLog));
            fs.unlinkSync(temporaryBuildLog);
          }
        } catch (error) {
          fail(`Could not reconnect the user data directory: ${error.message}`);
          return resolve(false);
        }
        if (code === 0) {
          progressLine(100, 'Production application compiled', true);
          resolve(true);
        } else {
          if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
          fail(`Production build failed (exit ${code}). See .workspaces/setup.log.`);
          resolve(false);
        }
      });
    });
  });
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
      const batContent = `@echo off\nsetlocal\ntitle EterX Agent\ncd /d "${projectRoot}"\n"${process.execPath}" "${path.join(projectRoot, 'setup', 'launcher.js')}" --production\nif errorlevel 1 pause\n`;
      fs.writeFileSync(path.join(projectRoot, 'EterX.bat'), batContent);
      ok('Created EterX.bat launcher');

      // Try to create desktop shortcut via PowerShell
      try {
        const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
        const shortcutPath = path.join(desktop, 'EterX Agent.lnk');
        const iconPath = path.join(projectRoot, 'public', 'icon.ico');
        const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
        const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut(${psQuote(shortcutPath)});$s.TargetPath=${psQuote(path.join(projectRoot, 'EterX.bat'))};$s.WorkingDirectory=${psQuote(projectRoot)};$s.IconLocation=${psQuote(`${iconPath},0`)};$s.Description='EterX AI Agent';$s.Save()`;
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
        ok('Desktop shortcut created');
      } catch { warn('Could not create desktop shortcut (non-critical)'); }
    } else if (platform === 'linux') {
      const nodePath = process.execPath;
      const desktopFile = `[Desktop Entry]
Name=EterX Agent
Comment=The Autonomous AI Agent
Exec="${desktopFieldEscape(nodePath)}" "${desktopFieldEscape(path.join(projectRoot, 'setup', 'launcher.js'))}" --production
Icon=${desktopFieldEscape(path.join(projectRoot, 'public', 'logo.png'))}
Terminal=false
Type=Application
Categories=Development;AI;
`;
      const appsDir = path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share'), 'applications');
      if (!fs.existsSync(appsDir)) fs.mkdirSync(appsDir, { recursive: true });
      fs.writeFileSync(path.join(appsDir, 'eterx.desktop'), desktopFile);
      ok('Linux .desktop file created');
    } else if (platform === 'darwin') {
      const launchScript = `#!/bin/sh\ncd -- ${shellQuote(projectRoot)}\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(projectRoot, 'setup', 'launcher.js'))}\n`;
      fs.writeFileSync(path.join(projectRoot, 'eterx.sh'), launchScript, { mode: 0o755 });
      ok('macOS launcher script created');
    }
  } catch (e) {
    warn(`Desktop shortcut: ${e.message}`);
  }
}

module.exports = {
  installDependencies,
  buildApplication,
  stopRunningApplication,
  installProviderPackages,
  generateEnvFile,
  setupLocalStorage,
  createDesktopShortcut,
};
