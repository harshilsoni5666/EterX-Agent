/**
 * Provider-neutral helpers for live model streams.
 *
 * Providers disagree about whether a chunk contains a delta or the complete
 * text seen so far. These helpers make both forms safe to consume together.
 */

const TERMINAL_STREAM_STATES = new Set([
  'completed', 'complete', 'done', 'success', 'failed', 'error',
  'stopped', 'cancelled', 'canceled', 'closed',
]);

export function normalizeStreamTimestamp(
  value: unknown,
  fallback: number = Date.now(),
): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;

  let timestamp = numeric;
  // Seconds, milliseconds, microseconds, and nanoseconds are all found in
  // real provider SDKs and webhook payloads.
  while (timestamp < 10_000_000_000) timestamp *= 1000;
  while (timestamp > 10_000_000_000_000) timestamp /= 1000;
  const now = Date.now();
  const plausible =
    Number.isFinite(timestamp) &&
    timestamp >= Date.UTC(2020, 0, 1) &&
    timestamp <= now + 60_000;
  return plausible ? timestamp : fallback;
}

export function mergeStreamingText(
  previousValue: unknown,
  incomingValue: unknown,
  isDelta: boolean = false,
): string {
  const previous = String(previousValue ?? '');
  const incoming = String(incomingValue ?? '');

  if (!incoming) return previous;
  if (!previous || previous === incoming) return previous || incoming;

  // A surprising number of OpenAI-compatible endpoints mark snapshots as
  // deltas. Prefix checks make those snapshots idempotent and also ignore a
  // late, shorter snapshot that would otherwise roll the UI backwards.
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;

  if (!isDelta) return incoming;

  // A real delta may legitimately begin with the same character that ended
  // the previous delta ("hel" + "lo"), so never remove arbitrary overlap.
  // Prefix snapshots were handled above; everything else is a genuine append.
  return previous + incoming;
}

/**
 * Merge narration that has already been painted into the activity feed.
 *
 * Some providers finish a streamed work note with a shorter summary snapshot.
 * Replacing the live value makes words visibly disappear just as the following
 * action arrives. Once narration is visible, keep the more complete snapshot;
 * real deltas still append through the provider-neutral stream merger above.
 */
export function mergeVisibleNarrativeText(
  previousValue: unknown,
  incomingValue: unknown,
  isDelta: boolean = false,
): string {
  const previous = String(previousValue ?? '');
  const incoming = String(incomingValue ?? '');

  if (isDelta) return mergeStreamingText(previous, incoming, true);
  if (!incoming) return previous;
  if (!previous || previous === incoming) return previous || incoming;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;
  return incoming.length >= previous.length ? incoming : previous;
}

export function isStreamFinalEvent(event: Record<string, any> | null | undefined): boolean {
  if (!event) return false;
  const state = String(event.state || '').trim().toLowerCase();
  const status = String(event.status || '').trim().toLowerCase();
  return (
    event.final === true ||
    event.done === true ||
    event.isStreaming === false ||
    (event.isLiveTyping === false && event.isStreaming !== true) ||
    event.streamState === 'closed' ||
    TERMINAL_STREAM_STATES.has(state) ||
    TERMINAL_STREAM_STATES.has(status)
  );
}

export function extractProviderText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => extractProviderText(item)).join('');
  }
  if (!value || typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'value', 'output_text', 'outputText']) {
    if (record[key] !== undefined && record[key] !== null) {
      const text = extractProviderText(record[key]);
      if (text) return text;
    }
  }
  return '';
}
