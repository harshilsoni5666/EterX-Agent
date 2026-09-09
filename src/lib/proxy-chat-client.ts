import { getNativeFilePath } from './path-utils';

const controlWrites = new Map<string, Promise<boolean>>();

export function writeProxyControl(chatId: string, patch: { action: 'enable' | 'disable' | 'pause' | 'resume' | 'intervention' | 'model'; level?: string; modelSelection?: string }, onError?: (message: string) => void): Promise<boolean> {
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
  void write.finally(() => { if (controlWrites.get(chatId) === write) controlWrites.delete(chatId); });
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

export async function readProxyManagerResponse(response: Response, onProgress: (event: any) => void): Promise<any> {
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
