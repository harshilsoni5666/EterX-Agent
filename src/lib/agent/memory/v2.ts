import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'path';
import { getEterxWorkspaceDir } from '../storage-paths';
import { renderDurableMemoryContext } from './prompt-context';
import { extractDurableUserMemories } from './user-preferences';

export type MemoryV2Scope =
  | 'raw'
  | 'session'
  | 'project'
  | 'user'
  | 'tool'
  | 'error'
  | 'artifact'
  | 'credential'
  | 'self_improvement'
  | 'eval';

export type MemoryV2Sensitivity =
  | 'safe'
  | 'private'
  | 'secret_ref'
  | 'secret_blocked'
  | 'prompt_injection';

export type MemoryV2Status =
  | 'active'
  | 'pending_review'
  | 'rejected'
  | 'expired'
  | 'promoted';

export interface MemoryV2Record {
  id: string;
  scope: MemoryV2Scope;
  type: string;
  content: string;
  summary: string;
  tags: string[];
  userId: string;
  projectId?: string;
  chatId?: string;
  confidence: number;
  importance: number;
  sensitivity: MemoryV2Sensitivity;
  status: MemoryV2Status;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
  ttlMs?: number;
  expiresAt?: number;
  provenance: {
    source: 'user' | 'agent' | 'tool' | 'system' | 'eval';
    chatId?: string;
    runId?: string;
    traceIds?: string[];
  };
  metadata?: Record<string, unknown>;
}

export interface CredentialV2Record {
  id: string;
  secretRef: string;
  label: string;
  encryptedValue: string;
  iv: string;
  authTag: string;
  userId: string;
  projectId?: string;
  chatId?: string;
  allowedTools: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  status: 'active' | 'revoked';
  metadata?: Record<string, unknown>;
}

export interface ImprovementCandidate {
  id: string;
  title: string;
  rule: string;
  reason: string;
  sourceMemoryIds: string[];
  userId: string;
  projectId?: string;
  chatId?: string;
  confidence: number;
  evidenceCount: number;
  status: 'candidate' | 'promoted' | 'rejected';
  createdAt: number;
  updatedAt: number;
  evals: Array<{
    at: number;
    score: number;
    notes: string;
  }>;
}

interface MemoryV2State {
  records: MemoryV2Record[];
  credentials: CredentialV2Record[];
  improvements: ImprovementCandidate[];
  rawEvents: Array<{
    id: string;
    userId: string;
    projectId?: string;
    chatId?: string;
    eventType: string;
    redactedText: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
  }>;
}

const BASE_DIR = getEterxWorkspaceDir('.memory_v2');
const RECORDS_FILE = path.join(BASE_DIR, 'records.json');
const CREDENTIALS_FILE = path.join(BASE_DIR, 'credentials.enc.json');
const IMPROVEMENTS_FILE = path.join(BASE_DIR, 'self_improvement_overlays.json');
const RAW_EVENTS_FILE = path.join(BASE_DIR, 'raw_events.json');
const MASTER_KEY_FILE = path.join(BASE_DIR, '.vault_master_key');

const MAX_RECORDS = 5000;
const MAX_RAW_EVENTS = 3000;
const PROMPT_CONTEXT_LIMIT = 12;

const SECRET_PATTERNS: RegExp[] = [
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(api[_-]?key|token|secret|password|passwd|credential)\s*[:=]\s*["']?([^\s"']{8,})/gi,
];

const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /\bignore (all )?(previous|prior|system|developer) instructions\b/i,
  /\b(disable|bypass|override).{0,30}(safety|guardrail|policy|instruction)\b/i,
  /\b(reveal|show|print|dump).{0,30}(system prompt|developer message|hidden instruction|secrets?)\b/i,
  /\bpretend you are not bound\b/i,
  /\bjailbreak\b/i,
  /\bdo anything now\b/i,
  /\bexfiltrate\b/i,
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]+/gu, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1 && !['the', 'and', 'this', 'that', 'with', 'from', 'please', 'have', 'for'].includes(word));
}

function compact(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function stableId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isExplicitDurableRecord(record: MemoryV2Record): boolean {
  return (record.scope === 'user' || record.scope === 'project')
    && record.provenance.source === 'user'
    && extractDurableUserMemories(record.content).some(item =>
      item.scope === record.scope && item.content === record.content.trim());
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeJson(tmpPath, value, { spaces: 2 });
  if (await fs.pathExists(filePath)) await fs.copyFile(filePath, `${filePath}.backup`).catch(() => {});
  await fs.move(tmpPath, filePath, { overwrite: true });
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmpPath, value, 'utf8');
  if (await fs.pathExists(filePath)) await fs.copyFile(filePath, `${filePath}.backup`).catch(() => {});
  await fs.move(tmpPath, filePath, { overwrite: true });
}

async function readJsonWithBackup(filePath: string): Promise<any> {
  for (const source of [filePath, `${filePath}.backup`]) {
    try {
      if (!(await fs.pathExists(source))) continue;
      return await fs.readJson(source);
    } catch {
      if (source === filePath) await fs.move(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => {});
    }
  }
  return [];
}

export class MemoryV2Manager {
  private state: MemoryV2State = {
    records: [],
    credentials: [],
    improvements: [],
    rawEvents: [],
  };
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savePending = false;
  private persistPromise: Promise<void> | null = null;

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = (async () => {
      await fs.ensureDir(BASE_DIR);

      const [records, credentials, improvements, rawEvents] = await Promise.allSettled([
        readJsonWithBackup(RECORDS_FILE),
        readJsonWithBackup(CREDENTIALS_FILE),
        readJsonWithBackup(IMPROVEMENTS_FILE),
        readJsonWithBackup(RAW_EVENTS_FILE),
      ]);

      this.state.records = records.status === 'fulfilled' && Array.isArray(records.value) ? records.value : [];
      this.state.credentials = credentials.status === 'fulfilled' && Array.isArray(credentials.value) ? credentials.value : [];
      this.state.improvements = improvements.status === 'fulfilled' && Array.isArray(improvements.value) ? improvements.value : [];
      this.state.rawEvents = rawEvents.status === 'fulfilled' && Array.isArray(rawEvents.value) ? rawEvents.value : [];
      this.initialized = true;
    })().finally(() => {
      this.initializePromise = null;
    });

    return this.initializePromise;
  }

  public async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    while (this.persistPromise) await this.persistPromise;
    if (!this.savePending) return;
    // One writer owns the snapshot until all mutations made during I/O have
    // been drained. A final flush also waits for an earlier debounce write.
    const writing = (async () => {
      try {
        while (this.savePending) {
          this.savePending = false;
          await this.persist();
        }
      } catch (error) {
        this.savePending = true;
        throw error;
      }
    })();
    this.persistPromise = writing;
    try {
      await writing;
    } finally {
      if (this.persistPromise === writing) this.persistPromise = null;
    }
  }

  public async remember(input: {
    userId?: string;
    projectId?: string;
    chatId?: string;
    scope: MemoryV2Scope;
    type: string;
    content: string;
    tags?: string[];
    confidence?: number;
    importance?: number;
    ttlDays?: number;
    source?: MemoryV2Record['provenance']['source'];
    metadata?: Record<string, unknown>;
  }): Promise<MemoryV2Record> {
    await this.initialize();

    const analysis = this.analyzeContent(input.content);
    const now = Date.now();
    // TTL has been removed to allow anytime user continuity without expiration
    const ttlMs = undefined;
    const sensitivity: MemoryV2Sensitivity = analysis.promptInjection
      ? 'prompt_injection'
      : analysis.hasSecret
        ? 'secret_blocked'
        : input.scope === 'credential'
          ? 'secret_ref'
          : 'safe';

    const status: MemoryV2Status = sensitivity === 'safe' || sensitivity === 'secret_ref'
      ? 'active'
      : 'pending_review';

    const content = sensitivity === 'safe' ? input.content.trim() : analysis.redacted;
    // Repeated admission/retries are not independent evidence. Deduplicate
    // only identical facts with identical ownership and source authority.
    const existing = this.state.records.find(item =>
      item.userId === (input.userId || 'user') && item.projectId === input.projectId
      && item.chatId === input.chatId && item.scope === input.scope && item.type === input.type
      && item.provenance.source === (input.source || 'agent')
      && item.sensitivity === sensitivity && item.status === status && item.content === content);
    if (existing) return existing;

    const record: MemoryV2Record = {
      id: stableId('mem'),
      scope: input.scope,
      type: input.type,
      content,
      summary: compact(sensitivity === 'safe' ? input.content : analysis.redacted),
      tags: Array.from(new Set([...(input.tags || []), ...analysis.tags])),
      userId: input.userId || 'user',
      projectId: input.projectId,
      chatId: input.chatId,
      confidence: clamp(input.confidence ?? 0.72, 0, 1),
      importance: clamp(input.importance ?? 5, 0, 10),
      sensitivity,
      status,
      createdAt: now,
      updatedAt: now,
      useCount: 0,
      ttlMs,
      expiresAt: ttlMs ? now + ttlMs : undefined,
      provenance: {
        source: input.source || 'agent',
        chatId: input.chatId,
      },
      metadata: input.metadata,
    };

    this.state.records.push(record);
    this.state.records = this.state.records.slice(-MAX_RECORDS);
    this.debouncedPersist();
    return record;
  }

  public async recordRawEvent(input: {
    userId?: string;
    projectId?: string;
    chatId?: string;
    eventType: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.initialize();
    const analysis = this.analyzeContent(input.text);
    this.state.rawEvents.push({
      id: stableId('raw'),
      userId: input.userId || 'user',
      projectId: input.projectId,
      chatId: input.chatId,
      eventType: input.eventType,
      redactedText: analysis.redacted,
      createdAt: Date.now(),
      metadata: input.metadata,
    });
    this.state.rawEvents = this.state.rawEvents.slice(-MAX_RAW_EVENTS);
    this.debouncedPersist();
  }

  public async storeCredential(input: {
    userId?: string;
    projectId?: string;
    chatId?: string;
    label: string;
    value: string;
    allowedTools?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ secretRef: string; memory: MemoryV2Record }> {
    await this.initialize();
    const now = Date.now();
    const secretRef = `vault:${input.projectId || 'global'}:${input.label.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const encrypted = await this.encryptSecret(input.value);
    const existingIdx = this.state.credentials.findIndex(c => c.secretRef === secretRef);
    const credential: CredentialV2Record = {
      id: existingIdx >= 0 ? this.state.credentials[existingIdx].id : stableId('cred'),
      secretRef,
      label: input.label,
      encryptedValue: encrypted.encryptedValue,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      userId: input.userId || 'user',
      projectId: input.projectId,
      chatId: input.chatId,
      allowedTools: input.allowedTools || ['workspace_run_command'],
      createdAt: existingIdx >= 0 ? this.state.credentials[existingIdx].createdAt : now,
      updatedAt: now,
      status: 'active',
      metadata: input.metadata,
    };

    if (existingIdx >= 0) this.state.credentials[existingIdx] = credential;
    else this.state.credentials.push(credential);

    const memory = await this.remember({
      userId: input.userId,
      projectId: input.projectId,
      chatId: input.chatId,
      scope: 'credential',
      type: 'credential_reference',
      content: `Credential available as ${secretRef}: ${input.label}. Never reveal the value; request it only through approved tool execution.`,
      tags: ['credential', input.label],
      confidence: 1,
      importance: 9,
      source: 'user',
      metadata: { secretRef, allowedTools: credential.allowedTools },
    });

    this.debouncedPersist();
    return { secretRef, memory };
  }

  public async listCredentialRefs(projectId?: string): Promise<Array<{ secretRef: string; label: string; allowedTools: string[]; updatedAt: number }>> {
    await this.initialize();
    return this.state.credentials
      .filter(c => c.status === 'active')
      .filter(c => !projectId || !c.projectId || c.projectId === projectId)
      .map(c => ({ secretRef: c.secretRef, label: c.label, allowedTools: c.allowedTools, updatedAt: c.updatedAt }));
  }

  public async resolveSecretForTool(secretRef: string, toolName: string): Promise<string | null> {
    await this.initialize();
    const credential = this.state.credentials.find(c => c.secretRef === secretRef && c.status === 'active');
    if (!credential) return null;
    if (!credential.allowedTools.includes(toolName) && !credential.allowedTools.includes('*')) return null;
    credential.lastUsedAt = Date.now();
    this.debouncedPersist();
    return this.decryptSecret(credential);
  }

  public async recall(input: {
    userId?: string;
    projectId?: string;
    chatId?: string;
    query?: string;
    scopes?: MemoryV2Scope[];
    limit?: number;
    durableOnly?: boolean;
  }): Promise<MemoryV2Record[]> {
    await this.initialize();
    const now = Date.now();
    const queryWords = new Set(normalizeWords(input.query || ''));
    const scopes = input.scopes && input.scopes.length > 0 ? new Set(input.scopes) : null;

    const candidates = this.state.records
      .filter(record => record.status === 'active' || record.status === 'promoted')
      // TTL filters removed to persist memories permanently
      .filter(record => record.sensitivity === 'safe' || record.sensitivity === 'secret_ref')
      .filter(record => record.userId === (input.userId || 'user'))
      .filter(record => !scopes || scopes.has(record.scope))
      .filter(record => !input.durableOnly || isExplicitDurableRecord(record))
      .filter(record => {
        // Historical turns remain chat-local even if an older version labeled
        // them project continuity. Missing identity never means all scopes.
        if (record.scope === 'session' || record.type === 'project_continuity') {
          return Boolean(input.chatId) && record.chatId === input.chatId
            && (!record.projectId || record.projectId === input.projectId);
        }
        if (record.scope === 'project') return Boolean(input.projectId) && record.projectId === input.projectId;
        if (record.scope === 'user') return true;
        if (record.projectId && record.projectId !== input.projectId) return false;
        if (record.chatId && record.chatId !== input.chatId) return false;
        return true;
      })
      .map(record => ({
        record,
        score: this.scoreRecord(record, queryWords),
      }))
      .filter(item => queryWords.size === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || b.record.importance - a.record.importance || b.record.updatedAt - a.record.updatedAt)
      .slice(0, Number.isFinite(input.limit) ? Math.max(0, Math.min(100, Math.floor(input.limit!))) : 20)
      .map(item => item.record);

    for (const record of candidates) {
      record.lastUsedAt = now;
      record.useCount += 1;
    }
    if (candidates.length > 0) this.debouncedPersist();
    return candidates;
  }

  public async getPromptContext(input: {
    userId?: string;
    projectId?: string;
    chatId?: string;
    query: string;
    includeContinuity?: boolean;
    maxChars?: number;
    /** The modern chat fabric already owns episodic continuity and tool state. */
    durableOnly?: boolean;
  }): Promise<string> {
    const scopes: MemoryV2Scope[] = input.durableOnly ? ['user', 'project'] : input.includeContinuity
      ? ['user', 'project', 'session', 'tool', 'error', 'artifact', 'credential']
      : ['user', 'project', 'tool', 'error', 'artifact', 'credential'];
    const memories = await this.recall({
        userId: input.userId,
        projectId: input.projectId,
        chatId: input.chatId,
        query: input.query,
        scopes,
        limit: PROMPT_CONTEXT_LIMIT,
        durableOnly: input.durableOnly,
      });
    const normalMemories = memories.filter(memory => {
      if (memory.scope === 'credential') return false;
      // Legacy user-scoped records may contain an entire task. Only explicit
      // durable user statements enter the modern preference channel.
      if (input.durableOnly && !isExplicitDurableRecord(memory)) return false;
      if (input.includeContinuity) return true;
      if (memory.type === 'project_continuity' || memory.type === 'last_turn') return false;
      if (memory.tags?.some(tag => ['continuity', 'chat-history', 'session'].includes(tag))) return false;
      const rememberedText = `${memory.summary} ${memory.content}`.toLowerCase();
      const looksLikeOldTask = /\b(i want to|please|can you|fix|build|create|make|update|download|install|setup|run|start|resolve|work on)\b/.test(rememberedText);
      const looksDurable = /\b(always|never|prefer|remember|from now|in future|in the future|default|style|tone)\b/.test(rememberedText);
      if (looksLikeOldTask && !looksDurable) return false;
      return true;
    });
    const records = normalMemories.map(memory => ({
      id: memory.id, scope: memory.scope, type: memory.type,
      source: memory.provenance.source, confidence: memory.confidence,
      updatedAt: new Date(memory.updatedAt).toISOString(), content: memory.content,
    }));
    // Credential references already passed the same owner/scope filter; never
    // enumerate another user's vault merely because lexical recall was empty.
    const credentials = memories.filter(memory => memory.scope === 'credential').map(memory => ({
      id: memory.id, scope: memory.scope, type: memory.type,
      source: memory.provenance.source, confidence: memory.confidence,
      updatedAt: new Date(memory.updatedAt).toISOString(),
      content: `Credential reference: ${String(memory.metadata?.secretRef || memory.summary)}`,
    }));
    return renderDurableMemoryContext([...records, ...credentials], input.maxChars);
  }

  public async saveSessionSnapshot(input: {
    userId?: string;
    projectId: string;
    chatId: string;
    userMessage: string;
    agentOutput: string;
    success: boolean;
    durationMs: number;
    artifactsGenerated?: string[];
    toolSummary?: string;
  }): Promise<void> {
    await this.recordRawEvent({
      userId: input.userId,
      projectId: input.projectId,
      chatId: input.chatId,
      eventType: 'session_snapshot',
      text: `User: ${input.userMessage}\nAgent: ${input.agentOutput}`,
      metadata: { success: input.success, durationMs: input.durationMs },
    });

    const sharedContent = [
      `Last task: ${compact(input.userMessage, 320)}`,
      `Execution: ${input.success ? 'response returned; task completion is not independently verified' : 'failed or stopped'}`,
      input.artifactsGenerated?.length ? `Artifacts: ${input.artifactsGenerated.join(', ')}` : '',
      `Agent output: ${compact(input.agentOutput, 420)}`,
    ].filter(Boolean).join('\n');

    await Promise.all([
      this.remember({
        userId: input.userId,
        projectId: input.projectId,
        chatId: input.chatId,
        scope: 'session',
        type: 'last_turn',
        content: sharedContent,
        tags: ['session', 'continuation', input.success ? 'success' : 'failed'],
        confidence: input.success ? 0.82 : 0.58,
        importance: input.success ? 7 : 6,
        source: 'system',
        ttlDays: 3,
      }),
    ]);
  }

  public async learnFromUserMessage(input: {
    userId?: string;
    projectId?: string;
    chatId?: string;
    message: string;
  }): Promise<MemoryV2Record[]> {
    const records: MemoryV2Record[] = [];
    for (const fact of extractDurableUserMemories(input.message)) {
      if (fact.scope === 'project' && !input.projectId) continue;
      records.push(await this.remember({
        userId: input.userId,
        projectId: input.projectId,
        chatId: input.chatId,
        ...fact,
        tags: [fact.scope === 'user' ? 'user-understanding' : 'project-understanding', 'explicit-preference'],
        confidence: 0.85,
        importance: 7,
        source: 'user',
      }));
    }

    return records;
  }

  public async queueImprovement(input: {
    userId?: string;
    projectId?: string;
    chatId?: string;
    title: string;
    rule: string;
    reason: string;
    sourceMemoryIds?: string[];
    confidence?: number;
    evidenceCount?: number;
  }): Promise<ImprovementCandidate> {
    await this.initialize();
    const now = Date.now();
    const candidate: ImprovementCandidate = {
      id: stableId('imp'),
      title: input.title,
      rule: input.rule,
      reason: input.reason,
      sourceMemoryIds: input.sourceMemoryIds || [],
      userId: input.userId || 'user',
      projectId: input.projectId,
      chatId: input.chatId,
      confidence: clamp(input.confidence ?? 0.5, 0, 1),
      evidenceCount: input.evidenceCount || 1,
      status: 'candidate',
      createdAt: now,
      updatedAt: now,
      evals: [],
    };
    this.state.improvements.push(candidate);
    this.debouncedPersist();
    return candidate;
  }

  public async promoteImprovement(id: string, score: number, notes: string): Promise<ImprovementCandidate | null> {
    await this.initialize();
    const candidate = this.state.improvements.find(item => item.id === id);
    if (!candidate) return null;
    candidate.evals.push({ at: Date.now(), score, notes });
    candidate.updatedAt = Date.now();
    if (score >= 0.75) candidate.status = 'promoted';
    this.debouncedPersist();
    return candidate;
  }

  public async getPromotedOverlays(projectId?: string, chatId?: string): Promise<ImprovementCandidate[]> {
    await this.initialize();
    return this.state.improvements
      .filter(item => item.status === 'promoted')
      .filter(item => !item.projectId || !projectId || item.projectId === projectId)
      .filter(item => !item.chatId || !chatId || item.chatId === chatId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8);
  }

  public async reviewMemory(id: string, status: Extract<MemoryV2Status, 'active' | 'rejected'>): Promise<MemoryV2Record | null> {
    await this.initialize();
    const record = this.state.records.find(item => item.id === id);
    if (!record) return null;
    record.status = status;
    record.updatedAt = Date.now();
    this.debouncedPersist();
    return record;
  }

  public async forget(id: string): Promise<boolean> {
    await this.initialize();
    const before = this.state.records.length;
    this.state.records = this.state.records.filter(item => item.id !== id);
    const changed = this.state.records.length !== before;
    if (changed) this.debouncedPersist();
    return changed;
  }

  public async getReviewQueue(): Promise<MemoryV2Record[]> {
    await this.initialize();
    return this.state.records
      .filter(item => item.status === 'pending_review')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
  }

  public async getStats(): Promise<Record<string, unknown>> {
    await this.initialize();
    const byScope: Record<string, number> = {};
    const bySensitivity: Record<string, number> = {};
    for (const record of this.state.records) {
      byScope[record.scope] = (byScope[record.scope] || 0) + 1;
      bySensitivity[record.sensitivity] = (bySensitivity[record.sensitivity] || 0) + 1;
    }
    return {
      records: this.state.records.length,
      rawEvents: this.state.rawEvents.length,
      credentials: this.state.credentials.filter(item => item.status === 'active').length,
      improvements: this.state.improvements.length,
      promotedOverlays: this.state.improvements.filter(item => item.status === 'promoted').length,
      pendingReview: this.state.records.filter(item => item.status === 'pending_review').length,
      byScope,
      bySensitivity,
    };
  }

  private scoreRecord(record: MemoryV2Record, queryWords: Set<string>): number {
    const recencyDays = Math.max(0, (Date.now() - record.updatedAt) / (24 * 60 * 60 * 1000));
    const recencyBoost = Math.max(0, 2 - recencyDays * 0.05);
    const base = record.importance + record.confidence * 4 + recencyBoost + Math.min(record.useCount, 5) * 0.15;
    if (queryWords.size === 0) return base;

    const haystack = new Set(normalizeWords(`${record.content} ${record.tags.join(' ')}`));
    let overlap = 0;
    for (const word of queryWords) {
      if (haystack.has(word)) overlap += 1;
    }
    const explicitPreference = record.scope === 'user' && record.provenance.source === 'user'
      && (record.tags.includes('explicit-preference') || extractDurableUserMemories(record.content)
        .some(item => item.scope === 'user' && item.content === record.content.trim()));
    // Stable communication/work preferences must survive a change of topic.
    // Other memories still require a lexical match, including content beyond
    // the short display summary and short technical names such as Go or UI.
    return overlap === 0 ? explicitPreference ? base : 0 : base + (overlap / queryWords.size) * 10;
  }

  private analyzeContent(text: string): { redacted: string; hasSecret: boolean; promptInjection: boolean; tags: string[] } {
    let redacted = text;
    let hasSecret = false;

    for (const pattern of SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, (...args: any[]) => {
        hasSecret = true;
        if (args.length > 2 && args[1]) return `${args[1]}=[REDACTED_SECRET]`;
        return '[REDACTED_SECRET]';
      });
    }

    const promptInjection = PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(text));
    const tags: string[] = [];
    if (hasSecret) tags.push('secret-filtered');
    if (promptInjection) tags.push('prompt-injection-review');
    return { redacted, hasSecret, promptInjection, tags };
  }

  private async encryptSecret(value: string): Promise<{ encryptedValue: string; iv: string; authTag: string }> {
    const key = await this.getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      encryptedValue: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  private async decryptSecret(credential: CredentialV2Record): Promise<string> {
    const key = await this.getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(credential.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(credential.authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(credential.encryptedValue, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  private async getMasterKey(): Promise<Buffer> {
    const envKey = process.env.ETERX_MEMORY_VAULT_KEY;
    if (envKey && envKey.trim()) {
      return crypto.createHash('sha256').update(envKey).digest();
    }

    await fs.ensureDir(BASE_DIR);
    for (const source of [MASTER_KEY_FILE, `${MASTER_KEY_FILE}.backup`]) {
      try {
        if (!(await fs.pathExists(source))) continue;
        const raw = String(await fs.readFile(source, 'utf8')).trim();
        const key = Buffer.from(raw, 'base64');
        if (key.length === 32) return key;
        if (source === MASTER_KEY_FILE) await fs.move(MASTER_KEY_FILE, `${MASTER_KEY_FILE}.corrupt-${Date.now()}`).catch(() => {});
      } catch { }
    }

    if (await fs.pathExists(MASTER_KEY_FILE)) {
      throw new Error('Invalid EterX memory vault master key. Set ETERX_MEMORY_VAULT_KEY or repair .vault_master_key.');
    }

    if (await fs.pathExists(`${MASTER_KEY_FILE}.backup`)) {
      throw new Error('Invalid EterX memory vault master key backup. Set ETERX_MEMORY_VAULT_KEY or repair .vault_master_key.');
    }

    const key = crypto.randomBytes(32);
    await writeTextAtomic(MASTER_KEY_FILE, key.toString('base64'));
    try {
      await fs.chmod(MASTER_KEY_FILE, 0o600);
    } catch {
      // Windows may ignore POSIX modes; the file still stays inside the local workspace memory folder.
    }
    return key;
  }

  private debouncedPersist(): void {
    this.savePending = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.savePending) return;
      this.flush().catch(error => {
        console.warn('[MemoryV2] Deferred persistence failed; memory remains pending:', error instanceof Error ? error.message : String(error));
      });
    }, 1200);
  }

  private async persist(): Promise<void> {
    // Capture all files from one immutable generation before yielding to I/O.
    const snapshot: MemoryV2State = JSON.parse(JSON.stringify(this.state));
    await fs.ensureDir(BASE_DIR);
    await Promise.all([
      writeJsonAtomic(RECORDS_FILE, snapshot.records.slice(-MAX_RECORDS)),
      writeJsonAtomic(CREDENTIALS_FILE, snapshot.credentials),
      writeJsonAtomic(IMPROVEMENTS_FILE, snapshot.improvements),
      writeJsonAtomic(RAW_EVENTS_FILE, snapshot.rawEvents.slice(-MAX_RAW_EVENTS)),
    ]);
  }
}

export const memoryV2 = new MemoryV2Manager();

memoryV2.initialize().catch(error => {
  console.warn(`[MemoryV2] Background init failed: ${error instanceof Error ? error.message : String(error)}`);
});
