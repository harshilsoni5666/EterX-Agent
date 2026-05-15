/**
 * EterX — Interactive Terminal Prompts (zero dependencies)
 */
const readline = require('readline');
const { c } = require('./banner');

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question, defaultVal) {
  const suffix = defaultVal ? ` ${c.dim}(${defaultVal})${c.reset}` : '';
  return new Promise((resolve) => {
    rl.question(`  ${c.cyan}→${c.reset} ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function askSecret(rl, question) {
  return new Promise((resolve) => {
    process.stdout.write(`  ${c.cyan}→${c.reset} ${question}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let input = '';
    const onData = (ch) => {
      const s = ch.toString();
      if (s === '\n' || s === '\r' || s === '\u0004') {
        if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input.trim());
      } else if (s === '\u0003') {
        process.exit(0);
      } else if (s === '\u007F' || s === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += s;
        process.stdout.write('•');
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(rl, question, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(rl, `${question} [${hint}]`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

async function selectOne(rl, title, options) {
  console.log(`\n  ${c.bold}${title}${c.reset}\n`);
  options.forEach((opt, i) => {
    const label = opt.name || opt;
    const desc = opt.description ? ` ${c.dim}— ${opt.description}${c.reset}` : '';
    const tag = opt.required ? ` ${c.yellow}[REQUIRED]${c.reset}` : '';
    console.log(`  ${c.cyan}[${i + 1}]${c.reset} ${label}${tag}${desc}`);
  });
  console.log();

  while (true) {
    const answer = await ask(rl, 'Select');
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= options.length) return { index: num - 1, item: options[num - 1] };
    console.log(`  ${c.red}Invalid. Enter 1-${options.length}${c.reset}`);
  }
}

async function selectMultiple(rl, title, options) {
  console.log(`\n  ${c.bold}${title}${c.reset}`);
  console.log(`  ${c.dim}Enter numbers separated by commas, or "all" / "none"${c.reset}\n`);
  options.forEach((opt, i) => {
    const label = opt.name || opt;
    const desc = opt.description ? ` ${c.dim}— ${opt.description}${c.reset}` : '';
    const tag = opt.required ? ` ${c.green}[INCLUDED]${c.reset}` : '';
    console.log(`  ${c.cyan}[${i + 1}]${c.reset} ${label}${tag}${desc}`);
  });
  console.log();

  const answer = await ask(rl, 'Select providers', 'none');
  if (answer.toLowerCase() === 'all') return options.map((_, i) => i);
  if (answer.toLowerCase() === 'none') return [];

  const indices = answer.split(/[,\s]+/).map(s => parseInt(s, 10) - 1).filter(n => n >= 0 && n < options.length);
  return [...new Set(indices)];
}

async function selectLaunchMode(rl) {
  return selectOne(rl, 'How do you want to run EterX?', [
    { name: 'Web App (Browser)', description: 'Opens at localhost:3000' },
    { name: 'Desktop App (Electron)', description: 'Native window experience' },
    { name: 'Telegram Bot', description: 'Run as Telegram bot' },
    { name: 'Exit (run manually later)', description: 'Just finish setup' },
  ]);
}

module.exports = { createRL, ask, askSecret, confirm, selectOne, selectMultiple, selectLaunchMode };
