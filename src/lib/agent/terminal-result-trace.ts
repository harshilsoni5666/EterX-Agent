import { formatTerminalProgram } from './terminal-invocation';

/** Shared presentation for terminal results that do not own a process stream. */
export function terminalInvocationText(args: any): string {
  if (typeof args?.command === 'string' && args.command.trim()) return args.command;
  if (typeof args?.program === 'string') {
    return formatTerminalProgram(args.program, Array.isArray(args.args) ? args.args : []);
  }
  if (Array.isArray(args?.commands)) return args.commands.map(terminalInvocationText).join('\n');
  return [args?.mode, args?.taskId].filter(Boolean).join(' ');
}

export function terminalResultText(result: any, mode = 'run'): string {
  if (result == null) return '';
  if (typeof result !== 'object') return String(result);
  const text = (value: any) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const output = text(result.stdout || result.output || result.content);
  const error = text(result.stderr || result.error);
  const details = Array.isArray(result.tasks) ? JSON.stringify(result.tasks, null, 2)
    : result.environment ? JSON.stringify(result.environment, null, 2) : '';
  const status = mode !== 'run' ? text(result.message || (result.status ? `Task ${result.taskId || ''}: ${result.status}` : '')) : '';
  const parts = [status, output, error, details].filter(Boolean);
  return [...new Set(parts)].join('\n') || text(result.message || result.result);
}

export function buildTerminalResultTrace(args: any, result: any, ownerTraceId: string, startedAt: number, endedAt = Date.now()): any | undefined {
  const mode = String(args?.mode || 'run');
  if (mode === 'run' && result?._consoleTraceEmitted) return undefined;
  const cancelled = Boolean(result?.cancelled || result?.error === 'CANCELLED_BY_USER');
  const running = mode === 'run' && Boolean(result?.stillRunning || result?.running || result?.status === 'running');
  const unknown = result?.status === 'unknown';
  const code = typeof result?.exitCode === 'number' ? result.exitCode : typeof result?.code === 'number' ? result.code : undefined;
  const failed = Boolean(result?.error || result?.success === false || result?.passed === false || (code !== undefined && code !== 0));
  const exitCode = running || unknown ? undefined : code ?? (cancelled ? 130 : failed ? 1 : result?.success === true ? 0 : undefined);
  return {
    type: 'tool_result_preview', toolName: 'workspace_run_command', toolArgs: args,
    result, command: mode === 'run' ? result?.command || terminalInvocationText(args) : terminalInvocationText(args),
    program: mode === 'run' ? result?.program || args?.program : undefined,
    args: mode === 'run' ? result?.args || args?.args : undefined,
    output: terminalResultText(result, mode), ownerTraceId,
    cwd: result?.cwd || args?.cwd, shell: result?.shell,
    taskId: mode === 'run' ? result?.taskId || result?.backgroundTaskId : undefined,
    startTime: startedAt, ...(running ? {} : { endTime: endedAt }), timestamp: endedAt,
    durationMs: Math.max(0, endedAt - startedAt), exitCode,
    isStreaming: running, isDelta: false, streamState: running ? 'open' : 'closed',
    status: running ? 'running' : cancelled ? 'stopped' : unknown ? 'unknown' : failed ? 'failed' : exitCode === 0 ? 'completed' : 'unknown',
  };
}
