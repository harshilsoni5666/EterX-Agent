import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ToolDefinition } from '../../schemas';
import { globalTaskPlanner } from '../../task_planner';
import { normalizeMainAgentMode } from '../../model-routing';
import { getAgentConversationScope } from '../../context-scope';
import { formatUnknownError } from '../../error-format';
import { planModeForContext } from '../../plan-mode';
import { trackerFromPlan, trackerToTrace } from '../../task-tracker-store';
import { planStepSchema } from './plan-step';
import { publishPlan, sessionPlanEngine } from './plan-persistence';

const planInput = z.object({
  complexTask: z.string().trim().min(1).describe('The goal this plan addresses.'),
  context: z.string().optional().describe('Relevant findings, decisions and user constraints.'),
  intent: z.enum(['track', 'propose']).optional().describe('Track authorized work, or propose work for later implementation. Plan mode always proposes.'),
  title: z.string().trim().min(1).max(160).optional().describe('Concise human-readable plan title.'),
  document: z.string().trim().min(1).max(32_000).optional().describe('Full implementation plan in Markdown, starting with a summary. Include decisions, scope and acceptance criteria where relevant. Omit for a compact checklist.'),
  steps: z.array(planStepSchema).min(1).max(20).optional().describe('Supply the remaining outcomes directly when the approach is known.'),
  maxSubtasks: z.number().int().min(1).max(20).optional().describe('Maximum generated steps, default 8.'),
});

type PlanInput = z.infer<typeof planInput>;
const pending = new Map<string, Promise<Awaited<ReturnType<typeof createPlan>>>>();

function planningDeclined(task: string) {
  // Qualifiers such as "don't plan first" leave the timing to the agent.
  return /\b(?:(?:do not|don't|dont|never|skip|avoid|without)\s+(?:(?:make|create|use|making|creating|using)\s+)?(?:a\s+)?(?:visible\s+)?|no\s+)(?:plan(?:ning)?|decomposition|task tracker|checklist)\b(?=\s*(?:[.,;!?\n]|$))/i.test(task);
}

async function createPlan(chatId: string, input: PlanInput, context: any) {
  const proposed = planModeForContext(context) || input.intent === 'propose' || (Boolean(input.document) && input.intent !== 'track');
  const emit = context?._onTrace;
  const engine = sessionPlanEngine(chatId);
  if (engine.hasOpenPlan()) {
    const existing = engine.serialize()!;
    const tracker = trackerFromPlan(chatId, existing);
    emit?.(trackerToTrace(tracker));
    return { success: true, skippedDuplicate: true, plan: tracker.steps, totalSteps: tracker.steps.length,
      estimatedTools: [...new Set(tracker.steps.flatMap(step => step.tools))], status: tracker.status,
      message: existing.status === 'proposed' ? 'The proposal already exists. Revise it with task_checkpoint, or start it in Auto mode when implementation is requested.' : 'Reuse the existing tracker. Revise unfinished work or advance completed outcomes with task_checkpoint.' };
  }
  const ownerTraceId = context?.ownerTraceId;
  const createdAt = Date.now();
  const base = { planId: 'task-plan-' + (ownerTraceId || randomUUID()), chatId, createdAt, title: input.title,
    goal: input.complexTask, complexity: 'pending', estimatedMinutes: 0, steps: [] };
  const emitLifecycle = (phase: 'generating' | 'failed', error?: string) => emit?.({
    ...trackerToTrace({ ...base, status: phase, updatedAt: Date.now() }, phase), ownerTraceId, ...(error ? { error } : {}),
  });
  emitLifecycle('generating');
  try {
    const options = { maxSubtasks: input.maxSubtasks ?? (input.steps ? input.steps.length : 8),
      provider: context?.selectedModelProvider, modelName: context?.selectedModelName };
    const notes = input.context || '';
    const plan = input.steps
      ? globalTaskPlanner.fromSteps(input.steps, input.complexTask, notes, options)
      : await globalTaskPlanner.decompose(input.complexTask, notes,
        normalizeMainAgentMode(context?.selectedModelMode || context?.modelMode || 'think'), options);
    if (context?.abortSignal?.aborted || context?.signal?.aborted || context?.isCancelled?.()) throw new Error('CANCELLED_BY_USER');
    const awaitingImplementation = proposed || planModeForContext(context);
    engine.loadPlan(input.complexTask, plan.steps, {
      planId: base.planId, title: input.title, document: input.document, context: notes,
      complexity: plan.estimated_complexity, estimatedMinutes: plan.estimated_time_minutes,
    }, awaitingImplementation);
    const stored = await publishPlan(chatId, engine.serialize()!, emit ? event => emit({ ...event, ownerTraceId }) : undefined, true);
    return {
      success: true, plan: plan.steps, planId: base.planId, totalSteps: plan.steps.length,
      estimatedTools: [...new Set(plan.steps.flatMap(step => step.tools))],
      status: awaitingImplementation ? 'proposed' : 'in_progress',
      complexity: plan.estimated_complexity, estimatedMinutes: plan.estimated_time_minutes,
      plannerVersion: plan.planner_version, qualityWarnings: [...plan.quality_warnings, ...stored.warnings],
      trackerFiles: stored.trackerFiles,
      message: awaitingImplementation ? 'The proposal is available for review. Summarize the decision and leave implementation for the user.' : 'The tracker is open. Work on the authorized outcomes and update it when evidence or scope changes.',
    };
  } catch (error) {
    const message = formatUnknownError(error, 'Could not prepare the plan');
    emitLifecycle('failed', message);
    return { success: false, plan: [], totalSteps: 0, estimatedTools: [], error: message };
  }
}

export const taskDecomposerTool: ToolDefinition = {
  name: 'task_decomposer',
  modelDescription: 'Publish a plan when the user wants one or tracking would help. In Auto, work directly when clear and investigate first when needed. Use intent=track for a live checklist or intent=propose for a plan to review. Supply steps from your findings to avoid a second model call. Add title and document for a full implementation plan. Carry user constraints in context. Revise an open plan with task_checkpoint.',
  description: 'Create a chat-scoped proposal or execution tracker with concrete outcomes and dependencies. A full Markdown implementation plan and its tracked steps share one identity.',
  category: 'core',
  inputSchema: planInput,
  outputSchema: z.object({
    success: z.boolean(), plan: z.array(z.any()), totalSteps: z.number(), estimatedTools: z.array(z.string()),
    skipped: z.boolean().optional(), skippedDuplicate: z.boolean().optional(), status: z.string().optional(),
    plannerVersion: z.string().optional(), qualityWarnings: z.array(z.string()).optional(),
    message: z.string().optional(), error: z.string().optional(),
  }),
  execute: async (input: PlanInput, context?: any) => {
    const chatId = getAgentConversationScope(context);
    if (planningDeclined(context?.visibleUserRequest || context?.rootUserRequest || input.complexTask)) {
      return { success: true, skipped: true, plan: [], totalSteps: 0, estimatedTools: [], message: 'The user declined a tracker. Continue within the requested scope.' };
    }
    const existing = pending.get(chatId);
    if (existing) return existing;
    const generation = createPlan(chatId, input, context);
    pending.set(chatId, generation);
    try { return await generation; }
    finally { if (pending.get(chatId) === generation) pending.delete(chatId); }
  },
};
