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

/**
 * uiOnly is the explicit provider-neutral presentation contract for the
 * dedicated Thought row. Raw analysis/reasoning remains internal, while the
 * provider's empty open shell is still allowed through so the live lifecycle
 * can be represented before the first reasoning chunk arrives. Rendering code
 * decides whether a closed empty shell should occupy a visible row.
 */
export function isUserVisibleTrace(trace: any): boolean {
  if (!trace || typeof trace !== 'object') return false;
  if (!isPrivateReasoningTrace(trace)) return true;
  const type = String(trace.type || '').trim().toLowerCase();
  return type === 'thought_stream' && trace.uiOnly === true;
}

/** Live and durable feed paths intentionally use the same visibility rule. */
export const isLiveUserVisibleTrace = isUserVisibleTrace;

export function filterUserVisibleTraces<T = any>(traces: T[]): T[] {
  return Array.isArray(traces)
    ? traces.filter(trace => isUserVisibleTrace(trace))
    : [];
}

export function filterLiveUserVisibleTraces<T = any>(traces: T[]): T[] {
  return Array.isArray(traces)
    ? traces.filter(trace => isLiveUserVisibleTrace(trace))
    : [];
}
