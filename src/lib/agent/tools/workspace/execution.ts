import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import { createReadStream } from 'fs';
import { open as openFile } from 'fs/promises';
import * as readline from 'readline';
import { getPathResolverInfo, resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import {
  normalizeCheckInMs,
  normalizeHardTimeoutMs
} from '../core/terminal_timeout';
import { runTerminalCommandWithCheckIn } from '../core/terminal_background';

const HELPER_SCRIPT_PATTERN = /\.(py|ps1|js|mjs|cjs|bat|cmd|vbs|ahk)(['"\s]|$)/i;
const MAX_TERMINAL_OUTPUT_BUFFER_CHARS = 10 * 1024 * 1024;

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

export const workspaceRunCommandTool: ToolDefinition = {
  name: 'workspace_run_command',
  description: 'Execute a project command with streamed output. If it is still running after the check-in timer (default 15s; timeoutSeconds/checkInSeconds override it), the process is kept alive in the background and this returns backgroundTaskId. Do not rerun handed-off commands; call wait_timer, then background_task mode="check". Supports absolute paths and relative workspace paths.',
  category: 'workspace',
  inputSchema: z.object({
    command: z.string().describe('The command to execute (e.g., "npm test", "ls -la")'),
    timeoutSeconds: z.number().optional().describe('Alias for the first check-in timer in seconds. Default is about 15 seconds.'),
    checkInSeconds: z.number().optional().describe('Seconds to wait before handing a still-running command to the background. Default is about 15 seconds.'),
    hardTimeoutSeconds: z.number().optional().describe('Hard safety timeout in seconds for stuck commands after handoff. Default is 30 minutes.'),
    cwd: z.string().optional().describe('Working directory — absolute path or relative to workspace root. Default: workspace root')
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    timedOut: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    stillRunning: z.boolean().optional(),
    backgroundTaskId: z.string().optional(),
    nextActionNote: z.string().optional()
  }),
  execute: async (input: { command: string, cwd?: string, timeoutSeconds?: number, timeoutMs?: number, checkInSeconds?: number, checkInMs?: number, hardTimeoutSeconds?: number, hardTimeoutMs?: number }, context: any) => {
    const runDir = resolveWorkspaceDirectoryForContext(input.cwd, context);
    const checkInMs = normalizeCheckInMs(input.checkInSeconds ?? input.checkInMs ?? input.timeoutSeconds ?? input.timeoutMs, input.command);
    const hardTimeoutMs = normalizeHardTimeoutMs(input.hardTimeoutSeconds ?? input.hardTimeoutMs, checkInMs);

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

    console.log(`[Tool: workspace_run_command] Executing: ${input.command} in ${runDir}`);
    
    try {
      const result = await runTerminalCommandWithCheckIn({
        command: input.command,
        cwd: runDir,
        source: 'workspace_run_command',
        context,
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0' },
        checkInMs,
        hardTimeoutMs,
        maxOutputChars: MAX_TERMINAL_OUTPUT_BUFFER_CHARS,
        traceThrottleMs: 150
      });
      return { ...result, stdout: result.output || result.stdout || '' };
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

export const workspaceVerifyCodeTool: ToolDefinition = {
  name: 'workspace_verify_code',
  description: 'Automatically run verification checks (lint/build/test) in any directory and report error/warning counts. Uses the terminal check-in protocol: if still running after about 15s, the process stays alive in the background and returns backgroundTaskId. Call wait_timer, then background_task mode="check"; do not rerun the same verification blindly.',
  category: 'workspace',
  inputSchema: z.object({
    checkType: z.enum(['lint', 'build', 'test']).describe('The type of verification to perform'),
    timeoutSeconds: z.number().optional().describe('Alias for the first check-in timer in seconds. Default is about 15 seconds.'),
    checkInSeconds: z.number().optional().describe('Seconds to wait before handing a still-running verification command to the background.'),
    hardTimeoutSeconds: z.number().optional().describe('Hard safety timeout in seconds for stuck verification commands after handoff. Default is 30 minutes.'),
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
    stillRunning: z.boolean().optional(),
    backgroundTaskId: z.string().optional(),
    nextActionNote: z.string().optional()
  }),
  execute: async (input: { checkType: 'lint' | 'build' | 'test', cwd?: string, timeoutSeconds?: number, timeoutMs?: number, checkInSeconds?: number, checkInMs?: number, hardTimeoutSeconds?: number, hardTimeoutMs?: number }, context: any) => {
    const workDir = resolveWorkspaceDirectoryForContext(input.cwd, context);

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
      const checkInMs = normalizeCheckInMs(input.checkInSeconds ?? input.checkInMs ?? input.timeoutSeconds ?? input.timeoutMs, command);
      const hardTimeoutMs = normalizeHardTimeoutMs(input.hardTimeoutSeconds ?? input.hardTimeoutMs, checkInMs);
      const result = await runTerminalCommandWithCheckIn({
        command,
        cwd: workDir,
        source: 'workspace_verify_code',
        context,
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0' },
        checkInMs,
        hardTimeoutMs,
        maxOutputChars: MAX_TERMINAL_OUTPUT_BUFFER_CHARS,
        traceThrottleMs: 150
      });
      const output = result.output || `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
      
      const errorMatch = output.match(/(\d+)\s+errors?/i);
      const warnMatch = output.match(/(\d+)\s+warnings?/i);

      if (result.stillRunning) {
        return {
          passed: false,
          errors: 0,
          warnings: warnMatch ? parseInt(warnMatch[1]) : 0,
          output: output.substring(0, 5000),
          commandUsed: command,
          timedOut: false,
          timeoutMs: checkInMs,
          stillRunning: true,
          backgroundTaskId: result.backgroundTaskId,
          nextActionNote: result.nextActionNote
        };
      }
      
      return {
        passed: result.exitCode === 0,
        errors: result.exitCode === 0 ? (errorMatch ? parseInt(errorMatch[1]) : 0) : (errorMatch ? parseInt(errorMatch[1]) : 1),
        warnings: warnMatch ? parseInt(warnMatch[1]) : 0,
        output: output.substring(0, 5000),
        commandUsed: command,
        timedOut: Boolean(result.timedOut),
        timeoutMs: checkInMs,
        backgroundTaskId: result.backgroundTaskId,
        nextActionNote: result.nextActionNote
      };
    } catch (error: any) {
      const output = (error.stdout || '') + (error.stderr || error.message);
      const errorMatch = output.match(/(\d+)\s+errors?/i);
      return {
        passed: false,
        errors: errorMatch ? parseInt(errorMatch[1]) : 1,
        warnings: 0,
        output: output.substring(0, 5000),
        commandUsed: command
      };
    }
  }
};
