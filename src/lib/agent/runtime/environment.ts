import path from 'path';
import os from 'os';
import { findExecutable, resolveTerminalShell } from '../tools/core/shell_resolver';
import { getRuntimeScratchRoot, getRuntimeWorkspaceRoot } from '../workspace/path_resolver';
import { getUserFolders } from './user-folders';
import { getLiveTerminalTaskContext } from '../tools/core/terminal_background';
import { getChatCommandEnvironment } from './python-runtime';

let cache: { key: string; expires: number; executables: Record<string, string | null> } | undefined;

/** Filesystem discovery only: no version processes, imports, installs, or env dump. */
export function getRuntimeExecutables(refresh = false, env?: NodeJS.ProcessEnv): Record<string, string | null> {
  const source = env || process.env;
  const pathKey = process.platform === 'win32' ? Object.keys(source).find(key => key.toLowerCase() === 'path') : 'PATH';
  const extensionKey = process.platform === 'win32' ? Object.keys(source).find(key => key.toLowerCase() === 'pathext') : 'PATHEXT';
  const key = [process.platform, pathKey && source[pathKey], extensionKey && source[extensionKey]].join('\0');
  if (!refresh && cache?.key === key && cache.expires > Date.now()) return { ...cache.executables };
  const executables = Object.fromEntries(Object.entries({
    pythonLauncher: process.platform === 'win32' ? ['py.exe'] : [],
    node: ['node'], npm: ['npm'], git: ['git'], rg: ['rg'],
    libreoffice: ['soffice', 'libreoffice', ...(process.platform === 'darwin' ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice'] : [])],
    pdftoppm: ['pdftoppm'],
  }).map(([name, candidates]) => [name, findExecutable(candidates, env)]));
  cache = { key, expires: Date.now() + 30_000, executables };
  return { ...executables };
}

export function getRuntimeEnvironment(context?: any, refresh = false) {
  const cwd = getRuntimeWorkspaceRoot(context);
  const { runtime: python, env } = getChatCommandEnvironment(context, cwd);
  let shell: string | null = null;
  let shellError: string | undefined;
  try { shell = resolveTerminalShell(context?.terminalShell); } catch (error) { shellError = String((error as Error).message); }
  return {
    platform: process.platform, architecture: process.arch,
    shell, shellError, cwd, scratchRoot: getRuntimeScratchRoot(context),
    home: os.homedir(), ...getUserFolders(), pathSeparator: path.sep,
    executables: { ...getRuntimeExecutables(refresh, env), python: python.program },
    python: {
      ...python,
      alias: python.program ? 'python' : undefined,
      // This is a recipe, not an installed executable or an automatic action.
      // Create once only when the task needs additional packages or isolation.
      createEnvironment: python.source === 'system' && python.program && python.managedRoot
        ? { program: python.program, args: ['-m', 'venv', python.managedRoot] } : undefined,
    },
    managedProcesses: getLiveTerminalTaskContext(String(context?.ownerChatId || context?.chatId || context?.projectId || '')),
    note: 'Current host/chat facts, not commands or a required workflow. Choose any suitable available tool for the request. This executable list is non-exhaustive; program accepts any installed native executable. Relative paths use cwd; direct program + args avoids shell quoting. Executable discovery does not establish optional dependencies. The python alias selects the described environment; explicit executable paths and invocation environment overrides remain supported. createEnvironment is an optional recipe, not a completed or mandatory setup step.',
  };
}
