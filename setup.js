#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════╗
 * ║       EterX Agent — Setup & Configuration        ║
 * ║       One command. Full agent. Ready to go.       ║
 * ╚══════════════════════════════════════════════════╝
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { showBanner, ok, warn, fail, info, step, line, c } = require('./setup/banner');
const { getSystemInfo, getProjectRoot } = require('./setup/detect');
const { installDependencies, setupLocalStorage, createDesktopShortcut } = require('./setup/installer');
const { createStartMenuEntry, registerCLI } = require('./setup/autostart');
const { checkForUpdates, performUpgrade, backupConfig, restoreConfig, getVersion, getCommitHash } = require('./setup/updater');
const { initLog, patchConsoleForLogging } = require('./setup/logger');

const ROOT = getProjectRoot();
const args = process.argv.slice(2);
const flag = args.find(arg => arg.startsWith('--')) || '';

async function main() {
  initLog();
  patchConsoleForLogging();

  switch (flag) {
    case '--auto':
    case '--yes':
    case '--quick':
      return autoSetup();
    case '--launch':
      return launch();
    case '--status':
      return showStatus();
    case '--repair':
      return repair();
    case '--upgrade':
      return upgrade();
    case '--backup':
      return backup();
    case '--restore':
      return restore();
    case '--uninstall':
      return uninstall();
    case '--health':
    case '--api':
    case '--apis':
    case '--keys':
    case '--reconfigure':
    case '--add-key':
      showBanner();
      info("Note: Configuration, API keys, and validation checks are now managed");
      info("directly in the EterX Desktop UI's Settings panel instead of the CLI.");
      return;
    default:
      // Fallback to auto-setup as interactive console setup is deprecated
      return autoSetup();
  }
}

// ══════════════════════════════════════════════
//  Automatic Setup
// ══════════════════════════════════════════════
async function autoSetup(options = {}) {
  if (!options.bannerAlreadyShown) showBanner();
  const version = getVersion(ROOT);
  const hash = getCommitHash(ROOT);
  info(`Version ${version} (${hash})`);
  info('Automatic setup mode: no prompts, same terminal, best-effort repair.');

  step('System Detection');
  const sys = getSystemInfo();
  if (!sys.node.installed || sys.node.major < 18) {
    fail('Node.js 18+ is required. Install from https://nodejs.org');
    process.exit(1);
  }

  step('Installing Dependencies');
  const depOk = await installDependencies(ROOT);
  if (!depOk) {
    fail('Dependency installation failed. Review the npm output above.');
    process.exit(1);
  }

  step('Environment');
  ensureAutoEnvFile(ROOT);

  step('Setting Up Local Storage');
  setupLocalStorage(ROOT);

  step('System Integration');
  createDesktopShortcut(ROOT, process.platform);
  createStartMenuEntry(ROOT);
  registerCLI(ROOT);

  const metaPath = path.join(ROOT, '.workspaces', 'config', 'setup-meta.json');
  const metaDir = path.dirname(metaPath);
  if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({
    installedAt: new Date().toISOString(),
    mode: 'auto',
    version: getVersion(ROOT),
    commit: getCommitHash(ROOT),
    platform: process.platform,
    nodeVersion: process.version,
  }, null, 2));
  ok('Setup metadata written');

  step('Automatic Setup Complete');
  console.log(`
  ${c.green}${c.bold}EterX setup is ready.${c.reset}

  ${c.cyan}Next commands:${c.reset}
    ${c.bold}eterx start${c.reset}      Web app
    ${c.bold}eterx desktop${c.reset}    Desktop app
  `);
}

function ensureAutoEnvFile(projectRoot) {
  const envPath = path.join(projectRoot, '.env.local');
  if (fs.existsSync(envPath)) {
    ok('.env.local already exists; preserving current keys');
    return envPath;
  }

  const lines = [
    '# ═══════════════════════════════════════════════════════',
    '# EterX Agent — Environment Configuration',
    `# Generated: ${new Date().toISOString()}`,
    '# ═══════════════════════════════════════════════════════',
    '',
    '# Port configuration for EterX services',
    'PORT=3000',
    'NEXT_PUBLIC_APP_URL=http://localhost:3000',
    '',
    '# Primary Google Gemini API key pool (required for chat and tools)',
    'GEMINI_API_KEY=',
    'GEMINI_API_KEY_1=',
    '',
    '# Optional AI provider keys (can be configured in Settings UI)',
    '# OPENAI_API_KEY=',
    '# ANTHROPIC_API_KEY=',
    '# GROQ_API_KEY=',
    '# TAVILY_API_KEY=',
    '',
  ];

  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
  ok('Created new default .env.local configuration file.');
  return envPath;
}

// ══════════════════════════════════════════════
//  --status
// ══════════════════════════════════════════════
async function showStatus() {
  showBanner();
  step('EterX Status');
  info(`Version: ${getVersion(ROOT)} (${getCommitHash(ROOT)})`);

  const metaPath = path.join(ROOT, '.workspaces', 'config', 'setup-meta.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    info(`Installed: ${meta.installedAt}`);
    info(`Mode: ${meta.mode || 'auto'}`);
  }

  const envPath = path.join(ROOT, '.env.local');
  if (fs.existsSync(envPath)) {
    ok(`.env.local: ${fs.readFileSync(envPath, 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#') && l.trim()).length} keys`);
  } else { fail('.env.local missing'); }

  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm)) ok(`node_modules: ${fs.readdirSync(nm).filter(d => !d.startsWith('.')).length} packages`);
  else fail('node_modules missing');

  const ws = path.join(ROOT, '.workspaces');
  if (fs.existsSync(ws)) ok('Local storage: initialized');
  else warn('Local storage missing');

  const updates = await checkForUpdates(ROOT);
  if (updates.available) {
    console.log(`\n  ${c.yellow}${c.bold}⬆ Update available!${c.reset} ${updates.behind} commits behind.`);
    console.log(`  ${c.dim}Run: node setup.js --upgrade${c.reset}`);
  }
}

// ══════════════════════════════════════════════
//  --repair
// ══════════════════════════════════════════════
async function repair() {
  showBanner();
  step('Repairing Installation');
  setupLocalStorage(ROOT);
  const ok2 = await installDependencies(ROOT);
  if (ok2) ok('Repair complete');
  else {
    fail('Repair failed — check setup.log');
    process.exitCode = 1;
  }
}

// ══════════════════════════════════════════════
//  --upgrade
// ══════════════════════════════════════════════
async function upgrade() {
  showBanner();
  step('Upgrade EterX');
  const updates = await checkForUpdates(ROOT);
  if (!updates.available) return;

  if (updates.log) {
    console.log(`\n  ${c.bold}Recent changes:${c.reset}`);
    updates.log.split('\n').forEach(l => console.log(`  ${c.dim}${l}${c.reset}`));
  }

  // Automatic upgrade pull
  await performUpgrade(ROOT);
}

// ══════════════════════════════════════════════
//  --backup / --restore
// ══════════════════════════════════════════════
async function backup() {
  showBanner();
  step('Backup Config & Memory');
  await backupConfig(ROOT);
}

async function restore() {
  showBanner();
  step('Restore Config & Memory');
  await restoreConfig(ROOT);
}

// ══════════════════════════════════════════════
//  --uninstall / --launch
// ══════════════════════════════════════════════
async function uninstall() {
  showBanner();
  step('Uninstalling EterX');
  const { unregisterAll } = require('./setup/autostart');
  unregisterAll(ROOT);
  ok('Desktop auto-start and CLI entries removed.');
  info('To complete uninstallation, delete the project folder.');
}

function launch() {
  showBanner();
  step('Launching EterX');
  spawn('npm', ['run', 'desktop'], { cwd: ROOT, stdio: 'inherit', shell: true });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
