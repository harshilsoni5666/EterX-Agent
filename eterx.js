#!/usr/bin/env node
/**
 * ╔═══════════════════════════════════════╗
 * ║          EterX Agent CLI              ║
 * ║    The single command for everything  ║
 * ╚═══════════════════════════════════════╝
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname);

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m', brightCyan: '\x1b[96m', brightGreen: '\x1b[92m',
  brightMagenta: '\x1b[95m', brightYellow: '\x1b[93m', white: '\x1b[37m',
  bgGreen: '\x1b[42m', bgCyan: '\x1b[46m',
};

const i = {
  bolt: '⚡', rocket: '🚀', gear: '⚙', key: '🔑', globe: '🌐',
  brain: '🧠', shield: '🛡️', chart: '📊', wrench: '🔧', fire: '🔥',
  trophy: '🏆', party: '🎉', diamond: '💎', doctor: '🩺', speed: '⏱️',
  api: '🔌', model: '🤖', disk: '💾', folder: '📁', terminal: '💻',
  package: '📦', search: '🔍', lock: '🔒', trash: '🗑️', refresh: '🔄',
  check: '✔', cross: '✖', warn: '⚠', info: 'ℹ', arrow: '→', sparkle: '✨',
  health: '💊', log: '📋', env: '🗂️', clean: '🧹', backup: '💾',
  restore: '📥', upgrade: '⬆️', uninstall: '🗑️',
};

const MINI_BANNER = `
${c.brightCyan}${c.bold}  ███████╗████████╗███████╗██████╗ ██╗  ██╗${c.reset}
${c.cyan}  ██╔════╝╚══██╔══╝██╔════╝██╔══██╗╚██╗██╔╝${c.reset}
${c.cyan}  █████╗     ██║   █████╗  ██████╔╝ ╚███╔╝${c.reset}
${c.cyan}  ██╔══╝     ██║   ██╔══╝  ██╔══██╗ ██╔██╗${c.reset}
${c.cyan}  ███████╗   ██║   ███████╗██║  ██║██╔╝ ██╗${c.reset}
${c.brightCyan}${c.bold}  ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝${c.reset}
`;

const cmd = (process.argv[2] || '').toLowerCase();
const extraArgs = process.argv.slice(3);

// ── First-run detection ──
function isFirstRun() {
  return !fs.existsSync(path.join(ROOT, '.env.local')) || !fs.existsSync(path.join(ROOT, 'node_modules'));
}

function getVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.1.0'; }
  catch { return '0.1.0'; }
}

// ── Route ──
switch (cmd) {
  case 'start': case 'web': case 'run': case 's':
    launchWithBanner(`${i.rocket} Starting EterX Web App...`, 'dev'); break;

  case 'desktop': case 'app': case 'd':
    launchWithBanner(`${i.terminal} Starting EterX Desktop...`, 'desktop'); break;

  case 'telegram': case 'tg': case 'bot': case 't':
    launchWithBanner(`${i.globe} Starting EterX Telegram Bot...`, 'telegram-dev'); break;

  case 'setup': case 'install':
    runSetup('', extraArgs); break;

  case 'config': case 'configure': case 'keys':
    runSetup('--reconfigure', extraArgs); break;

  case 'health': case 'check': case 'test':
    runSetup('--health', extraArgs); break;

  case 'status': case 'info':
    runSetup('--status', extraArgs); break;

  case 'upgrade': case 'update':
    runSetup('--upgrade', extraArgs); break;

  case 'backup':
    runSetup('--backup', extraArgs); break;

  case 'restore':
    runSetup('--restore', extraArgs); break;

  case 'repair': case 'fix':
    runSetup('--repair', extraArgs); break;

  case 'uninstall': case 'remove':
    runSetup('--uninstall', extraArgs); break;

  case 'add-key': case 'key':
    runSetup('--add-key', extraArgs); break;

  case 'doctor': case 'diagnose':
    runDoctor(); break;

  case 'benchmark': case 'bench': case 'speed':
    runBenchmark(); break;

  case 'providers': case 'models':
    runProviders(); break;

  case 'logs': case 'log':
    showLogs(); break;

  case 'clean': case 'cache':
    runClean(); break;

  case 'env':
    showEnv(); break;

  case 'open':
    openInBrowser(); break;

  case 'help': case '-h': case '--help':
    showHelp(); break;

  case 'version': case '-v': case '--version':
    showVersion(); break;

  default:
    if (cmd && cmd !== '') {
      console.log(`\n  ${c.red}${i.cross} Unknown command: ${c.bold}${cmd}${c.reset}`);
      console.log(`  ${c.dim}Run ${c.reset}${c.bold}eterx help${c.reset}${c.dim} for available commands${c.reset}\n`);
    } else if (isFirstRun()) {
      showFirstRun();
    } else {
      showInteractiveMenu();
    }
    break;
}

// ═══════════════════════════════════════════
//  First Run Experience
// ═══════════════════════════════════════════
function showFirstRun() {
  console.log(MINI_BANNER);
  console.log(`  ${c.brightMagenta}${c.bold}${i.sparkle} Welcome to EterX Agent ${i.sparkle}${c.reset}\n`);
  console.log(`  ${c.dim}First time? Let's get you set up in under 2 minutes.${c.reset}\n`);

  console.log(`  ${c.cyan}${c.bold}${i.arrow} Run:${c.reset}  ${c.bold}eterx setup${c.reset}`);
  console.log(`  ${c.dim}   This will install dependencies, configure your`);
  console.log(`   API keys, set up local storage, and launch EterX.${c.reset}\n`);
  console.log(`  ${c.dim}No prompts / repair mode:${c.reset} ${c.bold}eterx setup --auto${c.reset}\n`);

  console.log(`  ${c.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
  console.log(`  ${c.dim}Or jump straight in:${c.reset}`);
  console.log(`    ${c.cyan}eterx start${c.reset}     ${i.rocket} Launch web app`);
  console.log(`    ${c.cyan}eterx desktop${c.reset}   ${i.terminal} Launch desktop app`);
  console.log(`    ${c.cyan}eterx help${c.reset}      ${i.info} See all commands\n`);

  // Auto-trigger setup if no .env.local
  if (!fs.existsSync(path.join(ROOT, '.env.local'))) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${c.cyan}${i.arrow}${c.reset} Start setup now? [${c.bold}Y${c.reset}/n]: `, (answer) => {
      rl.close();
      if (!answer || answer.toLowerCase().startsWith('y')) {
        runSetup('');
      }
    });
  }
}

// ═══════════════════════════════════════════
//  Launch with Banner
// ═══════════════════════════════════════════
function launchWithBanner(message, script) {
  console.log(MINI_BANNER);
  console.log(`  ${c.brightGreen}${message}${c.reset}\n`);

  // Auto-setup if first run
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) {
    console.log(`  ${c.brightYellow}${i.warn}${c.reset} No configuration found. Running setup first...\n`);
    spawn('node', ['setup.js'], { cwd: ROOT, stdio: 'inherit', shell: true });
    return;
  }

  // Auto-install deps if missing
  const nmPath = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nmPath)) {
    console.log(`  ${c.brightYellow}${i.warn}${c.reset} ${i.package} Dependencies missing. Running setup repair...\n`);
    const proc = spawn('node', ['setup.js', '--repair'], { cwd: ROOT, stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`\n  ${c.brightGreen}${i.check}${c.reset} Dependencies ready. Launching...\n`);
        doLaunch(script);
      } else {
        console.log(`\n  ${c.red}${i.cross} Dependency repair failed${c.reset}`);
        console.log(`  ${c.dim}Run ${c.bold}node setup.js --repair${c.reset}${c.dim} and review the terminal output.${c.reset}\n`);
      }
    });
    return;
  }

  doLaunch(script);
}

function doLaunch(script) {
  console.log(`  ${c.dim}${i.gear} Starting services...${c.reset}\n`);

  const proc = spawn('npm', ['run', script], { cwd: ROOT, stdio: 'inherit', shell: true });

  proc.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.log(`\n  ${c.red}${i.cross} Process exited with code ${code}${c.reset}`);
      console.log(`  ${c.dim}Run ${c.bold}eterx doctor${c.reset}${c.dim} to diagnose issues${c.reset}\n`);
    }
  });
}

// ═══════════════════════════════════════════
//  Setup Router
// ═══════════════════════════════════════════
function runSetup(flag, passthrough = []) {
  const args = ['setup.js'];
  if (flag) args.push(flag);
  args.push(...passthrough);
  spawn('node', args, { cwd: ROOT, stdio: 'inherit' });
}

// ═══════════════════════════════════════════
//  Interactive Menu
// ═══════════════════════════════════════════
function showInteractiveMenu() {
  console.log(MINI_BANNER);

  // Show version + quick status
  const ver = getVersion();
  const envExists = fs.existsSync(path.join(ROOT, '.env.local'));
  const nmExists = fs.existsSync(path.join(ROOT, 'node_modules'));
  const statusTag = envExists && nmExists
    ? `${c.brightGreen}${i.check} Ready${c.reset}`
    : `${c.brightYellow}${i.warn} Setup needed${c.reset}`;

  console.log(`  ${c.brightMagenta}${c.bold}${i.bolt} EterX Agent ${c.dim}v${ver}${c.reset}  ${statusTag}\n`);

  console.log(`  ${c.bold}${i.rocket} Launch${c.reset}`);
  console.log(`    ${c.cyan}eterx start${c.reset}        ${i.globe} Web app  ${c.dim}(localhost:3000)${c.reset}`);
  console.log(`    ${c.cyan}eterx desktop${c.reset}      ${i.terminal} Desktop app  ${c.dim}(Electron)${c.reset}`);
  console.log(`    ${c.cyan}eterx telegram${c.reset}     ${i.globe} Telegram bot`);
  console.log(`    ${c.cyan}eterx open${c.reset}         ${i.globe} Open in browser`);
  console.log();
  console.log(`  ${c.bold}${i.gear} Setup${c.reset}`);
  console.log(`    ${c.cyan}eterx setup${c.reset}        ${i.sparkle} Full setup wizard`);
  console.log(`    ${c.cyan}eterx setup --auto${c.reset} ${i.gear} Automatic no-prompt setup`);
  console.log(`    ${c.cyan}eterx config${c.reset}       ${i.key} Change API keys`);
  console.log(`    ${c.cyan}eterx add-key${c.reset}      ${i.key} Quick-add one key`);
  console.log();
  console.log(`  ${c.bold}${i.doctor} Diagnostics${c.reset}`);
  console.log(`    ${c.cyan}eterx doctor${c.reset}       ${i.doctor} Deep diagnosis  ${c.dim}(30+ checks)${c.reset}`);
  console.log(`    ${c.cyan}eterx health${c.reset}       ${i.health} Live API key test`);
  console.log(`    ${c.cyan}eterx benchmark${c.reset}    ${i.speed} Speed-test providers`);
  console.log(`    ${c.cyan}eterx providers${c.reset}    ${i.model} List all providers`);
  console.log();
  console.log(`  ${c.bold}${i.wrench} Manage${c.reset}`);
  console.log(`    ${c.cyan}eterx status${c.reset}       ${i.chart} Config & update status`);
  console.log(`    ${c.cyan}eterx upgrade${c.reset}      ${i.upgrade} Pull latest updates`);
  console.log(`    ${c.cyan}eterx backup${c.reset}       ${i.backup} Backup config & memory`);
  console.log(`    ${c.cyan}eterx restore${c.reset}      ${i.restore} Restore from backup`);
  console.log(`    ${c.cyan}eterx repair${c.reset}       ${i.wrench} Fix broken install`);
  console.log(`    ${c.cyan}eterx logs${c.reset}         ${i.log} View setup logs`);
  console.log(`    ${c.cyan}eterx env${c.reset}          ${i.env} Show env vars  ${c.dim}(masked)${c.reset}`);
  console.log(`    ${c.cyan}eterx clean${c.reset}        ${i.clean} Clear caches`);
  console.log(`    ${c.cyan}eterx uninstall${c.reset}    ${i.uninstall} Remove EterX`);
  console.log();
  console.log(`  ${c.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`  ${c.dim}${i.arrow} Quick: ${c.reset}${c.bold}eterx start${c.reset}${c.dim} to launch${c.reset}\n`);
}

function showHelp() { showInteractiveMenu(); }

function showVersion() {
  const ver = getVersion();
  let hash = '';
  try { hash = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch {}
  console.log(`\n  ${c.brightCyan}${c.bold}EterX${c.reset} v${ver}${hash ? ` ${c.dim}(${hash})${c.reset}` : ''}`);
  console.log(`  ${c.dim}Node ${process.version} | ${os.platform()} ${os.arch()}${c.reset}\n`);
}

// ═══════════════════════════════════════════
//  Open in Browser
// ═══════════════════════════════════════════
function openInBrowser() {
  const port = 3000;
  const url = `http://localhost:${port}`;

  // Check if server is running
  const http = require('http');
  const req = http.get(url, (res) => {
    res.resume();
    console.log(`\n  ${c.brightGreen}${i.check}${c.reset} Server is running. Opening ${c.cyan}${url}${c.reset}...\n`);
    const open = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { execSync(`${open} ${url}`, { stdio: 'ignore' }); } catch {}
  });
  req.on('error', () => {
    console.log(`\n  ${c.brightYellow}${i.warn}${c.reset} Server not running on port ${port}.`);
    console.log(`  ${c.dim}Start it first: ${c.reset}${c.bold}eterx start${c.reset}\n`);
  });
  req.end();
}

// ═══════════════════════════════════════════
//  Doctor
// ═══════════════════════════════════════════
function runDoctor() {
  console.log(MINI_BANNER);
  console.log(`  ${c.bold}${c.brightCyan}  ━━━ ${i.doctor} EterX Doctor ━━━${c.reset}\n`);
  const { runDoctor: doctor } = require('./setup/doctor');
  doctor(ROOT);
}

// ═══════════════════════════════════════════
//  Benchmark
// ═══════════════════════════════════════════
function runBenchmark() {
  console.log(MINI_BANNER);
  console.log(`  ${c.bold}${c.brightCyan}  ━━━ ${i.speed} Provider Speed Test ━━━${c.reset}\n`);
  const { runBenchmark: bench } = require('./setup/benchmark');
  bench(ROOT);
}

// ═══════════════════════════════════════════
//  Providers
// ═══════════════════════════════════════════
function runProviders() {
  console.log(MINI_BANNER);
  console.log(`  ${c.bold}${c.brightCyan}  ━━━ ${i.model} Provider Registry ━━━${c.reset}\n`);
  const { listProviders } = require('./setup/provider-manager');
  listProviders(ROOT);
}

// ═══════════════════════════════════════════
//  Logs
// ═══════════════════════════════════════════
function showLogs() {
  console.log(MINI_BANNER);
  console.log(`  ${c.bold}${c.brightCyan}  ━━━ ${i.log} EterX Logs ━━━${c.reset}\n`);
  const logPath = path.join(ROOT, '.workspaces', 'setup.log');
  if (!fs.existsSync(logPath)) {
    console.log(`  ${c.brightYellow}${i.warn}${c.reset} No logs found yet.\n`);
    return;
  }
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - 60)).join('\n');
  console.log(tail);
  console.log(`\n  ${c.dim}${i.folder} ${logPath}${c.reset}`);
  console.log(`  ${c.dim}Total: ${lines.length} lines${c.reset}\n`);
}

// ═══════════════════════════════════════════
//  Env
// ═══════════════════════════════════════════
function showEnv() {
  console.log(MINI_BANNER);
  console.log(`  ${c.bold}${c.brightCyan}  ━━━ ${i.env} Environment Variables ━━━${c.reset}\n`);
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) {
    console.log(`  ${c.red}${i.cross}${c.reset} No .env.local found\n`);
    return;
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  let keyCount = 0;
  lines.forEach(l => {
    if (l.startsWith('#') || !l.trim()) {
      console.log(`  ${c.dim}${l}${c.reset}`);
      return;
    }
    if (!l.includes('=')) return;
    const [key, ...rest] = l.split('=');
    const val = rest.join('=');
    const masked = val.length > 8 ? val.slice(0, 4) + '•'.repeat(Math.min(val.length - 8, 20)) + val.slice(-4) : val.length > 0 ? '••••' : `${c.red}(empty)${c.reset}`;
    console.log(`  ${c.cyan}${key.trim().padEnd(28)}${c.reset} ${masked}`);
    if (val) keyCount++;
  });
  console.log(`\n  ${c.dim}${i.key} ${keyCount} keys configured${c.reset}\n`);
}

// ═══════════════════════════════════════════
//  Clean
// ═══════════════════════════════════════════
function runClean() {
  console.log(MINI_BANNER);
  console.log(`  ${c.bold}${c.brightCyan}  ━━━ ${i.clean} Clean Caches ━━━${c.reset}\n`);

  let cleaned = 0;

  const targets = [
    ['.next', 'Next.js build cache'],
    ['tsconfig.tsbuildinfo', 'TypeScript build info'],
    ['.workspaces/workspace_profile.json', 'Workspace profile cache'],
    ['.workspaces/.eterx.lock', 'Stale lock file'],
    ['chunk_log.txt', 'Chunk log'],
    ['chunk_log2.txt', 'Chunk log 2'],
  ];

  for (const [rel, label] of targets) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      console.log(`  ${c.brightGreen}${i.check}${c.reset} ${label}`);
      cleaned++;
    }
  }

  if (cleaned === 0) {
    console.log(`  ${c.brightGreen}${i.check}${c.reset} Already clean ${i.sparkle}`);
  } else {
    console.log(`\n  ${c.brightGreen}${c.bold}${i.sparkle} Cleaned ${cleaned} item(s)${c.reset}`);
  }
  console.log();
}
