import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import { getPathResolverInfo, resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import {
  emitRuntimeTrace,
  isExecTimeoutError,
  normalizeTimeoutMs,
  terminalTimeoutNote
} from './terminal_timeout';

const execAsync = promisify(exec);

import { referencesDesktopHelperScript } from '../shared/desktop_guard';

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
 * - Captured output with truncation for large results
 * - Multi-command chaining (&&, ;)
 * - PowerShell AND cmd support
 * - Output truncation for massive outputs (keeps first + last lines)
 * - Execution timing
 * - Environment variable injection
 */
export const shellTool: ToolDefinition = {
  name: 'system_shell',
  description: `Execute finite one-shot shell commands on the host OS with a configurable timeout (default 30s, max 2 minutes). Supports custom working directories, environment variables, multi-command chaining, output truncation for large outputs, and execution timing. Runs in PowerShell by default. Use process_manager/background_task plus wait_timer for long-running servers, watchers, or interactive processes.
  
  Pro tips:
  - Chain commands: "npm install && npm run build"
  - Custom directory: set workingDir to run in a specific folder
  - Long-running commands: use process_manager/background_task and wait_timer instead of system_shell
  - Use shellType "cmd" for native Windows commands`,
  category: 'core',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    workingDir: z.string().optional().describe('Working directory (relative to workspace). Default: workspace root'),
    shellType: z.enum(['powershell', 'cmd']).optional().default('powershell').describe('Shell type to use'),
    timeoutSeconds: z.number().optional().describe('Optional command timeout in seconds. Default: 30 seconds. Max: 120 seconds.'),
    env: z.string().optional().describe('Optional JSON object string of environment variables, e.g. {"NODE_ENV":"production"}')
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    executionTimeMs: z.number(),
    timedOut: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    nextActionNote: z.string().optional()
  }),
  execute: async (input: { command: string, workingDir?: string, shellType?: string, env?: Record<string, string> | string, timeoutSeconds?: number, timeoutMs?: number }, context?: any) => {
    const startTime = Date.now();
    const timeoutMs = normalizeTimeoutMs(input.timeoutSeconds ?? input.timeoutMs);

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

      const { stdout, stderr } = await execAsync(command, {
        shell: shellExe,
        cwd,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer (up from default 1MB)
        timeout: timeoutMs,
        env: execEnv
      });

      const executionTime = Date.now() - startTime;

      // Truncate large outputs — keep significantly more lines so output doesn't get dropped
      // Old: 200+50 lines (caused ~40% loss). New: 500+150 lines.
      const truncatedStdout = truncateOutput(stdout, 500, 150);
      const truncatedStderr = truncateOutput(stderr, 100, 50);

      if (stderr && stderr.trim().length > 0) {
        return {
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          exitCode: 0,
          executionTimeMs: executionTime,
          timeoutMs,
          cwd,
          TERMINAL_WARNING: "Command produced stderr output. This may be informational (e.g., npm warnings) or could indicate issues."
        };
      }

      return { stdout: truncatedStdout, stderr: '', exitCode: 0, executionTimeMs: executionTime, timeoutMs, cwd };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      if (isExecTimeoutError(error)) {
        const note = terminalTimeoutNote(input.command, timeoutMs);
        emitRuntimeTrace(context, {
          type: 'timer_expired',
          text: 'Shell command: Timer has expired',
          title: 'Shell command',
          note,
          durationMs: timeoutMs,
          command: input.command,
          iconCategory: 'terminal'
        });
        return {
          CRITICAL_ERROR: 'TERMINAL_TIMEOUT. Read the partial output, keep completed work, and continue from the latest visible state.',
          stdout: truncateOutput(error.stdout || '', 100, 30),
          stderr: truncateOutput(`${error.stderr || error.message || ''}\n\n${note}`, 100, 30),
          exitCode: 124,
          executionTimeMs: executionTime,
          timedOut: true,
          timeoutMs,
          nextActionNote: note
        };
      }

      return {
        CRITICAL_ERROR: "YOUR COMMAND CRASHED. Read the error, fix your code/command, and try again.",
        stdout: truncateOutput(error.stdout || '', 100, 30),
        stderr: truncateOutput(error.stderr || error.message, 100, 30),
        exitCode: error.code || 1,
        executionTimeMs: executionTime,
        timeoutMs
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

/**
 * Truncate output that's too long, keeping first N lines and last M lines.
 */
function truncateOutput(text: string, keepFirst: number, keepLast: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= keepFirst + keepLast) return text;

  const first = lines.slice(0, keepFirst).join('\n');
  const last = lines.slice(-keepLast).join('\n');
  const skipped = lines.length - keepFirst - keepLast;

  return `${ first }\n\n... [${ skipped } lines truncated] ...\n\n${ last }`;
}
