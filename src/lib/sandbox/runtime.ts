import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import {
  appendSandboxAudit,
  buildSandboxEnv,
  checkSandboxCommand,
  checkSandboxPath,
  initializeSandbox,
} from './policy';
import { SandboxCommandInput, SandboxCommandResult, SandboxSession } from './types';
import { buildTerminalShellInvocation } from '../agent/tools/core/shell_resolver';

export async function runSandboxCommand(
  session: SandboxSession,
  input: SandboxCommandInput,
): Promise<SandboxCommandResult> {
  await initializeSandbox(session);

  const cwd = path.resolve(input.cwd || session.workspaceRoot);
  const decision = checkSandboxCommand(session, input.command, cwd);
  if (!decision.allowed) {
    await appendSandboxAudit(session, {
      type: 'command.blocked',
      command: input.command,
      cwd,
      reason: decision.reason,
    });
    return {
      command: input.command,
      cwd,
      stdout: '',
      stderr: decision.reason,
      exitCode: 126,
      timedOut: false,
      durationMs: 0,
    };
  }

  await fs.ensureDir(cwd);
  const timeoutMs = input.timeoutMs || session.timeoutMs;
  const startedAt = Date.now();
  const env = buildSandboxEnv(session, input.env);

  await appendSandboxAudit(session, {
    type: 'command.started',
    command: input.command,
    cwd,
    timeoutMs,
  });

  return new Promise((resolve) => {
    const invocation = buildTerminalShellInvocation(input.command);
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const trim = (value: string) => {
      if (value.length <= session.maxOutputChars) return value;
      return `...[${value.length - session.maxOutputChars} chars truncated]...\n${value.slice(-session.maxOutputChars)}`;
    };

    const finish = async (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const result: SandboxCommandResult = {
        command: input.command,
        cwd,
        stdout: trim(stdout),
        stderr: trim(stderr),
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
      };

      await appendSandboxAudit(session, {
        type: 'command.finished',
        command: input.command,
        cwd,
        exitCode,
        timedOut,
        durationMs: result.durationMs,
      });
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\nSandbox command timed out after ${timeoutMs}ms.\n`;
      killProcessTree(child.pid);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', chunk => {
      stdout = trim(stdout + chunk.toString());
    });
    child.stderr?.on('data', chunk => {
      stderr = trim(stderr + chunk.toString());
    });
    child.on('close', code => {
      finish(timedOut ? 124 : code ?? 0).catch(() => resolve({
        command: input.command,
        cwd,
        stdout: trim(stdout),
        stderr: trim(stderr),
        exitCode: timedOut ? 124 : code ?? 1,
        timedOut,
        durationMs: Date.now() - startedAt,
      }));
    });
    child.on('error', error => {
      stderr += error.message;
      finish(1).catch(() => resolve({
        command: input.command,
        cwd,
        stdout: trim(stdout),
        stderr: trim(stderr),
        exitCode: 1,
        timedOut,
        durationMs: Date.now() - startedAt,
      }));
    });
  });
}

export async function readSandboxFile(session: SandboxSession, filename: string): Promise<string> {
  await initializeSandbox(session);
  const filePath = path.resolve(session.workspaceRoot, filename);
  const decision = checkSandboxPath(session, filePath, 'read');
  if (!decision.allowed) {
    await appendSandboxAudit(session, { type: 'file.read.blocked', path: filePath, reason: decision.reason });
    throw new Error(decision.reason);
  }
  await appendSandboxAudit(session, { type: 'file.read', path: filePath });
  return fs.readFile(filePath, 'utf8');
}

export async function writeSandboxFile(session: SandboxSession, filename: string, content: string): Promise<string> {
  await initializeSandbox(session);
  const baseRoot = session.mode === 'ephemeral' ? session.root : session.workspaceRoot;
  const filePath = path.resolve(baseRoot, filename);
  const decision = checkSandboxPath(session, filePath, 'write');
  if (!decision.allowed) {
    await appendSandboxAudit(session, { type: 'file.write.blocked', path: filePath, reason: decision.reason });
    throw new Error(decision.reason);
  }
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
  await appendSandboxAudit(session, { type: 'file.write', path: filePath, bytes: Buffer.byteLength(content) });
  return filePath;
}

export async function cleanupSandbox(session: SandboxSession): Promise<void> {
  await appendSandboxAudit(session, { type: 'sandbox.cleanup' });
  await fs.remove(session.root);
}

function killProcessTree(pid?: number) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already stopped.
    }
  }, 2_000);
  timer.unref?.();
}
