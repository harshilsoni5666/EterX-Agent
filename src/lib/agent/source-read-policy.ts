import { isSourceReadShellCommand } from './shell-command-shape';

/** Read content is exact; only execution/log output has a character allowance. */
export type TerminalOutputKind = 'read' | 'log';
export const MIN_TERMINAL_OUTPUT_CHARS = 4_000;
export const MAX_TERMINAL_OUTPUT_CHARS = 256_000;

export const SOURCE_READING_POLICY = `Locate unknown targets once; batch independent known reads with commands:[{command:readA},{command:readB}]. File/code/content reads are returned without application-level clipping or summarization; maxOutputChars limits logs only (${MIN_TERMINAL_OUTPUT_CHARS}-${MAX_TERMINAL_OUTPUT_CHARS} characters, default 24000). Standard literal reads/searches are recognized automatically; use outputKind="read" for other file readers/extraction scripts, outputKind="log" for noisy execution output. This changes retention, not permissions or parallel safety. Read complete relevant files or cohesive sections, not tiny repeated slices or project dumps: model context is still finite, so scope exceptionally large files before reading. Use shell-appropriate commands, reuse fresh content, and wait for discovery/mutations before dependent reads. Never use omission markers as edit context.`;

export function explicitOutputChars(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(MIN_TERMINAL_OUTPUT_CHARS, Math.min(MAX_TERMINAL_OUTPUT_CHARS, Math.floor(value)));
}

export function resolveTerminalOutputKind(command: string, outputKind?: unknown): TerminalOutputKind {
  if (outputKind === 'read' || outputKind === 'log') return outputKind;
  return isSourceReadShellCommand(command) ? 'read' : 'log';
}
