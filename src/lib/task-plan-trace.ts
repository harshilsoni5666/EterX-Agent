export function taskPlanTraceIdentity(trace: { planId?: unknown; ownerTraceId?: unknown } | null | undefined) {
  const planId = String(trace?.planId || '').trim();
  const ownerTraceId = String(trace?.ownerTraceId || '').trim();
  return planId || (ownerTraceId ? 'task-plan-' + ownerTraceId : '');
}

export type TaskTrackerStep = {
  id?: string;
  step: number;
  name: string;
  description?: string;
  status: 'pending' | 'blocked' | 'in_progress' | 'done' | 'skipped' | 'failed';
  tools?: string[];
  done_when?: string;
  depends_on?: number[];
  step_type?: string;
  expected_output?: string;
  risk?: string;
  artifacts?: string[];
  completionReason?: string | null;
  completionEvidence?: string[];
  failureReason?: string | null;
};

export type TaskTrackerState = {
  text?: string;
  planId?: string;
  ownerTraceId?: string;
  turnId?: string;
  runId?: string;
  title?: string;
  goal?: string;
  document?: string;
  context?: string;
  revision?: number;
  phase?: 'generating' | 'generated' | 'progress' | 'complete' | 'failed';
  status?: 'generating' | 'proposed' | 'in_progress' | 'completed' | 'failed' | 'stopped';
  error?: string;
  complexity?: string;
  estimatedMinutes?: number;
  completedSteps?: number;
  totalSteps?: number;
  activeStepName?: string | null;
  steps?: TaskTrackerStep[];
};

export type PlanImplementation = { planId: string; revision: number };

export function planViewKey(plan: TaskTrackerState): string {
  return taskPlanTraceIdentity(plan) || [plan.turnId || plan.runId || '', plan.goal || 'plan'].join('/');
}

export function planTitle(plan: TaskTrackerState) {
  return plan.title?.trim() || plan.goal?.trim() || 'Task plan';
}

export const planStepLabels: Record<TaskTrackerStep['status'], string> = {
  pending: 'Pending', blocked: 'Waiting on dependencies', in_progress: 'In progress',
  done: 'Done', skipped: 'Skipped', failed: 'Failed',
};

export function planMarkdown(plan: TaskTrackerState): string {
  const parts = ['# ' + planTitle(plan)];
  if (plan.document) parts.push(plan.document);
  else if (plan.title && plan.goal && plan.title !== plan.goal) parts.push(plan.goal);
  if (plan.context) parts.push('## Context', plan.context);
  if (plan.steps?.length) {
    parts.push('## Steps');
    for (const step of plan.steps) {
      const lines = [`${step.step}. **${step.name}**${plan.status === 'proposed' ? '' : ' · ' + planStepLabels[step.status]}`];
      if (step.description && step.description !== step.name) lines.push('   ' + step.description);
      if (step.expected_output && step.expected_output !== step.description && step.expected_output !== step.done_when) lines.push('   Expected outcome — ' + step.expected_output);
      if (step.done_when) lines.push('   Done when ' + step.done_when);
      if (step.depends_on?.length) lines.push('   Depends on ' + step.depends_on.join(', '));
      if (step.completionReason || step.failureReason) lines.push('   ' + (step.completionReason || step.failureReason));
      for (const entry of step.completionEvidence || []) lines.push('   - ' + entry);
      parts.push(lines.join('\n'));
    }
  }
  return parts.join('\n\n');
}
