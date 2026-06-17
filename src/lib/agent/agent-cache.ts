/**
 * AgentContextCacheManager
 *
 * Caches the static portion of the EterX system prompt (base identity + rules +
 * all tool function declarations) on the Gemini server once per API key/model pair.
 *
 * Savings: ~50-55K tokens per request, reducing cost from ~64K → ~9K per turn.
 *
 * Key behaviours:
 *  - Singleton via globalThis — survives Next.js hot reloads.
 *  - Keyed by (apiKey_suffix + modelName) — each rotated key gets its own cache.
 *  - TTL = 1 hour; heartbeat every 14 min extends it automatically.
 *  - Self-heals on NOT_FOUND: clears stale entry, recreates immediately.
 *  - Fully opt-out: set ETERX_DISABLE_CONTEXT_CACHE=1 or call returns null on any error.
 */

import * as crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  /** e.g. "cachedContents/abc123" */
  name: string;
  /** Last 8 chars of the API key this cache belongs to */
  apiKeyTail: string;
  modelName: string;
  /** SHA-1 of (staticSystemInstruction + first 500 chars of toolJSON) */
  contentHash: string;
  /** Unix ms when the cache should be considered expired on our side */
  expiresAt: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_S = 3600;                        // 1 hour
const CACHE_SAFETY_BUFFER_MS = 2 * 60 * 1000;   // expire 2 min early on our side
const HEARTBEAT_INTERVAL_MS = 14 * 60 * 1000;   // extend TTL every 14 min

/** Only Gemini models that support context caching */
const SUPPORTED_MODEL_PREFIXES = [
  'gemini-2.5',
  'gemini-2.0',
  'gemini-1.5',
  'gemini-3',
];

// ─────────────────────────────────────────────────────────────────────────────
// Global singleton cache store
// ─────────────────────────────────────────────────────────────────────────────

const globalForAgentCache = globalThis as typeof globalThis & {
  __eterxAgentContextCaches?: Map<string, CacheEntry>;
  /** API key tails permanently disabled after a free-tier / permission quota error */
  __eterxAgentCacheDisabledKeyTails?: Set<string>;
};

function getCacheStore(): Map<string, CacheEntry> {
  if (!globalForAgentCache.__eterxAgentContextCaches) {
    globalForAgentCache.__eterxAgentContextCaches = new Map();
  }
  return globalForAgentCache.__eterxAgentContextCaches;
}

function getDisabledKeyTails(): Set<string> {
  if (!globalForAgentCache.__eterxAgentCacheDisabledKeyTails) {
    globalForAgentCache.__eterxAgentCacheDisabledKeyTails = new Set();
  }
  return globalForAgentCache.__eterxAgentCacheDisabledKeyTails;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isCacheSupported(modelName: string): boolean {
  const lower = (modelName || '').toLowerCase();
  return SUPPORTED_MODEL_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function buildContentHash(staticSystemInstruction: string, toolDeclarations: any[]): string {
  const toolSample = JSON.stringify(toolDeclarations).slice(0, 600);
  return crypto
    .createHash('sha1')
    .update(staticSystemInstruction + toolSample)
    .digest('hex')
    .slice(0, 16);
}

/** Returns a stable, safe key for the in-memory store */
function storeKey(apiKey: string, modelName: string): string {
  return `${apiKey.slice(-8)}:${modelName}`;
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
    try {
      await ai.caches.update(entry.name, { config: { ttl: `${CACHE_TTL_S}s` } });
      entry.expiresAt = Date.now() + CACHE_TTL_S * 1000 - CACHE_SAFETY_BUFFER_MS;
      console.log(`[AgentCache] 💓 Heartbeat extended TTL for ${entry.name}`);
    } catch (err: any) {
      const msg = String(err?.message || err).toLowerCase();
      console.warn(`[AgentCache] ⚠️ Heartbeat failed for ${entry.name}: ${String(err?.message || '').slice(0, 80)}`);
      if (msg.includes('not_found') || msg.includes('not found') || msg.includes('404')) {
        // Cache vanished on Google's side — clear so next request rebuilds
        clearEntry(entry);
        getCacheStore().delete(entryStoreKey);
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
 *  - ETERX_DISABLE_CONTEXT_CACHE=1
 *  - Model doesn't support caching
 *  - Any error during creation (silent fallback to uncached)
 */
export async function getOrCreateAgentCache(
  ai: any,              // GoogleGenAI instance
  apiKey: string,
  modelName: string,
  staticSystemInstruction: string,
  toolDeclarations: any[]
): Promise<string | null> {
  if (process.env.ETERX_DISABLE_CONTEXT_CACHE === '1') return null;
  if (!isCacheSupported(modelName)) return null;

  // Skip permanently-disabled keys (free-tier or permission error on a prior attempt)
  const keyTail = apiKey.slice(-8);
  if (getDisabledKeyTails().has(keyTail)) return null;

  const store = getCacheStore();
  const key = storeKey(apiKey, modelName);
  const hash = buildContentHash(staticSystemInstruction, toolDeclarations);

  // ── Check existing valid cache ──
  const existing = store.get(key);
  if (existing && existing.contentHash === hash && Date.now() < existing.expiresAt) {
    console.log(`[AgentCache] ♻️ Reusing cache: ${existing.name}`);
    return existing.name;
  }

  // ── Invalidate stale entry ──
  if (existing) {
    clearEntry(existing);
    store.delete(key);
    console.log(`[AgentCache] 🔄 Stale/changed cache invalidated for model ${modelName}`);
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
      modelName,
      contentHash: hash,
      expiresAt: Date.now() + CACHE_TTL_S * 1000 - CACHE_SAFETY_BUFFER_MS,
      heartbeatTimer: null,
    };

    store.set(key, entry);
    startHeartbeat(ai, entry, key);

    const estimatedTokens = Math.round(staticSystemInstruction.length / 4);
    console.log(
      `[AgentCache] ✅ Created cache: ${cacheName}` +
      ` (~${estimatedTokens.toLocaleString()} tokens estimated, TTL=${CACHE_TTL_S}s)`
    );

    return cacheName;
  } catch (err: any) {
    const msg = String(err?.message || err);
    // Detect free-tier / permission quota — permanently disable for this key so
    // we don't burn an API call on every subsequent request.
    const isQuotaOrPermError =
      msg.includes('TotalCachedContentStorage') ||
      msg.includes('FreeTier') ||
      msg.includes('PERMISSION_DENIED') ||
      msg.includes('403');
    if (isQuotaOrPermError) {
      getDisabledKeyTails().add(apiKey.slice(-8));
      console.warn(
        `[AgentCache] ℹ️ Context caching unavailable for this API key ` +
        `(free-tier or no permission). Falling back to uncached mode permanently. ` +
        `Upgrade to a paid Gemini API key to enable caching.`
      );
    } else {
      console.warn(`[AgentCache] ⚠️ Cache creation failed (falling back to uncached): ${msg.slice(0, 120)}`);
    }
    return null;
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
  const store = getCacheStore();
  const key = storeKey(apiKey, modelName);
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
  const tail = apiKey.slice(-8);
  for (const [k, entry] of store.entries()) {
    if (entry.apiKeyTail === tail) {
      clearEntry(entry);
      store.delete(k);
      console.log(`[AgentCache] 🗑️ Cache invalidated after key rotation (tail: ...${tail})`);
    }
  }
}
