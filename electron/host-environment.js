const fs = require('fs');
const path = require('path');
const os = require('os');

function pythonEnvironmentRoot(location) {
  if (!location || !path.isAbsolute(location)) return null;
  let directory = location;
  try { if (fs.statSync(directory).isFile()) directory = path.dirname(directory); } catch { return null; }
  // Covers venv/bin, venv/Scripts and Conda's Library/bin without walking
  // arbitrary ancestors or resolving venv symlinks to the base installation.
  for (let depth = 0; depth < 4; depth++) {
    if (fs.existsSync(path.join(directory, 'pyvenv.cfg')) || fs.existsSync(path.join(directory, 'conda-meta'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function environmentValue(env, name) {
  const key = process.platform === 'win32' ? Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) : name;
  return key ? env[key] : undefined;
}

function createHostEnvironment(base = process.env, overrides = {}) {
  const env = {};
  const set = (key, value) => {
    const prior = process.platform === 'win32' ? Object.keys(env).find(k => k.toLowerCase() === key.toLowerCase()) : key;
    if (prior && prior !== key) delete env[prior];
    if (value !== undefined) env[key] = value;
    else delete env[key];
  };
  for (const [key, value] of Object.entries(base)) set(key, value);
  for (const key of Object.keys(env)) {
    if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|VIRTUAL_ENV(?:_PROMPT)?|CONDA_.*|_CE_CONDA|_CE_M|_OLD_VIRTUAL_.*|PYTHONHOME|PYTHONPATH|PYTHONUSERBASE|PIP_TARGET|PIP_PREFIX|PIP_USER|__PYVENV_LAUNCHER__)$/i.test(key)) delete env[key];
  }
  const pathKey = (process.platform === 'win32' ? Object.keys(env).find(k => k.toLowerCase() === 'path') : 'PATH') || 'PATH';
  // A desktop app may be launched from another application's activated venv.
  // That environment is not the selected chat/project environment. Explicit
  // invocation overrides are applied last so users can still select one.
  const entries = String(env[pathKey] || '').split(path.delimiter)
    .map(entry => entry.replace(/^"|"$/g, '')).filter(entry => path.isAbsolute(entry) && !pythonEnvironmentRoot(entry));
  const home = os.homedir();
  const extra = process.platform === 'win32'
    ? [path.join(environmentValue(env, 'SystemRoot') || 'C:\\Windows', 'System32'), path.join(environmentValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')]
    : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  for (const directory of extra) if (!entries.includes(directory) && fs.existsSync(directory)) entries.push(directory);
  env[pathKey] = entries.join(path.delimiter);
  for (const [key, value] of Object.entries(overrides)) set(key, value);
  return env;
}

function findHostExecutable(candidates, env = createHostEnvironment()) {
  const pathKey = (process.platform === 'win32' ? Object.keys(env).find(k => k.toLowerCase() === 'path') : 'PATH') || 'PATH';
  const extensions = process.platform === 'win32' ? String(environmentValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const names = process.platform === 'win32' && !path.extname(candidate) ? [candidate, ...extensions.map(ext => candidate + ext.toLowerCase())] : [candidate];
    const directories = path.isAbsolute(candidate) ? [''] : String(env[pathKey] || '').split(path.delimiter).filter(Boolean).map(dir => dir.replace(/^"|"$/g, ''));
    for (const directory of directories) for (const name of names) {
      const file = directory ? path.resolve(directory, name) : name;
      if (process.platform === 'win32' && /[\\/]Microsoft[\\/]WindowsApps[\\/]python(?:3)?\.exe$/i.test(file)) continue;
      try {
        if (!fs.statSync(file).isFile()) continue;
        fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

module.exports = { createHostEnvironment, findHostExecutable, pythonEnvironmentRoot, environmentValue };
