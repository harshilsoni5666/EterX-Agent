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

function installProductionDependencies(targetRoot, manifest, label, targetOs = '', targetCpu = '') {
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
  // electron-builder can package multiple target architectures from one
  // runner. Resolve optional/native packages for the artifact being built,
  // rather than silently reusing the runner's architecture (for example an
  // x64 Next SWC binary inside an arm64 Linux or macOS release).
  const resolvedOs = String(targetOs || process.env.ETERX_RUNTIME_OS || '').trim();
  const resolvedCpu = String(targetCpu || process.env.ETERX_RUNTIME_CPU || '').trim();
  if (resolvedOs) npmArguments.push('--os', resolvedOs);
  if (resolvedCpu) npmArguments.push('--cpu', resolvedCpu);
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
const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-desktop-runtime-'));
function runtimeFileFilter(source) {
  const name = path.basename(source);
  return !name.endsWith('.map') && !name.startsWith('.env')
    && !['.git', '.DS_Store', 'Thumbs.db'].includes(name)
    && !/[\\/]\.next[\\/]cache(?:[\\/]|$)/.test(source);
}
for (const runtimeEntry of ['server.js', '.next']) {
  const source = path.join(applicationRoot, runtimeEntry);
  if (!fs.existsSync(source)) continue;
  fs.cpSync(source, path.join(stagingRoot, runtimeEntry), {
    recursive: true,
    force: true,
    filter: runtimeFileFilter,
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

// Electron's macOS utility process does not always rebuild Node's module
// lookup paths from a late environment mutation. Start through a tiny CommonJS
// launcher that explicitly activates the external dependency archive before
// loading Next's standalone server. The same launcher is used by release
// smoke tests and every desktop platform, keeping the tested and real paths
// identical.
fs.writeFileSync(
  path.join(stagingRoot, 'server-launcher.js'),
  `'use strict';\n`
    + `const fs = require('fs');\n`
    + `const path = require('path');\n`
    + `const Module = require('module');\n`
    + `// Never leave the agent runtime alive after its desktop owner exits.\n`
    + `const desktopParentPid = Number(process.env.ETERX_DESKTOP_PARENT_PID);\n`
    + `if (Number.isInteger(desktopParentPid) && desktopParentPid > 0) {\n`
    + `  process.once('disconnect', () => process.exit(0));\n`
    + `  const ownerTimer = setInterval(() => {\n`
    + `    try { process.kill(desktopParentPid, 0); }\n`
    + `    catch (error) { if (error.code === 'ESRCH') process.exit(0); }\n`
    + `  }, 1000);\n`
    + `  ownerTimer.unref();\n`
    + `}\n`
    + `const configuredModulesRoot = String(process.env.ETERX_RUNTIME_MODULES || '').trim();\n`
    + `const packagedModulesRoot = process.resourcesPath\n`
    + `  ? path.join(process.resourcesPath, 'runtime', 'dependencies.asar', 'node_modules')\n`
    + `  : '';\n`
    + `const modulesRoot = [configuredModulesRoot, packagedModulesRoot]\n`
    + `  .find((candidate) => candidate && fs.existsSync(candidate));\n`
    + `if (!modulesRoot) {\n`
    + `  throw new Error('EterX packaged dependency archive is missing or unreadable.');\n`
    + `}\n`
    + `process.env.ETERX_RUNTIME_MODULES = modulesRoot;\n`
    + `process.env.NODE_PATH = [modulesRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);\n`
    + `Module._initPaths();\n`
    + `require.resolve('next/package.json');\n`
    + `require(path.join(__dirname, 'server.js'));\n`,
  'utf8',
);

const staticSource = path.join(repositoryRoot, '.next', 'static');
const staticTarget = path.join(stagingRoot, '.next', 'static');
if (fs.existsSync(staticSource)) {
  fs.mkdirSync(path.dirname(staticTarget), { recursive: true });
  fs.cpSync(staticSource, staticTarget, { recursive: true, force: true, filter: runtimeFileFilter });
}

const publicSource = path.join(repositoryRoot, 'public');
if (fs.existsSync(publicSource)) {
  fs.cpSync(publicSource, path.join(stagingRoot, 'public'), { recursive: true, force: true, filter: runtimeFileFilter });
}

const repositoryPackage = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
// The installed server needs identity and CommonJS semantics, not repository
// scripts, development dependencies, or build configuration.
fs.writeFileSync(path.join(stagingRoot, 'package.json'), `${JSON.stringify({
  name: repositoryPackage.name,
  version: repositoryPackage.version,
  private: true,
  type: 'commonjs',
}, null, 2)}\n`);
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
const stagedModules = path.join(stagingRoot, 'node_modules');
fs.rmSync(stagedModules, { recursive: true, force: true });
const dependencyCopyOptions = {
  recursive: true,
  force: true,
  // npm creates executable shims in nested .bin directories. Some optional
  // packages leave a dangling shim (notably next/node_modules/.bin/nanoid)
  // when npm is resolving a cross-platform production tree; copying that
  // broken link makes Node's fs.cpSync abort before packaging starts. The
  // packaged server never invokes npm lifecycle binaries, so omit every .bin
  // shim directory and retain the actual dependency files and native modules.
  filter: (source) => path.basename(source) !== '.bin' && !/\/node_modules\/node-pty\/build(?:\/|$)/.test(source.replace(/\\/g, '/')),
  verbatimSymlinks: true,
};
const targetSpec = String(process.env.ETERX_RUNTIME_TARGETS || '').trim();
const targetSpecs = targetSpec
  ? targetSpec.split(',').map((entry) => entry.trim()).filter(Boolean)
  : [''];
if (targetSpecs.length === 0) targetSpecs.push('');

// Build one dependency tree per packaged OS/CPU and merge their optional
// platform packages into the shared archive. This keeps electron-builder's
// single multi-arch release metadata intact while ensuring each artifact can
// resolve its native Next/SWC and other optional modules at runtime.
for (const [index, spec] of targetSpecs.entries()) {
  const [targetOs = '', targetCpu = '', ...extra] = spec.split(':').map((part) => part.trim());
  if (extra.length || (targetOs && !/^[a-z0-9_-]+$/i.test(targetOs)) || (targetCpu && !/^[a-z0-9_-]+$/i.test(targetCpu))) {
    throw new Error(`Invalid ETERX_RUNTIME_TARGETS entry: ${spec}`);
  }
  const dependencyInstallRoot = path.join(stagingRoot, `.eterx-production-install-${index}`);
  fs.rmSync(dependencyInstallRoot, { recursive: true, force: true });
  fs.mkdirSync(dependencyInstallRoot, { recursive: true });
  fs.writeFileSync(
    path.join(dependencyInstallRoot, 'package-lock.json'),
    `${JSON.stringify(lockfile, null, 2)}\n`,
    'utf8',
  );
  installProductionDependencies(
    dependencyInstallRoot,
    { ...repositoryPackage, scripts: {} },
    spec ? `the complete EterX production runtime (${targetOs}/${targetCpu})` : 'the complete EterX production runtime',
    targetOs,
    targetCpu,
  );
  const installedModules = path.join(dependencyInstallRoot, 'node_modules');
  const ptyOs = targetOs || process.env.ETERX_RUNTIME_OS || process.platform;
  const ptyCpu = targetCpu || process.env.ETERX_RUNTIME_CPU || process.arch;
  const ptyRoot = path.join(installedModules, 'node-pty');
  const ptyPrebuild = path.join(ptyRoot, 'prebuilds', `${ptyOs}-${ptyCpu}`);
  const ptyNative = path.join(ptyPrebuild, ptyOs === 'win32' ? 'conpty.node' : 'pty.node');
  if (!fs.existsSync(ptyNative)) {
    if (ptyOs !== process.platform || ptyCpu !== process.arch) {
      throw new Error(`node-pty needs a native ${ptyOs}/${ptyCpu} build runner. Build this target on its matching OS and architecture.`);
    }
    const rebuildArguments = ['rebuild', 'node-pty', '--ignore-scripts=false', '--no-audit', '--fund=false'];
    if (npmExecPath) rebuildArguments.unshift(npmExecPath);
    const rebuilt = spawnSync(npmCommand, rebuildArguments, { cwd: dependencyInstallRoot, stdio: 'inherit', shell: false, windowsHide: true, env: { ...process.env, npm_config_build_from_source: 'true' } });
    if (rebuilt.status !== 0) throw new Error('Could not compile the packaged terminal runtime.');
    fs.mkdirSync(ptyPrebuild, { recursive: true });
    fs.cpSync(path.join(ptyRoot, 'build', 'Release'), ptyPrebuild, { recursive: true });
  }
  if (!fs.existsSync(ptyNative)) throw new Error(`Missing terminal binary for ${ptyOs}/${ptyCpu}.`);
  if (ptyOs !== 'win32') {
    const helper = path.join(ptyPrebuild, 'spawn-helper');
    if (!fs.existsSync(helper)) throw new Error(`Missing terminal spawn-helper for ${ptyOs}/${ptyCpu}.`);
    fs.chmodSync(helper, 0o755);
  }
  fs.cpSync(installedModules, stagedModules, dependencyCopyOptions);
  // These modules are loaded by Electron's main process before the Next
  // server starts. Fail the build if the production archive would not contain
  // them; otherwise users receive an installer that crashes on first launch.
  for (const requiredModule of ['next', 'react', 'react-dom', 'ws']) {
    const moduleManifest = path.join(stagedModules, requiredModule, 'package.json');
    if (!fs.existsSync(moduleManifest)) {
      throw new Error(`Required packaged dependency is missing: ${requiredModule}`);
    }
  }
  fs.rmSync(dependencyInstallRoot, { recursive: true, force: true });
}
fs.rmSync(path.join(stagingRoot, 'node_modules', '.bin'), { recursive: true, force: true });

const assetsRoot = path.join(stagingRoot, 'assets');
fs.cpSync(
  path.join(repositoryRoot, 'src', 'lib', 'agent', 'gateways'),
  path.join(assetsRoot, 'gateways'),
  { recursive: true, filter: (source) => fs.statSync(source).isDirectory() || source.endsWith('.cjs') },
);
const sourceSkillsRoot = path.join(repositoryRoot, 'src', 'lib', 'agent', 'skills-new');
const generatedSkillsRoot = path.join(repositoryRoot, 'desktop-runtime', 'assets', 'skills');
const skillsRoot = fs.existsSync(path.join(sourceSkillsRoot, 'docx_skill.md'))
  ? sourceSkillsRoot
  : generatedSkillsRoot;
if (!fs.existsSync(skillsRoot)) {
  throw new Error('The desktop runtime skill bundle is missing. Restore src/lib/agent/skills-new or desktop-runtime/assets/skills.');
}
fs.cpSync(
  skillsRoot,
  path.join(assetsRoot, 'skills'),
  { recursive: true, force: true },
);
fs.cpSync(
  path.join(repositoryRoot, 'src', 'lib', 'agent', 'browser', 'extension'),
  path.join(assetsRoot, 'browser-extension'),
  { recursive: true, force: true },
);

const whisperRuntimeRoot = path.join(repositoryRoot, 'desktop-runtime', 'assets', 'native', 'whisper');
if (!fs.existsSync(whisperRuntimeRoot)) {
  throw new Error('The whisper.cpp runtime is missing. Run npm run desktop:prepare-whisper first.');
}
fs.cpSync(
  whisperRuntimeRoot,
  path.join(assetsRoot, 'native', 'whisper'),
  { recursive: true, force: true },
);

if (process.platform === 'win32') {
  const windowsRoot = String(process.env.WINDIR || 'C:\\Windows');
  const compiler = path.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
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
  unpackDir: '**/node-pty',
});
fs.rmSync(sourceModules, { recursive: true, force: true });

const required = [
  'server.js',
  'server-launcher.js',
  'dependencies.asar',
  path.join('assets', 'skills'),
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
try {
  // Windows antivirus/indexer processes can briefly hold a freshly-created
  // staging child after the copy completes. Cleanup is non-functional: the
  // runner removes its temp directory after the job, so never fail a valid
  // packaged runtime only because this best-effort deletion raced a lock.
  fs.rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
} catch (error) {
  console.warn(`[EterX build] Temporary staging cleanup deferred: ${error.message || error}`);
}
console.log(`[EterX build] Desktop runtime prepared at ${runtimeRoot}`);
