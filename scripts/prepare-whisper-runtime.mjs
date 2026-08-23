import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(repositoryRoot, 'desktop-runtime', 'assets', 'native', 'whisper');
const releaseTag = 'b4938';
const releaseBase = `https://github.com/ggml-org/whisper.cpp/releases/download/${releaseTag}`;
const model = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  bytes: 147951465,
};
const assets = {
  'win32-x64': {
    url: `${releaseBase}/whisper-bin-x64.zip`,
    sha256: 'c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d',
    archive: 'zip',
  },
  'linux-x64': {
    url: `${releaseBase}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061',
    archive: 'tar',
  },
  'linux-arm64': {
    url: `${releaseBase}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: '94a33318650c57cc3d9a91439e0e3f0b94ba96bacd34203a06db395cf9204e40',
    archive: 'tar',
  },
};

function targetKeys() {
  const configured = String(process.env.ETERX_RUNTIME_TARGETS || '').trim();
  const requested = configured
    ? configured.split(',').map(value => value.trim()).filter(Boolean)
    : [`${process.platform}:${process.arch}`];
  return [...new Set(requested.map(value => value.replace(':', '-')))];
}

function executableName(platform) {
  return platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
}

function runtimeReady(target) {
  const platform = target.split('-')[0];
  return fs.existsSync(path.join(outputRoot, target, executableName(platform)));
}

async function downloadVerified(url, sha256, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download whisper.cpp runtime (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) throw new Error(`whisper.cpp runtime checksum mismatch: ${actual}`);
  fs.writeFileSync(destination, bytes);
}

function fileMatches(filePath, expectedBytes, expectedHash) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size !== expectedBytes) return false;
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex') === expectedHash;
}

function copyRuntimeFiles(sourceRoot, destination, platform) {
  fs.mkdirSync(destination, { recursive: true });
  const serverName = executableName(platform);
  const queue = [sourceRoot];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const source = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(source);
        continue;
      }
      const name = entry.name;
      const needed = name === serverName
        || name === 'LICENSE'
        || (platform === 'win32' && /\.dll$/i.test(name))
        || (platform === 'linux' && /\.so(?:\.|$)/i.test(name))
        || (platform === 'darwin' && /\.(?:dylib|metal|metallib)$/i.test(name));
      if (needed) fs.copyFileSync(source, path.join(destination, name));
    }
  }
  if (platform !== 'win32') fs.chmodSync(path.join(destination, serverName), 0o755);
}

async function prepareReleaseAsset(target, asset) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-whisper-'));
  try {
    const archivePath = path.join(temporaryRoot, asset.archive === 'zip' ? 'runtime.zip' : 'runtime.tar.gz');
    await downloadVerified(asset.url, asset.sha256, archivePath);
    const extractedRoot = path.join(temporaryRoot, 'extracted');
    fs.mkdirSync(extractedRoot, { recursive: true });
    if (asset.archive === 'zip') {
      new AdmZip(archivePath).extractAllTo(extractedRoot, true);
    } else {
      const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', extractedRoot], { stdio: 'inherit' });
      if (extracted.status !== 0) throw new Error('Could not extract the whisper.cpp runtime.');
    }
    copyRuntimeFiles(extractedRoot, path.join(outputRoot, target), target.split('-')[0]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function prepareMacRuntime(targets) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS whisper.cpp binaries must be prepared on a macOS build runner.');
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-whisper-mac-'));
  try {
    const archivePath = path.join(temporaryRoot, 'source.tar.gz');
    await downloadVerified(
      `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${releaseTag}.tar.gz`,
      '6d8d70a014ca2b10f8a6d006b8f423e5f5ef2afcfbe92b57ab4e01107238112a',
      archivePath,
    );
    const sourceParent = path.join(temporaryRoot, 'source');
    fs.mkdirSync(sourceParent, { recursive: true });
    const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', sourceParent], { stdio: 'inherit' });
    if (extracted.status !== 0) throw new Error('Could not extract whisper.cpp source.');
    const sourceRoot = path.join(sourceParent, fs.readdirSync(sourceParent)[0]);
    const buildRoot = path.join(temporaryRoot, 'build');
    const configured = spawnSync('cmake', [
      '-S', sourceRoot,
      '-B', buildRoot,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DCMAKE_OSX_ARCHITECTURES=x86_64;arm64',
      '-DWHISPER_BUILD_TESTS=OFF',
      '-DWHISPER_BUILD_EXAMPLES=ON',
      '-DWHISPER_BUILD_SERVER=ON',
    ], { stdio: 'inherit' });
    if (configured.status !== 0) throw new Error('Could not configure whisper.cpp for macOS.');
    const built = spawnSync('cmake', ['--build', buildRoot, '--config', 'Release', '--target', 'whisper-server', '-j', String(Math.max(2, os.cpus().length))], { stdio: 'inherit' });
    if (built.status !== 0) throw new Error('Could not compile whisper.cpp for macOS.');
    for (const target of targets) {
      const destination = path.join(outputRoot, target);
      copyRuntimeFiles(buildRoot, destination, 'darwin');
      fs.copyFileSync(path.join(sourceRoot, 'LICENSE'), path.join(destination, 'LICENSE'));
      spawnSync('install_name_tool', ['-add_rpath', '@executable_path', path.join(destination, 'whisper-server')], { stdio: 'ignore' });
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const requestedTargets = targetKeys();
const missingMacTargets = requestedTargets.filter(target => target.startsWith('darwin-') && !runtimeReady(target));
if (missingMacTargets.length) await prepareMacRuntime(missingMacTargets);
for (const requestedTarget of requestedTargets) {
  if (runtimeReady(requestedTarget)) continue;
  let target = requestedTarget;
  let asset = assets[target];
  // Official Windows CPU builds are x64 and run under Windows ARM64 emulation.
  if (!asset && target === 'win32-arm64') {
    target = 'win32-x64';
    asset = assets[target];
  }
  if (!asset) throw new Error(`No pinned whisper.cpp runtime is available for ${requestedTarget}.`);
  await prepareReleaseAsset(target, asset);
  if (requestedTarget !== target) {
    fs.cpSync(path.join(outputRoot, target), path.join(outputRoot, requestedTarget), { recursive: true, force: true });
  }
}

const bundledModelPath = path.join(outputRoot, 'models', 'ggml-base.bin');
if (!fileMatches(bundledModelPath, model.bytes, model.sha256)) {
  fs.mkdirSync(path.dirname(bundledModelPath), { recursive: true });
  const temporaryModelPath = `${bundledModelPath}.download`;
  fs.rmSync(temporaryModelPath, { force: true });
  await downloadVerified(model.url, model.sha256, temporaryModelPath);
  if (fs.statSync(temporaryModelPath).size !== model.bytes) {
    fs.rmSync(temporaryModelPath, { force: true });
    throw new Error('The whisper.cpp model has an unexpected size.');
  }
  fs.rmSync(bundledModelPath, { force: true });
  fs.renameSync(temporaryModelPath, bundledModelPath);
}

console.log(`Prepared whisper.cpp ${releaseTag} for ${requestedTargets.join(', ')}.`);
