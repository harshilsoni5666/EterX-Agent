/**
 * Provider-neutral helpers for live model streams.
 *
 * Providers disagree about whether a chunk contains a delta or the complete
 * text seen so far. These helpers make both forms safe to consume together.
 */

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

export function isStreamFinalEvent(event: Record<string, any> | null | undefined): boolean {
  if (!event) return false;
  return (
    event.final === true ||
    event.done === true ||
    event.isStreaming === false ||
    (event.isLiveTyping === false && event.isStreaming !== true) ||
    event.streamState === 'closed' ||
    event.state === 'completed' ||
    event.state === 'failed' ||
    event.status === 'completed' ||
    event.status === 'failed'
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
