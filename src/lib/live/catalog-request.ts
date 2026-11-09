import { requestModelCatalog } from '../model-discovery-request';
import { requestJson } from '../request-json';
import { readStoredRuntimeSettings } from '../agent/runtime-settings-store';
import { parseModelEntryKey } from '../agent/model-selector-store';
import { normalizeLiveProvider } from './live-provider';

export const splitLiveKeys = (value: unknown): string[] => Array.from(new Set(
  (Array.isArray(value) ? value : [value])
    .flatMap(item => String(item || '').split(/[\n,;]+/))
    .map(key => key.trim()).filter(Boolean),
));

const nativeOrigins: Record<string, string> = {
  gemini: 'https://generativelanguage.googleapis.com', openai: 'https://api.openai.com',
  grok: 'https://api.x.ai', deepgram: 'https://api.deepgram.com', elevenlabs: 'https://api.elevenlabs.io',
};

/** Prefer a dedicated pool; otherwise reuse the same provider's connection.
 * Never send a custom gateway's credentials to a different native host. */
const storedLiveKeys = (providerValue: unknown, modelValue?: unknown): string[] => {
  const provider = normalizeLiveProvider(providerValue);
  const settings = readStoredRuntimeSettings();
  const dedicated = splitLiveKeys(settings.liveApiKeys?.[provider.keyProvider]);
  if (dedicated.length) return dedicated;
  const configuredBase = settings.baseURLs?.[provider.provider];
  if (configuredBase) {
    try { if (new URL(configuredBase).origin !== nativeOrigins[provider.provider]) return []; }
    catch { return []; }
  }
  const model = String(modelValue || '').replace(/^models\//, '').trim();
  const modelPools = Object.entries(settings.modelApiKeys || {}).flatMap(([selection, pool]) => {
    const entry = parseModelEntryKey(selection);
    return entry?.provider === provider.provider ? [{ modelId: entry.modelId, keys: splitLiveKeys(pool) }] : [];
  });
  const selected = modelPools.find(entry => entry.modelId.replace(/^models\//, '') === model);
  // Model connections store their keys separately from provider-wide keys.
  // Keep the selected model first, then rotate only within this native host.
  return Array.from(new Set([
    ...(selected?.keys || []),
    ...splitLiveKeys(settings.apiKeys?.[provider.keyProvider]),
    ...modelPools.flatMap(entry => entry.keys),
  ]));
};

/** A bounded, request-local key pool; a blank explicit override clears it. */
export function createLiveCatalogRequest(providerValue: unknown, override?: unknown, signal?: AbortSignal, model?: unknown) {
  const provider = normalizeLiveProvider(providerValue);
  const keys = override !== undefined ? splitLiveKeys(override) : storedLiveKeys(provider.value, model);
  const deadline = Date.now() + 35_000;
  let preferredKey = 0;
  return {
    hasKey: keys.length > 0,
    get selectedKey() { return keys[preferredKey] || ''; },
    async request(url: string, init: RequestInit = {}): Promise<any> {
      if (!keys.length) throw new Error(`No ${provider.label} Live API key is configured.`);
      const order = [preferredKey, ...keys.map((_, index) => index).filter(index => index !== preferredKey)];
      for (const index of order) {
        (init.signal || signal)?.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`${provider.label} request timed out. Please retry.`);
        const headers = new Headers(init.headers);
        if (provider.provider === 'gemini') headers.set('x-goog-api-key', keys[index]);
        else if (provider.provider === 'elevenlabs') headers.set('xi-api-key', keys[index]);
        else headers.set('Authorization', `${provider.provider === 'deepgram' ? 'Token' : 'Bearer'} ${keys[index]}`);
        // Session credentials must never be cached or shared between callers.
        const send = (init.method || 'GET') === 'GET' && !url.includes('/conversation/get-signed-url') ? requestModelCatalog : requestJson;
        const response = await send(url, { ...init, signal: init.signal || signal, headers, cache: 'no-store' }, Math.min(12_000, remaining));
        if (!response.ok) {
          if ([401, 403, 429].includes(response.status) && index !== order[order.length - 1]) continue;
          const payload = await response.json().catch(() => null);
          let detail = String(payload?.error?.message || payload?.error?.description || payload?.detail?.message
            || (typeof payload?.detail === 'string' ? payload.detail : '')
            || payload?.message || (typeof payload?.error === 'string' ? payload.error : '') || '');
          for (const key of keys) detail = detail.split(key).join('[redacted]');
          detail = detail.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[\r\n]+/g, ' ').slice(0, 500);
          const hint = [401, 403].includes(response.status) ? 'Check the key and its realtime permissions.'
            : response.status === 429 ? 'The provider rate limit or quota was reached.' : 'Check the selected model and voice.';
          throw new Error(`${provider.label} request failed (${response.status}). ${detail || hint}`);
        }
        preferredKey = index;
        return response.json();
      }
      throw new Error(`No authorized ${provider.label} Live key is available.`);
    },
  };
}

export const isAvailableCatalogItem = (item: any): boolean => {
  if (item?.active === false || item?.enabled === false || item?.deprecated === true) return false;
  if (/deprecated|retired|disabled|expired|unavailable/i.test(String(item?.lifecycle || item?.status || ''))) return false;
  const expiry = item?.expiration_date || item?.deprecationDate || item?.shutdown_at || item?.end_of_life;
  if (!expiry) return true;
  const date = typeof expiry === 'number' ? (expiry < 10_000_000_000 ? expiry * 1000 : expiry) : Date.parse(String(expiry));
  return !Number.isFinite(date) || date > Date.now();
};
