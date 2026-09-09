/**
 * Preserve the model's user-facing communication as written. Work-note
 * selection belongs to the response/action boundary, not an output rewriter.
 */
export const WORK_NOTE_POLICY = `Start tool-assisted work with one short, task-specific note. Then do the related work without narrating each call: several reads or commands can belong to one step. Add a note when a finding changes the approach, the next meaningful phase begins, recovery matters, or a long stretch needs a useful progress update. Use plain professional sentences without bold, headings, lists, emojis, decorative icons, or celebratory badges; state what matters, not tool labels or plan bookkeeping. Never repeat intent, expose private reasoning, or claim results before evidence. Answer simple questions directly.`;

export function isFinalAnswerOrRegularText(_value: string): boolean {
  return false;
}

export function formatVisibleWorkNote(value: string, _maxLength = 720, _suppressFinalAnswers = false): string {
  // Keep user-facing wording and Markdown intact. Brevity and professional
  // style are generation guidance, not reasons to suppress or clip a note.
  return String(value || '')
    // Some compatible providers place private reasoning tags in their normal
    // text channel. Never promote those blocks into visible progress notes.
    .replace(/<(analysis|thinking|reasoning|thought|scratchpad)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:analysis|thinking|reasoning|thought|scratchpad)\b[^>]*>/gi, '')
    .trim();
}
