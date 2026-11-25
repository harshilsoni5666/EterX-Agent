import { appStorage, appStorageReady } from '../client-storage';

const prefix = 'eterx_pending_live_receipt:';
const pending = new Map<string, string>();
let sending = false;
let retry: ReturnType<typeof setTimeout> | undefined;

async function deliver() {
  if (sending || retry || !pending.size) return;
  sending = true;
  try {
    for (const [key, body] of pending) {
      const response = await fetch('/api/usage/live', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, keepalive: true, signal: AbortSignal.timeout(10_000) });
      if (!response.ok && response.status !== 400) throw new Error('Receipt delivery interrupted.');
      pending.delete(key);
      appStorage.removeItem(key);
    }
  } catch {
    retry = setTimeout(() => { retry = undefined; void deliver(); }, 10_000);
  } finally { sending = false; }
}

/** Native realtime connections run in the renderer. Keep pending acknowledgements across a window restart. */
export function recordLiveUsage(provider: string, model: string, usage: unknown, id: string = crypto.randomUUID()) {
  const key = prefix + provider + ':' + id;
  const body = JSON.stringify({ provider, model, usage: usage || {}, id, at: Date.now() });
  pending.set(key, body);
  appStorage.setItem(key, body);
  void deliver();
}

if (typeof window !== 'undefined') {
  void appStorageReady.then(() => {
    for (let i = 0; i < appStorage.length; i++) {
      const key = appStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const body = appStorage.getItem(key);
      if (body) pending.set(key, body);
    }
    void deliver();
  });
}
