/**
 * EterX — Doctor (Deep Diagnostics)
 * 40+ checks across system, files, deps, env, network, agent core, and build.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ok, warn, fail, info, spinner, c, icons, step, header, line, doubleLine, successBox, errorBox, boxMessage } = require('./banner');
const { checkNodeVersion, checkGit, checkPort, getDiskFreeGB } = require('./detect');

function runTypeScriptCheck(projectRoot) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npx tsc --noEmit --pretty false']
    : ['tsc', '--noEmit', '--pretty', 'false'];
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  return {
    ok: result.status === 0,
    timedOut: result.error && result.error.code === 'ETIMEDOUT',
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    error: result.error,
  };
}

function runNpmPlanCheck(projectRoot) {
  const hasLockfile = fs.existsSync(path.join(projectRoot, 'package-lock.json'));
  const npmArgs = hasLockfile
    ? ['ci', '--dry-run', '--legacy-peer-deps']
    : ['install', '--dry-run', '--legacy-peer-deps'];
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`]
    : npmArgs;
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 90000,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  return {
    label: `npm ${npmArgs.join(' ')}`,
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    timedOut: result.error && result.error.code === 'ETIMEDOUT',
  };
}

async function runDoctor(projectRoot) {
  let issues = 0;
  let warnings = 0;
  let passed = 0;

  const check = (name, condition, fixHint) => {
    if (condition) { ok(name); passed++; }
    else { fail(`${name} ${c.dim}→ Fix: ${fixHint}${c.reset}`); issues++; }
  };

  const softCheck = (name, condition, hint) => {
    if (condition) { ok(name); passed++; }
    else { warn(`${name} ${c.dim}→ ${hint}${c.reset}`); warnings++; }
  };

  // ═══ SYSTEM ═══
  header(`${icons.terminal} System`);

  const node = checkNodeVersion();
  check('Node.js 18+', node.installed && node.major >= 18, 'Install from https://nodejs.org');
  softCheck('Node.js 20+ (recommended)', node.major >= 20, 'Upgrade for best performance');

  const git = checkGit();
  softCheck('Git installed', git.installed, 'Install from https://git-scm.com');

  const ram = os.totalmem() / (1024 ** 3);
  check(`RAM ≥ 4 GB (${ram.toFixed(1)} GB)`, ram >= 4, 'EterX needs at least 4 GB');
  softCheck(`RAM ≥ 8 GB (${ram.toFixed(1)} GB)`, ram >= 8, 'More RAM = better agent perf');

  const diskGB = getDiskFreeGB(projectRoot);
  if (diskGB > 0) check(`Disk space ≥ 2 GB (${diskGB.toFixed(1)} GB free)`, diskGB >= 2, 'Free up disk space');

  // ═══ PROJECT FILES ═══
  header(`${icons.folder} Project Files`);

  const criticalFiles = [
    ['package.json', 'Re-clone the repository'],
    ['node_modules', 'Run: eterx repair'],
    ['.env.local', 'Run: eterx setup'],
    ['next.config.mjs', 'Re-clone the repository'],
    ['electron/main.js', 'Re-clone the repository'],
  ];

  for (const [file, fix] of criticalFiles) {
    check(file, fs.existsSync(path.join(projectRoot, file)), fix);
  }

  const optionalFiles = [
    ['tsconfig.json', 'TypeScript config missing'],
    ['.workspaces', 'Run: eterx setup'],
    ['public/logo.png', 'Logo file missing'],
    ['banner.png', 'Banner file missing'],
    ['setup.js', 'Installer missing — re-clone'],
    ['eterx.js', 'CLI entry missing — re-clone'],
    ['setup/providers.js', 'Provider registry missing'],
    ['setup/launcher.js', 'Launcher missing'],
  ];

  for (const [file, hint] of optionalFiles) {
    softCheck(file, fs.existsSync(path.join(projectRoot, file)), hint);
  }

  // ═══ DEPENDENCIES ═══
  header(`${icons.package} Dependencies`);

  const criticalDeps = [
    'next', 'react', 'react-dom', '@google/genai', 'openai',
    '@anthropic-ai/sdk', 'zustand', 'zod', 'groq-sdk', '@tavily/core',
  ];
  for (const dep of criticalDeps) {
    check(dep, fs.existsSync(path.join(projectRoot, 'node_modules', dep)), `npm install ${dep}`);
  }

  softCheck('package-lock.json', fs.existsSync(path.join(projectRoot, 'package-lock.json')), 'npm install to generate');
  const npmPlan = runNpmPlanCheck(projectRoot);
  softCheck(`${npmPlan.label} works`, npmPlan.ok, npmPlan.timedOut ? 'Dependency dry-run timed out' : 'Review npm output');
  if (!npmPlan.ok && npmPlan.output) {
    npmPlan.output.split(/\r?\n/).filter(Boolean).slice(0, 6).forEach((lineText) => {
      console.log(`  ${c.dim}${lineText}${c.reset}`);
    });
  }

  // ═══ ENVIRONMENT ═══
  header(`${icons.key} Environment Variables`);

  const envPath = path.join(projectRoot, '.env.local');
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    const vars = {};
    env.split('\n').forEach(l => {
      if (l.startsWith('#') || !l.includes('=')) return;
      const [k, ...rest] = l.split('=');
      vars[k.trim()] = rest.join('=').trim();
    });

    check(`${icons.key} GEMINI_API_KEY`, !!(vars.GEMINI_API_KEY || vars.GEMINI_API_KEY_1), 'eterx config');

    const geminiCount = Object.keys(vars).filter(k => k.startsWith('GEMINI_API_KEY')).filter(k => vars[k]).length;
    info(`${icons.lock} Gemini pool: ${geminiCount} keys`);

    softCheck(`${icons.search} TAVILY_API_KEY`, !!(vars.TAVILY_API_KEY_1 || vars.TAVILY_API_KEY), 'No web search');
    softCheck(`${icons.speed} GROQ_API_KEY`, !!vars.GROQ_API_KEY, 'Optional fast inference');

    const emptyKeys = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
    if (emptyKeys.length > 0) {
      warn(`${emptyKeys.length} empty key(s): ${emptyKeys.slice(0, 3).join(', ')}`);
      warnings++;
    }

    const totalKeys = Object.entries(vars).filter(([, v]) => v).length;
    info(`${icons.shield} ${totalKeys} total keys configured`);
  }

  // ═══ NETWORK ═══
  header(`${icons.globe} Network`);

  const port3000Busy = checkPort(3000);
  if (port3000Busy) {
    warn('Port 3000 in use → auto-find enabled');
    warnings++;
  } else {
    ok('Port 3000 is free');
    passed++;
  }

  // ═══ AGENT CORE ═══
  header(`${icons.brain} Agent Core`);

  const agentFiles = [
    'src/lib/agent/gemini.ts',
    'src/lib/agent/engines.ts',
    'src/lib/agent/memory.ts',
    'src/lib/agent/session.ts',
    'src/lib/agent/schemas.ts',
    'src/lib/agent/tools/index.ts',
    'src/lib/agent/tools/registry.ts',
    'src/app/page.tsx',
    'src/app/layout.tsx',
    'src/app/globals.css',
  ];

  for (const file of agentFiles) {
    check(path.basename(file), fs.existsSync(path.join(projectRoot, file)), 'Missing core file');
  }

  // ═══ MEMORY ═══
  header(`${icons.disk} Memory System`);

  const memoryFiles = [
    ['.workspaces/memory', 'Memory directory'],
    ['.workspaces/config/eterx.config.json', 'App config'],
    ['.workspaces/dynamic_tools', 'Dynamic tools dir'],
  ];

  for (const [file, label] of memoryFiles) {
    softCheck(label, fs.existsSync(path.join(projectRoot, file)), 'eterx setup to create');
  }

  // ═══ BUILD ═══
  header(`${icons.gear} Build`);

  softCheck('Next.js build cache', fs.existsSync(path.join(projectRoot, '.next')), 'First run will be slower');

  const s = spinner('Checking TypeScript...');
  const ts = runTypeScriptCheck(projectRoot);
  if (ts.ok) {
    s.stop('No TypeScript errors');
    passed++;
  } else if (ts.timedOut) {
    s.fail('TypeScript check timed out after 60s');
    warnings++;
  } else {
    s.fail('TypeScript check found issues');
    const errorCount = (ts.output.match(/error TS/g) || []).length;
    warn(`${errorCount || 'Some'} TypeScript error(s)`);
    ts.output.split(/\r?\n/).filter(Boolean).slice(0, 8).forEach((lineText) => {
      console.log(`  ${c.dim}${lineText}${c.reset}`);
    });
    warnings++;
  }

  // ═══ SUMMARY ═══
  doubleLine();
  console.log();

  const total = passed + warnings + issues;
  const score = Math.round((passed / total) * 100);

  boxMessage(`${icons.doctor} Doctor Summary`, [
    `${c.brightGreen}${icons.check} ${passed} passed${c.reset}`,
    warnings > 0 ? `${c.brightYellow}${icons.warn} ${warnings} warnings${c.reset}` : '',
    issues > 0 ? `${c.red}${icons.cross} ${issues} issues${c.reset}` : '',
    '',
    `Health Score: ${score >= 90 ? c.brightGreen : score >= 70 ? c.brightYellow : c.red}${score}%${c.reset}`,
  ].filter(Boolean));

  console.log();

  if (issues === 0 && warnings === 0) {
    successBox(`${icons.party} EterX is in perfect health!`);
  } else if (issues === 0) {
    console.log(`  ${c.brightGreen}${c.bold}${icons.check} EterX is healthy${c.reset} ${c.dim}(minor warnings)${c.reset}\n`);
  } else {
    errorBox(`${issues} issue(s) need attention`);
    console.log(`  ${c.dim}Run ${c.bold}eterx repair${c.reset}${c.dim} to fix common problems${c.reset}\n`);
  }

  return { passed, warnings, issues, score };
}

module.exports = { runDoctor };
