import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import { sessionPlanEngine, publishPlan } from './plan-persistence';
import { planStepSchema } from './plan-step';
import { planModeForContext } from '../../plan-mode';
import { trackerFromPlan } from '../../task-tracker-store';
import { getEterxWorkspaceDir } from '../../storage-paths';
import { getAgentConversationScope } from '../../context-scope';
import { stableScopeSegment } from '../../context-scope';
import { globalSessionManager } from '../../session';
import { formatUnknownError } from '../../error-format';

/**
 * Task Checkpoint Tool v2.0
 *
 * Two responsibilities:
 *
 * 1. CHECKPOINT — Save/load progress checkpoints for long-running tasks
 *    so the agent can resume after interruptions.
 *
 * 2. PLAN CONTROL — When a task plan is active, the model uses this tool
 *    to control plan progression with its own intelligence:
 *      - advance: Mark the current step done and move to the next
 *      - skip: Skip the current step (with a reason)
 *      - activate N: Jump to step N
 *      - complete: Mark the entire plan done
 *
 *    The model decides WHEN a step is done — not regex, not keyword
 *    matching. The model reads the plan state context injected into
 *    its prompt and uses its reasoning to determine progress.
 */

const CHECKPOINT_DIR = getEterxWorkspaceDir('.checkpoints');

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveUnder(parent: string, ...segments: string[]): string {
  const resolved = path.resolve(parent, ...segments);
  if (!isPathInside(parent, resolved)) {
    throw new Error(`Resolved path escapes expected directory: ${resolved}`);
  }
  return resolved;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, data, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}

export const checkpointTool: ToolDefinition = {
  name: 'task_checkpoint',
  modelDescription: 'Use view to read the current plan, constraints, step ids and outcomes. Start a proposal when the user requests implementation in Auto mode. Revise the document or steps with a reason and retain resolved steps. Advance a step with evidence for done_when, skip or fail it with a reason, or activate a ready step by stepNumber. Complete with a summary. Save, load and clear manage separate resume checkpoints.',
  description: `Control task plan progression and save/load checkpoints.

PLAN CONTROL (use when a task plan is active):
  - action: "advance" — Mark the current plan step done. Include why done_when is satisfied and concrete evidence when available.
  - action: "skip" — Skip the current step (requires reason). Use when a step is unnecessary or blocked.
  - action: "fail" — Record that the current step failed and explain the cause.
  - action: "activate" — Jump to a specific step number (set stepNumber). Use to work on steps out of order.
  - action: "revise" — Replace unfinished work with revisedSteps when evidence changes the best approach. Completed work is preserved.
  - action: "complete" — Finish after all important steps are terminal. Unfinished steps require force=true and justification.

CHECKPOINT (use on long tasks without a plan):
  - action: "save" — Persist progress so you can resume later if interrupted
  - action: "load" — Retrieve last checkpoint when continuing a previous task
  - action: "clear" — Delete the checkpoint

When a plan is active, prefer plan control actions over checkpoint save/load.`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['save', 'load', 'clear', 'view', 'start', 'advance', 'skip', 'fail', 'activate', 'revise', 'complete']).describe(
      'Plan control: view, start, advance, skip, fail, activate, revise, complete. Checkpoint: save, load, clear.'
    ),
    reason: z.string().optional().describe('Required for advance (why done_when is satisfied), skip, fail, and revise. May justify forced completion.'),
    stepNumber: z.number().int().optional().describe('Step number to activate (for "activate" action)'),
    summary: z.string().optional().describe('Completion summary (for "complete" action)'),
    evidence: z.array(z.string()).optional().describe('Concrete evidence supporting step or plan completion'),
    force: z.boolean().optional().describe('Explicitly complete despite unfinished steps; requires justification'),
    title: z.string().trim().min(1).max(160).optional().describe("New title for a revision"),
    document: z.string().trim().max(32_000).optional().describe("Updated Markdown implementation plan for a revision"),
    revisedGoal: z.string().optional().describe('Updated goal for a revised plan'),
    revisedSteps: z.array(planStepSchema).min(1).max(20).optional().describe('Replacement steps for revise. Include completed outcomes unchanged. Omit when revising only the title or document.'),
    taskSummary: z.string().optional().describe('Brief description of progress (for checkpoint save)'),
    nextSteps: z.array(z.string()).optional().describe('Remaining steps (for checkpoint save)'),
    filesCreated: z.array(z.string()).optional().describe('Files created/modified (for checkpoint save)'),
    metadata: z.record(z.string(), z.any()).optional().describe('Extra context to persist'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    plan: z.any().optional(),
    checkpoint: z.any().optional(),
    message: z.string(),
    activeStep: z.any().optional(),
    planCompleted: z.boolean().optional(),
  }),
  execute: async (input: any, context?: any) => {
    const chatId = getAgentConversationScope(context);
    const planEngine = sessionPlanEngine(chatId);
    if (input.action === 'view') {
      const state = planEngine.serialize();
      return state ? { success: true, message: 'Current plan revision ' + state.revision, plan: trackerFromPlan(chatId, state) }
        : { success: false, message: 'There is no plan in the current task.' };
    }

    // ── Plan Control Actions ──
    if (['start', 'advance', 'skip', 'fail', 'activate', 'revise', 'complete'].includes(input.action)) {
      if (!planEngine.hasOpenPlan()) {
        return {
          success: false,
          message: 'No active plan. Work directly unless persistent coordination is actually needed. save/load are available for an explicit checkpoint; do not create a plan just to advance it.',
        };
      }

      if (planModeForContext(context) && input.action !== 'revise') {
        return { success: false, message: 'Switch to Auto mode to implement this proposal.' };
      }
      let result;
      switch (input.action) {
        case 'start':
          result = planEngine.executeAction({ type: 'start' });
          break;
        case 'advance':
          result = planEngine.executeAction({ type: 'advance', reason: input.reason || '', evidence: input.evidence });
          break;
        case 'skip':
          if (!String(input.reason || '').trim()) return { success: false, message: 'reason is required for "skip" action.' };
          result = planEngine.executeAction({ type: 'skip', reason: input.reason });
          break;
        case 'fail':
          if (!String(input.reason || '').trim()) return { success: false, message: 'reason is required for "fail" action.' };
          result = planEngine.executeAction({ type: 'fail', reason: input.reason });
          break;
        case 'activate':
          if (!input.stepNumber) {
            return { success: false, message: 'stepNumber is required for "activate" action.' };
          }
          result = planEngine.executeAction({ type: 'activate', stepNumber: input.stepNumber });
          break;
        case 'revise':
          result = planEngine.executeAction({ type: 'revise', reason: input.reason || '', steps: input.revisedSteps, goal: input.revisedGoal,
            title: input.title, document: input.document, proposed: planModeForContext(context) });
          break;
        case 'complete':
          result = planEngine.executeAction({ type: 'complete', summary: input.summary || input.reason || '', force: Boolean(input.force), evidence: input.evidence });
          break;
        default:
          return { success: false, message: 'Unknown plan action.' };
      }

      const state = planEngine.serialize();
      const stored = result.success && state ? await publishPlan(chatId, state, context?._onTrace) : undefined;

      return {
        success: result.success,
        message: [result.message, ...(stored?.warnings || [])].join(" "),
        activeStep: result.activeStep ? {
          step: result.activeStep.step,
          name: result.activeStep.name,
          step_type: result.activeStep.step_type,
          done_when: result.activeStep.done_when,
          tools: result.activeStep.tools,
        } : null,
        planCompleted: result.planCompleted,
      };
    }

    // ── Legacy Checkpoint Actions ──
    await fs.ensureDir(CHECKPOINT_DIR);
    const safeChatId = stableScopeSegment(chatId, 64);
    const checkpointFile = resolveUnder(CHECKPOINT_DIR, `${safeChatId || 'default'}.json`);

    try {
      switch (input.action) {
        case 'save': {
          const checkpoint = {
            taskSummary: input.taskSummary || 'No summary provided',
            nextSteps: input.nextSteps || [],
            filesCreated: input.filesCreated || [],
            metadata: input.metadata || {},
            savedAt: Date.now(),
            savedAtISO: new Date().toISOString(),
            // Also persist plan engine state if active
            planState: planEngine.hasOpenPlan() ? planEngine.serialize() : null,
          };

          await writeJsonAtomic(checkpointFile, checkpoint);
          console.log(`[Tool: task_checkpoint] 💾 Checkpoint saved: ${input.taskSummary?.substring(0, 60)}`);

          return {
            success: true,
            message: `Checkpoint saved with ${input.nextSteps?.length || 0} remaining steps. Interpret later requests with this state and the current conversation.`
          };
        }

        case 'load': {
          if (!await fs.pathExists(checkpointFile)) {
            return {
              success: false,
              message: 'No checkpoint found. Use the existing conversation and context state; absence of a checkpoint does not mean earlier work is absent.'
            };
          }

          const checkpoint = await fs.readJson(checkpointFile);
          const ageMinutes = ((Date.now() - checkpoint.savedAt) / 60000).toFixed(1);

          if (Date.now() - checkpoint.savedAt > 24 * 60 * 60 * 1000) {
            return {
              success: false,
              checkpoint,
              message: `Checkpoint is ${ageMinutes} minutes old. Treat it as historical context, not current execution evidence; do not restart completed work.`
            };
          }

          // Restore plan engine state if available
          if (checkpoint.planState && !planEngine.hasOpenPlan()) {
            try {
              planEngine.restore(checkpoint.planState);
              try {
                const { globalSessionManager } = require('../../session');
                globalSessionManager.setExecutionPlanForChat(chatId, planEngine.serialize());
              } catch { }
              console.log(`[Tool: task_checkpoint] 📋 Plan engine state restored from checkpoint.`);
            } catch { /* plan restore is advisory */ }
          }

          console.log(`[Tool: task_checkpoint] 📋 Loaded checkpoint (${ageMinutes} min old): ${checkpoint.taskSummary?.substring(0, 60)}`);

          return {
            success: true,
            checkpoint,
            message: `Checkpoint loaded (${ageMinutes} min old). Task: "${checkpoint.taskSummary}". ${checkpoint.nextSteps?.length || 0} steps remaining. Files: ${checkpoint.filesCreated?.join(', ') || 'none'}.`
          };
        }

        case 'clear': {
          if (await fs.pathExists(checkpointFile)) {
            await fs.remove(checkpointFile);
          }
          return { success: true, message: 'Checkpoint cleared.' };
        }

        default:
          return { success: false, message: 'Unknown action. Use save, load, clear, advance, skip, fail, activate, revise, or complete.' };
      }
    } catch (err: any) {
      return { success: false, message: `Checkpoint error: ${formatUnknownError(err, 'Unknown checkpoint failure')}` };
    }
  }
};
