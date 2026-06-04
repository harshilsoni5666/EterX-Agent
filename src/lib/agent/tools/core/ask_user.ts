import { z } from 'zod';
import { ToolDefinition } from '../../schemas';

const ASK_USER_MAX_WAIT_MS = 10 * 60 * 1000;
const ASK_USER_POLL_INTERVAL_MS = 400;

const askUserModeSchema = z.enum(['choice', 'multi_select', 'text', 'short_answer', 'confirm']);
const askUserOptionSchema = z.object({
  label: z.string().describe('Short user-facing label.'),
  description: z.string().optional().describe('Optional short explanation.'),
  value: z.string().describe('Machine-readable value for this option.'),
});
const askUserQuestionSchema = z.object({
  id: z.string().optional().describe('Stable identifier for this answer, such as "project_name".'),
  question: z.string().describe('The exact question to show the user.'),
  mode: askUserModeSchema
    .optional()
    .default('short_answer')
    .describe('Interaction mode for this question.'),
  options: z.array(askUserOptionSchema).optional().describe('Required for choice and multi_select modes.'),
  context: z.string().optional().describe('Brief reason this specific answer is needed.'),
  defaultValue: z.string().optional().describe('Safe fallback or prefilled value for this question.'),
  placeholder: z.string().optional().describe('Placeholder for text inputs.'),
  required: z.boolean().optional().default(true).describe('Whether the user must answer this question before submitting.'),
});

const normalizeMode = (mode: any, options: any[]) => {
  const requested = String(mode || 'short_answer');
  if ((requested === 'choice' || requested === 'multi_select') && options.length < 2) {
    return 'short_answer';
  }
  if (['choice', 'multi_select', 'text', 'short_answer', 'confirm'].includes(requested)) {
    return requested;
  }
  return 'short_answer';
};

const normalizeOptions = (rawOptions: any[]) => {
  if (!Array.isArray(rawOptions)) return [];

  return rawOptions
    .map((option, index) => {
      if (typeof option === 'string') {
        const label = option.trim();
        return label ? { label, value: label } : null;
      }

      const label = String(option?.label || option?.value || '').trim();
      if (!label) return null;

      const value = String(option?.value || label).trim();
      const description = String(option?.description || '').trim();

      return {
        label,
        value: value || `option_${index + 1}`,
        ...(description ? { description } : {}),
      };
    })
    .filter(Boolean);
};

const normalizeQuestion = (rawQuestion: any, index: number, fallback: any = {}) => {
  const options = normalizeOptions(rawQuestion?.options ?? fallback.options ?? []);
  const mode = normalizeMode(rawQuestion?.mode ?? fallback.mode, options);
  const question = String(rawQuestion?.question ?? fallback.question ?? '').trim();
  const id = String(rawQuestion?.id || `q${index + 1}`).trim();
  const context = String(rawQuestion?.context ?? '').trim();
  const defaultValue = String(rawQuestion?.defaultValue ?? '').trim();
  const placeholder = String(rawQuestion?.placeholder ?? '').trim();

  return {
    id: id || `q${index + 1}`,
    question,
    mode,
    options,
    ...(context ? { context } : {}),
    ...(defaultValue ? { defaultValue } : {}),
    ...(placeholder ? { placeholder } : {}),
    required: rawQuestion?.required === false ? false : true,
  };
};

const normalizeQuestions = (input: any) => {
  const rawQuestions = Array.isArray(input?.questions) ? input.questions : [];
  const normalized = rawQuestions
    .slice(0, 8)
    .map((question: any, index: number) => normalizeQuestion(question, index))
    .filter((question: ReturnType<typeof normalizeQuestion>) => question.question);

  if (normalized.length > 0) return normalized;

  return [
    normalizeQuestion(input, 0, {
      question: 'Please provide the needed detail.',
      mode: 'short_answer',
      options: [],
    }),
  ];
};

const formatDefaultAnswers = (questions: any[]) => {
  const requiredQuestions = questions.filter(question => question.required !== false);
  if (requiredQuestions.length === 0) return '';
  if (!requiredQuestions.every(question => question.defaultValue)) return '';

  if (questions.length === 1) return String(questions[0].defaultValue || '').trim();

  return questions
    .filter(question => question.defaultValue)
    .map((question, index) => `${index + 1}. ${question.question}: ${question.defaultValue}`)
    .join('\n');
};

export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  description: `Pause execution and ask the user for a specific answer.

Use this only when the answer cannot be safely inferred from the user's request,
files, tools, or available context.

Ask a single question with question/mode/options, or ask 2-8 related questions in
one pause with questions[]. Each question can be required and can use its own mode.

Modes:
- choice: one selection from 2-6 concise options.
- multi_select: multiple selections from 2-10 concise options.
- short_answer: one-line input for names, paths, URLs, keys, or short values.
- text: longer free-form answer.
- confirm: yes/no decision for risky or important actions.

Guidance:
- Prefer one concise question. Use questions[] only when several answers are required before work can continue.
- Explain why the answer is needed in context when useful.
- Prefer short_answer over text for paths, filenames, URLs, and small values.
- Provide defaultValue when there is a safe fallback.
- Do not use this tool to stall; use it only when user input materially changes the next action.`,

  category: 'core',
  inputSchema: z.object({
    question: z.string().optional().describe('The exact question to show the user, or a title for a questions[] group.'),
    mode: askUserModeSchema
      .optional()
      .default('short_answer')
      .describe('Interaction mode for the UI. Defaults to short_answer.'),
    options: z.array(askUserOptionSchema).optional().describe('Required for choice and multi_select modes.'),
    questions: z.array(askUserQuestionSchema)
      .optional()
      .describe('Optional group of 2-8 related questions to ask in one form. Use when multiple answers are required before continuing.'),
    context: z.string().optional().describe('Brief reason this question is needed.'),
    defaultValue: z.string().optional().describe('Safe fallback or prefilled value.'),
    urgent: z.boolean().optional().default(false).describe('True when progress is blocked without an answer.'),
  }),

  outputSchema: z.object({
    answer: z.string(),
    answers: z.any().optional(),
    selectedOption: z.any().optional(),
    responseKey: z.string().optional(),
    respondedInMs: z.number().optional(),
    timedOut: z.boolean().optional(),
    usedDefault: z.boolean().optional(),
    error: z.string().optional(),
  }),

  execute: async (input: any, ctx?: any) => {
    const timestamp = Date.now();
    const responseKey = `ask_user_${timestamp}`;
    const questions = normalizeQuestions(input);
    const isQuestionGroup = questions.length > 1;
    const mode = isQuestionGroup ? 'questions' : questions[0].mode;
    const options = isQuestionGroup ? [] : questions[0].options;
    const defaultAnswer = String(input?.defaultValue || '').trim() || formatDefaultAnswers(questions);
    const groupQuestion = String(input?.question || '').trim();

    const pendingQuestion = {
      question: groupQuestion || (isQuestionGroup ? `Please answer ${questions.length} questions.` : questions[0].question),
      mode,
      questions,
      options,
      context: String(input?.context || '').trim(),
      defaultValue: defaultAnswer,
      urgent: Boolean(input?.urgent),
      status: 'pending',
      answer: null,
      answers: null,
      selectedOption: null,
      createdAt: timestamp,
      responseKey,
    };

    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__pendingAskUser = (globalThis as any).__pendingAskUser || {};
      (globalThis as any).__pendingAskUser[responseKey] = pendingQuestion;
    }

    const askEvent = {
      type: 'ask_user',
      question: pendingQuestion.question,
      mode,
      questions,
      options,
      context: pendingQuestion.context,
      defaultValue: pendingQuestion.defaultValue,
      urgent: pendingQuestion.urgent,
      timestamp,
      responseKey,
    };

    if (ctx?._onTrace) {
      ctx._onTrace(askEvent);
    }

    console.log(`[Tool: ask_user] Waiting for user input, mode=${mode}, urgent=${pendingQuestion.urgent}, key=${responseKey}`);

    const startTime = Date.now();
    while (Date.now() - startTime < ASK_USER_MAX_WAIT_MS) {
      const pending = (globalThis as any).__pendingAskUser?.[responseKey];

      if (pending?.status === 'answered' && pending?.answer !== null && pending?.answer !== undefined) {
        delete (globalThis as any).__pendingAskUser[responseKey];
        const elapsed = Date.now() - startTime;

        console.log(`[Tool: ask_user] User answered in ${(elapsed / 1000).toFixed(1)}s.`);

        return {
          answer: String(pending.answer),
          answers: pending.answers ?? null,
          selectedOption: pending.selectedOption ?? null,
          responseKey,
          respondedInMs: elapsed,
        };
      }

      await new Promise(resolve => setTimeout(resolve, ASK_USER_POLL_INTERVAL_MS));
    }

    if ((globalThis as any).__pendingAskUser?.[responseKey]) {
      delete (globalThis as any).__pendingAskUser[responseKey];
    }

    if (pendingQuestion.defaultValue) {
      console.log(`[Tool: ask_user] Timed out; using default for key=${responseKey}.`);
      return {
        answer: pendingQuestion.defaultValue,
        responseKey,
        timedOut: true,
        usedDefault: true,
      };
    }

    console.warn(`[Tool: ask_user] Timed out with no answer for key=${responseKey}.`);
    return {
      answer: '',
      responseKey,
      timedOut: true,
      error: 'User did not respond within 10 minutes. Continue with best judgment or ask a simpler question.',
    };
  },
};
