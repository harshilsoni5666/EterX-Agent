import { globalSessionManager } from '../../session';
import { getPlanEngine, type PlanState } from '../../plan-execution-engine';
import { readTaskTracker, trackerFromPlan, trackerToTrace, writeTaskTrackerState } from '../../task-tracker-store';
import type { PlanImplementation } from '../../../task-plan-trace';
import { planModeForContext } from '../../plan-mode';

export function sessionPlanEngine(chatId: string) {
  const engine = getPlanEngine(chatId);
  if (!engine.hasOpenPlan()) {
    const saved = globalSessionManager.getStateForChat(chatId).executionPlanState;
    if (saved && (saved.status === 'executing' || saved.status === 'proposed')) engine.restore(saved);
  }
  return engine;
}

export async function retireOpenPlan(chatId: string, emit?: (event: any) => void) {
  const plan = sessionPlanEngine(chatId).serialize();
  const tracker = plan ? trackerFromPlan(chatId, plan) : readTaskTracker(chatId)?.data;
  if (!tracker || (tracker.status !== 'proposed' && tracker.status !== 'in_progress')) return;
  const closed = { ...tracker, status: 'stopped' as const, updatedAt: Date.now() };
  emit?.({ ...trackerToTrace(closed), retired: true });
  await writeTaskTrackerState(chatId, closed);
}

export async function beginRequestedImplementation(chatId: string, reference: PlanImplementation, context: any, emit?: (event: any) => void) {
  if (planModeForContext(context)) throw new Error('Switch to Auto to implement the plan.');
  const engine = sessionPlanEngine(chatId);
  let state = engine.serialize();
  // Chat sessions can expire while the proposal is still available in history.
  // Restore only the exact proposal selected in this chat.
  if (!state) {
    const tracker = readTaskTracker(chatId)?.data;
    if (tracker?.status === 'proposed' && tracker.chatId === chatId && tracker.planId === reference.planId
      && tracker.revision === reference.revision && tracker.steps?.length) {
      const { planId, title, document, context: notes, complexity, estimatedMinutes } = tracker;
      engine.loadPlan(tracker.goal, tracker.steps, { planId, title, document, context: notes, complexity, estimatedMinutes }, true);
      state = engine.serialize()!;
      state.createdAt = tracker.createdAt;
      state.updatedAt = tracker.updatedAt || tracker.createdAt;
      state.revision = reference.revision;
      state.steps.forEach((step, index) => {
        const saved = tracker.steps[index];
        if (saved.status === 'done' || saved.status === 'skipped' || saved.status === 'failed') step.status = saved.status;
        step.startedAt = saved.startedAt ?? null;
        step.completedAt = saved.completedAt ?? null;
        step.completionReason = saved.completionReason || null;
        step.completionEvidence = saved.completionEvidence || [];
        step.failureReason = saved.failureReason || null;
      });
      engine.restore(state);
    }
  }
  if (!state || state.planId !== reference.planId || state.revision !== reference.revision || !engine.hasOpenPlan()) {
    throw new Error('This proposal has changed or is no longer available. Open the current plan before starting implementation.');
  }
  if (engine.hasActivePlan()) return;
  const result = engine.executeAction({ type: 'start' });
  if (!result.success) throw new Error(result.message);
  await publishPlan(chatId, engine.serialize()!, emit);
}

export async function publishPlan(chatId: string, state: PlanState, emit: ((event: any) => void) | undefined, generated = false) {
  const tracker = trackerFromPlan(chatId, state);
  globalSessionManager.setExecutionPlanForChat(chatId, state);
  globalSessionManager.setTaskDecomposerUsedForChat(chatId, true);
  globalSessionManager.setTaskPlanForChat(chatId, state.steps.map(step => ({
    name: step.name, description: step.description,
    status: step.status === 'done' || step.status === 'skipped' ? 'done' : 'pending',
  })));
  const phase = generated ? 'generated' : state.status === 'completed' ? 'complete' : state.status === 'failed' ? 'failed' : 'progress';
  emit?.(trackerToTrace(tracker, phase));
  const [files, session] = await Promise.allSettled([
    writeTaskTrackerState(chatId, tracker), globalSessionManager.saveForChat(chatId),
  ]);
  const warnings: string[] = [];
  if (files.status === 'rejected') warnings.push('The tracker files could not be saved.');
  if (session.status === 'rejected') warnings.push('The chat session could not be saved.');
  return { trackerFiles: files.status === 'fulfilled' ? [files.value.mdPath, files.value.jsonPath] : [], warnings };
}
