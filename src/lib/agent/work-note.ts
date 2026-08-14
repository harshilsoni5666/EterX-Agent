/**
 * Preserve the model's user-facing communication as written. Work-note
 * selection belongs to the response/action boundary, not an output rewriter.
 */
export function isFinalAnswerOrRegularText(_value: string): boolean {
  return false;
}

export function formatVisibleWorkNote(value: string, _maxLength = 720, _suppressFinalAnswers = false): string {
  const cleaned = String(value || '')
    // Some compatible providers place private reasoning tags in their normal
    // text channel. Never promote those blocks into visible progress notes.
    .replace(/<(analysis|thinking|reasoning|thought|scratchpad)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:analysis|thinking|reasoning|thought|scratchpad)\b[^>]*>/gi, '')
    .trim();

  if (!cleaned) return '';

  const internalHeading = /^(?:#{1,6}\s*)?(?:internal\s+)?(?:analysis|reasoning|thinking|scratchpad)\s*:/i;
  const mediaAnalysisHeading = /^(?:#{1,6}\s*)?(?:image|attachment|screenshot|photo)\s*#?\s*\d*\s*(?:analysis|reasoning|inspection)\s*:/i;
  const responseDrafting = /^(?:i|we)\s+(?:need|must|should|have)\s+(?:to\s+)?(?:answer|respond|draft|output|analy[sz]e)\b/i;
  const userMeta = /^the user\s+(?:asks?|asked|wants?|wanted|requests?|requested|needs?)\b/i;

  if (
    internalHeading.test(cleaned)
    || mediaAnalysisHeading.test(cleaned)
    || responseDrafting.test(cleaned)
    || userMeta.test(cleaned)
  ) return '';

  return cleaned;
}
