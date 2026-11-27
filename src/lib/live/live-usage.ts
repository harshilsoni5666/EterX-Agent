import { appStorage, appStorageReady, isAppStorageLoaded } from '../client-storage';
import { isDesktopTelemetryRenderer, resolveTelemetryEnabled } from '../telemetry/preference';

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

function queueReceipt(key: string, values: Record<string, unknown>) {
  const body = JSON.stringify(values);
  pending.set(key, body);
  try { appStorage.setItem(key, body); } catch { /* Receipt delivery still has the current entry. */ }
  void deliver();
}

type LiveUsageOutcome = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

/** Native realtime connections run in the renderer. Keep pending acknowledgements across a window restart. */
export function recordLiveUsage(
  provider: string, model: string, usage: unknown, id: string = crypto.randomUUID(), outcome: LiveUsageOutcome = 'succeeded',
) {
  queueReceipt(prefix + provider + ':' + id, { provider, model, usage: usage || {}, id, at: Date.now(), outcome });
}

function liveTelemetryEnabled() {
  if (!isAppStorageLoaded()) return false;
  try {
    const settings = JSON.parse(appStorage.getItem('eterx_settings') ?? '{}');
    return resolveTelemetryEnabled(settings.telemetry, isDesktopTelemetryRenderer());
  }
  catch { return false; }
}

export function createLiveSessionTelemetry(provider: string) {
  let current: { id: string; model: string; started: number; resumes: number } | undefined;
  return {
    started(model: string, resumed = false) {
      if (current) {
        if (resumed) current.resumes++;
        return;
      }
      if (!liveTelemetryEnabled()) return;
      const id = crypto.randomUUID();
      current = { id, model, started: performance.now(), resumes: 0 };
      queueReceipt(prefix + id + ':start', { kind: 'session_started', provider, model, id, at: Date.now(), resumed });
    },
    stopped(status: 'closed' | 'failed') {
      const session = current;
      current = undefined;
      if (!session || !liveTelemetryEnabled()) return;
      queueReceipt(prefix + session.id + ':stop', {
        kind: 'session_stopped', provider, model: session.model, id: session.id, at: Date.now(), status,
        durationMs: Math.round(performance.now() - session.started), resumes: session.resumes,
      });
    },
  };
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
