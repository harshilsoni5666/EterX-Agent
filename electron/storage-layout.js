const path = require('path');
const os = require('os');
const { isAbsoluteHostPath } = require('./workspace-layout');

function absoluteEnvironmentPath(value) {
  const candidate = String(value || '').trim();
  return isAbsoluteHostPath(candidate) ? path.normalize(candidate) : null;
}

// Shared by Electron and the server so launch cwd and malformed XDG variables
// cannot move credentials or workspaces into the installation directory.
function installedProfileRoot() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(absoluteEnvironmentPath(process.env.LOCALAPPDATA)
      || path.join(home, 'AppData', 'Local'), 'EterX');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'EterX');
  return path.join(absoluteEnvironmentPath(process.env.XDG_DATA_HOME)
    || path.join(home, '.local', 'share'), 'EterX');
}

function dataRoot() {
  const configured = String(process.env.ETERX_DATA_DIR || '').trim();
  if (configured && !absoluteEnvironmentPath(configured)) throw new Error('ETERX_DATA_DIR must be an absolute path.');
  return absoluteEnvironmentPath(configured) || path.join(installedProfileRoot(), 'data');
}

function workspaceRoot() {
  const configured = String(process.env.ETERX_WORKSPACE_ROOT || '').trim();
  if (configured && !absoluteEnvironmentPath(configured)) throw new Error('ETERX_WORKSPACE_ROOT must be an absolute path.');
  return absoluteEnvironmentPath(configured) || path.join(dataRoot(), '.workspaces');
}

module.exports = { absoluteEnvironmentPath, installedProfileRoot, dataRoot, workspaceRoot };
