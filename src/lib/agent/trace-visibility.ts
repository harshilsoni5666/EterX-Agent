const PRIVATE_REASONING_TYPES = new Set([
  'analysis',
  'reasoning',
  'thinking',
  'thought_stream',
]);

/**
 * Native model reasoning is execution data, not conversation content.
 * Keep this provider-neutral so every model family follows the same privacy
 * boundary before traces reach the browser or a restored chat transcript.
 */
export function isPrivateReasoningTrace(trace: any): boolean {
  if (!trace || typeof trace !== 'object') return false;
  const type = String(trace.type || '').trim().toLowerCase();
  const visibility = String(trace.visibility || trace.audience || '').trim().toLowerCase();
  return PRIVATE_REASONING_TYPES.has(type)
    || visibility === 'internal'
    || trace.privateReasoning === true
    || trace.nativeReasoning === true;
}

export function filterUserVisibleTraces<T = any>(traces: T[]): T[] {
  return Array.isArray(traces)
    ? traces.filter(trace => !isPrivateReasoningTrace(trace))
    : [];
}
