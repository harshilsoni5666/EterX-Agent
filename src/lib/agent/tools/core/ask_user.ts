import { z } from 'zod';
import { ToolDefinition } from '../../schemas';

/**
 * Ask User Tool v1.0
 * 
 * A powerful interaction tool that lets the agent PAUSE and ask the user
 * for information when it doesn't have enough context to proceed.
 * 
 * FEATURES:
 * - Presents a question to the user in a clean UI
 * - Can provide multiple choice options for quick selection  
 * - Can ask for free-text input
 * - Supports urgent/normal priority levels
 * - Returns the user's answer so the agent can continue
 * 
 * This makes the agent MUCH smarter — instead of guessing wrong,
 * it asks when unsure, like a real team member would.
 */
export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  modelDescription: 'Ask only for missing user input or authorization that blocks the next meaningful action; use available context/tools for discoverable facts. Send one focused question or group related questions once. Single: question + mode=text/short_answer/confirm; choice/multi_select adds options:[{label,value}]. Group: mode=questions + questions:[{id,question,mode,options?}]. Defaults are suggestions, never submitted answers or permission. Wait for the actual reply; do not re-ask an answered question or treat a timeout as consent.',
  description: `Ask the user a clarifying question when you need more information to proceed. 
  
USE THIS WHEN:
- You don't have enough information to make a good decision
- There are multiple valid approaches and user preference matters
- The task is ambiguous and guessing wrong would waste time
- You need a file path, API key, preference, or specific detail

DO NOT USE FOR:
- Things you can figure out yourself (file names, code structure, etc.)
- Simple yes/no decisions where you should just pick the better option
- Routine connector discovery, status checks, retries, or connected-service work already authorized by the task
- Stalling or being lazy — only ask when it truly matters

MODES:
- "choice": Present 2-5 options for the user to pick from. Best for clear alternatives.
- "text": Ask an open-ended question. Best for paths, names, details.
- "confirm": Yes/No confirmation before a potentially impactful action.

The response will contain the user's answer. Continue your work based on it.`,
  category: 'core',
  inputSchema: z.object({
    question: z.string().optional().describe('Required for a single question. Optional group heading when mode=questions.'),
    mode: z.enum(['choice', 'text', 'confirm', 'multi_select', 'short_answer', 'questions']).optional().default('text').describe('text/short_answer need question; choice/multi_select also need options; confirm is explicit yes/no; questions needs questions[].'),
    options: z.array(z.object({
      label: z.string().describe('Short label for this option (e.g., "Desktop")'),
      description: z.string().optional().describe('Optional longer description of what this option means'),
      value: z.string().describe('The value returned if this option is selected')
    })).min(2).max(8).optional().describe('Required for choice/multi_select: 2–8 distinct options with label and value. Prefer 2–3 useful alternatives.'),
    questions: z.array(z.object({
      id: z.string().optional(),
      question: z.string(),
      mode: z.enum(['choice', 'text', 'confirm', 'multi_select', 'short_answer']).optional(),
      options: z.array(z.object({
        label: z.string(),
        description: z.string().optional(),
        value: z.string(),
      })).optional(),
      context: z.string().optional(),
      defaultValue: z.string().optional(),
      required: z.boolean().optional(),
      placeholder: z.string().optional(),
    })).min(1).max(20).optional().describe('Required for mode=questions. Group related blockers once; normally ask 1–3 concise questions. Each needs question and a unique id.'),
    context: z.string().optional().describe('Brief context about WHY you need this information (shown to user)'),
    defaultValue: z.string().optional().describe('Suggested value the user must explicitly submit. Never automatically authorizes an action.'),
    urgent: z.boolean().optional().default(false).describe('If true, marks as high priority — agent is blocked without this info')
  }).superRefine((value, issueContext) => {
    if (value.mode === 'questions') {
      if (!value.questions?.length) issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ['questions'], message: 'questions[] is required for mode=questions.' });
    } else if (!value.question?.trim()) issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ['question'], message: 'A non-empty question is required.' });
    if (['choice', 'multi_select'].includes(value.mode || '') && !value.options?.length) {
      issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Provide at least two labeled options for choice/multi_select.' });
    }
  }),
  outputSchema: z.object({
    success: z.boolean().optional(),
    answer: z.string(),
    selectedOption: z.any().optional(),
    answers: z.array(z.any()).optional(),
    timedOut: z.boolean().optional(),
    respondedInMs: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (input: any, ctx?: any) => {
    const { question, mode, options, context, defaultValue, urgent } = input;
    const questions = Array.isArray(input?.questions)
      ? input.questions.slice(0, 20).map((item: any, index: number) => ({
          id: String(item?.id || `q_${index + 1}`).slice(0, 80),
          question: String(item?.question || '').slice(0, 1000),
          mode: item?.mode || 'text',
          options: Array.isArray(item?.options) ? item.options.slice(0, 8) : [],
          context: String(item?.context || '').slice(0, 1000),
          defaultValue: String(item?.defaultValue || '').slice(0, 2000),
          required: item?.required !== false,
          placeholder: String(item?.placeholder || '').slice(0, 200),
        })).filter((item: any) => item.question)
      : [];
    const timestamp = Date.now();
    const responseKey = `ask_user_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
    const chatId = String(ctx?.chatId || ctx?.projectId || '').slice(0, 160);
    const sessionId = String(ctx?.agentSessionId || '').slice(0, 160);
    
    // Build the ask_user event payload for the frontend
    const askEvent = {
      type: 'ask_user',
      question,
      mode: mode || 'text',
      options: options || [],
      questions,
      context: context || '',
      defaultValue: defaultValue || '',
      urgent: !!urgent,
      responseKey,
      chatId,
      timestamp
    };
    // Store the pending question globally so the API can match responses
    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__pendingAskUser = (globalThis as any).__pendingAskUser || {};
      const store = (globalThis as any).__pendingAskUser;
      const receipts = Object.entries(store).filter(([, item]: [string, any]) => item.status === 'answered')
        .sort((a: any, b: any) => Number(a[1].answeredAt || 0) - Number(b[1].answeredAt || 0));
      receipts.forEach(([key, item]: [string, any], index) => {
        if (timestamp - Number(item.answeredAt || 0) > 15 * 60 * 1000 || index < receipts.length - 200) delete store[key];
      });
      (globalThis as any).__pendingAskUser[responseKey] = {
        question,
        mode,
        options,
        questions,
        context: context || '',
        defaultValue: defaultValue || '',
        urgent: !!urgent,
        chatId,
        sessionId,
        status: 'pending',
        answer: null,
        selectedOption: null,
        answers: null,
        createdAt: timestamp
      };
    }

    // Emit the event to the frontend via the trace callback after the pending
    // record exists, otherwise a fast answer can race the store write.
    if (ctx?._onTrace) {
      ctx._onTrace(askEvent);
    }
    
    // Wait for the user's response
    // The frontend will send back an answer via a special API endpoint
    // For now, we use a polling mechanism with a global response store
    
    // Poll for response with timeout (max 5 minutes)
    const MAX_WAIT_MS = 5 * 60 * 1000;
    const POLL_INTERVAL_MS = 500;
    const startTime = Date.now();
    const isCancelled = () => Boolean(
      ctx?.abortSignal?.aborted ||
      ctx?.signal?.aborted ||
      (typeof ctx?.isCancelled === 'function' && ctx.isCancelled()),
    );
    const waitForPollOrCancellation = () => new Promise<void>((resolve, reject) => {
      if (isCancelled()) {
        delete (globalThis as any).__pendingAskUser?.[responseKey];
        reject(new Error('CANCELLED_BY_USER'));
        return;
      }

      const signal = (ctx?.abortSignal || ctx?.signal) as AbortSignal | undefined;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener('abort', onAbort);
        delete (globalThis as any).__pendingAskUser?.[responseKey];
        reject(new Error('CANCELLED_BY_USER'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        timer = null;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, POLL_INTERVAL_MS);
    });

    while (Date.now() - startTime < MAX_WAIT_MS) {
      if (isCancelled()) {
        delete (globalThis as any).__pendingAskUser?.[responseKey];
        throw new Error('CANCELLED_BY_USER');
      }
      // Check if user has responded
      const pending = (globalThis as any).__pendingAskUser?.[responseKey];
      
      if (pending?.status === 'answered' && pending?.answer !== null) {
        // Keep a short-lived receipt so a lost HTTP response can be retried
        // after the agent has already consumed this answer.
        pending.consumedAt = Date.now();
        
        return {
          success: true,
          answer: pending.answer,
          selectedOption: pending.selectedOption || null,
          answers: pending.answers || undefined,
          respondedInMs: Date.now() - startTime
        };
      }
      
      // Wait before polling again, but let Stop/cancellation interrupt the wait.
      await waitForPollOrCancellation();
    }
    
    // A timeout is not a user decision, including when a default was suggested.
    // Clean up
    delete (globalThis as any).__pendingAskUser?.[responseKey];
    
    return {
      success: false,
      answer: '',
      timedOut: true,
      error: 'No user reply was received. Do not infer an answer or permission, repeat the same question, or take the blocked action. Preserve the unresolved question; do only independent authorized work.'
    };
  }
};
