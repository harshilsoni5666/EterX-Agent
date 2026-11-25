import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getEterxDataDir } from '../agent/storage-paths';
import bundled from './bundled-rates.json';
import { extractRateTable, MODELS_URL, OPENROUTER_URL, LITELLM_URL, type RateCatalog } from './rate-catalog';

const directory = path.join(getEterxDataDir(), 'usage');
const file = path.join(directory, 'rates-v1.json');
interface PriceCache { catalog: RateCatalog; nextRefresh: number; pending?: Promise<void> }
const state = globalThis as typeof globalThis & { __eterxUsagePrices?: PriceCache };

function prices(): PriceCache {
  if (state.__eterxUsagePrices) return state.__eterxUsagePrices;
  let catalog = bundled as RateCatalog;
  let nextRefresh = 0;
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (cached.asOf >= catalog.asOf && cached.providers?.openai && cached.providers?.openrouter) {
      catalog = cached;
      nextRefresh = Date.parse(cached.asOf) + 86_400_000;
    }
  } catch { /* The bundled catalog also works on first launch and offline. */ }
  return state.__eterxUsagePrices = { catalog, nextRefresh };
}
export const currentRates = () => prices().catalog;

async function publicJson(url: string) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error('Price catalog unavailable');
  return res.json();
}
/** List downloads are independent of the user's model requests and contain no local identifiers. */
export function refreshRates(): Promise<void> {
  const cache = prices();
  if (cache.pending) return cache.pending;
  if (Date.now() < cache.nextRefresh) return Promise.resolve();
  cache.nextRefresh = Date.now() + 15 * 60_000;
  cache.pending = (async () => {
    const [models, router, lite] = await Promise.all([publicJson(MODELS_URL), publicJson(OPENROUTER_URL), publicJson(LITELLM_URL)]);
    if (!models?.openai?.models || !router?.data?.length) throw new Error('Incomplete price catalog');
    const fresh = extractRateTable(models, router, lite);
    const providers = { ...cache.catalog.providers };
    // Keep last-known prices for retired model IDs that still occur in older conversations.
    for (const [provider, entries] of Object.entries(fresh)) providers[provider] = { ...providers[provider], ...entries };
    const catalog = { asOf: new Date().toISOString().slice(0, 10), providers };
    mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, 'rates-' + randomUUID() + '.tmp');
    try {
      await writeFile(temp, JSON.stringify(catalog), { mode: 0o600 });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
    cache.catalog = catalog;
    cache.nextRefresh = Date.now() + 86_400_000;
  })().catch(() => {}).finally(() => { cache.pending = undefined; });
  return cache.pending;
}
