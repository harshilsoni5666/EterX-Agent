import { getNativeFilePath } from './path-utils';

const controlWrites = new Map<string, Promise<boolean>>();
const controlWriteResults = new Map<string, boolean>();

export type ProxyControlSettings = {
  enabled: boolean;
  paused: boolean;
  intervention: 'minimal' | 'normal' | 'high';
  modelSelection: string;
  followChatModel?: boolean;
};

export type ProxyManagerSnapshot = {
  success: boolean;
  messages: Array<{ id: string; role: 'user' | 'proxy'; text: string; requestId?: string; delivery?: string }>;
  processing: boolean;
  control?: ProxyControlSettings & { revision: number };
  context?: { run?: { runId?: string; status?: string }; [key: string]: unknown };
};

export async function readProxyManagerSnapshot(chatId: string): Promise<ProxyManagerSnapshot> {
  await waitForProxyControlWrites(chatId);
  const response = await fetch(`/api/agent/proxy-manager?chatId=${encodeURIComponent(chatId)}`, {
    cache: 'no-store', signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || 'Could not load Proxy messages.');
  return { ...data, messages: Array.isArray(data.messages) ? data.messages : [], processing: data.processing === true };
}

export function hasPendingProxyControlWrites(chatId: string): boolean {
  return controlWrites.has(chatId);
}

// Reads and sends must also join the write queue. Waiting for just the first
// promise misses a second toggle made while the first request was in flight.
export async function waitForProxyControlWrites(chatId: string): Promise<boolean> {
  let success = controlWriteResults.get(chatId) ?? true;
  let pending: Promise<boolean> | undefined;
  while ((pending = controlWrites.get(chatId))) {
    success = await pending;
    if (controlWrites.get(chatId) === pending) controlWrites.delete(chatId);
  }
  return success;
}

export function writeProxyControl(chatId: string, patch: { action: 'enable' | 'disable' | 'pause' | 'resume' | 'intervention' | 'model' | 'configure'; level?: string; modelSelection?: string; followChatModel?: boolean; settings?: ProxyControlSettings }, onError?: (message: string) => void): Promise<boolean> {
  const previous = controlWrites.get(chatId) || Promise.resolve(true);
  const write = previous.catch(() => false).then(async () => {
    try {
      const response = await fetch('/api/agent/proxy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, ...patch }), signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        onError?.(data.error || `Proxy settings could not be saved (${response.status}). Please try again.`);
        return false;
      }
      return true;
    } catch (error) {
      onError?.(error instanceof Error && error.name === 'TimeoutError'
        ? 'Saving Proxy settings timed out. Please try again.'
        : 'Could not reach Proxy. Check the connection and try again.');
      return false;
    }
  });
  controlWrites.set(chatId, write);
  void write.then(success => {
    controlWriteResults.set(chatId, success);
    if (controlWrites.get(chatId) === write) controlWrites.delete(chatId);
  });
  return write;
}

export async function prepareProxyAttachments(attachments: Array<{
  id?: string; file: File; name?: string; localPath?: string; mimeType?: string;
}>) {
  return Promise.all(attachments.map(async attachment => {
    const name = attachment.name || attachment.file.name;
    const id = attachment.id || crypto.randomUUID();
    const localPath = attachment.localPath || getNativeFilePath(attachment.file);
    const mimeType = attachment.mimeType || attachment.file.type || 'application/octet-stream';
    if (localPath) return { id, path: localPath, name, mimeType };
    const form = new FormData();
    form.append('file', attachment.file, name);
    form.append('fileName', name);
    form.append('mimeType', mimeType);
    const response = await fetch('/api/media/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.localPath) throw new Error(data.error || `Could not attach ${name}. Please try again.`);
    return { id, path: String(data.localPath), name, mimeType: String(data.mimeType || mimeType) };
  }));
}

export async function captureProxyScreenshot(): Promise<File> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen capture is unavailable in this window. Attach a screenshot file instead.');
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const frameReady = new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('The selected screen could not be captured.'));
      timeout = setTimeout(() => reject(new Error('Screen capture timed out. Please try again.')), 15_000);
    });
    video.srcObject = stream;
    // loadeddata waits for actual pixels; metadata alone can produce a black image.
    await Promise.all([video.play(), frameReady]);
    if (!video.videoWidth || !video.videoHeight) throw new Error('No screen image was returned.');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the screenshot.');
    context.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not encode the screenshot.')), 'image/png'));
    return new File([blob], `screenshot_${Date.now()}.png`, { type: 'image/png' });
  } finally {
    clearTimeout(timeout);
    stream.getTracks().forEach(track => track.stop());
    video.pause();
    video.onloadeddata = null;
    video.onerror = null;
    video.srcObject = null;
  }
}

async function consumeProxyManagerResponse(response: Response, onProgress: (event: any) => void): Promise<any> {
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(failure.error || 'Proxy Manager request failed.');
  }
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let result: any;
  const processLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'progress' && event.progress) onProgress(event.progress);
    if (event.type === 'complete') result = { success: true, ...event.result, context: event.context };
    if (event.type === 'error') throw new Error(event.error || 'Proxy Manager request failed.');
  };
  try {
    while (!result) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('The side-agent connection was interrupted. Reconnecting to saved progress.')), 60_000);
      });
      const chunk = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timeout));
      buffered += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      const lines = buffered.split('\n');
      buffered = lines.pop() || '';
      lines.forEach(processLine);
      if (chunk.done) {
        if (buffered.trim()) processLine(buffered);
        break;
      }
    }
    if (!result) throw new Error('The side-agent connection ended before a reply arrived. Reconnecting to saved progress.');
    return result;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readProxyManagerResponse(response: Response | Promise<Response>, onProgress: (event: any) => void, recovery?: {
  chatId: string;
  requestId: string;
  onAdmission?: (accepted: boolean) => void;
}): Promise<any> {
  let rejected = false;
  let failure: unknown;
  try {
    const admitted = await response;
    rejected = !admitted.ok;
    recovery?.onAdmission?.(admitted.ok);
    const result = await consumeProxyManagerResponse(admitted, onProgress);
    if (result.message?.delivery === 'unavailable') {
      rejected = true;
      recovery?.onAdmission?.(false);
      throw new Error(result.message.text || 'Proxy could not deliver this request. Please retry.');
    }
    return result;
  } catch (error) {
    if (rejected || !recovery) throw error;
    failure = error;
  }

  // An accepted turn runs independently of its connection. Recover that
  // exact request from its chat's history; never submit a second request.
  onProgress({ type: 'status', text: 'Reconnecting to saved Proxy progress…', phase: 'reconnecting', timestamp: Date.now() });
  const deadline = Date.now() + 180_000;
  let missingReads = 0;
  while (Date.now() < deadline) {
    let snapshot: ProxyManagerSnapshot | undefined;
    try { snapshot = await readProxyManagerSnapshot(recovery.chatId); }
    catch { missingReads = 0; }
    if (snapshot) {
      const replies = snapshot.messages.filter(message => message.role === 'proxy' && message.requestId === recovery.requestId);
      const reply = replies.findLast(message => message.delivery !== 'unavailable');
      if (reply) return {
        success: true, message: reply, history: snapshot.messages, context: snapshot.context,
        wakeRequested: reply.delivery === 'active' || snapshot.context?.run?.status === 'running',
      };
      if (!snapshot.processing && replies.length) {
        recovery.onAdmission?.(false);
        throw new Error(replies[replies.length - 1].text || 'Proxy could not complete this request. Please retry.');
      }
      const admitted = snapshot.messages.some(message => message.requestId === recovery.requestId || message.id === recovery.requestId);
      missingReads = !admitted && !snapshot.processing ? missingReads + 1 : 0;
      if (missingReads >= 2) {
        recovery.onAdmission?.(false);
        throw failure;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw failure;
}
