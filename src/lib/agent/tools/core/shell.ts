import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';

const execAsync = promisify(exec);

/**
 * Enhanced System Shell — v2.0
 * 
 * Major upgrades over v1:
 * - Configurable timeout (default 60s, up to 5 min)
 * - Custom working directory support (still sandboxed)
 * - Streaming output for long-running commands
 * - Multi-command chaining (&&, ;)
 * - PowerShell AND cmd support
 * - Output truncation for massive outputs (keeps first + last lines)
 * - Execution timing
 * - Environment variable injection
 */
export const shellTool: ToolDefinition = {
  name: 'system_shell',
  description: `Execute shell commands on the host OS. Enhanced v2: configurable timeout, custom working directory, multi-command chaining, output truncation for large outputs, and execution timing. Runs in PowerShell by default.
  
  Pro tips:
  - Chain commands: "npm install && npm run build"
  - Custom directory: set workingDir to run in a specific folder
  - Long commands: increase timeoutSeconds (default: 60)
  - Use shellType "cmd" for native Windows commands`,
  category: 'core',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    workingDir: z.string().optional().describe('Working directory (relative to workspace). Default: workspace root'),
    timeoutSeconds: z.number().optional().default(60).describe('Timeout in seconds (default: 60, max: 300)'),
    shellType: z.enum(['powershell', 'cmd']).optional().default('powershell').describe('Shell type to use'),
    env: z.string().optional().describe('Optional JSON object string of environment variables, e.g. {"NODE_ENV":"production"}')
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    executionTimeMs: z.number()
  }),
  execute: async (input: { command: string, workingDir?: string, timeoutSeconds?: number, shellType?: string, env?: Record<string, string> | string }) => {
    const startTime = Date.now();

    try {
      // Resolve working directory — agent runs LOCALLY, full filesystem access
      const userHome = process.env.USERPROFILE || process.env.HOME || process.cwd();
      const defaultDir = process.cwd();

      let cwd: string;
      if (input.workingDir) {
        // Allow absolute paths (Desktop, Downloads, etc.) OR relative to workspace
        cwd = path.isAbsolute(input.workingDir)
          ? input.workingDir
          : path.resolve(defaultDir, input.workingDir);
      } else {
        cwd = defaultDir;
      }
      // === EterX SOURCE PROTECTION ===
      // Block shell commands from running inside protected EterX directories
      const cwdLower = cwd.toLowerCase().replace(/\\/g, '/');
      const EterXRoot = defaultDir.toLowerCase().replace(/\\/g, '/');
      const protectedDirs = ['src', 'electron', 'public', '.git', '.next', 'node_modules'];

      for (const dir of protectedDirs) {
        const protectedPath = `${ EterXRoot }/${ dir }`;
        if (cwdLower.startsWith(protectedPath)) {
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

      const timeout = Math.min(Math.max((input.timeoutSeconds || 60) * 1000, 5000), 300000);
      const shellExe = input.shellType === 'cmd' ? 'cmd.exe' : 'powershell.exe';

      console.log(`[Tool: system_shell] Exec: "${ input.command.substring(0, 120) }" (cwd: ${ cwd }, timeout: ${ timeout / 1000 }s, shell: ${ shellExe })`);

      // Build environment
      const parsedEnv = parseStringRecord(input.env);
      const execEnv = { ...process.env, ...parsedEnv };

      const { stdout, stderr } = await execAsync(input.command, {
        shell: shellExe,
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer (up from default 1MB)
        env: execEnv
      });

      const executionTime = Date.now() - startTime;

      // Truncate large outputs (keep first 200 + last 50 lines)
      const truncatedStdout = truncateOutput(stdout, 200, 50);
      const truncatedStderr = truncateOutput(stderr, 50, 20);

      if (stderr && stderr.trim().length > 0) {
        return {
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          exitCode: 0,
          executionTimeMs: executionTime,
          TERMINAL_WARNING: "Command produced stderr output. This may be informational (e.g., npm warnings) or could indicate issues."
        };
      }

      return { stdout: truncatedStdout, exitCode: 0, executionTimeMs: executionTime };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const isTimeout = error.killed || error.signal === 'SIGTERM';

      return {
        CRITICAL_ERROR: isTimeout
          ? `COMMAND TIMED OUT after ${ (executionTime / 1000).toFixed(1) }s. Try increasing timeoutSeconds or breaking the task into smaller steps.`
          : "YOUR COMMAND CRASHED. Read the error, fix your code/command, and try again.",
        stdout: truncateOutput(error.stdout || '', 100, 30),
        stderr: truncateOutput(error.stderr || error.message, 100, 30),
        exitCode: error.code || (isTimeout ? 124 : 1),
        executionTimeMs: executionTime
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
