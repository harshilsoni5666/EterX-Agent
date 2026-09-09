const CONTINUATION_VERBS = new Set([
  'continue', 'cont', 'cotn', 'cotne', 'cotnue', 'conue', 'contue', 'corinue',
  'cotinue', 'cotneu', 'contine', 'resume', 'proceed',
]);

const POLITE_PREFIXES = new Set([
  'hey', 'hi', 'hello', 'okay', 'ok', 'yes', 'please', 'pls', 'plz', 'pelase',
  'pelse', 'plese', 'now', 'nwo', 'just', 'jsut', 'also',
]);

const FILLER_WORDS = new Set([
  ...POLITE_PREFIXES,
  'work', 'working', 'workign', 'wokr', 'deep', 'deeply', 'deeper', 'depe',
  'further', 'again', 'ahead', 'on', 'it', 'this', 'same', 'task',
]);

/**
 * A control turn resumes the last substantive objective; it is not a new one.
 * Only a tiny vocabulary is accepted. File names, numbers, or other task words
 * ("continue fixing auth.ts") remain substantive, including mixed-language
 * directives. Punctuation normalization must not discard that new content.
 */
export const isContinuationControlMessage = (text: string): boolean => {
  const words = String(text || '').toLowerCase()
    .replace(/[.!?,;:…'’"]/g, ' ')
    .split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 12) return false;
  let start = 0;
  while (start < words.length && POLITE_PREFIXES.has(words[start])) start += 1;
  const suffixIsFiller = (from: number) => words.slice(from).every(word =>
    FILLER_WORDS.has(word) || CONTINUATION_VERBS.has(word)
  );
  if (CONTINUATION_VERBS.has(words[start]) && suffixIsFiller(start + 1)) return true;
  const phrase = words.slice(start, start + 2).join(' ');
  return ['go on', 'go ahead', 'keep going', 'keep working', 'carry on'].includes(phrase)
    && suffixIsFiller(start + 2);
};
