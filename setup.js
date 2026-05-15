#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════╗
 * ║       EterX Agent — Setup & Configuration        ║
 * ║       One command. Full agent. Ready to go.       ║
 * ╚══════════════════════════════════════════════════╝
 *
 * Usage:
 *   node setup.js                    Full setup wizard
 *   node setup.js --auto             Automatic no-prompt setup/repair
 *   node setup.js --reconfigure      Re-run API key wizard
 *   node setup.js --status           Show current config
 *   node setup.js --health           Run health check (test all keys)
 *   node setup.js --repair           Re-install dependencies
 *   node setup.js --upgrade          Pull latest + re-install
 *   node setup.js --backup           Backup config & memory
 *   node setup.js --restore          Restore from backup
 *   node setup.js --uninstall        Remove EterX
 *   node setup.js --launch           Launch the app
 *   node setup.js --add-key          Add a single API key
 */
const path = require('path');
const fs = require('fs');
const { showBanner, ok, warn, fail, info, step, header, line, c, spinner } = require('./setup/banner');
const { getSystemInfo, getProjectRoot } = require('./setup/detect');
const { createRL, ask, askSecret, confirm, selectOne, selectMultiple, selectLaunchMode } = require('./setup/prompts');
const { PROVIDERS, SERVICES } = require('./setup/providers');
const { installDependencies, installProviderPackages, generateEnvFile, setupLocalStorage, createDesktopShortcut } = require('./setup/installer');
const { runHealthCheck } = require('./setup/health');
const { registerAutoStart, createStartMenuEntry, registerCLI, unregisterAll } = require('./setup/autostart');
const { checkForUpdates, performUpgrade, backupConfig, restoreConfig, getVersion, getCommitHash } = require('./setup/updater');
const { initLog, patchConsoleForLogging } = require('./setup/logger');
const { spawn } = require('child_process');

const ROOT = getProjectRoot();
const args = process.argv.slice(2);
const flag = args.find(arg => arg.startsWith('--')) || '';

// ══════════════════════════════════════════════
//  CLI Router
// ══════════════════════════════════════════════
async function main() {
  initLog();
  patchConsoleForLogging();

  switch (flag) {
    case '--auto':
    case '--yes':
    case '--quick':
      return autoSetup();
    case '--launch': return launch();
    case '--status': return showStatus();
    case '--health': return healthCheck();
    case '--repair': return repair();
    case '--uninstall': return uninstall();
    case '--reconfigure': return reconfigure();
    case '--add-key': return addKey();
    case '--upgrade': return upgrade();
    case '--backup': return backup();
    case '--restore': return restore();
    default: return fullSetup();
  }
}

// ══════════════════════════════════════════════
//  Full Setup Wizard
// ══════════════════════════════════════════════
async function fullSetup() {
  showBanner();
  const version = getVersion(ROOT);
  const hash = getCommitHash(ROOT);
  info(`Version ${version} (${hash})`);

  if (!process.stdin.isTTY) {
    warn('No interactive terminal detected. Switching to automatic setup mode.');
    return autoSetup({ bannerAlreadyShown: true });
  }

  step('System Detection');
  const sys = getSystemInfo();

  if (!sys.node.installed || sys.node.major < 18) {
    fail('Node.js 18+ is required. Install from https://nodejs.org');
    process.exit(1);
  }

  const rl = createRL();

  // Phase 1: Dependencies
  step('Installing Dependencies');
  const depOk = await installDependencies(ROOT);
  if (!depOk) {
    const retry = await confirm(rl, 'Install failed. Retry?');
    if (retry) await installDependencies(ROOT);
    else warn('Continuing...');
  }

  // Phase 2: Model Providers
  step('Model Provider Configuration');
  console.log(`  ${c.dim}EterX supports ${PROVIDERS.length} AI providers. Gemini is required.${c.reset}\n`);

  const config = { providers: {}, services: {}, port: 3000 };

  // Required providers (Gemini)
  for (const provider of PROVIDERS.filter(p => p.required)) {
    header(`${provider.name} ${c.yellow}[REQUIRED]${c.reset}`);
    info(provider.description);
    if (provider.getUrl) info(`Get key: ${c.cyan}${provider.getUrl}${c.reset}`);
    console.log();

    if (provider.multiKey) {
      const firstKey = await askSecret(rl, `${provider.name} API Key`);
      if (!firstKey) { fail('At least one Gemini key is required!'); process.exit(1); }
      const multiKeys = [firstKey];
      if (await confirm(rl, 'Add more keys for load-balancing?', false)) {
        console.log(`  ${c.dim}Enter keys one per line. Empty line to stop.${c.reset}`);
        while (multiKeys.length < provider.maxKeys) {
          const key = await askSecret(rl, `Key ${multiKeys.length + 1} (Enter to finish)`);
          if (!key) break;
          multiKeys.push(key);
        }
      }
      config.providers[provider.id] = { name: provider.name, multiKeys, envPrefix: provider.envPrefix, keys: { [provider.envKeys[0]]: firstKey } };
      ok(`${multiKeys.length} key(s) configured`);
    }
  }

  // Optional providers
  const optional = PROVIDERS.filter(p => !p.required);
  const selected = await selectMultiple(rl, 'Select additional model providers:', optional);

  for (const idx of selected) {
    const p = optional[idx];
    header(p.name);
    info(p.description);
    if (p.getUrl) info(`Get key: ${c.cyan}${p.getUrl}${c.reset}`);
    console.log();

    if (p.noKeyRequired) {
      const url = await ask(rl, `${p.name} URL`, p.defaultValue);
      config.providers[p.id] = { name: p.name, endpoint: url || p.defaultValue, keys: {} };
    } else if (p.isCustom) {
      const url = await ask(rl, 'API Endpoint URL');
      const key = await askSecret(rl, 'API Key');
      config.providers[p.id] = { name: p.name, endpoint: url, keys: { CUSTOM_API_KEY: key, CUSTOM_API_URL: url } };
    } else {
      const keys = {};
      for (const envKey of p.envKeys) {
        const val = await askSecret(rl, envKey);
        if (val) keys[envKey] = val;
      }
      config.providers[p.id] = { name: p.name, keys, endpoint: p.endpoint };
    }
    ok(`${p.name} configured`);
  }

  // Provider packages
  const selectedProviders = selected.map(i => optional[i]);
  if (selectedProviders.length > 0) {
    step('Installing Provider Packages');
    await installProviderPackages(selectedProviders, ROOT);
  }

  // Phase 3: Services
  step('Service Integrations');
  for (const service of SERVICES) {
    if (!(await confirm(rl, `Configure ${service.name}?`, false))) continue;
    header(service.name);
    info(service.description);
    if (service.getUrl) info(`Setup: ${c.cyan}${service.getUrl}${c.reset}`);
    console.log();

    if (service.multiKey) {
      const keys = [];
      for (let i = 0; i < (service.maxKeys || 3); i++) {
        const key = await askSecret(rl, `${service.envKeys[0]} ${i + 1} (Enter to finish)`);
        if (!key) break;
        keys.push(key);
      }
      config.services[service.id] = { name: service.name, multiKeys: keys, envPrefix: service.envPrefix };
    } else {
      const keys = {};
      for (const envKey of service.envKeys) {
        const val = await askSecret(rl, envKey);
        if (val) keys[envKey] = val;
      }
      config.services[service.id] = { name: service.name, keys };
    }
    ok(`${service.name} configured`);
  }

  // Phase 4: Generate env
  step('Generating Environment');
  generateEnvFile(config, ROOT);

  // Phase 5: Local storage
  step('Setting Up Local Storage');
  setupLocalStorage(ROOT);

  // Phase 6: System integration
  step('System Integration');
  createDesktopShortcut(ROOT, process.platform);
  createStartMenuEntry(ROOT);

  const wantAutoStart = await confirm(rl, 'Auto-start EterX on system boot?', false);
  if (wantAutoStart) registerAutoStart(ROOT, true);

  const wantCLI = await confirm(rl, 'Add "eterx" command to your terminal?', true);
  if (wantCLI) registerCLI(ROOT);

  // Phase 7: Health check
  step('Validating Installation');
  const health = await runHealthCheck(ROOT);
  line();
  console.log(`\n  ${c.bold}Results:${c.reset} ${c.green}${health.passed} passed${c.reset}  ${health.warnings > 0 ? c.yellow + health.warnings + ' warnings' + c.reset + '  ' : ''}${health.failed > 0 ? c.red + health.failed + ' failed' + c.reset : ''}\n`);

  // Save meta
  const metaPath = path.join(ROOT, '.workspaces', 'config', 'setup-meta.json');
  const metaDir = path.dirname(metaPath);
  if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({
    installedAt: new Date().toISOString(),
    version: getVersion(ROOT),
    commit: getCommitHash(ROOT),
    providers: Object.keys(config.providers),
    services: Object.keys(config.services),
    platform: process.platform,
    nodeVersion: process.version,
    healthPassed: health.passed,
    healthFailed: health.failed,
  }, null, 2));

  // Phase 8: Launch
  step('Setup Complete!');
  console.log(`
  ${c.green}${c.bold}⚡ EterX Agent is ready!${c.reset}

  ${c.cyan}Quick start:${c.reset}
    ${c.bold}eterx start${c.reset}          Web app at localhost:3000
    ${c.bold}eterx desktop${c.reset}        Desktop app (Electron)
    ${c.bold}eterx telegram${c.reset}       Telegram bot

  ${c.cyan}Management:${c.reset}
    ${c.bold}eterx config${c.reset}         Change API keys
    ${c.bold}eterx health${c.reset}         Test all connections
    ${c.bold}eterx doctor${c.reset}         Deep system diagnosis
    ${c.bold}eterx status${c.reset}         View current config
  `);

  const launchChoice = await selectLaunchMode(rl);
  rl.close();

  if (launchChoice.index === 0) spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: 'inherit', shell: true });
  else if (launchChoice.index === 1) spawn('npm', ['run', 'desktop'], { cwd: ROOT, stdio: 'inherit', shell: true });
  else if (launchChoice.index === 2) spawn('npm', ['run', 'telegram-dev'], { cwd: ROOT, stdio: 'inherit', shell: true });
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

  step('Diagnostics');
  const { runDoctor } = require('./setup/doctor');
  await runDoctor(ROOT);

  step('Automatic Setup Complete');
  console.log(`
  ${c.green}${c.bold}EterX setup is ready.${c.reset}

  ${c.cyan}Next commands:${c.reset}
    ${c.bold}eterx start${c.reset}      Web app
    ${c.bold}eterx desktop${c.reset}    Desktop app
    ${c.bold}eterx config${c.reset}     Add or update API keys
    ${c.bold}eterx health${c.reset}     Test live API connections
  `);
}

function ensureAutoEnvFile(projectRoot) {
  const envPath = path.join(projectRoot, '.env.local');
  if (fs.existsSync(envPath)) {
    ok('.env.local already exists; preserving current keys');
    return envPath;
  }

  const config = { providers: {}, services: {}, port: Number(process.env.PORT || 3000) || 3000 };

  for (const provider of PROVIDERS) {
    const keys = {};
    for (const envKey of provider.envKeys || []) {
      if (process.env[envKey]) keys[envKey] = process.env[envKey];
    }

    const multiKeys = [];
    if (provider.multiKey && provider.envPrefix) {
      if (process.env[provider.envKeys[0]]) multiKeys.push(process.env[provider.envKeys[0]]);
      for (let i = 1; i <= (provider.maxKeys || 1); i++) {
        const value = process.env[`${provider.envPrefix}${i}`];
        if (value && !multiKeys.includes(value)) multiKeys.push(value);
      }
    }

    if (Object.keys(keys).length > 0 || multiKeys.length > 0) {
      config.providers[provider.id] = {
        name: provider.name,
        keys,
        multiKeys,
        envPrefix: provider.envPrefix,
        endpoint: provider.endpoint || provider.defaultValue,
      };
    }
  }

  for (const service of SERVICES) {
    const keys = {};
    for (const envKey of service.envKeys || []) {
      if (process.env[envKey]) keys[envKey] = process.env[envKey];
    }

    const multiKeys = [];
    if (service.multiKey && service.envPrefix) {
      for (let i = 1; i <= (service.maxKeys || 1); i++) {
        const value = process.env[`${service.envPrefix}${i}`];
        if (value) multiKeys.push(value);
      }
    }

    if (Object.keys(keys).length > 0 || multiKeys.length > 0) {
      config.services[service.id] = {
        name: service.name,
        keys,
        multiKeys,
        envPrefix: service.envPrefix,
      };
    }
  }

  const configuredKeys = Object.values(config.providers).some(p => Object.keys(p.keys || {}).length || (p.multiKeys || []).length)
    || Object.values(config.services).some(s => Object.keys(s.keys || {}).length || (s.multiKeys || []).length);
  if (!configuredKeys) {
    warn('No API keys found in environment. Creating minimal .env.local; add keys later with eterx config.');
  }

  return generateEnvFile(config, projectRoot);
}

// ══════════════════════════════════════════════
//  --reconfigure
// ══════════════════════════════════════════════
async function reconfigure() {
  showBanner();
  step('Reconfigure API Keys');
  const rl = createRL();
  const envPath = path.join(ROOT, '.env.local');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  info(`${existing.split('\n').filter(l => l.includes('=') && !l.startsWith('#')).length} keys currently configured`);

  const choice = await selectOne(rl, 'What do you want to do?', [
    { name: 'Add/update a specific provider key' },
    { name: 'Full config wizard (replaces .env.local)' },
    { name: 'View current keys (masked)' },
    { name: 'Cancel' },
  ]);

  if (choice.index === 0) {
    const all = [...PROVIDERS, ...SERVICES];
    const which = await selectOne(rl, 'Select provider:', all);
    const p = which.item;
    header(p.name);
    if (p.getUrl) info(`Get key: ${c.cyan}${p.getUrl}${c.reset}`);

    for (const envKey of p.envKeys) {
      const val = await askSecret(rl, envKey);
      if (val) {
        const re = new RegExp(`^${envKey}=.*$`, 'm');
        let updated = re.test(existing) ? existing.replace(re, `${envKey}=${val}`) : existing.trimEnd() + `\n${envKey}=${val}\n`;
        fs.writeFileSync(envPath, updated);
        ok(`Updated ${envKey}`);
      }
    }
  } else if (choice.index === 1) {
    rl.close();
    return fullSetup();
  } else if (choice.index === 2) {
    existing.split('\n').filter(l => l.includes('=') && !l.startsWith('#')).forEach(l => {
      const [key, ...rest] = l.split('=');
      const val = rest.join('=');
      const masked = val.length > 8 ? val.slice(0, 4) + '•'.repeat(Math.min(val.length - 8, 16)) + val.slice(-4) : '••••';
      console.log(`  ${c.cyan}${key.trim()}${c.reset} = ${masked}`);
    });
  }
  rl.close();
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
    const providers = Array.isArray(meta.providers) ? meta.providers : [];
    const services = Array.isArray(meta.services) ? meta.services : [];
    info(`Installed: ${meta.installedAt}`);
    info(`Mode: ${meta.mode || 'interactive'}`);
    info(`Providers: ${providers.join(', ') || 'none'}`);
    info(`Services: ${services.join(', ') || 'none'}`);
    info(`Last health: ${meta.healthPassed || '?'} passed, ${meta.healthFailed || '?'} failed`);
  } else {
    warn('No setup metadata. Run: node setup.js --auto or node setup.js');
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

  // Check for updates silently
  const updates = await checkForUpdates(ROOT);
  if (updates.available) {
    console.log(`\n  ${c.yellow}${c.bold}⬆ Update available!${c.reset} ${updates.behind} commits behind.`);
    console.log(`  ${c.dim}Run: node setup.js --upgrade${c.reset}`);
  }
}

// ══════════════════════════════════════════════
//  --health
// ══════════════════════════════════════════════
async function healthCheck() {
  showBanner();
  step('Health Check');
  const results = await runHealthCheck(ROOT);
  line();
  console.log(`\n  ${c.bold}Results:${c.reset} ${c.green}${results.passed} passed${c.reset}  ${results.warnings > 0 ? c.yellow + results.warnings + ' warnings' + c.reset + '  ' : ''}${results.failed > 0 ? c.red + results.failed + ' failed' + c.reset : ''}\n`);
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
    header('Recent changes:');
    updates.log.split('\n').forEach(l => console.log(`  ${c.dim}${l}${c.reset}`));
  }

  const rl = createRL();
  const proceed = await confirm(rl, 'Proceed with upgrade?', true);
  rl.close();

  if (proceed) await performUpgrade(ROOT);
}

// ══════════════════════════════════════════════
//  --backup
// ══════════════════════════════════════════════
async function backup() {
  showBanner();
  step('Backup Config & Memory');
  await backupConfig(ROOT);
}

// ══════════════════════════════════════════════
//  --restore
// ══════════════════════════════════════════════
async function restore() {
  showBanner();
  step('Restore from Backup');
  const list = await restoreConfig(ROOT, null);
  if (!list || !Array.isArray(list)) return;

  const rl = createRL();
  console.log(`\n  ${c.bold}Available backups:${c.reset}\n`);
  list.forEach((b, i) => console.log(`  ${c.cyan}[${i + 1}]${c.reset} ${b}`));
  const choice = await ask(rl, '\n  Select backup number');
  const idx = parseInt(choice, 10) - 1;

  if (idx >= 0 && idx < list.length) {
    await restoreConfig(ROOT, list[idx]);
  } else {
    fail('Invalid selection');
  }
  rl.close();
}

// ══════════════════════════════════════════════
//  --uninstall
// ══════════════════════════════════════════════
async function uninstall() {
  showBanner();
  step('Uninstall EterX');
  const rl = createRL();

  const choice = await selectOne(rl, 'What should we remove?', [
    { name: 'App only (keep memory, config, API keys)' },
    { name: 'App + memory (keep API keys)' },
    { name: 'Everything (full wipe)' },
    { name: 'Cancel' },
  ]);

  if (choice.index === 3) { rl.close(); return; }
  if (!(await confirm(rl, `${c.red}Are you sure?${c.reset}`, false))) { rl.close(); return; }

  // Always remove system integrations
  unregisterAll(ROOT);

  if (choice.index >= 1) {
    const ws = path.join(ROOT, '.workspaces');
    if (fs.existsSync(ws)) { fs.rmSync(ws, { recursive: true, force: true }); ok('Removed local storage'); }
  }
  if (choice.index >= 2) {
    const envPath = path.join(ROOT, '.env.local');
    if (fs.existsSync(envPath)) { fs.unlinkSync(envPath); ok('Removed .env.local'); }
  }

  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm)) {
    const s = spinner('Removing node_modules...');
    fs.rmSync(nm, { recursive: true, force: true });
    s.stop('Removed node_modules');
  }

  ok('Uninstall complete');
  rl.close();
}

// ══════════════════════════════════════════════
//  --launch
// ══════════════════════════════════════════════
function launch() {
  const { main: launchMain } = require('./setup/launcher');
  return launchMain();
}

// ══════════════════════════════════════════════
//  --add-key
// ══════════════════════════════════════════════
async function addKey() {
  showBanner();
  const rl = createRL();
  const envPath = path.join(ROOT, '.env.local');
  const keyName = await ask(rl, 'Env variable name (e.g. GROQ_API_KEY)');
  const keyVal = await askSecret(rl, 'Value');
  if (keyName && keyVal) {
    let existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const re = new RegExp(`^${keyName}=.*$`, 'm');
    existing = re.test(existing) ? existing.replace(re, `${keyName}=${keyVal}`) : existing.trimEnd() + `\n${keyName}=${keyVal}\n`;
    fs.writeFileSync(envPath, existing);
    ok(`Saved ${keyName}`);
  }
  rl.close();
}

// ── Run ──
main().catch(err => {
  console.error(`\n${c.red}Setup error:${c.reset} ${err.message}`);
  process.exit(1);
});
