/**
 * EterX — Self-Updater, Backup/Restore & Version Management
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ok, warn, fail, info, spinner, c } = require('./banner');

const BACKUP_DIR_NAME = '.workspaces/backups';

/**
 * Check for updates from git remote
 */
async function checkForUpdates(projectRoot) {
  try {
    const gitDir = path.join(projectRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      info('Not a git repo — updates must be manual');
      return { available: false };
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

/**
 * Backup .env.local and config
 */
async function backupConfig(projectRoot) {
  const backupDir = path.join(projectRoot, BACKUP_DIR_NAME);
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

  ok(`Backup created: ${backupName} (${count} items)`);
  return backupPath;
}

/**
 * Restore from a backup
 */
async function restoreConfig(projectRoot, backupName) {
  const backupDir = path.join(projectRoot, BACKUP_DIR_NAME);
  const backupPath = backupName ? path.join(backupDir, backupName) : null;

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
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

module.exports = { checkForUpdates, performUpgrade, backupConfig, restoreConfig, getVersion, getCommitHash };
