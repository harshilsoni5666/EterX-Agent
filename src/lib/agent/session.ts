import fs from 'fs-extra';
import path from 'path';
import type { PlanState } from './plan-execution-engine';
import { getEterxWorkspaceDir } from './storage-paths';
import { stableScopeSegment } from './context-scope';

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

const SESSION_DIR = getEterxWorkspaceDir('.session');
const STATE_FILE = path.join(SESSION_DIR, 'state.json'); // Legacy fallback
const SESSION_TIMEOUT_MS = 72 * 60 * 60 * 1000;           // 72 hours idle — up from 24h
const LONG_TASK_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;    // 30 days for long-task mode (effectively never)
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;      // 30 days absolute max
const STALE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_ACTIVE_CHAT_SESSIONS = 40;
const MAX_CALL_HISTORY = 500;
const MAX_WRITTEN_FILES = 250;
const MAX_FILE_RECORDS = 250;
const MAX_ACTION_SUMMARY = 250;
const MAX_LOADED_SKILLS = 80;
const MAX_TOOL_RESULT_DIGEST = 150;
const STALE_CLEANUP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days auto-GC

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveUnder(parent: string, ...segments: string[]): string {
  const resolved = path.resolve(parent, ...segments);
  if (!isPathInside(parent, resolved)) {
    throw new Error(`Resolved path escapes expected directory: ${resolved}`);
  }
  return resolved;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, data, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}

function safeSessionFileId(chatId: string): string {
  return stableScopeSegment(chatId, 120);
}

/** Previous v3 filename format, retained only for safe read/migration. */
function legacySessionFileId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || '_global';
}

/** Rich file record — tracks what was done to each file and why */

/** Rich file record — tracks what was done to each file and why */
interface FileRecord {
  filename: string;
  action: 'created' | 'edited' | 'deleted';
  purpose: string;       // Why this file was created/edited
  contentPreview: string; // First 150 chars of content
  sizeBytes: number;
  timestamp: number;
  absolutePath?: string; // Explicit absolute path on disk
}

export interface SessionHealth {
  score: number;       // 0-100
  staleness: number;   // how old the session is (hours)
  complexity: number;  // tool calls / files ratio
  warnings: string[];  // e.g., "high failure rate", "circular patterns"
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
  /** Full model-driven execution state for exact restart/resume continuity */
  executionPlanState: PlanState | null;
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
  /** Whether this session is in long-task mode (never auto-expires) */
  longTaskMode?: boolean;
  /** Timestamp of last explicit extendSession() call */
  lastExtendedAt?: number;
  /** How many times the session has been extended */
  extensionCount?: number;
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
  executionPlanState: null,
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
  private _chatSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _lastStaleCleanupAt = 0;

  /** Resolve the state file path for a given chatId */
  private getStateFilePath(chatId?: string): string {
    if (chatId) {
      // Per-chat isolated file
      return resolveUnder(SESSION_DIR, `${safeSessionFileId(chatId)}.json`);
    }
    return resolveUnder(SESSION_DIR, 'state.json'); // Legacy fallback
  }

  private getLegacyStateFilePath(chatId: string): string {
    return resolveUnder(SESSION_DIR, `${legacySessionFileId(chatId)}.json`);
  }

  private isIsolatedSessionId(projectId?: string | null): boolean {
    if (!projectId) return false;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId);
    return isUuid || /^(telegram|whatsapp)-/i.test(projectId);
  }

  private cloneState(state: SessionState): SessionState {
    return {
      ...state,
      callHistory: [...state.callHistory],
      writtenFiles: [...state.writtenFiles],
      fileRecords: [...state.fileRecords],
      loadedSkills: [...state.loadedSkills],
      toolCallCounts: { ...state.toolCallCounts },
      actionSummary: [...state.actionSummary],
      taskPlanSteps: [...state.taskPlanSteps],
      executionPlanState: state.executionPlanState ? JSON.parse(JSON.stringify(state.executionPlanState)) : null,
      toolResultDigest: [...state.toolResultDigest],
    };
  }

  private rememberActiveSession(chatId: string, state: SessionState = this.state): void {
    if (!chatId) return;
    this.activeChatSessions.delete(chatId);
    this.activeChatSessions.set(chatId, this.cloneState(state));

    while (this.activeChatSessions.size > MAX_ACTIVE_CHAT_SESSIONS) {
      let oldestChatId: string | null = null;
      let oldestActivity = Number.POSITIVE_INFINITY;

      for (const [id, cachedState] of this.activeChatSessions.entries()) {
        const activity = cachedState.lastActivityAt || cachedState.createdAt || 0;
        if (activity < oldestActivity) {
          oldestActivity = activity;
          oldestChatId = id;
        }
      }

      if (!oldestChatId) break;
      this.activeChatSessions.delete(oldestChatId);
    }
  }

  private trimStateForRetention(state: SessionState = this.state): void {
    state.callHistory = state.callHistory.slice(-MAX_CALL_HISTORY);
    state.writtenFiles = state.writtenFiles.slice(-MAX_WRITTEN_FILES);
    state.loadedSkills = state.loadedSkills.slice(-MAX_LOADED_SKILLS);
    state.toolResultDigest = state.toolResultDigest.slice(-MAX_TOOL_RESULT_DIGEST);
    state.fileRecords = state.fileRecords.slice(-MAX_FILE_RECORDS);
    state.actionSummary = state.actionSummary.slice(-MAX_ACTION_SUMMARY);
    state.taskPlanSteps = state.taskPlanSteps.slice(0, 20);
    if (state.executionPlanState) {
      state.executionPlanState.steps = state.executionPlanState.steps.slice(0, 30).map(step => ({
        ...step,
        trace: Array.isArray(step.trace) ? step.trace.slice(-40) : [],
      }));
      state.executionPlanState.revisionHistory = (state.executionPlanState.revisionHistory || []).slice(-20);
      state.executionPlanState.actionHistory = (state.executionPlanState.actionHistory || []).slice(-100);
    }
  }

  private maybeCleanupStaleSessions(): void {
    const now = Date.now();
    if (now - this._lastStaleCleanupAt < STALE_CLEANUP_INTERVAL_MS) return;
    this._lastStaleCleanupAt = now;
    this.cleanupStaleSessions().catch(() => undefined);
  }

  private formatToolDigestForSummary(): string {
    const digest = (this.state.toolResultDigest || []).slice(-10);
    if (digest.length === 0) return '';

    return digest.map((entry, index) => {
      const args = String(entry.args || '').replace(/\s+/g, ' ').substring(0, 90);
      const result = String(entry.result || '').replace(/\s+/g, ' ').substring(0, 220);
      return `  ${ index + 1 }. ${ entry.tool }(${ args }) -> ${ result }`;
    }).join('\n');
  }

  /**
   * Load session state from disk. Returns true if a valid (non-expired) session was restored.
   */
  public async load(chatId?: string): Promise<boolean> {
    try {
      const scopedChatId = chatId || this.currentProjectId || undefined;
      const stateFile = scopedChatId
        ? this.getStateFilePath(scopedChatId)
        : this.getStateFilePath();
      const legacyStateFile = scopedChatId
        ? this.getLegacyStateFilePath(scopedChatId)
        : null;
      const readableStateFile = await fs.pathExists(stateFile)
        ? stateFile
        : (legacyStateFile && legacyStateFile !== stateFile && await fs.pathExists(legacyStateFile)
          ? legacyStateFile
          : null);

      if (!readableStateFile) {
        this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), boundChatId: chatId || '' };
        this.loaded = true;
        return false;
      }

      const data = await fs.readJson(readableStateFile);
      // A legacy sanitized filename can be shared by multiple logical IDs.
      // Never restore it unless the payload proves its ownership.
      const legacyScopedFile = Boolean(scopedChatId && legacyStateFile && readableStateFile === legacyStateFile);
      if (legacyScopedFile && (!data._projectId || String(data._projectId) !== scopedChatId)) {
        this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), boundChatId: scopedChatId || '' };
        this.loaded = true;
        return false;
      }

      // Check if session is expired (idle too long)
      // Long-task sessions NEVER auto-expire
      const elapsed = Date.now() - (data.lastActivityAt || 0);
      const effectiveTimeout = data.longTaskMode ? LONG_TASK_TIMEOUT_MS : SESSION_TIMEOUT_MS;
      if (elapsed > effectiveTimeout) {
        console.log(`[Session] ⏰ Session expired (${ (elapsed / 60000).toFixed(1) } min idle, mode: ${data.longTaskMode ? 'long-task' : 'normal'}). Starting fresh.`);
        this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), messageCount: 0, boundChatId: '' };
        this.loaded = true;
        await this.save();
        return false;
      }

      // BUG FIX: Check if session is TOO OLD (absolute age, not just idle time)
      const absoluteAge = Date.now() - (data.createdAt || 0);
      if (absoluteAge > MAX_SESSION_AGE_MS) {
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
        executionPlanState: data.executionPlanState || null,
        lastActivityAt: Date.now(),
        createdAt: data.createdAt || Date.now(),
        messageCount: data.messageCount || 0,
        boundChatId: data._projectId || '',
        toolResultDigest: Array.isArray(data.toolResultDigest) ? data.toolResultDigest : [],
      };
      this.trimStateForRetention();
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
    const legacyChatStateFile = this.getLegacyStateFilePath(projectId);
    
    try {
      const readableChatStateFile = await fs.pathExists(chatStateFile)
        ? chatStateFile
        : (legacyChatStateFile !== chatStateFile && await fs.pathExists(legacyChatStateFile)
          ? legacyChatStateFile
          : null);
      if (readableChatStateFile) {
        const data = await fs.readJson(readableChatStateFile);
        const legacyScopedFile = readableChatStateFile === legacyChatStateFile;
        if (legacyScopedFile && (!data._projectId || String(data._projectId) !== projectId)) {
          throw new Error(`Session ownership mismatch for ${projectId}`);
        }
        
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
          executionPlanState: data.executionPlanState || null,
          lastActivityAt: Date.now(),
          createdAt: data.createdAt || Date.now(),
          messageCount: data.messageCount || 0,
          boundChatId: projectId,
          toolResultDigest: Array.isArray(data.toolResultDigest) ? data.toolResultDigest : [],
        };
        this.trimStateForRetention();
        this.currentProjectId = projectId;
        this.loaded = true;
        
        // Cache in memory for fast access
        this.rememberActiveSession(projectId);
        
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
      this.rememberActiveSession(projectId);
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
      
      // Save every active chat snapshot. Runtime updates are chat-scoped, so
      // persisting only the currently bound state can lose data during tab/chat
      // switches or concurrent runs.
      const chatId = this.currentProjectId || this.state.boundChatId;
      const writes: Promise<void>[] = [];
      
      if (chatId) {
        this.trimStateForRetention();
        this.rememberActiveSession(chatId);
      }

      const statesToWrite = new Map<string, SessionState>();
      for (const [id, cachedState] of this.activeChatSessions.entries()) {
        if (!id) continue;
        statesToWrite.set(id, this.cloneState(cachedState));
      }

      for (const [id, state] of statesToWrite.entries()) {
        this.trimStateForRetention(state);
        writes.push(writeJsonAtomic(this.getStateFilePath(id), { ...state, boundChatId: id, _projectId: id }));
      }
      
      // Also save to legacy file for backward compatibility, but never let
      // isolated Telegram/WhatsApp chats overwrite the shared browser/UI state.
      if (!this.isIsolatedSessionId(chatId)) {
        writes.push(writeJsonAtomic(this.getStateFilePath(), { ...this.state, _projectId: this.currentProjectId }));
      }
      
      await Promise.all(writes);
      this.maybeCleanupStaleSessions();
    } catch (err: any) {
      console.warn(`[Session] ⚠️ Failed to save session: ${ err.message }`);
    }
  }

  /**
   * Persist exactly one chat's state without consulting the mutable
   * process-wide "current project" pointer. Tool calls from concurrent chats
   * use this path so a save can never write another chat's session snapshot.
   */
  public async saveForChat(chatId: string): Promise<void> {
    if (!chatId) return;
    try {
      await fs.ensureDir(SESSION_DIR);
      const state = this.cloneState(this.getStateForChat(chatId));
      state.lastActivityAt = Date.now();
      state.boundChatId = chatId;
      this.trimStateForRetention(state);
      this.rememberActiveSession(chatId, state);
      await writeJsonAtomic(this.getStateFilePath(chatId), { ...state, _projectId: chatId });
      this.maybeCleanupStaleSessions();
    } catch (err: any) {
      console.warn(`[Session] Failed to save isolated chat session: ${err.message}`);
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

  /** Debounce one chat without consulting the process-wide current-project pointer. */
  public debouncedSaveForChat(chatId: string): void {
    if (!chatId || this._chatSaveTimers.has(chatId)) return;
    const timer = setTimeout(() => {
      this._chatSaveTimers.delete(chatId);
      this.saveForChat(chatId).catch(() => {});
    }, 3000);
    (timer as any).unref?.();
    this._chatSaveTimers.set(chatId, timer);
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
    this.trimStateForRetention();

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

  // ═══════════════════════════════════════════════════════════════
  // CHAT-SCOPED API — Isolated Per-Chat Session Management
  // ═══════════════════════════════════════════════════════════════

  /** Resolve state for a specific chat — checks active cache, falls back to this.state if it matches */
  public getStateForChat(chatId: string): SessionState {
    if (this.currentProjectId === chatId) return this.state;
    const cached = this.activeChatSessions.get(chatId);
    if (cached) return cached;
    return { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), boundChatId: chatId, messageCount: 0 };
  }

  /** Resolve or initialize state for a specific chat and ensure it's in the cache */
  private getOrCreateStateForChat(chatId: string): SessionState {
    if (this.currentProjectId === chatId) return this.state;
    let cached = this.activeChatSessions.get(chatId);
    if (!cached) {
      cached = {
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
        executionPlanState: null,
        lastActivityAt: Date.now(),
        createdAt: Date.now(),
        messageCount: 0,
        boundChatId: chatId,
        toolResultDigest: [],
      };
      this.activeChatSessions.set(chatId, cached);
    }
    return cached;
  }

  /** Get the last user message for a SPECIFIC chat */
  public getLastUserMessageForChat(chatId: string): string {
    return this.getStateForChat(chatId).lastUserMessage;
  }

  /** Get the agent's last output for a SPECIFIC chat */
  public getLastAgentOutputForChat(chatId: string): string {
    return this.getStateForChat(chatId).lastAgentOutput;
  }

  /** Clear task-scoped continuity after a confidently detected new objective. */
  public resetTaskStateForChat(chatId: string): void {
    const previous = this.getOrCreateStateForChat(chatId);
    const reset: SessionState = {
      ...EMPTY_STATE,
      // A task boundary is not a conversation boundary. Keep durable
      // artifacts so later turns can still recover exact work from this chat.
      writtenFiles: [...previous.writtenFiles],
      fileRecords: [...previous.fileRecords],
      loadedSkills: [...previous.loadedSkills],
      // These fields describe the old objective and must not leak into the
      // next task. Durable file records remain available for artifact lookup.
      actionSummary: [],
      lastUserMessage: '',
      lastAgentOutput: '',
      createdAt: previous.createdAt || Date.now(),
      lastActivityAt: Date.now(),
      messageCount: previous.messageCount || 0,
      boundChatId: chatId,
    };
    if (this.currentProjectId === chatId) this.state = reset;
    this.rememberActiveSession(chatId, reset);
    this.debouncedSaveForChat(chatId);
  }

  /** Set the last user message for a SPECIFIC chat */
  public setLastUserMessageForChat(chatId: string, message: string): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.lastUserMessage = message;
    this.rememberActiveSession(chatId, state);
    this.debouncedSaveForChat(chatId);
  }

  /** Set the agent's last output for a SPECIFIC chat */
  public setLastAgentOutputForChat(chatId: string, output: string): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.lastAgentOutput = output.substring(0, 1500);
    this.rememberActiveSession(chatId, state);
    this.debouncedSaveForChat(chatId);
  }

  /** Get session summary for a SPECIFIC chat — NEVER leaks other chats' data */
  public getSessionSummaryForChat(chatId: string): string {
    const state = this.getStateForChat(chatId);
    return this.buildSummaryFromState(state);
  }

  /** Check if a SPECIFIC chat has an active session */
  public hasActiveSessionForChat(chatId: string): boolean {
    const state = this.getStateForChat(chatId);
    return state.callHistory.length > 0 ||
      state.fileRecords.length > 0 ||
      state.actionSummary.length > 0 ||
      state.toolResultDigest.length > 0 ||
      !!state.lastAgentOutput ||
      state.taskPlanSteps.length > 0;
  }

  /** Hydrate ReAct loop state for a SPECIFIC chat */
  public hydrateForChat(chatId: string): ReturnType<SessionStateManager['hydrate']> {
    const state = this.getStateForChat(chatId);
    return {
      callHistory: new Set(state.callHistory),
      writtenFiles: new Set(state.writtenFiles),
      loadedSkills: new Set(state.loadedSkills),
      taskDecomposerUsed: state.taskDecomposerUsed,
      toolCallCounts: new Map(Object.entries(state.toolCallCounts)),
      toolResultDigest: [...state.toolResultDigest],
    };
  }

  /** Update loop state for a SPECIFIC chat */
  public updateFromLoopForChat(chatId: string, partial: {
    callHistory: Set<string>;
    writtenFiles: Set<string>;
    loadedSkills: Set<string>;
    taskDecomposerUsed: boolean;
    toolCallCounts: Map<string, number>;
    toolResultDigest?: Array<{ tool: string; args: string; result: string; iteration: number }>;
  }): void {
    const state = this.getOrCreateStateForChat(chatId);
    if (partial.callHistory) state.callHistory = Array.from(partial.callHistory);
    if (partial.writtenFiles) state.writtenFiles = Array.from(partial.writtenFiles);
    if (partial.loadedSkills) state.loadedSkills = Array.from(partial.loadedSkills);
    if (partial.taskDecomposerUsed !== undefined) state.taskDecomposerUsed = partial.taskDecomposerUsed;
    if (partial.toolCallCounts) state.toolCallCounts = Object.fromEntries(partial.toolCallCounts);
    if (partial.toolResultDigest) state.toolResultDigest = [...partial.toolResultDigest];
    
    // Trim
    state.callHistory = state.callHistory.slice(-MAX_CALL_HISTORY);
    state.writtenFiles = state.writtenFiles.slice(-MAX_WRITTEN_FILES);
    state.loadedSkills = state.loadedSkills.slice(-MAX_LOADED_SKILLS);
    state.toolResultDigest = state.toolResultDigest.slice(-MAX_TOOL_RESULT_DIGEST);
    
    this.rememberActiveSession(chatId, state);
    this.debouncedSaveForChat(chatId);
  }

  /** Self-review for a SPECIFIC chat */
  public async selfReviewForChat(chatId: string): Promise<string> {
    const state = this.getStateForChat(chatId);
    return this.selfReviewFromState(state);
  }

  /** Enable LONG-TASK MODE for a specific chat */
  public enableLongTaskModeForChat(chatId: string): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.longTaskMode = true;
    state.lastExtendedAt = Date.now();
    state.extensionCount = (state.extensionCount ?? 0) + 1;
    console.log(`[Session] 🚀 Long-task mode ENABLED for chat ${chatId.substring(0, 8)} — session immortal until task completion.`);
    this.debouncedSaveForChat(chatId);
  }

  /** Disable long-task mode for a specific chat */
  public disableLongTaskModeForChat(chatId: string): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.longTaskMode = false;
    console.log(`[Session] ⏱ Long-task mode disabled for chat ${chatId.substring(0, 8)}. Normal timeout restored.`);
    this.debouncedSaveForChat(chatId);
  }

  /** Returns true if a specific chat is in long-task mode */
  public isLongTaskModeForChat(chatId: string): boolean {
    return !!this.getOrCreateStateForChat(chatId).longTaskMode;
  }

  /** Extend session lifetime for a specific chat */
  public extendSessionForChat(chatId: string): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.lastActivityAt = Date.now();
    state.lastExtendedAt = Date.now();
    state.extensionCount = (state.extensionCount ?? 0) + 1;
    if ((state.extensionCount % 10) === 0) {
      this.debouncedSaveForChat(chatId);
    }
  }

  /** Track a file with rich metadata for a specific chat */
  public trackFileForChat(chatId: string, filename: string, action: 'created' | 'edited' | 'deleted', purpose: string, content?: string): void {
    const absolutePath = path.isAbsolute(filename) ? path.normalize(filename) : path.resolve(process.cwd(), filename);
    const normalizedAbs = absolutePath.replace(/\\/g, '/');
    const relativeFilename = path.relative(process.cwd(), absolutePath).replace(/\\/g, '/');

    const state = this.getOrCreateStateForChat(chatId);
    state.fileRecords = state.fileRecords.filter(r => r.filename !== filename && r.filename !== normalizedAbs && r.filename !== relativeFilename);
    state.fileRecords.push({
      filename: relativeFilename,
      action,
      purpose: purpose.substring(0, 100),
      contentPreview: (content || '').substring(0, 150).replace(/\n/g, ' '),
      sizeBytes: content ? content.length : 0,
      timestamp: Date.now(),
      absolutePath: normalizedAbs
    });
    if (state.fileRecords.length > MAX_FILE_RECORDS) {
      state.fileRecords = state.fileRecords.slice(-MAX_FILE_RECORDS);
    }
    this.rememberActiveSession(chatId, state);
    this.debouncedSaveForChat(chatId);
  }

  /** Store the current task plan steps for progress tracking in a specific chat */
  public setTaskPlanForChat(chatId: string, steps: Array<{ name: string; status: 'pending' | 'done'; description?: string }>): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.taskPlanSteps = steps.slice(0, 20); // Cap at 20 steps
    this.rememberActiveSession(chatId, state);
    this.debouncedSaveForChat(chatId);
  }

  public setTaskDecomposerUsedForChat(chatId: string, used: boolean): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.taskDecomposerUsed = used;
    this.rememberActiveSession(chatId, state);
    this.debouncedSaveForChat(chatId);
  }

  public setExecutionPlanForChat(chatId: string, planState: PlanState | null): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.executionPlanState = planState ? JSON.parse(JSON.stringify(planState)) : null;
    this.rememberActiveSession(chatId, state);
    this.debouncedSaveForChat(chatId);
  }

  /** Add a human-readable action summary entry for a specific chat */
  public addActionForChat(chatId: string, action: string): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.actionSummary.push(action);
    if (state.actionSummary.length > MAX_ACTION_SUMMARY) {
      state.actionSummary = state.actionSummary.slice(-MAX_ACTION_SUMMARY);
    }
    this.rememberActiveSession(chatId, state);
    this.debouncedSaveForChat(chatId);
  }

  /** Increment message count for a specific chat */
  public incrementMessageCountForChat(chatId: string): void {
    const state = this.getOrCreateStateForChat(chatId);
    state.messageCount = (state.messageCount || 0) + 1;
    this.rememberActiveSession(chatId, state);
    this.debouncedSaveForChat(chatId);
  }

  /** Get the current message count for a specific chat */
  public getMessageCountForChat(chatId: string): number {
    return this.getStateForChat(chatId).messageCount || 0;
  }

  /** Get the human-readable action summary for a specific chat */
  public getActionsForChat(chatId: string): string[] {
    return this.getStateForChat(chatId).actionSummary || [];
  }

  /** Build summary from any state object (shared logic for both global and per-chat) */
  private buildSummaryFromState(state: SessionState): string {
    if (
      state.actionSummary.length === 0 &&
      state.fileRecords.length === 0 &&
      state.toolResultDigest.length === 0 &&
      state.taskPlanSteps.length === 0 &&
      !state.lastAgentOutput &&
      !state.lastUserMessage
    ) {
      return '';
    }

    const parts: string[] = [];

    if (state.lastUserMessage) {
      parts.push(`Previous task: "${ state.lastUserMessage.substring(0, 120) }"`);
    }

    if (state.fileRecords.length > 0) {
      const fileSummary = state.fileRecords.slice(-8).map(r =>
        `  • ${ r.filename } (${ r.action }) — Location: ${ r.absolutePath || r.filename } — Purpose: ${ r.purpose || r.contentPreview || 'no description' }`
      ).join('\n');
      parts.push(`Files in this session:\n${ fileSummary }`);
    }

    if (state.loadedSkills.length > 0) {
      parts.push(`Skills loaded: ${ state.loadedSkills.join(', ') } (DO NOT reload)`);
    }

    if (state.taskDecomposerUsed) {
      parts.push(`Task decomposer already used (DO NOT call again)`);
    }

    if (state.taskPlanSteps.length > 0) {
      const done = state.taskPlanSteps.filter(s => s.status === 'done').length;
      const total = state.taskPlanSteps.length;
      const pending = state.taskPlanSteps.filter(s => s.status === 'pending');
      parts.push(`Task plan: ${ done }/${ total } steps done${ pending.length > 0 ? `. Next: "${ pending[0].name }"` : ' — ALL COMPLETE' }`);
    }

    if (state.actionSummary.length > 0) {
      const recent = state.actionSummary.slice(-6);
      parts.push(`Recent actions:\n${ recent.map((a, i) => `  ${ i + 1 }. ${ a }`).join('\n') }`);
    }

    const digest = (state.toolResultDigest || []).slice(-10);
    if (digest.length > 0) {
      const toolDigestSummary = digest.map((entry, index) => {
        const args = String(entry.args || '').replace(/\s+/g, ' ').substring(0, 90);
        const result = String(entry.result || '').replace(/\s+/g, ' ').substring(0, 220);
        return `  ${ index + 1 }. ${ entry.tool }(${ args }) -> ${ result }`;
      }).join('\n');
      parts.push(`Recent tool evidence already gathered:\n${ toolDigestSummary }`);
    }

    if (state.lastAgentOutput) {
      parts.push(`Last agent output: "${ state.lastAgentOutput.substring(0, 150) }"`);
    }

    if (parts.length === 0) return '';

    // Session state is evidence for a genuine continuation, never an objective
    // that can override the newest user request.
    return [
      '',
      'SESSION CONTINUITY EVIDENCE',
      'Use this only when the current request continues or refers to the prior task.',
      ...parts,
      '',
      'CONTINUITY RULES:',
      '- Treat paths and tool results as prior observations, not guaranteed current state.',
      '- Continue from the next pending step and avoid exact duplicate calls while evidence remains valid.',
      '- Re-read or re-verify when correctness depends on current external or filesystem state.',
      '- The latest user request is authoritative and may replace this prior task entirely.',
      'END SESSION CONTINUITY',
    ].join('\n');

    /* Legacy directive-heavy summary retained in history for reference only.
    return [
      '',
      '\u2501\u2501\u2501 AGENT SELF-AWARENESS (ALWAYS ACTIVE — EVERY SINGLE MESSAGE) \u2501\u2501\u2501',
      ...parts,
      '',
      '\u26a1 IRON RULES — NON-NEGOTIABLE, EVERY MESSAGE:',
      '  \u2022 NEVER re-create, re-download, re-profile, or re-inspect anything listed above.',
      '  \u2022 File listed above = it EXISTS. Do NOT create it again. Do NOT check if it needs creation.',
      '  \u2022 Tool evidence above = those commands ALREADY RAN. Do NOT re-run them.',
      '  \u2022 Your ONLY valid job is the NEXT MISSING step — not redoing completed work.',
      '  \u2022 Final deliverable (Excel/PDF/report) NOT in files list? \u2192 CREATE IT NOW as first action.',
      '  \u2022 Any message (continue/cont/next/go/more) \u2192 resume from LAST PENDING STEP, not from scratch.',
      '  \u2022 NEVER start an unrelated task when active work context exists above.',
      '\u2501\u2501\u2501 END SELF-AWARENESS \u2501\u2501\u2501',
    ].join('\n'); */
  }

  // ── Backward Compatible Fallbacks (Delegating to Active/Bound Chat) ──

  public enableLongTaskMode(): void {
    this.enableLongTaskModeForChat(this.currentProjectId || this.state.boundChatId || '');
  }

  public disableLongTaskMode(): void {
    this.disableLongTaskModeForChat(this.currentProjectId || this.state.boundChatId || '');
  }

  public isLongTaskMode(): boolean {
    return this.isLongTaskModeForChat(this.currentProjectId || this.state.boundChatId || '');
  }

  public extendSession(): void {
    this.extendSessionForChat(this.currentProjectId || this.state.boundChatId || '');
  }

  public trackFile(filename: string, action: 'created' | 'edited' | 'deleted', purpose: string, content?: string): void {
    this.trackFileForChat(this.currentProjectId || this.state.boundChatId || '', filename, action, purpose, content);
  }

  public setTaskPlan(steps: Array<{ name: string; status: 'pending' | 'done'; description?: string }>): void {
    this.setTaskPlanForChat(this.currentProjectId || this.state.boundChatId || '', steps);
  }

  public addAction(action: string): void {
    this.addActionForChat(this.currentProjectId || this.state.boundChatId || '', action);
  }

  public getActions(): string[] {
    return this.getActionsForChat(this.currentProjectId || this.state.boundChatId || '');
  }

  /**
   * SELF-REVIEW: Read back the actual files the agent created in this session.
   * Returns a compact summary of each file's current content.
   * This lets the agent "see" its own work when the user says "work more on it".
   */
  public async selfReview(): Promise<string> {
    return this.selfReviewFromState(this.state);
  }

  private async selfReviewFromState(state: SessionState): Promise<string> {
    if (state.fileRecords.length === 0) return '';

    const reviews: string[] = [];

    for (const record of state.fileRecords.slice(-8)) { // Review last 8 files max
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
    if (
      this.state.actionSummary.length === 0 &&
      this.state.fileRecords.length === 0 &&
      this.state.toolResultDigest.length === 0 &&
      this.state.taskPlanSteps.length === 0 &&
      !this.state.lastAgentOutput &&
      !this.state.lastUserMessage
    ) {
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

    const toolDigestSummary = this.formatToolDigestForSummary();
    if (toolDigestSummary) {
      parts.push(`Recent tool evidence already gathered:\n${ toolDigestSummary }`);
    }

    if (this.state.lastAgentOutput) {
      parts.push(`Last agent output: "${ this.state.lastAgentOutput.substring(0, 150) }"`);
    }

    if (parts.length === 0) return '';

    return [
      '',
      '\u2501\u2501\u2501 AGENT SELF-AWARENESS (ALWAYS ACTIVE — EVERY SINGLE MESSAGE) \u2501\u2501\u2501',
      ...parts,
      '',
      '\u26a1 IRON RULES — NON-NEGOTIABLE, EVERY MESSAGE:',
      '  \u2022 NEVER re-create, re-download, re-profile, or re-inspect anything listed above.',
      '  \u2022 File listed above = it EXISTS. Do NOT create it again. Do NOT check if it needs creation.',
      '  \u2022 Tool evidence above = those commands ALREADY RAN. Do NOT re-run them.',
      '  \u2022 Your ONLY valid job is the NEXT MISSING step — not redoing completed work.',
      '  \u2022 Final deliverable (Excel/PDF/report) NOT in files list? \u2192 CREATE IT NOW as first action.',
      '  \u2022 Any message (continue/cont/next/go/more) \u2192 resume from LAST PENDING STEP, not from scratch.',
      '  \u2022 NEVER start an unrelated task when active work context exists above.',
      '\u2501\u2501\u2501 END SELF-AWARENESS \u2501\u2501\u2501',
    ].join('\n');
  }

  /**
   * Clear the session completely.
   * v3: Also removes the per-chat session file.
   */
  public async clear(): Promise<void> {
    const chatId = this.currentProjectId || this.state.boundChatId;
    this.state = { ...EMPTY_STATE, createdAt: Date.now(), lastActivityAt: Date.now(), messageCount: 0, boundChatId: '' };
    try {
      const legacyFile = this.getStateFilePath();
      if (await fs.pathExists(legacyFile)) {
        await fs.remove(legacyFile);
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
    return this.state.callHistory.length > 0 ||
      this.state.fileRecords.length > 0 ||
      this.state.actionSummary.length > 0 ||
      this.state.toolResultDigest.length > 0 ||
      !!this.state.lastAgentOutput ||
      this.state.taskPlanSteps.length > 0;
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
        this.rememberActiveSession(this.currentProjectId);
      }
      this.state = this.cloneState(cached);
      this.currentProjectId = chatId;
      this.loaded = true;
      this.rememberActiveSession(chatId);
      console.log(`[Session] \u26a1 Hot-swapped to chat ${chatId.substring(0, 8)}\u2026 (from memory cache)`);
      return true;
    }
    
    // Not cached — load from disk
    return this.loadForProject(chatId);
  }

  /**
   * Intelligently merges the previous session state into the current session state
   * when continuing/resuming across chats.
   */
  public intelligentMergeForChat(chatId: string, previousState: SessionState): void {
    const currentState = this.getOrCreateStateForChat(chatId);
    
    // 1. Preserve file records and loaded skills (always valid)
    const combinedFileRecords = [...previousState.fileRecords];
    for (const cur of currentState.fileRecords) {
      if (!combinedFileRecords.some(f => f.filename === cur.filename && f.timestamp === cur.timestamp)) {
        combinedFileRecords.push(cur);
      }
    }
    currentState.fileRecords = combinedFileRecords;

    const skillsSet = new Set([...previousState.loadedSkills, ...currentState.loadedSkills]);
    currentState.loadedSkills = Array.from(skillsSet);

    const writtenSet = new Set([...previousState.writtenFiles, ...currentState.writtenFiles]);
    currentState.writtenFiles = Array.from(writtenSet);

    // 2. Filter tool results from previousState.toolResultDigest
    // Keep file reads if they exist, and keep web searches if they are fresh (< 5 mins old)
    const mergedDigest = [...currentState.toolResultDigest];
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

    for (const prev of previousState.toolResultDigest) {
      if (mergedDigest.some(d => d.tool === prev.tool && d.args === prev.args && d.iteration === prev.iteration)) {
        continue;
      }

      let keep = false;
      const toolLower = prev.tool.toLowerCase();

      if (toolLower.includes('read') || toolLower.includes('view') || toolLower.includes('search_text') || toolLower.includes('list_dir')) {
        try {
          const argsObj = JSON.parse(prev.args);
          const filePath = argsObj.filename || argsObj.path || argsObj.pathKey;
          if (filePath && fs.existsSync(path.resolve(filePath))) {
            keep = true;
          }
        } catch {
          // Silent catch
        }
      } else if (toolLower.includes('search') && !toolLower.includes('workspace')) {
        if (previousState.lastActivityAt && previousState.lastActivityAt > fiveMinutesAgo) {
          keep = true;
        }
      }

      if (keep) {
        mergedDigest.push(prev);
      }
    }

    currentState.toolResultDigest = mergedDigest.slice(-MAX_TOOL_RESULT_DIGEST);

    // 3. Merge toolCallCounts
    const mergedCounts = { ...previousState.toolCallCounts };
    for (const [tool, count] of Object.entries(currentState.toolCallCounts)) {
      mergedCounts[tool] = (mergedCounts[tool] || 0) + count;
    }
    currentState.toolCallCounts = mergedCounts;

    // 4. Merge call history
    const historySet = new Set([...previousState.callHistory, ...currentState.callHistory]);
    currentState.callHistory = Array.from(historySet).slice(-MAX_CALL_HISTORY);

    // 5. Merge task plan steps
    if (currentState.taskPlanSteps.length === 0 && previousState.taskPlanSteps.length > 0) {
      currentState.taskPlanSteps = [...previousState.taskPlanSteps];
    }
    currentState.taskDecomposerUsed = previousState.taskDecomposerUsed || currentState.taskDecomposerUsed;

    currentState.lastActivityAt = Date.now();
  }

  /**
   * Evaluates the health of a session based on staleness, repetition patterns,
   * tool execution success/failure rate, and efficiency.
   */
  public getSessionHealthForChat(chatId: string): SessionHealth {
    const state = this.getStateForChat(chatId);
    const stalenessHours = (Date.now() - state.lastActivityAt) / (3600 * 1000);

    const toolCounts = state.toolCallCounts || {};
    const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);
    const filesModified = state.writtenFiles.length || state.fileRecords.length;

    // Complexity ratio: tool calls per file modification
    const complexity = totalToolCalls / (filesModified + 1);

    const warnings: string[] = [];
    let score = 100;

    // Check 1: Tool loop/high count warning
    let highestCount = 0;
    let highestTool = '';
    for (const [tool, count] of Object.entries(toolCounts)) {
      if (count > highestCount) {
        highestCount = count;
        highestTool = tool;
      }
    }
    if (highestCount >= 8) {
      warnings.push(`High repetition: tool "${highestTool}" used ${highestCount} times (potential loop).`);
      score -= 20;
    }

    // Check 2: High tool use with low file modification (except purely research)
    const isResearchTask = toolCounts['web_search'];
    if (totalToolCalls > 18 && filesModified === 0 && !isResearchTask) {
      warnings.push(`High tool usage (${totalToolCalls} calls) without modifying any files.`);
      score -= 15;
    }

    // Check 3: Stale session
    if (stalenessHours > 24) {
      warnings.push(`Session is stale (idle for ${stalenessHours.toFixed(1)} hours).`);
      score -= Math.min(25, Math.floor(stalenessHours));
    }

    // Check 4: Failed tool executions in result digest
    const failedCalls = state.toolResultDigest.filter(d => 
      d.result.toLowerCase().includes('failed') || 
      d.result.toLowerCase().includes('error:') || 
      d.result.toLowerCase().includes('error ') ||
      d.result.toLowerCase().includes('not found')
    ).length;
    
    if (failedCalls > 3) {
      warnings.push(`High failure rate: ${failedCalls} tool calls returned errors/warnings.`);
      score -= Math.min(30, failedCalls * 5);
    }

    // Ensure score bounds
    score = Math.max(0, Math.min(100, score));

    return {
      score,
      staleness: parseFloat(stalenessHours.toFixed(1)),
      complexity: parseFloat(complexity.toFixed(1)),
      warnings,
    };
  }

  public getSessionHealth(): SessionHealth {
    if (!this.loaded || !this.state.boundChatId) {
      return { score: 100, staleness: 0, complexity: 0, warnings: [] };
    }
    return this.getSessionHealthForChat(this.state.boundChatId);
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
        
        const filePath = resolveUnder(SESSION_DIR, file);
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

