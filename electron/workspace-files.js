const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { createWorkspaceAppFinder, launchWorkspaceApp } = require('./workspace-open-apps');

exports.registerWorkspaceFiles = ({ ipcMain, app, getWindow, authorize }) => {
  const { shell, dialog } = require('electron');
  const watches = new Map();
  const subscriptions = new Map();
  const applications = createWorkspaceAppFinder(app);
  const send = payload => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send('workspace-files-event', payload); };
  const unwatch = id => {
    const directory = subscriptions.get(id); subscriptions.delete(id);
    const record = watches.get(directory);
    if (!record) return;
    record.ids.delete(id);
    if (!record.ids.size) { clearTimeout(record.timer); record.watcher.close(); watches.delete(directory); }
  };
  const cleanup = () => { for (const id of subscriptions.keys()) unwatch(id); };
  ipcMain.handle('workspace-files-watch', (event, id, directory) => {
    const window = authorize(event);
    if (typeof id !== 'string' || typeof directory !== 'string' || !path.isAbsolute(directory)) return false;
    unwatch(id);
    if (!watches.has(directory)) {
      if (watches.size >= 64) return false;
      const record = { ids: new Set(), timer: null, watcher: null };
      try {
        record.watcher = fs.watch(directory, { persistent: false }, (_type, filename) => {
          const name = String(filename || '');
          if (['node_modules', '.git', '.next', '__pycache__'].includes(name)) return;
          clearTimeout(record.timer);
          record.timer = setTimeout(() => { for (const watchId of record.ids) send({ id: watchId, directory }); }, 350);
        });
        record.watcher.on('error', () => { for (const watchId of [...record.ids]) { send({ id: watchId, directory, unavailable: true }); unwatch(watchId); } });
        watches.set(directory, record);
      } catch { return false; }
    }
    watches.get(directory).ids.add(id); subscriptions.set(id, directory);
    if (!window.__eterxWorkspaceWatches) {
      window.__eterxWorkspaceWatches = true;
      window.webContents.once('destroyed', cleanup);
      window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cleanup(); });
    }
    return true;
  });
  ipcMain.on('workspace-files-unwatch', (event, id) => { try { authorize(event); unwatch(id); } catch {} });
  app.on('will-quit', cleanup);

  ipcMain.handle('workspace-open-apps', async (event, refresh = false) => {
    authorize(event);
    return (await applications.find(refresh === true)).map(({ id, name, icon, folders }) => ({ id, name, icon, folders }));
  });
  ipcMain.handle('workspace-open-file', async (event, filePath, application = 'default') => {
    authorize(event);
    if (typeof filePath !== 'string' || filePath.includes('\0') || !path.isAbsolute(filePath)) throw new Error('Select a local file first.');
    if (typeof application !== 'string') throw new Error('Choose an application to open this path.');
    filePath = path.normalize(filePath);
    const targetStat = await fsp.stat(filePath);
    if (application === 'reveal') { shell.showItemInFolder(filePath); return; }
    if (application === 'save-as') {
      const sourceStat = await fsp.stat(filePath);
      if (!sourceStat.isFile()) throw new Error('Choose a file to save a copy.');
      const result = await dialog.showSaveDialog(getWindow(), { defaultPath: path.basename(filePath) });
      if (result.canceled || !result.filePath) return;
      const source = await fsp.realpath(filePath);
      const destination = await fsp.realpath(result.filePath).catch(() => path.resolve(result.filePath));
      const destinationStat = await fsp.stat(result.filePath).catch(() => null);
      if (destinationStat && sourceStat.ino && sourceStat.ino === destinationStat.ino && sourceStat.dev === destinationStat.dev) return;
      const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
      if (key(source) !== key(destination)) await fsp.copyFile(filePath, result.filePath);
      return;
    }
    if (application === 'default') { const error = await shell.openPath(filePath); if (error) throw new Error(error); return; }
    let selected = (await applications.find()).find(item => item.id === application);
    // An app may have moved, updated, or been uninstalled since the menu opened.
    if (!selected || !await fsp.access(selected.executable).then(() => true, () => false)) selected = (await applications.find(true)).find(item => item.id === application);
    if (!selected) throw new Error('This application is no longer available on this device. Open the menu to refresh the application list.');
    if (targetStat.isDirectory() && !selected.folders) throw new Error(`${selected.name} opens files. Choose a file first.`);
    try { await launchWorkspaceApp(selected, filePath); }
    catch (error) { applications.invalidate(); throw error; }
  });

  // These read-only commands run only for a user-opened working-tree/branch
  // review. No stage, commit, reset, or push action is exposed by this panel.
  const git = (root, args) => new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout));
  });
  const reviewTargets = new Map();
  const addedFileLines = content => {
    const lines = content ? content.split(/\r?\n/) : [];
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { diffLines: lines.slice(0, 10000).map((content, index) => ({ type: 'added', content, newLine: index + 1 })), truncated: lines.length > 10000 };
  };
  const resolveReviewTarget = async (root, scope, comparisonRef = '') => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Choose a project folder to review.');
    const repository = String(await git(root, ['rev-parse', '--show-toplevel'])).trim();
    const branch = String(await git(repository, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'Detached HEAD')).trim();
    const upstream = String(await git(repository, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim();
    const references = String(await git(repository, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])).trim().split(/\r?\n/).filter(ref => ref && !ref.endsWith('/HEAD')).slice(0, 1200);
    const baseRef = comparisonRef || upstream || 'HEAD';
    if (typeof baseRef !== 'string' || baseRef.length > 1024 || /[\x00-\x1f]/.test(baseRef)) throw new Error('Choose a valid comparison branch.');
    const hasHead = await git(repository, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
    const gitDirectory = String(await git(repository, ['rev-parse', '--absolute-git-dir'])).trim();
    // Resolve the selected ref to an object ID before constructing a revision
    // range. Ref text is never treated as command options or shell input.
    const baseCommit = scope === 'branch' ? String(await git(repository, ['rev-parse', '--verify', '--end-of-options', baseRef + '^{commit}'])).trim() : '';
    return { repository, branch, upstream, gitDirectory, hasHead, references, baseRef, base: scope === 'branch' ? [`${baseCommit}...HEAD`] : hasHead ? ['HEAD'] : [] };
  };
  const reviewTarget = (root, scope, baseRef = '') => {
    const key = JSON.stringify([root, scope, baseRef]);
    const cached = reviewTargets.get(key);
    if (cached && Date.now() - cached.at < 2000) return cached.promise;
    const promise = resolveReviewTarget(root, scope, baseRef).catch(error => { reviewTargets.delete(key); throw error; });
    reviewTargets.set(key, { at: Date.now(), promise });
    if (reviewTargets.size > 24) reviewTargets.delete(reviewTargets.keys().next().value);
    return promise;
  };
  ipcMain.handle('workspace-review-list', async (event, root, scope = 'working', baseRef = '') => {
    authorize(event);
    const target = await reviewTarget(root, scope, baseRef);
    let files = [];
    if (scope === 'branch') {
      const entries = String(await git(target.repository, ['diff', '--name-status', '-z', '--no-renames', ...target.base, '--'])).split('\0');
      for (let i = 0; i + 1 < entries.length; i += 2) files.push({ status: entries[i], relativePath: entries[i + 1] });
    } else {
      const entries = String(await git(target.repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]; if (!entry) continue;
        const status = entry.slice(0, 2);
        files.push({ status: status.trim(), relativePath: entry.slice(3) });
        if (/[RC]/.test(status)) i++;
      }
    }
    // Apply the chat's selected/touched folder boundary before pagination.
    files = files.filter(file => {
      const relative = path.relative(path.resolve(root), path.resolve(target.repository, file.relativePath));
      return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    });
    const stats = new Map();
    const numstat = String(await git(target.repository, ['diff', '--numstat', '-z', '--no-renames', ...(!target.hasHead && scope === 'working' ? ['--cached'] : []), ...target.base, '--']).catch(() => ''));
    for (const entry of numstat.split('\0')) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
      if (match && match[1] !== '-') stats.set(match[3], { linesAdded: Number(match[1]), linesRemoved: Number(match[2]) });
    }
    return { root: target.repository, branch: target.branch, upstream: target.upstream, baseRef: target.baseRef, references: target.references, gitDirectory: target.gitDirectory, files: files.slice(0, 1000).map(file => ({ ...file, ...stats.get(file.relativePath), filepath: path.join(target.repository, file.relativePath), filename: path.basename(file.relativePath), directory: file.relativePath.endsWith('/'), isEdit: true })), truncated: files.length > 1000 };
  });
  ipcMain.handle('workspace-review-diff', async (event, root, relativePath, scope = 'working', expanded = false, baseRef = '') => {
    authorize(event);
    const target = await reviewTarget(root, scope, baseRef);
    const absolute = path.resolve(target.repository, relativePath);
    const relative = path.relative(target.repository, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Invalid review path.');
    let patch = String(await git(target.repository, ['diff', '--no-ext-diff', '--no-color', '--no-renames', expanded ? '--unified=10000' : '--unified=6', ...target.base, '--', relative]));
    // With no initial commit, the complete current contents of a new file are
    // additions, including files already added to the index.
    if (!target.hasHead && scope === 'working') {
      const stat = await fsp.stat(absolute).catch(() => null);
      if (stat?.isFile() && stat.size <= 2 * 1024 * 1024) {
        const content = await fsp.readFile(absolute, 'utf8');
        if (content.includes('\0')) return { diffLines: [], notice: 'Binary file added.' };
        return addedFileLines(content);
      }
    }
    if (!patch) {
      const tracked = await git(target.repository, ['ls-files', '--error-unmatch', '--', relative]).then(() => true, () => false);
      if (!tracked) {
        const stat = await fsp.stat(absolute);
        if (stat.isDirectory()) return { diffLines: [], notice: 'New folder. Open Files to explore its contents.' };
        if (stat.size > 2 * 1024 * 1024) return { diffLines: [], notice: 'File is too large for an inline diff.' };
        const content = await fsp.readFile(absolute, 'utf8');
        if (content.includes('\0')) return { diffLines: [], notice: 'Binary file added.' };
        return addedFileLines(content);
      }
    }
    let oldLine = 0, newLine = 0;
    const diffLines = [];
    for (const line of patch.split(/\r?\n/)) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); diffLines.push({ type: 'context', content: line }); }
      else if (oldLine || newLine) {
        if (line.startsWith('+')) diffLines.push({ type: 'added', content: line.slice(1), newLine: newLine++ });
        else if (line.startsWith('-')) diffLines.push({ type: 'removed', content: line.slice(1), oldLine: oldLine++ });
        else if (line.startsWith(' ')) diffLines.push({ type: 'unchanged', content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
      }
      if (diffLines.length >= 10000) break;
    }
    return { diffLines, truncated: diffLines.length >= 10000, notice: /Binary files/.test(patch) ? 'Binary file changed.' : '' };
  });
};
