/**
 * Smart API Key Pool — Collision-Free Key Assignment with Auto-Failover
 * 
 * This is the brain of parallel agent execution. It solves:
 * 1. NO COLLISIONS: Each chat/agent gets a key that nobody else is currently using
 * 2. AUTO-FAILOVER: If a key fails (429, 403, etc.), the system auto-swaps to an unused key
 * 3. LEASE SYSTEM: Keys are "leased" to a chatId. When the chat finishes, the key is returned to the pool
 * 4. FAIR ROTATION: Keys with fewer total uses get priority (load balancing)
 * 5. HEALTH TRACKING: Failed keys are skipped immediately without timer-based waiting
/**
 * Smart API Key Pool — Collision-Free Key Assignment with Auto-Failover
 * 
 * This is the brain of parallel agent execution. It solves:
 * 1. NO COLLISIONS: Each chat/agent gets a key that nobody else is currently using
 * 2. AUTO-FAILOVER: If a key fails (429, 403, etc.), the system auto-swaps to an unused key
 * 3. LEASE SYSTEM: Keys are "leased" to a chatId. When the chat finishes, the key is returned to the pool
 * 4. FAIR ROTATION: Keys with fewer total uses get priority (load balancing)
 * 5. HEALTH TRACKING: Failed keys are skipped immediately without timer-based waiting
 * 6. PARALLEL CAPACITY: With 27 keys, easily supports 4-8+ simultaneous agents
 * 
 * Architecture:
 * - allKeys: Master list of all discovered API keys
 * - activeLeases: Map<chatId, keyIndex> — which chat is using which key
 * - keyHealth: Map<keyIndex, { failures, totalUses, lastUsed }> - per-key health
 */

export interface KeyLease {
  keyIndex: number;
  apiKey: string;
  chatId: string;
  leasedAt: number;
  purpose: 'main_agent' | 'sub_agent';
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
  private preferredKeyByOwner: Map<string, number> = new Map();
  private lastProvenKeyIndex: number | null = null;
  private retiredKeyIndices: Set<number> = new Set();
  private initialized = false;
  private autoRefreshStarted = false;

  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

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
    this.retiredKeyIndices.clear();

    this.allKeys.forEach((key, index) => {
      this.keyHealth.set(index, previousHealth.get(key) || {
        failures: 0,
        totalUses: 0,
        lastUsed: 0,
        lastError: '',
      });
    });

    this.lastProvenKeyIndex = this.lastProvenKeyIndex != null && this.lastProvenKeyIndex < this.allKeys.length
      ? this.lastProvenKeyIndex
      : null;

    for (const [ownerId, keyIndex] of Array.from(this.preferredKeyByOwner.entries())) {
      if (keyIndex >= this.allKeys.length) this.preferredKeyByOwner.delete(ownerId);
    }

    console.log(`[APIKeyPool] Runtime pool synced from Settings: ${this.allKeys.length} Gemini key(s).`);
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
    const usableKeys = this.allKeys.length - this.retiredKeyIndices.size;
    return usableKeys <= 0 ? 0 : Math.max(1, usableKeys - 2);
  }

  /**
   * LEASE a key for a specific chat/agent.
   * 
   * The algorithm picks the BEST available key:
   * 1. Filter out keys that are currently leased to other chats
   * 2. Filter out keys retired by auth/repeated failures
   * 3. Prefer proven keys for continuity
   * 4. Sort remaining by: fewest failures -> fewest total uses -> longest since last use
   * 
   * If calling for the same chatId that already has a lease, returns the existing lease.
   * 
   * @param chatId - The chat or agent identifier
   * @param purpose - Whether this is for a main agent or sub-agent
   * @returns The leased key, or null if no keys available
   */
  public leaseKey(chatId: string, purpose: 'main_agent' | 'sub_agent' = 'main_agent', avoidKeyIndex?: number): KeyLease | null {
    this.initialize();
    this.startAutoRefresh();

    // If this chatId already has a lease, return it
    const existing = this.activeLeases.get(chatId);
    if (existing) {
      return existing;
    }

    const now = Date.now();

    // 1. Try to find keys not leased to ANY chat at all
    const leasedIndices = new Set<number>();
    for (const lease of this.activeLeases.values()) {
      leasedIndices.add(lease.keyIndex);
    }

    let candidates: { index: number; health: KeyHealth }[] = [];
    for (let i = 0; i < this.allKeys.length; i++) {
      if (leasedIndices.has(i)) continue;
      if (this.retiredKeyIndices.has(i)) continue;
      if (avoidKeyIndex === i) continue;
      candidates.push({ index: i, health: this.keyHealth.get(i)! });
    }

    // 2. Fall back to allowing sharing for sub-agents/Main of the same chat if no free keys exist
    if (candidates.length === 0) {
      const leasedToOtherOwners = new Set<number>();
      const requestOwner = this.ownerIdFor(chatId);
      for (const [otherChatId, lease] of this.activeLeases.entries()) {
        if (this.ownerIdFor(otherChatId) !== requestOwner) {
          leasedToOtherOwners.add(lease.keyIndex);
        }
      }

      for (let i = 0; i < this.allKeys.length; i++) {
        if (leasedToOtherOwners.has(i)) continue;
        if (this.retiredKeyIndices.has(i)) continue;
        if (avoidKeyIndex === i) continue;
        candidates.push({ index: i, health: this.keyHealth.get(i)! });
      }
    }

    if (candidates.length === 0 && avoidKeyIndex != null && !leasedIndices.has(avoidKeyIndex) && !this.retiredKeyIndices.has(avoidKeyIndex)) {
      const health = this.keyHealth.get(avoidKeyIndex)!;
      candidates.push({ index: avoidKeyIndex, health });
      console.warn(`[APIKeyPool] No alternate ready key; retrying key #${avoidKeyIndex} immediately.`);
    }

    if (candidates.length === 0) {
      console.error(`[APIKeyPool] No ready API keys. ${leasedIndices.size} leased, ${this.retiredKeyIndices.size} retired, ${this.allKeys.length} total.`);
      return null;
    }

    const ownerId = this.ownerIdFor(chatId);
    const preferredIndex = this.preferredKeyByOwner.get(ownerId);
    const preferredCandidate = preferredIndex == null
      ? null
      : candidates.find(candidate => candidate.index === preferredIndex);
    if (preferredCandidate) {
      const lease: KeyLease = {
        keyIndex: preferredCandidate.index,
        apiKey: this.allKeys[preferredCandidate.index],
        chatId,
        leasedAt: now,
        purpose,
      };
      this.activeLeases.set(chatId, lease);
      preferredCandidate.health.totalUses++;
      preferredCandidate.health.lastUsed = now;
      console.log(`[APIKeyPool] Reusing proven key #${preferredCandidate.index} for ${purpose} [${chatId.substring(0, 8)}...]`);
      return lease;
    }

    const globalProvenCandidate = this.lastProvenKeyIndex == null
      ? null
      : candidates.find(candidate => candidate.index === this.lastProvenKeyIndex);
    if (globalProvenCandidate && purpose === 'main_agent') {
      const lease: KeyLease = {
        keyIndex: globalProvenCandidate.index,
        apiKey: this.allKeys[globalProvenCandidate.index],
        chatId,
        leasedAt: now,
        purpose,
      };
      this.activeLeases.set(chatId, lease);
      globalProvenCandidate.health.totalUses++;
      globalProvenCandidate.health.lastUsed = now;
      this.preferredKeyByOwner.set(ownerId, globalProvenCandidate.index);
      console.log(`[APIKeyPool] Reusing last proven key #${globalProvenCandidate.index} for ${purpose} [${chatId.substring(0, 8)}...]`);
      return lease;
    }

    // Sort candidates: healthiest first, then fewest uses, then longest since last use.
    candidates.sort((a, b) => {
      if (a.health.failures !== b.health.failures) {
        return a.health.failures - b.health.failures;
      }
      if (a.health.totalUses !== b.health.totalUses) {
        return a.health.totalUses - b.health.totalUses; // Fewer uses = better
      }
      return a.health.lastUsed - b.health.lastUsed; // Older = better
    });

    const picked = candidates[0];
    const lease: KeyLease = {
      keyIndex: picked.index,
      apiKey: this.allKeys[picked.index],
      chatId,
      leasedAt: now,
      purpose,
    };

    this.activeLeases.set(chatId, lease);
    picked.health.totalUses++;
    picked.health.lastUsed = now;

    console.log(`[APIKeyPool] ✅ Leased key #${picked.index} to ${purpose} [${chatId.substring(0, 8)}...] (${this.activeLeases.size}/${this.allKeys.length} in use, ${candidates.length - 1} available)`);

    return lease;
  }

  /**
   * Lease a user-provided key when settings explicitly supplied one.
   * This keeps the same no-collision lease semantics as the general pool:
   * if another active chat is using this key, the caller must wait/fallback.
   */
  public leaseSpecificKey(chatId: string, apiKey: string, purpose: 'main_agent' | 'sub_agent' = 'main_agent'): KeyLease | null {
    this.initialize();
    this.startAutoRefresh();

    const key = String(apiKey || '').trim();
    if (!key || !key.startsWith('AIza') || key.length <= 20) return null;

    this.addKey(key);
    const keyIndex = this.allKeys.indexOf(key);
    if (keyIndex < 0 || this.retiredKeyIndices.has(keyIndex)) return null;

    const existing = this.activeLeases.get(chatId);
    if (existing) {
      return existing.keyIndex === keyIndex ? existing : null;
    }

    for (const lease of this.activeLeases.values()) {
      if (lease.keyIndex === keyIndex) return null;
    }

    const health = this.keyHealth.get(keyIndex);
    if (!health) return null;

    const now = Date.now();
    const lease: KeyLease = {
      keyIndex,
      apiKey: key,
      chatId,
      leasedAt: now,
      purpose,
    };

    this.activeLeases.set(chatId, lease);
    health.totalUses++;
    health.lastUsed = now;
    this.preferredKeyByOwner.set(this.ownerIdFor(chatId), keyIndex);
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
    // Never penalize key health or retire keys for server-side overload.
    if (errorType === 'server_error') {
      console.warn(`[APIKeyPool] Key #${failedKeyIndex} got server overload (503/500); rotating without health penalty.`);
      this.activeLeases.delete(chatId);
      return this.leaseKey(chatId, currentLease.purpose, failedKeyIndex);
    }

    health.failures++;

    const retireKey = errorType === 'auth' || health.failures >= APIKeyPool.MAX_CONSECUTIVE_FAILURES;
    if (retireKey) {
      this.retiredKeyIndices.add(failedKeyIndex);
      console.error(`[APIKeyPool] Retired key #${failedKeyIndex} after ${health.failures} failure(s): ${errorType}.`);
    } else {
      console.warn(`[APIKeyPool] Key #${failedKeyIndex} failed (${errorType}); rotating immediately.`);
    }

    if (this.preferredKeyByOwner.get(this.ownerIdFor(chatId)) === failedKeyIndex) {
      this.preferredKeyByOwner.delete(this.ownerIdFor(chatId));
    }
    if (this.lastProvenKeyIndex === failedKeyIndex) {
      this.lastProvenKeyIndex = null;
    }

    this.activeLeases.delete(chatId);
    return this.leaseKey(chatId, currentLease.purpose, retireKey ? undefined : failedKeyIndex);
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
    this.retiredKeyIndices.delete(keyIndex);
    this.preferredKeyByOwner.set(this.ownerIdFor(chatId), keyIndex);
    this.lastProvenKeyIndex = keyIndex;
    console.log(`[APIKeyPool] Proven key #${keyIndex} saved for [${this.ownerIdFor(chatId).substring(0, 16)}...]`);
  }

  private ownerIdFor(chatId: string): string {
    const telegram = chatId.match(/^telegram-\d+/);
    if (telegram) return telegram[0];
    const subAgent = chatId.match(/^(.*)_sub_/);
    if (subAgent) return subAgent[1];
    return chatId;
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
    retiredKeys: number;
    cooldownKeys: number;
    leases: Array<{ chatId: string; keyIndex: number; purpose: string; durationSec: number }>;
    healthySummary: string;
  } {
    this.initialize();
    const now = Date.now();
    const leasedIndices = new Set<number>();
    for (const lease of this.activeLeases.values()) {
      leasedIndices.add(lease.keyIndex);
    }

    const retiredCount = this.retiredKeyIndices.size;
    let availableCount = 0;
    for (let i = 0; i < this.allKeys.length; i++) {
      if (leasedIndices.has(i)) continue;
      if (this.retiredKeyIndices.has(i)) continue;
      availableCount++;
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
      retiredKeys: retiredCount,
      cooldownKeys: 0,
      leases,
      healthySummary: `${availableCount} ready, ${this.activeLeases.size} in use, ${retiredCount} retired`,
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
    const leasedIndices = new Set<number>();
    for (const lease of this.activeLeases.values()) {
      leasedIndices.add(lease.keyIndex);
    }

    for (let i = 0; i < this.allKeys.length; i++) {
      if (leasedIndices.has(i)) continue;
      if (!this.retiredKeyIndices.has(i)) return true;
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
  // HOT-RELOAD: Runtime key discovery and injection
  // ═══════════════════════════════════════════════════════════════

  /**
   * Re-scan process.env for any new AIza* keys that appeared since last scan.
   * Safe to call at any time — idempotent, never removes existing keys.
   * @returns number of NEW keys discovered
   */
  public hotReload(): number {
    this.initialize();
    return 0;
  }

  /**
   * Inject a key at runtime (e.g., from a UI settings panel).
   * Idempotent — if key already exists, just un-retires it.
   */
  public addKey(apiKey: string): boolean {
    this.initialize();
    if (!apiKey || !apiKey.startsWith('AIza') || apiKey.length <= 20) {
      console.warn('[APIKeyPool] addKey: invalid key format, ignored.');
      return false;
    }
    const existingIdx = this.allKeys.indexOf(apiKey);
    if (existingIdx >= 0) {
      // Un-retire it if it was retired
      if (this.retiredKeyIndices.has(existingIdx)) {
        this.retiredKeyIndices.delete(existingIdx);
        const health = this.keyHealth.get(existingIdx);
        if (health) health.failures = 0;
        console.log(`[APIKeyPool] 🔑 Re-activated retired key #${existingIdx}`);
      }
      return false; // Already existed
    }
    const newIdx = this.allKeys.length;
    this.allKeys.push(apiKey);
    this.keyHealth.set(newIdx, { failures: 0, totalUses: 0, lastUsed: 0, lastError: '' });
    console.log(`[APIKeyPool] ➕ Added runtime key #${newIdx}. Total: ${this.allKeys.length}`);
    return true;
  }

  /**
   * Remove (permanently retire) a key by value.
   */
  public removeKey(apiKey: string): boolean {
    this.initialize();
    const idx = this.allKeys.indexOf(apiKey);
    if (idx < 0) return false;
    this.retiredKeyIndices.add(idx);
    // Release any leases using this key
    for (const [chatId, lease] of this.activeLeases.entries()) {
      if (lease.keyIndex === idx) {
        this.activeLeases.delete(chatId);
        console.warn(`[APIKeyPool] Evicted lease for [${chatId.substring(0, 8)}...] because key #${idx} was removed.`);
      }
    }
    console.log(`[APIKeyPool] ➖ Removed key #${idx}. ${this.retiredKeyIndices.size} retired.`);
    return true;
  }

  /**
   * Un-retire rate-limited keys that have been cooling for >= 65 seconds.
   * 65s = one full quota window. Called automatically on a 60s interval.
   */
  public unretireStaleKeys(): number {
    this.initialize();
    const now = Date.now();
    const COOLDOWN_MS = 65_000;
    let unretiredCount = 0;

    for (const retiredIdx of Array.from(this.retiredKeyIndices)) {
      const health = this.keyHealth.get(retiredIdx);
      if (!health) continue;

      // Only un-retire rate-limited keys (not auth failures)
      const wasRateLimited = !health.lastError.toLowerCase().includes('401') &&
                             !health.lastError.toLowerCase().includes('403') &&
                             !health.lastError.toLowerCase().includes('auth') &&
                             !health.lastError.toLowerCase().includes('forbidden');

      if (wasRateLimited && (now - health.lastUsed) >= COOLDOWN_MS) {
        this.retiredKeyIndices.delete(retiredIdx);
        health.failures = 0;
        unretiredCount++;
        console.log(`[APIKeyPool] ♻️ Un-retired key #${retiredIdx} after ${Math.round((now - health.lastUsed) / 1000)}s cooldown`);
      }
    }

    if (unretiredCount > 0) {
      console.log(`[APIKeyPool] ✅ ${unretiredCount} key(s) un-retired and back in rotation`);
    }
    return unretiredCount;
  }

  /**
   * Start background auto-refresh:
   *   - Every 5 minutes: hot-reload env for new keys
   *   - Every 65 seconds: un-retire cooled rate-limited keys
   */
  public startAutoRefresh(): void {
    if (this.autoRefreshStarted) return;
    this.autoRefreshStarted = true;

    // Un-retire cooled keys every 65s
    setInterval(() => {
      this.unretireStaleKeys();
    }, 65_000).unref?.();

    // Environment scans are disabled. Settings is the source of truth.


    console.log('[APIKeyPool] Auto-refresh started (key un-retire: 65s, Settings-controlled key pool)');
  }

  /**
   * Check if ALL non-retired keys are currently rate-limited (leased + failed).
   * Used by universal-guard to know when to wait for quota reset.
   */
  public areAllKeysExhausted(): boolean {
    this.initialize();
    const leasedIndices = new Set<number>();
    for (const lease of this.activeLeases.values()) leasedIndices.add(lease.keyIndex);

    for (let i = 0; i < this.allKeys.length; i++) {
      if (this.retiredKeyIndices.has(i)) continue;
      if (!leasedIndices.has(i)) return false; // At least one free key
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
