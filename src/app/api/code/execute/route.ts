import { NextRequest, NextResponse } from 'next/server';
import * as path from 'path';
import { getPathResolverInfo } from '@/lib/agent/workspace/path_resolver';
import { runTerminalCommandWithCheckIn } from '@/lib/agent/tools/core/terminal_background';
import { normalizeTerminalShell, resolveTerminalShell } from '@/lib/agent/tools/core/shell_resolver';
import { rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// POST: Execute a command in the workspace
export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const { command, cwd, terminalShell, background, timeoutSeconds, timeoutMs, checkInSeconds, checkInMs, hardTimeoutSeconds, hardTimeoutMs } = await req.json();

    if (!command) {
      return NextResponse.json({ error: 'command is required' }, { status: 400 });
    }

    const defaultDir = getPathResolverInfo().desktopPath;
    let workingDir = defaultDir;
    if (cwd === 'PROJECT_ROOT' || cwd === 'ETERX_ROOT') {
      workingDir = process.cwd();
    } else if (cwd) {
      workingDir = path.isAbsolute(cwd) ? cwd : path.resolve(defaultDir, cwd);
    }

    const checkInTimeoutMs = checkInSeconds !== undefined && checkInSeconds !== null
      ? Number(checkInSeconds) * 1000
      : checkInMs;
    const hardTimeoutValueMs = hardTimeoutSeconds !== undefined && hardTimeoutSeconds !== null
      ? Number(hardTimeoutSeconds) * 1000
      : hardTimeoutMs;

    const result = await runTerminalCommandWithCheckIn({
      command,
      cwd: workingDir,
      source: 'code_terminal',
      shell: resolveTerminalShell(normalizeTerminalShell(terminalShell)),
      env: { ...process.env, FORCE_COLOR: '0' },
      checkInMs: checkInTimeoutMs ?? timeoutSeconds ?? timeoutMs,
      hardTimeoutMs: hardTimeoutValueMs,
      maxOutputChars: 10 * 1024 * 1024,
      traceThrottleMs: 150,
      immediateHandoff: background === true,
      surviveRunSettlement: background === true,
    });

    return NextResponse.json({
      command,
      cwd: workingDir,
      stdout: result.output || result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      success: result.exitCode === 0 || Boolean(result.stillRunning),
      stillRunning: Boolean(result.stillRunning),
      backgroundTaskId: result.backgroundTaskId,
      taskId: result.taskId,
      pid: result.pid,
      nextActionNote: result.nextActionNote,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
