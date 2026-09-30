import { createHash } from 'node:crypto';
import { requestJson } from './request-json';

// Share catalog reads only when the URL and credentials are identical. Never
// retain credentials themselves, failed responses, or unbounded cache entries.
const pending = new Map<string, ReturnType<typeof requestJson>>();
const cache = new Map<string, { expires: number; response: Awaited<ReturnType<typeof requestJson>> }>();

export async function requestModelCatalog(input: string, init: RequestInit = {}, timeoutMs = 12_000) {
  const key = createHash('sha256').update(JSON.stringify([
    input, init.method || 'GET', Array.from(new Headers(init.headers).entries()).sort(), init.body || '',
  ])).digest('hex');
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.response;
  cache.delete(key);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = requestJson(input, init, Math.min(timeoutMs, 12_000)).then(async response => {
    // Parse under the request lifetime, and don't cache malformed responses.
    const payload = await response.json().catch(error => {
      if (response.ok) throw error;
      return null;
    });
    const reusable = { ok: response.ok, status: response.status, json: async () => payload };
    if (response.ok) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(key, { expires: Date.now() + 20_000, response: reusable });
    }
    return reusable;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
