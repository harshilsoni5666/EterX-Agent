import path from 'path';
const { findHostExecutable } = require('../../../../../electron/host-environment') as {
  findHostExecutable: (candidates: string[], env?: NodeJS.ProcessEnv) => string | null;
};
const { resolveHostShell, availableHostShells } = require('../../../../../electron/terminal-shell') as {
  resolveHostShell: (preference?: unknown, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, allowCustom?: boolean) => string;
  availableHostShells: () => TerminalShellPreference[];
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
  return resolveHostShell(preference, undefined, process.platform, true);
}

export function getAvailableTerminalShells(): TerminalShellPreference[] {
  return availableHostShells();
}

export type TerminalShellInvocation = {
  file: string;
  args: string[];
  shell: false;
  windowsVerbatimArguments?: boolean;
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
    // Capture the last command's status inside the script block. Returning
    // from & { ... } can reset $? and hide a native program's failure.
    const script = `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding;\n$ErrorActionPreference = 'Stop'\ntry {\n& {\n${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }\n}\nexit 0\n} catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }`;
    return {
      file: resolvedShell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      shell: false,
    };
  }

  if (process.platform === 'win32') {
    if (shellName === 'cmd' || shellName === 'cmd.exe') {
      // cmd parses its own command line. libuv's native-executable quoting
      // escapes nested quotes with backslashes, which cmd treats literally.
      return { file: resolvedShell, args: ['/d', '/s', '/c', `"${command}"`], shell: false, windowsVerbatimArguments: true };
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

export function isExecutableAvailable(candidates: string[]): boolean {
  return findExecutable(candidates) !== null;
}

export function findExecutable(candidates: string[], env?: NodeJS.ProcessEnv): string | null {
  return findHostExecutable(candidates, env);
}

