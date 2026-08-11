/**
 * Small client-safe concurrency gate for live agent polling.
 *
 * A browser can keep many chats live, but allowing every timer to open a
 * request at the exact same moment causes connection contention and a React
 * update storm. The gate keeps the polling cadence low-latency while making
 * request admission fair and bounded. AbortSignals are intentionally
 * supported so stopping a chat never leaves a waiter stranded in the queue.
 */

export type PollSlotRelease = () => void;

interface PollSlotWaiter {
  signal?: AbortSignal;
  resolve: (release: PollSlotRelease) => void;
  reject: (error: Error) => void;
  settled: boolean;
  onAbort?: () => void;
}
const createAbortError = () => {
  const error = new Error('Polling request was aborted.');
  error.name = 'AbortError';
  return error;
};

export class PollingConcurrencyGate {
  private readonly maxConcurrent: number;
  private inFlight = 0;
  private waiters: PollSlotWaiter[] = [];
  private disposed = false;

  constructor(maxConcurrent = 8) {
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('PollingConcurrencyGate requires a positive maxConcurrent value.');
    }
    this.maxConcurrent = Math.floor(maxConcurrent);
  }

  get stats() {
    return {
      inFlight: this.inFlight,
      queued: this.waiters.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  acquire(signal?: AbortSignal): Promise<PollSlotRelease> {
    if (this.disposed) {
      return Promise.reject(new Error('Polling concurrency gate has been disposed.'));
    }
    if (signal?.aborted) return Promise.reject(createAbortError());

    return new Promise<PollSlotRelease>((resolve, reject) => {
      const waiter: PollSlotWaiter = {
        signal,
        resolve,
        reject,
        settled: false,
      };

      const abort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.waiters = this.waiters.filter(candidate => candidate !== waiter);
        reject(createAbortError());
        this.drain();
      };
      waiter.onAbort = abort;
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('Polling concurrency gate has been disposed.');
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(error);
    }
  }

  private drain() {
    if (this.disposed) return;

    while (this.inFlight < this.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.settled || waiter.signal?.aborted) {
        if (!waiter.settled) {
          waiter.settled = true;
          if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
          waiter.reject(createAbortError());
        }
        continue;
      }

      waiter.settled = true;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.inFlight += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.drain();
      };
      waiter.resolve(release);
    }
  }
}
