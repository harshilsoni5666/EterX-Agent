import { createHash, randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { getEterxDataDir } from '../storage-paths';
import { isComputerUseDisabled } from '../builtin-agent-tool-policy';

export type DesktopActivity = {
  visible: boolean;
  signal?: AbortSignal;
  openTarget?: (kind: 'url' | 'path', target: string) => Promise<unknown>;
  finish: () => Promise<void>;
};

/** Owns the OS overlay and its emergency-stop channel for one desktop call. */
export async function beginDesktopActivity(context: any): Promise<DesktopActivity> {
  const upstream: AbortSignal | undefined = context?.abortSignal || context?.signal;
  upstream?.throwIfAborted();
  const descriptorPath = path.join(getEterxDataDir(), '.temp', 'desktop-control-bridge.json');
  if (!(await fs.pathExists(descriptorPath))) {
    if (process.env.ETERX_DESKTOP_PARENT_PID) throw new Error('Desktop stop controls are unavailable. Reopen the EterX desktop app before controlling the screen.');
    // A standalone web/server deployment has no Electron display surface.
    return { visible: false, signal: upstream, finish: async () => {} };
  }
  const descriptor = await fs.readJson(descriptorPath);
  if (!Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[a-f0-9]{64}$/.test(String(descriptor.token))) {
    throw new Error('Desktop control connection is unavailable. Reopen the EterX desktop app.');
  }
  const chatId = String(context?.chatId || context?.projectId || 'desktop');
  const runKey = createHash('sha256').update(`${chatId}:${context?.runId || context?.turnId || chatId}`).digest('hex');
  const leaseId = randomUUID();
  const request = async (action: string, timeout = 2000, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({ ...extra, runKey, leaseId }), signal: AbortSignal.timeout(timeout),
    });
    const result = await response.json();
    if (!response.ok && !result.stopped) throw new Error(result.error || 'Desktop stop controls are unavailable.');
    return result;
  };
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort(new Error('CANCELLED_BY_USER'));
    void import('../roles/sub_agent').then(({ cancelAgent }) => cancelAgent(chatId)).catch(() => {});
    void import('./live-stream').then(({ stopLiveStream }) => stopLiveStream(chatId)).catch(() => {});
    void import('./cua-driver').then(({ endCuaSession }) => endCuaSession(chatId)).catch(() => {});
  };
  const initial = await request('begin', 8000);
  if (initial.stopped) { cancel(); throw new Error('CANCELLED_BY_USER: Computer use was stopped with Escape.'); }
  let finished = false;
  let polling = false;
  const timer = setInterval(async () => {
    if (finished || polling) return;
    polling = true;
    try {
      if (upstream?.aborted || context?.isCancelled?.() || isComputerUseDisabled() || (await request('pulse')).stopped) cancel();
    } catch { cancel(); } finally { polling = false; }
  }, 200);
  timer.unref();
  return {
    visible: true,
    signal: upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal,
    openTarget: async (kind, target) => {
      upstream?.throwIfAborted();
      controller.signal.throwIfAborted();
      const result = await request('open_target', 12_000, { kind, target });
      if (result.stopped) { cancel(); throw new Error('CANCELLED_BY_USER'); }
      return result;
    },
    finish: async () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      await request('end').catch(() => {});
    },
  };
}
