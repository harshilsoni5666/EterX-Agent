import { createHash, randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { getEterxDataDir } from '../storage-paths';
import { isComputerUseDisabled } from '../builtin-agent-tool-policy';

export type DesktopActivity = {
  visible: boolean;
  signal?: AbortSignal;
  assertActive: () => Promise<void>;
  openTarget?: (kind: 'url' | 'path', target: string) => Promise<unknown>;
  finish: () => Promise<void>;
};

function desktopError(message: string, reason = 'connection_unavailable'): Error {
  const error = new Error(message);
  error.name = reason === 'user_escape' ? 'ToolCancelledError' : 'DesktopControlError';
  return error;
}

/** Owns the OS overlay and its emergency-stop channel for a desktop session. */
export async function beginDesktopActivity(context: any): Promise<DesktopActivity> {
  const upstream: AbortSignal | undefined = context?.abortSignal || context?.signal;
  upstream?.throwIfAborted();
  const descriptorPath = path.join(getEterxDataDir(), '.temp', 'desktop-control-bridge.json');
  if (!(await fs.pathExists(descriptorPath))) {
    if (process.env.ETERX_DESKTOP_PARENT_PID) throw new Error('Desktop stop controls are unavailable. Reopen the EterX desktop app before controlling the screen.');
    // A standalone web/server deployment has no Electron display surface.
    return { visible: false, signal: upstream, assertActive: async () => { upstream?.throwIfAborted(); }, finish: async () => {} };
  }
  const descriptor = await fs.readJson(descriptorPath);
  if (!Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[a-f0-9]{64}$/.test(String(descriptor.token))) {
    throw new Error('Desktop control connection is unavailable. Reopen the EterX desktop app.');
  }
  const chatId = String(context?.chatId || context?.projectId || 'desktop');
  const runKey = createHash('sha256').update(`${chatId}:${context?.runId || context?.turnId || chatId}`).digest('hex');
  const leaseId = randomUUID();
  const request = async (action: string, timeout = 2000, extra: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({ ...extra, runKey, leaseId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    const result = await response.json();
    if (!response.ok && !result.stopped) throw new Error(result.error || 'Desktop stop controls are unavailable.');
    return result;
  };
  const controller = new AbortController();
  const heartbeatController = new AbortController();
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  let pulsePending: Promise<void> | undefined;
  let lastPulseAt = Date.now();
  let connectionGraceMs = 6000;
  const finish = async () => {
    if (finished) return;
    // Invalidate pending replies BEFORE ending the lease. A late timeout or
    // lease_ended reply must never stop the chat or a newer desktop session.
    finished = true;
    if (timer) clearInterval(timer);
    heartbeatController.abort();
    upstream?.removeEventListener('abort', onUpstreamAbort);
    await request('end').catch(() => {});
  };
  const stop = (reason: string, message: string) => {
    if (finished || controller.signal.aborted) return;
    controller.abort(desktopError(message, reason));
    // A transport failure is a desktop error, never a user stop of the whole
    // chat (which would also cancel browser and coding work).
    if (reason === 'user_escape') {
      void import('../roles/sub_agent').then(({ cancelAgent }) => cancelAgent(chatId)).catch(() => {});
    }
    void finish();
  };
  const onUpstreamAbort = () => stop('task_ended', 'The task ended its desktop session.');
  const checkStop = (result: any) => {
    if (finished) return;
    if (result.stopped) stop(String(result.reason || 'connection_unavailable'), result.message || 'Desktop control connection is unavailable.');
    controller.signal.throwIfAborted();
  };
  const pulse = (): Promise<void> => {
    if (pulsePending) return pulsePending;
    pulsePending = (async () => {
      if (finished) throw desktopError('Desktop activity has ended.', 'lease_ended');
      if (upstream?.aborted || await context?.isCancelled?.() === true) stop('task_ended', 'The task ended its desktop session.');
      if (isComputerUseDisabled()) stop('access_disabled', 'Computer Use was turned off in Settings.');
      controller.signal.throwIfAborted();
      const result = await request('pulse', 2000, {}, heartbeatController.signal);
      if (finished) return;
      checkStop(result);
      lastPulseAt = Date.now();
    })().finally(() => { pulsePending = undefined; });
    return pulsePending;
  };
  try {
    const initial = await request('begin', 25_000, {}, upstream);
    checkStop(initial);
    upstream?.throwIfAborted();
    connectionGraceMs = Math.max(1000, Math.min(6000, Number(initial.leaseTimeoutMs || 15_000) / 2));
    lastPulseAt = Date.now();
    upstream?.addEventListener('abort', onUpstreamAbort, { once: true });
    timer = setInterval(() => {
      if (finished) return;
      void pulse().catch(() => {
        if (!finished && Date.now() - lastPulseAt >= connectionGraceMs) {
          stop('connection_unavailable', 'The desktop activity connection was lost. Native input stopped; reconnect desktop control before continuing.');
        }
      });
    }, 250);
    timer.unref();
  } catch (error) {
    await finish();
    throw error;
  }
  return {
    visible: true,
    signal: upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal,
    assertActive: async () => {
      try { await pulse(); }
      catch (error) {
        controller.signal.throwIfAborted();
        throw desktopError('Desktop stop controls could not be reached. No new input was sent; observe again once the connection is available.');
      }
      if (finished) throw desktopError('Desktop activity has ended.', 'lease_ended');
      controller.signal.throwIfAborted();
    },
    openTarget: async (kind, target) => {
      upstream?.throwIfAborted();
      controller.signal.throwIfAborted();
      const result = await request('open_target', 12_000, { kind, target });
      checkStop(result);
      return result;
    },
    finish,
  };
}
