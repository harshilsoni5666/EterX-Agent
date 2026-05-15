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

  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  /**
   * Initialize the pool by discovering all API keys from environment.
   * Called lazily on first use.
   */
  public initialize(): void {
    if (this.initialized) return;

    const discovered: Set<string> = new Set();

    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && value.startsWith('AIza') && value.length > 20) {
        discovered.add(value);
      }
    }

    this.allKeys = Array.from(discovered);

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

    // If this chatId already has a lease, return it
    const existing = this.activeLeases.get(chatId);
    if (existing) {
      return existing;
    }

    const now = Date.now();

    // Get indices of keys currently leased to OTHER chats
    const leasedIndices = new Set<number>();
    for (const lease of this.activeLeases.values()) {
      leasedIndices.add(lease.keyIndex);
    }

    // Find ready keys: not leased, not retired, and not the key that just failed.
    const candidates: { index: number; health: KeyHealth }[] = [];

    for (let i = 0; i < this.allKeys.length; i++) {
      // Skip keys currently in use by other chats
      if (leasedIndices.has(i)) continue;
      if (this.retiredKeyIndices.has(i)) continue;
      if (avoidKeyIndex === i) continue;

      const health = this.keyHealth.get(i)!;

      candidates.push({ index: i, health });
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
  public reportFailure(chatId: string, errorType: 'rate_limit' | 'auth' | 'transient' | 'unknown', errorMsg: string = ''): KeyLease | null {
    const currentLease = this.activeLeases.get(chatId);
    if (!currentLease) return null;

    const failedKeyIndex = currentLease.keyIndex;
    const health = this.keyHealth.get(failedKeyIndex)!;

    health.failures++;
    health.lastError = errorMsg.substring(0, 200);

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
  public classifyError(errorMsg: string): 'rate_limit' | 'auth' | 'transient' | 'unknown' {
    const lower = errorMsg.toLowerCase();
    if (lower.includes('429') || lower.includes('quota') || lower.includes('rate')) return 'rate_limit';
    if (lower.includes('401') || lower.includes('403') || lower.includes('forbidden') || lower.includes('unauthenticated') ||
        lower.includes('api_key_invalid') || lower.includes('api key not valid') || lower.includes('leaked')) return 'auth';
    if (lower.includes('500') || lower.includes('503') || lower.includes('unavailable') || lower.includes('fetch failed') ||
        lower.includes('econnreset') || lower.includes('timeout') || lower.includes('network')) return 'transient';
    return 'unknown';
  }
}

// ═══════════════════════════════════════════
// GLOBAL SINGLETON — One pool for the entire app
// ═══════════════════════════════════════════
export const apiKeyPool = new APIKeyPool();
