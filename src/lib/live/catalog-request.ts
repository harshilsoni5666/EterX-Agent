import { requestModelCatalog } from '../model-discovery-request';
import { requestJson } from '../request-json';
import { readStoredRuntimeSettings } from '../agent/runtime-settings-store';
import { normalizeLiveProvider } from './live-provider';

export const splitLiveKeys = (value: unknown): string[] => Array.from(new Set(
  (Array.isArray(value) ? value : [value])
    .flatMap(item => String(item || '').split(/[\n,;]+/))
    .map(key => key.trim()).filter(Boolean),
));

/** A bounded, request-local key pool; a blank override deliberately clears it. */
export function createLiveCatalogRequest(providerValue: unknown, override?: unknown) {
  const provider = normalizeLiveProvider(providerValue);
  const keys = splitLiveKeys(override !== undefined
    ? override : readStoredRuntimeSettings().liveApiKeys?.[provider.keyProvider]);
  const deadline = Date.now() + 35_000;
  let preferredKey = 0;
  return {
    hasKey: keys.length > 0,
    get selectedKey() { return keys[preferredKey] || ''; },
    async request(url: string, init: RequestInit = {}): Promise<any> {
      if (!keys.length) throw new Error(`No ${provider.label} Live API key is configured.`);
      const order = [preferredKey, ...keys.map((_, index) => index).filter(index => index !== preferredKey)];
      for (const index of order) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`${provider.label} request timed out. Please retry.`);
        const headers = new Headers(init.headers);
        if (provider.provider === 'gemini') headers.set('x-goog-api-key', keys[index]);
        else if (provider.provider === 'elevenlabs') headers.set('xi-api-key', keys[index]);
        else headers.set('Authorization', `${provider.provider === 'deepgram' ? 'Token' : 'Bearer'} ${keys[index]}`);
        // Session credentials must never be cached or shared between callers.
        const send = (init.method || 'GET') === 'GET' && !url.includes('/conversation/get-signed-url') ? requestModelCatalog : requestJson;
        const response = await send(url, { ...init, headers, cache: 'no-store' }, Math.min(12_000, remaining));
        if (!response.ok) {
          if ([401, 403].includes(response.status) && index !== order[order.length - 1]) continue;
          throw new Error(`${provider.label} request failed (${response.status}). ${response.status === 401 || response.status === 403 ? 'Check the Live key and its permissions.' : 'Please retry.'}`);
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
