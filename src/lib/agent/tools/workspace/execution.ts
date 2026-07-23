import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import { createReadStream } from 'fs';
import { open as openFile } from 'fs/promises';
import * as readline from 'readline';
import { getPathResolverInfo, resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import {
  emitRuntimeTrace,
  isExecTimeoutError,
  normalizeTimeoutMs,
  terminalTimeoutNote
} from '../core/terminal_timeout';
import { authorizeToolCommand } from '../security/command_broker';
import { runTerminalCommandWithCheckIn } from '../core/terminal_background';
import { monitorEmitter } from '../../monitor/emitter';
import { resolveTerminalShell } from '../core/shell_resolver';

const execAsync = promisify(exec);

import { referencesDesktopHelperScript } from '../shared/desktop_guard';

/**
 * Detect if a command is a long-running install/build that needs a longer timeout.
 * Returns recommended timeout in seconds, or 0 if default is fine.
 */
function detectInstallTimeout(command: string): number {
  const lower = command.toLowerCase().trim();
  if (/\b(npm\s+(install|ci|i)\b|yarn\s*(install)?\b|pnpm\s+(install|i)\b|bun\s+install\b)/i.test(lower)) return 120;
  if (/\b(pip\s+install|pip3\s+install|poetry\s+install|pipenv\s+install)/i.test(lower)) return 120;
  if (/\b(cargo\s+(build|install)|rustup)/i.test(lower)) return 120;
  if (/\b(dotnet\s+(build|restore|publish))/i.test(lower)) return 120;
  if (/\b(mvn\s+(install|package|compile)|gradle\s+(build|assemble))/i.test(lower)) return 120;
  if (/\b(npm\s+run\s+build|yarn\s+build|pnpm\s+build|next\s+build|vite\s+build|tsc\b)/i.test(lower)) return 120;
  if (/\b(npm\s+create|npx\s)/i.test(lower)) return 120;
  return 0;
}

export const workspaceRunCommandTool: ToolDefinition = {
  name: 'workspace_run_command',
  description: 'Execute a finite shell command inside any directory with streamed output and a configurable timeout (default 30s, max 2 min). Install/build commands (npm install, pip install, cargo build, etc.) auto-get 120s timeout. Supports absolute paths and relative workspace paths. NEVER use "cd path;" prefix — use the cwd parameter instead. Use process_manager/background_task plus wait_timer for long-running servers, watchers, or builds that exceed 2 minutes.',
  category: 'workspace',
  inputSchema: z.object({
    command: z.string().describe('The command to execute (e.g., "npm test", "ls -la"). Do NOT prefix with "cd path;"'),
    timeoutSeconds: z.number().optional().describe('Optional command timeout in seconds. Default: 30 seconds. Max: 120 seconds. Auto-set to 120s for install/build commands.'),
    cwd: z.string().optional().describe('Working directory — ABSOLUTE PATH preferred, or relative to workspace root. Default: workspace root'),
    background: z.boolean().optional().describe('If true, spawns the command in the background as a managed process and returns immediately without blocking. Ideal for build steps, installations, servers, or long tasks.')
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    timedOut: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    processId: z.string().optional(),
    nextActionNote: z.string().optional(),
    stillRunning: z.boolean().optional(),
    backgroundTaskId: z.string().optional()
  }),
  execute: async (input: { command: string, cwd?: string, timeoutSeconds?: number, timeoutMs?: number, background?: boolean }, context: any) => {
    const runDir = resolveWorkspaceDirectoryForContext(input.cwd, context);

    // Smart timeout: auto-detect install/build commands
    const autoTimeout = detectInstallTimeout(input.command);
    const explicitTimeout = input.timeoutSeconds ?? input.timeoutMs;
    const timeoutMs = autoTimeout > 0 && !explicitTimeout
      ? normalizeTimeoutMs(autoTimeout)
      : normalizeTimeoutMs(explicitTimeout);

    const portableSampling = getPortableSamplingRequest(input.command);
    if (portableSampling) {
      return {
        stdout: await runPortableSampling(portableSampling, runDir),
        stderr: '',
        exitCode: 0
      };
    }

    if (!await fs.pathExists(runDir)) {
      return {
        stdout: '',
        stderr: `Working directory not found: ${runDir}`,
        exitCode: 1
      };
    }

    if (referencesDesktopHelperScript(input.command, runDir)) {
      return {
        stdout: '',
        stderr: '⚠️ HINT: This command references a script directly on the Desktop root, which is typically a UI automation helper. Use computer or screen_agent directly for real app control. If this is intentionally a project script, move it into the project directory.',
        exitCode: 1
      };
    }

    try {
      const result = await runTerminalCommandWithCheckIn({
        command: input.command,
        cwd: runDir,
        source: 'workspace_run_command',
        context,
        shell: resolveTerminalShell(context?.terminalShell),
        checkInMs: input.background ? 1 : timeoutMs,
        hardTimeoutMs: undefined, // Keep background running up to EterX's 30-minute limit
        immediateHandoff: input.background === true,
        surviveRunSettlement: input.background === true,
      });

      return {
        stdout: result.output || result.stdout,
        stderr: result.stderr || '',
        exitCode: result.exitCode ?? (result.success ? 0 : 1),
        timedOut: Boolean(result.timedOut),
        timeoutMs: result.timeoutMs,
        processId: result.taskId,
        nextActionNote: result.nextActionNote,
        stillRunning: Boolean(result.stillRunning),
        backgroundTaskId: result.backgroundTaskId || result.taskId
      };
    } catch (error: any) {
      return {
        stdout: '',
        stderr: error.message,
        exitCode: 1
      };
    }
  }
};

function getPortableSamplingRequest(command: string): { mode: 'head' | 'tail'; lines: number; target: string } | null {
  const trimmed = command.trim();
  const headMatch = /^head\s+-n\s+(\d+)\s+(.+)$/i.exec(trimmed);
  if (headMatch) {
    return { mode: 'head', lines: Number(headMatch[1]), target: stripShellQuotes(headMatch[2]) };
  }
  const tailMatch = /^tail\s+-n\s+(\d+)\s+(.+)$/i.exec(trimmed);
  if (tailMatch) {
    return { mode: 'tail', lines: Number(tailMatch[1]), target: stripShellQuotes(tailMatch[2]) };
  }
  return null;
}

function stripShellQuotes(value: string): string {
  const clean = value.trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    return clean.slice(1, -1);
  }
  return clean;
}

async function runPortableSampling(request: { mode: 'head' | 'tail'; lines: number; target: string }, cwd: string): Promise<string> {
  const targetPath = path.isAbsolute(request.target) ? request.target : path.resolve(cwd, request.target);
  if (!await fs.pathExists(targetPath)) {
    return `File not found: ${targetPath}`;
  }
  const content = request.mode === 'head'
    ? await readHeadLines(targetPath, request.lines)
    : await readTailLines(targetPath, request.lines);
  return [
    `[workspace_run_command used portable ${request.mode} reader for Windows compatibility]`,
    content
  ].filter(Boolean).join('\n');
}

async function readHeadLines(filePath: string, maxLines: number): Promise<string> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  try {
    for await (const line of rl) {
      if (lines.length >= maxLines) break;
      lines.push(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return lines.join('\n');
}

async function readTailLines(filePath: string, maxLines: number): Promise<string> {
  const handle = await openFile(filePath, 'r');
  const stat = await handle.stat();
  const chunkSize = 64 * 1024;
  const chunks: string[] = [];
  let position = stat.size;
  let newlineCount = 0;

  try {
    while (position > 0 && newlineCount <= maxLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, position);
      const text = buffer.toString('utf-8');
      chunks.unshift(text);
      newlineCount += (text.match(/\n/g) || []).length;
    }
  } finally {
    await handle.close();
  }

  const lines = chunks.join('').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

export const workspaceExecuteScriptTool: ToolDefinition = {
  name: 'workspace_execute_script',
  description: 'Run a one-shot analysis/transform script without writing persistent project files. Use for inspections, migrations, smoke checks, or generated transforms.',
  category: 'workspace',
  inputSchema: z.object({
    language: z.enum(['powershell', 'node', 'python']).describe('Script runtime'),
    script: z.string().describe('Script source to execute once'),
    cwd: z.string().optional().describe('Working directory. Default: workspace root'),
    timeoutSeconds: z.number().optional().describe('Timeout in seconds (default: 60, max: 120)'),
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    timedOut: z.boolean().optional(),
  }),
  execute: async (input: { language: 'powershell' | 'node' | 'python'; script: string; cwd?: string; timeoutSeconds?: number }, context: any) => {
    const runDir = resolveWorkspaceDirectoryForContext(input.cwd, context);
    const timeoutMs = normalizeTimeoutMs(input.timeoutSeconds ?? 60);

    if (!await fs.pathExists(runDir)) {
      return { stdout: '', stderr: `Working directory not found: ${runDir}`, exitCode: 1 };
    }

    const ext = input.language === 'powershell' ? '.ps1' : input.language === 'python' ? '.py' : '.mjs';
    const scriptPath = path.join(runDir, `.eterx-temp-${Date.now()}${ext}`);

    try {
      if (context?.abortSignal?.aborted || context?.isCancelled?.()) {
        return { stdout: '', stderr: 'Script cancelled by user.', exitCode: 130, cancelled: true, timeoutMs };
      }

      await fs.writeFile(scriptPath, input.script, 'utf-8');
      const powerShellExecutable = resolveTerminalShell('powershell');
      const command =
        input.language === 'powershell' ? `"${powerShellExecutable}" -NoProfile -NonInteractive ${process.platform === 'win32' ? '-ExecutionPolicy Bypass ' : ''}-File "${scriptPath}"` :
        input.language === 'python' ? `python "${scriptPath}"` :
        `node "${scriptPath}"`;

      const authorization = await authorizeToolCommand({
        command,
        cwd: runDir,
        context,
        timeoutMs,
        network: context?.networkPolicy === 'deny' ? 'deny' : 'allow',
      });
      if (!authorization.allowed) {
        return {
          stdout: '',
          stderr: authorization.reason || 'Command blocked by command broker',
          exitCode: 126,
          timeoutMs,
        };
      }

      const result = await runTerminalCommandWithCheckIn({
        command,
        cwd: authorization.cwd,
        env: authorization.env,
        source: 'workspace_execute_script',
        description: `${input.language} inline script`,
        context,
        shell: resolveTerminalShell(context?.terminalShell),
        checkInMs: timeoutMs,
        hardTimeoutMs: Math.max(timeoutMs + 1_000, 30 * 60_000),
      });

      return {
        stdout: String(result.stdout || result.output || '').slice(0, 30000),
        stderr: String(result.stderr || '').slice(0, 8000),
        exitCode: result.exitCode ?? (result.success ? 0 : 1),
        timeoutMs,
        stillRunning: Boolean(result.stillRunning),
        backgroundTaskId: result.backgroundTaskId,
        taskId: result.taskId,
        nextActionNote: result.nextActionNote,
        _consoleTraceEmitted: true,
      };
    } catch (error: any) {
      if (error?.name === 'AbortError' || context?.abortSignal?.aborted || context?.isCancelled?.()) {
        return {
          stdout: String(error.stdout || '').slice(0, 30000),
          stderr: 'Script cancelled by user.',
          exitCode: 130,
          cancelled: true,
          timeoutMs,
        };
      }
      if (isExecTimeoutError(error)) {
        const note = terminalTimeoutNote('workspace_execute_script', timeoutMs);
        return {
          stdout: String(error.stdout || '').slice(0, 30000),
          stderr: `${String(error.stderr || error.message || '').slice(0, 8000)}\n${note}`,
          exitCode: 1,
          timedOut: true,
          timeoutMs,
        };
      }
      return {
        stdout: String(error.stdout || '').slice(0, 30000),
        stderr: String(error.stderr || error.message || '').slice(0, 8000),
        exitCode: typeof error.code === 'number' ? error.code : 1,
        timeoutMs,
      };
    } finally {
      try { await fs.remove(scriptPath); } catch { /* temp cleanup */ }
    }
  },
};

export const workspaceVerifyCodeTool: ToolDefinition = {
  name: 'workspace_verify_code',
  description: 'Automatically run finite verification checks (lint/build/test) in any directory and report error/warning counts. Has a configurable timeout (default 30s, max 2 minutes). Supports absolute and relative paths. Automatically detects framework (Python, Rust, Java, standard Node/Yarn/PNPM).',
  category: 'workspace',
  inputSchema: z.object({
    checkType: z.enum(['lint', 'build', 'test']).describe('The type of verification to perform'),
    timeoutSeconds: z.number().optional().describe('Optional verification timeout in seconds. Default: 30 seconds. Max: 120 seconds.'),
    cwd: z.string().optional().describe('Working directory — absolute or relative. Default: workspace root')
  }),
  outputSchema: z.object({
    passed: z.boolean(),
    errors: z.number(),
    warnings: z.number(),
    output: z.string(),
    commandUsed: z.string(),
    timedOut: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    nextActionNote: z.string().optional()
  }),
  execute: async (input: { checkType: 'lint' | 'build' | 'test', cwd?: string, timeoutSeconds?: number, timeoutMs?: number }, context: any) => {
    const workDir = resolveWorkspaceDirectoryForContext(input.cwd, context);
    const timeoutMs = normalizeTimeoutMs(input.timeoutSeconds ?? input.timeoutMs);

    // Dynamic resolution based on Project Intelligence
    const { workspaceIntelligence } = require('../../engines');
    const profile = await workspaceIntelligence.getProfile();
    let command = '';

    if (profile.language === 'Python') {
      if (input.checkType === 'lint') command = 'flake8 .';
      else if (input.checkType === 'test') command = 'pytest';
      else command = 'python -m compileall .';
    } else if (profile.language === 'Rust') {
      if (input.checkType === 'lint') command = 'cargo clippy';
      else if (input.checkType === 'test') command = 'cargo test';
      else command = 'cargo build';
    } else if (profile.language === 'Go') {
      if (input.checkType === 'lint') command = 'go vet ./...';
      else if (input.checkType === 'test') command = 'go test ./...';
      else command = 'go build ./...';
    } else if (profile.language === 'Java') {
      const tool = profile.hasMaven ? 'mvn' : 'gradle';
      if (input.checkType === 'test') command = `${tool} test`;
      else command = `${tool} build`;
    } else {
      // Default to JS/TS ecosystem with dynamic package manager
      const pm = profile.packageManager === 'yarn' ? 'yarn' : profile.packageManager === 'pnpm' ? 'pnpm' : profile.packageManager === 'bun' ? 'bun' : 'npm run';
      if (input.checkType === 'lint') command = `${pm} lint`;
      else if (input.checkType === 'build') command = `${pm} build`;
      else if (input.checkType === 'test') command = `${profile.packageManager === 'yarn' ? 'yarn test' : profile.packageManager === 'pnpm' ? 'pnpm test' : profile.packageManager === 'bun' ? 'bun test' : 'npm test'}`;
    }

    console.log(`[Tool: workspace_verify_code] Verifying with: ${command} in ${workDir}`);
    
    try {
      if (context?.abortSignal?.aborted || context?.isCancelled?.()) {
        return {
          passed: false,
          errors: 1,
          warnings: 0,
          output: 'Verification cancelled by user.',
          commandUsed: command,
          cancelled: true,
          timeoutMs,
        };
      }
      const authorization = await authorizeToolCommand({
        command,
        cwd: workDir,
        context,
        timeoutMs,
        network: context?.networkPolicy === 'deny' ? 'deny' : 'allow',
      });
      if (!authorization.allowed) {
        return {
          passed: false,
          errors: 1,
          warnings: 0,
          output: authorization.reason || 'Command blocked by command broker',
          commandUsed: command,
          timeoutMs,
        };
      }
      const { stdout, stderr } = await execAsync(command, { 
        cwd: authorization.cwd,
        env: authorization.env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
        signal: context?.abortSignal,
      });
      const output = stdout + stderr;
      
      const errorMatch = output.match(/(\d+)\s+errors?/i);
      const warnMatch = output.match(/(\d+)\s+warnings?/i);
      
      return {
        passed: true,
        errors: errorMatch ? parseInt(errorMatch[1]) : 0,
        warnings: warnMatch ? parseInt(warnMatch[1]) : 0,
        output: output.substring(0, 5000),
        commandUsed: command,
        timeoutMs
      };
    } catch (error: any) {
      const output = (error.stdout || '') + (error.stderr || error.message);
      const errorMatch = output.match(/(\d+)\s+errors?/i);
      if (error?.name === 'AbortError' || context?.abortSignal?.aborted || context?.isCancelled?.()) {
        return {
          passed: false,
          errors: errorMatch ? parseInt(errorMatch[1]) : 1,
          warnings: 0,
          output: 'Verification cancelled by user.',
          commandUsed: command,
          cancelled: true,
          timeoutMs,
        };
      }
      if (isExecTimeoutError(error)) {
        const note = terminalTimeoutNote(command, timeoutMs);
        emitRuntimeTrace(context, {
          type: 'timer_expired',
          text: 'Verification check: Timer has expired',
          title: 'Verification check',
          note,
          durationMs: timeoutMs,
          command,
          iconCategory: 'terminal'
        });
        return {
          passed: false,
          errors: errorMatch ? parseInt(errorMatch[1]) : 1,
          warnings: 0,
          output: `${output.substring(0, 4500)}\n\n${note}`.substring(0, 5000),
          commandUsed: command,
          timedOut: true,
          timeoutMs,
          nextActionNote: note
        };
      }
      
      return {
        passed: false,
        errors: errorMatch ? parseInt(errorMatch[1]) : 1,
        warnings: 0,
        output: output.substring(0, 5000),
        commandUsed: command,
        timeoutMs
      };
    }
  }
};
