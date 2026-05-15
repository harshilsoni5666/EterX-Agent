import { MemoryEntry, ProjectContext } from '../schemas';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'path';

const MEMORY_DIR = path.resolve(process.cwd(), '.workspaces', '.memory');
const STORE_FILE = path.join(MEMORY_DIR, 'memory_store.json');
const PREFS_FILE = path.join(MEMORY_DIR, 'user_preferences.json');
const ERROR_LOG_FILE = path.join(MEMORY_DIR, 'error_log.json');

/**
 * Enhanced MemoryManager
 * 
 * Layer 5: Manages Short-Term, Episodic, Semantic, and Project Memory.
 * 
 * NEW:
 * - File-backed persistence (survives restarts)
 * - Conversation summarization
 * - User preference learning
 * - Error logging for self-improvement
 * - Importance-weighted retrieval
 * - Tag-based memory search
 */
export class MemoryManager {
  private inMemoryStore: Map<string, MemoryEntry[]> = new Map();
  private userPreferences: Map<string, any> = new Map();
  private errorLog: Array<{ timestamp: number, tool: string, error: string, context: string }> = [];
  private initialized = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistPending = false;

  /**
   * Initialize: Load persisted memories from disk.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      await fs.ensureDir(MEMORY_DIR);

      // Parallel file reads — all 3 at once
      const [storeRes, prefsRes, errRes] = await Promise.allSettled([
        fs.pathExists(STORE_FILE).then(e => e ? fs.readJSON(STORE_FILE) : null),
        fs.pathExists(PREFS_FILE).then(e => e ? fs.readJSON(PREFS_FILE) : null),
        fs.pathExists(ERROR_LOG_FILE).then(e => e ? fs.readJSON(ERROR_LOG_FILE) : null),
      ]);

      if (storeRes.status === 'fulfilled' && storeRes.value) {
        for (const [key, entries] of Object.entries(storeRes.value)) {
          this.inMemoryStore.set(key, entries as MemoryEntry[]);
        }
      }
      if (prefsRes.status === 'fulfilled' && prefsRes.value) {
        for (const [key, value] of Object.entries(prefsRes.value)) {
          this.userPreferences.set(key, value);
        }
      }
      if (errRes.status === 'fulfilled' && errRes.value) {
        this.errorLog = errRes.value;
      }

      this.initialized = true;
    } catch (error: any) {
      console.warn(`[MemoryManager] Failed to load persisted memory: ${error.message}. Starting fresh.`);
      this.initialized = true;
    }
  }

  /**
   * Persist all memories to disk.
   */
  private async persist(): Promise<void> {
    try {
      await fs.ensureDir(MEMORY_DIR);

      // Save memory store
      const storeObj: Record<string, MemoryEntry[]> = {};
      for (const [key, entries] of this.inMemoryStore.entries()) {
        // Keep last 100 entries per project to avoid unbounded growth
        storeObj[key] = entries.slice(-100);
      }
      await fs.writeJSON(STORE_FILE, storeObj, { spaces: 2 });

      // Save preferences
      const prefsObj: Record<string, any> = {};
      for (const [key, value] of this.userPreferences.entries()) {
        prefsObj[key] = value;
      }
      await fs.writeJSON(PREFS_FILE, prefsObj, { spaces: 2 });

      // Save error log (keep last 200)
      await fs.writeJSON(ERROR_LOG_FILE, this.errorLog.slice(-200), { spaces: 2 });
    } catch (error: any) {
      console.warn(`[MemoryManager] Failed to persist memory: ${error.message}`);
    }
  }

  /**
   * Initialize or retrieve context for a given project namespace.
   * Enhanced with user preferences and error history.
   */
  public getProjectContext(projectId: string): ProjectContext {
    const recentMemories = this.inMemoryStore.get(projectId) || [];
    
    // Sort by importance and recency, return top 20
    const sortedMemories = [...recentMemories]
      .sort((a, b) => {
        const importanceDiff = ((b as any).importance || 5) - ((a as any).importance || 5);
        if (importanceDiff !== 0) return importanceDiff;
        return b.timestamp - a.timestamp;
      })
      .slice(0, 20);

    // Collect user preferences relevant to this project
    const prefs: Record<string, any> = {};
    for (const [key, value] of this.userPreferences.entries()) {
      if (key.startsWith(`${projectId}:`) || key.startsWith('global:')) {
        const shortKey = key.split(':').slice(1).join(':');
        prefs[shortKey] = value;
      }
    }

    // Recent errors for this project
    const recentErrors = this.errorLog
      .filter(e => e.context.includes(projectId))
      .slice(-5)
      .map(e => `[${new Date(e.timestamp).toISOString()}] ${e.tool}: ${e.error}`);

    return {
      projectId,
      conversationSummary: this.getConversationSummary(projectId),
      uploadedFiles: [],
      recentMemories: sortedMemories,
      userPreferences: prefs,
      errorHistory: recentErrors
    };
  }

  /**
   * Auto-generate a conversation summary from recent memories.
   */
  private getConversationSummary(projectId: string): string {
    const memories = this.inMemoryStore.get(projectId) || [];
    if (memories.length === 0) return "No recent conversation.";

    const recent = memories.slice(-10);
    const summaryParts = recent
      .filter(m => m.type === 'task_result' || m.type === 'conversation_summary')
      .map(m => m.content.substring(0, 100));

    if (summaryParts.length === 0) return "Active project with recent tasks.";
    return `Recent activity: ${summaryParts.join(' | ')}`;
  }

  /**
   * Save an episodic memory (an event or tool result from a past task).
   * Enhanced with importance and tags.
   */
  public saveEpisodicMemory(
    projectId: string, 
    content: string, 
    type: MemoryEntry['type'] = 'task_result',
    importance: number = 5,
    tags: string[] = []
  ): void {
    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type,
      content,
      importance,
      tags
    };

    if (!this.inMemoryStore.has(projectId)) {
      this.inMemoryStore.set(projectId, []);
    }
    this.inMemoryStore.get(projectId)!.push(entry);
    console.log(`[MemoryManager] Saved episodic memory to project ${projectId}: ${content.substring(0, 30)}...`);
    
    // Debounced persist
    this.debouncedPersist();
  }

  /** Debounced persist — batches multiple mutations into one disk write */
  private debouncedPersist(): void {
    this.persistPending = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.persistPending) {
        this.persistPending = false;
        this.persist().catch(() => {});
      }
    }, 3000);
  }

  public async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistPending) return;
    this.persistPending = false;
    await this.persist();
  }

  /**
   * Save a semantic memory (long-term knowledge, facts, rules).
   */
  public saveSemanticMemory(userId: string, key: string, value: any): void {
    this.userPreferences.set(`${userId}:${key}`, value);
    console.log(`[MemoryManager] Saved semantic memory for user ${userId}: [${key}]`);
    this.debouncedPersist();
  }

  /**
   * Retrieve semantic memory.
   */
  public getSemanticMemory(userId: string, key: string): any {
    return this.userPreferences.get(`${userId}:${key}`);
  }

  /**
   * Learn a user preference automatically.
   */
  public learnPreference(userId: string, category: string, preference: string, value: any): void {
    const key = `global:${category}.${preference}`;
    this.userPreferences.set(key, { value, learnedAt: Date.now(), userId });
    console.log(`[MemoryManager] 🧠 Learned preference: ${category}.${preference} = ${JSON.stringify(value)}`);
    this.debouncedPersist();
  }

  /**
   * Get all learned preferences for a user.
   */
  public getAllPreferences(userId: string): Record<string, any> {
    const prefs: Record<string, any> = {};
    for (const [key, value] of this.userPreferences.entries()) {
      if (key.startsWith('global:') || key.startsWith(`${userId}:`)) {
        prefs[key] = value;
      }
    }
    return prefs;
  }

  /**
   * Log a tool error for self-improvement analysis.
   */
  public logError(tool: string, error: string, context: string): void {
    this.errorLog.push({
      timestamp: Date.now(),
      tool,
      error: error.substring(0, 500),
      context: context.substring(0, 200)
    });
    console.log(`[MemoryManager] 📝 Error logged: ${tool} - ${error.substring(0, 50)}`);
    this.debouncedPersist();
  }

  /**
   * Get error patterns for self-improvement.
   */
  public getErrorPatterns(): { tool: string, count: number, lastError: string }[] {
    const errorCounts: Map<string, { count: number, lastError: string }> = new Map();
    
    for (const err of this.errorLog) {
      const existing = errorCounts.get(err.tool);
      if (existing) {
        existing.count++;
        existing.lastError = err.error;
      } else {
        errorCounts.set(err.tool, { count: 1, lastError: err.error });
      }
    }

    return Array.from(errorCounts.entries())
      .map(([tool, data]) => ({ tool, ...data }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Search memories by content or tags.
   */
  public searchMemories(projectId: string, query: string): MemoryEntry[] {
    const memories = this.inMemoryStore.get(projectId) || [];
    const lowerQuery = query.toLowerCase();
    
    return memories.filter(m => 
      m.content.toLowerCase().includes(lowerQuery) ||
      (m.tags && m.tags.some(t => t.toLowerCase().includes(lowerQuery)))
    );
  }

  /**
   * Get memory statistics.
   */
  public getStats(): { projects: number, totalMemories: number, preferences: number, errors: number } {
    let totalMemories = 0;
    for (const entries of this.inMemoryStore.values()) {
      totalMemories += entries.length;
    }
    return {
      projects: this.inMemoryStore.size,
      totalMemories,
      preferences: this.userPreferences.size,
      errors: this.errorLog.length
    };
  }
}

export const globalMemoryManager = new MemoryManager();

// Auto-initialize on import
globalMemoryManager.initialize().catch(err => {
  console.warn(`[MemoryManager] Background init failed: ${err.message}`);
});
