import path from 'path';
import { getPathResolverInfo } from '../../workspace/path_resolver';

const HELPER_SCRIPT_PATTERN = /\.(py|ps1|js|mjs|cjs|bat|cmd|vbs|ahk)(['"\s]|$)/i;

/**
 * Check if a command references a helper script directly on the Desktop root.
 * Blocks UI automation scripts written directly to Desktop, but allows
 * project scripts in subdirectories.
 *
 * Shared between shell.ts and execution.ts to avoid code duplication.
 */
export function referencesDesktopHelperScript(command: string, cwd: string): boolean {
  // Only block scripts that are DIRECTLY on the Desktop (not in subdirectories/projects)
  // and appear to be UI automation helpers (not legitimate project scripts)
  if (!HELPER_SCRIPT_PATTERN.test(command)) return false;

  const normalizedCommand = command.replace(/\\/g, '/').toLowerCase();
  const desktopPath = path.resolve(getPathResolverInfo().desktopPath);
  const normalizedDesktop = desktopPath.replace(/\\/g, '/').toLowerCase();

  // ALLOW: Scripts inside project directories, .workspaces, sandbox, node_modules, etc.
  // These are legitimate project scripts, not UI automation helpers.
  const allowedPatterns = [
    '.workspaces', '/sandbox/', '/node_modules/', '/src/', '/lib/', '/dist/',
    '/build/', '/scripts/', '/test/', '/tests/', '/__tests__/', '/spec/',
    '/temp/', '/tmp/', '/draft/', '/.cache/', '/.git/'
  ];
  for (const pattern of allowedPatterns) {
    if (normalizedCommand.includes(pattern)) return false;
  }

  // ALLOW: If the CWD is inside a project (has package.json, .git, etc.) — it's project work
  const normalizedCwd = path.resolve(cwd).replace(/\\/g, '/').toLowerCase();
  const cwdInsideDesktop = normalizedCwd === normalizedDesktop || normalizedCwd.startsWith(`${normalizedDesktop}/`);

  // Only block if the script is DIRECTLY on Desktop (not in a project subfolder on Desktop)
  if (cwdInsideDesktop) {
    // If CWD is deeper than Desktop by 2+ levels, it's a project — allow it
    const relativeDepth = normalizedCwd.substring(normalizedDesktop.length).split('/').filter(Boolean).length;
    if (relativeDepth >= 2) return false; // e.g., Desktop/my-project/scripts/ → allowed
  }

  // Only block if command references a script directly on Desktop root
  if (normalizedCommand.includes(normalizedDesktop + '/')) {
    // Extract the script path after Desktop
    const afterDesktop = normalizedCommand.substring(normalizedCommand.indexOf(normalizedDesktop) + normalizedDesktop.length + 1);
    // If the script is in a subdirectory (project), allow it
    if (afterDesktop.includes('/')) return false;
    // Script is directly on Desktop root — this is likely a helper script, block it
    return true;
  }

  return false;
}
