/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX LIFETIME AGENT BRAIN — Permanent Cross-Session Memory
 * ═══════════════════════════════════════════════════════════════
 *
 * The single most important file in the entire agent stack.
 * This is the agent's PERMANENT MEMORY — it survives EVERYTHING:
 *   • App restarts
 *   • Chat switches
 *   • Session timeouts
 *   • Server crashes
 *   • Days, weeks, months of inactivity
 *
 * When ANY chat opens, the agent instantly knows:
 *   • Every file ever created/edited and what was in it
 *   • Every terminal command ever run and its output
 *   • Every task ever completed (what, when, duration, result)
 *   • Every error ever encountered and how it was fixed
 *   • Key facts learned about the project and user
 *   • What was being worked on in the LAST chat (any chat)
 *
 * Storage:
 *   .workspaces/.brain/lifetime_events.jsonl  — append-only event log
 *   .workspaces/.brain/lifetime_index.json    — fast-access index
 *
 * Architecture:
 *   • JSONL append-only writes (ultra-fast, crash-safe)
 *   • In-memory hot cache of last 5,000 events
 *   • BM25-inspired scoring for semantic recall
 *   • Automatic file rotation at 15MB
 *   • Importance-weighted TTL (important events live forever)
 */

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { getEterxWorkspaceDir } from '../storage-paths';

const BRAIN_DIR = getEterxWorkspaceDir('.brain');
const EVENTS_FILE = path.join(BRAIN_DIR, 'lifetime_events.jsonl');
const INDEX_FILE = path.join(BRAIN_DIR, 'lifetime_index.json');
const ARCHIVE_DIR = path.join(BRAIN_DIR, 'archive');
const MAX_HOT_EVENTS = 10_000;
const MAX_HOT_EVENTS_PER_SCOPE = 500;
const MAX_INDEX_EVENTS_PER_SCOPE = 300;
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB before rotation
const MAX_BOOT_FILES = 8;
const MAX_BOOT_CMDS = 6;
const MAX_BOOT_ERRORS = 4;
const MAX_BOOT_FACTS = 8;

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, data, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}

export type LifetimeEventType =
  | 'file_write'
  | 'file_edit'
  | 'file_delete'
  | 'terminal_cmd'
  | 'terminal_output'
  | 'task_start'
  | 'task_complete'
  | 'task_failed'
  | 'error'
  | 'error_fixed'
  | 'fact_learned'
  | 'user_message'
  | 'agent_decision'
  | 'model_switched'
  | 'skill_loaded'
  | 'subagent_result'
  | 'session_start'
  | 'session_end';

export interface LifetimeEvent {
  id: string;
  ts: number;             // Unix timestamp ms
  chatId: string;         // which chat this happened in
  projectId: string;      // which project
  type: LifetimeEventType;
  title: string;          // Short human-readable summary (≤120 chars)
  detail: string;         // Full detail (compressed with age)
  tags: string[];         // searchable tags
  importance: number;     // 0-10 (10 = always show)
  metadata?: Record<string, any>;
}

// Index stores compact summaries for fast boot-context generation
interface LifetimeIndex {
  totalEvents: number;
  firstEventAt: number;
  lastEventAt: number;
  recentFiles: Array<{ filename: string; action: string; ts: number; chatId: string; projectId?: string; summary: string }>;
  recentCmds: Array<{ cmd: string; output: string; exitCode: number | null; ts: number; chatId: string; projectId?: string }>;
  recentTasks: Array<{ title: string; status: string; ts: number; chatId: string; projectId?: string; durationMs?: number }>;
  recentErrors: Array<{ tool: string; error: string; fixed: boolean; ts: number; chatId: string; projectId?: string }>;
  learnedFacts: Array<{ fact: string; ts: number; confidence: number; tags: string[]; chatId?: string; projectId?: string }>;
  recentEventsByScope: Record<string, LifetimeEvent[]>;
  lastChatId: string;
  lastProjectId: string;
  modelProven: Record<string, string>; // mode → proven model name
}

const EMPTY_INDEX: LifetimeIndex = {
  totalEvents: 0,
  firstEventAt: 0,
  lastEventAt: 0,
  recentFiles: [],
  recentCmds: [],
  recentTasks: [],
  recentErrors: [],
  learnedFacts: [],
  recentEventsByScope: {},
  lastChatId: '',
  lastProjectId: '',
  modelProven: {},
};

function scopeKey(entry: { chatId?: string; projectId?: string }): string {
  return JSON.stringify([String(entry.chatId || ''), String(entry.projectId || '')]);
}

function sameScope(
  left: { chatId?: string; projectId?: string },
  right: { chatId?: string; projectId?: string },
): boolean {
  return String(left.chatId || '') === String(right.chatId || '') &&
    String(left.projectId || '') === String(right.projectId || '');
}

function retainRecentPerScope<T extends { chatId?: string; projectId?: string }>(
  entries: T[],
  perScopeLimit: number,
  totalLimit: number,
): T[] {
  const counts = new Map<string, number>();
  const kept: T[] = [];
  for (const entry of entries) {
    const key = scopeKey(entry);
    const count = counts.get(key) || 0;
    if (count >= perScopeLimit) continue;
    kept.push(entry);
    counts.set(key, count + 1);
    if (kept.length >= totalLimit) break;
  }
  return kept;
}

function redactLifetimeText(value: string): string {
  return value
    .replace(/(AIza[0-9A-Za-z_-]{20,})/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/(sk-[A-Za-z0-9_-]{20,})/g, '[REDACTED_API_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function sanitizeLifetimeValue(value: unknown): any {
  if (typeof value === 'string') return redactLifetimeText(value);
  if (Array.isArray(value)) return value.map(sanitizeLifetimeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, sanitizeLifetimeValue(item)]),
    );
  }
  return value;
}

function sanitizeLifetimeEvent(event: LifetimeEvent): LifetimeEvent {
  return {
    ...event,
    title: redactLifetimeText(String(event.title || '')),
    detail: redactLifetimeText(String(event.detail || '')),
    tags: Array.isArray(event.tags)
      ? event.tags.map(tag => redactLifetimeText(String(tag)))
      : [],
    metadata: sanitizeLifetimeValue(event.metadata),
  };
}

// ─── BM25-inspired scoring ────────────────────────────────────────────────────

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.\-\/\\]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function scoreEvent(
  event: LifetimeEvent,
  queryWords: Set<string>,
  chatId?: string,
  projectId?: string
): number {
  let score = 0;

  if (queryWords.size > 0) {
    const titleWords = new Set(normalizeWords(event.title));
    const tagWords = new Set(event.tags.flatMap(t => normalizeWords(t)));
    const detailWords = new Set(normalizeWords(event.detail.substring(0, 800)));

    let titleHits = 0;
    let tagHits = 0;
    let detailHits = 0;
    for (const word of queryWords) {
      if (titleWords.has(word)) titleHits++;
      if (tagWords.has(word)) tagHits++;
      if (detailWords.has(word)) detailHits++;
    }
    score += titleHits * 3 + tagHits * 2 + detailHits * 1;
    if (score === 0) return 0; // No keyword match → irrelevant
  }

  // Recency boost: log scale
  const ageDays = Math.max(0, (Date.now() - event.ts) / (24 * 60 * 60 * 1000));
  score += Math.max(0, 6 - Math.log(ageDays + 1) * 2.5);

  // Importance weight
  score += event.importance * 0.6;

  // Same chat boost
  if (chatId && event.chatId === chatId) score += 4;

  // Same project boost
  if (projectId && event.projectId === projectId) score += 2;

  return score;
}

function eventMatchesScope(event: LifetimeEvent, opts?: { chatId?: string; projectId?: string }): boolean {
  if (opts?.chatId && event.chatId !== opts.chatId) return false;
  if (opts?.projectId && event.projectId !== opts.projectId) return false;
  return true;
}

function indexEntryMatchesScope(
  entry: { chatId?: string; projectId?: string },
  opts?: { chatId?: string; projectId?: string }
): boolean {
  if (!opts?.chatId && !opts?.projectId) return true;
  if (opts.chatId && entry.chatId !== opts.chatId) return false;
  if (opts.projectId) {
    if (entry.projectId) return entry.projectId === opts.projectId;
    return Boolean(opts.chatId && entry.chatId === opts.chatId);
  }
  return true;
}

// ─── Main class ───────────────────────────────────────────────────────────────

class LifetimeBrain {
  private hotCache: LifetimeEvent[] = [];
  private index: LifetimeIndex = { ...EMPTY_INDEX };
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private writeStream: fs.WriteStream | null = null;
  private indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private indexDirty = false;

  // ── Initialization ──────────────────────────────────────────────────────────

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    try {
      await fs.ensureDir(BRAIN_DIR);
      await fs.ensureDir(ARCHIVE_DIR);

      // Load index first (fast, small file)
      if (await fs.pathExists(INDEX_FILE)) {
        try {
          const raw = await fs.readJson(INDEX_FILE);
          this.index = { ...EMPTY_INDEX, ...raw };
        } catch {
          this.index = { ...EMPTY_INDEX };
        }
      }

      // Load hot cache from JSONL (tail last MAX_HOT_EVENTS lines)
      if (await fs.pathExists(EVENTS_FILE)) {
        try {
          const content = await fs.readFile(EVENTS_FILE, 'utf8');
          const lines = content.trim().split('\n').filter(Boolean);
          const tail = lines.slice(-MAX_HOT_EVENTS);
          for (const line of tail) {
            try {
              const event = JSON.parse(line) as LifetimeEvent;
              this.hotCache.push(event);
              this._rememberScopedEvent(event);
            } catch { /* skip corrupt lines */ }
          }
        } catch { /* file unreadable → start fresh */ }
      }

      // Open write stream for appending
      this.writeStream = fs.createWriteStream(EVENTS_FILE, { flags: 'a', encoding: 'utf8' });

      this.initialized = true;
      const age = this.index.firstEventAt
        ? Math.round((Date.now() - this.index.firstEventAt) / (24 * 60 * 60 * 1000))
        : 0;
      console.log(`[LifetimeBrain] 🧠 Initialized — ${this.hotCache.length} events in hot cache, brain age: ${age} days`);
    } catch (err: any) {
      console.warn(`[LifetimeBrain] Init failed: ${err.message}. Starting fresh.`);
      this.initialized = true;
    }
  }

  // ── Recording ───────────────────────────────────────────────────────────────

  /**
   * Record any event to the lifetime brain.
   * FIRE AND FORGET — never blocks the caller.
   */
  public record(event: Omit<LifetimeEvent, 'id' | 'ts'>): void {
    this.initialize().then(() => this._writeEvent(event)).catch(() => {});
  }

  private async _writeEvent(partial: Omit<LifetimeEvent, 'id' | 'ts'>): Promise<void> {
    const chatId = String(partial.chatId || '').trim();
    const projectId = String(partial.projectId || '').trim();
    if (!chatId || !projectId) return;
    const event: LifetimeEvent = {
      id: crypto.randomUUID().substring(0, 16),
      ts: Date.now(),
      ...partial,
      chatId,
      projectId,
      title: redactLifetimeText(String(partial.title || '')).substring(0, 120),
      detail: redactLifetimeText(String(partial.detail || '')).substring(0, 4000),
      tags: Array.isArray(partial.tags)
        ? partial.tags.slice(0, 20).map(tag => redactLifetimeText(String(tag)))
        : [],
      importance: Math.min(10, Math.max(0, partial.importance ?? 5)),
      metadata: sanitizeLifetimeValue(partial.metadata),
    };

    // Add to hot cache
    this.hotCache.push(event);
    if (this.hotCache.length > MAX_HOT_EVENTS) {
      this.hotCache = retainRecentPerScope(
        [...this.hotCache].reverse(),
        MAX_HOT_EVENTS_PER_SCOPE,
        MAX_HOT_EVENTS,
      ).reverse();
    }

    // Update index
    this._updateIndex(event);

    // Append to JSONL file
    if (this.writeStream) {
      try {
        this.writeStream.write(JSON.stringify(event) + '\n');
      } catch {
        // Stream closed — reopen
        try {
          this.writeStream = fs.createWriteStream(EVENTS_FILE, { flags: 'a', encoding: 'utf8' });
          this.writeStream.write(JSON.stringify(event) + '\n');
        } catch { /* silent */ }
      }
    }

    // Schedule file rotation check
    this._maybeRotate();

    // Debounced index save
    this.indexDirty = true;
    if (!this.indexSaveTimer) {
      this.indexSaveTimer = setTimeout(() => {
        this.indexSaveTimer = null;
        if (this.indexDirty) {
          this.indexDirty = false;
          writeJsonAtomic(INDEX_FILE, this.index).catch(() => {});
        }
      }, 2000);
    }
  }

  private _updateIndex(event: LifetimeEvent): void {
    this.index.totalEvents++;
    if (!this.index.firstEventAt) this.index.firstEventAt = event.ts;
    this.index.lastEventAt = event.ts;
    this.index.lastChatId = event.chatId || this.index.lastChatId;
    this.index.lastProjectId = event.projectId || this.index.lastProjectId;
    this._rememberScopedEvent(event);

    switch (event.type) {
      case 'file_write':
      case 'file_edit':
      case 'file_delete': {
        const filename = event.metadata?.filename || event.metadata?.path || '';
        if (filename) {
          // Deduplicate — keep latest for each file
          this.index.recentFiles = this.index.recentFiles.filter(
            f => !(f.filename === filename && sameScope(f, event)),
          );
          this.index.recentFiles.unshift({
            filename: String(filename),
            action: event.type.replace('file_', ''),
            ts: event.ts,
            chatId: event.chatId,
            projectId: event.projectId,
            summary: event.title,
          });
          this.index.recentFiles = retainRecentPerScope(this.index.recentFiles, 30, 2_000);
        }
        break;
      }

      case 'terminal_cmd': {
        const cmd = event.metadata?.command || event.title;
        this.index.recentCmds.unshift({
          cmd: String(cmd).substring(0, 200),
          output: String(event.metadata?.output || event.detail || '').substring(0, 500),
          exitCode: event.metadata?.exitCode ?? null,
          ts: event.ts,
          chatId: event.chatId,
          projectId: event.projectId,
        });
        this.index.recentCmds = retainRecentPerScope(this.index.recentCmds, 20, 2_000);
        break;
      }

      case 'task_complete':
      case 'task_failed':
      case 'task_start': {
        // Deduplicate by title
        this.index.recentTasks = this.index.recentTasks.filter(
          t => !(t.title === event.title && sameScope(t, event)),
        );
        this.index.recentTasks.unshift({
          title: event.title,
          status: event.type === 'task_complete' ? 'completed' : event.type === 'task_failed' ? 'failed' : 'started',
          ts: event.ts,
          chatId: event.chatId,
          projectId: event.projectId,
          durationMs: event.metadata?.durationMs,
        });
        this.index.recentTasks = retainRecentPerScope(this.index.recentTasks, 20, 2_000);
        break;
      }

      case 'error':
      case 'error_fixed': {
        this.index.recentErrors.unshift({
          tool: String(event.metadata?.tool || event.tags[0] || 'unknown'),
          error: event.title,
          fixed: event.type === 'error_fixed',
          ts: event.ts,
          chatId: event.chatId,
          projectId: event.projectId,
        });
        this.index.recentErrors = retainRecentPerScope(this.index.recentErrors, 20, 2_000);
        break;
      }

      case 'fact_learned': {
        // Deduplicate facts
        const factText = event.title;
        this.index.learnedFacts = this.index.learnedFacts.filter(
          f => !(
            sameScope(f, event) &&
            f.fact.toLowerCase().startsWith(factText.toLowerCase().substring(0, 30))
          )
        );
        this.index.learnedFacts.unshift({
          fact: factText,
          ts: event.ts,
          confidence: event.metadata?.confidence ?? 0.7,
          tags: event.tags,
          chatId: event.chatId,
          projectId: event.projectId,
        });
        this.index.learnedFacts = retainRecentPerScope(this.index.learnedFacts, 50, 4_000);
        break;
      }
    }
  }

  private _rememberScopedEvent(event: LifetimeEvent): void {
    if (!event.chatId || !event.projectId) return;
    if (!this.index.recentEventsByScope) this.index.recentEventsByScope = {};
    const safeEvent = sanitizeLifetimeEvent(event);
    const key = scopeKey(safeEvent);
    const existing = this.index.recentEventsByScope[key] || [];
    this.index.recentEventsByScope[key] = [
      safeEvent,
      ...existing
        .filter(item => item.id !== safeEvent.id)
        .map(sanitizeLifetimeEvent),
    ].slice(0, MAX_INDEX_EVENTS_PER_SCOPE);
  }

  private _getScopedEvents(opts?: { chatId?: string; projectId?: string }): LifetimeEvent[] {
    const byId = new Map<string, LifetimeEvent>();
    for (const event of this.hotCache) {
      if (eventMatchesScope(event, opts)) byId.set(event.id, sanitizeLifetimeEvent(event));
    }
    for (const events of Object.values(this.index.recentEventsByScope || {})) {
      for (const event of events) {
        if (eventMatchesScope(event, opts) && !byId.has(event.id)) {
          byId.set(event.id, sanitizeLifetimeEvent(event));
        }
      }
    }
    return Array.from(byId.values());
  }

  // ── Shortcut recorders for common events ────────────────────────────────────

  public recordFileWrite(opts: {
    chatId: string;
    projectId: string;
    filename: string;
    purpose: string;
    contentPreview: string;
    sizeBytes?: number;
  }): void {
    const basename = opts.filename.split(/[\/\\]/).pop() || opts.filename;
    this.record({
      chatId: opts.chatId,
      projectId: opts.projectId,
      type: 'file_write',
      title: `Created ${basename} — ${opts.purpose.substring(0, 80)}`,
      detail: opts.contentPreview.substring(0, 2000),
      tags: [
        'file', 'write', basename,
        ...basename.split('.').slice(1), // extensions as tags
        ...opts.purpose.toLowerCase().split(/\s+/).slice(0, 5),
      ],
      importance: 7,
      metadata: {
        filename: opts.filename,
        purpose: opts.purpose,
        sizeBytes: opts.sizeBytes,
      },
    });
  }

  public recordFileEdit(opts: {
    chatId: string;
    projectId: string;
    filename: string;
    changeDescription: string;
  }): void {
    const basename = opts.filename.split(/[\/\\]/).pop() || opts.filename;
    this.record({
      chatId: opts.chatId,
      projectId: opts.projectId,
      type: 'file_edit',
      title: `Edited ${basename} — ${opts.changeDescription.substring(0, 80)}`,
      detail: opts.changeDescription,
      tags: ['file', 'edit', basename, ...basename.split('.').slice(1)],
      importance: 6,
      metadata: { filename: opts.filename, change: opts.changeDescription },
    });
  }

  public recordTerminalCommand(opts: {
    chatId: string;
    projectId: string;
    command: string;
    output: string;
    exitCode?: number | null;
    durationMs?: number;
  }): void {
    const success = opts.exitCode === 0 || opts.exitCode === null;
    const icon = success ? '✅' : '❌';
    const shortCmd = opts.command.substring(0, 100);
    const shortOutput = opts.output.substring(0, 500);

    this.record({
      chatId: opts.chatId,
      projectId: opts.projectId,
      type: 'terminal_cmd',
      title: `${icon} ${shortCmd}`,
      detail: shortOutput,
      tags: [
        'terminal', 'command',
        success ? 'success' : 'error',
        ...shortCmd.split(/\s+/).slice(0, 3).map(w => w.replace(/[^a-z0-9]/gi, '').toLowerCase()).filter(Boolean),
      ],
      importance: success ? 5 : 8,
      metadata: {
        command: opts.command,
        output: opts.output.substring(0, 2000),
        exitCode: opts.exitCode,
        durationMs: opts.durationMs,
      },
    });
  }

  public recordTaskComplete(opts: {
    chatId: string;
    projectId: string;
    taskTitle: string;
    success: boolean;
    durationMs: number;
    filesChanged?: string[];
  }): void {
    this.record({
      chatId: opts.chatId,
      projectId: opts.projectId,
      type: opts.success ? 'task_complete' : 'task_failed',
      title: opts.taskTitle.substring(0, 100),
      detail: [
        `Status: ${opts.success ? 'SUCCESS' : 'FAILED'}`,
        `Duration: ${Math.round(opts.durationMs / 1000)}s`,
        opts.filesChanged?.length ? `Files changed: ${opts.filesChanged.slice(0, 10).join(', ')}` : '',
      ].filter(Boolean).join('\n'),
      tags: ['task', opts.success ? 'success' : 'failed'],
      importance: opts.success ? 8 : 9,
      metadata: {
        success: opts.success,
        durationMs: opts.durationMs,
        filesChanged: opts.filesChanged,
      },
    });
  }

  public recordError(opts: {
    chatId: string;
    projectId: string;
    tool: string;
    error: string;
    fixed?: boolean;
    fixDescription?: string;
  }): void {
    this.record({
      chatId: opts.chatId,
      projectId: opts.projectId,
      type: opts.fixed ? 'error_fixed' : 'error',
      title: `${opts.tool}: ${opts.error.substring(0, 80)}${opts.fixed ? ' → FIXED' : ''}`,
      detail: opts.fixed ? `Fixed: ${opts.fixDescription || 'resolved'}` : opts.error.substring(0, 1000),
      tags: ['error', opts.tool, opts.fixed ? 'fixed' : 'unresolved'],
      importance: opts.fixed ? 6 : 8,
      metadata: { tool: opts.tool, error: opts.error, fixed: opts.fixed, fix: opts.fixDescription },
    });
  }

  public recordFact(opts: {
    chatId: string;
    projectId: string;
    fact: string;
    confidence?: number;
    tags?: string[];
  }): void {
    this.record({
      chatId: opts.chatId,
      projectId: opts.projectId,
      type: 'fact_learned',
      title: opts.fact.substring(0, 120),
      detail: opts.fact,
      tags: ['fact', ...(opts.tags || [])],
      importance: 7,
      metadata: { confidence: opts.confidence ?? 0.8 },
    });
  }

  public recordSessionStart(opts: { chatId: string; projectId: string; userMessage: string }): void {
    this.record({
      chatId: opts.chatId,
      projectId: opts.projectId,
      type: 'session_start',
      title: `Session started: ${opts.userMessage.substring(0, 80)}`,
      detail: opts.userMessage.substring(0, 500),
      tags: ['session', 'start'],
      importance: 4,
      metadata: { userMessage: opts.userMessage },
    });
  }

  // ── Recall ───────────────────────────────────────────────────────────────────

  /**
   * Recall events relevant to a query.
   * Uses BM25-inspired scoring across chat-scoped recent memory.
   */
  public recall(opts: {
    query?: string;
    chatId?: string;
    projectId?: string;
    types?: LifetimeEventType[];
    limit?: number;
    minImportance?: number;
  }): LifetimeEvent[] {
    const queryWords = opts.query ? new Set(normalizeWords(opts.query)) : new Set<string>();
    const typeFilter = opts.types ? new Set(opts.types) : null;
    const limit = opts.limit ?? 20;
    const minImportance = opts.minImportance ?? 0;

    const scored: Array<{ event: LifetimeEvent; score: number }> = [];

    for (const event of this._getScopedEvents(opts)) {
      if (typeFilter && !typeFilter.has(event.type)) continue;
      if (event.importance < minImportance) continue;
      if (!eventMatchesScope(event, opts)) continue;

      const score = scoreEvent(event, queryWords, opts.chatId, opts.projectId);
      if (queryWords.size === 0 || score > 0) {
        scored.push({ event, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.event);
  }

  // ── Boot Context Generation ─────────────────────────────────────────────────

  /**
   * Generate the LIFETIME BRAIN context block to inject into the system prompt.
   * Called ONCE per message, before the agent runs.
   * Returns empty string if brain is empty.
   */
  public getBootContext(opts?: {
    chatId?: string;
    projectId?: string;
    query?: string;
  }): string {
    if (!this.initialized) return '';

    const parts: string[] = [];
    const now = Date.now();

    // ── Header ──
    const scopedEvents = this._getScopedEvents(opts);
    const firstScopedEventAt = scopedEvents.reduce(
      (oldest, event) => oldest === 0 ? event.ts : Math.min(oldest, event.ts),
      0,
    );
    const ageDays = firstScopedEventAt
      ? Math.round((now - firstScopedEventAt) / (24 * 60 * 60 * 1000))
      : 0;
    parts.push(
      `Scoped memory: ${scopedEvents.length.toLocaleString()} recent events | Active since ${ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`}`
    );

    // ── Recent Files ──
    const recentFiles = this.index.recentFiles
      .filter(f => indexEntryMatchesScope(f, opts))
      .slice(0, MAX_BOOT_FILES);
    if (recentFiles.length > 0) {
      const fileLines = recentFiles.map(f => {
        const agoMin = Math.round((now - f.ts) / 60000);
        const agoStr = agoMin < 1 ? 'just now' : agoMin < 60 ? `${agoMin}m ago` : agoMin < 1440 ? `${Math.round(agoMin/60)}h ago` : agoMin < 10080 ? `${Math.round(agoMin/1440)}d ago` : `${Math.round(agoMin/10080)}w ago`;
        const basename = f.filename.split(/[\/\\]/).pop() || f.filename;
        return `  • ${redactLifetimeText(basename)} (${f.action}) — ${redactLifetimeText(f.summary).substring(0, 60)} [${agoStr}]`;
      });
      parts.push(`📁 FILES LAST WORKED ON:\n${fileLines.join('\n')}`);
    }

    // ── Recent Terminal Commands ──
    const recentCmds = this.index.recentCmds
      .filter(c => indexEntryMatchesScope(c, opts))
      .slice(0, MAX_BOOT_CMDS);
    if (recentCmds.length > 0) {
      const cmdLines = recentCmds.map(c => {
        const agoMin = Math.round((now - c.ts) / 60000);
        const agoStr = agoMin < 1 ? 'just now' : agoMin < 60 ? `${agoMin}m ago` : agoMin < 1440 ? `${Math.round(agoMin/60)}h ago` : `${Math.round(agoMin/1440)}d ago`;
        const icon = c.exitCode === 0 ? '✅' : c.exitCode === null ? '▶️' : '❌';
        const shortOutput = c.output.substring(0, 80).replace(/\n/g, ' ').trim();
        return `  • ${icon} ${redactLifetimeText(c.cmd).substring(0, 80)}${shortOutput ? ` → ${redactLifetimeText(shortOutput)}` : ''} [${agoStr}]`;
      });
      parts.push(`💻 TERMINAL HISTORY:\n${cmdLines.join('\n')}`);
    }

    // ── Last Completed Task ──
    const lastCompletedTask = this.index.recentTasks
      .filter(t => indexEntryMatchesScope(t, opts))
      .find(t => t.status === 'completed');
    if (lastCompletedTask) {
      const agoMin = Math.round((now - lastCompletedTask.ts) / 60000);
      const agoStr = agoMin < 60 ? `${agoMin}m ago` : agoMin < 1440 ? `${Math.round(agoMin/60)}h ago` : `${Math.round(agoMin/1440)}d ago`;
      const durStr = lastCompletedTask.durationMs ? ` | ${Math.round(lastCompletedTask.durationMs / 60000)}min` : '';
      parts.push(`✅ LAST TASK (${agoStr}${durStr}): ${redactLifetimeText(lastCompletedTask.title)}`);
    }

    // ── Recent Errors ──
    const unresolvedErrors = this.index.recentErrors
      .filter(e => indexEntryMatchesScope(e, opts) && !e.fixed)
      .slice(0, MAX_BOOT_ERRORS);
    if (unresolvedErrors.length > 0) {
      const errLines = unresolvedErrors.map(e => {
        const agoMin = Math.round((now - e.ts) / 60000);
        const agoStr = agoMin < 60 ? `${agoMin}m ago` : `${Math.round(agoMin/60)}h ago`;
        return `  • [${redactLifetimeText(e.tool)}] ${redactLifetimeText(e.error).substring(0, 80)} [${agoStr}]`;
      });
      parts.push(`⚠️ RECENT ERRORS (unresolved):\n${errLines.join('\n')}`);
    }

    // Fixed errors — learn from them
    const fixedErrors = this.index.recentErrors
      .filter(e => indexEntryMatchesScope(e, opts) && e.fixed)
      .slice(0, 3);
    if (fixedErrors.length > 0) {
      const fixLines = fixedErrors.map(e => `  • [${redactLifetimeText(e.tool)}] ${redactLifetimeText(e.error).substring(0, 60)} → FIXED`);
      parts.push(`🔧 ERRORS FIXED PREVIOUSLY:\n${fixLines.join('\n')}`);
    }

    // ── Learned Facts ──
    const topFacts = this.index.learnedFacts
      .filter(f => indexEntryMatchesScope(f, opts) && f.confidence >= 0.7)
      .slice(0, MAX_BOOT_FACTS);
    if (topFacts.length > 0) {
      const factLines = topFacts.map(f => `  • ${redactLifetimeText(f.fact).substring(0, 100)}`);
      parts.push(`🧠 LEARNED ABOUT THIS PROJECT:\n${factLines.join('\n')}`);
    }

    if (parts.length <= 1) return ''; // Only header, nothing useful

    return [
      '━━━ LIFETIME AGENT BRAIN (read-only context) ━━━',
      ...parts,
      'NOTE: This is permanent memory. Use it to avoid re-doing work and to understand project state.',
      '━━━ END LIFETIME BRAIN ━━━',
    ].join('\n');
  }

  // ── Auto-ingest from tool results ───────────────────────────────────────────

  /**
   * Auto-record any tool execution result.
   * Called after EVERY tool call in the agent loop.
   * Fully fire-and-forget, never throws.
   */
  public autoIngestToolResult(opts: {
    chatId: string;
    projectId: string;
    toolName: string;
    args: Record<string, any>;
    result: any;
    durationMs: number;
  }): void {
    const { chatId, projectId, toolName, args, result, durationMs } = opts;
    const hasError = !!(result?.error || result?._retryFailed);

    try {
      switch (toolName) {
        case 'workspace_write_file':
        case 'workspace_edit_file': {
          if (hasError) {
            this.recordError({ chatId, projectId, tool: toolName, error: String(result.error) });
            return;
          }
          const filename = String(args.filename || args.path || '');
          const content = String(args.content || '');
          const purpose = String(args.purpose || args.description || args.uiActionText || 'Updated');
          if (!filename) return;
          if (toolName === 'workspace_write_file') {
            this.recordFileWrite({
              chatId, projectId, filename, purpose,
              contentPreview: content.substring(0, 500),
              sizeBytes: content.length,
            });
          } else {
            this.recordFileEdit({ chatId, projectId, filename, changeDescription: purpose });
          }
          break;
        }

        case 'system_shell':
        case 'workspace_run_command': {
          const cmd = String(args.command || args.cmd || '');
          if (!cmd) return;
          const output = String(
            result?.output || result?.stdout || result?.stderr || result?.result || ''
          ).substring(0, 2000);
          const exitCode = result?.exitCode ?? result?.code ?? null;
          this.recordTerminalCommand({ chatId, projectId, command: cmd, output, exitCode, durationMs });
          break;
        }

        case 'workspace_analyze': {
          if (result?.profile) {
            const p = result.profile;
            this.recordFact({
              chatId, projectId,
              fact: `Project: ${p.framework || 'unknown'} with ${p.language || 'unknown'}. Build: ${p.buildSystem || 'unknown'}`,
              confidence: 0.9,
              tags: ['project', 'framework', 'stack'],
            });
          }
          break;
        }

        case 'get_skill_guidelines': {
          const skillName = String(args.skill_name || args.skillName || '');
          if (skillName) {
            this.record({
              chatId, projectId, type: 'skill_loaded',
              title: `Loaded skill: ${skillName}`,
              detail: skillName,
              tags: ['skill', skillName],
              importance: 4,
            });
          }
          break;
        }

        default:
          // For errors on any tool, record them
          if (hasError) {
            this.recordError({
              chatId, projectId,
              tool: toolName,
              error: String(result.error || 'unknown error').substring(0, 200),
            });
          }
          break;
      }
    } catch { /* never throw */ }
  }

  // ── File rotation ───────────────────────────────────────────────────────────

  private _rotationCheckTs = 0;

  private _maybeRotate(): void {
    const now = Date.now();
    if (now - this._rotationCheckTs < 30_000) return; // Check at most every 30s
    this._rotationCheckTs = now;
    this._checkRotation().catch(() => {});
  }

  private async _checkRotation(): Promise<void> {
    try {
      if (!await fs.pathExists(EVENTS_FILE)) return;
      const stat = await fs.stat(EVENTS_FILE);
      if (stat.size < MAX_FILE_BYTES) return;

      // Rotate: close stream, move file, reopen
      if (this.writeStream) {
        this.writeStream.end();
        this.writeStream = null;
      }

      const archiveName = path.join(ARCHIVE_DIR, `events_${Date.now()}.jsonl`);
      await fs.move(EVENTS_FILE, archiveName);
      this.writeStream = fs.createWriteStream(EVENTS_FILE, { flags: 'a', encoding: 'utf8' });
      console.log(`[LifetimeBrain] 🔄 Rotated events log → ${path.basename(archiveName)}`);
    } catch { /* silent */ }
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  public getStats(): Record<string, any> {
    return {
      initialized: this.initialized,
      hotCacheSize: this.hotCache.length,
      totalEvents: this.index.totalEvents,
      lastChatId: this.index.lastChatId,
      indexedFiles: this.index.recentFiles.length,
      indexedCmds: this.index.recentCmds.length,
      indexedTasks: this.index.recentTasks.length,
      indexedErrors: this.index.recentErrors.length,
      learnedFacts: this.index.learnedFacts.length,
      ageDays: this.index.firstEventAt
        ? Math.round((Date.now() - this.index.firstEventAt) / (24 * 60 * 60 * 1000))
        : 0,
    };
  }

  public getIndex(): Readonly<LifetimeIndex> {
    return this.index;
  }

  /**
   * Force flush index to disk. Called on graceful shutdown.
   */
  public async flush(): Promise<void> {
    if (this.indexSaveTimer) {
      clearTimeout(this.indexSaveTimer);
      this.indexSaveTimer = null;
    }
    if (this.indexDirty) {
      this.indexDirty = false;
      await writeJsonAtomic(INDEX_FILE, this.index).catch(() => {});
    }
    if (this.writeStream) {
      await new Promise<void>(resolve => this.writeStream!.end(resolve));
      this.writeStream = null;
    }
  }
}

// ─── Global singleton ─────────────────────────────────────────────────────────
export const lifetimeBrain = new LifetimeBrain();

// Background init — doesn't block imports
lifetimeBrain.initialize().catch(err => {
  console.warn(`[LifetimeBrain] Background init failed: ${err instanceof Error ? err.message : String(err)}`);
});
