/**
 * EterX — OS Detection & Prerequisite Checks
 */
const { execFileSync, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ok, warn, fail, info } = require('./banner');

function detectOS() {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  let distro = '';

  if (platform === 'linux') {
    try {
      const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
      const nameMatch = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
      distro = nameMatch ? nameMatch[1] : 'Linux';
      const idMatch = osRelease.match(/^ID=(.+)/m);
      const distroId = idMatch ? idMatch[1].replace(/"/g, '').trim() : '';
      return { platform, release, arch, distro, distroId };
    } catch { distro = 'Linux'; }
  }

  return {
    platform,
    release,
    arch,
    distro: platform === 'win32' ? `Windows ${release}` : platform === 'darwin' ? `macOS ${release}` : distro,
    distroId: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux',
  };
}

function checkCommand(cmd) {
  try {
    const result = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return result || true;
  } catch { return false; }
}

function checkNodeVersion() {
  const version = checkCommand('node --version');
  if (!version) return { installed: false, version: null, major: 0 };
  const clean = String(version).replace('v', '');
  const major = parseInt(clean.split('.')[0], 10);
  return { installed: true, version: clean, major };
}

function checkGit() {
  const version = checkCommand('git --version');
  if (!version) return { installed: false };
  const match = String(version).match(/(\d+\.\d+\.\d+)/);
  return { installed: true, version: match ? match[1] : 'unknown' };
}

function checkNpm() {
  const version = checkCommand('npm --version');
  return { installed: !!version, version: version || null };
}

function checkPort(port) {
  try {
    if (os.platform() === 'win32') {
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return result.includes('LISTENING');
    } else {
      const result = execSync(`lsof -i :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return result.length > 0;
    }
  } catch { return false; }
}

function getDiskFreeGB(targetDir) {
  try {
    const dir = path.resolve(targetDir || process.cwd());
    if (os.platform() === 'win32') {
      const driveName = path.parse(dir).root.charAt(0);
      if (!driveName) return -1;

      try {
        const out = execSync(`powershell.exe -NoProfile -NonInteractive -Command "(Get-PSDrive -Name ${driveName}).Free"`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        }).trim();
        const bytes = Number(out.replace(/[^\d.]/g, ''));
        if (Number.isFinite(bytes) && bytes > 0) return bytes / (1024 ** 3);
      } catch {}

      const drive = `${driveName}:`;
      const out = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      const match = out.match(/FreeSpace=(\d+)/);
      return match ? parseInt(match[1], 10) / (1024 ** 3) : -1;
    }

    const out = execFileSync('df', ['-k', dir], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const lines = out.trim().split(/\r?\n/);
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    const freeKb = Number(cols[3]);
    return Number.isFinite(freeKb) ? freeKb / (1024 ** 2) : -1;
  } catch {
    return -1;
  }
}

function getSystemInfo() {
  const osInfo = detectOS();
  const node = checkNodeVersion();
  const git = checkGit();
  const npm = checkNpm();
  const ram = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
  const cpus = os.cpus().length;

  info(`OS: ${osInfo.distro} (${osInfo.arch})`);
  info(`RAM: ${ram} GB | CPUs: ${cpus}`);

  if (node.installed && node.major >= 18) {
    ok(`Node.js ${node.version}`);
  } else if (node.installed) {
    warn(`Node.js ${node.version} — v18+ recommended`);
  } else {
    fail('Node.js not found');
  }

  if (npm.installed) ok(`npm ${npm.version}`);
  else fail('npm not found');

  if (git.installed) ok(`Git ${git.version}`);
  else warn('Git not found (optional)');

  return { osInfo, node, git, npm, ram, cpus };
}

function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (!checkPort(port)) return port;
  }
  return startPort;
}

function getProjectRoot() {
  // Walk up from this file's location to find package.json
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '..');
}

module.exports = { detectOS, checkCommand, checkNodeVersion, checkGit, checkNpm, checkPort, getDiskFreeGB, getSystemInfo, findFreePort, getProjectRoot };
