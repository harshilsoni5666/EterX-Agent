import fs from 'fs';
import path from 'path';
const { findHostExecutable } = require('../../../../../electron/host-environment') as {
  findHostExecutable: (candidates: string[], env?: NodeJS.ProcessEnv) => string | null;
};

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
  const requested = String(preference || 'auto').trim();
  if (requested && !KNOWN_SHELLS.has(requested.toLowerCase() as TerminalShellPreference)) {
    const executable = findExecutable([requested]);
    if (executable) return executable;
    throw new Error(`The requested shell is unavailable: ${requested}. Choose an installed shell or use program + args for direct execution.`);
  }
  const selected = normalizeTerminalShell(preference);

  if (process.platform === 'win32') {
    if (selected === 'cmd') return requireExecutable([process.env.ComSpec || 'cmd.exe', 'cmd.exe'], selected);
    if (selected === 'wsl') return requireExecutable(['wsl.exe'], selected);
    if (selected === 'git-bash' || selected === 'bash') {
      return requireExecutable([
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
        'bash.exe',
      ], selected);
    }
    if (selected === 'auto') return defaultWindowsShell();
    if (['zsh', 'fish', 'sh'].includes(selected)) {
      throw new Error(`The selected terminal shell "${selected}" is not available on Windows. Use PowerShell, cmd, Git Bash, or WSL.`);
    }
    return requireExecutable([
      'pwsh.exe',
      'powershell.exe',
      path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ], selected);
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
    if (findExecutable([
      'pwsh.exe',
      'powershell.exe',
      path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ])) available.push('powershell');
    if (findExecutable([process.env.ComSpec || 'cmd.exe', 'cmd.exe'])) available.push('cmd');
    if (findExecutable([
      'bash.exe',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ])) available.push('git-bash');
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
  cwd?: string,
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

  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(shellName)) {
    // Pass the script as UTF-16LE instead of letting Windows reinterpret quotes
    // and Unicode. PowerShell uses the same switches on macOS and Linux.
    const script = `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding;\n$ErrorActionPreference = 'Stop'\ntry {\n& {\n${command}\n}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }\nexit 0\n} catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }`;
    return {
      file: resolvedShell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      shell: false,
    };
  }

  if (process.platform === 'win32') {
    if (shellName === 'cmd' || shellName === 'cmd.exe') {
      return { file: resolvedShell, args: ['/d', '/s', '/c', command], shell: false };
    }
    if (shellName === 'wsl' || shellName === 'wsl.exe') {
      return { file: resolvedShell, args: [...(cwd ? ['--cd', cwd] : []), '--', 'sh', '-c', command], shell: false };
    }
    return { file: resolvedShell, args: ['-c', command], shell: false };
  }

  return { file: resolvedShell, args: ['-c', command], shell: false };
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
  return requireExecutable([
    'pwsh.exe',
    'powershell.exe',
    path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    process.env.ComSpec || 'cmd.exe',
    'cmd.exe',
  ], 'auto');
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

export function isExecutableAvailable(candidates: string[]): boolean {
  return findExecutable(candidates) !== null;
}

export function findExecutable(candidates: string[], env?: NodeJS.ProcessEnv): string | null {
  return findHostExecutable(candidates, env);
}

function requireExecutable(candidates: string[], selected: TerminalShellPreference): string {
  const resolved = findExecutable(candidates);
  if (resolved) return resolved;
  throw new Error(`The selected terminal shell "${selected}" is not installed or is not available on this device.`);
}

function isExecutable(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
