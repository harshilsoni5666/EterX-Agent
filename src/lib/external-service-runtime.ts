import { AsyncLocalStorage } from 'node:async_hooks';
import { withApiRetries } from './agent/api-retry';
import { getScopedRuntimeApiKeyValues, type RuntimeApiKeyProvider, type ScopedRuntimeSettings } from './agent/runtime-api-keys';

export type ExternalServiceContext = {
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  runtimeSettings?: ScopedRuntimeSettings;
  serviceSettings?: unknown;
  job?: ExternalServiceJob;
};

export type ExternalServiceJob = { provider: string; model: string; id: string };

const requestContext = new AsyncLocalStorage<ExternalServiceContext>();

export function withExternalServiceContext<T>(context: ExternalServiceContext | undefined, operation: () => Promise<T>): Promise<T> {
  return requestContext.run({ ...(context || requestContext.getStore() || {}) }, operation);
}

export function externalServiceSettings<T>(): T | undefined {
  return requestContext.getStore()?.serviceSettings as T | undefined;
}

export function externalServiceJob(): ExternalServiceJob | undefined {
  return requestContext.getStore()?.job;
}

export function rememberExternalServiceJob(provider: string, model: string, id: string): void {
  const context = requestContext.getStore();
  if (context) context.job = { provider, model, id };
}

/** A terminal job failure may use another provider, but not resubmit on every key. */
export function externalServiceJobFailed(message: string): Error {
  const context = requestContext.getStore();
  if (context) context.job = undefined;
  return externalServiceError(message, 422);
}

export function externalServiceSignal(): AbortSignal | undefined {
  const context = requestContext.getStore();
  return context?.abortSignal || context?.signal;
}

export function throwIfExternalServiceCancelled(): void {
  if (externalServiceSignal()?.aborted) throw new DOMException('External service request cancelled by user.', 'AbortError');
}

export function externalServiceKeys(configured: string[] | undefined, environment: string[], modelProvider?: RuntimeApiKeyProvider, runtimeSettings?: ScopedRuntimeSettings): string[] {
  const shared = modelProvider ? getScopedRuntimeApiKeyValues(runtimeSettings || requestContext.getStore()?.runtimeSettings, modelProvider) : [];
  const keys = configured?.length ? configured : shared.length ? shared : environment;
  return Array.from(new Set(keys.map(key => key.trim()).filter(Boolean))).slice(0, 3);
}

export function externalServiceError(message: string, status = 502, headers?: Headers): Error {
  return Object.assign(new Error(message), { status, headers });
}

export function externalServiceJobAccessError(error: unknown): unknown {
  // Some providers conceal another key's jobs behind a 404. Try the remaining
  // configured keys against the existing job instead of submitting a new job.
  if (externalServiceJob() && Number((error as any)?.status || (error as any)?.code || (error as any)?.response?.status) === 404) {
    return Object.assign(new Error((error as Error).message), { status: 403, cause: error });
  }
  return error;
}

/** Deadline and Stop cover both response headers and the complete response body. */
export async function externalServiceRequest(url: string, init: RequestInit = {}, timeout = 60_000): Promise<Response> {
  throwIfExternalServiceCancelled();
  const controller = new AbortController();
  const signals = [controller.signal, externalServiceSignal(), init.signal].filter((signal): signal is AbortSignal => Boolean(signal));
  let timedOut = false;
  const timer = timeout > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout) : undefined;
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
    const bytes = await response.arrayBuffer();
    if (!response.ok) {
      let detail = new TextDecoder().decode(bytes);
      try {
        const payload = JSON.parse(detail);
        const error = payload?.error?.message || payload?.error || payload?.message || payload?.detail;
        if (error) detail = typeof error === 'string' ? error : JSON.stringify(error);
      } catch { /* Preserve a non-JSON error body. */ }
      throw externalServiceError(`${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 400)}` : ''}`, response.status, response.headers);
    }
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    throwIfExternalServiceCancelled();
    if (timedOut) throw externalServiceError(`External service request timed out after ${timeout}ms.`, 408);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function externalServiceJson(url: string, init: RequestInit = {}, timeout = 60_000): Promise<any> {
  const response = await externalServiceRequest(url, init, timeout);
  let payload: any;
  try { payload = await response.json(); } catch {
    throw externalServiceError('External service returned an invalid JSON response.');
  }
  if (payload?.success === false || payload?.error || Number(payload?.base_resp?.status_code || 0) !== 0) {
    const detail = payload?.error?.message || payload?.error || payload?.message || payload?.base_resp?.status_msg || 'Provider reported an unsuccessful request.';
    const message = typeof detail === 'string' ? detail : JSON.stringify(detail);
    const state = String(payload?.status || payload?.state || payload?.data?.status || payload?.task?.status || '').toLowerCase();
    if (externalServiceJob() && ['failed', 'failure', 'error', 'expired', 'cancelled', 'canceled'].includes(state)) {
      throw externalServiceJobFailed(message);
    }
    const status = Number(payload?.error?.http_code || payload?.error?.status || payload?.status_code);
    throw externalServiceError(message, status >= 400 && status <= 599 ? status : 502);
  }
  return payload;
}

/** FAL's catalog lives on the Platform API, not on its inference queue. */
export async function readFalModelCatalog(baseURL: string, key: string, model: string): Promise<void> {
  const endpoint = baseURL.replace(/\/+$/, '');
  if (!['https://queue.fal.run', 'https://fal.run', 'https://api.fal.ai', 'https://api.fal.ai/v1'].includes(endpoint)) {
    throw new Error('A read-only catalog probe is not available for this custom FAL endpoint. Credentials and generation access remain unverified.');
  }
  const payload = await externalServiceJson(`https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Key ${key}`, Accept: 'application/json' },
  }, 20_000);
  if (!Array.isArray(payload?.models) || !payload.models.some((entry: any) => entry?.endpoint_id === model)) {
    throw new Error(`FAL did not advertise '${model}' in its model catalog; generation access remains unverified.`);
  }
}

/** Retry an existing output download without charging for another generation. */
export async function downloadExternalServiceAsset(url: string, init: RequestInit = {}, timeout = 60_000): Promise<Response> {
  try {
    return await withApiRetries(() => externalServiceRequest(url, init, timeout), requestContext.getStore()?.runtimeSettings, externalServiceSignal());
  } catch (error: any) {
    throwIfExternalServiceCancelled();
    throw Object.assign(externalServiceError(`Generated asset download failed: ${error?.message || error}`, 422), { assetURL: url });
  }
}

export async function waitForExternalService(milliseconds: number): Promise<void> {
  throwIfExternalServiceCancelled();
  const signal = externalServiceSignal();
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new DOMException('External service request cancelled by user.', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
