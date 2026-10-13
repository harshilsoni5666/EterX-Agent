const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { workspaceRoot, dataRoot } = require('./storage-layout');
const { isAbsoluteHostPath } = require('./workspace-layout');

const git = promisify(execFile);
const DAY = 86400000;
const root = () => path.join(workspaceRoot(), 'managed');
const owner = value => String(value || '').replace(/^terminal-draft-/, '');
const normalizeDays = value => Number.isFinite(Number(value)) && Number(value) >= 1
  ? Math.max(1, Math.min(365, Math.round(Number(value)))) : 7;
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (child, parent) => {
  const relative = path.relative(key(parent), key(child));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const baseFor = id => {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid managed workspace.');
  return path.join(root(), id);
};
const directoryFor = id => path.join(baseFor(id), 'working');
const recordFor = id => path.join(baseFor(id), 'workspace.json');

function read(id) {
  const entry = JSON.parse(fs.readFileSync(recordFor(id), 'utf8'));
  if (entry.id !== id || !['sandbox', 'worktree'].includes(entry.kind)) throw new Error('Invalid workspace record.');
  return { ...entry, path: directoryFor(id) };
}

function write(entry) {
  const temporary = recordFor(entry.id) + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(entry, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, recordFor(entry.id));
}

// All deletion targets are derived from our own IDs, then checked against the
// canonical managed root. Never follow a moved folder, junction, or symlink.
function assertOwned(id) {
  const base = baseFor(id);
  const managedRoot = root();
  if (fs.lstatSync(managedRoot).isSymbolicLink() || fs.lstatSync(base).isSymbolicLink()) throw new Error('Managed workspace links are not supported.');
  const realRoot = fs.realpathSync(managedRoot);
  const realBase = fs.realpathSync(base);
  if (!inside(realBase, realRoot) || key(realBase) === key(realRoot)) throw new Error('Workspace is outside managed storage.');
  const directory = directoryFor(id);
  if (fs.existsSync(directory)) {
    if (fs.lstatSync(directory).isSymbolicLink() || !inside(fs.realpathSync(directory), realBase)) throw new Error('Workspace folder has moved outside managed storage.');
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function lock(id) {
  assertOwned(id);
  const file = path.join(baseFor(id), 'access.lock');
  let handle;
  try { handle = fs.openSync(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* Fail closed for a lock being written. */ }
    if (!previous || isAlive(previous.pid)) throw new Error('This workspace is busy. Try again in a moment.');
    fs.unlinkSync(file);
    handle = fs.openSync(file, 'wx');
  }
  try { fs.writeFileSync(handle, JSON.stringify({ pid: process.pid })); }
  finally { fs.closeSync(handle); }
  return () => { try { fs.unlinkSync(file); } catch {} };
}

function hasLeases(id) {
  const leases = path.join(baseFor(id), 'leases');
  if (!fs.existsSync(leases)) return false;
  if (fs.lstatSync(leases).isSymbolicLink() || !inside(fs.realpathSync(leases), fs.realpathSync(baseFor(id)))) throw new Error('Invalid workspace lease directory.');
  for (const name of fs.readdirSync(leases)) {
    const file = path.join(leases, name);
    try {
      if (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) return true;
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isAlive(entry.pid) || (entry.childPid && isAlive(entry.childPid))) return true;
      fs.unlinkSync(file);
    } catch { return true; }
  }
  return false;
}

function findByPath(directory) {
  if (typeof directory !== 'string' || !isAbsoluteHostPath(directory) || !inside(path.resolve(directory), root())) return null;
  const relative = path.relative(root(), path.resolve(directory));
  const id = relative.split(path.sep)[0];
  if (!/^[a-f0-9]{32}$/.test(id) || !inside(path.resolve(directory), directoryFor(id))) return null;
  return read(id);
}

function acquireWorkspaceLease(directory) {
  const entry = findByPath(directory);
  if (!entry) return () => {};
  const unlock = lock(entry.id);
  try {
    const current = read(entry.id);
    if (current.status !== 'ready' || !fs.existsSync(current.path)) throw new Error('This workspace has expired or was removed. Create a new workspace from Start in.');
    const leases = path.join(baseFor(entry.id), 'leases');
    fs.mkdirSync(leases, { recursive: true });
    if (fs.lstatSync(leases).isSymbolicLink()) throw new Error('Invalid workspace lease directory.');
    const file = path.join(leases, `${process.pid}-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    const release = () => { try { fs.unlinkSync(file); } catch {} };
    release.setProcess = childPid => {
      if (Number.isInteger(childPid) && childPid > 0) {
        try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, childPid }), { mode: 0o600 }); }
        catch (error) { console.warn('[Workspaces] Could not record child process:', error.message); }
      }
    };
    return release;
  } finally { unlock(); }
}

function retentionDays() {
  for (const name of ['preferences.json', 'preferences.backup.json']) {
    try {
      const values = JSON.parse(fs.readFileSync(path.join(dataRoot(), 'settings', name), 'utf8'));
      return normalizeDays(JSON.parse(values.eterx_settings || '{}').scratchRetentionDays);
    } catch {}
  }
  return 7;
}

async function runGit(cwd, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  try {
    return (await git('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024, env })).stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Install Git on this device to create a worktree.');
    if (String(error.stderr).includes('not a git repository')) throw new Error('This folder is not a Git repository. Select a repository folder and try again.');
    if (String(error.stderr).includes('Needed a single revision')) throw new Error('This repository needs its first commit before you can create a worktree.');
    throw new Error(String(error.stderr || error.message || 'Git could not create the worktree.').trim().slice(0, 1500));
  }
}

function list(chatId) {
  if (!fs.existsSync(root())) return [];
  return fs.readdirSync(root()).filter(id => /^[a-f0-9]{32}$/.test(id)).flatMap(id => {
    try { const entry = read(id); return !chatId || entry.chatId === owner(chatId) ? [entry] : []; } catch { return []; }
  });
}

async function create({ chatId, kind, sourcePath, days }) {
  if (!owner(chatId) || owner(chatId).length > 160 || chatId === 'terminal-draft-initial') throw new Error('The chat is still opening. Try again in a moment.');
  if (!['sandbox', 'worktree'].includes(kind)) throw new Error('Choose a worktree or scratch workspace.');
  let source = null;
  if (kind === 'worktree') {
    if (!isAbsoluteHostPath(sourcePath)) throw new Error('Select a repository folder before creating a worktree.');
    const existing = findByPath(sourcePath);
    source = existing?.kind === 'worktree' ? existing.sourcePath : sourcePath;
    source = await runGit(source, ['rev-parse', '--show-toplevel']);
    await runGit(source, ['rev-parse', '--verify', 'HEAD']);
  }
  const existing = list(chatId).find(entry => entry.kind === kind && entry.status === 'ready' && (!source || key(entry.sourcePath) === key(source)) && fs.existsSync(entry.path) && (!entry.expiresAt || entry.expiresAt > Date.now() || hasLeases(entry.id)));
  if (existing) return existing;
  // Stable identity prevents duplicate folders on repeated clicks or retries.
  const generation = list(chatId).filter(entry => entry.kind === kind).length;
  const id = createHash('sha256').update(`${owner(chatId)}:${kind}:${source || ''}:${generation}`).digest('hex').slice(0, 32);
  fs.mkdirSync(baseFor(id), { recursive: true });
  const unlock = lock(id);
  try {
    if (fs.existsSync(recordFor(id))) {
      const previous = read(id);
      if (previous.status === 'ready') return previous;
      throw new Error('This workspace could not finish preparing. Select the option again to create a fresh workspace.');
    }
    const createdAt = Date.now();
    const entry = { id, chatId: owner(chatId), kind, path: directoryFor(id), sourcePath: source || sourcePath || null, branch: kind === 'worktree' ? `eterx/workspace-${id.slice(0, 12)}` : null, createdAt, expiresAt: kind === 'sandbox' ? createdAt + normalizeDays(days ?? retentionDays()) * DAY : null, status: 'ready' };
    write({ ...entry, status: 'creating' });
    try {
    if (kind === 'worktree') {
      // No force, checkout, reset, stash, hooks, or dependency setup in the
      // source checkout. Uncommitted files remain in the original folder.
      const hooks = path.join(baseFor(id), 'empty-hooks');
      fs.mkdirSync(hooks);
      await runGit(source, ['-c', `core.hooksPath=${hooks}`, 'worktree', 'add', '-b', entry.branch, entry.path, 'HEAD']);
    } else {
      await fsp.mkdir(entry.path);
    }
    write(entry);
    return entry;
    } catch (error) {
      write({ ...entry, status: 'failed', error: String(error.message || error) });
      throw error;
    }
  } finally { unlock(); }
}

async function update(id, action, days) {
  const unlock = lock(id);
  try {
    const entry = read(id);
    if (entry.status !== 'ready') throw new Error('This workspace is no longer available. Create a new workspace.');
    if (action === 'remove') {
      if (hasLeases(id)) throw new Error('Stop active agents and close this workspace’s terminals before removing it.');
      assertOwned(id);
      if (entry.kind === 'worktree') {
        // Git refuses dirty worktrees and preserves the branch for recovery.
        await runGit(entry.sourcePath, ['worktree', 'remove', entry.path]);
      } else {
        await fsp.rm(directoryFor(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      }
      const removed = { ...entry, status: 'removed', deletedAt: Date.now() };
      write(removed);
      return removed;
    }
    if (entry.kind !== 'sandbox') throw new Error('Worktrees do not expire automatically.');
    if (action === 'keep') entry.expiresAt = null;
    else if (action === 'extend') entry.expiresAt = Math.max(Date.now(), entry.expiresAt || Date.now()) + normalizeDays(days ?? retentionDays()) * DAY;
    else throw new Error('Unknown workspace action.');
    write(entry);
    return entry;
  } finally { unlock(); }
}

let sweeping = false;
async function cleanupExpiredWorkspaces() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const candidate of list()) {
      if (candidate.kind !== 'sandbox' || candidate.status !== 'ready' || !candidate.expiresAt || candidate.expiresAt > Date.now()) continue;
      let unlock;
      try {
        unlock = lock(candidate.id);
        const entry = read(candidate.id);
        if (entry.status !== 'ready' || !entry.expiresAt || entry.expiresAt > Date.now() || hasLeases(entry.id)) continue;
        assertOwned(entry.id);
        await fsp.rm(directoryFor(entry.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
        write({ ...entry, status: 'expired', deletedAt: Date.now() });
      } catch (error) {
        // A busy/moved folder stays intact; retry on the next sweep.
        if (!String(error.message).includes('busy')) console.warn('[Workspaces] Cleanup deferred:', error.message);
      } finally { unlock?.(); }
    }
  } catch (error) {
    console.warn('[Workspaces] Could not read cleanup records:', error.message);
  } finally { sweeping = false; }
}

function startWorkspaceCleanup() {
  const token = Symbol.for('eterx.managedWorkspaceCleanup');
  if (globalThis[token]) return;
  globalThis[token] = setInterval(() => void cleanupExpiredWorkspaces(), 60 * 60 * 1000);
  globalThis[token].unref?.();
  void cleanupExpiredWorkspaces();
}

module.exports = { create, list, update, findByPath, acquireWorkspaceLease, cleanupExpiredWorkspaces, startWorkspaceCleanup, retentionDays };
