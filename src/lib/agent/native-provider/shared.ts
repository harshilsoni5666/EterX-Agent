import { open } from 'node:fs/promises';
import path from 'node:path';
import { normalizeAttachmentMime } from '../attachment-pipeline';
import { normalizeModelThinkingCapabilities, type MainAgentThinkingLevel } from '../model-routing';
import { requestToolApproval } from '../tool-approval-runtime';
import type { NativeProvider } from '../../native-provider-contract';
import type { NativeAttachment, NativeTurn } from './types';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const levelNames: Partial<Record<string, MainAgentThinkingLevel>> = {
  off: 'off', none: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
  xhigh: 'xhigh', 'extra-high': 'xhigh', max: 'max',
};

export function effortOptions(provider: NativeProvider, modelId: string, values: string[], fallback?: string) {
  const wireValues: Partial<Record<MainAgentThinkingLevel, string>> = {};
  for (const value of values) {
    const level = Object.hasOwn(levelNames, value) ? levelNames[value] : undefined;
    if (level) wireValues[level] = value;
  }
  return normalizeModelThinkingCapabilities({
    provider, modelId, source: 'provider', kind: 'effort',
    levels: Object.keys(wireValues), wireValues, defaultLevel: fallback && levelNames[fallback],
  }) ?? undefined;
}

export async function readNativeAttachment(file: NativeAttachment) {
  const name = file.name || path.basename(file.path || 'attachment');
  const mimeType = normalizeAttachmentMime(name, file.mimeType);
  const inline = typeof file.inlineData === 'string' ? file.inlineData : file.inlineData?.data;
  const data = (file.data || inline || '').replace(/^data:[^,]+,/, '');
  if (data && Buffer.byteLength(data, 'base64') <= MAX_FILE_BYTES) {
    return { name, mimeType, bytes: Buffer.from(data, 'base64') };
  }
  if (data || !file.path || !path.isAbsolute(file.path)) throw new Error('Unable to read the attachment ' + name + '.');
  const handle = await open(file.path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('The attachment ' + name + ' exceeds the input size limit.');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes);
    if (bytesRead > stat.size) throw new Error('The attachment ' + name + ' changed while it was read.');
    return { name, mimeType, bytes: bytes.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

export const isInlineText = (mime: string) => /^(?:text\/|application\/(?:json|xml|javascript|yaml|typescript)$)/.test(mime);
export const isInlineImage = (mime: string) => /^image\/(png|jpeg|gif|webp)$/.test(mime);

export async function nativeApproval(turn: NativeTurn, tool: string, args: Record<string, unknown>, label: string) {
  if (!turn.context || turn.signal.aborted) return false;
  return !await requestToolApproval(tool, args, { ...turn.context, abortSignal: turn.signal }, { label, requireScope: true });
}

export function sanitizedCounts(counts: Record<string, unknown>) {
  const result = Object.fromEntries(Object.entries(counts).filter(([, value]) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0));
  return Object.keys(result).length ? result : undefined;
}

export function trustedLoginUrl(raw: string, hosts: readonly string[]) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password &&
      hosts.includes(url.hostname) && url.href.length <= 8192) return url.href;
  } catch { /* Provider may print other text before the sign-in URL. */ }
}

export async function waitForNative<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    signal.throwIfAborted();
  }
  let abort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
