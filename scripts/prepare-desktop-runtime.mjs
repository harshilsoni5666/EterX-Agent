import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createPackageWithOptions } = require('@electron/asar');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const standaloneRoot = path.join(repositoryRoot, '.next', 'standalone');
const runtimeRoot = path.join(repositoryRoot, 'desktop-runtime');
const npmExecPath = String(process.env.npm_execpath || '').trim();
const npmCommand = npmExecPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');

function installProductionDependencies(targetRoot, manifest, label) {
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const npmArguments = [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--legacy-peer-deps',
    '--no-audit',
    '--fund=false',
    '--package-lock=false',
  ];
  if (npmExecPath) npmArguments.unshift(npmExecPath);
  const result = spawnSync(npmCommand, npmArguments, {
    cwd: targetRoot,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (result.status !== 0) {
    throw new Error(`Could not prepare ${label} (exit ${result.status ?? 'unknown'}).`);
  }
}

function findStandaloneServer(root) {
  const direct = path.join(root, 'server.js');
  if (fs.existsSync(direct)) return root;

  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (fs.existsSync(path.join(child, 'server.js'))) return child;
      queue.push(child);
    }
  }
  return null;
}

if (!fs.existsSync(standaloneRoot)) {
  throw new Error('The Next.js standalone build is missing. Run the production build first.');
}

const applicationRoot = findStandaloneServer(standaloneRoot);
if (!applicationRoot) {
  throw new Error('The standalone build does not contain server.js.');
}

// Keep packaging intermediates outside the repository. Next.js and TypeScript
// intentionally scan the project tree, so an interrupted in-repo staging copy
// can otherwise be mistaken for application source during the next build.
const stagingRoot = path.join(os.tmpdir(), `eterx-desktop-runtime-${process.pid}`);
fs.rmSync(stagingRoot, { recursive: true, force: true });
fs.mkdirSync(stagingRoot, { recursive: true });
for (const runtimeEntry of ['server.js', 'package.json', '.next']) {
  const source = path.join(applicationRoot, runtimeEntry);
  if (!fs.existsSync(source)) continue;
  fs.cpSync(source, path.join(stagingRoot, runtimeEntry), {
    recursive: true,
    force: true,
  });
}

const serverPath = path.join(stagingRoot, 'server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');
fs.writeFileSync(
  serverPath,
  serverSource.replace(
    'process.chdir(__dirname)',
    "if (!process.env.ETERX_DATA_DIR) process.chdir(__dirname)",
  ),
  'utf8',
);

const staticSource = path.join(repositoryRoot, '.next', 'static');
const staticTarget = path.join(stagingRoot, '.next', 'static');
if (fs.existsSync(staticSource)) {
  fs.mkdirSync(path.dirname(staticTarget), { recursive: true });
  fs.cpSync(staticSource, staticTarget, { recursive: true, force: true });
}

const publicSource = path.join(repositoryRoot, 'public');
if (fs.existsSync(publicSource)) {
  fs.cpSync(publicSource, path.join(stagingRoot, 'public'), { recursive: true, force: true });
}

const repositoryPackage = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const lockfile = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
);
const productionDependencies = Object.fromEntries(
  Object.keys(repositoryPackage.dependencies || {}).map((name) => {
    const lockedPackage = lockfile.packages?.[`node_modules/${name}`];
    if (!lockedPackage?.version) {
      throw new Error(`Production dependency ${name} is not locked in package-lock.json.`);
    }
    return [name, lockedPackage.version];
  }),
);
const dependencyInstallRoot = path.join(stagingRoot, '.eterx-production-install');
fs.mkdirSync(dependencyInstallRoot, { recursive: true });
fs.writeFileSync(
  path.join(dependencyInstallRoot, 'package-lock.json'),
  `${JSON.stringify(lockfile, null, 2)}\n`,
  'utf8',
);
installProductionDependencies(dependencyInstallRoot, {
  ...repositoryPackage,
  scripts: {},
}, 'the complete EterX production runtime');
const installedModules = path.join(dependencyInstallRoot, 'node_modules');
const stagedModules = path.join(stagingRoot, 'node_modules');
fs.rmSync(stagedModules, { recursive: true, force: true });
fs.cpSync(installedModules, stagedModules, { recursive: true, force: true });
fs.rmSync(installedModules, { recursive: true, force: true });
fs.rmSync(path.join(stagingRoot, 'node_modules', '.bin'), { recursive: true, force: true });
fs.rmSync(dependencyInstallRoot, { recursive: true, force: true });

const assetsRoot = path.join(stagingRoot, 'assets');
fs.cpSync(
  path.join(repositoryRoot, 'src', 'lib', 'agent', 'skills'),
  path.join(assetsRoot, 'skills'),
  { recursive: true, force: true },
);
fs.cpSync(
  path.join(repositoryRoot, 'coding-agent', 'eterx-agent-reference', 'prompts'),
  path.join(assetsRoot, 'agent-prompts', 'prompts'),
  { recursive: true, force: true },
);
fs.cpSync(
  path.join(repositoryRoot, 'src', 'lib', 'agent', 'browser', 'extension'),
  path.join(assetsRoot, 'browser-extension'),
  { recursive: true, force: true },
);

if (process.platform === 'win32') {
  const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const nativeRoot = path.join(assetsRoot, 'native', 'win');
  fs.mkdirSync(nativeRoot, { recursive: true });
  const nativePrograms = [
    {
      source: path.join(repositoryRoot, 'src', 'lib', 'agent', 'computer', 'EterXManagedComputer.cs'),
      output: path.join(nativeRoot, 'EterXManagedComputer.exe'),
      references: ['System.Drawing.dll'],
    },
    {
      source: path.join(repositoryRoot, 'src', 'lib', 'agent', 'computer', 'EterXScreenStream.cs'),
      output: path.join(nativeRoot, 'EterXScreenStream.exe'),
      references: ['System.Windows.Forms.dll', 'System.Drawing.dll'],
    },
  ];
  for (const nativeProgram of nativePrograms) {
    const compile = spawnSync(compiler, [
      '/nologo',
      '/target:exe',
      ...nativeProgram.references.map((reference) => `/r:${reference}`),
      `/out:${nativeProgram.output}`,
      nativeProgram.source,
    ], { stdio: 'inherit', shell: false });
    if (compile.status !== 0) {
      throw new Error(`Could not compile ${path.basename(nativeProgram.output)} (exit ${compile.status ?? 'unknown'}).`);
    }
  }
}

// Preserve npm's exact nested dependency hierarchy in its own ASAR. Electron
// Builder otherwise filters directories named node_modules at any depth,
// flattening incompatible transitive versions. Native binaries are emitted to
// the companion .unpacked directory for Electron's process.dlopen/spawn APIs.
const sourceModules = path.join(stagingRoot, 'node_modules');
const dependencyArchive = path.join(stagingRoot, 'dependencies.asar');
await createPackageWithOptions(stagingRoot, dependencyArchive, {
  dot: true,
  pattern: '/node_modules/**/*',
  unpack: '**/*.{node,dll,exe,so,dylib}',
});
fs.rmSync(sourceModules, { recursive: true, force: true });

const required = [
  'server.js',
  'dependencies.asar',
  path.join('assets', 'skills'),
  path.join('assets', 'agent-prompts', 'prompts'),
  path.join('.next', 'BUILD_ID'),
  path.join('.next', 'server', 'app-paths-manifest.json'),
];
for (const relativePath of required) {
  if (!fs.existsSync(path.join(stagingRoot, relativePath))) {
    throw new Error(`Desktop runtime is incomplete: ${relativePath} is missing.`);
  }
}

fs.writeFileSync(
  path.join(stagingRoot, 'eterx-runtime.json'),
  `${JSON.stringify({
    schema: 1,
    appVersion: JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`,
  'utf8',
);

fs.rmSync(runtimeRoot, { recursive: true, force: true });
fs.cpSync(stagingRoot, runtimeRoot, { recursive: true, force: true });
fs.rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
console.log(`[EterX build] Desktop runtime prepared at ${runtimeRoot}`);
