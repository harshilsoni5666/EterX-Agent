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

export function resolveTerminalShell(preference?: unknown): string | boolean {
  const selected = normalizeTerminalShell(preference);

  if (process.platform === 'win32') {
    if (selected === 'cmd') return process.env.ComSpec || 'cmd.exe';
    if (selected === 'wsl') return findExecutable(['wsl.exe']) || 'wsl.exe';
    if (selected === 'git-bash' || selected === 'bash') {
      return findExecutable([
        'bash.exe',
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
      ]) || 'bash.exe';
    }
    return findExecutable(['pwsh.exe', 'powershell.exe']) || 'powershell.exe';
  }

  if (selected === 'powershell') {
    return findExecutable(['pwsh', '/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh']) || 'pwsh';
  }
  const requested = selected;
  if (requested !== 'auto' && !['cmd', 'git-bash', 'wsl'].includes(requested)) {
    return findExecutable([requested]) || defaultPosixShell();
  }
  return defaultPosixShell();
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
  if (process.platform === 'darwin') return findExecutable(['/bin/zsh', 'zsh']) || '/bin/bash';
  return findExecutable(['/bin/bash', 'bash', '/bin/sh']) || '/bin/sh';
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

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
