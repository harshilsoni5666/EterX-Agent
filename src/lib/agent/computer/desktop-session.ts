import { randomUUID } from 'crypto';
import { beginDesktopActivity, type DesktopActivity } from './desktop-activity';
import { captureCuaPreview, endCuaSession, executeCuaScreenAction, ensureCuaDriverDaemon, type CuaActionResult } from './cua-driver';
import { monitorEmitter } from '../monitor/emitter';

type DesktopSession = {
  key: string;
  chatId: string;
  runId: string;
  driverId: string;
  activity: DesktopActivity;
  controller: AbortController;
  signal: AbortSignal;
  closed: boolean;
  previewEnabled: boolean;
  previewInFlight: boolean;
  previewTimer?: NodeJS.Timeout;
  previewError?: string;
  frames: number;
  observed: boolean;
  close?: Promise<void>;
};

const shared = globalThis as typeof globalThis & {
  __eterxDesktopSessions?: Map<string, Promise<DesktopSession>>;
  __eterxClosedDesktopRuns?: Map<string, number>;
};
const sessions = shared.__eterxDesktopSessions ||= new Map();
const closedRuns = shared.__eterxClosedDesktopRuns ||= new Map();

function identity(context: any) {
  const chatId = String(context?.chatId || context?.projectId || 'desktop');
  const runId = String(context?.runId || context?.turnId || chatId);
  const ownerId = context?.subAgentId || (context?.isSubAgent ? context?.agentName : '') || 'main';
  return { chatId, runId, key: JSON.stringify([chatId, runId, ownerId]) };
}

async function closeSession(session: DesktopSession): Promise<void> {
  if (session.close) return session.close;
  session.closed = true;
  session.previewEnabled = false;
  if (session.previewTimer) clearTimeout(session.previewTimer);
  session.controller.abort(new Error('Desktop session ended.'));
  session.close = (async () => {
    await session.activity.finish();
    // Each activity owns a unique driver session. Late cleanup from an older
    // task cannot close the new task's window selection or capture state.
    await endCuaSession(session.driverId);
  })().catch(() => {});
  return session.close;
}

function startPreview(session: DesktopSession) {
  if (session.closed || !session.previewEnabled || session.previewTimer || session.previewInFlight) return;
  const tick = async () => {
    session.previewTimer = undefined;
    if (session.closed || !session.previewEnabled) { session.previewTimer = undefined; return; }
    session.previewInFlight = true;
    try {
      const frame = await captureCuaPreview(session.driverId, session.signal);
      if (!session.closed && session.previewEnabled && frame?.vision) {
        session.frames += 1;
        session.previewError = undefined;
        monitorEmitter.desktopScreenshot(frame.vision.inlineData.data, undefined, session.chatId);
      }
    } catch (error: any) {
      if (!session.closed && !session.signal.aborted) {
        const message = String(error?.message || error).slice(0, 400);
        if (session.previewError !== message) console.warn('[computer-use] Preview unavailable:', message);
        session.previewError = message;
      }
    } finally {
      session.previewInFlight = false;
      session.previewTimer = undefined;
      if (!session.closed && session.previewEnabled) startPreview(session);
    }
  };
  session.previewTimer = setTimeout(() => { void tick(); }, 1000);
  session.previewTimer.unref();
}

async function getSession(context: any): Promise<DesktopSession> {
  const owner = identity(context);
  for (const [key, at] of closedRuns) if (Date.now() - at > 24 * 60 * 60_000) closedRuns.delete(key);
  if (closedRuns.has(owner.key)) throw new Error('This task has ended its desktop session. Start a new task to use native control.');
  const current = sessions.get(owner.key);
  if (current) {
    const session = await current;
    if (!session.closed) return session;
    await session.close;
    if (sessions.get(owner.key) === current) sessions.delete(owner.key);
  }
  // Another caller may have opened a session while old cleanup was awaited.
  const opening = sessions.get(owner.key);
  if (opening) return opening;
  const pending = (async () => {
    const driver = await ensureCuaDriverDaemon();
    (context?.abortSignal as AbortSignal | undefined)?.throwIfAborted();
    if (closedRuns.has(owner.key)) throw new Error('The task ended before desktop control started.');
    if (!driver.installed || !driver.daemonRunning) throw new Error(driver.message);
    const activity = await beginDesktopActivity({
      ...context,
      ...owner,
      // A tool request ending is not the end of the agent's desktop session.
      // Run cancellation and explicit cleanup own its lifetime instead.
      abortSignal: context?.runAbortSignal,
      signal: context?.runAbortSignal,
      isCancelled: context?.runIsCancelled,
    });
    const controller = new AbortController();
    const session: DesktopSession = {
      ...owner, driverId: `${owner.chatId}:desktop:${randomUUID()}`, activity, controller,
      signal: activity.signal ? AbortSignal.any([controller.signal, activity.signal]) : controller.signal,
      closed: false, previewEnabled: true, previewInFlight: false, frames: 0, observed: false,
    };
    activity.signal?.addEventListener('abort', () => { void closeSession(session); }, { once: true });
    if (activity.signal?.aborted) { await closeSession(session); activity.signal.throwIfAborted(); }
    if (closedRuns.has(owner.key)) { await closeSession(session); throw new Error('The task ended before desktop control started.'); }
    return session;
  })();
  sessions.set(owner.key, pending);
  try { return await pending; }
  catch (error) { if (sessions.get(owner.key) === pending) sessions.delete(owner.key); throw error; }
}

/** End only native control for this run; browser sessions are independent. */
export async function finishDesktopSession(context: any, endRun = false): Promise<void> {
  const owner = identity(context);
  if (endRun) {
    closedRuns.set(owner.key, Date.now());
    if (closedRuns.size > 2048) closedRuns.delete(closedRuns.keys().next().value!);
  }
  const pending = sessions.get(owner.key);
  if (!pending) return;
  try { await closeSession(await pending); }
  catch { /* Session startup already reported its error to the tool caller. */ }
  finally { if (sessions.get(owner.key) === pending) sessions.delete(owner.key); }
}

export async function desktopSessionStatus(context: any) {
  const pending = sessions.get(identity(context).key);
  if (!pending) return { active: false, preview: false, frames: 0 };
  const session = await pending.catch(() => null);
  return { active: Boolean(session && !session.closed), preview: Boolean(session && !session.closed && session.previewEnabled),
    frames: session?.frames || 0, previewError: session?.previewError };
}

/** A persistent model-driven observe → act → observe loop, using native tools. */
export async function executeDesktopAction(action: string, input: any, context: any): Promise<CuaActionResult & { action: string; desktopSession?: unknown }> {
  let actionResult: CuaActionResult | undefined;
  const response = (result: string, success = false): CuaActionResult & { action: string } => ({
    success, action, result, provider: 'Cua Driver (native desktop)', vision: null, actionStatus: 'not_sent',
  });
  try {
    if (action === 'session_stop') {
      await finishDesktopSession(context);
      return { ...response('Native desktop session ended. Browser control is unchanged.', true), desktopSession: { active: false } };
    }
    if (action === 'stream_stop') {
      const pending = sessions.get(identity(context).key);
      const session = pending ? await pending : null;
      if (session) {
        session.previewEnabled = false;
        if (session.previewTimer) clearTimeout(session.previewTimer);
        session.previewTimer = undefined;
      }
      return response('Desktop preview paused. Use session_stop to end native desktop control.', true);
    }
    const session = await getSession(context);
    await session.activity.assertActive();
    const upstream: AbortSignal | undefined = context?.abortSignal || context?.signal;
    const signal = upstream ? AbortSignal.any([session.signal, upstream]) : session.signal;
    signal.throwIfAborted();
    if (session.activity.visible && action === 'key' && /^(esc|escape)$/i.test(String(input.text || '').trim())) {
      return response('Escape is reserved for the user to stop EterX. Use a named Cancel/Close control, or session_stop to end native control.');
    }
    const driverAction = action === 'session_start' || action === 'stream_start' ? 'see' : action;
    const options = { chatId: session.driverId, signal, openTarget: session.activity.openTarget };
    let result = await executeCuaScreenAction(driverAction, input, options);
    if (!result) return response(`Native desktop action ${action} is unavailable. Use a supported native action; browser control is a separate tool.`);
    actionResult = result;
    if (!session.observed && result.success && !result.vision) {
      // Discovery can be the first call. Include the initial screen alongside
      // its window list instead of making the model start a separate stream.
      const initial = await executeCuaScreenAction('see', {}, options);
      if (initial) result = { ...result, vision: initial.vision, observation: initial.observation,
        ...(!initial.success ? { observationError: String(initial.result), success: result.actionStatus === 'sent' } : {}) };
    }
    if (action === 'stream_start' || action === 'session_start') session.previewEnabled = true;
    if (result.vision) {
      session.observed = true;
      monitorEmitter.desktopScreenshot(result.vision.inlineData.data, undefined, session.chatId);
      startPreview(session);
    }
    if (result.success) monitorEmitter.desktopAction(action, undefined, { provider: result.provider }, session.chatId);
    return { ...result, action, desktopSession: { active: !session.closed, automaticCapture: session.previewEnabled,
      next: 'Inspect the returned screenshot, choose the next action, and call session_stop when desktop work is complete.' } };
  } catch (error: any) {
    return { ...response(String(error?.message || error).slice(0, 700)), actionStatus: actionResult?.actionStatus || 'not_sent' };
  }
}
