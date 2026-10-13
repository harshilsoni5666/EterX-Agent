const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile, spawn } = require('child_process');
const { createHostEnvironment, environmentValue, findHostExecutable } = require('./host-environment');

// IDs are persisted by the renderer. Keep them independent of installation paths.
const applications = [
  { id: 'code', name: 'VS Code', mac: ['Visual Studio Code.app'], win: ['Microsoft VS Code/Code.exe'], commands: ['code'], desktop: ['code', 'com.visualstudio.code'], folders: true },
  { id: 'code-insiders', name: 'VS Code Insiders', mac: ['Visual Studio Code - Insiders.app'], win: ['Microsoft VS Code Insiders/Code - Insiders.exe'], commands: ['code-insiders'], desktop: ['code-insiders', 'com.visualstudio.code.insiders'], folders: true },
  { id: 'cursor', name: 'Cursor', mac: ['Cursor.app'], win: ['Cursor/Cursor.exe'], commands: ['cursor'], desktop: ['cursor', 'com.cursor.Cursor'], folders: true },
  { id: 'antigravity', name: 'Antigravity', mac: ['Antigravity.app'], win: ['Antigravity/Antigravity.exe'], commands: ['antigravity'], desktop: ['antigravity', 'com.google.Antigravity'], folders: true },
  { id: 'windsurf', name: 'Windsurf', mac: ['Windsurf.app'], win: ['Windsurf/Windsurf.exe'], commands: ['windsurf'], desktop: ['windsurf', 'com.windsurf.Windsurf'], folders: true },
  { id: 'zed', name: 'Zed', mac: ['Zed.app'], win: ['Zed/zed.exe'], commands: ['zed', 'zeditor'], desktop: ['dev.zed.Zed', 'zed'], folders: true },
  { id: 'sublime', name: 'Sublime Text', mac: ['Sublime Text.app'], win: ['Sublime Text/sublime_text.exe', 'Sublime Text 3/sublime_text.exe'], commands: ['subl', 'sublime_text'], desktop: ['sublime_text', 'com.sublimetext.three', 'com.sublimetext.four'], folders: true },
  { id: 'notepad++', name: 'Notepad++', win: ['Notepad++/notepad++.exe'], commands: [], folders: false },
  { id: 'notepad', name: 'Notepad', win: ['notepad.exe'], commands: [], folders: false },
  { id: 'textedit', name: 'TextEdit', mac: ['TextEdit.app'], commands: [], folders: false },
  { id: 'kate', name: 'Kate', commands: ['kate'], desktop: ['org.kde.kate', 'kate'], folders: true },
  { id: 'gedit', name: 'Text Editor (gedit)', commands: ['gedit'], desktop: ['org.gnome.gedit', 'gedit'], folders: false },
  { id: 'gnome-text-editor', name: 'GNOME Text Editor', commands: ['gnome-text-editor'], desktop: ['org.gnome.TextEditor'], folders: false },
  { id: 'pycharm', name: 'PyCharm', mac: ['PyCharm.app', 'PyCharm CE.app', 'PyCharm Community Edition.app'], win: ['JetBrains/PyCharm/bin/pycharm64.exe'], commands: ['pycharm', 'pycharm-community', 'pycharm-professional'], desktop: ['jetbrains-pycharm', 'jetbrains-pycharm-ce', 'pycharm', 'com.jetbrains.PyCharm-Community', 'com.jetbrains.PyCharm-Professional'], folders: true },
];

const unique = values => [...new Set(values.filter(Boolean))];
const matchesMacBundle = (definition, file) => definition.mac?.some(name => name.toLowerCase() === path.basename(file).toLowerCase())
  || (definition.id === 'pycharm' && /^PyCharm(?:[ ._-].*)?\.app$/i.test(path.basename(file)));
const run = (command, args, env) => new Promise((resolve, reject) => {
  execFile(command, args, { env, windowsHide: true, timeout: 6000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
async function accessible(file, bundle = false) {
  try {
    const stat = await fsp.stat(file);
    if (bundle ? !stat.isDirectory() : !stat.isFile()) return false;
    await fsp.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch { return false; }
}

async function windowsRegistrations(env) {
  // App Paths and Start Menu shortcuts cover custom and per-user installations.
  // Resolve shortcuts as data; never run a shortcut or a discovered command line.
  const names = applications.filter(item => item.win).map(item => ({ id: item.id, name: item.name, executables: unique(item.win.map(file => path.win32.basename(file))) }));
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$definitions = '${JSON.stringify(names).replace(/'/g, "''")}' | ConvertFrom-Json
$results = @()
foreach ($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
  foreach ($definition in $definitions) {
    foreach ($exe in $definition.executables) {
      $key = Get-Item -LiteralPath (Join-Path $root $exe)
      if ($key) { $value = $key.GetValue(''); if ($value) { $results += @{ id = $definition.id; executable = [Environment]::ExpandEnvironmentVariables($value).Trim('"') } } }
    }
  }
}
$wsh = New-Object -ComObject WScript.Shell
foreach ($root in @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'))) {
  if (!$root) { continue }
  foreach ($link in (Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -File)) {
    if ($link.BaseName -notmatch 'Visual Studio Code|VS Code|Cursor|Antigravity|Windsurf|Zed|Sublime|Notepad|PyCharm' -or $link.BaseName -match 'uninstall') { continue }
    $target = $wsh.CreateShortcut($link.FullName).TargetPath
    foreach ($definition in $definitions) {
      if ($target -and $definition.executables -contains [IO.Path]::GetFileName($target)) { $results += @{ id = $definition.id; executable = $target }; break }
    }
  }
}
ConvertTo-Json -InputObject @($results) -Compress
`;
  const powershell = findHostExecutable(['powershell.exe'], env);
  if (!powershell) return [];
  try {
    const output = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env);
    const records = JSON.parse(output.replace(/^\uFEFF/, '').trim());
    return Array.isArray(records) ? records.filter(item => typeof item?.executable === 'string' && path.isAbsolute(item.executable) && /\.exe$/i.test(item.executable)) : [];
  } catch { return []; }
}

async function macBundles(home, env) {
  const roots = ['/Applications', path.join(home, 'Applications'), '/System/Applications', '/System/Applications/Utilities', '/Applications/Utilities'];
  const found = [];
  await Promise.all(roots.map(async root => {
    try { found.push(...(await fsp.readdir(root)).filter(name => name.endsWith('.app')).map(name => path.join(root, name))); } catch {}
  }));
  // Spotlight also finds installations outside /Applications. Standard paths
  // remain usable when indexing is disabled or Spotlight is unavailable.
  const names = [...applications.flatMap(item => item.mac || []), 'PyCharm*.app'];
  const query = names.map(name => `kMDItemFSName == "${name}"c`).join(' || ');
  const output = await run('/usr/bin/mdfind', ['-0', `kMDItemContentType == "com.apple.application-bundle" && (${query})`], env).catch(() => '');
  found.push(...output.split('\0').filter(file => path.isAbsolute(file) && !file.startsWith('/Volumes/') && !file.includes('/.Trash/')));
  return unique(found);
}

function desktopValues(source) {
  const values = {};
  let entry = false;
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('[')) { entry = line.trim() === '[Desktop Entry]'; continue; }
    if (!entry || line.startsWith('#')) continue;
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/\\([sntr\\])/g, (_, char) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[char]);
  }
  return values;
}

// Desktop Exec is an argument list, not a shell command. Quoted paths, Flatpak
// flags and file/URI placeholders must survive without shell interpolation.
function desktopArgs(value) {
  const args = [];
  let token = '', quoted = false, started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"') { quoted = !quoted; started = true; }
    else if (char === '\\' && i + 1 < value.length && (!quoted || /["`$\\]/.test(value[i + 1]))) { token += value[++i]; started = true; }
    else if (/\s/.test(char) && !quoted) { if (started) args.push(token); token = ''; started = false; }
    else { token += char; started = true; }
  }
  if (quoted) return [];
  if (started) args.push(token);
  return args;
}

async function linuxEntries(home, env) {
  const dataRoots = unique([env.XDG_DATA_HOME || path.join(home, '.local/share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'), path.join(home, '.local/share/flatpak/exports/share'), '/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop']).filter(root => path.isAbsolute(root));
  const records = [], seen = new Set();
  // User desktop files override system files, including Hidden=true entries.
  for (const root of dataRoots) {
    const directory = path.join(root, 'applications');
    const names = await fsp.readdir(directory).catch(() => []);
    for (const name of names.filter(name => name.endsWith('.desktop')).sort()) {
      if (seen.has(name)) continue;
      seen.add(name);
      const filename = path.join(directory, name);
      const stat = await fsp.stat(filename).catch(() => null);
      if (!stat?.isFile() || stat.size > 256 * 1024) continue;
      const source = await fsp.readFile(filename, 'utf8').catch(() => '');
      const values = desktopValues(source);
      if (values.Type !== 'Application' || values.Hidden === 'true' || values.NoDisplay === 'true' || values.Terminal === 'true' || !values.Exec) continue;
      const args = desktopArgs(values.Exec);
      const command = args.shift();
      if (!command || (values.TryExec && !findHostExecutable([values.TryExec], env))) continue;
      const executable = findHostExecutable([command], env);
      if (!executable) continue;
      const id = name.slice(0, -8).toLowerCase();
      const definition = applications.find(item => item.desktop?.some(alias => id === alias.toLowerCase() || id === `${alias.toLowerCase()}_${alias.toLowerCase()}`)
        || (item.desktop && (values.Name?.toLowerCase() === item.name.toLowerCase() || item.commands.includes(path.basename(command)))));
      if (definition) records.push({ id: definition.id, executable, args, desktopFile: filename, iconName: values.Icon, displayName: values.Name || definition.name, cwd: values.Path });
    }
  }
  return { records, dataRoots };
}

async function linuxIconDirectories(roots, home) {
  const directories = [];
  for (const root of unique([path.join(home, '.icons'), ...roots.map(root => path.join(root, 'icons'))])) {
    const themes = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const theme of unique(['hicolor', ...themes.filter(item => item.isDirectory() || item.isSymbolicLink()).map(item => item.name)])) {
      const themeRoot = path.join(root, theme);
      const manifest = await fsp.readFile(path.join(themeRoot, 'index.theme'), 'utf8').catch(() => '');
      const declared = [...manifest.matchAll(/^(?:ScaledDirectories|Directories)=(.*)$/gm)].flatMap(match => match[1].trim().split(','));
      const sizes = ['48x48', '32x32', '64x64', '24x24', '16x16', '128x128', '256x256', '512x512', 'scalable', 'symbolic'];
      const relative = unique([...sizes.map(size => `${size}/apps`), ...declared.filter(dir => /(?:apps|applications)/i.test(dir)), ...declared]);
      for (const directory of relative) {
        if (path.isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) continue;
        directories.push(path.join(themeRoot, directory));
      }
    }
    directories.push(root);
  }
  return unique([...directories, ...roots.map(root => path.join(root, 'pixmaps'))]);
}

async function linuxIcon(iconName, directories) {
  if (!iconName) return undefined;
  let candidates = [];
  if (path.isAbsolute(iconName)) candidates.push(iconName);
  else if (!/[\\/]/.test(iconName)) {
    const names = /\.(png|svg|jpe?g)$/i.test(iconName) ? [iconName] : [iconName + '.png', iconName + '.svg'];
    candidates = directories.flatMap(directory => names.map(name => path.join(directory, name)));
  }
  for (let index = 0; index < candidates.length; index += 32) {
    const images = await Promise.all(candidates.slice(index, index + 32).map(async filename => {
      try {
        const stat = await fsp.stat(filename);
        if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
        const mime = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[path.extname(filename).toLowerCase()];
        if (mime) return `data:${mime};base64,${(await fsp.readFile(filename)).toString('base64')}`;
      } catch {}
      return undefined;
    }));
    const icon = images.find(Boolean);
    if (icon) return icon;
  }
  return undefined;
}

exports.createWorkspaceAppFinder = app => {
  let cache, pending;
  const iconCache = new Map();
  async function discover() {
    const home = app.getPath('home');
    const env = createHostEnvironment();
    const platform = process.platform;
    const [registered, bundles, linux] = await Promise.all([
      platform === 'win32' ? windowsRegistrations(env) : [],
      platform === 'darwin' ? macBundles(home, env) : [],
      platform === 'linux' ? linuxEntries(home, env) : { records: [], dataRoots: [] },
    ]);
    const local = environmentValue(env, 'LOCALAPPDATA');
    const winRoots = unique([local && path.join(local, 'Programs'), local, environmentValue(env, 'ProgramW6432'), environmentValue(env, 'ProgramFiles'), environmentValue(env, 'ProgramFiles(x86)')]);
    const iconDirectories = platform === 'linux' ? await linuxIconDirectories(linux.dataRoots, home) : [];
    const found = await Promise.all(applications.map(async definition => {
      let candidates = [];
      if (platform === 'darwin' && definition.mac) {
        candidates = unique([...['/Applications', path.join(home, 'Applications'), '/System/Applications'].flatMap(root => definition.mac.map(name => path.join(root, name))), ...bundles.filter(file => matchesMacBundle(definition, file))]).map(executable => ({ executable, bundle: true }));
        for (const command of definition.commands) {
          const launcher = findHostExecutable([command], env);
          if (!launcher) continue;
          const real = await fsp.realpath(launcher).catch(() => launcher);
          const bundleEnd = real.toLowerCase().lastIndexOf('.app/');
          candidates.push(bundleEnd >= 0 ? { executable: real.slice(0, bundleEnd + 4), bundle: true } : { executable: launcher });
        }
      } else if (platform === 'win32' && definition.win) {
        candidates = [...registered.filter(item => item.id === definition.id), ...winRoots.flatMap(root => definition.win.map(relative => ({ executable: path.join(root, relative) })))];
        if (definition.id === 'notepad') candidates.unshift({ executable: path.join(environmentValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'notepad.exe') });
        for (const executableName of unique(definition.win.map(file => path.win32.basename(file)))) {
          const executable = findHostExecutable([executableName], env);
          if (executable) candidates.push({ executable });
        }
        // Editor command shims live under <install>/bin. Launch the actual exe,
        // never a .cmd through cmd.exe, so file names stay literal arguments.
        for (const command of definition.commands) {
          const shim = findHostExecutable([command + '.cmd'], env);
          if (!shim) continue;
          const real = await fsp.realpath(shim).catch(() => shim);
          for (const relative of definition.win) candidates.push({ executable: path.join(path.dirname(path.dirname(real)), path.win32.basename(relative)) });
        }
        if (definition.id === 'pycharm') for (const root of winRoots) {
          const directory = path.join(root, 'JetBrains');
          const entries = await fsp.readdir(directory).catch(() => []);
          candidates.push(...entries.filter(name => /^PyCharm/i.test(name)).reverse().map(name => ({ executable: path.join(directory, name, 'bin', 'pycharm64.exe') })));
        }
      } else if (platform === 'linux' && definition.desktop) {
        candidates = linux.records.filter(item => item.id === definition.id);
        for (const command of definition.commands) {
          const executable = findHostExecutable([command, path.join('/snap/bin', command)], env);
          if (executable) candidates.push({ executable });
        }
      }
      for (const candidate of candidates) {
        if (!await accessible(candidate.executable, candidate.bundle)) continue;
        const iconKey = [candidate.executable, candidate.iconName || '', candidate.desktopFile || ''].join('\0');
        let icon = iconCache.get(iconKey);
        if (!icon) {
          if (platform === 'linux') icon = await linuxIcon(candidate.iconName || definition.desktop?.[0] || definition.id, iconDirectories);
          if (!icon) try {
            const nativeIcon = await app.getFileIcon(candidate.executable, { size: 'normal' });
            if (!nativeIcon.isEmpty()) icon = nativeIcon.toDataURL();
          } catch {}
          if (icon) { if (iconCache.size >= 64) iconCache.clear(); iconCache.set(iconKey, icon); }
        }
        return { ...candidate, id: definition.id, name: definition.name, folders: definition.folders, icon };
      }
      return null;
    }));
    return found.filter(Boolean);
  }
  return {
    async find(force = false) {
      if (pending) return pending;
      if (!force && cache && Date.now() - cache.time < 30000) return cache.value;
      pending = discover().then(value => { cache = { value, time: Date.now() }; return value; }).finally(() => { pending = undefined; });
      return pending;
    },
    invalidate() { cache = undefined; },
  };
};

exports.launchWorkspaceApp = async (selected, filePath) => {
  const env = createHostEnvironment();
  if (selected.bundle) {
    await run('/usr/bin/open', ['-a', selected.executable, filePath], env);
    return;
  }
  let supplied = false;
  const args = [];
  for (const argument of selected.args || []) {
    if (argument === '%i') { if (selected.iconName) args.push('--icon', selected.iconName); continue; }
    if (/^%[fFuU]$/.test(argument)) { supplied = true; args.push(/[uU]/.test(argument) ? pathToFileURL(filePath).href : filePath); continue; }
    if (/^%[dDnNvm]$/.test(argument)) continue;
    const expanded = argument.replace(/%([%ckfFuU])/g, (_, code) => {
      if (code === '%') return '%';
      if (code === 'c') return selected.displayName || selected.name;
      if (code === 'k') return selected.desktopFile || '';
      supplied = true;
      return /[uU]/.test(code) ? pathToFileURL(filePath).href : filePath;
    });
    args.push(expanded);
  }
  if (!supplied) args.push(filePath);
  let cwd = path.dirname(filePath);
  if (selected.cwd && path.isAbsolute(selected.cwd) && await fsp.stat(selected.cwd).then(stat => stat.isDirectory(), () => false)) cwd = selected.cwd;
  await new Promise((resolve, reject) => {
    const child = spawn(selected.executable, args, { cwd, env, detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    let timer, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.unref();
      if (error) reject(error); else resolve();
    };
    child.once('error', finish);
    child.once('exit', (code, signal) => finish(code === 0 ? undefined : new Error(`${selected.name} could not open this path (${signal || 'exit ' + code}).`)));
    // GUI processes stay alive; short-lived CLI launchers must get a chance to
    // report failure before the UI persists this application as the preference.
    child.once('spawn', () => { timer = setTimeout(() => finish(), 1200); });
  });
};
