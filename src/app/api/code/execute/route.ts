import { NextRequest, NextResponse } from 'next/server';
import { resolveWorkspaceDirectoryForContext } from '@/lib/agent/workspace/path_resolver';
import { initializeChatWorkspace } from '@/lib/agent/workspace/runtime-context';
import { runTerminalCommandWithCheckIn } from '@/lib/agent/tools/core/terminal_background';
import { normalizeTerminalShell, resolveTerminalShell } from '@/lib/agent/tools/core/shell_resolver';
import { rejectCrossOrigin } from '../../agent/_shared';
import { formatUnknownError } from '@/lib/agent/error-format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// POST: Execute a command in the workspace
export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const { command, cwd, terminalShell, background, timeoutSeconds, timeoutMs, checkInSeconds, checkInMs, hardTimeoutSeconds, hardTimeoutMs, chatId, ownerTraceId, runId } = await req.json();

    if (!command) {
      return NextResponse.json({ error: 'command is required' }, { status: 400 });
    }

    if (!cwd && (typeof chatId !== 'string' || !chatId.trim())) {
      return NextResponse.json({ error: 'Provide a chatId or an explicit working directory.' }, { status: 400 });
    }
    const routing = typeof chatId === 'string' && chatId.trim()
      ? await initializeChatWorkspace(chatId, 'default') : undefined;
    const workingDir = resolveWorkspaceDirectoryForContext(cwd, routing);

    const checkInTimeoutMs = checkInSeconds !== undefined && checkInSeconds !== null
      ? Number(checkInSeconds) * 1000
      : checkInMs ?? (timeoutSeconds != null ? Number(timeoutSeconds) * 1000 : timeoutMs);
    const hardTimeoutValueMs = hardTimeoutSeconds !== undefined && hardTimeoutSeconds !== null
      ? Number(hardTimeoutSeconds) * 1000
      : hardTimeoutMs;

    let resolvedShell: string;
    try {
      resolvedShell = resolveTerminalShell(normalizeTerminalShell(terminalShell));
    } catch (error: any) {
      const message = String(error?.message || error);
      return NextResponse.json({
        command,
        cwd: workingDir,
        stdout: '',
        stderr: message,
        exitCode: 127,
        success: false,
        stillRunning: false,
        error: message,
      }, { status: 400 });
    }

    const result = await runTerminalCommandWithCheckIn({
      command,
      cwd: workingDir,
      source: 'code_terminal',
      shell: resolvedShell,
      env: { FORCE_COLOR: '0' },
      checkInMs: checkInTimeoutMs,
      hardTimeoutMs: hardTimeoutValueMs,
      maxOutputChars: 10 * 1024 * 1024,
      traceThrottleMs: 100,
      immediateHandoff: background === true,
      surviveRunSettlement: background === true,
      context: {
        ...routing,
        chatId: typeof chatId === 'string' ? chatId : undefined,
        projectId: typeof chatId === 'string' ? chatId : undefined,
        ownerTraceId: typeof ownerTraceId === 'string' ? ownerTraceId : undefined,
        runId: typeof runId === 'string' ? runId : undefined,
        abortSignal: req.signal,
      },
    });

    return NextResponse.json({
      command,
      cwd: workingDir,
      shell: result.shell || resolvedShell,
      stdout: result.output || result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      success: result.exitCode === 0 || Boolean(result.stillRunning),
      stillRunning: Boolean(result.stillRunning),
      backgroundTaskId: result.backgroundTaskId,
      taskId: result.taskId,
      streamId: result.streamId,
      pid: result.pid,
      status: result.status,
      durationMs: result.executionTimeMs,
      totalOutputChars: result.totalOutputChars,
      droppedOutputChars: result.droppedOutputChars,
      nextActionNote: result.nextActionNote,
    });
  } catch (error: any) {
    return NextResponse.json({ error: formatUnknownError(error, 'Command execution failed') }, { status: 500 });
  }
}
