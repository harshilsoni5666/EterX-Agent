import { createHash, type Hash } from 'node:crypto';

/** Digests are advisory progress evidence, never a cache or execution veto. */
export interface ObservationStamp {
  readonly key: string;
  readonly digest: string;
}

const PRESENTATION_ARGUMENTS = new Set(['uiActionText', 'uiIcon']);
const TRANSPORT_FIELDS = new Set([
  '_consoleTraceEmitted', 'streamId', 'traceId', 'ownerTraceId',
  'durationMs', 'elapsedMs', 'executionTimeMs', 'latencyMs',
]);
const TERMINAL_ENVELOPE_FIELDS = new Set([
  ...TRANSPORT_FIELDS,
  'taskId', 'backgroundTaskId', 'processId', 'timestamp', 'startTime', 'endTime',
  'startedAt', 'completedAt', 'nextActionNote',
]);

/** Hash complete content incrementally; do not copy large source reads. */
function hashValue(
  hash: Hash,
  value: unknown,
  ancestors: Set<object>,
  ignoredKeys?: Set<string>,
  terminalEnvelope = false,
): void {
  if (value === null || typeof value !== 'object') {
    const text = typeof value === 'string' ? value : String(value);
    hash.update(`${typeof value}:${text.length}:`).update(text);
    return;
  }
  if (ancestors.has(value)) throw new Error('Cyclic observation');
  if (value instanceof Date) {
    hash.update(`date:${value.toISOString()};`);
    return;
  }
  if (value instanceof Uint8Array) {
    hash.update(`bytes:${value.byteLength}:`).update(value);
    return;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    hash.update(`array:${value.length}:[`);
    for (const item of value) hashValue(hash, item, ancestors, ignoredKeys, terminalEnvelope);
    hash.update(']');
  } else {
    hash.update('object:{');
    for (const key of Object.keys(value).sort()) {
      if (ignoredKeys?.has(key)) continue;
      hash.update(`${key.length}:${key}=`);
      // Strip metadata only from known terminal result envelopes. Fields in
      // source content, documents, search hits, or API data remain significant.
      const nestedEnvelope = terminalEnvelope && (key === 'result' || key === 'results');
      hashValue(hash, (value as Record<string, unknown>)[key], ancestors,
        nestedEnvelope ? TERMINAL_ENVELOPE_FIELDS : undefined, nestedEnvelope);
    }
    hash.update('}');
  }
  ancestors.delete(value);
}

export function stampObservation(
  toolName: string,
  args: Record<string, any>,
  result: unknown,
): ObservationStamp | undefined {
  try {
    const name = toolName.trim().toLowerCase();
    const identity = createHash('sha256').update(`${name}:`);
    hashValue(identity, args, new Set(), PRESENTATION_ARGUMENTS);
    const content = createHash('sha256');
    const terminal = name === 'workspace_run_command';
    hashValue(content, result, new Set(), terminal ? TERMINAL_ENVELOPE_FIELDS : TRANSPORT_FIELDS, terminal);
    return { key: identity.digest('hex'), digest: content.digest('hex') };
  } catch {
    // An unusual tool payload must never interrupt execution or lose evidence.
    return undefined;
  }
}

/** Bounded per-run history; retry snapshots restore the same novelty baseline. */
export class ObservationProgressTracker {
  private readonly recent = new Map<string, { digest: string; epoch: number }>();

  constructor(history: Iterable<{ observation?: ObservationStamp; mutationEpoch: number }> = []) {
    for (const entry of history) {
      if (entry.observation) this.record(entry.observation, entry.mutationEpoch);
    }
  }

  record(stamp: ObservationStamp | undefined, epoch: number): boolean {
    if (!stamp) return true;
    const previous = this.recent.get(stamp.key);
    const changed = !previous || previous.epoch !== epoch || previous.digest !== stamp.digest;
    this.recent.delete(stamp.key);
    this.recent.set(stamp.key, { digest: stamp.digest, epoch });
    if (this.recent.size > 128) this.recent.delete(this.recent.keys().next().value!);
    return changed;
  }
}
