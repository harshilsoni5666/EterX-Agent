const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHostEnvironment, findHostExecutable, pythonEnvironmentRoot, environmentValue } = require('./host-environment');

const pythonNames = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
const binDirectory = root => path.join(root, process.platform === 'win32' ? 'Scripts' : 'bin');
let systemPythonCache;
const inside = (root, directory) => {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function workspaceDirectories(cwd, workspaceRoot = cwd) {
  if (!cwd || !path.isAbsolute(cwd)) return [];
  const directories = [cwd];
  if (!workspaceRoot || !inside(workspaceRoot, cwd)) return directories;
  let current = cwd;
  while (current !== workspaceRoot) {
    const parent = path.dirname(current);
    if (parent === current || !inside(workspaceRoot, parent)) break;
    directories.push(parent);
    current = parent;
  }
  return directories;
}

function runtimeAt(root, source, env, explicitProgram) {
  const conda = fs.existsSync(path.join(root, 'conda-meta'));
  const directories = conda && process.platform === 'win32' ? [root, binDirectory(root)] : [binDirectory(root)];
  const program = explicitProgram || findHostExecutable(directories.flatMap(dir => pythonNames.map(name => path.join(dir, name))), env);
  return {
    program, source, environmentRoot: root, kind: conda ? 'conda' : 'venv', isolated: true,
    ...(!program ? { issue: `The selected Python environment is incomplete or unavailable: ${root}. Repair it or explicitly select another interpreter; no other environment was substituted.` } : {}),
  };
}

function cleanPython(candidate, env) {
  const program = findHostExecutable([candidate], env);
  if (!program || pythonEnvironmentRoot(program)) return null;
  try { if (pythonEnvironmentRoot(fs.realpathSync(program))) return null; } catch { return null; }
  return program;
}

function basePythonCandidates(inheritedEnv) {
  const roots = new Set();
  for (const entry of String(environmentValue(inheritedEnv, 'PATH') || '').split(path.delimiter)) {
    const root = pythonEnvironmentRoot(entry.replace(/^"|"$/g, ''));
    if (root) roots.add(root);
  }
  const active = environmentValue(inheritedEnv, 'VIRTUAL_ENV');
  if (active && path.isAbsolute(active)) roots.add(active);
  const candidates = [];
  for (const root of roots) {
    try {
      const config = Object.fromEntries(fs.readFileSync(path.join(root, 'pyvenv.cfg'), 'utf8').split(/\r?\n/)
        .map(line => /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line)).filter(Boolean).map(match => [match[1].toLowerCase(), match[2]]));
      if (config.executable && path.isAbsolute(config.executable)) candidates.push(config.executable);
      if (config.home && path.isAbsolute(config.home)) candidates.push(...pythonNames.map(name => path.join(config.home, name)));
    } catch {}
  }
  return candidates;
}

function installedPythonCandidates(env) {
  // Bounded filesystem lookup for desktop launches whose PATH is minimal.
  const roots = process.platform === 'win32'
    ? [path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Python'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)
    : process.platform === 'darwin' ? ['/Library/Frameworks/Python.framework/Versions'] : [];
  const candidates = [];
  for (const root of roots) {
    try {
      const directories = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && /^(?:Python\d[\d.]*|\d+\.\d+|Current)$/i.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      for (const directory of directories) {
        const bin = process.platform === 'win32' ? path.join(root, directory.name) : path.join(root, directory.name, 'bin');
        candidates.push(...pythonNames.map(name => path.join(bin, name)));
      }
    } catch {}
  }
  return candidates;
}

/** Describe real executables only. No subprocesses, installation or startup probes. */
function resolvePythonRuntime({ cwd, workspaceRoot = cwd, managedRoot, env = createHostEnvironment(), inheritedEnv = process.env } = {}) {
  const configured = String(environmentValue(env, 'ETERX_PYTHON_PATH') || '').trim();
  if (configured) {
    const program = findHostExecutable([configured], env);
    const root = program && pythonEnvironmentRoot(program);
    return {
      ...(root ? runtimeAt(root, 'configured', env, program) : { source: 'configured', isolated: false }),
      program, managedRoot,
      ...(!program ? { issue: `ETERX_PYTHON_PATH points to an unavailable interpreter: ${configured}. Update that setting; no other interpreter was substituted.` } : {}),
    };
  }
  for (const directory of workspaceDirectories(cwd, workspaceRoot)) {
    for (const root of [directory, path.join(directory, '.venv'), path.join(directory, 'venv')]) {
      if (fs.existsSync(path.join(root, 'pyvenv.cfg')) || fs.existsSync(path.join(root, 'conda-meta'))) {
        return { ...runtimeAt(root, 'workspace', env), managedRoot };
      }
    }
  }
  if (managedRoot && fs.existsSync(managedRoot)) {
    if (!fs.existsSync(path.join(managedRoot, 'pyvenv.cfg'))) {
      return { program: null, source: 'eterx', managedRoot, isolated: false, issue: `The EterX Python environment at ${managedRoot} has not finished initialization. Use its pending task result or repair this environment before retrying.` };
    }
    return { ...runtimeAt(managedRoot, 'eterx', env), managedRoot };
  }
  // Preserve PATH directory order across python/python3. Do not automatically
  // select a different application's venv, even if it was on the launch PATH.
  const directories = String(environmentValue(env, 'PATH') || '').split(path.delimiter).filter(dir => path.isAbsolute(dir));
  const cacheKey = [environmentValue(env, 'PATH'), environmentValue(env, 'PATHEXT'), env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)'], environmentValue(inheritedEnv, 'PATH'), environmentValue(inheritedEnv, 'VIRTUAL_ENV')].join('\0');
  if (systemPythonCache?.key === cacheKey && systemPythonCache.expires > Date.now()) {
    const program = cleanPython(systemPythonCache.program, env);
    if (program) return { program, source: 'system', isolated: false, managedRoot };
  }
  // Defer fallback discovery until the earlier source actually failed.
  for (const candidates of [
    () => directories.flatMap(dir => pythonNames.map(name => path.join(dir, name))),
    () => installedPythonCandidates(env), () => basePythonCandidates(inheritedEnv),
  ]) {
    for (const candidate of candidates()) {
      const program = cleanPython(candidate, env);
      if (program) {
        systemPythonCache = { key: cacheKey, program, expires: Date.now() + 30_000 };
        return { program, source: 'system', isolated: false, managedRoot };
      }
    }
  }
  return { program: null, source: 'unavailable', isolated: false, managedRoot, issue: 'No usable Python installation was discovered. Use another suitable available tool, or install/select Python explicitly. Do not borrow another application’s virtual environment.' };
}

/** Apply the chosen environment without executing activation scripts. */
function applyWorkspaceEnvironment(env, { cwd, workspaceRoot = cwd, runtime, overrides = {} }) {
  const result = { ...env };
  const pathKey = (process.platform === 'win32' ? Object.keys(result).find(key => key.toLowerCase() === 'path') : 'PATH') || 'PATH';
  const directories = workspaceDirectories(cwd, workspaceRoot).map(root => path.join(root, 'node_modules', '.bin')).filter(dir => fs.existsSync(dir));
  if (runtime?.program) {
    directories.push(path.dirname(runtime.program));
    if (runtime.environmentRoot) {
      if (runtime.kind === 'conda') {
        result.CONDA_PREFIX = runtime.environmentRoot;
        if (process.platform === 'win32') directories.push(path.join(runtime.environmentRoot, 'Library', 'bin'), binDirectory(runtime.environmentRoot));
      } else result.VIRTUAL_ENV = runtime.environmentRoot;
      result.PYTHONNOUSERSITE = '1';
    }
  }
  result[pathKey] = [...new Set([...directories, ...String(result[pathKey] || '').split(path.delimiter).filter(Boolean)])].join(path.delimiter);
  for (const [key, value] of Object.entries(overrides)) {
    const prior = process.platform === 'win32' ? Object.keys(result).find(entry => entry.toLowerCase() === key.toLowerCase()) : key;
    if (prior) delete result[prior];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

module.exports = { resolvePythonRuntime, applyWorkspaceEnvironment };
