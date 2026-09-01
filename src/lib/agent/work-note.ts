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

  // A single provider response is one work-note lifecycle. Preserve its
  // words without semantic guessing. Ordinary progress can legitimately
  // begin with "I need", "the user asked", or an inspection heading; hiding
  // those phrases made the opening note vanish while its action remained.
  // Explicit private-reasoning tags were removed above. Collapse paragraph/
  // list whitespace so one response cannot masquerade as unrelated notes.
  const continuous = cleaned.replace(/\s+/g, ' ').trim();
  const safeLimit = Math.max(120, Math.floor(maxLength));
  if (continuous.length <= safeLimit) return continuous;
  const clipped = continuous.slice(0, safeLimit - 1).replace(/\s+\S*$/, '').trim();
  return `${clipped || continuous.slice(0, safeLimit - 1).trim()}…`;
}
