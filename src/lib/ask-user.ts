export const ASK_USER_MODES = ['choice', 'multi_select', 'text', 'short_answer', 'fill_blank', 'rank', 'confirm'] as const;

export type AskUserMode = typeof ASK_USER_MODES[number];
export type AskUserStatus = 'pending' | 'answered' | 'dismissed' | 'interrupted' | 'expired' | 'closed';

export interface AskUserOption {
  label: string;
  value: string;
  description?: string;
}

export interface AskUserField {
  id: string;
  question: string;
  mode: AskUserMode;
  options: AskUserOption[];
  context?: string;
  defaultValue?: string;
  placeholder?: string;
  required: boolean;
}

type AskUserFieldInput = Omit<Partial<AskUserField>, 'mode' | 'options'> & {
  mode?: string;
  options?: Array<string | Partial<AskUserOption>>;
};

export type AskUserInput = AskUserFieldInput & {
  questions?: AskUserFieldInput[];
  urgent?: boolean;
  behavior?: 'wait' | 'continue';
};

export interface AskUserAnswer {
  id: string;
  question: string;
  mode: AskUserMode;
  answer: string;
  selectedOption: AskUserOption | AskUserOption[] | null;
}

const trimmed = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function normalizeAskUserMode(mode: unknown) {
  if (typeof mode !== 'string') return undefined;
  const key = mode.trim().toLowerCase().replace(/[ -]+/g, '_');
  switch (key) {
    case 'multiple_choice': case 'single_choice': case 'single_select': return 'choice';
    case 'multiple_select': case 'checkbox': return 'multi_select';
    case 'fill_in_blank': case 'fill_in_the_blank': return 'fill_blank';
    case 'ranking': return 'rank';
    case 'free_text': return 'text';
    default: return key;
  }
}

export function getAskUserFields(input: AskUserInput): AskUserField[] {
  const grouped = Array.isArray(input.questions) && input.questions.length > 0;
  const fields = grouped ? input.questions! : [input];
  const ids = new Set<string>();
  return fields.flatMap((field, index) => {
    const question = trimmed(field?.question);
    if (!question) return [];
    const baseId = trimmed(field.id) || (grouped ? `q_${index + 1}` : 'q1');
    let id = baseId;
    for (let suffix = 2; ids.has(id); suffix++) id = `${baseId}_${suffix}`;
    ids.add(id);
    const values = new Set<string>();
    const options = (Array.isArray(field.options) ? field.options : []).flatMap(option => {
      const item = typeof option === 'string' ? { label: option, value: option } : option;
      const label = trimmed(item?.label) || trimmed(item?.value);
      const value = trimmed(item?.value) || label;
      if (!label || !value || values.has(value)) return [];
      values.add(value);
      const description = trimmed(item?.description);
      return [{ label, value, ...(description && { description }) }];
    });
    const requested = normalizeAskUserMode(field.mode);
    const mode = ASK_USER_MODES.find(candidate => candidate === requested) ?? (options.length ? 'choice' : 'text');
    return [{ id, question, mode, options, context: trimmed(field.context), defaultValue: trimmed(field.defaultValue),
      placeholder: trimmed(field.placeholder), required: field.required !== false }];
  });
}

export function formatAskUserAnswers(answers: AskUserAnswer[]): string {
  if (answers.length === 1) return answers[0].answer;
  return answers.map(({ question, answer }, index) => `${index + 1}. ${question}\n${answer || 'Skipped'}`).join('\n\n');
}

export function isAskUserPrompt(log: any): boolean {
  return log?.type === 'ask_user' && Boolean(log.responseKey || Number(log.timestamp)) &&
    (typeof log.question === 'string' && Boolean(log.question.trim()) || Array.isArray(log.questions) &&
      log.questions.some((field: any) => typeof field?.question === 'string' && field.question.trim()));
}

export function getAskUserResponseKey(log: any): string {
  return String(log?.responseKey || (log?.timestamp ? 'ask_user_' + log.timestamp : ''));
}

export function getAskUserStatus(log: any): AskUserStatus {
  if (log?.answeredAt || log?.answeredWith) return 'answered';
  return log?.questionStatus || (log?.interrupted === true ? 'interrupted' : 'pending');
}

export function isPendingAskUser(log: any): boolean {
  return isAskUserPrompt(log) && getAskUserStatus(log) === 'pending';
}
