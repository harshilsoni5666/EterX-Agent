const fs = require('fs/promises');
const path = require('path');
const { chatWorkspacePaths, isAbsoluteHostPath } = require('./workspace-layout');
const { workspaceRoot } = require('./storage-layout');

// Request-scoped roots: a selection wins; otherwise start in this chat's own
// working directory and include folders containing its actual file activity.
exports.resolveWorkspaceRoots = async (options = {}) => {
  if (options.workspacePath) {
    if (!isAbsoluteHostPath(options.workspacePath)) throw new Error('Select an absolute folder path on this device. Paths from another OS are not remapped.');
    const directory = path.normalize(options.workspacePath);
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new Error('The selected workspace is not a folder.');
    return [directory];
  }
  const roots = [];
  if (typeof options.chatId === 'string' && options.chatId.trim() && process.env.ETERX_DATA_DIR) {
    const owned = chatWorkspacePaths(workspaceRoot(), 'default', options.chatId);
    await fs.mkdir(owned.workspace, { recursive: true });
    roots.push(owned.workspace);
  }
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const inside = (child, parent) => { const relative = path.relative(key(parent), key(child)); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };
  const seen = new Set();
  for (const item of Array.isArray(options.touched) ? options.touched : []) {
    if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path)) continue;
    const target = path.normalize(item.path);
    if (seen.has(key(target))) continue;
    seen.add(key(target));
    let directory;
    if (item.kind === 'file') directory = path.dirname(target);
    else if (item.kind === 'directory') directory = target;
    else {
      const stat = await fs.stat(target).catch(() => null);
      directory = stat?.isDirectory() ? target : path.dirname(target);
    }
    if (roots.some(root => inside(directory, root))) continue;
    for (let i = roots.length - 1; i >= 0; i--) if (inside(roots[i], directory)) roots.splice(i, 1);
    roots.push(directory);
  }
  return roots;
};
