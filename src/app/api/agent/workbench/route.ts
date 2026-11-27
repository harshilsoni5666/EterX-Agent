import { NextRequest, NextResponse } from 'next/server';
import { attachAgentApiSessionCookie, getOrCreateAgentApiSession, isSafeChatId, jsonError, readJsonObject, rejectCrossOrigin, requireChatOwner } from '../_shared';
import { localWorkbenchUrl, type WorkbenchTarget } from '@/lib/workbench/contracts';
import { captureWorkbenchDevice, deviceInputSchema, installWorkbenchDeviceApp, launchWorkbenchDeviceApp, listWorkbenchDevices, openNativeSimulator, resolveWorkbenchDevice, sendWorkbenchDeviceInput, startWorkbenchDevice, stopWorkbenchDevice } from '@/lib/workbench/devices';
import { streamDeviceVideo } from '@/lib/workbench/device-video-server';
import { forgetWorkbenchTarget, publishWorkbenchTarget, readWorkbench, setWorkbenchDevice, setWorkbenchMachine, subscribeWorkbench } from '@/lib/workbench/events';
import { callWorkbenchApi, checkWorkbenchService, desktopWorkbenchEnabled, readProjectScripts, runProjectScript, workbenchActivity } from '@/lib/workbench/server';
import { claimPreviewJob, currentPreviewJob, finishPreviewJob, previewResultSchema } from '@/lib/workbench/preview-jobs';
import { countRunningTerminalTasks } from '@/lib/agent/tools/core/terminal_background';
import { listLocalMachines, startLocalMachine } from '@/lib/workbench/virtual-machines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noCache = { 'Cache-Control': 'no-store' };

function eventStream(chatId: string, signal: AbortSignal) {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let pending: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      function send(message: string) {
        if (closed) return;
        try { controller.enqueue(encoder.encode(message)); }
        catch { close(); }
      }
      const current = () => {
        pending = undefined;
        send('data: ' + JSON.stringify({ focus: readWorkbench(chatId).focus, running: countRunningTerminalTasks(chatId), previewJobId: currentPreviewJob(chatId) }) + '\n\n');
      };
      const unsubscribe = subscribeWorkbench(chatId, () => {
        if (!pending) pending = setTimeout(current, 160);
      });
      const heartbeat = setInterval(() => send(': heartbeat\n\n'), 20_000);
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(pending);
        unsubscribe();
        signal.removeEventListener('abort', close);
        try { controller.close(); } catch { /* The renderer already disconnected. */ }
      }
      cleanup = close;
      signal.addEventListener('abort', close, { once: true });
      if (signal.aborted) close();
      else current();
    },
    cancel() { cleanup?.(); },
  });
  return new Response(stream, {
    headers: { ...noCache, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' },
  });
}

function authorize(req: NextRequest, chatId: unknown) {
  const origin = rejectCrossOrigin(req);
  const site = req.headers.get('sec-fetch-site');
  if (origin || (site && site !== 'same-origin' && site !== 'none')) {
    return { error: origin || jsonError('Workbench requests must come from this EterX window.', 403) };
  }
  if (!isSafeChatId(chatId)) return { error: jsonError('A valid chat ID is required.') };
  const session = getOrCreateAgentApiSession(req);
  const error = requireChatOwner(chatId, session.sessionId);
  if (error) return { error: attachAgentApiSessionCookie(error, session) };
  return { chatId, respond: <T extends Response>(response: T) => attachAgentApiSessionCookie(response, session) };
}

function isDesktopRequest(req: NextRequest) {
  return desktopWorkbenchEnabled() && ['localhost', '127.0.0.1', '[::1]'].includes(req.nextUrl.hostname);
}

const json = (data: object) => NextResponse.json(data, { headers: noCache });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams;
  const auth = authorize(req, search.get('chatId'));
  if ('error' in auth) return auth.error!;
  const { chatId, respond } = auth;
  const view = search.get('view') || 'activity';
  try {
    if (view === 'events') return respond(eventStream(chatId, req.signal));
    if (view === 'activity') return respond(json({ ...await workbenchActivity(chatId), desktop: isDesktopRequest(req) }));
    if (!isDesktopRequest(req)) return respond(jsonError('Open EterX Desktop on the development host to use local runtimes.', 403));
    if (view === 'scripts') return respond(json({ scripts: await readProjectScripts(search.get('root') || '') }));
    if (view === 'devices') return respond(json(await listWorkbenchDevices(search.get('refresh') === '1', search.get('local') === '1')));
    if (view === 'machines') return respond(json(await listLocalMachines()));
    if (view === 'runtime') {
      const { deviceId, machine: selectedMachine } = readWorkbench(chatId);
      const [device, machine] = await Promise.all([
        deviceId ? resolveWorkbenchDevice(deviceId).catch(() => null) : null,
        selectedMachine ? listLocalMachines().then(result => result.machines.find(item => item.id === selectedMachine.id) || null, () => null) : null,
      ]);
      return respond(json({ device, machine }));
    }
    if (view === 'frame' || view === 'device-video') {
      const active = readWorkbench(chatId).deviceId;
      if (!active || active !== search.get('deviceId')) return respond(jsonError('Select this device in the chat to view it.', 409));
      if (view === 'device-video') {
        const video = await streamDeviceVideo(active, req.signal);
        return respond(new Response(video, { headers: { ...noCache, 'Content-Type': 'application/octet-stream', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' } }));
      }
      const frame = await captureWorkbenchDevice(active);
      return respond(new Response(new Uint8Array(frame.png), { headers: { ...noCache, 'Content-Type': 'image/png' } }));
    }
    return respond(jsonError('Unknown workbench view.', 404));
  } catch (error) {
    return respond(jsonError(message(error)));
  }
}

export async function POST(req: NextRequest) {
  const mime = req.headers.get('content-type') || '';
  if (!/^application\/json(?:;|$)/i.test(mime)) return jsonError('Send a JSON workbench request.', 415);
  if (Number(req.headers.get('content-length')) > 1_000_000) return jsonError('Workbench request is too large.', 413);
  const body = await readJsonObject(req);
  const auth = authorize(req, body.chatId);
  if ('error' in auth) return auth.error!;
  const { chatId, respond } = auth;
  try {
    if (body.action === 'publish' || body.action === 'forget') {
      const url = localWorkbenchUrl(typeof body.url === 'string' ? body.url : '').href;
      if (body.action === 'forget') forgetWorkbenchTarget(chatId, url);
      else {
        const target: WorkbenchTarget = { url, kind: body.kind === 'api' ? 'api' : 'web', label: typeof body.label === 'string' ? body.label.trim().slice(0, 90) : undefined };
        publishWorkbenchTarget(chatId, target, false);
      }
      return respond(json({ success: true }));
    }
    if (!isDesktopRequest(req)) return respond(jsonError('Open EterX Desktop on the development host to use local runtimes.', 403));
    switch (body.action) {
      case 'claim-preview':
        return respond(json(claimPreviewJob(chatId, body.id) || { job: null }));
      case 'finish-preview': {
        const result = previewResultSchema.safeParse(body.result);
        if (!result.success) return respond(jsonError('Invalid browser preview result.'));
        return respond(json({ success: finishPreviewJob(chatId, body.id, body.claim, result.data) }));
      }
      case 'run-script':
        return respond(json({ taskId: await runProjectScript(chatId, body.root, body.name) }));
      case 'start-machine':
        setWorkbenchMachine(chatId, await startLocalMachine(body.machineId));
        return respond(json({ success: true }));
      case 'check-service':
        return respond(json(await checkWorkbenchService(body.url, req.url, req.signal)));
      case 'api-call': {
        const { url, method, headers, body: requestBody }: Record<string, unknown> = body;
        if (typeof url !== 'string' || typeof method !== 'string' ||
          (headers != null && typeof headers !== 'string') ||
          (requestBody != null && typeof requestBody !== 'string')) {
          return respond(jsonError('An API request requires a URL and method. Headers and body must be text when provided.'));
        }
        return respond(json(await callWorkbenchApi({
          url, method, headers: headers ?? undefined, body: requestBody ?? undefined,
        }, req.url, req.signal)));
      }
      case 'select-device': {
        if (body.deviceId === null) {
          setWorkbenchDevice(chatId);
          return respond(json({ success: true }));
        }
        const device = await resolveWorkbenchDevice(body.deviceId);
        setWorkbenchDevice(chatId, device);
        return respond(json({ success: true }));
      }
      case 'start-device':
      case 'stop-device':
      case 'open-simulator':
      case 'device-input':
      case 'install-app':
      case 'launch-app': {
        const active = readWorkbench(chatId).deviceId;
        if (!active || active !== body.deviceId) return respond(jsonError('Select this device in the chat first.', 409));
        if (body.action === 'start-device') await startWorkbenchDevice(active);
        if (body.action === 'stop-device') await stopWorkbenchDevice(active);
        if (body.action === 'open-simulator') await openNativeSimulator(active);
        if (body.action === 'device-input') {
          const input = deviceInputSchema.safeParse(body.input);
          if (!input.success) return respond(jsonError('Invalid device input.'));
          await sendWorkbenchDeviceInput(active, input.data);
        }
        if (body.action === 'install-app') {
          const appId = await installWorkbenchDeviceApp(active, typeof body.artifact === 'string' ? body.artifact : '');
          return respond(json({ success: true, appId }));
        }
        if (body.action === 'launch-app') await launchWorkbenchDeviceApp(active, typeof body.appId === 'string' ? body.appId : '');
        return respond(json({ success: true }));
      }
      default:
        return respond(jsonError('Unknown workbench action.', 404));
    }
  } catch (error) {
    return respond(jsonError(message(error)));
  }
}
