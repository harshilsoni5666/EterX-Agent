export type WorkspaceTouch = { path: string; kind: 'file' | 'directory' | 'unknown' };

export function workspacePathKey(value: string) {
  const slashes = value.replace(/\\/g, '/');
  const prefix = slashes.startsWith('//') ? '//' : slashes.startsWith('/') ? '/' : '';
  const segments: string[] = [];
  const protectedSegments = prefix === '//' ? 2 : /^[a-z]:/i.test(slashes) ? 1 : 0;
  for (const segment of slashes.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && segments.length > protectedSegments) segments.pop();
    else if (segment !== '..') segments.push(segment);
  }
  const normalized = prefix + segments.join('/') || '/';
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}
export function isWithinWorkspace(path: string, root: string) {
  const child = workspacePathKey(path), parent = workspacePathKey(root);
  return child === parent || child.startsWith(parent === '/' ? '/' : parent + '/');
}
export function workspaceParent(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return normalized;
  const parent = normalized.slice(0, index);
  return /^[a-z]:$/i.test(parent) ? parent + '/' : parent || '/';
}
export function compactWorkspaceRoots(paths: string[]) {
  const roots: string[] = [];
  for (const path of paths) {
    if (!path || roots.some(root => isWithinWorkspace(path, root))) continue;
    for (let i = roots.length - 1; i >= 0; i--) if (isWithinWorkspace(roots[i], path)) roots.splice(i, 1);
    roots.push(path);
  }
  return roots;
}
export function workspaceRootForFile(roots: string[], path?: string) {
  return path ? roots.filter(root => isWithinWorkspace(path, root)).sort((a, b) => b.length - a.length)[0] || workspaceParent(path) : roots[0] || '';
}
const absolute = (value: string) => /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value);
export function resolveTouchPath(value: unknown, cwd: string) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let path = value.trim();
  if (/^file:\/\//i.test(path)) {
    try { const url = new URL(path); path = decodeURIComponent(url.pathname); if (url.hostname) path = '//' + url.hostname + path; else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1); } catch { return ''; }
  }
  if (absolute(path)) return path;
  return cwd && absolute(cwd) && !/^[a-z][\w+.-]*:/i.test(path) ? cwd.replace(/[\\/]$/, '') + '/' + path : '';
}

// Read structured evidence from this transcript only. Never scrape assistant
// prose or use an application's global last-folder/default working directory.
export function collectWorkspaceTouches(logs: any[], owner: string, workspacePath?: string | null): WorkspaceTouch[] {
  const found = new Map<string, WorkspaceTouch>();
  for (const log of logs) {
    if (!log || (log.ownerChatId && log.ownerChatId !== owner) || log.isLive || log.isStreaming || ['running', 'pending', 'error', 'failed', 'cancelled'].includes(log.status) || log.streamState === 'open') continue;
    if (!/^(file_preview|file_edit|file_read|file_create|folder_read|folder_create|command|console_output|tool_result_preview|tool_result|exploration)$/.test(log.type || '')) continue;
    const rawResult = log.fileOperationResult || log.toolResult || log.result || {};
    let result = rawResult;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = {}; } }
    if (!result || typeof result !== 'object') result = {};
    if (result.success === false || result.rolledBack || log.error) continue;
    const args = log.toolArgs || log.args || log.toolInput || {};
    const cwd = [result.cwd, log.cwd, args.cwd, log.workspacePath, workspacePath].find(value => typeof value === 'string' && absolute(value)) || '';
    const add = (value: unknown, kind: WorkspaceTouch['kind']) => {
      const path = resolveTouchPath(value, cwd);
      if (!path) return;
      const key = workspacePathKey(path);
      if (!found.has(key) || kind !== 'unknown') found.set(key, { path, kind });
    };
    const addItem = (item: any, kind: WorkspaceTouch['kind']) => typeof item === 'string' ? add(item, kind) : item && add(item.filepath || item.filePath || item.path || item.file, item.type === 'directory' || item.isDirectory ? 'directory' : kind);
    const tool = log.toolName || log.tool || '';
    const isFileAction = /^file_/.test(log.type) || /^file_/.test(log.iconCategory || '') || /^workspace_(read|edit|create|delete)_file$/.test(tool);
    const isFolderCreation = log.type === 'folder_create' || log.iconCategory === 'folder_create';
    const target = [log.filepath, log.filePath, result.filepath, result.filePath].map(value => resolveTouchPath(value, cwd)).find(Boolean);
    if (target) add(target, 'file');
    // Mutation receipts identify actual outputs. A directory listing's `files`
    // and a shell's cwd describe its surroundings, not this chat's workspace.
    for (const key of ['filesCreated', 'filesModified', 'filesDeleted']) {
      for (const item of Array.isArray(result[key]) ? result[key] : []) addItem(item, 'file');
    }
    if (isFileAction) {
      // `filename` is frequently a display-only basename. Never resolve it a
      // second time against cwd when the same trace supplies the real filepath.
      if (!target) {
        const explicit = [args.filePath, args.filepath, args.file_path, args.TargetFile, args.targetFile, args.path, log.path, args.filename, log.filename]
          .map(value => resolveTouchPath(value, cwd)).find(Boolean);
        if (explicit) add(explicit, 'file');
      }
      for (const item of Array.isArray(args.files) ? args.files : []) addItem(item, 'file');
    }
    if (isFolderCreation) {
      const directory = [result.folderPath, result.directoryPath, result.path, args.path, args.directoryPath, args.folderPath, args.directory, args.dir, log.path, log.folderPath]
        .map(value => resolveTouchPath(value, cwd)).find(Boolean);
      if (directory) add(directory, 'directory');
    }
  }
  return [...found.values()];
}
