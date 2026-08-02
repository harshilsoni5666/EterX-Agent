import fs from 'fs';
import path from 'path';

export type TerminalShellPreference =
  | 'auto'
  | 'powershell'
  | 'cmd'
  | 'git-bash'
  | 'wsl'
  | 'zsh'
  | 'bash'
  | 'fish'
  | 'sh';

const KNOWN_SHELLS = new Set<TerminalShellPreference>([
  'auto', 'powershell', 'cmd', 'git-bash', 'wsl', 'zsh', 'bash', 'fish', 'sh',
]);

export function normalizeTerminalShell(value: unknown): TerminalShellPreference {
  const normalized = String(value || '').trim().toLowerCase() as TerminalShellPreference;
  return KNOWN_SHELLS.has(normalized) ? normalized : 'auto';
}

export function resolveTerminalShell(preference?: unknown): string {
  const selected = normalizeTerminalShell(preference);

  if (process.platform === 'win32') {
    if (selected === 'cmd') return requireExecutable([process.env.ComSpec || 'cmd.exe', 'cmd.exe'], selected);
    if (selected === 'wsl') return requireExecutable(['wsl.exe'], selected);
    if (selected === 'git-bash' || selected === 'bash') {
      return requireExecutable([
        'bash.exe',
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
      ], selected);
    }
    if (selected === 'auto') return defaultWindowsShell();
    return requireExecutable(['powershell.exe', 'pwsh.exe'], selected);
  }

  if (selected === 'powershell') {
    return requireExecutable(['pwsh', '/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh'], selected);
  }
  if (selected === 'auto') return defaultPosixShell();
  if (['cmd', 'git-bash', 'wsl'].includes(selected)) {
    throw new Error(`The selected terminal shell "${selected}" is only available on Windows.`);
  }
  return requireExecutable(posixShellCandidates(selected), selected);
}

export function getAvailableTerminalShells(): TerminalShellPreference[] {
  const available: TerminalShellPreference[] = ['auto'];

  if (process.platform === 'win32') {
    if (findExecutable(['pwsh.exe', 'powershell.exe'])) available.push('powershell');
    if (findExecutable([process.env.ComSpec || 'cmd.exe', 'cmd.exe'])) available.push('cmd');
    if (findExecutable(['bash.exe', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')])) available.push('git-bash');
    if (findExecutable(['wsl.exe'])) available.push('wsl');
    return available;
  }

  for (const shell of ['zsh', 'bash', 'fish', 'sh'] as const) {
    if (findExecutable(posixShellCandidates(shell))) available.push(shell);
  }
  if (findExecutable(['pwsh', '/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh'])) available.push('powershell');
  return available;
}

export type TerminalShellInvocation = {
  file: string;
  args: string[];
  shell: false;
};

/**
 * Build an explicit shell invocation instead of relying on Node's `shell`
 * option. Node uses cmd.exe-style switches even when a custom Windows shell
 * is supplied, which makes PowerShell, Git Bash, and WSL commands fail or
 * behave differently across operating systems.
 */
export function buildTerminalShellInvocation(
  command: string,
  shell?: boolean | string,
): TerminalShellInvocation {
  if (shell === false) {
    return { file: command, args: [], shell: false };
  }

  const requestedShell = typeof shell === 'string' ? shell.trim() : '';
  const normalizedRequestedShell = normalizeTerminalShell(requestedShell);
  const resolvedShell = requestedShell && KNOWN_SHELLS.has(normalizedRequestedShell) && normalizedRequestedShell === requestedShell.toLowerCase()
    ? resolveTerminalShell(normalizedRequestedShell)
    : requestedShell || resolveTerminalShell();
  const shellName = path.basename(resolvedShell).toLowerCase();

  if (process.platform === 'win32') {
    if (shellName === 'cmd' || shellName === 'cmd.exe') {
      return { file: resolvedShell, args: ['/d', '/s', '/c', command], shell: false };
    }
    if (shellName === 'powershell' || shellName === 'powershell.exe' || shellName === 'pwsh' || shellName === 'pwsh.exe') {
      return {
        file: resolvedShell,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        shell: false,
      };
    }
    if (shellName === 'wsl' || shellName === 'wsl.exe') {
      return { file: resolvedShell, args: ['--', 'sh', '-lc', command], shell: false };
    }
    return { file: resolvedShell, args: [shellName === 'fish' ? '-c' : '-lc', command], shell: false };
  }

  return { file: resolvedShell, args: [shellName === 'fish' ? '-c' : '-lc', command], shell: false };
}

export function platformDefaultTerminalShell(): TerminalShellPreference {
  if (process.platform === 'win32') return 'powershell';
  if (process.platform === 'darwin') return 'zsh';
  const current = path.basename(process.env.SHELL || '').toLowerCase();
  return KNOWN_SHELLS.has(current as TerminalShellPreference)
    ? current as TerminalShellPreference
    : 'bash';
}

function defaultPosixShell(): string {
  const configured = process.env.SHELL;
  if (configured && isExecutable(configured)) return configured;
  if (process.platform === 'darwin') return requireExecutable(['/bin/zsh', 'zsh', '/bin/bash', 'bash', '/bin/sh'], 'auto');
  return requireExecutable(['/bin/bash', 'bash', '/bin/sh'], 'auto');
}

function defaultWindowsShell(): string {
  return requireExecutable(['powershell.exe', 'pwsh.exe', process.env.ComSpec || 'cmd.exe', 'cmd.exe'], 'auto');
}

function posixShellCandidates(shell: string): string[] {
  switch (shell) {
    case 'zsh': return ['/bin/zsh', '/usr/bin/zsh', 'zsh'];
    case 'bash': return ['/bin/bash', '/usr/bin/bash', 'bash'];
    case 'fish': return ['/usr/bin/fish', '/opt/homebrew/bin/fish', 'fish'];
    case 'sh': return ['/bin/sh', '/usr/bin/sh', 'sh'];
    default: return [shell];
  }
}

function findExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      if (isExecutable(candidate)) return candidate;
      continue;
    }
    for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const resolved = path.join(directory, candidate);
      if (isExecutable(resolved)) return resolved;
    }
  }
  return null;
}

function requireExecutable(candidates: string[], selected: TerminalShellPreference): string {
  const resolved = findExecutable(candidates);
  if (resolved) return resolved;
  throw new Error(`The selected terminal shell "${selected}" is not installed or is not available on this device.`);
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
