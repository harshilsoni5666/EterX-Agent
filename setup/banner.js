/**
 * EterX Terminal UI — Enterprise-Grade Console Output
 * Rich icons, progress bars, section dividers, animated spinners, and color theming.
 */

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m', underline: '\x1b[4m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  bgBlue: '\x1b[44m', bgMagenta: '\x1b[45m', bgCyan: '\x1b[46m', bgGreen: '\x1b[42m',
  gray: '\x1b[90m', brightCyan: '\x1b[96m', brightGreen: '\x1b[92m', brightYellow: '\x1b[93m',
  brightMagenta: '\x1b[95m', brightWhite: '\x1b[97m',
};

for (const stream of [process.stdout, process.stderr]) {
  if (!stream || stream.__eterxPipeGuarded) continue;
  stream.__eterxPipeGuarded = true;
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

function writeOut(text) {
  try {
    process.stdout.write(text);
  } catch (err) {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  }
}

// ── Icons ──
const icons = {
  check: '✔', cross: '✖', warn: '⚠', info: 'ℹ', arrow: '→', bullet: '●',
  star: '★', lightning: '⚡', gear: '⚙', key: '🔑', lock: '🔒', unlock: '🔓',
  rocket: '🚀', globe: '🌐', disk: '💾', folder: '📁', file: '📄', terminal: '💻',
  brain: '🧠', link: '🔗', shield: '🛡️', chart: '📊', clock: '🕐', sparkle: '✨',
  package: '📦', search: '🔍', wrench: '🔧', fire: '🔥', trophy: '🏆',
  party: '🎉', heart: '❤️', diamond: '💎', bolt: '⚡', pin: '📌',
  send: '📤', receive: '📥', refresh: '🔄', trash: '🗑️', tools: '🛠️',
  api: '🔌', model: '🤖', speed: '⏱️', health: '💊', doctor: '🩺',
};

const BANNER = `
${c.brightCyan}${c.bold}
    ███████╗████████╗███████╗██████╗ ██╗  ██╗
    ██╔════╝╚══██╔══╝██╔════╝██╔══██╗╚██╗██╔╝
    █████╗     ██║   █████╗  ██████╔╝ ╚███╔╝ 
    ██╔══╝     ██║   ██╔══╝  ██╔══██╗ ██╔██╗ 
    ███████╗   ██║   ███████╗██║  ██║██╔╝ ██╗
    ╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝
${c.reset}
${c.brightMagenta}${c.bold}    ${icons.lightning} The Autonomous AI Agent System${c.reset}
${c.dim}    Built by Harshil Soni ${icons.diamond}${c.reset}
`;

function showBanner() {
  console.clear();
  console.log(BANNER);
  console.log(`${c.gray}${'━'.repeat(52)}${c.reset}\n`);
}

function ok(msg) { console.log(`  ${c.brightGreen}${icons.check}${c.reset} ${msg}`); }
function warn(msg) { console.log(`  ${c.brightYellow}${icons.warn}${c.reset} ${msg}`); }
function fail(msg) { console.log(`  ${c.red}${icons.cross}${c.reset} ${msg}`); }
function info(msg) { console.log(`  ${c.cyan}${icons.info}${c.reset} ${msg}`); }
function step(msg) { console.log(`\n${c.bold}${c.brightCyan}  ━━━ ${msg} ━━━${c.reset}\n`); }
function header(msg) { console.log(`\n${c.bold}${c.brightMagenta}  ${msg}${c.reset}`); }
function line() { console.log(`${c.gray}  ${'─'.repeat(48)}${c.reset}`); }
function doubleLine() { console.log(`${c.gray}  ${'═'.repeat(48)}${c.reset}`); }

function label(icon, text) {
  console.log(`  ${icon} ${c.bold}${text}${c.reset}`);
}

function keyValue(key, value, keyWidth = 28) {
  console.log(`  ${c.cyan}${key.padEnd(keyWidth)}${c.reset} ${value}`);
}

function spinner(msg) {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const animated = !!process.stdout.isTTY && process.env.CI !== 'true';
  if (!animated) {
    console.log(`  ${c.cyan}${icons.info}${c.reset} ${msg}`);
  }
  const id = animated ? setInterval(() => {
    writeOut(`\r  ${c.cyan}${frames[i++ % frames.length]}${c.reset} ${msg}`);
  }, 80) : null;
  return {
    stop(finalMsg) {
      if (id) clearInterval(id);
      writeOut(`${animated ? '\r' : ''}  ${c.brightGreen}${icons.check}${c.reset} ${finalMsg || msg}${animated ? ' '.repeat(20) : ''}\n`);
    },
    fail(finalMsg) {
      if (id) clearInterval(id);
      writeOut(`${animated ? '\r' : ''}  ${c.red}${icons.cross}${c.reset} ${finalMsg || msg}${animated ? ' '.repeat(20) : ''}\n`);
    },
    update(newMsg) {
      msg = newMsg;
    }
  };
}

function progressBar(current, total, width = 30) {
  const pct = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const bar = `${c.brightGreen}${'█'.repeat(filled)}${c.gray}${'░'.repeat(empty)}${c.reset}`;
  return `${bar} ${c.bold}${pct}%${c.reset}`;
}

function boxMessage(title, lines) {
  const maxLen = Math.max(title.length, ...lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, '').length));
  const w = maxLen + 4;
  console.log(`  ${c.cyan}╔${'═'.repeat(w)}╗${c.reset}`);
  console.log(`  ${c.cyan}║${c.reset}  ${c.bold}${title.padEnd(w - 2)}${c.reset}${c.cyan}║${c.reset}`);
  console.log(`  ${c.cyan}╠${'═'.repeat(w)}╣${c.reset}`);
  for (const l of lines) {
    const plainLen = l.replace(/\x1b\[[0-9;]*m/g, '').length;
    const pad = w - 2 - plainLen;
    console.log(`  ${c.cyan}║${c.reset}  ${l}${' '.repeat(Math.max(0, pad))}${c.cyan}║${c.reset}`);
  }
  console.log(`  ${c.cyan}╚${'═'.repeat(w)}╝${c.reset}`);
}

function successBox(msg) {
  console.log(`\n  ${c.bgGreen}${c.bold}${c.white}  ${icons.check} ${msg}  ${c.reset}\n`);
}

function errorBox(msg) {
  console.log(`\n  ${c.red}${c.bold}  ${icons.cross} ${msg}  ${c.reset}\n`);
}

module.exports = {
  c, icons, showBanner, ok, warn, fail, info, step, header, line, doubleLine,
  label, keyValue, spinner, progressBar, boxMessage, successBox, errorBox,
};
