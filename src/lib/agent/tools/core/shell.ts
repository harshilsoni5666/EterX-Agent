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
import { authorizeToolCommand } from '../security/command_broker';

const execAsync = promisify(exec);

import { referencesDesktopHelperScript } from '../shared/desktop_guard';

function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Auto-detect if a command starts with 'cd "path"; actual_command' or 'cd path && actual_command'
 * and extract the directory and the real command.
 * This prevents the most common agent mistake: using cd in a shell command string
 * instead of the workingDir parameter.
 */
function extractCdPrefix(command: string): { directory: string; command: string } | null {
  const cdPatterns = [
    /^cd\s+"([^"]+)"\s*[;&]+\s*(.+)$/is,
    /^cd\s+'([^']+)'\s*[;&]+\s*(.+)$/is,
    /^cd\s+"([^"]+)"\s*&&\s*(.+)$/is,
    /^cd\s+'([^']+)'\s*&&\s*(.+)$/is,
    /^cd\s+(\S+)\s*[;&]+\s*(.+)$/is,
    /^cd\s+(\S+)\s*&&\s*(.+)$/is,
  ];
  for (const pattern of cdPatterns) {
    const match = pattern.exec(command.trim());
    if (match) {
      return { directory: match[1].trim(), command: match[2].trim() };
    }
  }
  return null;
}

/**
 * Translate common Unix shell commands to PowerShell equivalents.
 * This prevents failures when the agent generates Unix syntax on Windows.
 */
function translateUnixToWindows(command: string): string {
  let cmd = command;

  // mkdir -p path1 path2 ... -> New-Item -ItemType Directory -Force -Path "path1","path2",...
  const mkdirMatch = /^mkdir\s+-p\s+(.+)$/i.exec(cmd.trim());
  if (mkdirMatch) {
    const rawPaths = mkdirMatch[1];
    // Split on spaces or commas, respecting quotes
    const paths = rawPaths.match(/"[^"]+"|'[^']+'|\S+/g) || [];
    const cleaned = paths.map(p => p.replace(/^["']|["']$/g, ''));
    const quoted = cleaned.map(p => `"${p}"`).join(', ');
    return `New-Item -ItemType Directory -Force -Path ${quoted}`;
  }

  // rm -rf path -> Remove-Item -Recurse -Force "path"
  const rmrfMatch = /^rm\s+(-rf|-r\s+-f|-f\s+-r)\s+(.+)$/i.exec(cmd.trim());
  if (rmrfMatch) {
    const target = rmrfMatch[2].trim().replace(/^["']|["']$/g, '');
    return `Remove-Item -Recurse -Force "${target}"`;
  }

  // touch path -> New-Item -ItemType File -Force -Path "path"
  const touchMatch = /^touch\s+(.+)$/i.exec(cmd.trim());
  if (touchMatch) {
    const target = touchMatch[1].trim().replace(/^["']|["']$/g, '');
    return `New-Item -ItemType File -Force -Path "${target}"`;
  }

  // cat file -> Get-Content file
  const catMatch = /^cat\s+(.+)$/i.exec(cmd.trim());
  if (catMatch) {
    return `Get-Content ${catMatch[1]}`;
  }

  return cmd;
}

/**
 * Detect if a command is a long-running install/build that needs a longer timeout.
 * Returns the recommended timeout in seconds, or 0 if default is fine.
 */
function detectLongRunningTimeout(command: string): number {
  const lower = command.toLowerCase().trim();
  // Package installs — almost always take >30s
  if (/\b(npm\s+(install|ci|i)\b|yarn\s*(install)?\b|pnpm\s+(install|i)\b|bun\s+install\b)/i.test(lower)) return 120;
  if (/\b(pip\s+install|pip3\s+install|poetry\s+install|pipenv\s+install)/i.test(lower)) return 120;
  if (/\b(cargo\s+(build|install)|rustup)/i.test(lower)) return 120;
  if (/\b(dotnet\s+(build|restore|publish))/i.test(lower)) return 120;
  if (/\b(mvn\s+(install|package|compile)|gradle\s+(build|assemble))/i.test(lower)) return 120;
  // Full project builds
  if (/\b(npm\s+run\s+build|yarn\s+build|pnpm\s+build|next\s+build|vite\s+build|tsc\b)/i.test(lower)) return 120;
  // npm create / npx scaffolding
  if (/\b(npm\s+create|npx\s)/i.test(lower)) return 120;
  return 0;
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
  description: `Execute finite one-shot shell commands on the host OS (Windows/PowerShell). Supports custom working directories, environment variables, multi-command chaining, output truncation, and execution timing.

  CRITICAL RULES:
  - NEVER prefix commands with "cd path;". Use the workingDir parameter instead. cd prefixes are auto-stripped but waste cycles.
  - This is PowerShell on Windows. Common Unix commands (mkdir -p, rm -rf, touch, cat) are auto-translated, but prefer native PowerShell for complex cases.
  - Install commands (npm install, pip install, cargo build, etc.) auto-get 120s timeout — no need to set timeoutSeconds.
  - For dev servers, watchers, or anything that runs forever: use process_manager/background_task + wait_timer.
  - For installs that STILL time out at 120s: use background_task mode="launch" with the same command.
  
  Pro tips:
  - Chain commands: "npm install && npm run build"
  - Custom directory: set workingDir to the ABSOLUTE PATH of the target folder
  - Use shellType "cmd" for native Windows batch commands`,
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
    // ═══ SANDBOX GATE (defense-in-depth) ═══
    // system_shell is completely disabled in sandbox mode.
    // The agent should use workspace_run_command instead.
    if (context?.runLocation === 'sandbox') {
      return {
        CRITICAL_ERROR: '🔒 Sandbox: system_shell is disabled in sandbox mode for security. Use workspace_run_command instead — it provides the same functionality within the sandbox boundary.',
        stdout: '',
        stderr: '🔒 Sandbox: system_shell blocked. Use workspace_run_command.',
        exitCode: 126,
        executionTimeMs: 0,
      };
    }

    const startTime = Date.now();
    let authorization: any = null;

    // === AUTO-CWD EXTRACTION ===
    // Detect "cd path; command" pattern and extract workingDir automatically
    let effectiveCommand = input.command;
    let effectiveWorkingDir = input.workingDir;
    const cdExtraction = extractCdPrefix(effectiveCommand);
    if (cdExtraction) {
      console.log(`[Tool: system_shell] Auto-extracted cd prefix: dir="${cdExtraction.directory}", cmd="${cdExtraction.command.substring(0, 80)}"`);
      effectiveCommand = cdExtraction.command;
      if (!effectiveWorkingDir) {
        effectiveWorkingDir = cdExtraction.directory;
      }
    }

    // === CROSS-PLATFORM TRANSLATION ===
    if (process.platform === 'win32' && input.shellType !== 'cmd') {
      const translated = translateUnixToWindows(effectiveCommand);
      if (translated !== effectiveCommand) {
        console.log(`[Tool: system_shell] Auto-translated Unix->Windows: "${effectiveCommand.substring(0, 60)}" -> "${translated.substring(0, 60)}"`);
        effectiveCommand = translated;
      }
    }

    // === SMART TIMEOUT ===
    const autoTimeout = detectLongRunningTimeout(effectiveCommand);
    const explicitTimeout = input.timeoutSeconds ?? input.timeoutMs;
    const timeoutMs = autoTimeout > 0 && !explicitTimeout
      ? normalizeTimeoutMs(autoTimeout)
      : normalizeTimeoutMs(explicitTimeout);

    try {
      // Resolve working directory against the selected/pinned workspace.
      const cwd = resolveWorkspaceDirectoryForContext(effectiveWorkingDir, context);
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
      const cmd = effectiveCommand;
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
        ? effectiveCommand.replace(/\[Environment\]::GetFolderPath\(\s*Desktop\s*\)/g, "[Environment]::GetFolderPath('Desktop')")
        : effectiveCommand;

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
      authorization = await authorizeToolCommand({
        command,
        cwd,
        context,
        env: parsedEnv,
        timeoutMs,
        network: context?.networkPolicy === 'deny' ? 'deny' : 'allow',
      });
      if (!authorization.allowed) {
        return {
          stdout: '',
          stderr: authorization.reason || 'Command blocked by command broker',
          exitCode: 126,
          executionTimeMs: Date.now() - startTime,
          timeoutMs,
          cwd,
        };
      }
      const execEnv = authorization.env;

      if (context?.runLocation === 'sandbox' && authorization.session) {
        try {
          const { initializeSandbox, appendSandboxAudit } = require('../../../sandbox');
          await initializeSandbox(authorization.session);
          await appendSandboxAudit(authorization.session, {
            type: 'command.started',
            command,
            cwd: authorization.cwd,
            timeoutMs,
          });
        } catch (e) {
          console.error('Failed to log sandbox command start:', e);
        }
      }

      const { stdout, stderr } = await execAsync(command, {
        shell: shellExe,
        cwd: authorization.cwd,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer (up from default 1MB)
        timeout: timeoutMs,
        env: execEnv
      });

      const executionTime = Date.now() - startTime;

      // Truncate large outputs — keep significantly more lines so output doesn't get dropped
      // Old: 200+50 lines (caused ~40% loss). New: 500+150 lines.
      const truncatedStdout = truncateOutput(stdout, 500, 150);
      const truncatedStderr = truncateOutput(stderr, 100, 50);

      if (context?.runLocation === 'sandbox' && authorization.session) {
        try {
          const { appendSandboxAudit } = require('../../../sandbox');
          await appendSandboxAudit(authorization.session, {
            type: 'command.finished',
            command: input.command,
            cwd: authorization.cwd,
            exitCode: 0,
            timedOut: false,
            durationMs: executionTime,
          });
        } catch {}
      }

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
      if (context?.runLocation === 'sandbox' && authorization?.session) {
        try {
          const { appendSandboxAudit } = require('../../../sandbox');
          await appendSandboxAudit(authorization.session, {
            type: 'command.finished',
            command: input.command,
            cwd: authorization.cwd,
            exitCode: error.code || (isExecTimeoutError(error) ? 124 : 1),
            timedOut: isExecTimeoutError(error),
            durationMs: executionTime,
          }).catch(() => {});
        } catch {}
      }
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
