const path = require('path');
const { createHostEnvironment, environmentValue, findHostExecutable } = require('./host-environment');

const shellNames = ['auto', 'powershell', 'cmd', 'git-bash', 'wsl', 'zsh', 'bash', 'fish', 'sh'];

// The desktop terminal and agent commands must discover the same shells as
// Settings. Windows environment keys are case-insensitive, including COMSPEC.
function shellCandidates(platform, env) {
  if (platform === 'win32') {
    const root = environmentValue(env, 'SystemRoot') || environmentValue(env, 'WINDIR') || 'C:\\Windows';
    const programFiles = environmentValue(env, 'ProgramFiles') || 'C:\\Program Files';
    const local = environmentValue(env, 'LOCALAPPDATA');
    const powershell = [
      'pwsh.exe', path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      'powershell.exe', path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ];
    const cmd = [environmentValue(env, 'ComSpec'), path.win32.join(root, 'System32', 'cmd.exe'), 'cmd.exe'];
    const bash = [
      path.win32.join(programFiles, 'Git', 'bin', 'bash.exe'),
      path.win32.join(environmentValue(env, 'ProgramFiles(x86)') || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      ...(local ? [path.win32.join(local, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
      'bash.exe',
    ];
    return { auto: [...powershell, ...cmd], powershell, cmd, 'git-bash': bash, bash, wsl: ['wsl.exe', path.win32.join(root, 'System32', 'wsl.exe')] };
  }
  // Account shells such as nologin are executable, but cannot host a terminal.
  const loginShell = typeof env.SHELL === 'string' && !/^(?:false|nologin)$/i.test(path.posix.basename(env.SHELL)) ? env.SHELL : undefined;
  return {
    auto: [loginShell, ...(platform === 'darwin' ? ['/bin/zsh', 'zsh'] : []), '/bin/bash', 'bash', '/bin/sh'],
    powershell: ['pwsh', '/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', '/usr/bin/pwsh'],
    zsh: ['/bin/zsh', '/usr/bin/zsh', 'zsh'],
    bash: ['/bin/bash', '/usr/bin/bash', 'bash'],
    fish: ['fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'],
    sh: ['/bin/sh', '/usr/bin/sh', 'sh'],
  };
}

function resolveHostShell(preference = 'auto', env = createHostEnvironment(), platform = process.platform, allowCustom = false) {
  const requested = String(preference || 'auto').trim() || 'auto';
  const selected = requested.toLowerCase();
  const choices = shellCandidates(platform, env);
  const candidates = Object.prototype.hasOwnProperty.call(choices, selected)
    ? choices[selected]
    : allowCustom && !shellNames.includes(selected) ? [requested] : [];
  const file = findHostExecutable(candidates, env);
  if (!file) throw new Error(`The selected terminal shell "${requested}" is not available on this device. Choose an installed shell in Settings.`);
  return file;
}

function availableHostShells(env = createHostEnvironment(), platform = process.platform) {
  const choices = shellCandidates(platform, env);
  const names = platform === 'win32' ? ['powershell', 'cmd', 'git-bash', 'wsl'] : ['zsh', 'bash', 'fish', 'sh', 'powershell'];
  return ['auto', ...names.filter(name => findHostExecutable(choices[name], env))];
}

module.exports = { resolveHostShell, availableHostShells };
