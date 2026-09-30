export const HARNESS_CONTEXT_HEADER = '[ADAPTIVE COGNITIVE FABRIC]';
export const HARNESS_CONTEXT_FOOTER = '[END ADAPTIVE COGNITIVE FABRIC]';
const OMISSION_NOTICE = 'Some runtime records were omitted for space; omitted work is not completed. The user conversation remains authoritative.';

export function isHarnessContext(text: string): boolean {
  return text.trimStart().startsWith(HARNESS_CONTEXT_HEADER);
}

/**
 * Records arrive in priority order. Keep complete records, provenance, and the
 * closing boundary; a secondary context reducer must not rewrite their meaning.
 */
export function boundHarnessContext(text: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 3200;
  if (text.length <= limit) return text;
  const lines = text.split('\n').filter(line => line !== HARNESS_CONTEXT_HEADER
    && line !== HARNESS_CONTEXT_FOOTER && line !== OMISSION_NOTICE && line.trim());
  const selected = [HARNESS_CONTEXT_HEADER];
  let used = HARNESS_CONTEXT_HEADER.length + HARNESS_CONTEXT_FOOTER.length + OMISSION_NOTICE.length + 2;
  if (used > limit) return '';
  for (const line of lines) {
    if (used + line.length + 1 > limit) continue;
    selected.push(line);
    used += line.length + 1;
  }
  return [...selected, OMISSION_NOTICE, HARNESS_CONTEXT_FOOTER].join('\n');
}
