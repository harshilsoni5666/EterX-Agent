/**
 * Preserve the model's user-facing communication as written. Work-note
 * selection belongs to the response/action boundary, not an output rewriter.
 */
export function isFinalAnswerOrRegularText(_value: string): boolean {
  return false;
}

export function formatVisibleWorkNote(value: string, maxLength = 720, _suppressFinalAnswers = false): string {
  const cleaned = String(value || '')
    // Some compatible providers place private reasoning tags in their normal
    // text channel. Never promote those blocks into visible progress notes.
    .replace(/<(analysis|thinking|reasoning|thought|scratchpad)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:analysis|thinking|reasoning|thought|scratchpad)\b[^>]*>/gi, '')
    .trim();

  if (!cleaned) return '';

  // Providers sometimes leak private planning headings into their normal text
  // channel. Do not promote those planning/meta lines into user-facing work
  // notes; genuine progress phrased as an inspection or check remains valid.
  const internalHeading = /^(?:#{1,6}\s*)?(?:internal\s+)?(?:analysis|reasoning|thinking|scratchpad)\s*:/i;
  const mediaAnalysisHeading = /^(?:#{1,6}\s*)?(?:image|attachment|screenshot|photo)\s*#?\s*\d*\s*(?:analysis|reasoning|inspection)\s*:/i;
  const responseDrafting = /^(?:i|we)\s+(?:need|must|should|have)\s+(?:to\s+)?(?:answer|respond|draft|output|analy[sz]e)\b/i;
  const userMeta = /^the\s+user\s+(?:asks?|asked|wants?|wanted|requests?|requested|needs?)\b/i;

  if (
    internalHeading.test(cleaned)
    || mediaAnalysisHeading.test(cleaned)
    || responseDrafting.test(cleaned)
    || userMeta.test(cleaned)
  ) return '';

  // A single provider response is one work-note lifecycle. Collapse
  // paragraph/list whitespace so one response cannot masquerade as unrelated
  // notes while preserving its actual user-facing words.
  const continuous = cleaned.replace(/\s+/g, ' ').trim();
  const safeLimit = Math.max(120, Math.floor(maxLength));
  if (continuous.length <= safeLimit) return continuous;
  const clipped = continuous.slice(0, safeLimit - 1).replace(/\s+\S*$/, '').trim();
  return `${clipped || continuous.slice(0, safeLimit - 1).trim()}…`;
}
