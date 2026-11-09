/**
 * Smart API Key Pool — Collision-Free Key Assignment with Auto-Failover
 * 
 * This is the brain of parallel agent execution. It solves:
 * 1. CAPACITY: Each key has a bounded number of concurrent leases
 * 2. AUTO-FAILOVER: Failed requests can rotate to another key with capacity
 * 3. LEASE SYSTEM: Keys are "leased" to a chatId. When the chat finishes, the key is returned to the pool
 * 4. CACHE AFFINITY: Returning chats reuse a healthy key; new chats balance load
 * 5. HEALTH TRACKING: Failed keys are skipped immediately without timer-based waiting
 * 6. PARALLEL CAPACITY: With 27 keys, easily supports 4-8+ simultaneous agents
 * 
 * Architecture:
 * - allKeys: Master list of all discovered API keys
 * - activeLeases: Map<chatId, keyIndex> — which chat is using which key
 * - keyHealth: Map<keyIndex, { failures, totalUses, lastUsed }> - per-key health
 */

import { createHash } from 'crypto';

export interface KeyLease {
  keyIndex: number;
  apiKey: string;
  chatId: string;
  leasedAt: number;
  purpose: 'main_agent' | 'sub_agent';
  cacheScope?: string;
}

interface KeyHealth {
  failures: number;        // Consecutive failure count
  totalUses: number;       // Lifetime use count (for fair rotation)
  lastUsed: number;        // Last time this key was used
  lastError: string;       // Last error message (for debugging)
}

class APIKeyPool {
  private allKeys: string[] = [];
  private activeLeases: Map<string, KeyLease> = new Map(); // chatId/agentId → lease
  private keyHealth: Map<number, KeyHealth> = new Map();
  private cacheAffinity = new Map<string, string>();
  private initialized = false;
  private capacityListeners = new Set<() => void>();

  public subscribeCapacity(wake: () => void): () => void {
    this.capacityListeners.add(wake);
    return () => { this.capacityListeners.delete(wake); };
  }

  private notifyCapacity(): void {
    for (const wake of [...this.capacityListeners]) wake();
  }

  /** Wait for a lease without treating temporary saturation as missing keys. */
  public waitForLease(chatId: string, purpose: KeyLease['purpose'], signal?: AbortSignal, cacheScope = chatId): Promise<KeyLease> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener('abort', acquire);
      };
      const acquire = () => {
        if (settled) return;
        if (signal?.aborted || this.totalKeys === 0) {
          settled = true;
          cleanup();
          reject(new Error(signal?.aborted ? 'CANCELLED_BY_USER' : 'No Gemini API keys are configured for this execution.'));
          return;
        }
        if (!this.activeLeases.has(chatId) && !this.canAcceptNewAgent()) return;
        const lease = this.leaseKey(chatId, purpose, undefined, cacheScope);
        if (!lease) return;
        settled = true;
        cleanup();
        resolve(lease);
      };
      const unsubscribe = this.subscribeCapacity(acquire);
      signal?.addEventListener('abort', acquire, { once: true });
      acquire();
    });
  }

  /** A parent doing no provider work must not retain the last key while joining children. */
  public async withReleasedLease<T>(chatId: string, operation: () => Promise<T>, signal?: AbortSignal, onReacquired?: (lease: KeyLease) => void): Promise<T> {
    const previous = this.activeLeases.get(chatId);
    if (!previous) return operation();
    this.releaseKey(chatId);
    try {
      return await operation();
    } finally {
      if (!signal?.aborted) {
        const lease = await this.waitForLease(chatId, previous.purpose, signal, previous.cacheScope || chatId);
        onReacquired?.(lease);
      }
    }
  }

  private static readonly DEFAULT_PARALLEL_LEASES_PER_KEY = 8;

  private rememberCacheKey(scope: string, apiKey: string): void {
    this.cacheAffinity.delete(scope);
    this.cacheAffinity.set(scope, createHash('sha256').update(apiKey).digest('hex'));
    // Retain routes across turns without retaining an unbounded chat registry.
    while (this.cacheAffinity.size > 4096) this.cacheAffinity.delete(this.cacheAffinity.keys().next().value!);
  }

  private get maxParallelLeasesPerKey(): number {
    const configured = Number.parseInt(process.env.ETERX_MAX_PARALLEL_PER_GEMINI_KEY || '', 10);
    if (!Number.isFinite(configured)) return APIKeyPool.DEFAULT_PARALLEL_LEASES_PER_KEY;
    return Math.max(1, Math.min(64, configured));
  }

  private getLeaseCountsByKey(): Map<number, number> {
    const counts = new Map<number, number>();
    for (const lease of this.activeLeases.values()) {
      counts.set(lease.keyIndex, (counts.get(lease.keyIndex) || 0) + 1);
    }
    return counts;
  }

  /**
   * Initialize the pool by discovering all API keys from environment.
   * Called lazily on first use.
   */
  public initialize(): void {
    if (this.initialized) return;

    this.allKeys = [];

    // Initialize health tracking for each key
    this.allKeys.forEach((_, idx) => {
      this.keyHealth.set(idx, {
        failures: 0,
        totalUses: 0,
        lastUsed: 0,
        lastError: '',
      });
    });

    this.initialized = true;
    console.log(`[APIKeyPool] 🔑 Initialized with ${this.allKeys.length} unique keys. Max parallel agents: ${this.allKeys.length}`);
  }

  /**
   * Replace the pool with the exact Gemini keys currently configured in Settings.
   * Removed UI keys are evicted so stale .env values cannot remain in rotation.
   */
  public setRuntimeKeys(apiKeys: string[]): void {
    this.initialize();

    const uniqueKeys = Array.from(new Set(
      apiKeys
        .map(key => String(key || '').trim())
        .filter(key => key.startsWith('AIza') && key.length > 20),
    ));
    const allowedKeys = new Set(uniqueKeys);
    const allowedFingerprints = new Set(uniqueKeys.map(key => createHash('sha256').update(key).digest('hex')));
    for (const [scope, fingerprint] of this.cacheAffinity) {
      if (!allowedFingerprints.has(fingerprint)) this.cacheAffinity.delete(scope);
    }

    for (const [chatId, lease] of Array.from(this.activeLeases.entries())) {
      if (!allowedKeys.has(lease.apiKey)) {
        this.activeLeases.delete(chatId);
      }
    }

    const previousHealth = new Map<string, KeyHealth>();
    this.allKeys.forEach((key, index) => {
      const health = this.keyHealth.get(index);
      if (health) previousHealth.set(key, health);
    });

    this.allKeys = uniqueKeys;
    this.keyHealth.clear();
    this.allKeys.forEach((key, index) => {
      this.keyHealth.set(index, previousHealth.get(key) || {
        failures: 0,
        totalUses: 0,
        lastUsed: 0,
        lastError: '',
      });
    });

    for (const [chatId, lease] of this.activeLeases.entries()) {
      const keyIndex = this.allKeys.indexOf(lease.apiKey);
      if (keyIndex < 0) this.activeLeases.delete(chatId);
      else if (lease.keyIndex !== keyIndex) this.activeLeases.set(chatId, { ...lease, keyIndex });
    }

    console.log(`[APIKeyPool] Runtime pool synced from Settings: ${this.allKeys.length} Gemini key(s).`);
    this.notifyCapacity();
  }

  /**
   * Get total number of available keys.
   */
  public get totalKeys(): number {
    this.initialize();
    return this.allKeys.length;
  }

  /**
   * Get number of currently active leases.
   */
  public get activeCount(): number {
    return this.activeLeases.size;
  }

  /**
   * Get maximum recommended parallel agents.
   * We reserve 2 keys as failover buffer.
   */
  public get maxParallelAgents(): number {
    this.initialize();
    return this.allKeys.length * this.maxParallelLeasesPerKey;
  }

  /**
   * LEASE a key for a specific chat/agent.
   * 
   * The algorithm picks the BEST available key:
   * 1. Filter out keys at capacity and the key being avoided during failover
   * 2. Reuse a healthy remembered route when it has capacity
   * 3. Sort remaining by: fewest active leases -> fewest total uses -> fewest failures -> longest since last use
   * 
   * If calling for the same chatId that already has a lease, returns the existing lease.
   * 
   * @param chatId - The chat or agent identifier
   * @param purpose - Whether this is for a main agent or sub-agent
   * @returns The leased key, or null if no keys available
   */
  public leaseKey(chatId: string, purpose: 'main_agent' | 'sub_agent' = 'main_agent', avoidKeyIndex?: number, cacheScope = chatId): KeyLease | null {
    this.initialize();
    // If this chatId already has a lease, return it
    const existing = this.activeLeases.get(chatId);
    if (existing) {
      return existing;
    }

    const now = Date.now();

    const leaseCounts = this.getLeaseCountsByKey();

    let candidates: { index: number; health: KeyHealth; active: number }[] = [];
    for (let i = 0; i < this.allKeys.length; i++) {
      if (avoidKeyIndex === i) continue;
      const active = leaseCounts.get(i) || 0;
      if (active >= this.maxParallelLeasesPerKey) continue;
      candidates.push({ index: i, health: this.keyHealth.get(i)!, active });
    }

    if (candidates.length === 0 && avoidKeyIndex != null && (leaseCounts.get(avoidKeyIndex) || 0) < this.maxParallelLeasesPerKey) {
      const health = this.keyHealth.get(avoidKeyIndex)!;
      candidates.push({ index: avoidKeyIndex, health, active: leaseCounts.get(avoidKeyIndex) || 0 });
      console.warn(`[APIKeyPool] No alternate ready key; retrying key #${avoidKeyIndex} immediately.`);
    }

    if (candidates.length === 0) {
      console.error(`[APIKeyPool] No ready API-key capacity. ${this.activeLeases.size} leases, ${this.allKeys.length} total.`);
      return null;
    }

    // Spread concurrent work first, then prefer the healthiest/least-used key.
    candidates.sort((a, b) => {
      if (a.active !== b.active) return a.active - b.active;
      if (a.health.totalUses !== b.health.totalUses) {
        return a.health.totalUses - b.health.totalUses; // Fewer uses = better
      }
      if (a.health.failures !== b.health.failures) {
        return a.health.failures - b.health.failures;
      }
      return a.health.lastUsed - b.health.lastUsed; // Older = better
    });

    const remembered = this.cacheAffinity.get(cacheScope);
    const preferred = remembered ? candidates.find(candidate => candidate.health.failures === 0
      && createHash('sha256').update(this.allKeys[candidate.index]).digest('hex') === remembered) : undefined;
    const picked = preferred || candidates[0];
    const lease: KeyLease = {
      keyIndex: picked.index,
      apiKey: this.allKeys[picked.index],
      chatId,
      leasedAt: now,
      purpose,
      cacheScope,
    };

    this.activeLeases.set(chatId, lease);
    this.rememberCacheKey(cacheScope, lease.apiKey);
    picked.health.totalUses++;
    picked.health.lastUsed = now;

    console.log(`[APIKeyPool] ✅ Leased key #${picked.index} to ${purpose} [${chatId.substring(0, 8)}...] (${this.activeLeases.size}/${this.allKeys.length} in use, ${candidates.length - 1} available)`);

    return lease;
  }

  /**
   * Lease a user-provided key when settings explicitly supplied one.
   * This respects the same per-key concurrency limit as the general pool.
   */
  public leaseSpecificKey(chatId: string, apiKey: string, purpose: 'main_agent' | 'sub_agent' = 'main_agent', cacheScope = chatId): KeyLease | null {
    this.initialize();

    const key = String(apiKey || '').trim();
    if (!key || !key.startsWith('AIza') || key.length <= 20) return null;

    this.addKey(key);
    const keyIndex = this.allKeys.indexOf(key);
    if (keyIndex < 0) return null;

    const existing = this.activeLeases.get(chatId);
    if (existing) {
      return existing.keyIndex === keyIndex ? existing : null;
    }

    const activeOnKey = this.getLeaseCountsByKey().get(keyIndex) || 0;
    if (activeOnKey >= this.maxParallelLeasesPerKey) return null;

    const health = this.keyHealth.get(keyIndex);
    if (!health) return null;

    const now = Date.now();
    const lease: KeyLease = {
      keyIndex,
      apiKey: key,
      chatId,
      leasedAt: now,
      purpose,
      cacheScope,
    };

    this.activeLeases.set(chatId, lease);
    this.rememberCacheKey(cacheScope, lease.apiKey);
    health.totalUses++;
    health.lastUsed = now;
    console.log(`[APIKeyPool] Leased runtime settings key #${keyIndex} to ${purpose} [${chatId.substring(0, 8)}...]`);
    return lease;
  }

  /**
   * RELEASE a key lease when a chat/agent finishes.
   * The key goes back to the available pool.
   */
  public releaseKey(chatId: string): void {
    const lease = this.activeLeases.get(chatId);
    if (lease) {
      const duration = ((Date.now() - lease.leasedAt) / 1000).toFixed(1);
      console.log(`[APIKeyPool] 🔓 Released key #${lease.keyIndex} from [${chatId.substring(0, 8)}...] after ${duration}s`);
      this.activeLeases.delete(chatId);
      this.notifyCapacity();
    }
  }

  /**
   * Release every lease whose identifier starts with a prefix.
   * Used when a parent chat stops or finishes and any sub-agent leases must be cleaned.
   */
  public releaseLeasesWithPrefix(prefix: string): number {
    const leaseIds = Array.from(this.activeLeases.keys()).filter((leaseId) => leaseId.startsWith(prefix));
    for (const leaseId of leaseIds) {
      this.releaseKey(leaseId);
    }
    return leaseIds.length;
  }

  /**
   * Report a key failure. The system immediately auto-swaps the chat
   * to another ready key, without timer-based waiting.
   * 
   * @returns A new lease with a different key, or null if no alternatives
   */
  public reportFailure(chatId: string, errorType: 'rate_limit' | 'auth' | 'transient' | 'server_error' | 'unknown', errorMsg: string = ''): KeyLease | null {
    const currentLease = this.activeLeases.get(chatId);
    if (!currentLease) return null;

    const failedKeyIndex = currentLease.keyIndex;
    const health = this.keyHealth.get(failedKeyIndex)!;

    health.lastError = errorMsg.substring(0, 200);

    // 503/500 are Google-side overloads — NOT the key's fault.
    // Never penalize key health for server-side overload.
    if (errorType === 'server_error' || errorType === 'transient' || /timeout|timed out|deadline/i.test(errorMsg)) {
      console.warn(`[APIKeyPool] Request failed (${errorType}); rotating without a credential-health penalty.`);
      this.activeLeases.delete(chatId);
      const replacement = this.leaseKey(chatId, currentLease.purpose, failedKeyIndex, currentLease.cacheScope || chatId);
      this.notifyCapacity();
      return replacement;
    }

    health.failures++;

    console.warn(`[APIKeyPool] Key #${failedKeyIndex} failed (${errorType}); rotating immediately. All configured keys remain eligible.`);

    this.activeLeases.delete(chatId);
    const replacement = this.leaseKey(chatId, currentLease.purpose, failedKeyIndex, currentLease.cacheScope || chatId);
    this.notifyCapacity();
    return replacement;
  }

  /**
   * Report a key success — reset its failure counter.
   */
  public reportSuccess(chatId: string, successfulApiKey?: string): void {
    const lease = this.activeLeases.get(chatId);
    const successfulIndex = successfulApiKey ? this.allKeys.indexOf(successfulApiKey) : -1;
    const keyIndex = successfulIndex >= 0 ? successfulIndex : lease?.keyIndex;
    if (keyIndex == null) return;

    const health = this.keyHealth.get(keyIndex);
    if (!health) return;

    health.failures = 0; // Reset consecutive failures on success
    health.lastUsed = Date.now();
    this.rememberCacheKey(lease?.cacheScope || chatId, this.allKeys[keyIndex]);
    console.log(`[APIKeyPool] Key #${keyIndex} recovered and remains eligible for rotation.`);
  }

  /**
   * Get a key for a sub-agent, ensuring it doesn't collide with the parent's key.
   * Sub-agents get a unique lease ID: `${parentChatId}_sub_${agentName}`
   */
  public leaseSubAgentKey(parentChatId: string, agentName: string): KeyLease | null {
    const subLeaseId = `${parentChatId}_sub_${agentName}`;
    return this.leaseKey(subLeaseId, 'sub_agent');
  }

  /**
   * Release a sub-agent's key lease.
   */
  public releaseSubAgentKey(parentChatId: string, agentName: string): void {
    const subLeaseId = `${parentChatId}_sub_${agentName}`;
    this.releaseKey(subLeaseId);
  }

  /**
   * Get pool status for diagnostics.
   */
  public getPoolStatus(): {
    totalKeys: number;
    activeLeases: number;
    availableKeys: number;
    leases: Array<{ chatId: string; keyIndex: number; purpose: string; durationSec: number }>;
    healthySummary: string;
  } {
    this.initialize();
    const now = Date.now();
    const leaseCounts = this.getLeaseCountsByKey();

    let availableCount = 0;
    for (let i = 0; i < this.allKeys.length; i++) {
      availableCount += Math.max(0, this.maxParallelLeasesPerKey - (leaseCounts.get(i) || 0));
    }

    const leases = Array.from(this.activeLeases.entries()).map(([chatId, lease]) => ({
      chatId: chatId.substring(0, 12) + '...',
      keyIndex: lease.keyIndex,
      purpose: lease.purpose,
      durationSec: Math.round((now - lease.leasedAt) / 1000),
    }));

    return {
      totalKeys: this.allKeys.length,
      activeLeases: this.activeLeases.size,
      availableKeys: availableCount,
      leases,
      healthySummary: `${availableCount} slots ready, ${this.activeLeases.size} in use, all ${this.allKeys.length} configured keys eligible`,
    };
  }

  /**
   * Get the raw API key string by index. Used internally.
   */
  public getKeyByIndex(index: number): string | null {
    this.initialize();
    return this.allKeys[index] || null;
  }

  /**
   * Check if the system can accept a new parallel agent.
   */
  public canAcceptNewAgent(): boolean {
    this.initialize();
    const leaseCounts = this.getLeaseCountsByKey();

    for (let i = 0; i < this.allKeys.length; i++) {
      if ((leaseCounts.get(i) || 0) < this.maxParallelLeasesPerKey) return true;
    }

    return false;
  }

  /**
   * Classify an error message into a failure type for failover routing.
   */
  public classifyError(errorMsg: string): 'rate_limit' | 'auth' | 'transient' | 'server_error' | 'unknown' {
    const lower = errorMsg.toLowerCase();
    if (lower.includes('stream_connect_timeout') || lower.includes('stream_chunk_timeout') ||
        lower.includes('telegram_fast_timeout') || lower.includes('deadline_exceeded')) return 'unknown';
    if (lower.includes('429') || lower.includes('quota') || lower.includes('rate')) return 'rate_limit';
    if (lower.includes('401') || lower.includes('403') || lower.includes('forbidden') || lower.includes('unauthenticated') ||
        lower.includes('api_key_invalid') || lower.includes('api key not valid') || lower.includes('leaked')) return 'auth';
    // 503/500/UNAVAILABLE = Google server overload — NOT a key problem, never penalize key health
    if (lower.includes('503') || lower.includes('500') || lower.includes('unavailable') || lower.includes('service unavailable')) return 'server_error';
    // True transient network errors where key rotation may help
    if (lower.includes('fetch failed') || lower.includes('econnreset') || lower.includes('timeout') || lower.includes('network')) return 'transient';
    return 'unknown';
  }

  // ═══════════════════════════════════════════════════════════════
  // RUNTIME KEY INJECTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Inject a key at runtime (e.g., from a UI settings panel).
   * Idempotent — if key already exists, it remains eligible for rotation.
   */
  public addKey(apiKey: string): boolean {
    this.initialize();
    if (!apiKey || !apiKey.startsWith('AIza') || apiKey.length <= 20) {
      console.warn('[APIKeyPool] addKey: invalid key format, ignored.');
      return false;
    }
    const existingIdx = this.allKeys.indexOf(apiKey);
    if (existingIdx >= 0) {
      return false; // Already existed
    }
    const newIdx = this.allKeys.length;
    this.allKeys.push(apiKey);
    this.keyHealth.set(newIdx, { failures: 0, totalUses: 0, lastUsed: 0, lastError: '' });
    console.log(`[APIKeyPool] ➕ Added runtime key #${newIdx}. Total: ${this.allKeys.length}`);
    this.notifyCapacity();
    return true;
  }

  /**
   * Check if every configured key is currently at its lease capacity.
   * Used by universal-guard to know when to wait for quota reset.
   */
  public areAllKeysExhausted(): boolean {
    this.initialize();
    const leaseCounts = this.getLeaseCountsByKey();

    for (let i = 0; i < this.allKeys.length; i++) {
      if ((leaseCounts.get(i) || 0) < this.maxParallelLeasesPerKey) return false;
    }
    return true;
  }
}

// ═══════════════════════════════════════════
// PROCESS-GLOBAL SINGLETON — One pool for the entire app
// ═══════════════════════════════════════════
const globalForAPIKeyPool = globalThis as typeof globalThis & {
  __eterxAPIKeyPool?: APIKeyPool;
};

export const apiKeyPool =
  globalForAPIKeyPool.__eterxAPIKeyPool ||
  (globalForAPIKeyPool.__eterxAPIKeyPool = new APIKeyPool());
