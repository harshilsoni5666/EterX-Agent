import { isSourceReadShellCommand } from './shell-command-shape';

/** Read pages remain verbatim; retained output and model delivery have separate budgets. */
export type TerminalOutputKind = 'read' | 'log';
export const MIN_TERMINAL_OUTPUT_CHARS = 4_000;
export const MAX_TERMINAL_OUTPUT_CHARS = 256_000;
export const DEFAULT_TERMINAL_OUTPUT_CHARS = 24_000;

export const SOURCE_READING_POLICY = `Locate unknown targets once; batch independent known reads with commands:[{command:readA},{command:readB}]. File/code/content output is retained exactly and delivered in bounded verbatim pages. maxOutputChars limits each response (${MIN_TERMINAL_OUTPUT_CHARS}-${MAX_TERMINAL_OUTPUT_CHARS} characters, default 24000), including reads/searches; the active context budget can lower it. When hasMoreOutput is true, use workspace_run_command mode="check" with taskId and sinceOffset=outputEnd for the next page, or narrow the search. Do not replay the command just to retrieve omitted output. Standard literal reads/searches are recognized automatically; use outputKind="read" for other file readers/extraction scripts, outputKind="log" for noisy execution output. This changes retention, not permissions or parallel safety. Read complete relevant files or cohesive sections, not tiny repeated slices or project dumps. Use shell-appropriate commands, reuse fresh content, and wait for discovery/mutations before dependent reads. Never use omission markers as edit context or claim unread pages were inspected.`;

/** A single result must leave room for the prompt, other tools, and the answer. */
export function terminalOutputPageChars(value?: unknown, contextWindow?: unknown): number {
  const requested = explicitOutputChars(value) ?? DEFAULT_TERMINAL_OUTPUT_CHARS;
  const window = Number(contextWindow);
  const budget = Number.isFinite(window) && window >= 16_000
    ? Math.max(MIN_TERMINAL_OUTPUT_CHARS, Math.floor(window * 4 * 0.08))
    : MAX_TERMINAL_OUTPUT_CHARS;
  return Math.min(requested, budget);
}

export function explicitOutputChars(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(MIN_TERMINAL_OUTPUT_CHARS, Math.min(MAX_TERMINAL_OUTPUT_CHARS, Math.floor(value)));
}

export function resolveTerminalOutputKind(command: string, outputKind?: unknown): TerminalOutputKind {
  if (outputKind === 'read' || outputKind === 'log') return outputKind;
  return isSourceReadShellCommand(command) ? 'read' : 'log';
}
