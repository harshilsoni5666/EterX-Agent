import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import { createReadStream } from 'fs';
import { open as openFile } from 'fs/promises';
import * as readline from 'readline';

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 120000;

export const workspaceRunCommandTool: ToolDefinition = {
  name: 'workspace_run_command',
  description: 'Execute a shell command inside any directory. Supports absolute paths (C:\\path\\to\\dir) and relative workspace paths. Use this to run tests, build projects, install dependencies, or execute any command.',
  category: 'workspace',
  inputSchema: z.object({
    command: z.string().describe('The command to execute (e.g., "npm test", "ls -la")'),
    cwd: z.string().optional().describe('Working directory — absolute path or relative to workspace root. Default: workspace root')
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number()
  }),
  execute: async (input: { command: string, cwd?: string }, context: any) => {
    const portableSampling = getPortableSamplingRequest(input.command);
    if (portableSampling) {
      return {
        stdout: await runPortableSampling(portableSampling),
        stderr: '',
        exitCode: 0
      };
    }

    let runDir: string;
    if (input.cwd && path.isAbsolute(input.cwd)) {
      runDir = input.cwd;
    } else {
      runDir = input.cwd ? path.resolve(process.cwd(), input.cwd) : process.cwd();
    }

    if (!await fs.pathExists(runDir)) {
      return {
        stdout: '',
        stderr: `Working directory not found: ${runDir}`,
        exitCode: 1
      };
    }

    console.log(`[Tool: workspace_run_command] Executing: ${input.command} in ${runDir}`);
    
    try {
      const { taskStore } = require('../../task-store');
      let combinedOutput = '';

      return new Promise((resolve) => {
        const { spawn } = require('child_process');
        // Run via shell to get exact command execution semantics
        let timedOut = false;
        const child = spawn(input.command, { 
          cwd: runDir, 
          shell: true,
          timeout: COMMAND_TIMEOUT_MS
        });
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          combinedOutput += `\n[Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s and was stopped]\n`;
          child.kill('SIGTERM');
        }, COMMAND_TIMEOUT_MS + 500);

        // Throttle updates to UI so we don't crash the React tree
        let UIThrottleBuffer = '';
        let lastUITick = Date.now();

        const flushToUI = () => {
          if (UIThrottleBuffer.length > 0) {
            const consoleEvt = {
              type: 'console_output',
              command: input.command,
              content: combinedOutput.slice(-3000) // Keep the window scrolling logic clean
            };
            // Primary: emit through onTrace callback (reaches UI in real-time)
            if (context?._onTrace) {
              context._onTrace(consoleEvt);
            }
            // Secondary: also persist to taskStore if chatId is available
            if (context?.chatId) {
              taskStore.addTrace(context.chatId, consoleEvt);
            }
            UIThrottleBuffer = '';
            lastUITick = Date.now();
          }
        };

        const handleData = (chunk: Buffer) => {
          const text = chunk.toString();
          combinedOutput += text;
          UIThrottleBuffer += text;

          // Cap the internal output length to prevent memory blowouts
          if (combinedOutput.length > 5 * 1024 * 1024) {
            combinedOutput = combinedOutput.substring(combinedOutput.length - 2 * 1024 * 1024);
          }

          if (Date.now() - lastUITick > 150) {
            flushToUI();
          }
        };

        child.stdout.on('data', handleData);
        child.stderr.on('data', handleData);

        child.on('close', (code: number) => {
          clearTimeout(timeoutHandle);
          flushToUI(); // Final flush
          
          // Cap output sent back to API to prevent massive 50s API latencies
          // We keep the LAST 30,000 chars because terminal output usually has the important errors/results at the end.
          let finalOutput = combinedOutput;
          if (finalOutput.length > 30000) {
            finalOutput = `...[TRUNCATED ${finalOutput.length - 30000} chars]...\n` + finalOutput.substring(finalOutput.length - 30000);
          }
          
          resolve({
            stdout: finalOutput,
            stderr: '', // Already combined into stdout for simplicity
            exitCode: timedOut ? 124 : (code ?? 0)
          });
        });

        child.on('error', (err: any) => {
          clearTimeout(timeoutHandle);
          flushToUI();
          resolve({
            stdout: combinedOutput,
            stderr: err.message,
            exitCode: 1
          });
        });
      });
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

async function runPortableSampling(request: { mode: 'head' | 'tail'; lines: number; target: string }): Promise<string> {
  const targetPath = path.isAbsolute(request.target) ? request.target : path.resolve(process.cwd(), request.target);
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
  description: 'Automatically run verification checks (lint/build/test) in any directory and report error/warning counts. Supports absolute and relative paths. Automatically detects framework (Python, Rust, Java, standard Node/Yarn/PNPM).',
  category: 'workspace',
  inputSchema: z.object({
    checkType: z.enum(['lint', 'build', 'test']).describe('The type of verification to perform'),
    cwd: z.string().optional().describe('Working directory — absolute or relative. Default: workspace root')
  }),
  outputSchema: z.object({
    passed: z.boolean(),
    errors: z.number(),
    warnings: z.number(),
    output: z.string(),
    commandUsed: z.string()
  }),
  execute: async (input: { checkType: 'lint' | 'build' | 'test', cwd?: string }, context: any) => {
    let workDir: string;
    if (input.cwd && path.isAbsolute(input.cwd)) {
      workDir = input.cwd;
    } else {
      workDir = input.cwd ? path.resolve(process.cwd(), input.cwd) : process.cwd();
    }

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
      const { stdout, stderr } = await execAsync(command, { 
        cwd: workDir,
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
      });
      const output = stdout + stderr;
      
      const errorMatch = output.match(/(\d+)\s+errors?/i);
      const warnMatch = output.match(/(\d+)\s+warnings?/i);
      
      return {
        passed: true,
        errors: errorMatch ? parseInt(errorMatch[1]) : 0,
        warnings: warnMatch ? parseInt(warnMatch[1]) : 0,
        output: output.substring(0, 5000),
        commandUsed: command
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
