import { z } from 'zod';
import type { AskUserInbox } from '../../ask-user-inbox';
import type { ToolDefinition } from '../../schemas';
import {
  ASK_USER_MODES, getAskUserFields, type AskUserAnswer, type AskUserInput, type AskUserOption, type AskUserStatus,
} from '../../../ask-user';

interface PendingAskUser extends AskUserInput {
  chatId: string;
  sessionId: string;
  createdAt: number;
  status: AskUserStatus;
  answer: string | null;
  selectedOption: AskUserOption | AskUserOption[] | null;
  answers: AskUserAnswer[] | null;
  answeredAt?: number;
  notify?: () => void;
}

export function getPendingAskUser() {
  const runtime = globalThis as typeof globalThis & { __pendingAskUser?: Record<string, PendingAskUser> };
  return runtime.__pendingAskUser ??= Object.create(null) as Record<string, PendingAskUser>;
}

const questionFields = {
  options: z.array(z.object({
    label: z.string().trim().min(1).describe('Label displayed to the user.'),
    value: z.string().trim().min(1).describe('Value returned when the option is selected.'),
    description: z.string().optional(),
  })).optional(),
  context: z.string().optional().describe('Brief context displayed with this question.'),
  defaultValue: z.string().optional().describe('A suggestion shown to the user.'),
  placeholder: z.string().optional().describe('Placeholder for a text or fill_blank answer.'),
  required: z.boolean().optional().describe('Set false to let the user skip this question. Defaults to true.'),
};

const askUserInputSchema = z.object({
  ...questionFields,
  question: z.string().trim().min(1).optional().describe('Question text for a single question, or an optional heading for a group.'),
  mode: z.enum([...ASK_USER_MODES, 'questions']).optional().describe('Use questions for a group of mixed question formats.'),
  questions: z.array(z.object({
    ...questionFields,
    id: z.string().optional(),
    question: z.string().trim().min(1),
    mode: z.enum(ASK_USER_MODES).optional(),
  })).min(1).optional().describe('The questions in display order. Each item can have its own mode and options.'),
  urgent: z.boolean().optional().describe('Mark this question as necessary for the current work.'),
  behavior: z.enum(['wait', 'continue']).optional().describe('wait pauses for a reply. continue lets independent work proceed and delivers the reply as an internal update.'),
}).superRefine((input, issues) => {
  const fields = getAskUserFields(input);
  if (!fields.length || (input.mode === 'questions' && !input.questions?.length)) {
    issues.addIssue({ code: 'custom', path: [input.mode === 'questions' ? 'questions' : 'question'], message: 'Provide at least one question.' });
  }
  fields.forEach((field, index) => {
    if ((field.mode === 'choice' || field.mode === 'multi_select' || field.mode === 'rank') && !field.options.length) {
      issues.addIssue({ code: 'custom', path: input.questions?.length ? ['questions', index, 'options'] : ['options'],
        message: 'Provide labeled options for this question.' });
    }
  });
});

const QUESTION_RESULT_MESSAGES = {
  dismissed: 'The user dismissed the question. Continue with independent authorized work and leave the dependent action unresolved.',
  interrupted: 'The user sent live steering. Read that guidance and continue with the active task. The question is unanswered.',
  expired: 'The question expired without a reply. Continue with independent authorized work and leave the dependent action unresolved.',
};

export async function requestAskUser(input: AskUserInput, ctx?: any, timeoutMs?: number) {
  const trace = ctx?._onTrace as ((event: Record<string, unknown>) => void) | undefined;
  const fields = getAskUserFields(input);
  if (!trace || !fields.length) return { success: false, answer: '', error: 'There is no question to deliver to the user.' };

  const inbox = input.behavior === 'continue' ? ctx?.askUserInbox as AskUserInbox | undefined : undefined;
  const continuation = inbox ? new AbortController() : undefined;
  const signals = new Set<AbortSignal>((continuation
    ? [continuation.signal, ctx?.runAbortSignal]
    : [ctx?.abortSignal, ctx?.signal, ctx?.runAbortSignal]).filter(Boolean));
  const isCancelled = () => Array.from(signals).some(signal => signal.aborted) ||
    (typeof ctx?.isCancelled === 'function' && ctx.isCancelled());
  if (isCancelled()) throw new Error('CANCELLED_BY_USER');

  const timestamp = Date.now();
  const responseKey = 'ask_user_' + timestamp + '_' + Math.random().toString(36).slice(2, 10);
  const grouped = Boolean(input.questions?.length);
  const { question, context, defaultValue, placeholder, required, options, mode } = fields[0];
  const event = {
    type: 'ask_user',
    question: grouped ? input.question?.trim() : question,
    mode: grouped ? 'questions' : mode,
    questions: grouped ? fields : [],
    options: grouped ? [] : options,
    context: grouped ? input.context?.trim() : context,
    defaultValue: grouped ? undefined : defaultValue,
    placeholder: grouped ? undefined : placeholder,
    required: grouped ? undefined : required,
    urgent: input.urgent === true,
    behavior: continuation ? 'continue' as const : 'wait' as const,
    responseKey,
    chatId: String(ctx?.ownerChatId || ctx?.chatId || ctx?.projectId || ''),
    timestamp,
    startTime: timestamp,
  };
  const store = getPendingAskUser();
  const receipts = Object.entries(store).filter(([, record]) => record.answeredAt)
    .sort((a, b) => a[1].answeredAt! - b[1].answeredAt!);
  receipts.forEach(([key, record], index) => {
    if (timestamp - record.answeredAt! > 15 * 60_000 || index < receipts.length - 200) delete store[key];
  });
  const record: PendingAskUser = {
    ...event,
    sessionId: String(ctx?.agentSessionId || ''),
    status: 'pending',
    answer: null,
    selectedOption: null,
    answers: null,
    createdAt: timestamp,
  };
  store[responseKey] = record;

  const resolution = new Promise<Exclude<AskUserStatus, 'pending'>>((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cancellationPoll: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      clearTimeout(deadline);
      clearInterval(cancellationPoll);
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
      delete record.notify;
    };
    const finish = (status: Exclude<AskUserStatus, 'pending'>) => {
      cleanup();
      resolve(status);
    };
    const onAbort = () => finish('closed');
    record.notify = () => {
      if (isCancelled()) onAbort();
      else if (record.status !== 'pending') finish(record.status);
    };
    for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) deadline = setTimeout(() => finish('expired'), timeoutMs);
    if (!signals.size && typeof ctx?.isCancelled === 'function') cancellationPoll = setInterval(record.notify, 500);
    try {
      trace({ ...event, questionStatus: 'pending' });
    } catch (error) {
      cleanup();
      delete store[responseKey];
      reject(error);
    }
  }).then(status => {
    if (status !== 'answered' && status !== 'dismissed') delete store[responseKey];
    // The feed receives a receipt. The reply is delivered directly to the model.
    const publish = continuation ? ctx?._onQuestionResolved || trace : trace;
    try {
      publish({ ...event, questionStatus: status, resolvedAt: Date.now() });
    } catch {
      // A disconnected trace consumer does not revoke an accepted reply.
    }
    if (status === 'closed') throw new Error('CANCELLED_BY_USER');
    if (status !== 'answered') return {
      success: false,
      answer: '',
      dismissed: status === 'dismissed',
      interrupted: status === 'interrupted',
      timedOut: status === 'expired',
      error: QUESTION_RESULT_MESSAGES[status],
    };
    return {
      success: true,
      answer: record.answer ?? '',
      selectedOption: record.selectedOption,
      answers: record.answers ?? undefined,
      respondedInMs: Date.now() - timestamp,
    };
  });

  if (inbox && continuation) {
    inbox.track(resolution.then(reply => JSON.stringify({ responseKey, question: event.question, ...reply })), () => continuation.abort());
    return { success: true, answer: '', pending: true, responseKey,
      message: 'Continue any independent work. Do not guess the answer or start work that depends on it. The reply will arrive as an internal update.' };
  }
  return resolution;
}

const modelDescription = 'Ask for missing user input or explicit authorization. Choose behavior=wait (default) to pause when the answer gates the next action, or behavior=continue to keep doing independent work while the reply is pending. A pending reply arrives as an internal update automatically. When no independent work remains, yield so the runtime can wait for the reply. Use choice to pick one option, multi_select to pick several, rank to order options, confirm for yes/no, text for a free-form answer, short_answer for a line, and fill_blank for a missing word or value. Supply options:[{label,value}] for choice, multi_select and rank. For mixed formats supply mode=questions and questions:[{id?,question,mode,options?,required?,context?,placeholder?}]. Set required=false for questions that can be skipped. A dismissal, expiry or suggestion is never an answer or permission.';

export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  category: 'core',
  modelDescription,
  description: modelDescription,
  inputSchema: askUserInputSchema,
  outputSchema: z.object({
    success: z.boolean(),
    answer: z.string(),
    pending: z.boolean().optional(),
    responseKey: z.string().optional(),
    message: z.string().optional(),
    selectedOption: z.any().optional(),
    answers: z.array(z.any()).optional(),
    timedOut: z.boolean().optional(),
    interrupted: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    respondedInMs: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: (input: AskUserInput, ctx?: any) => requestAskUser(input, ctx, ctx?.telegramBot?.id ? 5 * 60_000 : undefined),
};
