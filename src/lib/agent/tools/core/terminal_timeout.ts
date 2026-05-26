export const MIN_TERMINAL_TIMEOUT_MS = 1_000;
export const MAX_TERMINAL_TIMEOUT_MS = 120_000;   // 2 minutes — realistic for builds, installs, tsc
export const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;  // 30s default — enough for most commands

export function normalizeTimeoutMs(value: unknown, defaultMs = DEFAULT_TERMINAL_TIMEOUT_MS): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return defaultMs;
  const ms = raw <= 120 ? raw * 1000 : raw;
  return Math.max(MIN_TERMINAL_TIMEOUT_MS, Math.min(MAX_TERMINAL_TIMEOUT_MS, Math.floor(ms)));
}

export function secondsFromTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.round(timeoutMs / 1000));
}

export function terminalTimeoutNote(command: string, timeoutMs: number): string {
  const seconds = secondsFromTimeoutMs(timeoutMs);
  const shortCommand = command.trim().replace(/\s+/g, ' ').substring(0, 120);
  return [
    `The command was stopped after ${seconds} seconds: ${shortCommand}`,
    'Read the partial output and continue from it.',
    'If this work is intentionally long-running, start it with process_manager/background_task, then use wait_timer for short check-ins instead of rerunning blindly.'
  ].join(' ');
}

export function isExecTimeoutError(error: any): boolean {
  const message = String(error?.message || '').toLowerCase();
  return Boolean(
    error?.killed ||
    error?.signal === 'SIGTERM' ||
    error?.signal === 'SIGKILL' ||
    error?.code === 'ETIMEDOUT' ||
    message.includes('timed out') ||
    message.includes('timeout')
  );
}

export function emitRuntimeTrace(context: any, traceEvent: any): void {
  const event = { timestamp: Date.now(), ...traceEvent };
  if (typeof context?._onTrace === 'function') {
    context._onTrace(event);
    return;
  }

  if (context?.chatId) {
    try {
      const { taskStore } = require('../../task-store');
      taskStore.addTrace(context.chatId, event);
    } catch {
      // Trace persistence is best-effort; tool execution should continue.
    }
  }
}

