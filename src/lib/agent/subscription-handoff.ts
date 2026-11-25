import { clearTimeout, setTimeout } from 'node:timers';

type HandoffMode = 'idle' | 'stop' | 'resume';
type Handoff = {
  id: string;
  mode: HandoffMode;
  released: Promise<void>;
  release: () => void;
  timer: ReturnType<typeof setTimeout>;
};

const runtime = globalThis as typeof globalThis & { __eterxSubscriptionHandoff?: Handoff };

export function beginSubscriptionHandoff(id: string, mode: HandoffMode): boolean {
  if (runtime.__eterxSubscriptionHandoff) return false;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  // Release safe boundaries if the desktop process exits mid-change.
  const timer = setTimeout(() => endSubscriptionHandoff(id), 180_000);
  timer.unref();
  runtime.__eterxSubscriptionHandoff = { id, mode, released, release, timer };
  return true;
}

export function isSubscriptionHandoff(id: string, mode: HandoffMode): boolean {
  return runtime.__eterxSubscriptionHandoff?.id === id && runtime.__eterxSubscriptionHandoff.mode === mode;
}

export function endSubscriptionHandoff(id: string): void {
  const handoff = runtime.__eterxSubscriptionHandoff;
  if (!handoff || handoff.id !== id) return;
  delete runtime.__eterxSubscriptionHandoff;
  clearTimeout(handoff.timer);
  handoff.release();
}

export async function waitForSubscriptionHandoff(signal?: AbortSignal): Promise<void> {
  while (runtime.__eterxSubscriptionHandoff) {
    const { released } = runtime.__eterxSubscriptionHandoff;
    if (signal?.aborted) throw new Error('CANCELLED_BY_USER');
    if (!signal) {
      await released;
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error('CANCELLED_BY_USER'));
      signal.addEventListener('abort', abort, { once: true });
      void released.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
    });
  }
}
