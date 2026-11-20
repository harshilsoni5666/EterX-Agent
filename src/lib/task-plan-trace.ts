export function taskPlanTraceIdentity(trace: { planId?: unknown; ownerTraceId?: unknown } | null | undefined) {
  const planId = String(trace?.planId || '').trim();
  const ownerTraceId = String(trace?.ownerTraceId || '').trim();
  return planId || (ownerTraceId ? 'task-plan-' + ownerTraceId : '');
}
