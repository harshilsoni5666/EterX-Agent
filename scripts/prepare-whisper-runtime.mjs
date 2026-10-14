import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const { DEFAULT_MODEL, RUNTIME_REVISION, getModel } = require('../electron/whisper-config');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(repositoryRoot, 'desktop-runtime', 'assets', 'native', 'whisper');
const releaseTag = 'b4938';
const sourceHash = '6d8d70a014ca2b10f8a6d006b8f423e5f5ef2afcfbe92b57ab4e01107238112a';
const supportedTargets = new Set(['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);
const buildFromSource = /^(1|true)$/i.test(String(process.env.ETERX_WHISPER_BUILD_FROM_SOURCE || ''));
const releaseAssets = {
  'win32-x64': {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${releaseTag}/whisper-bin-x64.zip`,
    bytes: 8361840,
    sha256: 'c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d',
  },
};

function runtimeKind(target) {
  return !buildFromSource && releaseAssets[target] ? 'release-asset' : 'source';
}

function targetKeys() {
  const configured = String(process.env.ETERX_RUNTIME_TARGETS || '').trim();
  const targets = [...new Set((configured ? configured.split(',') : [`${process.platform}:${process.arch}`])
    .map(value => value.trim().replace(':', '-')).filter(Boolean))];
  for (const target of targets) {
    if (!supportedTargets.has(target)) throw new Error(`Unsupported speech runtime target: ${target}`);
    if (!target.startsWith(`${process.platform}-`)) throw new Error(`Prepare ${target} on a ${target.split('-')[0]} build runner.`);
  }
  return targets;
}

function executableName(platform) {
  return platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
}

function runtimeReady(target) {
  const directory = path.join(outputRoot, target);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
    return manifest.revision === RUNTIME_REVISION && manifest.target === target
      && (manifest.kind || 'source') === runtimeKind(target)
      && Array.isArray(manifest.files) && manifest.files.includes(executableName(target.split('-')[0]))
      && manifest.files.every(name => path.basename(name) === name && fs.statSync(path.join(directory, name)).size > 0);
  } catch {
    return false;
  }
}

async function downloadVerified(url, sha256, destination, expectedBytes) {
  const controller = new AbortController();
  let timer;
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('Speech runtime download stalled. Retry the preparation command.')), 90_000);
    timer.unref?.();
  };
  progress();
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Could not download speech runtime (${response.status}).`);
    const hash = crypto.createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        progress();
        received += chunk.length;
        if (expectedBytes && received > expectedBytes) return callback(new Error('Speech download has an unexpected size.'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(response.body, meter, fs.createWriteStream(destination), { signal: controller.signal });
    if ((expectedBytes && received !== expectedBytes) || hash.digest('hex') !== sha256) throw new Error('The speech download did not match its pinned checksum.');
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fileMatches(filePath, model) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size !== model.bytes) return false;
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex') === model.sha256;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error || result.status !== 0) throw new Error(`${label}: ${result.error?.message || `exit ${result.status}`}`);
}

function copyRuntimeFiles(sourceRoot, destination, platform) {
  fs.mkdirSync(destination, { recursive: true });
  const serverName = executableName(platform);
  const queue = [sourceRoot];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const source = path.join(current, entry.name);
      if (entry.isDirectory()) { queue.push(source); continue; }
      const name = entry.name;
      const needed = name === serverName
        || /^LICENSE(?:\.txt)?$/i.test(name)
        || (platform === 'win32' && /\.dll$/i.test(name))
        || (platform === 'linux' && /\.so(?:\.|$)/i.test(name))
        || (platform === 'darwin' && /\.(?:dylib|metal|metallib)$/i.test(name));
      // Dereference versioned library symlinks for ZIP installers and migration.
      if (needed) fs.copyFileSync(source, path.join(destination, name));
    }
  }
  if (!fs.existsSync(path.join(destination, serverName))) throw new Error(`The ${platform} speech build did not produce ${serverName}.`);
  if (platform !== 'win32') fs.chmodSync(path.join(destination, serverName), 0o755);
}

function installRuntime(staging, target, kind) {
  const destination = path.resolve(outputRoot, target);
  if (!supportedTargets.has(target) || path.dirname(destination) !== path.resolve(outputRoot)) {
    throw new Error(`Invalid speech runtime destination: ${target}`);
  }
  const files = fs.readdirSync(staging).filter(name => name !== 'runtime.json');
  fs.writeFileSync(path.join(staging, 'runtime.json'), JSON.stringify({ revision: RUNTIME_REVISION, target, kind, files }, null, 2));
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(staging, destination, { recursive: true });
}

async function prepareReleaseRuntime(target) {
  const asset = releaseAssets[target];
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-whisper-release-'));
  try {
    console.log(`Downloading the prebuilt whisper.cpp ${releaseTag} runtime for ${target}…`);
    const archive = path.join(temporaryRoot, 'runtime.zip');
    await downloadVerified(asset.url, asset.sha256, archive, asset.bytes);
    const extracted = path.join(temporaryRoot, 'extracted');
    new AdmZip(archive).extractAllTo(extracted, true);
    const staging = path.join(temporaryRoot, 'runtime');
    // Keep every accompanying DLL, including dynamically loaded CPU backends.
    copyRuntimeFiles(extracted, staging, target.split('-')[0]);
    installRuntime(staging, target, 'release-asset');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function windowsSourceGenerator(targets) {
  const explicit = String(process.env.ETERX_WHISPER_CMAKE_GENERATOR || '').trim();
  const inherited = String(process.env.CMAKE_GENERATOR || '').trim();
  const isVisualStudio = value => /^Visual Studio \d+ \d{4}$/.test(value);
  if (explicit) {
    if (!isVisualStudio(explicit)) throw new Error('ETERX_WHISPER_CMAKE_GENERATOR must name a Visual Studio generator, for example Visual Studio 17 2022. NMake and Ninja do not accept -A.');
    return explicit;
  }
  if (isVisualStudio(inherited)) return inherited;

  // Do not let an inherited NMake/Ninja default receive Visual Studio's -A
  // option. Discover an installed C++ toolchain and select its generator.
  const programFiles = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || 'C:\\Program Files (x86)';
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const requiredComponents = ['Microsoft.VisualStudio.Component.VC.Tools.x86.x64'];
  if (targets.includes('win32-arm64')) {
    requiredComponents.push(
      'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
      'Microsoft.VisualStudio.Component.VC.Llvm.Clang',
      'Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset',
    );
  }
  const installations = fs.existsSync(vswhere) ? spawnSync(vswhere, [
    '-products', '*', '-requires', ...requiredComponents, '-format', 'json', '-utf8',
  ], { encoding: 'utf8', windowsHide: true, shell: false }) : null;
  const capabilities = spawnSync('cmake', ['-E', 'capabilities'], { encoding: 'utf8', windowsHide: true, shell: false });
  if (capabilities.error || capabilities.status !== 0) throw new Error('CMake is required for source builds of the speech engine. Windows x64 uses a prebuilt runtime unless ETERX_WHISPER_BUILD_FROM_SOURCE is enabled.');
  try {
    const available = JSON.parse(capabilities.stdout).generators || [];
    const installed = installations?.status === 0 ? JSON.parse(installations.stdout.replace(/^\uFEFF/, '')) : [];
    const versions = [...new Set(installed.map(instance => Number(String(instance.installationVersion).split('.')[0])))].sort((a, b) => b - a);
    for (const version of versions) {
      const generator = available.find(entry => entry.name.startsWith(`Visual Studio ${version} `));
      if (generator) return generator.name;
    }
  } catch {
    // Report a setup issue rather than falling back to an incompatible generator.
  }
  throw new Error('A compatible Visual Studio C++ toolchain is required for native Windows source builds. Install Visual Studio Build Tools with Desktop development with C++; ARM64 also requires the ARM64 build tools, C++ Clang compiler, and MSBuild support for LLVM (ClangCL). Windows x64 can use the prebuilt runtime with ETERX_WHISPER_BUILD_FROM_SOURCE unset.');
}

async function prepareSourceRuntimes(targets) {
  const windowsGenerator = targets.some(target => target.startsWith('win32-')) ? windowsSourceGenerator(targets) : null;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-whisper-'));
  try {
    const archivePath = path.join(temporaryRoot, 'source.tar.gz');
    await downloadVerified(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${releaseTag}.tar.gz`, sourceHash, archivePath);
    const sourceParent = path.join(temporaryRoot, 'source');
    fs.mkdirSync(sourceParent, { recursive: true });
    run('tar', ['-xzf', archivePath, '-C', sourceParent], 'Could not extract whisper.cpp source');
    const sourceRoot = path.join(sourceParent, fs.readdirSync(sourceParent)[0]);
    for (const target of targets) {
      const [platform, arch] = target.split('-');
      const buildRoot = path.join(temporaryRoot, `build-${target}`);
      const staging = path.join(temporaryRoot, `runtime-${target}`);
      // Linux builds use our oldest supported runner's glibc. x64 selects
      // baseline/optimized CPU backends at runtime; ARM64 is a native build.
      const dynamicCpu = arch === 'x64';
      const args = [
        '-S', sourceRoot, '-B', buildRoot, '-DCMAKE_BUILD_TYPE=Release',
        '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_BUILD_SERVER=ON',
        '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF', '-DGGML_BLAS=OFF',
        `-DBUILD_SHARED_LIBS=${dynamicCpu ? 'ON' : 'OFF'}`,
        `-DGGML_BACKEND_DL=${dynamicCpu ? 'ON' : 'OFF'}`,
        `-DGGML_CPU_ALL_VARIANTS=${dynamicCpu ? 'ON' : 'OFF'}`,
        '-DGGML_CUDA=OFF', '-DGGML_VULKAN=OFF',
        `-DGGML_METAL=${platform === 'darwin' ? 'ON' : 'OFF'}`,
        '-DGGML_METAL_EMBED_LIBRARY=ON',
        '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
        `-DCMAKE_INSTALL_RPATH=${platform === 'darwin' ? '@loader_path' : '$ORIGIN'}`,
      ];
      if (platform === 'darwin') {
        args.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'arm64' ? 'arm64' : 'x86_64'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0');
      } else if (platform === 'win32') {
        args.push('-G', windowsGenerator, '-A', arch === 'arm64' ? 'ARM64' : 'x64',
          '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
        // ggml rejects Microsoft's ARM compiler. ClangCL uses the same
        // Visual Studio ARM64 SDK and linker with Clang's ARM intrinsics.
        if (arch === 'arm64') args.push('-T', 'ClangCL');
      } else {
        args.push('-DCMAKE_SHARED_LINKER_FLAGS=-static-libstdc++ -static-libgcc', '-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc');
        if (arch !== process.arch) {
          const prefix = arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
          args.push('-DCMAKE_SYSTEM_NAME=Linux', `-DCMAKE_SYSTEM_PROCESSOR=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`,
            `-DCMAKE_C_COMPILER=${prefix}-gcc`, `-DCMAKE_CXX_COMPILER=${prefix}-g++`);
        }
      }
      run('cmake', args, `Could not configure speech for ${target}. Install CMake and the target C++ toolchain`);
      // The server target alone does not build the dlopen CPU plugins.
      run('cmake', ['--build', buildRoot, '--config', 'Release', '--parallel', String(Math.max(1, Math.min(8, os.cpus().length)))], `Could not compile speech for ${target}`);
      copyRuntimeFiles(buildRoot, staging, platform);
      fs.copyFileSync(path.join(sourceRoot, 'LICENSE'), path.join(staging, 'LICENSE'));
      installRuntime(staging, target, 'source');
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const requestedTargets = targetKeys();
const missing = requestedTargets.filter(target => !runtimeReady(target));
for (const target of missing.filter(target => runtimeKind(target) === 'release-asset')) {
  await prepareReleaseRuntime(target);
}
const sourceTargets = missing.filter(target => runtimeKind(target) === 'source');
if (sourceTargets.length) await prepareSourceRuntimes(sourceTargets);

// Bundle Large v3. Additional models download through General settings.
const model = getModel(DEFAULT_MODEL);
const bundledModelPath = path.join(outputRoot, 'models', model.file);
if (!(await fileMatches(bundledModelPath, model))) {
  fs.mkdirSync(path.dirname(bundledModelPath), { recursive: true });
  const temporary = `${bundledModelPath}.download`;
  await downloadVerified(model.url, model.sha256, temporary, model.bytes);
  fs.rmSync(bundledModelPath, { force: true });
  fs.renameSync(temporary, bundledModelPath);
}

console.log(`Prepared whisper.cpp ${releaseTag} with ${model.name} for ${requestedTargets.join(', ')}.`);
