import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitBranch, GitCommit, GitDiff, GitFile, GitFileStats, GitMutation, GitMutationResult, GitSnapshot, GitStash, GitStatus } from './types';

export class GitError extends Error {
  constructor(message: string, public status = 400, public code = 'git-error') { super(message); }
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const redact = (text: string) => text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@');
const state = globalThis as typeof globalThis & { __eterxGitLocks?: Set<string> };
const locks = state.__eterxGitLocks ||= new Set<string>();

function git(root: string, args: string[], network = false, input?: string): Promise<string> {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_PAGER: 'cat' };
  // The desktop may itself have been launched from a Git hook or worktree.
  // Never let that process environment override the selected repository.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete (env as NodeJS.ProcessEnv)[key];
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-pager', '--literal-pathspecs', '-C', root, ...args], {
      windowsHide: true, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, timeout: network ? 120_000 : 30_000, env,
    }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { reject(new GitError('Git is not installed or is not on PATH. Install Git, then restart EterX.', 503, 'not-installed')); return; }
      if (error.killed) { reject(new GitError('Git timed out. Refresh the repository before retrying; the action may have completed.', 408)); return; }
      const detail = redact(String(stderr || stdout || error.message).trim()).slice(0, 4000);
      reject(new GitError(detail, 400, /not a git repository/i.test(detail) ? 'not-repository' : 'git-error'));
    });
    child.stdin?.on('error', () => { /* The process callback reports early exits. */ });
    child.stdin?.end(input);
  });
}

async function directory(input: unknown): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 8192 || input.includes('\0')) throw new GitError('Choose an absolute project folder.');
  const root = await fs.realpath(input).catch(() => { throw new GitError('This project folder is no longer available.'); });
  if (!(await fs.stat(root)).isDirectory()) throw new GitError('Choose a project folder, rather than a file.');
  return root;
}

function parseStatus(output: string): GitFile[] {
  const entries = output.split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const index = entry[0], working = entry[1];
    const originalPath = /[RC]/.test(index + working) ? entries[++i] : undefined;
    files.push({ path: entry.slice(3), originalPath, index, working, untracked: index === '?', conflicted: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(index + working) });
  }
  return files;
}

function parseNumstat(output: string): Map<string, GitFileStats> {
  const entries = output.split('\0');
  const stats = new Map<string, GitFileStats>();
  for (let i = 0; i < entries.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entries[i]);
    if (!match) continue;
    let file = match[3];
    // With -z, renames have an empty path followed by old and new paths.
    // Read only the first two tabs so tabs/newlines in filenames stay literal.
    if (!file) { file = entries[i + 2]; i += 2; }
    if (!file) continue;
    const binary = match[1] === '-' || match[2] === '-';
    stats.set(file, { added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary });
  }
  return stats;
}

async function untrackedStats(root: string, file: string): Promise<GitFileStats | undefined> {
  const target = path.join(root, relativeFile(file));
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return;
  const real = await fs.realpath(target);
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
  const handle = await fs.open(real, 'r');
  try {
    // One extra byte detects a file growing during the read without allowing
    // a large new file to allocate unbounded memory on every status refresh.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return;
    const content = buffer.subarray(0, length);
    if (content.includes(0)) return { added: 0, removed: 0, binary: true };
    let added = length && content[length - 1] !== 10 ? 1 : 0;
    for (const byte of content) if (byte === 10) added++;
    return { added, removed: 0, binary: false };
  } finally { await handle.close(); }
}

async function addFileStats(current: GitSnapshot): Promise<void> {
  const trackedStats = async (staged: boolean) => {
    const files = current.files.filter(file => !file.untracked && !file.conflicted && (staged ? file.index : file.working) !== ' ');
    if (!files.length) return;
    const output = await git(current.root, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', ...(staged ? ['--cached'] : []), '--']).catch(() => null);
    if (output === null) return;
    const stats = parseNumstat(output);
    for (const file of files) file[staged ? 'stagedStats' : 'workingStats'] = stats.get(file.path);
  };
  const untracked = current.files.filter(file => file.untracked);
  let next = 0;
  await Promise.all([
    trackedStats(true), trackedStats(false),
    ...Array.from({ length: Math.min(4, untracked.length) }, async () => {
      for (;;) {
        const file = untracked[next++];
        if (!file) return;
        file.workingStats = await untrackedStats(current.root, file.path).catch(() => undefined);
      }
    }),
  ]);
}

async function repository(root: string) {
  return (await git(root, ['rev-parse', '--show-toplevel'])).trim();
}

async function optionalRef(root: string, ref: string): Promise<string> {
  return git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref]).then(value => value.trim(), () => '');
}

async function snapshot(root: string): Promise<GitSnapshot> {
  const [raw, head, branch, gitDirectory, upstream, remoteText] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    optionalRef(root, 'HEAD'),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(value => value.trim(), () => ''),
    git(root, ['rev-parse', '--absolute-git-dir']).then(value => value.trim()),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).then(value => value.trim(), () => ''),
    git(root, ['remote']),
  ]);
  const operations = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
  const [index, counts, active] = await Promise.all([
    fs.readFile(path.join(gitDirectory, 'index')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; }),
    head && upstream ? git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}', '--']).catch(() => '') : Promise.resolve(''),
    Promise.all(operations.map(name => fs.access(path.join(gitDirectory, name)).then(() => name, () => ''))),
  ]);
  const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
  const operation = active.find(Boolean) || '';
  return {
    available: true, root, gitDirectory, branch: branch || (head ? head.slice(0, 8) : ''), head, detached: !branch,
    upstream, ahead: ahead || 0, behind: behind || 0, remotes: remoteText.trim().split(/\r?\n/).filter(Boolean), files: parseStatus(raw), operation,
    revision: digest(JSON.stringify([head, branch, raw, digest(index), operation])),
  };
}

export async function getGitStatus(input: unknown, includeStats = false): Promise<GitStatus> {
  const root = await directory(input);
  try {
    const current = await snapshot(await repository(root));
    if (includeStats) await addFileStats(current);
    return current;
  }
  catch (error) {
    if (error instanceof GitError && (error.code === 'not-repository' || error.code === 'not-installed')) return { available: false, root, reason: error.code };
    throw error;
  }
}

function relativeFile(input: unknown) {
  if (typeof input !== 'string' || !input || input.length > 8192 || input.includes('\0') || path.isAbsolute(input) || /^[a-z]:/i.test(input) || input.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) throw new GitError('Choose a file inside this repository.');
  return input;
}

function objectId(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{40,64}$/.test(input)) throw new GitError('Choose a valid commit.');
  return input;
}

function clippedDiff(text: string, token: string, notice?: string): GitDiff {
  const limit = 240_000;
  return { text: text.slice(0, limit), truncated: text.length > limit, token, notice };
}

async function fileDiff(root: string, file: string, staged: boolean): Promise<GitDiff> {
  const current = await snapshot(root);
  const entry = current.files.find(item => item.path === file);
  if (!entry) return { text: '', token: '', truncated: false, notice: 'This file has no pending changes.' };
  if (entry.untracked) {
    const target = path.join(root, file);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return { text: '', token: '', truncated: false, notice: 'Open this item in Files to inspect it.' };
    const real = await fs.realpath(target);
    const relative = path.relative(root, real);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new GitError('This file resolves outside the repository.');
    const handle = await fs.open(real, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, 240_000));
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) return { text: '', token: '', truncated: false, notice: 'Binary file. Open it in Files to preview.' };
      return { text: content.toString('utf8').split('\n').map(line => '+' + line).join('\n'), token: '', truncated: stat.size > bytesRead, notice: 'New file · not yet tracked' };
    } finally { await handle.close(); }
  }
  const files = [file, ...(entry.originalPath ? [entry.originalPath] : [])];
  const text = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', ...(staged ? ['--cached'] : []), '--', ...files]);
  return clippedDiff(text, digest(text), entry.conflicted ? 'Resolve conflict markers, then stage this file to mark it resolved.' : undefined);
}

export async function readGitView(input: unknown, view: string, options: URLSearchParams): Promise<unknown> {
  if (view === 'status') return getGitStatus(input, options.get('stats') === 'true');
  const root = await repository(await directory(input));
  if (view === 'identity') {
    const [name, email] = await Promise.all(['user.name', 'user.email'].map(key => git(root, ['config', '--get', key]).then(value => value.trim(), () => '')));
    return { name, email };
  }
  if (view === 'diff') return fileDiff(root, relativeFile(options.get('path')), options.get('staged') === 'true');
  if (view === 'branches') {
    const output = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(subject)%00%(worktreepath)', 'refs/heads', 'refs/remotes']);
    const branches: GitBranch[] = output.trim().split('\n').filter(Boolean).map(line => {
      const [ref, current, upstream, subject, worktree] = line.split('\0');
      return { name: ref.replace(/^refs\/(heads|remotes)\//, ''), current: current === '*', remote: ref.startsWith('refs/remotes/'), upstream: upstream || '', subject: subject || '', worktree: worktree || '' };
    }).filter(branch => !branch.name.endsWith('/HEAD'));
    return { branches };
  }
  if (view === 'history') {
    if (!await optionalRef(root, 'HEAD')) return { commits: [], hasMore: false };
    const skip = Math.min(100_000, Math.max(0, Number(options.get('skip')) || 0));
    const output = await git(root, ['log', '-z', '--max-count=51', '--skip=' + Math.floor(skip), '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D', 'HEAD', '--']);
    const fields = output.split('\0'), commits: GitCommit[] = [];
    for (let i = 0; i + 5 < fields.length; i += 6) commits.push({ hash: fields[i], shortHash: fields[i + 1], author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4], refs: fields[i + 5] });
    return { commits: commits.slice(0, 50), hasMore: commits.length > 50 };
  }
  if (view === 'commit') {
    const hash = objectId(options.get('hash'));
    return clippedDiff(await git(root, ['show', '--format=fuller', '--stat', '--patch', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', hash, '--']), '');
  }
  if (view === 'stashes') return { stashes: await getStashes(root) };
  if (view === 'stash') {
    const hash = objectId(options.get('hash'));
    if (!(await getStashes(root)).some(item => item.hash === hash)) throw new GitError('This stash no longer exists. Refresh the list.');
    return clippedDiff(await git(root, ['stash', 'show', '--patch', '--include-untracked', '--no-ext-diff', '--no-textconv', '--no-color', hash]), '');
  }
  throw new GitError('Unknown Git view.');
}

async function getStashes(root: string): Promise<GitStash[]> {
  const output = await git(root, ['stash', 'list', '-z', '--format=%gd%x00%H%x00%gs%x00%cI']);
  const fields = output.split('\0'), stashes: GitStash[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) stashes.push({ ref: fields[i], hash: fields[i + 1], subject: fields[i + 2], date: fields[i + 3] });
  return stashes;
}

async function branchName(root: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value || value.length > 240 || value.startsWith('-') || value === 'HEAD' || value.includes('@{') || /[\x00-\x20\x7f]/.test(value)) throw new GitError('Enter a valid branch name without spaces or special revision syntax.');
  await git(root, ['check-ref-format', 'refs/heads/' + value]);
  return value;
}

function requireClean(current: GitSnapshot) {
  if (current.files.length) throw new GitError('Commit or stash your changes before switching or merging branches.');
  if (current.operation) throw new GitError('Finish the current Git operation in Terminal first.');
}

export async function mutateRepository(input: GitMutation): Promise<GitMutationResult> {
  const requested = await directory(input.root);
  const root = input.action === 'init' ? requested : await repository(requested);
  const common = input.action === 'init' ? root : (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const lockPath = await fs.realpath(common);
  const lock = process.platform === 'win32' ? lockPath.toLowerCase() : lockPath;
  if (locks.has(lock)) throw new GitError('Another Git action is running for this repository. Wait for it to finish.', 409);
  locks.add(lock);
  try {
    if (input.action === 'init') {
      if (!input.confirmed) throw new GitError('Confirm repository initialization first.');
      const existing = await getGitStatus(root);
      if (existing.available) throw new GitError('This folder already belongs to a repository. Refresh to open it.');
      await git(root, ['init', '--initial-branch=' + await branchName(root, input.branch || 'main')]);
      return { message: 'Repository initialized. Stage files to create your first commit.' };
    }
    const current = await snapshot(root);
    if (input.action !== 'fetch' && input.revision !== current.revision) throw new GitError('The repository changed since you last viewed it. Refresh and review the latest state.', 409);
    if (current.operation && !['stage', 'unstage', 'fetch', 'commit', 'set-identity'].includes(input.action)) throw new GitError('Finish the current Git operation in Terminal before starting another action.');
    if (input.action === 'stage' || input.action === 'unstage') {
      if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 500) throw new GitError('Select between 1 and 500 files.');
      const selected = input.paths.map(relativeFile).map(file => {
        const found = current.files.find(item => item.path === file);
        if (!found) throw new GitError('A selected file changed. Refresh before staging.');
        return found;
      });
      const paths = [...new Set(selected.flatMap(file => [file.path, ...(file.originalPath ? [file.originalPath] : [])]))];
      // A NUL-separated input keeps filenames literal and avoids Windows'
      // command-line length limit when staging a large group of files.
      const specs = ['--pathspec-from-file=-', '--pathspec-file-nul'];
      const pathInput = paths.join('\0') + '\0';
      if (input.action === 'stage') await git(root, ['add', '--all', ...specs], false, pathInput);
      else if (current.head) await git(root, ['restore', '--staged', '--source=HEAD', ...specs], false, pathInput);
      // Before the first commit there is no HEAD to restore from. Force here
      // applies only to index removal, preserving even subsequently edited
      // working files that differ from their staged versions.
      else await git(root, ['rm', '--cached', '--force', '-r', '--ignore-unmatch', ...specs], false, pathInput);
      return { message: `${selected.length} file${selected.length === 1 ? '' : 's'} ${input.action === 'stage' ? 'staged' : 'unstaged'}.` };
    }
    if (input.action === 'commit') {
      if (current.detached) throw new GitError('Create a branch before committing from a detached HEAD.');
      if (current.files.some(file => file.conflicted)) throw new GitError('Resolve and stage all conflicted files before committing.');
      if (current.operation && current.operation !== 'MERGE_HEAD') throw new GitError('Continue the current rebase, revert, or cherry-pick in Terminal.');
      if (!current.files.some(file => file.index !== ' ' && !file.untracked) && current.operation !== 'MERGE_HEAD') throw new GitError('Stage at least one change before committing.');
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      if (!message || message.length > 20_000 || message.includes('\0')) throw new GitError('Enter a commit message of up to 20,000 characters.');
      await git(root, ['commit', '-m', message], true);
      return { message: 'Staged changes committed.' };
    }
    if (['fetch', 'pull', 'push'].includes(input.action)) {
      const remote = input.remote || current.remotes[0];
      if (!remote || remote.startsWith('-') || !current.remotes.includes(remote)) throw new GitError('Select a configured remote first.');
      if (input.action === 'fetch') { await git(root, ['fetch', '--', remote], true); return { message: 'Remote references fetched. Your files are unchanged.' }; }
      if (current.detached || !current.head) throw new GitError('Create a branch and a commit before pulling or pushing.');
      if (input.action === 'pull') {
        requireClean(current);
        const trackedRemote = (await git(root, ['config', '--get', `branch.${current.branch}.remote`]).catch(() => '')).trim();
        const trackedRef = (await git(root, ['config', '--get', `branch.${current.branch}.merge`]).catch(() => '')).trim();
        if (trackedRemote !== remote || !trackedRef.startsWith('refs/heads/')) throw new GitError('Pull requires an upstream on the selected remote. Publish this branch first or select its tracking remote.');
        await git(root, ['pull', '--ff-only', '--no-rebase', '--', remote, trackedRef], true);
        return { message: 'Branch updated with a fast-forward pull.' };
      }
      const trackedRemote = (await git(root, ['config', '--get', `branch.${current.branch}.remote`]).catch(() => '')).trim();
      const trackedRef = (await git(root, ['config', '--get', `branch.${current.branch}.merge`]).catch(() => '')).trim();
      const destination = trackedRemote === remote && trackedRef.startsWith('refs/heads/') ? trackedRef : 'refs/heads/' + current.branch;
      await git(root, ['-c', 'push.followTags=false', '-c', `remote.${remote}.mirror=false`, 'push', ...(current.upstream ? [] : ['--set-upstream']), '--', remote, `refs/heads/${current.branch}:${destination}`], true);
      return { message: `Branch pushed to ${remote}.` };
    }
    if (input.action === 'create-branch') {
      const branch = await branchName(root, input.branch);
      await git(root, ['switch', '-c', branch]);
      return { message: `Created and switched to ${branch}. Existing edits stayed in your working tree.` };
    }
    if (input.action === 'switch-branch' || input.action === 'merge' || input.action === 'delete-branch') {
      const branch = await branchName(root, input.branch);
      const local = input.branchSource === 'remote' ? '' : await optionalRef(root, 'refs/heads/' + branch);
      const remote = input.branchSource === 'remote' ? await optionalRef(root, 'refs/remotes/' + branch) : '';
      if (!local && !remote) throw new GitError('This branch no longer exists. Refresh the branch list.');
      if (input.action === 'delete-branch') {
        if (!input.confirmed || !local || current.branch === branch) throw new GitError('Select another local branch and confirm its deletion.');
        await git(root, ['branch', '-d', '--', branch]);
        return { message: `Deleted merged branch ${branch}.` };
      }
      requireClean(current);
      if (input.action === 'switch-branch') {
        if (local) await git(root, ['switch', '--no-guess', '--', branch]);
        else await git(root, ['switch', '--track', '--', 'refs/remotes/' + branch]);
        return { message: `Switched to ${branch}.` };
      }
      if (current.detached || !current.head) throw new GitError('Create a branch and a first commit before merging.');
      if (!input.confirmed) throw new GitError('Confirm the target and source branches before merging.');
      await git(root, ['merge', ...(input.method === 'squash' ? ['--squash'] : ['--no-edit']), '--', local || remote], true);
      return { message: input.method === 'squash' ? 'Squashed changes are staged. Review them and create a commit.' : `Merged ${branch} into ${current.branch}.` };
    }
    if (input.action === 'stash-save') {
      if (!current.head) throw new GitError('Create your first commit before saving a stash.');
      if (current.files.some(file => file.conflicted)) throw new GitError('Resolve conflicts before stashing.');
      if (!current.files.some(file => !file.untracked || input.includeUntracked)) throw new GitError('There are no changes to stash with this selection.');
      const message = typeof input.message === 'string' ? input.message.trim().slice(0, 2000) : '';
      if (message.includes('\0')) throw new GitError('Enter a valid stash message.');
      await git(root, ['stash', 'push', ...(input.includeUntracked ? ['--include-untracked'] : []), '-m', message || 'Saved from EterX']);
      return { message: 'Changes saved in a stash.' };
    }
    if (input.action === 'stash-apply' || input.action === 'stash-drop') {
      const stash = (await getStashes(root)).find(item => item.hash === input.stashHash && item.ref === input.stash);
      if (!stash) throw new GitError('The stash list changed. Refresh and choose the stash again.', 409);
      if (input.action === 'stash-apply') {
        requireClean(current);
        await git(root, ['stash', 'apply', '--index', stash.hash]);
        return { message: 'Stash applied. The saved stash is still available.' };
      }
      if (!input.confirmed) throw new GitError('Confirm that this stash can be permanently dropped.');
      await git(root, ['stash', 'drop', stash.ref]);
      return { message: 'Stash dropped.' };
    }
    if (input.action === 'discard') {
      if (!input.confirmed || input.paths?.length !== 1) throw new GitError('Review and confirm one file before discarding its unstaged changes.');
      const file = relativeFile(input.paths[0]);
      const entry = current.files.find(item => item.path === file);
      if (!entry || entry.untracked || entry.conflicted || entry.originalPath || entry.working === ' ') throw new GitError('Only ordinary tracked, unstaged changes can be discarded here.');
      const diff = await fileDiff(root, file, false);
      if (/^Binary files /m.test(diff.text)) throw new GitError('Open this binary file in Files and use Terminal to restore it.');
      if (!diff.text || !input.token || input.token !== diff.token) throw new GitError('The file changed since its preview was opened. Review the latest diff before discarding.', 409);
      // Restore only the working copy from the index; staged edits are retained.
      await git(root, ['restore', '--worktree', '--', file]);
      return { message: 'Unstaged changes discarded for ' + file + '.' };
    }
    if (input.action === 'add-remote') {
      if (typeof input.remote !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(input.remote)) throw new GitError('Enter a remote name using letters, numbers, dots, hyphens, or underscores.');
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (url.length > 4096 || /[\s\x00-\x1f]/.test(url) || !(/^(https:\/\/|ssh:\/\/)/.test(url) || /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(url))) throw new GitError('Use an HTTPS or SSH repository URL. Authenticate through your system Git credential manager.');
      if (url.includes('://')) {
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new GitError('Enter a valid HTTPS or SSH repository URL.'); }
        if (!parsed.hostname) throw new GitError('The remote URL must include a hostname.');
        if (parsed.password || (parsed.protocol === 'https:' && parsed.username)) throw new GitError('Keep passwords and tokens in your Git credential manager, rather than in remote URLs.');
      }
      await git(root, ['remote', 'add', input.remote, url]);
      return { message: `Remote ${input.remote} added.` };
    }
    if (input.action === 'set-identity') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const email = typeof input.email === 'string' ? input.email.trim() : '';
      if (!name || name.length > 200 || /[\x00-\x1f<>]/.test(name)) throw new GitError('Enter a commit author name of up to 200 characters.');
      if (email.length > 320 || !/^[^\s<>@\x00-\x1f]+@[^\s<>@\x00-\x1f]+$/.test(email)) throw new GitError('Enter a valid commit email address.');
      await git(root, ['config', '--local', '--replace-all', 'user.name', name]);
      await git(root, ['config', '--local', '--replace-all', 'user.email', email]);
      return { message: 'Commit identity saved for this repository only.' };
    }
    throw new GitError('Unknown Git action.');
  } finally { locks.delete(lock); }
}
