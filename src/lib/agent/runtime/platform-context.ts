import os from 'os';
import { getPathResolverInfo, getUserDocumentsPath, getUserDownloadsPath } from '../workspace/path_resolver';
import { normalizeTerminalShell, resolveTerminalShell } from '../tools/core/shell_resolver';

export type SupportedRuntimePlatform = 'windows' | 'macos' | 'linux';

export type RuntimePlatformContext = {
  platform: SupportedRuntimePlatform;
  label: 'Windows' | 'macOS' | 'Linux';
  shellPreference: string;
  resolvedShell: string;
  pathSeparator: '\\' | '/';
  homePath: string;
  desktopPath: string;
  documentsPath: string;
  downloadsPath: string;
};

export function detectRuntimePlatform(): SupportedRuntimePlatform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`Unsupported operating system: ${process.platform}. EterX supports Windows, macOS, and Linux.`);
}

export function getRuntimePlatformContext(shellPreference: unknown = 'auto'): RuntimePlatformContext {
  const platform = detectRuntimePlatform();
  const homePath = os.homedir();
  const selectedShell = normalizeTerminalShell(shellPreference);
  const resolvedShell = resolveTerminalShell(selectedShell);
  if (typeof resolvedShell !== 'string' || !resolvedShell.trim()) {
    throw new Error(`Unable to resolve the ${selectedShell} terminal shell on ${platform}.`);
  }

  return {
    platform,
    label: platform === 'windows' ? 'Windows' : platform === 'macos' ? 'macOS' : 'Linux',
    shellPreference: selectedShell,
    resolvedShell,
    pathSeparator: platform === 'windows' ? '\\' : '/',
    homePath,
    desktopPath: getPathResolverInfo().desktopPath,
    documentsPath: getUserDocumentsPath(),
    downloadsPath: getUserDownloadsPath(),
  };
}

export function buildRuntimePlatformPrompt(shellPreference: unknown = 'auto'): string {
  const runtime = getRuntimePlatformContext(shellPreference);
  return `RUNTIME PLATFORM
- OS: ${runtime.label}
- Shell: ${runtime.resolvedShell} (${runtime.shellPreference === 'auto' ? 'Smart auto-detect' : 'user selected'})
- Paths: use ${runtime.pathSeparator} syntax; home=${runtime.homePath}; desktop=${runtime.desktopPath}
- Generate commands, quoting, executables, and file paths only for this OS and shell. Reuse absolute paths returned by tools.`;
}
