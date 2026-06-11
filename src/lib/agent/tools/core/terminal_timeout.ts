export const MIN_TERMINAL_TIMEOUT_MS = 1_000;
export const MIN_TERMINAL_CHECKIN_MS = 5_000;
export const DEFAULT_TERMINAL_CHECKIN_MS = 15_000;
export const MAX_TERMINAL_CHECKIN_MS = 120_000;
export const DEFAULT_TERMINAL_HARD_TIMEOUT_MS = 30 * 60_000;
export const MAX_TERMINAL_HARD_TIMEOUT_MS = 60 * 60_000;
export const MAX_TERMINAL_TIMEOUT_MS = 120_000;   // 2 minutes — realistic for builds, installs, tsc
export const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;  // 30s default — enough for most commands

export function normalizeTimeoutMs(value: unknown, defaultMs = DEFAULT_TERMINAL_TIMEOUT_MS): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return defaultMs;
  const ms = raw <= 120 ? raw * 1000 : raw;
  return Math.max(MIN_TERMINAL_TIMEOUT_MS, Math.min(MAX_TERMINAL_TIMEOUT_MS, Math.floor(ms)));
}

export function inferTerminalCheckInMs(command: string): number {
  const normalized = command.trim().toLowerCase();

  if (/\b(dev|serve|watch|--watch|start)\b/.test(normalized)) return 10_000;
  if (/\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|lint|install|ci)\b/.test(normalized)) return 15_000;
  if (/\b(?:next\s+build|vite\s+build|tsc|pytest|cargo\s+(?:build|test)|go\s+test|mvn\s+test|gradle\s+build)\b/.test(normalized)) return 15_000;

  return DEFAULT_TERMINAL_CHECKIN_MS;
}

export function normalizeCheckInMs(value: unknown, command = ''): number {
  const defaultMs = inferTerminalCheckInMs(command);
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return defaultMs;
  const ms = raw <= 120 ? raw * 1000 : raw;
  return Math.max(MIN_TERMINAL_CHECKIN_MS, Math.min(MAX_TERMINAL_CHECKIN_MS, Math.floor(ms)));
}

export function normalizeHardTimeoutMs(value: unknown, checkInMs = DEFAULT_TERMINAL_CHECKIN_MS): number {
  const raw = Number(value);
  const defaultMs = Math.max(DEFAULT_TERMINAL_HARD_TIMEOUT_MS, checkInMs + 1_000);
  if (!Number.isFinite(raw) || raw <= 0) return defaultMs;
  const ms = raw <= 3600 ? raw * 1000 : raw;
  return Math.max(checkInMs + 1_000, Math.min(MAX_TERMINAL_HARD_TIMEOUT_MS, Math.floor(ms)));
}

export function secondsFromTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.round(timeoutMs / 1000));
}

export function terminalTimeoutNote(command: string, timeoutMs: number): string {
  const seconds = secondsFromTimeoutMs(timeoutMs);
  const shortCommand = command.trim().replace(/\s+/g, ' ').substring(0, 120);
  const lower = command.toLowerCase();

  // Specific recovery instructions based on command type
  let recoveryInstruction: string;

  if (/\b(npm\s+(install|ci|i)\b|yarn\s*(install)?\b|pnpm\s+(install|i)\b|pip\s+install|cargo\s+(build|install)|npm\s+create|npx\s)/i.test(lower)) {
    recoveryInstruction = [
      'This is a package install/scaffold command that needs more time.',
      'DO NOT retry this command with system_shell or workspace_run_command.',
      'Instead: use background_task mode="launch" with the same command and cwd,',
      'then wait_timer seconds=60, then background_task mode="check" with the returned taskId.',
      'NEVER retry the exact same timed-out command — it will time out again.'
    ].join(' ');
  } else if (/\b(npm\s+run\s+(dev|start|serve)|yarn\s+(dev|start)|pnpm\s+(dev|start)|next\s+dev|vite\s*$|python\s+-m\s+(http|flask|uvicorn)|node\s+.*server)/i.test(lower)) {
    recoveryInstruction = [
      'This looks like a dev server or watcher — it runs forever and WILL always time out.',
      'Use process_manager action="start" with this command instead.',
      'Then use process_manager action="logs" to check its output.',
      'NEVER run dev servers with system_shell or workspace_run_command.'
    ].join(' ');
  } else if (/\b(npm\s+run\s+build|yarn\s+build|next\s+build|vite\s+build|tsc\b|cargo\s+build|mvn|gradle)/i.test(lower)) {
    recoveryInstruction = [
      'This is a build command that needs more time.',
      'Use background_task mode="launch" with the same command,',
      'then wait_timer seconds=60, then background_task mode="check" with the returned taskId.'
    ].join(' ');
  } else {
    recoveryInstruction = [
      'Read the partial output and continue from it.',
      'If this work is intentionally long-running, start it with process_manager/background_task,',
      'then use wait_timer for short check-ins instead of rerunning blindly.',
      'NEVER retry the exact same command without changing the approach.'
    ].join(' ');
  }

  return `The command was stopped after ${seconds} seconds: ${shortCommand}. ${recoveryInstruction}`;
}

export function terminalBackgroundHandoffNote(command: string, taskId: string, checkInMs: number): string {
  const seconds = secondsFromTimeoutMs(checkInMs);
  const shortCommand = command.trim().replace(/\s+/g, ' ').substring(0, 120);
  return [
    `The command is still running in the background after ${seconds} seconds: ${shortCommand}`,
    `Task ID: ${taskId}.`,
    `Do not rerun the command. Use wait_timer for about ${seconds} seconds, then background_task mode="check" with this taskId.`
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

