import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import {
  emitRuntimeTrace,
  resolveWaitDurationMs,
  secondsFromTimeoutMs
} from './terminal_timeout';

function waitForTimer(ms: number, context: any): Promise<boolean> {
  return new Promise(resolve => {
    const signal: AbortSignal | undefined = context?.abortSignal;
    let polling: ReturnType<typeof setInterval> | undefined;
    const finish = (expired: boolean) => {
      clearTimeout(timer);
      if (polling) clearInterval(polling);
      signal?.removeEventListener('abort', cancel);
      resolve(expired);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', cancel, { once: true });
    if (typeof context?.isCancelled === 'function') polling = setInterval(() => { if (context.isCancelled()) cancel(); }, 250);
    if (signal?.aborted || context?.isCancelled?.()) cancel();
  });
}

function timerTitle(title: unknown): string {
  const clean = String(title || '').trim();
  return clean || 'Scheduled check-in';
}

function timerNote(note: unknown): string {
  const clean = String(note || '').trim();
  return clean || 'Check the latest status, read any new output, and continue from the current task state.';
}

export const waitTimerTool: ToolDefinition = {
  name: 'wait_timer',
  description: 'Wait for a bounded interval, then return a check-in note so the agent can continue from the current work. Use after workspace_run_command hands off a long-running task or when a brief internal pause is needed. Maximum wait is 120 seconds.',
  category: 'core',
  inputSchema: z.object({
    seconds: z.number().optional().describe('Seconds to wait. Values are capped to 120 seconds.'),
    timeoutSeconds: z.number().optional().describe('Alias for seconds. Values are capped to 120 seconds.'),
    timeoutMs: z.number().optional().describe('Milliseconds to wait. Values are capped to 120000 ms.'),
    title: z.string().optional().describe('Short UI title for the check-in, e.g. "Schedule compilation check-in"'),
    note: z.string().optional().describe('Exact instruction for what to inspect or do after the timer expires.')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    expired: z.boolean(),
    cancelled: z.boolean().optional(),
    waitedMs: z.number(),
    title: z.string(),
    note: z.string(),
    nextActionNote: z.string()
  }),
  execute: async (input: { seconds?: number; timeoutSeconds?: number; timeoutMs?: number; durationMs?: number; title?: string; note?: string }, context: any) => {
    const waitedMs = resolveWaitDurationMs(input);
    const title = timerTitle(input.title);
    const note = timerNote(input.note);
    const seconds = secondsFromTimeoutMs(waitedMs);

    if (!context?._timerStartTraceEmitted) {
      emitRuntimeTrace(context, {
        type: 'timer',
        text: `Timed ${seconds} seconds`,
        title,
        note,
        durationMs: waitedMs,
        iconCategory: 'terminal'
      });
    }

    const startedAt = Date.now();
    const expired = await waitForTimer(waitedMs, context);
    if (!expired) {
      return { success: false, expired: false, cancelled: true, waitedMs: Date.now() - startedAt, title, note, nextActionNote: 'The wait was cancelled. Follow the latest user instruction; do not resume the cancelled step automatically.' };
    }

    emitRuntimeTrace(context, {
      type: 'timer_expired',
      text: `${title}: Timer has expired`,
      title,
      note,
      durationMs: waitedMs,
      iconCategory: 'terminal'
    });

    return {
      success: true,
      expired: true,
      waitedMs,
      title,
      note,
      nextActionNote: note
    };
  }
};

