/**
 * Preserve the model's user-facing communication as written. Work-note
 * selection belongs to the response/action boundary, not an output rewriter.
 */
export function isFinalAnswerOrRegularText(_value: string): boolean {
  return false;
}

export function formatVisibleWorkNote(value: string, _maxLength = 720, _suppressFinalAnswers = false): string {
  return String(value || '').trim();
}
