import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MANIFEST_ROOT = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
const RELEASE_ROOT = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/';
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export const antigravityBinaryName = process.platform === 'win32' ? 'agy.exe' : 'antigravity';
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const cpu = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null;
export const supportsAntigravity = Boolean(cpu && ['windows', 'darwin', 'linux'].includes(platform));

const musl = platform === 'linux' && existsSync(`/lib/libc.musl-${cpu === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`);
const suffix = musl ? '_musl' : '';

async function downloadRelease(file: string, signal: AbortSignal): Promise<string> {
  if (!supportsAntigravity) throw new Error('Antigravity is unavailable on this desktop platform.');
  const target = `${platform}_${cpu === 'x64' ? 'amd64' : 'arm64'}${suffix}`;
  const response = await fetch(`${MANIFEST_ROOT}/${target}.json`, { signal, redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error('Google did not provide an Antigravity release for this platform.');
  const release = await response.json();
  if (typeof release?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(release.version) ||
      typeof release?.url !== 'string' || typeof release?.sha512 !== 'string' || !/^[a-f\d]{128}$/i.test(release.sha512)) {
    throw new Error('Google returned an invalid Antigravity release manifest.');
  }
  const prefix = `${RELEASE_ROOT}${release.version}-`;
  const folder = `${platform}-${cpu === 'arm64' ? 'arm' : 'x64'}${musl ? '-musl' : ''}`;
  const os = platform === 'darwin' ? 'mac' : platform;
  const extension = platform === 'windows' ? 'exe' : 'tar.gz';
  const artifact = `${folder}/cli_${os}_${cpu}${suffix}.${extension}`;
  const tail = release.url.startsWith(prefix) ? release.url.slice(prefix.length) : '';
  if (!/^\d+\//.test(tail) || tail.replace(/^\d+\//, '') !== artifact) {
    throw new Error('The Antigravity release did not point to Google’s download server.');
  }

  const download = await fetch(release.url, { signal, redirect: 'error', cache: 'no-store' });
  if (!download.ok || !download.body) throw new Error('Could not download Antigravity from Google.');
  const hash = createHash('sha512');
  let bytes = 0;
  await pipeline(Readable.fromWeb(download.body as Parameters<typeof Readable.fromWeb>[0]), new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) return callback(new Error('The Antigravity download is too large.'));
      hash.update(chunk);
      callback(null, chunk);
    },
  }), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
  if (hash.digest('hex') !== release.sha512.toLowerCase()) throw new Error('The Antigravity download did not match Google’s checksum.');
  return release.version;
}

async function extractExecutable(archive: string, target: string, signal: AbortSignal) {
  // Read just the named regular executable into an EterX-owned file. No archive
  // paths, permissions or links are installed on the host filesystem.
  const command = existsSync('/usr/bin/tar') ? '/usr/bin/tar' : '/bin/tar';
  const tar = spawn(command, ['-xOzf', archive, antigravityBinaryName], { signal, windowsHide: true });
  tar.stdin.end();
  tar.stderr.resume();
  const exit = new Promise<void>((resolve, reject) => {
    tar.once('error', reject);
    tar.once('close', code => code === 0 ? resolve() : reject(new Error('Could not extract the Antigravity executable.')));
  });
  try {
    await Promise.all([exit, pipeline(tar.stdout, createWriteStream(target, { flags: 'wx', mode: 0o700 }), { signal })]);
  } finally {
    if (tar.exitCode === null) tar.kill();
  }
}

export async function installAntigravity(binDir: string, cancellation: AbortSignal): Promise<string> {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(10 * 60_000)]);
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(binDir, '.download-'));
  const download = path.join(staging, 'download');
  const executable = path.join(staging, antigravityBinaryName);
  try {
    const version = await downloadRelease(download, signal);
    if (process.platform === 'win32') await rename(download, executable);
    else {
      await extractExecutable(download, executable, signal);
      await chmod(executable, 0o700);
    }
    signal.throwIfAborted();
    await rename(executable, path.join(binDir, antigravityBinaryName));
    return version;
  } finally {
    await Promise.allSettled([unlink(download), unlink(executable)]);
    await rmdir(staging).catch(() => undefined);
  }
}
