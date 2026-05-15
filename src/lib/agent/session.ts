import fs from 'fs-extra';
import path from 'path';

/**
 * SessionStateManager v2 — Persistent Session Continuity + Self-Review Engine
 * 
 * v2 UPGRADES:
 * - Rich file tracking: stores file purpose + content snapshot, not just paths
 * - Self-review: can read back created files to understand what was built
 * - Smart "work more" support: knows what was created and what can be enhanced
 * - Task plan persistence: remembers the decomposed plan and completed steps
 * - Edit history: tracks what was modified, not just what was created
 */

const SESSION_DIR = path.resolve(process.cwd(), '.workspaces', '.session');
const STATE_FILE = path.join(SESSION_DIR, 'state.json'); // Legacy fallback
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSION_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours absolute max
const STALE_CLEANUP_MS = 24 * 60 * 60 * 1000; // 24 hours — auto-GC

/** Rich file record — tracks what was done to each file and why */
interface FileRecord {
  filename: string;
  action: 'created' | 'edited' | 'deleted';
  purpose: string;       // Why this file was created/edited
  contentPreview: string; // First 150 chars of content
  sizeBytes: number;
  timestamp: number;
}

export interface SessionState {
  /** Normalized tool call signatures that have been executed */
  callHistory: string[];
  /** Files that have been written in this session (paths only, for dedup) */
  writtenFiles: string[];
  /** Rich file records with content previews */
  fileRecords: FileRecord[];
  /** Skills loaded via get_skill_guidelines */
  loadedSkills: string[];
  /** Whether task_decomposer was already used */
  taskDecomposerUsed: boolean;
  /** Per-tool call counts */
  toolCallCounts: Record<string, number>;

  /** Last user message (for "continue" context) */
  lastUserMessage: string;
  /** Summary of what the agent accomplished */
  actionSummary: string[];
  /** The agent's final answer text from last message */
  lastAgentOutput: string;
  /** Current task plan steps (from task_decomposer or tracker) */
  taskPlanSteps: Array<{ name: string; status: 'pending' | 'done'; description?: string }>;
  /** Timestamp of last activity */
  lastActivityAt: number;
  /** Session creation timestamp */
  createdAt: number;
  /** Total message count in this session */
  messageCount: number;
  /** Chat ID this session belongs to (for isolation verification) */
  boundChatId: string;
  /** Digest of tool results to maintain memory across turns */
  toolResultDigest: Array<{ tool: string; args: string; result: string; iteration: number }>;
}

const EMPTY_STATE: SessionState = {
  callHistory: [],
  writtenFiles: [],
  fileRecords: [],
  loadedSkills: [],
  taskDecomposerUsed: false,
  toolCallCounts: {},

  lastUserMessage: '',
  actionSummary: [],
  lastAgentOutput: '',
  taskPlanSteps: [],
  lastActivityAt: Date.now(),
  createdAt: Date.now(),
  messageCount: 0,
  boundChatId: '',
  toolResultDigest: [],
};

export class SessionStateManager {
  private state: SessionState = { ...EMPTY_STATE };
  private loaded = false;
  private currentProjectId: string | null = null;

  // === PER-CHAT SESSION ISOLATION ===
  // Each chatId gets its own state file: .session/{chatId}.json
  // This prevents concurrent chats from corrupting each other's state.
  private activeChatSessions: Map<string, SessionState> = new Map();
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _savePending = false;

  /** Resolve the state file path for a given chatId */
  private getStateFilePath(chatId?: string): string {
    if (chatId) {
      // Per-chat isolated file
      return path.join(SESSION_DIR, `${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    }
    return STATE_FILE; // Legacy fallback
  }

  private isIsolatedSessionId(projectId?: string | null): boolean {
    return !!projectId && /^(telegram|whatsapp)-/i.test(projectId);
  }

  /**
   * Load session state from disk. Returns true if a valid (non-expired) session was restored.
   */
  public async load(chatId?: string): Promise<boolean> {
    try {
      const stateFile = this.getStateFilePath(chatId || this.currentProjectId || undefined);
      
      if (!await fs.pathExists(stateFile)) {
        this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), boundChatId: chatId || '' };
        this.loaded = true;
        return false;
      }

      const data = await fs.readJson(stateFile);

      // Check if session is expired (idle too long)
      const elapsed = Date.now() - (data.lastActivityAt || 0);
      if (elapsed > SESSION_TIMEOUT_MS) {
        console.log(`[Session] ⏰ Session expired (${ (elapsed / 60000).toFixed(1) } min idle). Starting fresh.`);
        this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), messageCount: 0, boundChatId: '' };
        this.loaded = true;
        await this.save();
        return false;
      }

      // BUG FIX: Check if session is TOO OLD (absolute age, not just idle time)
      const absoluteAge = Date.now() - (data.createdAt || 0);
      const MAX_SESSION_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours absolute max
      if (absoluteAge > MAX_SESSION_AGE_MS) {
        console.log(`[Session] 🕐 Session too old (${ (absoluteAge / 60000).toFixed(1) } min absolute age). Starting fresh.`);
        this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), messageCount: 0, boundChatId: '' };
        this.loaded = true;
        await this.save();
        return false;
      }

      this.state = {
        callHistory: Array.isArray(data.callHistory) ? data.callHistory : [],
        writtenFiles: Array.isArray(data.writtenFiles) ? data.writtenFiles : [],
        fileRecords: Array.isArray(data.fileRecords) ? data.fileRecords : [],
        loadedSkills: Array.isArray(data.loadedSkills) ? data.loadedSkills : [],
        taskDecomposerUsed: !!data.taskDecomposerUsed,
        toolCallCounts: data.toolCallCounts || {},

        lastUserMessage: data.lastUserMessage || '',
        actionSummary: Array.isArray(data.actionSummary) ? data.actionSummary : [],
        lastAgentOutput: data.lastAgentOutput || '',
        taskPlanSteps: Array.isArray(data.taskPlanSteps) ? data.taskPlanSteps : [],
        lastActivityAt: Date.now(),
        createdAt: data.createdAt || Date.now(),
        messageCount: data.messageCount || 0,
        boundChatId: data._projectId || '',
        toolResultDigest: Array.isArray(data.toolResultDigest) ? data.toolResultDigest : [],
      };
      this.loaded = true;
      this.currentProjectId = data._projectId || null;

      const sessionAge = ((Date.now() - this.state.createdAt) / 60000).toFixed(1);
      console.log(`[Session] ✅ Restored session (${ sessionAge } min old, project: ${ this.currentProjectId || 'unknown' }) — ${ this.state.callHistory.length } calls, ${ this.state.fileRecords.length } files tracked, ${ this.state.loadedSkills.length } skills`);
      return true;
    } catch (err: any) {
      console.warn(`[Session] ⚠️ Failed to load session: ${ err.message }`);
      this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), messageCount: 0, boundChatId: '' };
      this.loaded = true;
      return false;
    }
  }

  /**
   * Load session for a specific project/conversation.
   * If the stored session belongs to a DIFFERENT project, reset it.
   * This prevents stale state from old conversations bleeding into new ones.
   * 
   * v3: Now uses per-chatId state files for true session isolation.
   */
  public async loadForProject(projectId: string): Promise<boolean> {
    // FAST PATH: If already loaded for this exact project, skip disk I/O entirely
    if (this.loaded && this.currentProjectId === projectId && this.state.boundChatId === projectId) {
      this.state.lastActivityAt = Date.now();
      return true;
    }

    // Try loading the per-chat session file first
    const chatStateFile = this.getStateFilePath(projectId);
    
    try {
      if (await fs.pathExists(chatStateFile)) {
        const data = await fs.readJson(chatStateFile);
        
        // Check expiration
        const elapsed = Date.now() - (data.lastActivityAt || 0);
        if (elapsed > SESSION_TIMEOUT_MS) {
          console.log(`[Session] ⏰ Chat session ${projectId} expired (${(elapsed / 60000).toFixed(1)} min idle). Starting fresh.`);
          this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), boundChatId: projectId, messageCount: 0 };
          this.currentProjectId = projectId;
          await this.save();
          return false;
        }
        
        const absoluteAge = Date.now() - (data.createdAt || 0);
        if (absoluteAge > MAX_SESSION_AGE_MS) {
          console.log(`[Session] Chat session ${projectId} too old (${(absoluteAge / 60000).toFixed(1)} min). Starting fresh.`);
          this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), boundChatId: projectId, messageCount: 0 };
          this.currentProjectId = projectId;
          await this.save();
          return false;
        }

        this.state = {
          callHistory: Array.isArray(data.callHistory) ? data.callHistory : [],
          writtenFiles: Array.isArray(data.writtenFiles) ? data.writtenFiles : [],
          fileRecords: Array.isArray(data.fileRecords) ? data.fileRecords : [],
          loadedSkills: Array.isArray(data.loadedSkills) ? data.loadedSkills : [],
          taskDecomposerUsed: !!data.taskDecomposerUsed,
          toolCallCounts: data.toolCallCounts || {},
          lastUserMessage: data.lastUserMessage || '',
          actionSummary: Array.isArray(data.actionSummary) ? data.actionSummary : [],
          lastAgentOutput: data.lastAgentOutput || '',
          taskPlanSteps: Array.isArray(data.taskPlanSteps) ? data.taskPlanSteps : [],
          lastActivityAt: Date.now(),
          createdAt: data.createdAt || Date.now(),
          messageCount: data.messageCount || 0,
          boundChatId: projectId,
          toolResultDigest: Array.isArray(data.toolResultDigest) ? data.toolResultDigest : [],
        };
        this.currentProjectId = projectId;
        this.loaded = true;
        
        // Cache in memory for fast access
        this.activeChatSessions.set(projectId, { ...this.state });
        
        const sessionAge = ((Date.now() - this.state.createdAt) / 60000).toFixed(1);
        console.log(`[Session] ✅ Restored ISOLATED session for chat ${projectId.substring(0, 8)}… (${sessionAge} min old, ${this.state.callHistory.length} calls, ${this.state.fileRecords.length} files, msg #${this.state.messageCount})`);
        return true;
      }
    } catch (err: any) {
      console.warn(`[Session] ⚠️ Failed to load chat session: ${err.message}`);
    }
    
    // Telegram/WhatsApp sessions must never read the legacy shared state. That
    // file can contain browser/UI memory and causes cross-chat contamination.
    if (this.isIsolatedSessionId(projectId)) {
      this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), boundChatId: projectId, messageCount: 0 };
      this.currentProjectId = projectId;
      this.loaded = true;
      this.activeChatSessions.set(projectId, { ...this.state });
      return false;
    }

    // Fallback: try legacy shared session, then migrate it
    const restored = await this.load();
    if (restored && this.currentProjectId && this.currentProjectId !== projectId) {
      console.log(`[Session] 🔄 Project changed (${this.currentProjectId} → ${projectId}). Clearing stale session.`);
      this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), boundChatId: projectId, messageCount: 0 };
      this.currentProjectId = projectId;
      await this.save();
      return false;
    }
    
    this.currentProjectId = projectId;
    this.state.boundChatId = projectId;
    return restored;
  }

  /** Get the current project ID this session is bound to */
  public getCurrentProjectId(): string | null {
    return this.currentProjectId;
  }

  /**
   * Save current session state to disk.
   * v3: Saves to per-chat state file for isolation.
   */
  public async save(): Promise<void> {
    try {
      this.state.lastActivityAt = Date.now();
      await fs.ensureDir(SESSION_DIR);
      
      // Save to per-chat file (primary) + legacy file in PARALLEL
      const chatId = this.currentProjectId || this.state.boundChatId;
      const writes: Promise<void>[] = [];
      
      if (chatId) {
        const chatFile = this.getStateFilePath(chatId);
        writes.push(fs.writeJson(chatFile, { ...this.state, _projectId: chatId }, { spaces: 2 }));
        // Update in-memory cache
        this.activeChatSessions.set(chatId, { ...this.state });
      }
      
      // Also save to legacy file for backward compatibility, but never let
      // isolated Telegram/WhatsApp chats overwrite the shared browser/UI state.
      if (!this.isIsolatedSessionId(chatId)) {
        writes.push(fs.writeJson(STATE_FILE, { ...this.state, _projectId: this.currentProjectId }, { spaces: 2 }));
      }
      
      await Promise.all(writes);
    } catch (err: any) {
      console.warn(`[Session] ⚠️ Failed to save session: ${ err.message }`);
    }
  }

  /** Debounced save — batches multiple state mutations into one disk write */
  public debouncedSave(): void {
    this._savePending = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._savePending) {
        this._savePending = false;
        this.save().catch(() => {});
      }
    }, 3000);
  }

  /**
   * Hydrate ReAct loop state from the persisted session.
   */
  public hydrate(): {
    callHistory: Set<string>;
    writtenFiles: Set<string>;
    loadedSkills: Set<string>;
    taskDecomposerUsed: boolean;
    toolCallCounts: Map<string, number>;
    toolResultDigest: Array<{ tool: string; args: string; result: string; iteration: number }>;
  } {
    return {
      callHistory: new Set(this.state.callHistory),
      writtenFiles: new Set(this.state.writtenFiles),
      loadedSkills: new Set(this.state.loadedSkills),
      taskDecomposerUsed: this.state.taskDecomposerUsed,
      toolCallCounts: new Map(Object.entries(this.state.toolCallCounts)),
      toolResultDigest: [...this.state.toolResultDigest],
    };
  }

  /**
   * Persist the current loop state back to the session.
   */
  public updateFromLoop(partial: {
    callHistory: Set<string>;
    writtenFiles: Set<string>;
    loadedSkills: Set<string>;
    taskDecomposerUsed: boolean;
    toolCallCounts: Map<string, number>;
    toolResultDigest?: Array<{ tool: string; args: string; result: string; iteration: number }>;
  }) {
    if (partial.callHistory) this.state.callHistory = Array.from(partial.callHistory);
    if (partial.writtenFiles) this.state.writtenFiles = Array.from(partial.writtenFiles);
    if (partial.loadedSkills) this.state.loadedSkills = Array.from(partial.loadedSkills);
    if (partial.taskDecomposerUsed !== undefined) this.state.taskDecomposerUsed = partial.taskDecomposerUsed;
    if (partial.toolCallCounts) this.state.toolCallCounts = Object.fromEntries(partial.toolCallCounts);
    if (partial.toolResultDigest) this.state.toolResultDigest = [...partial.toolResultDigest];

  }

  /** Record the user's message for "continue" context. */
  public setLastUserMessage(message: string): void {
    this.state.lastUserMessage = message;
  }

  /** Get the last user message (for "continue" routing). */
  public getLastUserMessage(): string {
    return this.state.lastUserMessage;
  }

  /** Store the agent's final answer so it can review its own output. */
  public setLastAgentOutput(output: string): void {
    // Keep last 1500 chars for meaningful context on follow-up messages
    this.state.lastAgentOutput = output.substring(0, 1500);
  }

  /** Get the agent's last output. */
  public getLastAgentOutput(): string {
    return this.state.lastAgentOutput;
  }

  /**
   * Track a file with rich metadata — what was done and why.
   * Called from the ReAct loop when workspace_write_file or workspace_edit_file succeeds.
   */
  public trackFile(filename: string, action: 'created' | 'edited' | 'deleted', purpose: string, content?: string): void {
    // Remove existing record for this file (update in place)
    this.state.fileRecords = this.state.fileRecords.filter(r => r.filename !== filename);

    this.state.fileRecords.push({
      filename,
      action,
      purpose: purpose.substring(0, 100),
      contentPreview: (content || '').substring(0, 150).replace(/\n/g, ' '),
      sizeBytes: content ? content.length : 0,
      timestamp: Date.now(),
    });

    // Cap at 15 most recent file records
    if (this.state.fileRecords.length > 15) {
      this.state.fileRecords = this.state.fileRecords.slice(-15);
    }
  }

  /**
   * Store the current task plan steps for progress tracking.
   */
  public setTaskPlan(steps: Array<{ name: string; status: 'pending' | 'done'; description?: string }>): void {
    this.state.taskPlanSteps = steps.slice(0, 20); // Cap at 20 steps
  }

  /** Add a human-readable action summary entry. */
  public addAction(action: string): void {
    this.state.actionSummary.push(action);
    if (this.state.actionSummary.length > 15) {
      this.state.actionSummary = this.state.actionSummary.slice(-15);
    }
  }

  /** Get the human-readable action summary. */
  public getActions(): string[] {
    return this.state.actionSummary || [];
  }

  /**
   * SELF-REVIEW: Read back the actual files the agent created in this session.
   * Returns a compact summary of each file's current content.
   * This lets the agent "see" its own work when the user says "work more on it".
   */
  public async selfReview(): Promise<string> {
    if (this.state.fileRecords.length === 0) return '';

    const reviews: string[] = [];

    for (const record of this.state.fileRecords.slice(-8)) { // Review last 8 files max
      try {
        const fullPath = path.isAbsolute(record.filename)
          ? record.filename
          : path.resolve(process.cwd(), record.filename);

        if (await fs.pathExists(fullPath)) {
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          const lineCount = lines.length;
          const sizeKB = (content.length / 1024).toFixed(1);

          // Smart preview: first 5 lines + last 2 lines for context
          let preview: string;
          if (lineCount <= 10) {
            preview = content.substring(0, 300);
          } else {
            const head = lines.slice(0, 5).join('\n');
            const tail = lines.slice(-2).join('\n');
            preview = `${ head }\n... (${ lineCount - 7 } more lines) ...\n${ tail }`;
            if (preview.length > 400) preview = preview.substring(0, 400);
          }

          reviews.push(`📄 ${ record.filename } (${ record.action }, ${ lineCount } lines, ${ sizeKB }KB):\n${ preview }`);
        } else {
          reviews.push(`⚠️ ${ record.filename } — file no longer exists`);
        }
      } catch {
        reviews.push(`⚠️ ${ record.filename } — could not read`);
      }
    }

    return reviews.length > 0
      ? `━━━ SELF-REVIEW: Your Previous Output ━━━\n${ reviews.join('\n\n') }\n━━━ END REVIEW ━━━`
      : '';
  }

  /**
   * Generate a concise session summary for injection into system prompt.
   * Returns empty string if nothing meaningful happened yet.
   */
  public getSessionSummary(): string {
    if (this.state.actionSummary.length === 0 && this.state.fileRecords.length === 0 && !this.state.lastUserMessage) {
      return '';
    }

    const parts: string[] = [];

    if (this.state.lastUserMessage) {
      parts.push(`Previous task: "${ this.state.lastUserMessage.substring(0, 120) }"`);
    }

    // Rich file summary — shows what was created and what it contains
    if (this.state.fileRecords.length > 0) {
      const fileSummary = this.state.fileRecords.slice(-8).map(r =>
        `  • ${ r.filename } (${ r.action }) — ${ r.purpose || r.contentPreview || 'no description' }`
      ).join('\n');
      parts.push(`Files in this session:\n${ fileSummary }`);
    }

    if (this.state.loadedSkills.length > 0) {
      parts.push(`Skills loaded: ${ this.state.loadedSkills.join(', ') } (DO NOT reload)`);
    }

    if (this.state.taskDecomposerUsed) {
      parts.push(`Task decomposer already used (DO NOT call again)`);
    }

    // Task plan progress
    if (this.state.taskPlanSteps.length > 0) {
      const done = this.state.taskPlanSteps.filter(s => s.status === 'done').length;
      const total = this.state.taskPlanSteps.length;
      const pending = this.state.taskPlanSteps.filter(s => s.status === 'pending');
      parts.push(`Task plan: ${ done }/${ total } steps done${ pending.length > 0 ? `. Next: "${ pending[0].name }"` : ' — ALL COMPLETE' }`);
    }

    if (this.state.actionSummary.length > 0) {
      const recent = this.state.actionSummary.slice(-6);
      parts.push(`Recent actions:\n${ recent.map((a, i) => `  ${ i + 1 }. ${ a }`).join('\n') }`);
    }

    // Brief mention of last output
    if (this.state.lastAgentOutput) {
      parts.push(`Last output preview: "${ this.state.lastAgentOutput.substring(0, 100) }..."`);
    }

    return parts.length > 0
      ? `\n━━━ SESSION MEMORY ━━━\n${ parts.join('\n') }\n\nIMPORTANT: If user says "work more", "add more", "continue" — enhance the FILES LISTED ABOVE. Use workspace_read_file to review them, then workspace_edit_file to improve. Do NOT recreate from scratch.\n━━━ END SESSION ━━━`
      : '';
  }

  /**
   * Clear the session completely.
   * v3: Also removes the per-chat session file.
   */
  public async clear(): Promise<void> {
    const chatId = this.currentProjectId || this.state.boundChatId;
    this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), messageCount: 0, boundChatId: '' };
    try {
      if (await fs.pathExists(STATE_FILE)) {
        await fs.remove(STATE_FILE);
      }
      if (chatId) {
        const chatFile = this.getStateFilePath(chatId);
        if (await fs.pathExists(chatFile)) {
          await fs.remove(chatFile);
        }
        this.activeChatSessions.delete(chatId);
      }
    } catch { /* silent */ }
  }

  /**
   * Check if we have an active session with meaningful state.
   */
  public hasActiveSession(): boolean {
    return this.state.callHistory.length > 0 || this.state.fileRecords.length > 0;
  }

  /** Increment message count — called once per user message */
  public incrementMessageCount(): void {
    this.state.messageCount = (this.state.messageCount || 0) + 1;
  }

  /** Get the current message count */
  public getMessageCount(): number {
    return this.state.messageCount || 0;
  }

  /**
   * SESSION ANALYTICS — Full execution summary for observability
   * 
   * Returns a comprehensive view of what happened in this session:
   * total duration, tool breakdown, file counts, and efficiency metrics.
   */
  public getSessionAnalytics(): {
    durationMinutes: number;
    messageCount: number;
    totalToolCalls: number;
    uniqueToolsUsed: number;
    filesCreated: number;
    filesEdited: number;
    skillsLoaded: number;
    topTools: Array<{ tool: string; count: number }>;
    efficiency: string; // tools-per-message ratio
  } {
    const durationMinutes = Math.round((Date.now() - this.state.createdAt) / 60000);
    const toolCounts = this.state.toolCallCounts || {};
    const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);
    const uniqueToolsUsed = Object.keys(toolCounts).length;
    const filesCreated = this.state.fileRecords.filter(f => f.action === 'created').length;
    const filesEdited = this.state.fileRecords.filter(f => f.action === 'edited').length;
    const msgCount = this.state.messageCount || 1;
    
    const topTools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tool, count]) => ({ tool, count }));

    const toolsPerMsg = (totalToolCalls / msgCount).toFixed(1);
    const efficiency = totalToolCalls > 20 && msgCount < 3 
      ? `${toolsPerMsg} tools/msg (HIGH autonomy)` 
      : `${toolsPerMsg} tools/msg`;

    return {
      durationMinutes,
      messageCount: msgCount,
      totalToolCalls,
      uniqueToolsUsed,
      filesCreated,
      filesEdited,
      skillsLoaded: this.state.loadedSkills.length,
      topTools,
      efficiency,
    };
  }

  /**
   * HOT-SWAP: Switch to a different chat session instantly from memory cache.
   * If cached, avoids disk I/O entirely. Used when user switches between tabs.
   */
  public async switchToChat(chatId: string): Promise<boolean> {
    // Check in-memory cache first (instant swap)
    const cached = this.activeChatSessions.get(chatId);
    if (cached) {
      // Save current state before swapping
      if (this.currentProjectId && this.currentProjectId !== chatId) {
        this.activeChatSessions.set(this.currentProjectId, { ...this.state });
      }
      this.state = { ...cached };
      this.currentProjectId = chatId;
      this.loaded = true;
      console.log(`[Session] \u26a1 Hot-swapped to chat ${chatId.substring(0, 8)}\u2026 (from memory cache)`);
      return true;
    }
    
    // Not cached — load from disk
    return this.loadForProject(chatId);
  }

  /**
   * STALE SESSION GARBAGE COLLECTION
   * 
   * Cleans up per-chat session files older than 24 hours.
   * Called lazily during save() or explicitly during initialization.
   */
  public async cleanupStaleSessions(): Promise<number> {
    let cleaned = 0;
    try {
      await fs.ensureDir(SESSION_DIR);
      const files = await fs.readdir(SESSION_DIR);
      
      for (const file of files) {
        if (!file.endsWith('.json') || file === 'state.json') continue;
        
        const filePath = path.join(SESSION_DIR, file);
        try {
          const stat = await fs.stat(filePath);
          const age = Date.now() - stat.mtimeMs;
          
          if (age > STALE_CLEANUP_MS) {
            await fs.remove(filePath);
            cleaned++;
          }
        } catch { /* skip individual file errors */ }
      }
      
      if (cleaned > 0) {
        console.log(`[Session] \ud83e\uddf9 Cleaned up ${cleaned} stale session file(s)`);
      }
    } catch { /* silent */ }
    return cleaned;
  }
}

// Singleton instance
export const globalSessionManager = new SessionStateManager();

