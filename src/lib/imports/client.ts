'use client';
import { useEffect } from 'react';
import { requestJson } from '../request-json';
import type { ImportJob, ImportReport, ImportStatus } from './types';

export const IMPORT_UPDATED_EVENT = 'eterx_imports_updated';
async function readImportResponse<T>(response: Pick<Response, 'ok' | 'status' | 'json'>): Promise<T> {
  const invalidResponse = () => new Error(`The import service returned an invalid response (HTTP ${response.status}). Restart EterX and try again. If this continues, update EterX.`);
  let data: unknown;
  try { data = await response.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw invalidResponse();
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidResponse();
  if (!response.ok) {
    const error = (data as { error?: unknown }).error;
    throw new Error(typeof error === 'string' && error.trim() ? error : `Import request failed (HTTP ${response.status}). Try again.`);
  }
  return data as T;
}

export async function importRequest<T = any>(body?: unknown, signal?: AbortSignal): Promise<T> {
  const upload = typeof FormData !== 'undefined' && body instanceof FormData;
  const response = await requestJson('/api/imports', body === undefined ? { cache: 'no-store', signal } : {
    method: 'POST', signal,
    ...(upload ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }, 120_000);
  return readImportResponse<T>(response);
}
export async function waitForImportJob(job: ImportJob, onProgress?: (job: ImportJob) => void, signal?: AbortSignal): Promise<ImportJob> {
  let current = job;
  while (current.status === 'running') {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress?.(current);
    await new Promise<void>(resolve => setTimeout(resolve, 900));
    const response = await requestJson(`/api/imports?job=${encodeURIComponent(job.id)}`, { cache: 'no-store', signal }, 20_000);
    const data = await readImportResponse<{ job?: ImportJob }>(response);
    if (!data.job) throw new Error('Could not load import progress. Try again.');
    current = data.job;
  }
  onProgress?.(current);
  if (current.status === 'failed') throw new Error(current.error || 'Import failed.');
  return current;
}
export function notifyImportChange(report?: ImportReport) {
  window.dispatchEvent(new CustomEvent(IMPORT_UPDATED_EVENT, { detail: { savedAt: report?.savedAt || 0, report } }));
  window.dispatchEvent(new CustomEvent('eterx_agents_updated'));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('eterx-chats');
    channel.postMessage({ type: 'chats-updated', savedAt: report?.savedAt || 0 });
    channel.close();
    const imports = new BroadcastChannel('eterx-imports');
    imports.postMessage({ type: 'imports-updated', savedAt: report?.savedAt || 0 });
    imports.close();
  }
}

/** Mounted with the workspace, independent of the Settings tab's lifetime. */
export function useImportSync() {
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    let enabled = false;
    const watchingSince = Date.now();
    const delivered = new Set<string>();
    const publish = (report?: ImportReport) => {
      if (!report) return;
      const key = `${report.provider}:${report.completedAt}`;
      if (delivered.has(key)) return;
      delivered.add(key);
      if (delivered.size > 100) delivered.delete(delivered.values().next().value!);
      if (report.created || report.updated || report.setup) notifyImportChange(report);
    };
    const tick = async () => {
      if (inFlight || controller.signal.aborted || !enabled) return;
      inFlight = true;
      try {
        const data = await importRequest<{ job: ImportJob | null }>({ action: 'sync', automatic: true }, controller.signal);
        if (data.job) {
          const job = await waitForImportJob(data.job, undefined, controller.signal);
          publish(job.report);
        }
      } catch { /* Errors are saved per source and shown in Settings > Import. */ }
      finally { inFlight = false; }
    };
    const refresh = async () => {
      try {
        const status = await importRequest<ImportStatus>(undefined, controller.signal);
        enabled = status.autoSync;
        for (const source of Object.values(status.sources)) if ((source?.lastReport?.completedAt || 0) >= watchingSince) publish(source?.lastReport);
        if (status.activeJob && status.activeJob.kind !== 'scan' && !inFlight) {
          inFlight = true;
          try {
            const completed = await waitForImportJob(status.activeJob, undefined, controller.signal);
            publish(completed.report);
          } finally { inFlight = false; }
        }
        void tick();
      } catch { /* Settings retains an explicit retry action. */ }
    };
    void refresh();
    // Observe imports even when automatic sync is paused: Settings can close
    // while an import is committing on the server.
    const interval = window.setInterval(() => { void refresh(); }, 10_000);
    window.addEventListener('focus', refresh);
    window.addEventListener(IMPORT_UPDATED_EVENT, refresh);
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('eterx-imports') : null;
    if (channel) channel.onmessage = event => {
      if (event.data?.type !== 'imports-updated') return;
      window.dispatchEvent(new CustomEvent(IMPORT_UPDATED_EVENT, { detail: { savedAt: Number(event.data.savedAt || 0) } }));
      window.dispatchEvent(new CustomEvent('eterx_agents_updated'));
    };
    return () => {
      controller.abort(); window.clearInterval(interval);
      window.removeEventListener('focus', refresh); window.removeEventListener(IMPORT_UPDATED_EVENT, refresh);
      channel?.close();
    };
  }, []);
}
