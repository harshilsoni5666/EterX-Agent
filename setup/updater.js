/**
 * EterX — Self-Updater, Backup/Restore & Version Management
 */
const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ok, warn, fail, info, spinner, c } = require('./banner');

const BACKUP_DIR_NAME = 'backups';

function getEterxDataDir() {
  const configured = String(process.env.ETERX_DATA_DIR || '').trim();
  if (configured) return path.resolve(configured);
  if (process.platform === 'win32') {
    const root = String(process.env.LOCALAPPDATA || process.env.APPDATA || '').trim();
    if (root) return path.resolve(root, 'EterX', 'data');
  }
  if (process.platform === 'darwin') {
    return path.resolve(os.homedir(), 'Library', 'Application Support', 'EterX', 'data');
  }
  return path.resolve(
    String(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')).trim(),
    'EterX',
    'data',
  );
}

function getBackupDir() {
  return path.join(getEterxDataDir(), BACKUP_DIR_NAME);
}

function resolveBackupPath(backupDir, backupName) {
  const root = path.resolve(backupDir);
  const resolved = path.resolve(root, String(backupName || ''));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid backup name');
  }
  return resolved;
}

/**
 * Check for updates from git remote
 */
async function checkForUpdates(projectRoot) {
  try {
    const gitDir = path.join(projectRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      info('Source-bootstrap installation detected — the installer will replace application code safely.');
      return { available: true, sourceBootstrap: true, behind: null };
    }

    const s = spinner('Checking for updates...');
    execSync('git fetch origin', { cwd: projectRoot, stdio: 'ignore', timeout: 15000 });

    const local = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();
    const remote = execSync('git rev-parse origin/main', { cwd: projectRoot, encoding: 'utf8' }).trim();

    if (local === remote) {
      s.stop('EterX is up to date');
      return { available: false, hash: local.slice(0, 8) };
    }

    // Count commits behind
    const behind = execSync(`git rev-list HEAD..origin/main --count`, { cwd: projectRoot, encoding: 'utf8' }).trim();
    s.stop(`Update available (${behind} commits behind)`);

    // Get changelog
    const log = execSync(`git log HEAD..origin/main --oneline -10`, { cwd: projectRoot, encoding: 'utf8' }).trim();
    return { available: true, behind: parseInt(behind), log, localHash: local.slice(0, 8), remoteHash: remote.slice(0, 8) };
  } catch (e) {
    warn(`Update check failed: ${e.message}`);
    return { available: false, error: e.message };
  }
}

/**
 * Pull latest updates and re-install
 */
async function performUpgrade(projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return launchBootstrapUpgrade(projectRoot);
  }
  // 1. Backup first
  info('Creating backup before upgrade...');
  await backupConfig(projectRoot);

  // 2. Git pull
  const s = spinner('Pulling latest code...');
  try {
    execSync('git stash', { cwd: projectRoot, stdio: 'inherit' });
    execSync('git pull origin main --rebase', { cwd: projectRoot, stdio: 'inherit' });
    s.stop('Code updated');
  } catch (e) {
    s.fail('Git pull failed');
    warn('Attempting recovery...');
    try { execSync('git stash pop', { cwd: projectRoot, stdio: 'inherit' }); } catch {}
    return false;
  }

  // 3. Restore stashed changes
  try { execSync('git stash pop', { cwd: projectRoot, stdio: 'inherit' }); } catch {}

  // 4. Re-install deps
  const s2 = spinner('Updating dependencies...');
  try {
    const installCmd = fs.existsSync(path.join(projectRoot, 'package-lock.json')) ? 'npm ci' : 'npm install';
    try {
      execSync(installCmd, { cwd: projectRoot, stdio: 'inherit', timeout: 300000 });
    } catch {
      warn('Standard dependency setup failed. Retrying with --legacy-peer-deps.');
      execSync(`${installCmd} --legacy-peer-deps`, { cwd: projectRoot, stdio: 'inherit', timeout: 300000 });
    }
    s2.stop('Dependencies updated');
  } catch {
    s2.fail('npm install failed');
    return false;
  }

  ok('Upgrade complete!');
  return true;
}

function launchBootstrapUpgrade(projectRoot) {
  try {
    if (process.platform === 'win32') {
      const source = path.join(projectRoot, 'install.ps1');
      if (!fs.existsSync(source)) throw new Error('install.ps1 is missing');
      const updaterScript = path.join(os.tmpdir(), `eterx-update-${Date.now()}.ps1`);
      fs.copyFileSync(source, updaterScript);
      // Do not launch the native installer while the source bootstrap is
      // still running.  Windows keeps the running Electron/Node image and
      // its loaded libraries locked, which previously produced the installer
      // dialog asking the user to close EterX and retry.  The detached helper
      // waits for this process to exit, then runs the copied script and cleans
      // it up even when the download fails.
      const parentPid = process.pid;
      const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;
      const command = [
        `while (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }`,
        `try { & ${psLiteral(updaterScript)} } finally { Remove-Item -LiteralPath ${psLiteral(updaterScript)} -Force -ErrorAction SilentlyContinue }`,
      ].join('; ');
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
      ], { detached: true, stdio: 'inherit', windowsHide: false });
      child.unref();
    } else {
      const source = path.join(projectRoot, 'install.sh');
      if (!fs.existsSync(source)) throw new Error('install.sh is missing');
      const updaterScript = path.join(os.tmpdir(), `eterx-update-${Date.now()}.sh`);
      fs.copyFileSync(source, updaterScript);
      fs.chmodSync(updaterScript, 0o755);
      const command = `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; ETERX_NO_LAUNCH=1 sh "$1"; code=$?; rm -f -- "$1"; exit $code`;
      const child = spawn('sh', ['-c', command, 'eterx-updater', updaterScript], {
        detached: true,
        stdio: 'inherit',
      });
      child.unref();
    }
    ok('The native EterX installer is starting. This terminal will continue showing its progress.');
    info('Your source-bootstrap data will be imported on the first native-app launch.');
    return true;
  } catch (error) {
    fail(`Could not start the source updater: ${error.message}`);
    return false;
  }
}

/**
 * Backup .env.local and config
 */
async function backupConfig(projectRoot) {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `backup-${timestamp}`;
  const backupPath = path.join(backupDir, backupName);
  fs.mkdirSync(backupPath, { recursive: true });

  const filesToBackup = [
    '.env.local',
    '.workspaces/config/eterx.config.json',
    '.workspaces/config/setup-meta.json',
  ];

  let count = 0;
  for (const file of filesToBackup) {
    const src = path.join(projectRoot, file);
    if (fs.existsSync(src)) {
      const dest = path.join(backupPath, path.basename(file));
      fs.copyFileSync(src, dest);
      count++;
    }
  }

  // Backup memory directory
  const memDir = path.join(projectRoot, '.workspaces', 'memory');
  if (fs.existsSync(memDir)) {
    const memBackup = path.join(backupPath, 'memory');
    copyDirSync(memDir, memBackup);
    count++;
  }

  // The native app keeps chats, preferences, runtime settings, browser
  // profiles, and agent state under AppData. Preserve that complete durable
  // tree before a source-bootstrap upgrade as well; the code replacement must
  // never be the thing that carries user state.
  const appDataRoot = getEterxDataDir();
  if (fs.existsSync(appDataRoot)) {
    copyDirSync(appDataRoot, path.join(backupPath, 'app-data'), new Set([BACKUP_DIR_NAME]));
    count++;
  }

  ok(`Backup created: ${backupName} (${count} items)`);
  return backupPath;
}

/**
 * Restore from a backup
 */
async function restoreConfig(projectRoot, backupName) {
  const backupDir = getBackupDir();
  let backupPath = null;
  if (backupName) {
    try {
      backupPath = resolveBackupPath(backupDir, backupName);
    } catch (error) {
      fail(error.message);
      return false;
    }
  }

  if (backupName && !fs.existsSync(backupPath)) {
    fail(`Backup not found: ${backupName}`);
    return false;
  }

  // If no name given, list available backups
  if (!backupName) {
    if (!fs.existsSync(backupDir)) {
      fail('No backups found');
      return false;
    }
    const backups = fs.readdirSync(backupDir).filter(d => d.startsWith('backup-')).sort().reverse();
    if (backups.length === 0) {
      fail('No backups found');
      return false;
    }
    return backups; // Return list for the caller to pick
  }

  // Restore files
  const files = fs.readdirSync(backupPath);
  for (const file of files) {
    const src = path.join(backupPath, file);
    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
      if (file === 'memory') {
        const dest = path.join(projectRoot, '.workspaces', 'memory');
        copyDirSync(src, dest);
      } else if (file === 'app-data') {
        copyDirSync(src, getEterxDataDir(), new Set([BACKUP_DIR_NAME]));
      }
    } else {
      let dest;
      if (file === '.env.local') dest = path.join(projectRoot, file);
      else if (file === 'eterx.config.json') dest = path.join(projectRoot, '.workspaces', 'config', file);
      else if (file === 'setup-meta.json') dest = path.join(projectRoot, '.workspaces', 'config', file);
      else dest = path.join(projectRoot, file);

      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  ok(`Restored from: ${backupName}`);
  return true;
}

/**
 * Get current version from package.json
 */
function getVersion(projectRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

/**
 * Get git commit hash
 */
function getCommitHash(projectRoot) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

// ── Utility: recursive dir copy ──
function copyDirSync(src, dest, excludedNames = new Set()) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath, excludedNames);
    else fs.copyFileSync(srcPath, destPath);
  }
}

module.exports = { checkForUpdates, performUpgrade, backupConfig, restoreConfig, getVersion, getCommitHash };
