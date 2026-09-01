/**
 * Fast local token estimate used only to decide when an authoritative context
 * boundary check is needed. It never mutates, summarizes, or truncates context.
 * Provider-reported input usage supersedes this estimate whenever available.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
