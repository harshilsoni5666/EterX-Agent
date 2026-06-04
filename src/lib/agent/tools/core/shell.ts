import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import { getPathResolverInfo, resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import {
  normalizeCheckInMs,
  normalizeHardTimeoutMs
} from './terminal_timeout';
import { runTerminalCommandWithCheckIn } from './terminal_background';

const HELPER_SCRIPT_PATTERN = /\.(py|ps1|js|mjs|cjs|bat|cmd|vbs|ahk)(['"\s]|$)/i;

function referencesDesktopHelperScript(command: string, cwd: string): boolean {
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

function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Enhanced System Shell — v2.0
 * 
 * Major upgrades over v1:
 * - Configurable timeout (default 30s, max 120s); long-running commands belong in process_manager
 * - Custom working directory support (still sandboxed)
 * - Captured output with live UI traces
 * - Multi-command chaining (&&, ;)
 * - PowerShell AND cmd support
 * - Full stdout/stderr returned to the runner; model-facing compaction happens later
 * - Execution timing
 * - Environment variable injection
 */
export const shellTool: ToolDefinition = {
  name: 'system_shell',
  description: `Execute shell commands on the host OS with streamed output and automatic background handoff. If a command is still running after the check-in timer (default 15s; timeoutSeconds/checkInSeconds override it), the process stays alive and this returns backgroundTaskId. Do not rerun handed-off commands; call wait_timer, then background_task mode="check". Runs in PowerShell by default.
  
  Pro tips:
  - Chain commands: "npm install && npm run build"
  - Custom directory: set workingDir to run in a specific folder
  - Long-running command returned stillRunning: wait_timer, then background_task check with the returned taskId
  - Use shellType "cmd" for native Windows commands`,
  category: 'core',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    workingDir: z.string().optional().describe('Working directory (relative to workspace). Default: workspace root'),
    shellType: z.enum(['powershell', 'cmd']).optional().default('powershell').describe('Shell type to use'),
    timeoutSeconds: z.number().optional().describe('Alias for the first check-in timer in seconds. Default is about 15 seconds.'),
    checkInSeconds: z.number().optional().describe('Seconds to wait before handing a still-running command to the background. Default is about 15 seconds.'),
    hardTimeoutSeconds: z.number().optional().describe('Hard safety timeout in seconds for stuck commands after handoff. Default is 30 minutes.'),
    env: z.string().optional().describe('Optional JSON object string of environment variables, e.g. {"NODE_ENV":"production"}')
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    executionTimeMs: z.number(),
    timedOut: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    stillRunning: z.boolean().optional(),
    backgroundTaskId: z.string().optional(),
    nextActionNote: z.string().optional()
  }),
  execute: async (input: { command: string, workingDir?: string, shellType?: string, env?: Record<string, string> | string, timeoutSeconds?: number, timeoutMs?: number, checkInSeconds?: number, checkInMs?: number, hardTimeoutSeconds?: number, hardTimeoutMs?: number }, context?: any) => {
    const startTime = Date.now();

    try {
      // Resolve working directory against the selected/pinned workspace.
      const cwd = resolveWorkspaceDirectoryForContext(input.workingDir, context);
      // === EterX SOURCE PROTECTION ===
      // Block shell commands from running inside protected EterX directories
      const eterxRootPath = process.cwd();
      const EterXRoot = eterxRootPath.toLowerCase().replace(/\\/g, '/');
      const protectedDirs = ['src', 'electron', 'public', '.git', '.next', 'node_modules'];

      for (const dir of protectedDirs) {
        const protectedPath = path.resolve(eterxRootPath, dir);
        if (isPathInsideOrEqual(protectedPath, cwd)) {
          return {
            CRITICAL_ERROR: `🛡️ BLOCKED: Cannot run shell commands inside EterX ${ dir }/ directory. This is a protected source folder. Use a different working directory like Desktop.`,
            stdout: '',
            stderr: '',
            exitCode: 1,
            executionTimeMs: 0
          };
        }
      }

      // Block commands that target EterX source files via redirection
      const cmd = input.command;
      const cmdLower = cmd.toLowerCase().replace(/\\/g, '/');
      const EterXSrcPath = `${ EterXRoot }/src`.toLowerCase();

      if (cmdLower.includes(EterXSrcPath) && (
        cmdLower.includes('>') || cmdLower.includes('set-content') ||
        cmdLower.includes('out-file') || cmdLower.includes('tee ')
      )) {
        return {
          CRITICAL_ERROR: `🛡️ BLOCKED: Cannot write to EterX source files via shell. Use workspace_write_file for files outside the EterX project.`,
          stdout: '',
          stderr: '',
          exitCode: 1,
          executionTimeMs: 0
        };
      }

      // Ensure the target directory exists before running command
      await fs.ensureDir(cwd);

      const shellExe = input.shellType === 'cmd' ? 'cmd.exe' : 'powershell.exe';
      const command = shellExe === 'powershell.exe'
        ? input.command.replace(/\[Environment\]::GetFolderPath\(\s*Desktop\s*\)/g, "[Environment]::GetFolderPath('Desktop')")
        : input.command;

      if (referencesDesktopHelperScript(command, cwd)) {
        return {
          CRITICAL_ERROR: '⚠️ HINT: This command references a script directly on the Desktop root. Use computer or screen_agent for real app control, or move scripts into the project directory.',
          stdout: '',
          stderr: '',
          exitCode: 1,
          executionTimeMs: 0
        };
      }

      console.log(`[Tool: system_shell] Exec: "${ command.substring(0, 120) }" (cwd: ${ cwd }, shell: ${ shellExe })`);

      // Build environment
      const parsedEnv = parseStringRecord(input.env);
      const execEnv = { ...process.env, ...parsedEnv };
      const checkInMs = normalizeCheckInMs(input.checkInSeconds ?? input.checkInMs ?? input.timeoutSeconds ?? input.timeoutMs, command);
      const hardTimeoutMs = normalizeHardTimeoutMs(input.hardTimeoutSeconds ?? input.hardTimeoutMs, checkInMs);

      const result = await runTerminalCommandWithCheckIn({
        command,
        cwd,
        source: 'system_shell',
        context,
        shell: shellExe,
        env: execEnv,
        checkInMs,
        hardTimeoutMs,
        maxOutputChars: 10 * 1024 * 1024,
        traceThrottleMs: 150
      });

      const executionTime = result.executionTimeMs ?? (Date.now() - startTime);

      if (result.stillRunning) return result;

      const stdoutText = result.stdout || '';
      const stderrText = result.stderr || '';
      if (result.exitCode !== 0) {
        return {
          CRITICAL_ERROR: result.timedOut
            ? 'TERMINAL_HARD_TIMEOUT. Read the partial output, keep completed work, and continue from the latest visible state.'
            : 'YOUR COMMAND CRASHED. Read the error, fix your code/command, and try again.',
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: result.exitCode || 1,
          executionTimeMs: executionTime,
          timedOut: Boolean(result.timedOut),
          timeoutMs: checkInMs,
          hardTimeoutMs,
          _consoleTraceEmitted: true,
          nextActionNote: result.nextActionNote
        };
      }

      if (stderrText.trim().length > 0) {
        return {
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: 0,
          executionTimeMs: executionTime,
          timeoutMs: checkInMs,
          hardTimeoutMs,
          _consoleTraceEmitted: true,
          TERMINAL_WARNING: "Command produced stderr output. This may be informational (e.g., npm warnings) or could indicate issues."
        };
      }

      return { stdout: stdoutText, stderr: '', exitCode: 0, executionTimeMs: executionTime, timeoutMs: checkInMs, hardTimeoutMs, _consoleTraceEmitted: true };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const failedStdout = String(error.stdout || '');
      const failedStderr = String(error.stderr || error.message);
      const failedExitCode = error.code || 1;
      emitShellOutputTrace(context, input.command, [failedStdout, failedStderr].filter(Boolean).join('\n'), {
        exitCode: failedExitCode,
        durationMs: executionTime
      });
      return {
        CRITICAL_ERROR: "YOUR COMMAND CRASHED. Read the error, fix your code/command, and try again.",
        stdout: failedStdout,
        stderr: failedStderr,
        exitCode: failedExitCode,
        executionTimeMs: executionTime,
        _consoleTraceEmitted: true
      };
    }
  }
};

function parseStringRecord(value: Record<string, string> | string | undefined): Record<string, string> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const normalized: Record<string, string> = {};
    for (const [key, recordValue] of Object.entries(parsed)) {
      normalized[key] = String(recordValue);
    }
    return normalized;
  } catch {
    return {};
  }
}

function emitShellOutputTrace(context: any, command: string, output: string, metadata: Record<string, any> = {}) {
  const content = output.trim();
  if (!content) return;

  const event = {
    type: 'console_output',
    command,
    output: content,
    content,
    source: 'system_shell',
    ...metadata
  };

  if (typeof context?._onTrace === 'function') {
    context._onTrace(event);
  }

  if (context?.chatId) {
    try {
      const { taskStore } = require('../../task-store');
      taskStore.addTrace(context.chatId, event);
    } catch {
      // Trace persistence is best-effort; command output still returns to the caller.
    }
  }
}
