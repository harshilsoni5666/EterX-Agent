import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import { getPlanEngine } from '../../plan-execution-engine';
import { getEterxWorkspaceDir } from '../../storage-paths';
import { getAgentConversationScope } from '../../context-scope';
import { stableScopeSegment } from '../../context-scope';
import { globalSessionManager } from '../../session';
import { readTaskTracker, trackerToTrace, writeTaskTrackerState, type TaskTrackerData, type TaskTrackerStep } from '../../task-tracker-store';

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

const planStepSchema = z.object({
  step: z.number().int().describe('Step number (1-indexed)'),
  name: z.string().describe('Short title of the step'),
  description: z.string().optional().describe('Action description'),
  done_when: z.string().describe('Concrete verification condition'),
  depends_on: z.array(z.number().int()).optional().describe('Step numbers this step depends on'),
  tools: z.array(z.string()).optional().describe('List of tools likely needed'),
  step_type: z.enum(['inspect', 'research', 'configure', 'edit', 'create', 'run', 'verify', 'communicate', 'deliver']).optional().describe('Type of task step'),
  expected_output: z.string().optional().describe('Expected deliverable/result'),
  risk: z.enum(['low', 'medium', 'high']).optional().describe('Risk classification'),
  artifacts: z.array(z.string()).optional().describe('Paths to files produced/edited'),
});

export const checkpointTool: ToolDefinition = {
  name: 'task_checkpoint',
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
    action: z.enum(['save', 'load', 'clear', 'advance', 'skip', 'fail', 'activate', 'revise', 'complete']).describe(
      'Plan control: advance, skip, fail, activate, revise, complete. Checkpoint: save, load, clear.'
    ),
    reason: z.string().optional().describe('Reason for skip/fail/complete action'),
    stepNumber: z.number().int().optional().describe('Step number to activate (for "activate" action)'),
    summary: z.string().optional().describe('Completion summary (for "complete" action)'),
    evidence: z.array(z.string()).optional().describe('Concrete evidence supporting step or plan completion'),
    force: z.boolean().optional().describe('Explicitly complete despite unfinished steps; requires justification'),
    revisedGoal: z.string().optional().describe('Updated goal for a revised plan'),
    revisedSteps: z.array(planStepSchema).optional().describe('Replacement plan steps for intelligent replanning'),
    taskSummary: z.string().optional().describe('Brief description of progress (for checkpoint save)'),
    nextSteps: z.array(z.string()).optional().describe('Remaining steps (for checkpoint save)'),
    filesCreated: z.array(z.string()).optional().describe('Files created/modified (for checkpoint save)'),
    metadata: z.record(z.string(), z.any()).optional().describe('Extra context to persist'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    checkpoint: z.any().optional(),
    message: z.string(),
    activeStep: z.any().optional(),
    planCompleted: z.boolean().optional(),
  }),
  execute: async (input: any, context?: any) => {
    const chatId = getAgentConversationScope(context);
    const planEngine = getPlanEngine(chatId);

    // ── Plan Control Actions ──
    if (['advance', 'skip', 'fail', 'activate', 'revise', 'complete'].includes(input.action)) {
      if (!planEngine.hasActivePlan()) {
        return {
          success: false,
          message: `No active plan. Use task_decomposer first to create a plan, or use "save"/"load" for checkpoints.`,
        };
      }

      let result;
      switch (input.action) {
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
          result = planEngine.executeAction({ type: 'revise', reason: input.reason || '', steps: input.revisedSteps || [], goal: input.revisedGoal });
          break;
        case 'complete':
          result = planEngine.executeAction({ type: 'complete', summary: input.summary || input.reason || '', force: Boolean(input.force), evidence: input.evidence });
          break;
        default:
          return { success: false, message: 'Unknown plan action.' };
      }

      // Sync with session manager and task tracker
      let trackerTrace: TaskTrackerData | null = null;
      try {
        if (chatId) {
          const planState = planEngine.serialize();

          if (planState) {
            const existing = readTaskTracker(chatId)?.data;
            const data: TaskTrackerData = {
              goal: planState.goal,
              chatId,
              createdAt: existing?.createdAt || planState.createdAt,
              updatedAt: Date.now(),
              complexity: existing?.complexity || 'moderate',
              estimatedMinutes: existing?.estimatedMinutes || 0,
              status: planState.status === 'completed' ? 'completed' : planState.status === 'failed' ? 'failed' : 'in_progress',
              steps: planState.steps.map((step): TaskTrackerStep => ({
                id: step.id,
                step: step.step,
                name: step.name,
                description: step.description,
                tools: step.tools,
                done_when: step.done_when,
                depends_on: step.depends_on,
                priority: step.priority,
                step_type: step.step_type,
                expected_output: step.expected_output,
                risk: step.risk,
                artifacts: step.artifacts,
                status: step.status === 'active' ? 'in_progress'
                  : step.status === 'ready' ? 'pending'
                    : step.status === 'blocked' ? 'blocked'
                    : step.status,
                startedAt: step.startedAt,
                completedAt: step.completedAt,
                completionReason: step.completionReason,
                completionEvidence: step.completionEvidence,
                failureReason: step.failureReason,
              })),
            };
            await writeTaskTrackerState(chatId, data);
            trackerTrace = data;
            globalSessionManager.setExecutionPlanForChat(chatId, planState);
            globalSessionManager.setTaskPlanForChat(
              chatId,
              planState.steps.map((s: any) => ({
                name: s.name,
                status: s.status === 'done' || s.status === 'skipped' ? 'done' as const : 'pending' as const,
                description: s.description,
              }))
            );
            await globalSessionManager.saveForChat(chatId);
          }
        }
      } catch (syncError: any) {
        console.warn(`[Tool: task_checkpoint] Plan state sync failed: ${String(syncError?.message || syncError)}`);
      }

      // Emit UI-compatible trace so the task dock updates
      const emitTrace = typeof context?._onTrace === 'function' ? context._onTrace : null;
      if (emitTrace && trackerTrace) {
        emitTrace(trackerToTrace(
          trackerTrace,
          trackerTrace.status === 'completed' ? 'complete' : trackerTrace.status === 'failed' ? 'failed' : 'progress',
        ));
      }

      return {
        success: result.success,
        message: result.message,
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
            planState: planEngine.hasActivePlan() ? planEngine.serialize() : null,
          };

          await writeJsonAtomic(checkpointFile, checkpoint);
          console.log(`[Tool: task_checkpoint] 💾 Checkpoint saved: ${input.taskSummary?.substring(0, 60)}`);

          return {
            success: true,
            message: `Checkpoint saved. ${input.nextSteps?.length || 0} steps remaining. Resume with "continue".`
          };
        }

        case 'load': {
          if (!await fs.pathExists(checkpointFile)) {
            return {
              success: false,
              message: 'No checkpoint found. This appears to be a fresh task — start from scratch.'
            };
          }

          const checkpoint = await fs.readJson(checkpointFile);
          const ageMinutes = ((Date.now() - checkpoint.savedAt) / 60000).toFixed(1);

          if (Date.now() - checkpoint.savedAt > 24 * 60 * 60 * 1000) {
            return {
              success: false,
              message: `Found checkpoint from ${ageMinutes} minutes ago, but it's too old (>24h). Starting fresh.`
            };
          }

          // Restore plan engine state if available
          if (checkpoint.planState) {
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
          return { success: false, message: 'Unknown action. Use save, load, clear, advance, skip, activate, or complete.' };
      }
    } catch (err: any) {
      return { success: false, message: `Checkpoint error: ${err.message}` };
    }
  }
};
