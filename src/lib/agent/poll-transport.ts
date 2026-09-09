interface PollRequest {
  chatId: string;
  after: number;
  runId?: string;
}

interface PollWaiter {
  after: number;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface Subscription {
  key: string;
  request: PollRequest;
  waiters: Set<PollWaiter>;
  traces: Map<number, any>;
  latest: any;
  version: number;
  deliveredVersion: number;
  touchedAt: number;
  bufferedChars: number;
  replayNeeded: boolean;
  epoch: number;
}

const MAX_SUBSCRIPTIONS = 128;
const MAX_CHANNELS = 2;
const MAX_BUFFERED_TRACES = 4096;
const MAX_BUFFERED_CHARS = 4 * 1024 * 1024;
const abortError = () => new DOMException('Polling request was aborted.', 'AbortError');
const subscriptionKey = (request: PollRequest) => JSON.stringify([request.chatId, request.runId || '']);

/**
 * The HTTP connection streams independently addressed records, not one JSON
 * array that waits for its slowest task. Existing cursor-based consumers can
 * await their own next record while up to 128 chats share one connection.
 * Cursors are acknowledged by the next consumer request, never by receipt on
 * the wire: interrupted UI commits can therefore replay without losing rows.
 */
class LivePollChannel {
  readonly subscriptions = new Map<string, Subscription>();
  private controller: AbortController | null = null;
  private generation = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private bufferedChars = 0;

  reconnect() { this.scheduleReconnect(); }

  private clearBufferedTraces(entry: Subscription) {
    this.bufferedChars = Math.max(0, this.bufferedChars - entry.bufferedChars);
    entry.bufferedChars = 0;
    entry.traces.clear();
  }

  request(request: PollRequest, signal: AbortSignal): Promise<any> {
    if (signal.aborted) return Promise.reject(abortError());
    const key = subscriptionKey(request);
    let entry = this.subscriptions.get(key);
    if (!entry) {
      entry = {
        key, request: { ...request }, waiters: new Set(), traces: new Map(), latest: null,
        version: 0, deliveredVersion: 0, touchedAt: Date.now(), bufferedChars: 0,
        replayNeeded: false, epoch: 0,
      };
      this.subscriptions.set(key, entry);
      this.scheduleReconnect();
    } else if (request.after < entry.request.after || (!request.runId && !entry.waiters.size)) {
      // A recovery reader needs older history. Invalidate records from the
      // previous subscription before reconnecting it at the earlier cursor.
      entry.request.after = request.after;
      this.reset(entry);
      this.scheduleReconnect();
    } else if (!entry.waiters.size) {
      entry.request.after = request.after;
      for (const index of entry.traces.keys()) {
        if (index <= request.after && !(index === -1 && request.after === -1)) entry.traces.delete(index);
      }
      if (!entry.traces.size) this.clearBufferedTraces(entry);
      if (entry.replayNeeded) {
        this.reset(entry);
        this.scheduleReconnect();
      }
    }
    entry.touchedAt = Date.now();
    this.scheduleExpiry();
    if (!this.controller) this.scheduleReconnect();
    const subscription = entry;
    return new Promise((resolve, reject) => {
      const abort = () => {
        subscription.waiters.delete(waiter);
        waiter.cleanup();
        reject(abortError());
        if (!subscription.waiters.size && this.subscriptions.get(key) === subscription) {
          this.clearBufferedTraces(subscription);
          this.subscriptions.delete(key);
          this.scheduleReconnect();
        }
      };
      const waiter: PollWaiter = {
        after: request.after, resolve, reject,
        cleanup: () => signal.removeEventListener('abort', abort),
      };
      signal.addEventListener('abort', abort, { once: true });
      subscription.waiters.add(waiter);
      this.deliver(subscription);
    });
  }

  private reset(entry: Subscription) {
    entry.epoch += 1;
    this.clearBufferedTraces(entry);
    entry.latest = null;
    entry.replayNeeded = false;
    entry.deliveredVersion = entry.version;
  }

  private deliver(entry: Subscription) {
    if (!entry.latest || !entry.waiters.size) return;
    if (entry.version <= entry.deliveredVersion && ![...entry.waiters].some(waiter =>
      [...entry.traces.keys()].some(index => index > waiter.after || (index === -1 && waiter.after === -1)),
    )) return;
    const traces = [...entry.traces].sort(([left], [right]) => left - right);
    for (const waiter of entry.waiters) {
      waiter.cleanup();
      if (entry.latest._pollError) waiter.reject(new Error(entry.latest._pollError));
      else waiter.resolve({
        ...entry.latest,
        // A recovered opening request uses index -1. Preserve it on a full
        // replay even though it does not advance the incremental cursor.
        traces: traces.filter(([index]) => index > waiter.after || (index === -1 && waiter.after === -1))
          .map(([, trace]) => trace),
      });
    }
    entry.waiters.clear();
    entry.deliveredVersion = entry.version;
    entry.touchedAt = Date.now();
  }

  private receive(entry: Subscription, payload: any, chars: number) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid live poll record.');
    if (!payload._pollError && (!Array.isArray(payload.traces) || !Number.isFinite(payload.maxIndex))) {
      throw new Error('Invalid live trace payload.');
    }
    if (entry.replayNeeded) return;
    if (entry.latest && (String(entry.latest.runId || '') !== String(payload.runId || '') ||
      payload.maxIndex < entry.latest.maxIndex)) {
      this.clearBufferedTraces(entry);
    }
    for (const trace of payload.traces || []) {
      // Persisted rows keep their first presentation index while _pollIdx
      // advances with later chunks/settlement. Filtering by the first index
      // drops exactly those updates and can hide the completed answer.
      const index = Number.isFinite(trace?._pollIdx) ? trace._pollIdx : trace?._traceIdx;
      if (Number.isFinite(index) && (index > entry.request.after || (index === -1 && entry.request.after === -1))) {
        entry.traces.set(index, trace);
      }
    }
    const { traces: _traces, ...metadata } = payload;
    entry.latest = metadata;
    entry.bufferedChars += chars;
    this.bufferedChars += chars;
    entry.version += 1;
    this.deliver(entry);
    if (payload._pollError) {
      this.clearBufferedTraces(entry);
      this.subscriptions.delete(entry.key);
      return;
    }
    if (entry.traces.size > MAX_BUFFERED_TRACES || entry.bufferedChars > MAX_BUFFERED_CHARS || this.bufferedChars > 16 * 1024 * 1024) {
      // Bound consumers that stop acknowledging. The server remains the
      // durable owner; resume from the consumer's committed cursor on demand.
      this.clearBufferedTraces(entry);
      entry.latest = null;
      entry.replayNeeded = true;
      entry.epoch += 1;
    }
  }

  private scheduleExpiry() {
    if (this.expiryTimer) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      let changed = false;
      for (const [key, entry] of this.subscriptions) {
        if (!entry.waiters.size && Date.now() - entry.touchedAt >= 2000) {
          this.clearBufferedTraces(entry);
          this.subscriptions.delete(key);
          changed = true;
        }
      }
      if (changed) this.scheduleReconnect();
      if (this.subscriptions.size) this.scheduleExpiry();
    }, 2000);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    // Only subscription changes reconnect HTTP. Token arrivals never do.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, 0);
  }

  private async connect() {
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = null;
    const entries = [...this.subscriptions.values()].filter(entry => !entry.replayNeeded);
    if (!entries.length) return;
    const epochs = entries.map(entry => entry.epoch);
    const controller = new AbortController();
    this.controller = controller;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const dispatch = (index: number, result: any, chars: number) => {
      const entry = entries[index];
      if (!entry || this.generation !== generation || this.subscriptions.get(entry.key) !== entry ||
        entry.epoch !== epochs[index]) return;
      this.receive(entry, result, chars);
    };
    try {
      const response = await fetch('/api/agent/poll', {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ requests: entries.map(entry => ({
          ...entry.request,
          after: Math.min(entry.request.after, ...[...entry.waiters].map(waiter => waiter.after)),
        })) }),
      });
      if (!response.ok) throw new Error(`Poll HTTP ${response.status}`);
      if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
        const payload = await response.json();
        if (!Array.isArray(payload.results) || payload.results.length !== entries.length) {
          throw new Error('Invalid batch poll response.');
        }
        payload.results.forEach((result: any, index: number) => dispatch(index, result, 0));
        return;
      }
      if (!response.body) throw new Error('Live poll stream is unavailable.');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (this.generation === generation && !controller.signal.aborted) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          dispatch(record.index, record.result, line.length);
        }
        if (pending.length > 32 * 1024 * 1024) throw new Error('Live poll record exceeded its buffer limit.');
        if (chunk.done) throw new Error('Live poll connection ended.');
      }
    } catch (error) {
      if (this.generation === generation) {
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const entry of entries) {
          for (const waiter of entry.waiters) { waiter.cleanup(); waiter.reject(failure); }
          entry.waiters.clear();
        }
      }
    } finally {
      void reader?.cancel().catch(() => undefined);
      controller.abort();
      if (this.generation === generation) {
        this.controller = null;
        if ([...this.subscriptions.values()].some(entry => entry.waiters.size)) this.scheduleReconnect();
      }
    }
  }
}

const channels: LivePollChannel[] = [];

export function reconnectAgentPollStreams() {
  channels.forEach(channel => channel.reconnect());
}

export function fetchBatchedAgentPoll(request: PollRequest, signal: AbortSignal): Promise<any> {
  if (signal.aborted) return Promise.reject(abortError());
  const key = subscriptionKey(request);
  let channel = channels.find(candidate => candidate.subscriptions.has(key));
  channel ||= channels.find(candidate => candidate.subscriptions.size < MAX_SUBSCRIPTIONS);
  if (!channel && channels.length < MAX_CHANNELS) {
    channel = new LivePollChannel();
    channels.push(channel);
  }
  if (!channel) return Promise.reject(new Error('Live subscription capacity reached.'));
  return channel.request(request, signal);
}
