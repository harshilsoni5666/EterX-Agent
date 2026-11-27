import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { previewKeys, type PreviewAction, type PreviewJob, type PreviewResult } from './contracts';
import { hasWorkbenchListeners, notifyWorkbench } from './events';

const fraction = z.number().min(0).max(1);
export const previewActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status') }),
  z.object({ kind: z.literal('snapshot') }),
  z.object({ kind: z.literal('reload') }),
  z.object({ kind: z.literal('navigate'), url: z.string().min(1).max(2048) }),
  z.object({ kind: z.literal('click'), x: fraction, y: fraction }),
  z.object({ kind: z.literal('scroll'), x: fraction, y: fraction, deltaY: z.number().int().min(-1600).max(1600) }),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(600).refine(text => !text.includes('\0')) }),
  z.object({ kind: z.literal('key'), key: z.enum(previewKeys) }),
]);

export const previewResultSchema = z.object({
  success: z.boolean(),
  error: z.string().max(1200).optional(),
  url: z.string().max(4096).optional(),
  title: z.string().max(500).optional(),
  loading: z.boolean().optional(),
  actionStatus: z.literal('sent').optional(),
  vision: z.object({ inlineData: z.object({ data: z.string().min(32).max(780_000).regex(/^[a-z0-9+/=]+$/i), mimeType: z.literal('image/jpeg') }) }).optional(),
});

type Pending = { job: PreviewJob; claim?: string; finish: (result: PreviewResult) => void };
const host = globalThis as typeof globalThis & { __eterxPreviewJobs?: Map<string, Pending> };
const pending = host.__eterxPreviewJobs ??= new Map();

export function currentPreviewJob(chatId: string) {
  const current = pending.get(chatId);
  return current && !current.claim ? current.job.id : undefined;
}

export function queuePreviewJob(chatId: string, action: PreviewAction, signal?: AbortSignal): Promise<PreviewResult> {
  if (signal?.aborted) return Promise.resolve({ success: false, error: 'Preview action cancelled.' });
  if (pending.has(chatId)) return Promise.resolve({ success: false, error: 'Wait for the current preview action to settle.' });
  if (!hasWorkbenchListeners(chatId)) return Promise.resolve({ success: false, error: 'Open this chat and its local browser preview in EterX Desktop first.' });
  return new Promise(resolve => {
    const job = { id: randomUUID(), action };
    const finish = (result: PreviewResult) => {
      if (pending.get(chatId)?.job.id !== job.id) return;
      pending.delete(chatId);
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = () => finish({ success: false, error: 'Preview action cancelled. Observe the current tab before retrying.' });
    const timer = setTimeout(() => finish({ success: false, error: 'No reply from the live preview. If input was sent, observe the tab before retrying.' }), 10_000);
    pending.set(chatId, { job, finish });
    signal?.addEventListener('abort', cancel, { once: true });
    notifyWorkbench(chatId);
  });
}

export function claimPreviewJob(chatId: string, id: string) {
  const active = pending.get(chatId);
  if (!active || active.job.id !== id || active.claim) return null;
  active.claim = randomUUID();
  return { job: active.job, claim: active.claim };
}

export function finishPreviewJob(chatId: string, id: string, claim: string, result: PreviewResult) {
  const active = pending.get(chatId);
  if (!active || active.job.id !== id || !active.claim || active.claim !== claim) return false;
  active.finish(result);
  return true;
}
