export type TerminalLifecycleInput = {
  preview?: any;
  result?: any;
  log?: any;
  isLiveChip?: boolean;
  exitCode?: number;
  hasResult?: boolean;
};

function explicitLifecycleState(value: any): 'running' | 'settled' | null {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.exitCode === 'number' || typeof value.code === 'number') return 'settled';
  if (value.isStreaming === false || value.running === false || value.stillRunning === false) return 'settled';
  if (value.status && value.status !== 'running') return 'settled';
  if (value.isStreaming === true || value.running === true || value.stillRunning === true || value.status === 'running') {
    return 'running';
  }
  return null;
}

/**
 * Resolve terminal state newest-first. A settled console snapshot must beat
 * the older command card's `isLive`/`isStreaming` flag during poll hydration.
 */
export function isTerminalTraceStreaming(input: TerminalLifecycleInput): boolean {
  for (const source of [input.preview, input.result, input.log]) {
    const state = explicitLifecycleState(source);
    if (state) return state === 'running';
  }

  if (input.exitCode !== undefined || input.hasResult) return false;
  return input.isLiveChip === true;
}

