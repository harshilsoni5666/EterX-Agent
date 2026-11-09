/** Reuse the owner-scoped terminal API so Live can continue a handed-off process. */
export async function manageLiveTerminalTask(
  chatId: string,
  args: Record<string, any>,
  signal: AbortSignal,
): Promise<Record<string, any>> {
  const action = String(args.action || 'status');
  if (!['list', 'status', 'stop'].includes(action)) throw new Error('Use list, status or stop for a terminal task.');
  const taskId = String(args.task_id || args.taskId || '').trim();
  if (action !== 'list' && !taskId) throw new Error('Use the exact taskId returned by the command or terminal task list.');
  const query = new URLSearchParams({ chatId, maxOutputChars: '6000' });
  if (action !== 'list') query.set('taskId', taskId);
  if (args.since_offset !== undefined) {
    const offset = Number(args.since_offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('since_offset must be a nonnegative output cursor.');
    query.set('sinceOffset', String(offset));
  }
  const response = action === 'stop'
    ? await fetch('/api/agent/terminal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ chatId, taskId }),
    })
    : await fetch(`/api/agent/terminal?${query}`, { signal, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || `Terminal task request failed (${response.status}).`);
  if (Array.isArray(payload.tasks)) {
    return {
      tasks: payload.tasks.slice(0, 30).map((task: any) => ({
        taskId: task.taskId || task.id, status: task.status, description: String(task.description || task.command || '').slice(0, 250),
        exitCode: task.exitCode, startedAt: task.startedAt, completedAt: task.completedAt,
      })),
      totalTasks: payload.tasks.length,
    };
  }
  const task = payload.task;
  if (!task || typeof task !== 'object') throw new Error('The terminal task response was unavailable.');
  // Query success is separate from process success. Preserve failed/unknown
  // outcomes as inspectable evidence, with the cursor needed for continuation.
  return {
    taskId: task.taskId || taskId, status: task.status,
    running: task.running === true || task.status === 'running',
    exitCode: task.exitCode ?? null,
    output: String(task.output || task.stdout || '').slice(-6500),
    stderr: String(task.stderr || '').slice(-2000),
    outputStart: task.outputStart, outputEnd: task.outputEnd,
    hasNewOutput: task.hasNewOutput, totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    message: String(task.message || '').slice(0, 500),
    nextActionNote: task.running === true || task.status === 'running'
      ? `The process is still running. Reuse manage_terminal_task status with task_id="${task.taskId || taskId}" and since_offset=${task.outputEnd || 0} after allowing time for progress. Do not relaunch it.`
      : task.status === 'unknown'
        ? 'The original execution handle is unavailable. Read retained output and current target state before deciding what remains; do not infer success or replay a mutation.'
        : 'Read the final output and compare it with the requested result before reporting completion.',
  };
}
