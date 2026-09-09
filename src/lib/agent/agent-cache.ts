/**
 * AgentContextCacheManager
 *
 * Optionally caches the static portion of the EterX system prompt (base
 * identity + rules + all tool declarations) on the Gemini server as reusable,
 * content-addressed variants. Explicit caching is attempted by default and can
 * be disabled independently; stable prefixes also allow provider-managed caching.
 *
 * Savings depend on the active prompt/tool surface and provider cache tier.
 *
 * Key behaviours:
 *  - Singleton via globalThis — survives Next.js hot reloads.
 *  - Keyed by (apiKey_suffix + modelName) — each rotated key gets its own cache.
 *  - TTL = 1 hour; heartbeat every 14 min extends it automatically.
 *  - Self-heals on NOT_FOUND: clears stale entry, recreates immediately.
 *  - Opt out with ETERX_ENABLE_EXPLICIT_GEMINI_CACHE=0.
 *  - Fully opt out with ETERX_DISABLE_CONTEXT_CACHE=1.
 */

import * as crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  /** e.g. "cachedContents/abc123" */
  name: string;
  /** Last 8 chars used only for non-sensitive diagnostics. */
  apiKeyTail: string;
  /** Non-reversible key fingerprint used for local ownership checks. */
  apiKeyId: string;
  modelName: string;
  /** Full static prompt and tool-declaration fingerprint. */
  contentHash: string;
  /** Unix ms when the cache should be considered expired on our side */
  expiresAt: number;
  lastUsedAt: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_S = 3600;                        // 1 hour
const CACHE_SAFETY_BUFFER_MS = 2 * 60 * 1000;   // expire 2 min early on our side
const HEARTBEAT_INTERVAL_MS = 14 * 60 * 1000;   // extend TTL every 14 min
const MAX_CACHE_VARIANTS_PER_MODEL = 6;
const CACHE_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Global singleton cache store
// ─────────────────────────────────────────────────────────────────────────────

const globalForAgentCache = globalThis as typeof globalThis & {
  __eterxAgentContextCaches?: Map<string, CacheEntry>;
  __eterxAgentContextCacheInflight?: Map<string, Promise<string | null>>;
  /** Temporary per-key/per-model backoff after a cache quota/permission error. */
  __eterxAgentCacheDisabledUntil?: Map<string, number>;
};

function getCacheStore(): Map<string, CacheEntry> {
  if (!globalForAgentCache.__eterxAgentContextCaches) {
    globalForAgentCache.__eterxAgentContextCaches = new Map();
  }
  return globalForAgentCache.__eterxAgentContextCaches;
}

function getCacheBackoffStore(): Map<string, number> {
  if (!globalForAgentCache.__eterxAgentCacheDisabledUntil) {
    globalForAgentCache.__eterxAgentCacheDisabledUntil = new Map();
  }
  return globalForAgentCache.__eterxAgentCacheDisabledUntil;
}

function getInflightStore(): Map<string, Promise<string | null>> {
  if (!globalForAgentCache.__eterxAgentContextCacheInflight) {
    globalForAgentCache.__eterxAgentContextCacheInflight = new Map();
  }
  return globalForAgentCache.__eterxAgentContextCacheInflight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isCacheSupported(modelName: string): boolean {
  const lower = (modelName || '').toLowerCase();
  // Let the API decide support so newly released Gemini families benefit
  // immediately. Exclude only clearly non-generative/non-chat model classes.
  return /^(?:models\/)?gemini[-_]/.test(lower)
    && !/(?:embedding|image|imagen|tts|speech|robotics)/.test(lower);
}

function cacheOwnerKey(apiKey: string, modelName: string): string {
  return `${apiKeyId(apiKey)}:${modelName}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(',')}}`;
}

function normalizeGeminiCacheToolDeclarations(toolDeclarations: any[]): any[] {
  return toolDeclarations.map((declaration) => {
    if (!declaration || typeof declaration !== 'object') return declaration;
    const normalized = { ...declaration };
    // Cached-content accepts standard JSON Schema through the dedicated JSON
    // fields. Supplying lowercase JSON Schema as the proto `parameters` field
    // is what produced the repeated "Unknown name type" failures.
    if (declaration.parameters) {
      normalized.parametersJsonSchema = declaration.parameters;
      delete normalized.parameters;
    }
    if (declaration.response) {
      normalized.responseJsonSchema = declaration.response;
      delete normalized.response;
    }
    return normalized;
  });
}

export function isExplicitGeminiCacheEnabled(): boolean {
  return process.env.ETERX_ENABLE_EXPLICIT_GEMINI_CACHE !== '0'
    && process.env.ETERX_DISABLE_CONTEXT_CACHE !== '1';
}

function buildContentHash(staticSystemInstruction: string, toolDeclarations: any[]): string {
  return crypto
    .createHash('sha256')
    .update(staticSystemInstruction)
    .update('\0')
    .update(stableSerialize(toolDeclarations))
    .digest('hex')
    .slice(0, 24);
}

function apiKeyId(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 24);
}

/** Returns a stable key prefix without retaining raw key material. */
function storeKeyPrefix(apiKey: string, modelName: string): string {
  return `${apiKeyId(apiKey)}:${modelName}`;
}

function storeKey(apiKey: string, modelName: string, contentHash: string): string {
  return `${storeKeyPrefix(apiKey, modelName)}:${contentHash}`;
}

function clearEntry(entry: CacheEntry): void {
  if (entry.heartbeatTimer) {
    clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat
// ─────────────────────────────────────────────────────────────────────────────

function startHeartbeat(ai: any, entry: CacheEntry, entryStoreKey: string): void {
  if (entry.heartbeatTimer) return; // already running

  const timer = setInterval(async () => {
    if (getCacheStore().get(entryStoreKey) !== entry) {
      clearEntry(entry);
      return;
    }
    // Do not keep charging for a cache indefinitely after its agent/chat goes
    // idle. The existing remote TTL remains bounded; reuse can restart renewal.
    if (Date.now() - entry.lastUsedAt >= HEARTBEAT_INTERVAL_MS) {
      clearEntry(entry);
      return;
    }
    try {
      await ai.caches.update({
        name: entry.name,
        config: { ttl: `${CACHE_TTL_S}s` },
      });
      entry.expiresAt = Date.now() + CACHE_TTL_S * 1000 - CACHE_SAFETY_BUFFER_MS;
      console.log(`[AgentCache] 💓 Heartbeat extended TTL for ${entry.name}`);
    } catch (err: any) {
      const msg = String(err?.message || err).toLowerCase();
      console.warn(`[AgentCache] ⚠️ Heartbeat failed for ${entry.name}: ${String(err?.message || '').slice(0, 80)}`);
      if (msg.includes('not_found') || msg.includes('not found') || msg.includes('404')) {
        // Cache vanished on Google's side — clear so next request rebuilds
        clearEntry(entry);
        if (getCacheStore().get(entryStoreKey) === entry) getCacheStore().delete(entryStoreKey);
        console.log(`[AgentCache] 🗑️ Stale cache cleared (NOT_FOUND on heartbeat): ${entry.name}`);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Don't block process exit
  if (typeof timer.unref === 'function') timer.unref();
  entry.heartbeatTimer = timer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the name of a valid Gemini cached-content object for this
 * (apiKey × modelName) pair, creating it on first call.
 *
 * Returns `null` if:
 *  - ETERX_ENABLE_EXPLICIT_GEMINI_CACHE=0
 *  - ETERX_DISABLE_CONTEXT_CACHE=1
 *  - Model doesn't support caching
 *  - Any error during creation (silent fallback to uncached)
 */
async function getOrCreateAgentCacheUnlocked(
  ai: any,              // GoogleGenAI instance
  apiKey: string,
  modelName: string,
  staticSystemInstruction: string,
  toolDeclarations: any[]
): Promise<string | null> {
  if (!isExplicitGeminiCacheEnabled()) return null;
  if (!isCacheSupported(modelName)) return null;

  // Quota/permission failures are often temporary (tier upgrade, model change,
  // or provider-side recovery). Back off per model instead of disabling the
  // whole API key for the lifetime of the desktop process.
  const keyId = apiKeyId(apiKey);
  const ownerKey = cacheOwnerKey(apiKey, modelName);
  const disabledUntil = getCacheBackoffStore().get(ownerKey) || 0;
  if (disabledUntil > Date.now()) return null;
  if (disabledUntil) getCacheBackoffStore().delete(ownerKey);

  const store = getCacheStore();
  const hash = buildContentHash(staticSystemInstruction, toolDeclarations);
  const key = storeKey(apiKey, modelName, hash);

  // ── Check existing valid cache ──
  const existing = store.get(key);
  if (existing && Date.now() < existing.expiresAt) {
    existing.lastUsedAt = Date.now();
    startHeartbeat(ai, existing, key);
    console.log(`[AgentCache] ♻️ Reusing cache: ${existing.name}`);
    return existing.name;
  }

  // ── Invalidate stale entry ──
  if (existing) {
    clearEntry(existing);
    store.delete(key);
    console.log(`[AgentCache] 🔄 Stale/changed cache invalidated for model ${modelName}`);
    try {
      await ai.caches.delete({ name: existing.name });
      console.log(`[AgentCache] 🗑️ Deleted stale/changed cache on Google servers: ${existing.name}`);
    } catch (e: any) {
      console.warn(`[AgentCache] ⚠️ Failed to delete stale cache on Google servers: ${e.message || e}`);
    }
  }

  // ── Create new cache ──
  try {
    console.log(`[AgentCache] 🔨 Creating context cache for model ${modelName} ...`);
    const cache = await ai.caches.create({
      model: modelName,
      config: {
        systemInstruction: staticSystemInstruction,
        tools: toolDeclarations.length > 0
          ? [{ functionDeclarations: toolDeclarations }]
          : [],
        ttl: `${CACHE_TTL_S}s`,
      },
    });

    // SDK may use `.name` or `.cachedContentId` depending on version
    const cacheName: string | undefined = cache?.name ?? cache?.cachedContentId;
    if (!cacheName) {
      throw new Error('Cache create() returned an object with no name/cachedContentId');
    }

    const entry: CacheEntry = {
      name: cacheName,
      apiKeyTail: apiKey.slice(-8),
      apiKeyId: keyId,
      modelName,
      contentHash: hash,
      expiresAt: Date.now() + CACHE_TTL_S * 1000 - CACHE_SAFETY_BUFFER_MS,
      lastUsedAt: Date.now(),
      heartbeatTimer: null,
    };

    store.set(key, entry);
    startHeartbeat(ai, entry, key);

    const prefix = `${storeKeyPrefix(apiKey, modelName)}:`;
    const variants = [...store.entries()]
      .filter(([entryKey]) => entryKey.startsWith(prefix))
      .sort(([, left], [, right]) => (left.lastUsedAt || 0) - (right.lastUsedAt || 0));
    while (variants.length > MAX_CACHE_VARIANTS_PER_MODEL) {
      const [oldestKey, oldest] = variants.shift()!;
      if (oldestKey === key) continue;
      clearEntry(oldest);
      store.delete(oldestKey);
      try {
        await ai.caches.delete({ name: oldest.name });
      } catch {
        // Provider-side expiry/deletion is best-effort.
      }
    }

    const providerCachedTokens = Number(
      cache?.usageMetadata?.totalTokenCount ??
      cache?.usageMetadata?.totalTokens ??
      0,
    );
    const estimatedTokens = providerCachedTokens > 0
      ? providerCachedTokens
      : Math.round((staticSystemInstruction.length + stableSerialize(toolDeclarations).length) / 4);
    console.log(
      `[AgentCache] ✅ Created cache: ${cacheName}` +
      ` (${estimatedTokens.toLocaleString()} cached tokens${providerCachedTokens > 0 ? '' : ' estimated'}, TTL=${CACHE_TTL_S}s)`
    );

    return cacheName;
  } catch (err: any) {
    const msg = String(err?.message || err);
    // Detect free-tier / permission quota and temporarily back off so repeated
    // turns do not burn a cache-create request while the route is unavailable.
    const isQuotaOrPermError =
      msg.includes('TotalCachedContentStorage') ||
      msg.includes('FreeTier') ||
      msg.includes('PERMISSION_DENIED') ||
      msg.includes('403');
    if (isQuotaOrPermError) {
      getCacheBackoffStore().set(ownerKey, Date.now() + CACHE_RETRY_COOLDOWN_MS);
      console.warn(
        `[AgentCache] ℹ️ Context caching unavailable for this API key ` +
        `(free-tier, quota, or permission). Falling back temporarily; EterX will retry.`
      );
    } else {
      getCacheBackoffStore().set(ownerKey, Date.now() + 30_000);
      console.warn(`[AgentCache] ⚠️ Cache creation failed (falling back to uncached): ${msg.slice(0, 120)}`);
    }
    return null;
  }
}

export async function getOrCreateAgentCache(
  ai: any,
  apiKey: string,
  modelName: string,
  staticSystemInstruction: string,
  toolDeclarations: any[]
): Promise<string | null> {
  if (!isExplicitGeminiCacheEnabled()) return null;
  const cacheToolDeclarations = normalizeGeminiCacheToolDeclarations(toolDeclarations);
  const inflightKey = storeKey(
    apiKey,
    modelName,
    buildContentHash(staticSystemInstruction, cacheToolDeclarations),
  );
  const inflight = getInflightStore();
  const pending = inflight.get(inflightKey);
  if (pending) return pending;

  const creation = getOrCreateAgentCacheUnlocked(
    ai,
    apiKey,
    modelName,
    staticSystemInstruction,
    cacheToolDeclarations,
  );
  inflight.set(inflightKey, creation);
  try {
    return await creation;
  } finally {
    if (inflight.get(inflightKey) === creation) inflight.delete(inflightKey);
  }
}

/**
 * Call this when a request errors with NOT_FOUND referring to a cachedContent.
 * Clears the stale entry and immediately tries to rebuild the cache.
 *
 * Returns the new cache name, or null if rebuild also fails.
 */
export async function handleAgentCacheNotFound(
  ai: any,
  apiKey: string,
  modelName: string,
  staticSystemInstruction: string,
  toolDeclarations: any[]
): Promise<string | null> {
  const cacheToolDeclarations = normalizeGeminiCacheToolDeclarations(toolDeclarations);
  const store = getCacheStore();
  const key = storeKey(
    apiKey,
    modelName,
    buildContentHash(staticSystemInstruction, cacheToolDeclarations),
  );
  const existing = store.get(key);
  if (existing) {
    clearEntry(existing);
    store.delete(key);
  }
  console.log(`[AgentCache] 🔄 Cache NOT_FOUND — rebuilding for model ${modelName} ...`);
  return getOrCreateAgentCache(ai, apiKey, modelName, staticSystemInstruction, toolDeclarations);
}

/**
 * Invalidates all cache entries associated with a given API key.
 * Call after key rotation so the next request builds a fresh cache for the new key.
 */
export function invalidateAgentCacheForKey(apiKey: string): void {
  const store = getCacheStore();
  const keyId = apiKeyId(apiKey);
  const tail = keyId.slice(-8);
  for (const [k, entry] of store.entries()) {
    if (entry.apiKeyId === keyId) {
      clearEntry(entry);
      store.delete(k);
      console.log(`[AgentCache] 🗑️ Cache invalidated after key rotation (tail: ...${tail})`);
    }
  }
  for (const key of getCacheBackoffStore().keys()) {
    if (key.startsWith(`${keyId}:`)) getCacheBackoffStore().delete(key);
  }
}
