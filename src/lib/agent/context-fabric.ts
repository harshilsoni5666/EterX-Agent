/**
 * EterX Context Fabric
 *
 * Provider-neutral, loss-aware working memory for long-running agent tasks.
 * The model may propose a compact summary, but it is not allowed to become the
 * sole owner of state. Critical facts live in an append-only, hash-chained log,
 * are materialized into a query-ranked working set, and are deterministically
 * checked whenever history is compacted.
 */

import path from 'path';
import { visibleUserRequest } from '../chat-user-payload';
import { createHash } from 'crypto';
import { open as openFile } from 'fs/promises';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import fs from 'fs-extra';
import { getEterxWorkspaceDir } from './storage-paths';
import { stableScopeSegment } from './context-scope';
import { TfIdfVectorizer, cosineSimilarity } from './memory/divergence';
import {
  classifyToolSemantics,
  extractToolTargets,
  getToolResultOutcome,
  toolResultChangedState,
  toolResultSucceeded,
  type ToolEffect,
} from './tool-semantics';

export type ContextFactKind =
  | 'objective'
  | 'constraint'
  | 'decision'
  | 'state'
  | 'evidence'
  | 'artifact'
  | 'failure'
  | 'next_action'
  | 'reference'
  | 'preference'
  | 'milestone';

export type ContextFactStatus = 'active' | 'resolved' | 'superseded';
export type ContextEpistemicStatus = 'observed' | 'user_asserted' | 'inferred';
export type ContextMemoryNetwork = 'world' | 'experience' | 'observation' | 'belief';

const activeFactIdentity = (kind: ContextFactKind, key: string): string => `${kind}\u0000${key}`;

export interface MemoryValueFactors {
  affectiveIntensity: number;
  goalRelevance: number;
  valueAlignment: number;
  userRelevance: number;
  taskUtility: number;
  reliability: number;
  usageHistory: number;
}

export interface ContextEpisode {
  id: string;
  sequence: number;
  source: ContextProvenance['source'];
  createdAt: number;
  /** Stable source identity used to import a durable chat transcript exactly once. */
  originId?: string;
  header: string;
  contentPreview: string;
  contentHash: string;
  pageRef: string;
  toolName?: string;
  targets: string[];
}

export interface ContextLink {
  id: string;
  fromFactId: string;
  toFactId: string;
  relation: 'same_target' | 'shared_entity' | 'supports' | 'contradicts' | 'caused_by' | 'followed_by';
  weight: number;
  createdAt: number;
}

export interface ContextRetrievalResult {
  facts: ContextFact[];
  episodes: ContextEpisode[];
  strategyCounts: Record<'lexical' | 'semantic' | 'graph' | 'temporal' | 'value', number>;
  estimatedTokens: number;
  omittedActiveCritical: number;
}

export interface ContextProvenance {
  source: 'user' | 'steering' | 'tool' | 'runtime' | 'compaction';
  sourceId: string;
  observedAt: number;
  toolName?: string;
  resultHash?: string;
  mutationEpoch?: number;
  pageRef?: string;
  /** Workspace observations stay reusable until a mutation overlaps their targets. */
  observationScope?: 'workspace' | 'external';
  /** Cheap external-change guard for absolute local targets observed by a read. */
  targetSnapshots?: ContextTargetSnapshot[];
}

export interface ContextTargetSnapshot {
  target: string;
  size: number;
  modifiedAtMs: number;
  kind: 'file' | 'directory';
}

export interface ContextFact {
  id: string;
  key: string;
  kind: ContextFactKind;
  network: ContextMemoryNetwork;
  status: ContextFactStatus;
  epistemic: ContextEpistemicStatus;
  text: string;
  exactValues: string[];
  targets: string[];
  importance: number;
  firstObservedAt: number;
  lastObservedAt: number;
  observations: number;
  revision: number;
  validFrom: number;
  validTo?: number;
  recordedAt: number;
  invalidatedAt?: number;
  entities: string[];
  retrievalCount: number;
  valueFactors: MemoryValueFactors;
  supersededBy?: string;
  resolvedBy?: string;
  provenance: ContextProvenance[];
}

export interface ContextManifestFact {
  id: string;
  /** Optional for older persisted manifests. Identifies the source record's role. */
  key?: string;
  revision?: number;
  fingerprint: string;
  kind: ContextFactKind;
  status: ContextFactStatus;
  epistemic: ContextEpistemicStatus;
  text: string;
  exactValues: string[];
  source: string;
  importance: number;
  network: ContextMemoryNetwork;
  validFrom: number;
  validTo?: number;
  pageRefs: string[];
}

export interface ContextContinuityManifest {
  version: 1;
  scopeId: string;
  revision: number;
  mutationEpoch: number;
  createdAt: number;
  facts: ContextManifestFact[];
  /** Active records outside the bounded transfer frontier remain durable in Context Fabric. */
  omittedCriticalCount?: number;
  omittedCriticalPageRefs?: string[];
  learnedGuidelines: string[];
  pageRefs: string[];
  manifestHash: string;
}

export interface ContextFabricSnapshot {
  version: 1;
  scopeId: string;
  revision: number;
  mutationEpoch: number;
  lastEventHash: string;
  /** New ledgers hash their exact JSON representation, so every persisted event is restart-verifiable. */
  eventHashVersion?: 2;
  /** Exact end of a structurally chained v1 prefix retained during an in-place upgrade. */
  legacyEventPrefix?: { sequence: number; hash: string };
  /** Integrity seal for the complete materialized snapshot, excluding this field. */
  snapshotHash?: string;
  /** True only when this process materialized every ledger event through revision. */
  replaySafe?: true;
  facts: ContextFact[];
  episodes?: ContextEpisode[];
  links?: ContextLink[];
  memoryPolicy?: MemoryPolicyState;
  latestCompactionCheckpoint?: ContextCompactionCheckpoint;
  /** In-memory only when durable persistence is disabled; never written by a durable fabric. */
  ephemeralPageContents?: Record<string, string>;
}

export interface ContextCompactionCheckpoint {
  compactionId: string;
  manifestHash: string;
  capsuleHash: string;
  recordedAt: number;
  sequence: number;
}

export interface MemoryPolicyState {
  weights: MemoryValueFactors;
  successfulOutcomes: number;
  failedOutcomes: number;
  learnedGuidelines: string[];
  /** Durable retrieval emphasis learned when a fact kind was omitted. */
  kindUtilityBoosts?: Partial<Record<ContextFactKind, number>>;
}

type ContextEventOperation = 'upsert' | 'episode' | 'link' | 'policy' | 'checkpoint';

interface ContextFabricEvent {
  version: 1 | 2;
  scopeId: string;
  sequence: number;
  timestamp: number;
  operation: ContextEventOperation;
  fact?: ContextFact;
  episode?: ContextEpisode;
  link?: ContextLink;
  memoryPolicy?: MemoryPolicyState;
  checkpoint?: {
    compactionId: string;
    manifestHash: string;
    capsuleHash: string;
  };
  previousHash: string;
  hash: string;
}

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isStoredFactShape = (value: unknown): value is ContextFact =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.text === 'string'
  && (value.provenance === undefined || Array.isArray(value.provenance))
  && (value.exactValues === undefined || Array.isArray(value.exactValues))
  && (value.targets === undefined || Array.isArray(value.targets))
  && (value.entities === undefined || Array.isArray(value.entities));

const isStoredEpisodeShape = (value: unknown): value is ContextEpisode =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.pageRef === 'string'
  && (value.targets === undefined || Array.isArray(value.targets));

const isContextFabricEventPayloadValid = (event: ContextFabricEvent): boolean => {
  if (event.version !== 1 && event.version !== 2) return false;
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) return false;
  if (!['upsert', 'episode', 'link', 'policy', 'checkpoint'].includes(event.operation)) return false;
  if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0) return false;
  if (!/^[0-9a-f]{64}$/i.test(String(event.hash || ''))) return false;
  if (event.previousHash && !/^[0-9a-f]{64}$/i.test(String(event.previousHash))) return false;
  if (event.operation === 'upsert') return isStoredFactShape(event.fact);
  if (event.operation === 'episode') return isStoredEpisodeShape(event.episode);
  if (event.operation === 'link') {
    return isRecord(event.link)
      && typeof event.link.id === 'string'
      && typeof event.link.fromFactId === 'string'
      && typeof event.link.toFactId === 'string';
  }
  if (event.operation === 'policy') {
    return isRecord(event.memoryPolicy)
      && isRecord(event.memoryPolicy.weights)
      && Array.isArray(event.memoryPolicy.learnedGuidelines);
  }
  return isRecord(event.checkpoint)
    && /^[A-Za-z0-9_-]{1,220}$/.test(String(event.checkpoint.compactionId || ''))
    && /^[0-9a-f]{64}$/i.test(String(event.checkpoint.manifestHash || ''))
    && /^[0-9a-f]{64}$/i.test(String(event.checkpoint.capsuleHash || ''));
};

export interface ContextCapsuleAudit {
  coveredFactIds: string[];
  missingFactIds: string[];
  coverageRatio: number;
}

export interface ContextFabricOptions {
  durable?: boolean;
  storageRoot?: string;
  snapshot?: ContextFabricSnapshot | null;
}

const DEFAULT_CONTEXT_ROOT = getEterxWorkspaceDir('.context', 'fabric');
const MAX_PROVENANCE_PER_FACT = 12;
const MAX_FACT_TEXT = 6_000;
const MAX_RESULT_SUMMARY = 900;
const MAX_REUSABLE_OBSERVATION = 4_200;
const MAX_MANIFEST_FACTS = 180;
const MAX_MANIFEST_CHARS = 54_000;
const MAX_WORKING_SET_CHARS = 18_000;
const MAX_SEMANTIC_FACT_CANDIDATES = 880;
const MAX_RECENT_EPISODE_CANDIDATES = 800;
const MAX_WORKSPACE_FRESHNESS_CANDIDATES = 64;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_EPISODE_BYTES = 256 * 1024 * 1024;
const MAX_PAGE_CHUNKS = Math.ceil(MAX_EPISODE_BYTES / MAX_PAGE_BYTES);
const MAX_PAGE_MANIFEST_BYTES = 128 * 1024;
const EVENT_LEDGER_LEASE_STALE_MS = 2 * 60_000;
const EVENT_LEDGER_LEASE_WAIT_MS = 30_000;
const SNAPSHOT_IDLE_DELAY_MS = 30_000;
const SNAPSHOT_EVENT_INTERVAL = 64;
const MAX_RECENT_FACT_INDEX = 1_024;
const MAX_RECENT_EPISODE_INDEX = 1_024;
const MAX_LEXICAL_TERMS_PER_FACT = 96;
const MAX_LEXICAL_POSTINGS_PER_TERM = 512;
const MAX_LEXICAL_MATCH_POOL = 4_000;
const MAX_COMPILED_WORKING_SET_CACHE = 6;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const MAX_COMPRESSED_PAGE_BYTES = MAX_PAGE_BYTES + (1024 * 1024);

const gunzipContextPage = async (compressed: Buffer): Promise<Buffer> => {
  if (compressed.length > MAX_COMPRESSED_PAGE_BYTES) {
    throw new Error('Compressed context page exceeds its bounded page size.');
  }
  return await (gunzipAsync as any)(compressed, {
    maxOutputLength: MAX_PAGE_BYTES + 1,
  }) as Buffer;
};

const persistImmutableContextPageFile = async (
  destination: string,
  contents: Buffer,
  validateExisting: (contents: Buffer) => Promise<boolean>,
): Promise<void> => {
  await fs.ensureDir(path.dirname(destination));
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx' });
    try {
      await fs.move(temporary, destination, { overwrite: false });
      return;
    } catch (moveError) {
      if (!await fs.pathExists(destination)) throw moveError;
      const existing = await fs.readFile(destination);
      if (await validateExisting(existing)) return;
      throw new Error(`Context page identity collision at ${path.basename(destination)}.`);
    }
  } finally {
    await fs.remove(temporary).catch(() => undefined);
  }
};

const readOptionalDurableJson = async <T>(filePath: string): Promise<T | null> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fs.readJson(filePath) as T;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      if (attempt >= 2) {
        throw new Error(`Context Fabric could not read ${path.basename(filePath)} safely: ${String(error?.message || error)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  return null;
};

const readOptionalDurableText = async (filePath: string): Promise<string> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return '';
      if (attempt >= 2) {
        throw new Error(`Context Fabric could not read ${path.basename(filePath)} safely: ${String(error?.message || error)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  return '';
};

interface DurableLedgerTail {
  size: number;
  endsWithNewline: boolean;
  tailText: string;
}

interface DurableLedgerSlice {
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
  text: string;
}

/**
 * Read only the final JSONL record. Normal event admission needs the durable
 * chain tip, not the entire history; making that check proportional to the
 * ledger made every later turn slower than the one before it.
 */
const readDurableLedgerTail = async (filePath: string): Promise<DurableLedgerTail> => {
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  try {
    handle = await openFile(filePath, 'r');
    const stat = await handle.stat();
    const size = stat.size;
    if (size <= 0) return { size: 0, endsWithNewline: false, tailText: '' };
    const readExactly = async (buffer: Buffer, position: number) => {
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle!.read(
          buffer,
          offset,
          buffer.length - offset,
          position + offset,
        );
        if (bytesRead <= 0) throw new Error('Context Fabric event ledger changed during tail validation.');
        offset += bytesRead;
      }
    };

    const finalByte = Buffer.allocUnsafe(1);
    await readExactly(finalByte, size - 1);
    const endsWithNewline = finalByte[0] === 0x0a;
    let endExclusive = endsWithNewline ? size - 1 : size;
    if (endsWithNewline && endExclusive > 0) {
      const precedingByte = Buffer.allocUnsafe(1);
      await readExactly(precedingByte, endExclusive - 1);
      if (precedingByte[0] === 0x0d) endExclusive -= 1;
    }

    const segments: Buffer[] = [];
    let cursor = endExclusive;
    const chunkSize = 64 * 1024;
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunkSize);
      const chunk = Buffer.allocUnsafe(cursor - start);
      await readExactly(chunk, start);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) {
        segments.unshift(chunk.subarray(newline + 1));
        break;
      }
      segments.unshift(chunk);
      cursor = start;
    }
    return {
      size,
      endsWithNewline,
      tailText: Buffer.concat(segments).toString('utf8').replace(/\r$/, ''),
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { size: 0, endsWithNewline: false, tailText: '' };
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
};

/**
 * Read only bytes appended after an already verified/materialized frontier.
 * The caller holds the cross-process writer lease, so the returned stat and
 * suffix describe one stable ledger generation.
 */
const readDurableLedgerSlice = async (
  filePath: string,
  startOffset: number,
): Promise<DurableLedgerSlice> => {
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  try {
    handle = await openFile(filePath, 'r');
    const stat = await handle.stat();
    const size = stat.size;
    if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > size) {
      throw new Error('Context Fabric event ledger moved behind its materialized frontier.');
    }
    const length = size - startOffset;
    if (length === 0) {
      return {
        size,
        modifiedAtMs: stat.mtimeMs,
        changedAtMs: stat.ctimeMs,
        text: '',
      };
    }
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        startOffset + offset,
      );
      if (bytesRead <= 0) {
        throw new Error('Context Fabric event ledger changed during incremental replay.');
      }
      offset += bytesRead;
    }
    return {
      size,
      modifiedAtMs: stat.mtimeMs,
      changedAtMs: stat.ctimeMs,
      text: buffer.toString('utf8'),
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT' && startOffset === 0) {
      return { size: 0, modifiedAtMs: 0, changedAtMs: 0, text: '' };
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return '"[Undefined]"';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`);
  if (typeof value === 'function' || typeof value === 'symbol') return JSON.stringify(String(value));
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  try {
    if (Buffer.isBuffer(value)) {
      return stableSerialize({ type: 'Buffer', base64: value.toString('base64') }, seen);
    }
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (value instanceof Error) {
      return stableSerialize({ name: value.name, message: value.message, stack: value.stack }, seen);
    }
    if (value instanceof Map) {
      return stableSerialize(Array.from(value.entries()).sort(([a], [b]) => String(a).localeCompare(String(b))), seen);
    }
    if (value instanceof Set) return stableSerialize(Array.from(value.values()).sort(), seen);
    if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Keep only the best bounded frontier without sorting or retaining an
 * arbitrarily large history. `compare` has the same ordering contract as
 * Array#sort: a negative result places the left item first.
 */
function boundedTop<T>(items: Iterable<T>, limit: number, compare: (left: T, right: T) => number): T[] {
  const capacity = Math.max(0, Math.floor(limit));
  if (capacity === 0) return [];
  const selected: T[] = [];
  for (const item of items) {
    let low = 0;
    let high = selected.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(item, selected[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    if (low >= capacity) continue;
    selected.splice(low, 0, item);
    if (selected.length > capacity) selected.pop();
  }
  return selected;
}

function calculateSnapshotHash(snapshot: ContextFabricSnapshot): string {
  const body = { ...snapshot };
  delete body.snapshotHash;
  return sha256(stableSerialize(body));
}

function normalizeText(value: unknown, max = MAX_FACT_TEXT): string {
  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalizeKey(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\b(?:must|should|please|never|not|don't|do not|no|only|always)\b/g, ' ')
    .replace(/[^a-z0-9_./:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

function uniqueStrings(values: unknown[], max = 24): string[] {
  return Array.from(new Set(values
    .flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => value !== null && value !== undefined && String(value).trim())
    .map(value => normalizeText(value, 700))))
    .slice(0, max);
}

function boundedValues(values: string[], maxChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const value of values) {
    const normalized = normalizeText(value, Math.min(700, maxChars));
    if (!normalized) continue;
    if (used + normalized.length + (kept.length > 0 ? 3 : 0) > maxChars) continue;
    kept.push(normalized);
    used += normalized.length + (kept.length > 1 ? 3 : 0);
  }
  return kept;
}

function renderBoundedValues(values: string[], maxChars: number): string {
  return boundedValues(values, maxChars).join(' ; ');
}

function extractExactValues(text: string): string[] {
  const values: string[] = [];
  const patterns = [
    /(?:[A-Za-z]:\\|\/)[^\s"'<>|]{3,}/g,
    /https?:\/\/[^\s<>"')]+/g,
    /\b(?:[0-9a-f]{8}-[0-9a-f-]{27,}|(?:run|task|chat|turn|trace|tool|agent|file|ctx)_[A-Za-z0-9_-]{6,})\b/gi,
    /`[^`\n]{2,240}`/g,
    /\b\d+(?:\.\d+)?(?:%|ms|s|MB|GB|KB|k|m)?\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) values.push(match[0].replace(/^`|`$/g, ''));
  }
  return uniqueStrings(values, 36);
}

function extractConstraintClauses(text: string): string[] {
  return text
    .split(/\r?\n|[.!?]+|,{2,}/)
    .map(part => normalizeText(part, 1_200))
    .filter(part => part.length >= 4)
    .filter(part => {
      const probe = part
        .toLowerCase()
        .replace(/\b(?:dotn|dont|do\s+nt)\b/g, 'do not')
        .replace(/\b(?:cant|can\s+nt)\b/g, 'cannot');
      return /\b(?:must|never|do not|don't|cannot|can't|without|only|avoid|required|prohibited|no need|all models?|every provider|equally|no git|not git)\b/i.test(probe);
    })
    .slice(0, 32);
}

function networkForKind(kind: ContextFactKind, epistemic: ContextEpistemicStatus): ContextMemoryNetwork {
  if (epistemic === 'inferred' || ['decision', 'next_action'].includes(kind)) return 'belief';
  if (['failure', 'milestone'].includes(kind)) return 'experience';
  if (['state', 'evidence', 'artifact'].includes(kind)) return 'observation';
  return 'world';
}

function extractEntities(text: string, targets: string[] = []): string[] {
  const candidates: string[] = [...targets];
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9_.-]{2,}(?:\s+[A-Z][A-Za-z0-9_.-]{2,}){0,3}\b/g)) {
    candidates.push(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_.-]{2,}(?=\.(?:ts|tsx|js|jsx|py|rs|go|json|md|yaml|yml|toml|sql)\b)/g)) {
    candidates.push(match[0]);
  }
  return uniqueStrings(candidates, 32);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function initialValueFactors(input: {
  kind: ContextFactKind;
  epistemic: ContextEpistemicStatus;
  importance: number;
  text: string;
  source: ContextProvenance['source'];
  observations?: number;
}): MemoryValueFactors {
  const binding = ['objective', 'constraint', 'preference'].includes(input.kind);
  const utility = ['constraint', 'decision', 'state', 'failure', 'next_action', 'evidence'].includes(input.kind);
  return {
    affectiveIntensity: clamp01(/\b(?:urgent|critical|danger|must|never|blocked|failure)\b/i.test(input.text) ? 0.85 : 0.12),
    goalRelevance: clamp01(binding ? 1 : input.importance / 10),
    valueAlignment: clamp01(binding ? 1 : input.kind === 'decision' ? 0.8 : 0.35),
    userRelevance: clamp01(input.source === 'user' || input.source === 'steering' ? 1 : binding ? 0.9 : 0.35),
    taskUtility: clamp01(utility ? Math.max(0.7, input.importance / 10) : input.importance / 12),
    reliability: clamp01(input.epistemic === 'observed' ? 1 : input.epistemic === 'user_asserted' ? 0.92 : 0.45),
    usageHistory: clamp01((input.observations || 0) / (1 + (input.observations || 0))),
  };
}

const DEFAULT_MEMORY_WEIGHTS: MemoryValueFactors = {
  affectiveIntensity: 0.30,
  goalRelevance: 1.40,
  valueAlignment: 1.10,
  userRelevance: 1.20,
  taskUtility: 1.50,
  reliability: 1.40,
  usageHistory: 0.75,
};

function memoryValue(factors: MemoryValueFactors, weights: MemoryValueFactors): number {
  return (Object.keys(weights) as Array<keyof MemoryValueFactors>)
    .reduce((sum, key) => sum + factors[key] * weights[key], 0);
}

function queryTerms(text: string): Set<string> {
  return new Set(normalizeKey(text).split(/\s+/).filter(term => term.length > 3));
}

function relevance(text: string, query: Set<string>): number {
  if (query.size === 0) return 0;
  const terms = queryTerms(text);
  let overlap = 0;
  for (const term of query) if (terms.has(term)) overlap += 1;
  return overlap / Math.max(1, Math.min(query.size, terms.size));
}

function normalizeTargetIdentity(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function targetsOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const normalizedLeft = left.map(normalizeTargetIdentity).filter(Boolean);
  const normalizedRight = right.map(normalizeTargetIdentity).filter(Boolean);
  return normalizedLeft.some(a => normalizedRight.some(b =>
    a === b
    || a.startsWith(`${b}/`)
    || b.startsWith(`${a}/`)
    // Tool adapters are not required to agree on absolute versus
    // workspace-relative paths. A path-boundary suffix is the same target;
    // a bare basename is intentionally not enough to avoid cross-folder
    // invalidation when a repository contains repeated filenames.
    || (a.includes('/') && b.includes('/') && a.endsWith(`/${b}`))
    || (a.includes('/') && b.includes('/') && b.endsWith(`/${a}`)),
  ));
}

function captureTargetSnapshots(targets: string[]): ContextTargetSnapshot[] {
  const snapshots: ContextTargetSnapshot[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const candidate = String(target || '').trim().replace(/^["']|["']$/g, '');
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const identity = normalizeTargetIdentity(candidate);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() && !stat.isDirectory()) continue;
      snapshots.push({
        target: candidate,
        size: Math.max(0, Number(stat.size || 0)),
        modifiedAtMs: Math.max(0, Number(stat.mtimeMs || 0)),
        kind: stat.isDirectory() ? 'directory' : 'file',
      });
      if (snapshots.length >= 16) break;
    } catch {
      // An unstatable target still has the in-chat mutation lineage guard, but
      // cannot safely claim protection from changes made by another process.
    }
  }
  return snapshots;
}

/**
 * Search/list commands often name only a workspace root in their arguments and
 * report the concrete files in stdout. Preserve those real file identities so
 * a nested edit invalidates only the affected observation and unchanged search
 * evidence can be reused on a terse follow-up.
 */
function enrichWorkspaceObservationTargets(
  targets: string[],
  args: Record<string, any>,
  result: any,
): string[] {
  const cwd = String(
    result?.cwd
    || (Array.isArray(result?.results)
      ? result.results.map((entry: any) => String(entry?.cwd || '').trim()).find(Boolean)
      : '')
    || args?.cwd
    || '',
  ).trim();
  if (!cwd || !path.isAbsolute(cwd)) return targets;
  const outputValues: unknown[] = [result?.output, result?.stdout];
  if (Array.isArray(result?.results)) {
    for (const child of result.results.slice(0, 32)) {
      outputValues.push(child?.output, child?.stdout);
    }
  }
  const discovered: string[] = [];
  const seen = new Set(targets.map(normalizeTargetIdentity).filter(Boolean));
  const admit = (rawCandidate: unknown) => {
    let candidate = String(rawCandidate || '').trim().replace(/^['"]|['"]$/g, '');
    if (!candidate || candidate.length > 700 || /[*?{}<>|]/.test(candidate)) return;
    candidate = candidate.replace(/:\d+(?::\d+)?:.*$/, '');
    const absolute = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
    const identity = normalizeTargetIdentity(absolute);
    if (!identity || seen.has(identity)) return;
    try {
      if (!fs.statSync(absolute).isFile()) return;
    } catch {
      return;
    }
    seen.add(identity);
    discovered.push(absolute);
  };
  for (const outputValue of outputValues) {
    if (typeof outputValue !== 'string' || !outputValue.trim()) continue;
    const lines = outputValue.split(/\r?\n/, 2_000);
    for (const rawLine of lines) {
      if (discovered.length >= 24) break;
      const line = rawLine.trim();
      if (!line || line.length > 1_200) continue;
      const located = line.match(/^(.+?):\d+(?::\d+)?:/);
      if (located) {
        admit(located[1]);
        continue;
      }
      // Bare paths are common for rg --files/Get-ChildItem output. Requiring a
      // source-like extension plus an existing file avoids treating code prose
      // or arbitrary command output as a workspace target.
      if (/^[^\t\0]+\.[A-Za-z0-9]{1,12}$/.test(line)) admit(line);
    }
    if (discovered.length >= 24) break;
  }
  // Put a bounded concrete-file sample first, then retain the command's root
  // targets before any remaining matches. This gives snapshot freshness both
  // exact-file precision and conservative ancestor invalidation.
  return uniqueStrings([
    ...discovered.slice(0, 12),
    ...targets,
    cwd,
    ...discovered.slice(12),
  ], 48);
}

type CurrentTargetSnapshot = Omit<ContextTargetSnapshot, 'target'> | null;

function targetSnapshotsStillMatch(
  snapshots: ContextTargetSnapshot[],
  currentStatCache?: Map<string, CurrentTargetSnapshot>,
): boolean {
  for (const snapshot of snapshots) {
    const identity = normalizeTargetIdentity(snapshot.target);
    let current: CurrentTargetSnapshot | undefined = identity && currentStatCache?.has(identity)
      ? currentStatCache.get(identity)
      : undefined;
    if (current === undefined) {
      let observed: CurrentTargetSnapshot;
      try {
        const stat = fs.statSync(snapshot.target);
        observed = stat.isFile() || stat.isDirectory()
          ? {
              size: Math.max(0, Number(stat.size || 0)),
              modifiedAtMs: Math.max(0, Number(stat.mtimeMs || 0)),
              kind: stat.isDirectory() ? 'directory' : 'file',
            }
          : null;
      } catch {
        observed = null;
      }
      current = observed;
      if (identity && currentStatCache) currentStatCache.set(identity, observed);
    }
    if (
      !current
      || current.kind !== snapshot.kind
      || current.size !== snapshot.size
      || current.modifiedAtMs !== snapshot.modifiedAtMs
    ) return false;
  }
  return true;
}

function summarizeResult(
  toolName: string,
  args: Record<string, any>,
  result: any,
  effect: ToolEffect,
  maxChars = MAX_RESULT_SUMMARY,
): string {
  if (!toolResultSucceeded(result)) {
    const error = result?.error || result?.CRITICAL_ERROR || result?.message || result?.stderr || result;
    return normalizeText(`${toolName} failed: ${typeof error === 'string' ? error : stableSerialize(error)}`, maxChars);
  }
  const exitCode = result?.exitCode ?? result?.exit_code ?? result?.code;
  const explicit = result?.summary || result?.message || result?.output || result?.stdout || result?.content;
  const target = extractToolTargets(args, result)[0] || args?.command || args?.query || args?.url || '';
  const prefix = effect === 'verification'
    ? 'Verified'
    : effect === 'mutation' || effect === 'artifact'
      ? 'Changed'
      : effect === 'external_action'
        ? 'Completed external action'
        : 'Observed';
  const detail = explicit
    ? normalizeText(typeof explicit === 'string' ? explicit : stableSerialize(explicit), maxChars - 120)
    : normalizeText(target, 500);
  return normalizeText(`${prefix} with ${toolName}${target ? ` (${normalizeText(target, 260)})` : ''}${typeof exitCode === 'number' ? `; exit=${exitCode}` : ''}${detail ? `: ${detail}` : ''}`, maxChars);
}

function batchCommandOutput(combined: unknown, commandIndex: number): string {
  const text = String(combined || '').replace(/\r\n/g, '\n');
  if (!text) return '';
  const marker = new RegExp(`^\\[command ${commandIndex + 1}\\][^\\n]*\\n?`, 'm');
  const match = marker.exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  const remainder = text.slice(start);
  const nextMarker = /^\[command \d+\][^\n]*$/m.exec(remainder);
  return (nextMarker ? remainder.slice(0, nextMarker.index) : remainder).trim();
}

function factFingerprint(fact: Pick<ContextFact, 'kind' | 'text' | 'exactValues'>): string {
  return sha256(`${fact.kind}\u0000${fact.text}\u0000${fact.exactValues.join('\u0000')}`).slice(0, 16);
}

function isCriticalFact(fact: ContextFact): boolean {
  if (fact.status !== 'active') return false;
  return [
    'objective',
    'constraint',
    'decision',
    'failure',
    'next_action',
    'preference',
  ].includes(fact.kind);
}

function sourceLabel(fact: ContextFact): string {
  const latest = fact.provenance[fact.provenance.length - 1];
  if (!latest) return 'unknown';
  return latest.toolName ? `${latest.source}:${latest.toolName}` : `${latest.source}:${latest.sourceId}`;
}

function cloneValueFactors(factors: MemoryValueFactors): MemoryValueFactors {
  return { ...factors };
}

function normalizeStoredFact(fact: ContextFact): ContextFact {
  const observedAt = Number(fact.lastObservedAt || fact.firstObservedAt || Date.now());
  const epistemic = fact.epistemic || 'inferred';
  const importance = Math.max(0, Math.min(10, Number(fact.importance || 0)));
  return {
    ...fact,
    network: fact.network || networkForKind(fact.kind, epistemic),
    epistemic,
    importance,
    validFrom: Number(fact.validFrom || fact.firstObservedAt || observedAt),
    recordedAt: Number(fact.recordedAt || fact.firstObservedAt || observedAt),
    entities: uniqueStrings(fact.entities || extractEntities(fact.text, fact.targets || []), 32),
    retrievalCount: Math.max(0, Number(fact.retrievalCount || 0)),
    valueFactors: fact.valueFactors
      ? cloneValueFactors(fact.valueFactors)
      : initialValueFactors({
        kind: fact.kind,
        epistemic,
        importance,
        text: fact.text,
        source: fact.provenance?.[fact.provenance.length - 1]?.source || 'runtime',
        observations: fact.observations,
      }),
    exactValues: [...(fact.exactValues || [])],
    targets: [...(fact.targets || [])],
    provenance: (fact.provenance || []).map(item => ({
      ...item,
      ...(Array.isArray(item.targetSnapshots)
        ? { targetSnapshots: item.targetSnapshots.map(snapshot => ({ ...snapshot })) }
        : {}),
    })),
  };
}

function cloneEpisode(episode: ContextEpisode): ContextEpisode {
  return { ...episode, targets: [...(episode.targets || [])] };
}

function clonePolicy(policy: MemoryPolicyState): MemoryPolicyState {
  const kindUtilityBoosts = policy.kindUtilityBoosts
    ? Object.fromEntries(
        Object.entries(policy.kindUtilityBoosts)
          .filter(([, value]) => Number.isFinite(Number(value)))
          .map(([kind, value]) => [kind, clamp01(Number(value))]),
      ) as Partial<Record<ContextFactKind, number>>
    : undefined;
  return {
    ...policy,
    weights: cloneValueFactors(policy.weights),
    learnedGuidelines: [...policy.learnedGuidelines],
    ...(kindUtilityBoosts ? { kindUtilityBoosts } : {}),
  };
}

function renderManifestFact(fact: ContextManifestFact): string {
  const exactValues = renderBoundedValues(fact.exactValues, 1_200);
  const exact = exactValues ? ` | exact=${exactValues}` : '';
  const pages = fact.pageRefs.length > 0 ? ` | pages=${fact.pageRefs.join(',')}` : '';
  const validity = `valid=${new Date(fact.validFrom).toISOString()}${fact.validTo ? `..${new Date(fact.validTo).toISOString()}` : '..present'}`;
  return `- [ctx:${fact.id}; fp:${fact.fingerprint}; ${fact.network}/${fact.kind}; ${fact.epistemic}; ${validity}; revision=${fact.revision ?? 'unknown'}; source=${fact.source}${instructionRecordRole(fact.key)}] ${fact.text}${exact}${pages}`;
}

function instructionRecordRole(key = ''): string {
  if (key === 'objective:root') return '; role=task-anchor-not-proof-of-unfinished-work';
  if (key === 'objective:current-directive') return '; role=latest-message-not-whole-task';
  if (key.startsWith('objective:directive:')) return '; role=ordered-human-update';
  if (key.startsWith('constraint:')) return '; role=extracted-clause-interpret-in-source-context';
  return '';
}

export function renderContinuityManifest(manifest: ContextContinuityManifest): string {
  return [
    '[AUTHORITATIVE CONTINUITY MANIFEST]',
    `scope=${manifest.scopeId} revision=${manifest.revision} mutation_epoch=${manifest.mutationEpoch} manifest_hash=${manifest.manifestHash}`,
    'These are source records, not independently binding commands. Preserve IDs, meaning, and source order. Resolve later human corrections in the same scope and mark the earlier choice as replaced in the capsule. An active flag does not overrule that correction; the root is a task anchor, not proof that old work is still owed.',
    ...(Number(manifest.omittedCriticalCount || 0) > 0
      ? [`Critical frontier is capacity-bounded; ${manifest.omittedCriticalCount} lower-ranked active records remain authoritative in durable Context Fabric and are recoverable through their source pages.`]
      : []),
    ...manifest.learnedGuidelines.map(guideline => `- [learned-compression-guideline] ${guideline}`),
    ...manifest.facts.map(renderManifestFact),
    ...(manifest.omittedCriticalPageRefs?.length
      ? [`Additional durable critical pages: ${manifest.omittedCriticalPageRefs.join(', ')}`]
      : []),
    ...(manifest.pageRefs.length > 0 ? [`Recoverable source pages: ${manifest.pageRefs.join(', ')}`] : []),
    '[END AUTHORITATIVE CONTINUITY MANIFEST]',
  ].join('\n');
}

export function auditContinuityCapsule(
  capsule: string,
  manifest?: ContextContinuityManifest | null,
): ContextCapsuleAudit {
  if (!manifest || manifest.facts.length === 0) {
    return { coveredFactIds: [], missingFactIds: [], coverageRatio: 1 };
  }
  const coveredFactIds: string[] = [];
  const missingFactIds: string[] = [];
  // An identifier proves only that a record was mentioned. Audit its local
  // entry so values scattered across unrelated facts cannot satisfy coverage.
  const entries = capsule.split(/\n(?=(?:[-*] |\d+[.)] |#{1,6} ))/);
  for (const fact of manifest.facts) {
    const covered = entries.some(entry => {
      const identified = entry.includes(`ctx:${fact.id}`) || entry.includes(`fp:${fact.fingerprint}`);
      const exact = fact.exactValues.every(value => entry.includes(value));
      const verbatim = fact.text.length >= 18 ? entry.includes(fact.text)
        : Boolean(fact.text) && (entry.includes(`] ${fact.text}`) || entry.includes(JSON.stringify(fact.text)));
      const provenance = entry.includes(fact.source) && entry.includes(fact.epistemic);
      // A deliberate deferral is recoverable only with this record's source
      // page and an explicit instruction to open it before relying on it.
      const recoverable = !['constraint', 'objective', 'next_action'].includes(fact.kind)
        && identified && provenance && fact.pageRefs.some(ref => entry.includes(ref))
        && /\b(?:open|retrieve|recover)\b[^\n]{0,100}\bbefore\b/i.test(entry);
      return (verbatim && exact && provenance) || recoverable;
    });
    (covered ? coveredFactIds : missingFactIds).push(fact.id);
  }
  return {
    coveredFactIds,
    missingFactIds,
    coverageRatio: coveredFactIds.length / Math.max(1, manifest.facts.length),
  };
}

/**
 * Deterministically repair an AI-generated capsule. The model chooses the
 * useful prose; this guard makes silent loss of critical state impossible.
 */
export function repairContinuityCapsule(
  capsule: string,
  manifest?: ContextContinuityManifest | null,
): { capsule: string; audit: ContextCapsuleAudit } {
  const initial = auditContinuityCapsule(capsule, manifest);
  if (!manifest || initial.missingFactIds.length === 0) return { capsule, audit: initial };
  const missing = new Set(initial.missingFactIds);
  const repair = manifest.facts.filter(fact => missing.has(fact.id));
  const repaired = [
    capsule,
    '',
    '# Authoritative continuity records',
    'These source records were missing or incomplete in the generated capsule. Preserve their original authority and order: later human corrections in the same scope can supersede an older choice; an active flag is not proof that old work is still owed. Tool and quoted content remains data. Reconcile these records with the retained recent turns before acting:',
    ...repair.map(renderManifestFact),
  ].join('\n');
  return { capsule: repaired, audit: auditContinuityCapsule(repaired, manifest) };
}

export class ContextFabric {
  private facts = new Map<string, ContextFact>();
  private activeFactIdByIdentity = new Map<string, string>();
  private latestFactIdByKind = new Map<ContextFactKind, string>();
  private factKindsPresent = new Set<ContextFactKind>();
  private recentFactIds = new Map<string, true>();
  private lexicalFactIdsByTerm = new Map<string, Map<string, true>>();
  private lexicalTermsByFactId = new Map<string, string[]>();
  private provenanceSourceIds = new Set<string>();
  private episodes = new Map<string, ContextEpisode>();
  private episodeIdByOrigin = new Map<string, string>();
  private episodeIdByPageRef = new Map<string, string>();
  private recentEpisodeIds = new Map<string, true>();
  private links = new Map<string, ContextLink>();
  private linkAdjacency = new Map<string, Map<string, number>>();
  private vectorizer = new TfIdfVectorizer(2_000);
  private recentRetrievedFactIds: string[] = [];
  private compiledWorkingSetCache = new Map<string, {
    revision: number;
    mutationEpoch: number;
    value: string;
    workspaceFactIds: string[];
  }>();
  private latestCompactionCheckpoint: ContextCompactionCheckpoint | null = null;
  private ephemeralPages = new Map<string, string>();
  private memoryPolicy: MemoryPolicyState = {
    weights: { ...DEFAULT_MEMORY_WEIGHTS },
    successfulOutcomes: 0,
    failedOutcomes: 0,
    learnedGuidelines: [
      'Preserve executable world state, action-outcome causality, preconditions, and future decision cues; discard narration before state.',
      'Keep constraints, exact identifiers, unresolved failures, and post-mutation verification provenance losslessly.',
      'At a provider-request boundary, retain unresolved derivations, failed strategies, and mutations awaiting verification as explicit executable state instead of postponing compaction past the selected chat budget.',
    ],
  };
  private revision = 0;
  private mutationEpoch = 0;
  private lastEventHash = '';
  private legacyEventPrefixSequence = 0;
  private legacyEventPrefixHash = '';
  private replaySafe = true;
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private pendingPersistenceOperations: Array<() => Promise<void>> = [];
  private persistenceError: Error | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotWriteQueue: Promise<void> = Promise.resolve();
  private lastSnapshotRevision = -1;
  /** Exact durable prefix already represented by the materialized maps. */
  private materializedLedgerSize = 0;
  private materializedLedgerRevision = 0;
  private materializedLedgerHash = '';
  private materializedLedgerModifiedAtMs = 0;
  private materializedLedgerChangedAtMs = 0;
  private localEmissionEpoch = 0;
  private durableRefreshPromise: Promise<void> | null = null;
  private readonly durable: boolean;
  private readonly storageRoot: string;
  private readonly scopeDir: string;
  private readonly eventsPath: string;
  private readonly snapshotPath: string;

  constructor(
    readonly scopeId: string,
    options: ContextFabricOptions = {},
  ) {
    this.durable = options.durable !== false;
    this.storageRoot = options.storageRoot || DEFAULT_CONTEXT_ROOT;
    this.scopeDir = path.join(this.storageRoot, stableScopeSegment(scopeId));
    this.eventsPath = path.join(this.scopeDir, 'events.jsonl');
    this.snapshotPath = path.join(this.scopeDir, 'snapshot.json');
    if (options.snapshot) this.restore(options.snapshot);
  }

  private resetMaterializedState(): void {
    this.facts = new Map();
    this.activeFactIdByIdentity = new Map();
    this.latestFactIdByKind = new Map();
    this.factKindsPresent = new Set();
    this.recentFactIds = new Map();
    this.lexicalFactIdsByTerm = new Map();
    this.lexicalTermsByFactId = new Map();
    this.provenanceSourceIds = new Set();
    this.episodes = new Map();
    this.episodeIdByOrigin = new Map();
    this.episodeIdByPageRef = new Map();
    this.recentEpisodeIds = new Map();
    this.links = new Map();
    this.linkAdjacency = new Map();
    this.vectorizer = new TfIdfVectorizer(2_000);
    this.recentRetrievedFactIds = [];
    this.compiledWorkingSetCache = new Map();
    this.latestCompactionCheckpoint = null;
    this.ephemeralPages = new Map();
    this.memoryPolicy = {
      weights: { ...DEFAULT_MEMORY_WEIGHTS },
      successfulOutcomes: 0,
      failedOutcomes: 0,
      learnedGuidelines: [
        'Preserve executable world state, action-outcome causality, preconditions, and future decision cues; discard narration before state.',
        'Keep constraints, exact identifiers, unresolved failures, and post-mutation verification provenance losslessly.',
        'At a provider-request boundary, retain unresolved derivations, failed strategies, and mutations awaiting verification as explicit executable state instead of postponing compaction past the selected chat budget.',
      ],
    };
    this.revision = 0;
    this.mutationEpoch = 0;
    this.lastEventHash = '';
    this.legacyEventPrefixSequence = 0;
    this.legacyEventPrefixHash = '';
    this.replaySafe = true;
    this.lastSnapshotRevision = -1;
    this.materializedLedgerSize = 0;
    this.materializedLedgerRevision = 0;
    this.materializedLedgerHash = '';
    this.materializedLedgerModifiedAtMs = 0;
    this.materializedLedgerChangedAtMs = 0;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializationPromise) return this.initializationPromise;
    const initialization = this.initializeFromStorage();
    this.initializationPromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.initializationPromise === initialization) this.initializationPromise = null;
    }
  }

  private async initializeFromStorage(): Promise<void> {
    if (!this.durable) {
      this.initialized = true;
      return;
    }
    await fs.ensureDir(this.scopeDir);
    // Initialization can repair or migrate the ledger, so it participates in
    // the same cross-process writer lease as normal appends. Without this, a
    // live process could append between our read and atomic replacement and
    // that already-committed event would be lost.
    const initializationLease = await this.acquireEventLedgerLease();
    try {
    const eventText = await readOptionalDurableText(this.eventsPath);
    let snapshot: ContextFabricSnapshot | null = null;
    try {
      snapshot = await readOptionalDurableJson<ContextFabricSnapshot>(this.snapshotPath);
    } catch (error) {
      // The verified append-only ledger is sufficient to reconstruct every
      // materialized record. Ignore a bad auxiliary snapshot only when that
      // ledger is present; an eventless scope must not silently lose its sole
      // durable state.
      if (!eventText.trim()) throw error;
    }
    if (
      !eventText.trim()
      && snapshot?.eventHashVersion === 2
      && Number(snapshot.revision || 0) > 0
    ) {
      // A v2 snapshot is an acceleration checkpoint anchored to the event
      // ledger, not an independent replacement for it. Returning an empty
      // fabric here would turn a missing/truncated ledger into silent context
      // loss. Leave both the snapshot and page archive untouched and fail the
      // acquisition so recovery can be explicit.
      throw new Error('Context Fabric event ledger is missing while a non-empty sealed snapshot still exists.');
    }
    const eventLines = eventText.split(/\r?\n/).filter(Boolean);
    const verifiedEvents: ContextFabricEvent[] = [];
    const declaredLegacyPrefix = snapshot?.legacyEventPrefix;
    const legacyV1Ceiling = snapshot?.eventHashVersion === 2
      ? Math.max(0, Math.floor(Number(declaredLegacyPrefix?.sequence || 0)))
      : Number.POSITIVE_INFINITY;
    let expectedHash = '';
    let previousSequence = 0;
    let sawV2Event = false;
    let observedLegacyPrefixSequence = 0;
    let observedLegacyPrefixHash = '';
    for (const line of eventLines) {
      try {
        const event = JSON.parse(line) as ContextFabricEvent;
        if (
          (event.version !== 1 && event.version !== 2)
          || event.scopeId !== this.scopeId
          || !isContextFabricEventPayloadValid(event)
        ) break;
        const body = { ...event, hash: undefined } as any;
        delete body.hash;
        const hashMatches = sha256(stableSerialize(body)) === event.hash;
        const acceptsLegacyV1 = event.version === 1
          && !sawV2Event
          && event.sequence <= legacyV1Ceiling
          && (
            !declaredLegacyPrefix
            || event.sequence !== declaredLegacyPrefix.sequence
            || event.hash === declaredLegacyPrefix.hash
          );
        if (
          event.previousHash !== expectedHash
          || !Number.isFinite(event.sequence)
          || event.sequence !== previousSequence + 1
          || (event.version === 1 && (sawV2Event || event.sequence > legacyV1Ceiling))
          // Version 1 hashed pre-JSON objects and could include properties whose
          // undefined values vanished on disk. Retain that structurally chained
          // prefix only for snapshots created before the durable v2 hash format.
          || (!hashMatches && !acceptsLegacyV1)
        ) break;
        expectedHash = event.hash;
        previousSequence = event.sequence;
        if (event.version === 1) {
          observedLegacyPrefixSequence = event.sequence;
          observedLegacyPrefixHash = event.hash;
        } else {
          sawV2Event = true;
        }
        verifiedEvents.push(event);
      } catch {
        break;
      }
    }

    if (verifiedEvents.length < eventLines.length) {
      // Do not append new valid events behind a rejected tail: subsequent
      // restarts would stop at the same damaged record and never reach them.
      // Preserve the rejected bytes for diagnosis, then atomically make the
      // verified prefix the active ledger before this fabric accepts writes.
      const rejectedTail = eventLines.slice(verifiedEvents.length).join('\n');
      const recoveryTag = `${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
      const quarantinePath = path.join(this.scopeDir, `events.rejected.${recoveryTag}.jsonl`);
      const repairedPath = path.join(this.scopeDir, `.events.repaired.${recoveryTag}.tmp`);
      try {
        await fs.writeFile(quarantinePath, `${rejectedTail}\n`, { encoding: 'utf8', flag: 'wx' });
        const verifiedLedger = verifiedEvents.length > 0
          ? `${verifiedEvents.map(event => JSON.stringify(event)).join('\n')}\n`
          : '';
        await fs.writeFile(repairedPath, verifiedLedger, { encoding: 'utf8', flag: 'wx' });
        await fs.move(repairedPath, this.eventsPath, { overwrite: true });
      } catch (error) {
        await fs.remove(repairedPath).catch(() => undefined);
        this.persistenceError = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Context Fabric could not repair its damaged event ledger: ${this.persistenceError.message}`);
      }
    }

    // A sealed snapshot may accelerate materialization only when its revision
    // and chain hash are anchored to the fully verified ledger. This avoids
    // replaying every historical mutation while still rejecting ahead-of-disk,
    // corrupted, or stale snapshots. Eventless legacy snapshots remain readable
    // for migration; v2 snapshots may be eventless only at revision zero.
    this.resetMaterializedState();
    const snapshotShapeValid = snapshot?.version === 1 && snapshot.scopeId === this.scopeId;
    const snapshotRevision = snapshotShapeValid && Number.isInteger(Number(snapshot!.revision))
      ? Math.max(0, Number(snapshot!.revision))
      : -1;
    const snapshotHashValid = Boolean(
      snapshotShapeValid
      && /^[0-9a-f]{64}$/i.test(String(snapshot!.snapshotHash || ''))
      && calculateSnapshotHash(snapshot!) === snapshot!.snapshotHash,
    );
    const snapshotAnchor = snapshotRevision > 0
      ? verifiedEvents[snapshotRevision - 1]
      : null;
    const snapshotAnchoredToLedger = Boolean(
      snapshotHashValid
      && snapshot!.replaySafe === true
      && snapshot!.eventHashVersion === 2
      && snapshotRevision <= verifiedEvents.length
      && (
        snapshotRevision === 0
          ? snapshot!.lastEventHash === ''
          : snapshotAnchor?.sequence === snapshotRevision
            && snapshotAnchor.hash === snapshot!.lastEventHash
      ),
    );
    const eventlessSnapshotTrusted = Boolean(
      snapshotShapeValid
      && eventLines.length === 0
      && (
        snapshot!.eventHashVersion !== 2
        || (
          snapshotRevision === 0
          && snapshot!.lastEventHash === ''
          && (!Array.isArray(snapshot!.facts) || snapshot!.facts.length === 0)
          && (!Array.isArray(snapshot!.episodes) || snapshot!.episodes.length === 0)
          && (!Array.isArray(snapshot!.links) || snapshot!.links.length === 0)
          && !snapshot!.latestCompactionCheckpoint
        )
      ),
    );
    const snapshotTrusted = snapshotAnchoredToLedger || eventlessSnapshotTrusted;
    if (snapshotTrusted) this.restore(snapshot!);
    if (
      eventlessSnapshotTrusted
      && snapshot!.eventHashVersion !== 2
      && (
        this.revision > 0
        || this.facts.size > 0
        || this.episodes.size > 0
        || this.links.size > 0
        || Boolean(this.latestCompactionCheckpoint)
      )
    ) {
      await this.migrateLegacySnapshotToEventLedger();
    }

    for (const event of verifiedEvents) {
      if (event.sequence <= this.revision) continue;
      this.applyEvent(event);
    }
    // Retrieval indexes describe current world state, not the number of times
    // a fact was updated in the event log. Rebuild once after replay so old
    // revisions do not skew relevance and restart behavior stays deterministic.
    this.rebuildVectorizer();
    // The append-only ledger is the integrity root. Never advance its hash to
    // an unverified tail, and never let a disk snapshot claim a revision that
    // the verified chain cannot reach.
    const lastVerified = verifiedEvents[verifiedEvents.length - 1];
    if (lastVerified && this.revision <= lastVerified.sequence) {
      this.lastEventHash = lastVerified.hash;
    }
    // Carry the exact v1/v2 transition through future v2 snapshots. Without
    // this marker, an upgraded mixed ledger would look like an invalid v2-only
    // ledger on its next restart; new chats have no legacy allowance at all.
    if (observedLegacyPrefixSequence > 0) {
      this.legacyEventPrefixSequence = observedLegacyPrefixSequence;
      this.legacyEventPrefixHash = observedLegacyPrefixHash;
    }
    // Initialization holds the writer lease and has now applied the complete
    // verified chain, regardless of whether it started from a safe checkpoint.
    this.replaySafe = true;
    const materializedStat = await fs.stat(this.eventsPath).catch((error: any) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    this.materializedLedgerSize = materializedStat?.size || 0;
    this.materializedLedgerRevision = this.revision;
    this.materializedLedgerHash = this.lastEventHash;
    this.materializedLedgerModifiedAtMs = materializedStat?.mtimeMs || 0;
    this.materializedLedgerChangedAtMs = materializedStat?.ctimeMs || 0;
    this.initialized = true;
    } finally {
      await this.releaseEventLedgerLease(initializationLease);
    }
  }

  /**
   * Eventless v1 snapshots predate the ledger as integrity root. Materialize
   * their complete final state into a deterministic v2 chain before any live
   * event is accepted; otherwise the first append would begin at a revision
   * that does not exist on disk and become unreplayable after restart.
   */
  private async migrateLegacySnapshotToEventLedger(): Promise<void> {
    const events: ContextFabricEvent[] = [];
    let previousHash = '';
    const append = (
      operation: ContextEventOperation,
      payload: Pick<ContextFabricEvent, 'fact' | 'episode' | 'link' | 'memoryPolicy' | 'checkpoint'>,
      timestamp: number,
    ) => {
      const sequence = events.length + 1;
      const migratedPayload = {
        ...payload,
        ...(payload.fact ? { fact: { ...payload.fact, revision: sequence } } : {}),
        ...(payload.episode ? { episode: { ...payload.episode, sequence } } : {}),
      };
      const unpersisted = JSON.parse(JSON.stringify({
        version: 2,
        scopeId: this.scopeId,
        sequence,
        timestamp: Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : Date.now(),
        operation,
        ...migratedPayload,
        previousHash,
      })) as Omit<ContextFabricEvent, 'hash'>;
      const event: ContextFabricEvent = { ...unpersisted, hash: sha256(stableSerialize(unpersisted)) };
      events.push(event);
      previousHash = event.hash;
    };

    [...this.facts.values()]
      .sort((left, right) => left.recordedAt - right.recordedAt || left.id.localeCompare(right.id))
      .forEach(fact => append('upsert', { fact: normalizeStoredFact(fact) }, fact.recordedAt));
    [...this.episodes.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .forEach(episode => append('episode', { episode: cloneEpisode(episode) }, episode.createdAt));
    [...this.links.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .forEach(link => append('link', { link: { ...link } }, link.createdAt));
    append('policy', { memoryPolicy: this.getMemoryPolicy() }, Date.now());
    if (this.latestCompactionCheckpoint) {
      const checkpoint = this.latestCompactionCheckpoint;
      append('checkpoint', {
        checkpoint: {
          compactionId: checkpoint.compactionId,
          manifestHash: checkpoint.manifestHash,
          capsuleHash: checkpoint.capsuleHash,
        },
      }, checkpoint.recordedAt);
    }

    await this.replaceEventLedgerAtomically(`${events.map(event => JSON.stringify(event)).join('\n')}\n`);
    this.revision = events.length;
    this.lastEventHash = previousHash;
    this.legacyEventPrefixSequence = 0;
    this.legacyEventPrefixHash = '';
    for (const event of events) {
      if (event.fact) {
        const fact = normalizeStoredFact(event.fact);
        this.materializeFact(fact);
      }
      if (event.episode) {
        this.episodes.set(event.episode.id, cloneEpisode(event.episode));
        if (event.episode.originId) this.episodeIdByOrigin.set(event.episode.originId, event.episode.id);
        this.episodeIdByPageRef.set(event.episode.pageRef, event.episode.id);
        this.touchRecentEpisode(event.episode.id);
      }
      if (event.operation === 'checkpoint' && event.checkpoint) {
        this.latestCompactionCheckpoint = {
          ...event.checkpoint,
          recordedAt: event.timestamp,
          sequence: event.sequence,
        };
      }
    }
    this.rebuildLinkAdjacency();
    this.rebuildVectorizer();
  }

  private applyEvent(event: ContextFabricEvent): void {
    if (event.operation === 'upsert' && event.fact) {
      const isNewFact = !this.facts.has(event.fact.id);
      const fact = normalizeStoredFact(event.fact);
      this.materializeFact(fact);
      if (isNewFact) this.vectorizer.addDocument(this.searchableFactText(fact));
    }
    if (event.operation === 'episode' && event.episode) {
      const isNewEpisode = !this.episodes.has(event.episode.id);
      this.episodes.set(event.episode.id, cloneEpisode(event.episode));
      if (event.episode.originId) this.episodeIdByOrigin.set(event.episode.originId, event.episode.id);
      this.episodeIdByPageRef.set(event.episode.pageRef, event.episode.id);
      this.touchRecentEpisode(event.episode.id);
      if (isNewEpisode) this.vectorizer.addDocument(this.searchableEpisodeText(event.episode));
    }
    if (event.operation === 'link' && event.link) {
      this.links.set(event.link.id, event.link);
      this.indexLink(event.link);
    }
    if (event.operation === 'policy' && event.memoryPolicy) {
      this.memoryPolicy = clonePolicy({
        ...this.memoryPolicy,
        ...event.memoryPolicy,
        weights: { ...DEFAULT_MEMORY_WEIGHTS, ...(event.memoryPolicy.weights || {}) },
        learnedGuidelines: Array.isArray(event.memoryPolicy.learnedGuidelines)
          ? event.memoryPolicy.learnedGuidelines
          : this.memoryPolicy.learnedGuidelines,
      });
    }
    if (event.operation === 'checkpoint' && event.checkpoint) {
      this.latestCompactionCheckpoint = {
        ...event.checkpoint,
        recordedAt: event.timestamp,
        sequence: event.sequence,
      };
    }
    this.revision = Math.max(this.revision, event.sequence);
    this.lastEventHash = event.hash;
    const provenance = event.fact?.provenance;
    const epoch = Array.isArray(provenance)
      ? provenance[provenance.length - 1]?.mutationEpoch
      : undefined;
    if (typeof epoch === 'number') this.mutationEpoch = Math.max(this.mutationEpoch, epoch);
  }

  private emit(
    operation: ContextEventOperation,
    payload: Pick<ContextFabricEvent, 'fact' | 'episode' | 'link' | 'memoryPolicy' | 'checkpoint'>,
  ): void {
    this.localEmissionEpoch += 1;
    const unpersistedBody: Omit<ContextFabricEvent, 'hash'> = {
      version: 2,
      scopeId: this.scopeId,
      sequence: ++this.revision,
      timestamp: Date.now(),
      operation,
      ...payload,
      previousHash: this.lastEventHash,
    };
    // Hash exactly what JSON persistence retains. In v1, optional undefined
    // properties participated in the in-memory hash and then disappeared from
    // JSON, making authentic events impossible to verify after a restart.
    const body = JSON.parse(JSON.stringify(unpersistedBody)) as Omit<ContextFabricEvent, 'hash'>;
    let event: ContextFabricEvent = { ...body, hash: sha256(stableSerialize(body)) };
    this.lastEventHash = event.hash;
    if (event.fact) {
      const fact = normalizeStoredFact(event.fact);
      this.materializeFact(fact);
    }
    if (event.episode) {
      this.episodes.set(event.episode.id, cloneEpisode(event.episode));
      if (event.episode.originId) this.episodeIdByOrigin.set(event.episode.originId, event.episode.id);
      this.episodeIdByPageRef.set(event.episode.pageRef, event.episode.id);
      this.touchRecentEpisode(event.episode.id);
    }
    if (event.link) {
      this.links.set(event.link.id, event.link);
      this.indexLink(event.link);
    }
    if (event.memoryPolicy) this.memoryPolicy = clonePolicy(event.memoryPolicy);
    if (event.checkpoint) {
      this.latestCompactionCheckpoint = {
        ...event.checkpoint,
        recordedAt: event.timestamp,
        sequence: event.sequence,
      };
    }
    if (!this.durable) return;
    let line = `${JSON.stringify(event)}\n`;
    let firstAppendAttempt = true;
    this.enqueuePersistence(async () => {
      await fs.ensureDir(this.scopeDir);
      const lease = await this.acquireEventLedgerLease();
      try {
        if (firstAppendAttempt) {
          const prepared = await this.prepareEventForDurableAppend(event);
          event = prepared.event;
          line = `${JSON.stringify(event)}\n`;
          if (prepared.alreadyPresent) {
            await this.markOwnEventDurablyMaterialized(event);
            return;
          }
          // Flip only after preparation succeeds. A lease timeout or a damaged
          // pre-existing ledger has not made the append outcome ambiguous and
          // must be allowed to run preparation again on the queued retry.
          firstAppendAttempt = false;
          await fs.appendFile(this.eventsPath, line, 'utf8');
          await this.markOwnEventDurablyMaterialized(event);
          return;
        }
        // The prior append may have committed, partially committed, or failed
        // before touching disk. Reconciliation handles all three while the
        // same cross-process lease prevents a competing writer from moving the
        // tail during repair.
        await this.reconcileAmbiguousEventAppend(event, line);
        await this.markOwnEventDurablyMaterialized(event);
      } finally {
        await this.releaseEventLedgerLease(lease);
      }
    });
    this.scheduleSnapshot();
  }

  /**
   * Advance the byte frontier only when this exact event is the durable tail
   * and directly follows the materialized chain. If another process inserted
   * anything first, incremental replay must absorb that complete suffix before
   * a snapshot may be considered safe.
   */
  private async markOwnEventDurablyMaterialized(event: ContextFabricEvent): Promise<void> {
    const adjacent = event.sequence === this.materializedLedgerRevision + 1
      && event.previousHash === this.materializedLedgerHash;
    if (!adjacent) {
      this.replaySafe = false;
      return;
    }
    const tail = await readDurableLedgerTail(this.eventsPath);
    let durableTail: ContextFabricEvent | null = null;
    try {
      durableTail = tail.tailText ? JSON.parse(tail.tailText) as ContextFabricEvent : null;
    } catch {
      this.replaySafe = false;
      return;
    }
    if (
      !durableTail
      || durableTail.sequence !== event.sequence
      || durableTail.hash !== event.hash
      || stableSerialize(durableTail) !== stableSerialize(event)
    ) {
      this.replaySafe = false;
      return;
    }
    const stat = await fs.stat(this.eventsPath);
    this.materializedLedgerSize = stat.size;
    this.materializedLedgerRevision = event.sequence;
    this.materializedLedgerHash = event.hash;
    this.materializedLedgerModifiedAtMs = stat.mtimeMs;
    this.materializedLedgerChangedAtMs = stat.ctimeMs;
  }

  /**
   * Bring a retained fabric up to the newest cross-process durable state.
   * This is called when a chat fabric is acquired, never inside the provider
   * iteration loop. The unchanged path is one stat; the changed path verifies
   * and applies only bytes appended after our known-good frontier.
   */
  async refreshDurableState(): Promise<void> {
    if (!this.durable || !this.initialized) return;
    if (this.durableRefreshPromise) return this.durableRefreshPromise;
    // A new chat turn may acquire the retained fabric just as the prior turn's
    // terminal events are finishing. Settle that bounded queue first, then use
    // its final local epoch as the stable base for cross-process catch-up.
    const refresh = (async () => {
      await this.flushPersistenceOperations();
      await this.refreshDurableStateOnce(this.localEmissionEpoch);
    })();
    this.durableRefreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.durableRefreshPromise === refresh) this.durableRefreshPromise = null;
    }
  }

  private async refreshDurableStateOnce(emissionEpoch: number): Promise<void> {
    const observedStat = await fs.stat(this.eventsPath).catch((error: any) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (
      observedStat
      && this.replaySafe
      && observedStat.size === this.materializedLedgerSize
      && observedStat.mtimeMs === this.materializedLedgerModifiedAtMs
      && observedStat.ctimeMs === this.materializedLedgerChangedAtMs
    ) return;
    if (
      !observedStat
      && this.replaySafe
      && this.materializedLedgerSize === 0
      && this.materializedLedgerRevision === 0
      && this.materializedLedgerHash === ''
    ) return;

    let requiresCompleteRehydrate = false;
    const lease = await this.acquireEventLedgerLease();
    try {
      // A same-process run began mutating this fabric while the asynchronous
      // freshness check was in flight. Its queued append will rebase safely;
      // defer replay until the next clean acquisition rather than interleave
      // external history with an in-progress synchronous materialization.
      if (
        this.pendingPersistenceOperations.length > 0
        || this.localEmissionEpoch !== emissionEpoch
      ) {
        this.replaySafe = false;
        return;
      }
      try {
        const slice = await readDurableLedgerSlice(this.eventsPath, this.materializedLedgerSize);
        if (slice.size === this.materializedLedgerSize) {
          // The pre-lease stat fast path already handled a byte-identical,
          // unchanged file. Reaching this branch means the same-size ledger
          // was replaced/touched or this fabric was previously known unsafe.
          // Its middle cannot be authenticated from the tail alone, so use the
          // complete verified hydration path before sealing another snapshot.
          throw new Error('Context Fabric event ledger identity changed without an append-only size increase.');
        }

        let expectedSequence = this.materializedLedgerRevision;
        let expectedHash = this.materializedLedgerHash;
        const appendedEvents: ContextFabricEvent[] = [];
        const lines = slice.text.split(/\r?\n/).filter(line => Boolean(line.trim()));
        for (const line of lines) {
          let event: ContextFabricEvent;
          try {
            event = JSON.parse(line) as ContextFabricEvent;
          } catch {
            throw new Error('Context Fabric appended event is not valid JSON.');
          }
          const body = { ...event, hash: undefined } as any;
          delete body.hash;
          if (
            event.version !== 2
            || event.scopeId !== this.scopeId
            || !isContextFabricEventPayloadValid(event)
            || event.sequence !== expectedSequence + 1
            || event.previousHash !== expectedHash
            || sha256(stableSerialize(body)) !== event.hash
          ) {
            throw new Error('Context Fabric appended event failed its integrity or continuity check.');
          }
          appendedEvents.push(event);
          expectedSequence = event.sequence;
          expectedHash = event.hash;
        }
        if (appendedEvents.length === 0) {
          // A writer can normalize a valid newline-free ledger before its next
          // event. Advancing that byte alone is safe because chain identity did
          // not move.
          const tail = await readDurableLedgerTail(this.eventsPath);
          const durableTail = tail.tailText ? JSON.parse(tail.tailText) as ContextFabricEvent : null;
          if (
            this.materializedLedgerRevision !== 0
            && (
              durableTail?.sequence !== this.materializedLedgerRevision
              || durableTail?.hash !== this.materializedLedgerHash
            )
          ) {
            throw new Error('Context Fabric normalized ledger has a different chain tail.');
          }
        }
        if (
          this.pendingPersistenceOperations.length > 0
          || this.localEmissionEpoch !== emissionEpoch
        ) {
          this.replaySafe = false;
          return;
        }
        for (const event of appendedEvents) this.applyEvent(event);
        // With no local pending mutations, the verified durable tail is the
        // complete materialized revision, including any local events that had
        // previously been rebased around a competing process.
        this.revision = expectedSequence;
        this.lastEventHash = expectedHash;
        this.materializedLedgerSize = slice.size;
        this.materializedLedgerRevision = expectedSequence;
        this.materializedLedgerHash = expectedHash;
        this.materializedLedgerModifiedAtMs = slice.modifiedAtMs;
        this.materializedLedgerChangedAtMs = slice.changedAtMs;
        this.replaySafe = true;
        if (appendedEvents.length > 0) this.scheduleSnapshot();
      } catch {
        // A same-size atomic repair, truncation, or rejected suffix cannot be
        // understood from the old byte frontier. Reuse the authoritative full
        // initialization path, which verifies and repairs the chain before it
        // replaces materialized state.
        requiresCompleteRehydrate = true;
      }
    } finally {
      await this.releaseEventLedgerLease(lease);
    }

    if (!requiresCompleteRehydrate) return;
    if (
      this.pendingPersistenceOperations.length > 0
      || this.localEmissionEpoch !== emissionEpoch
    ) {
      this.replaySafe = false;
      return;
    }
    await this.initializeFromStorage();
  }

  private async acquireEventLedgerLease(): Promise<{
    lockPath: string;
    ownerToken: string;
    heartbeat: ReturnType<typeof setInterval>;
    heartbeatState: { stopped: boolean; inFlight: Promise<void> };
  }> {
    const lockPath = `${this.eventsPath}.lock`;
    const ownerToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
    const deadline = Date.now() + EVENT_LEDGER_LEASE_WAIT_MS;
    while (true) {
      try {
        await fs.writeFile(lockPath, JSON.stringify({
          version: 1,
          scopeId: this.scopeId,
          ownerToken,
          pid: process.pid,
          acquiredAt: Date.now(),
        }), { encoding: 'utf8', flag: 'wx' });
        const heartbeatState = { stopped: false, inFlight: Promise.resolve() };
        const heartbeat = setInterval(() => {
          heartbeatState.inFlight = heartbeatState.inFlight.then(async () => {
            if (heartbeatState.stopped) return;
            try {
              const current = await fs.readJson(lockPath);
              if (heartbeatState.stopped || current?.ownerToken !== ownerToken) return;
              const now = new Date();
              await fs.utimes(lockPath, now, now);
            } catch {
              // A moved/replaced lock is not ours to revive. The guarded token
              // check also prevents a resumed stale owner from touching the
              // successor's lock path and extending its lifetime indefinitely.
            }
          });
        }, 10_000);
        heartbeat.unref?.();
        return { lockPath, ownerToken, heartbeat, heartbeatState };
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > EVENT_LEDGER_LEASE_STALE_MS) {
            const stalePath = `${lockPath}.stale.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
            await fs.move(lockPath, stalePath, { overwrite: false });
            await fs.remove(stalePath).catch(() => undefined);
            continue;
          }
        } catch (statError: any) {
          if (statError?.code === 'ENOENT') continue;
        }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the Context Fabric event writer.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  private async releaseEventLedgerLease(lease: {
    lockPath: string;
    ownerToken: string;
    heartbeat: ReturnType<typeof setInterval>;
    heartbeatState: { stopped: boolean; inFlight: Promise<void> };
  }): Promise<void> {
    lease.heartbeatState.stopped = true;
    clearInterval(lease.heartbeat);
    await lease.heartbeatState.inFlight.catch(() => undefined);
    try {
      const current = await fs.readJson(lease.lockPath);
      if (current?.ownerToken === lease.ownerToken) await fs.remove(lease.lockPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        // Never delete an unreadable or replacement lock owned by another
        // process. Its stale-owner path will recover independently.
      }
    }
  }

  private async prepareEventForDurableAppend(event: ContextFabricEvent): Promise<{
    event: ContextFabricEvent;
    alreadyPresent: boolean;
  }> {
    const ledgerTail = await readDurableLedgerTail(this.eventsPath);
    const tailText = ledgerTail.tailText;
    let tail: ContextFabricEvent | null = null;
    if (tailText) {
      try {
        tail = JSON.parse(tailText) as ContextFabricEvent;
      } catch {
        throw new Error('Context Fabric event ledger has an incomplete tail and requires recovery before append.');
      }
    }
    if (tail) {
      const body = { ...tail, hash: undefined } as any;
      delete body.hash;
      if (
        tail.scopeId !== this.scopeId
        || !isContextFabricEventPayloadValid(tail)
        || (tail.version === 2 && sha256(stableSerialize(body)) !== tail.hash)
        || (
          tail.version === 1
          && (
            tail.sequence !== this.legacyEventPrefixSequence
            || tail.hash !== this.legacyEventPrefixHash
          )
        )
      ) {
        throw new Error('Context Fabric event ledger tail failed its integrity check.');
      }
      if (
        tail.sequence === event.sequence
        && tail.hash === event.hash
        && stableSerialize(tail) === stableSerialize(event)
      ) {
        return { event, alreadyPresent: true };
      }
    }
    if (ledgerTail.size > 0 && !ledgerTail.endsWithNewline) {
      // The existing final record was parsed and integrity-checked above. The
      // writer lease makes a one-byte normalization safe without copying an
      // arbitrarily large ledger to a replacement file.
      await fs.appendFile(this.eventsPath, '\n', 'utf8');
    }
    const expectedSequence = tail ? tail.sequence + 1 : 1;
    const expectedPreviousHash = tail?.hash || '';
    if (event.sequence === expectedSequence && event.previousHash === expectedPreviousHash) {
      return { event, alreadyPresent: false };
    }
    const unpersisted = {
      ...event,
      sequence: expectedSequence,
      previousHash: expectedPreviousHash,
      ...(event.fact ? { fact: { ...event.fact, revision: expectedSequence } } : {}),
      ...(event.episode ? { episode: { ...event.episode, sequence: expectedSequence } } : {}),
      hash: undefined,
    } as any;
    delete unpersisted.hash;
    const body = JSON.parse(JSON.stringify(unpersisted)) as Omit<ContextFabricEvent, 'hash'>;
    const rebased: ContextFabricEvent = { ...body, hash: sha256(stableSerialize(body)) };
    // Another writer committed an event this live instance has not replayed.
    // Our own pending state remains usable, but a snapshot of it is not a
    // complete materialization of the shared ledger and must never accelerate
    // a future restart.
    this.replaySafe = false;
    this.revision = Math.max(this.revision, rebased.sequence);
    this.lastEventHash = rebased.hash;
    return { event: rebased, alreadyPresent: false };
  }

  /**
   * Recover an append whose outcome is ambiguous. A filesystem can commit all
   * or part of appendFile and still surface an error (for example during a
   * transient Windows filter-driver interruption). Blindly repeating the
   * append would duplicate an event or leave an invalid JSONL tail.
   */
  private async reconcileAmbiguousEventAppend(event: ContextFabricEvent, line: string): Promise<void> {
    let ledger = '';
    try {
      ledger = await fs.readFile(this.eventsPath, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const lastNewline = ledger.lastIndexOf('\n');
    const completePrefix = lastNewline >= 0 ? ledger.slice(0, lastNewline + 1) : '';
    const trailingFragment = lastNewline >= 0 ? ledger.slice(lastNewline + 1) : ledger;
    const completeLines = completePrefix.split(/\r?\n/).filter(Boolean);
    const parseEvent = (value: string): ContextFabricEvent | null => {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed as ContextFabricEvent : null;
      } catch {
        return null;
      }
    };
    const lastComplete = completeLines.length > 0
      ? parseEvent(completeLines[completeLines.length - 1])
      : null;
    const fragmentEvent = trailingFragment ? parseEvent(trailingFragment) : null;
    const isSameEvent = (candidate: ContextFabricEvent | null) => Boolean(
      candidate
      && candidate.scopeId === this.scopeId
      && candidate.sequence === event.sequence
      && candidate.hash === event.hash
    );
    const alreadyCommitted = completeLines.some(value => isSameEvent(parseEvent(value)));

    // The first append completed despite reporting an error. Normalize a
    // missing final newline if necessary, but never append the event twice.
    if (alreadyCommitted && !trailingFragment) return;
    if (alreadyCommitted && fragmentEvent) {
      await this.replaceEventLedgerAtomically(`${completePrefix}${trailingFragment}\n`);
      return;
    }
    if (isSameEvent(fragmentEvent)) {
      await this.replaceEventLedgerAtomically(`${completePrefix}${trailingFragment}\n`);
      return;
    }

    // Accept a valid pre-existing tail that merely lacked its final newline.
    // It is not damage and remains part of the verified prefix.
    const previousTail = fragmentEvent || lastComplete;
    const verifiedPrefix = fragmentEvent
      ? `${completePrefix}${trailingFragment}\n`
      : completePrefix;
    const expectedPreviousPresent = event.sequence === 1
      ? !previousTail && event.previousHash === ''
      : Boolean(
          previousTail
          && previousTail.scopeId === this.scopeId
          && previousTail.sequence === event.sequence - 1
          && previousTail.hash === event.previousHash
        );
    if (!expectedPreviousPresent) {
      throw new Error(`Context Fabric event ${event.sequence} cannot be appended after the current ledger tail.`);
    }

    // Drop only the unparseable/incomplete fragment from this failed append,
    // then atomically install the verified prefix plus the exact event.
    await this.replaceEventLedgerAtomically(`${verifiedPrefix}${line}`);
  }

  private async replaceEventLedgerAtomically(contents: string): Promise<void> {
    const temporary = path.join(
      this.scopeDir,
      `.events.append-repair.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      await fs.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      await fs.move(temporary, this.eventsPath, { overwrite: true });
    } catch (error) {
      await fs.remove(temporary).catch(() => undefined);
      throw error;
    }
  }

  private enqueuePersistence(operation: () => Promise<void>): void {
    this.pendingPersistenceOperations.push(operation);
    this.persistQueue = this.persistQueue.then(() => this.drainPersistenceOperations());
  }

  private async drainPersistenceOperations(): Promise<void> {
    while (this.pendingPersistenceOperations.length > 0) {
      const operation = this.pendingPersistenceOperations[0];
      let committed = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await operation();
          committed = true;
          this.persistenceError = null;
          break;
        } catch (error) {
          this.persistenceError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (!committed) return;
      this.pendingPersistenceOperations.shift();
    }
  }

  private async flushPersistenceOperations(): Promise<void> {
    await this.persistQueue;
    if (this.pendingPersistenceOperations.length > 0) {
      this.persistQueue = this.persistQueue.then(() => this.drainPersistenceOperations());
      await this.persistQueue;
    }
    if (this.pendingPersistenceOperations.length > 0 || this.persistenceError) {
      throw new Error(`Context Fabric persistence failed: ${this.persistenceError?.message || 'pending operations could not be committed'}`);
    }
  }

  private scheduleSnapshot(): void {
    if (!this.durable) return;
    const revisionDelta = Math.max(0, this.revision - this.lastSnapshotRevision);
    if (this.lastSnapshotRevision >= 0 && revisionDelta === 0) return;
    const urgent = this.lastSnapshotRevision < 0 || revisionDelta >= SNAPSHOT_EVENT_INTERVAL;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    // Checkpoints accelerate restart; the event ledger is the durability root.
    // Debounce ordinary writes until the chat is idle so a long streaming/tool
    // run never repeatedly serializes its complete history in the hot path.
    const delay = urgent ? 750 : SNAPSHOT_IDLE_DELAY_MS;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.persistSnapshotCheckpoint().catch(() => {
        // The verified ledger is already durable. The next event schedules a
        // fresh acceleration checkpoint; avoid an unhandled timer rejection.
      });
    }, delay);
    (this.snapshotTimer as any).unref?.();
  }

  private searchableFactText(fact: ContextFact): string {
    return [
      fact.kind,
      fact.network,
      fact.key,
      fact.text,
      fact.exactValues.join(' '),
      fact.targets.join(' '),
      fact.entities.join(' '),
    ].join('\n');
  }

  private indexFactProvenance(fact: ContextFact): void {
    for (const item of fact.provenance || []) {
      if (item?.sourceId) this.provenanceSourceIds.add(item.sourceId);
    }
  }

  /**
   * Apply one fact revision and maintain the single active value for a
   * kind/key identity. This also deterministically resolves concurrent writers
   * that could not see each other's just-committed active revision.
   */
  private materializeFact(fact: ContextFact): void {
    const priorSameId = this.facts.get(fact.id);
    if (priorSameId?.status === 'active') {
      const priorIdentity = activeFactIdentity(priorSameId.kind, priorSameId.key);
      if (this.activeFactIdByIdentity.get(priorIdentity) === priorSameId.id) {
        this.activeFactIdByIdentity.delete(priorIdentity);
      }
    }
    if (fact.status === 'active') {
      const identity = activeFactIdentity(fact.kind, fact.key);
      const conflictingId = this.activeFactIdByIdentity.get(identity);
      const conflicting = conflictingId ? this.facts.get(conflictingId) : undefined;
      if (conflicting && conflicting.id !== fact.id && conflicting.status === 'active') {
        const boundaryAt = Math.max(conflicting.validFrom, fact.validFrom);
        this.facts.set(conflicting.id, {
          ...conflicting,
          status: 'superseded',
          supersededBy: fact.id,
          validTo: boundaryAt,
          invalidatedAt: boundaryAt,
          lastObservedAt: Math.max(conflicting.lastObservedAt, boundaryAt),
        });
      }
      this.activeFactIdByIdentity.set(identity, fact.id);
    }
    this.facts.set(fact.id, fact);
    this.factKindsPresent.add(fact.kind);
    this.latestFactIdByKind.set(fact.kind, fact.id);
    this.touchRecentFact(fact.id);
    this.indexFactTerms(fact);
    this.indexFactProvenance(fact);
  }

  private touchRecentFact(factId: string): void {
    this.recentFactIds.delete(factId);
    this.recentFactIds.set(factId, true);
    while (this.recentFactIds.size > MAX_RECENT_FACT_INDEX) {
      const oldest = this.recentFactIds.keys().next().value;
      if (!oldest) break;
      this.recentFactIds.delete(oldest);
    }
  }

  private indexFactTerms(fact: ContextFact): void {
    const previousTerms = this.lexicalTermsByFactId.get(fact.id) || [];
    for (const term of previousTerms) {
      const postings = this.lexicalFactIdsByTerm.get(term);
      postings?.delete(fact.id);
      if (postings?.size === 0) this.lexicalFactIdsByTerm.delete(term);
    }
    const identityTerms = queryTerms([
      fact.kind,
      fact.network,
      fact.key,
      fact.exactValues.join(' '),
      fact.targets.join(' '),
      fact.entities.join(' '),
    ].join('\n'));
    const terms = Array.from(new Set([
      ...identityTerms,
      ...queryTerms(fact.text),
    ])).slice(0, MAX_LEXICAL_TERMS_PER_FACT);
    this.lexicalTermsByFactId.set(fact.id, terms);
    for (const term of terms) {
      let postings = this.lexicalFactIdsByTerm.get(term);
      if (!postings) {
        postings = new Map();
        this.lexicalFactIdsByTerm.set(term, postings);
      }
      postings.delete(fact.id);
      postings.set(fact.id, true);
      while (postings.size > MAX_LEXICAL_POSTINGS_PER_TERM) {
        const oldest = postings.keys().next().value;
        if (!oldest) break;
        postings.delete(oldest);
      }
    }
  }

  private rebuildFactIndexes(): void {
    this.provenanceSourceIds = new Set();
    this.activeFactIdByIdentity = new Map();
    this.latestFactIdByKind = new Map();
    this.factKindsPresent = new Set();
    this.recentFactIds = new Map();
    this.lexicalFactIdsByTerm = new Map();
    this.lexicalTermsByFactId = new Map();
    const ordered = Array.from(this.facts.values()).sort((left, right) =>
      left.revision - right.revision
      || left.lastObservedAt - right.lastObservedAt
      || left.id.localeCompare(right.id)
    );
    for (const fact of ordered) {
      this.factKindsPresent.add(fact.kind);
      this.latestFactIdByKind.set(fact.kind, fact.id);
      this.touchRecentFact(fact.id);
      this.indexFactTerms(fact);
      this.indexFactProvenance(fact);
      if (fact.status !== 'active') continue;
      const identity = activeFactIdentity(fact.kind, fact.key);
      const conflictingId = this.activeFactIdByIdentity.get(identity);
      const conflicting = conflictingId ? this.facts.get(conflictingId) : undefined;
      if (conflicting && conflicting.status === 'active') {
        const boundaryAt = Math.max(conflicting.validFrom, fact.validFrom);
        this.facts.set(conflicting.id, {
          ...conflicting,
          status: 'superseded',
          supersededBy: fact.id,
          validTo: boundaryAt,
          invalidatedAt: boundaryAt,
          lastObservedAt: Math.max(conflicting.lastObservedAt, boundaryAt),
        });
      }
      this.activeFactIdByIdentity.set(identity, fact.id);
    }
  }

  private activeFactsSnapshot(): ContextFact[] {
    const active: ContextFact[] = [];
    for (const factId of this.activeFactIdByIdentity.values()) {
      const fact = this.facts.get(factId);
      if (fact?.status === 'active') active.push(fact);
    }
    return active;
  }

  private latestFactOfKind(kind: ContextFactKind): ContextFact | undefined {
    const factId = this.latestFactIdByKind.get(kind);
    return factId ? this.facts.get(factId) : undefined;
  }

  private searchableEpisodeText(episode: ContextEpisode): string {
    return [episode.header, episode.contentPreview, episode.toolName || '', episode.targets.join(' ')].join('\n');
  }

  private touchRecentEpisode(episodeId: string): void {
    this.recentEpisodeIds.delete(episodeId);
    this.recentEpisodeIds.set(episodeId, true);
    while (this.recentEpisodeIds.size > MAX_RECENT_EPISODE_INDEX) {
      const oldest = this.recentEpisodeIds.keys().next().value;
      if (!oldest) break;
      this.recentEpisodeIds.delete(oldest);
    }
  }

  private indexLink(link: ContextLink): void {
    const indexDirection = (fromFactId: string, toFactId: string) => {
      let neighbors = this.linkAdjacency.get(fromFactId);
      if (!neighbors) {
        neighbors = new Map();
        this.linkAdjacency.set(fromFactId, neighbors);
      }
      neighbors.set(toFactId, Math.max(neighbors.get(toFactId) || 0, clamp01(link.weight)));
    };
    indexDirection(link.fromFactId, link.toFactId);
    indexDirection(link.toFactId, link.fromFactId);
  }

  private rebuildLinkAdjacency(): void {
    this.linkAdjacency = new Map();
    for (const link of this.links.values()) this.indexLink(link);
  }

  private rebuildVectorizer(): void {
    this.vectorizer = new TfIdfVectorizer(2_000);
    for (const fact of this.facts.values()) this.vectorizer.addDocument(this.searchableFactText(fact));
    for (const episode of this.episodes.values()) this.vectorizer.addDocument(this.searchableEpisodeText(episode));
  }

  private archiveEpisode(input: {
    source: ContextProvenance['source'];
    header: string;
    content: unknown;
    toolName?: string;
    targets?: string[];
    originId?: string;
    createdAt?: number;
  }): ContextEpisode {
    const normalizedOriginId = input.originId ? normalizeText(input.originId, 700) : '';
    if (normalizedOriginId) {
      const existingId = this.episodeIdByOrigin.get(normalizedOriginId);
      const existing = existingId ? this.episodes.get(existingId) : undefined;
      if (existing) return existing;
    }
    const createdAt = Number.isFinite(input.createdAt)
      ? Math.max(0, Math.floor(Number(input.createdAt)))
      : Date.now();
    const serialized = stableSerialize(input.content);
    const serializedBuffer = Buffer.from(serialized, 'utf8');
    if (serializedBuffer.length > MAX_EPISODE_BYTES) {
      throw new Error('Context episode exceeds the bounded durable page size.');
    }
    const contentHash = sha256(serialized);
    // Include content identity so two desktop/background processes observing
    // the same revision and millisecond cannot map different episodes onto the
    // same page path before their ledger events are rebased under the lease.
    const id = `ep_${sha256(`${this.scopeId}\u0000${createdAt}\u0000${this.revision}\u0000${input.header}\u0000${contentHash}`).slice(0, 20)}`;
    const oversized = serializedBuffer.length > MAX_PAGE_BYTES;
    const pageRef = oversized ? `pages/${id}.manifest.json` : `pages/${id}.json.gz`;
    const episode: ContextEpisode = {
      id,
      sequence: this.revision + 1,
      source: input.source,
      createdAt,
      ...(normalizedOriginId ? { originId: normalizedOriginId } : {}),
      header: normalizeText(input.header, 700),
      contentPreview: normalizeText(serialized, 1_600),
      contentHash,
      pageRef,
      toolName: input.toolName,
      targets: uniqueStrings(input.targets || [], 32),
    };
    this.vectorizer.addDocument(`${episode.header}\n${episode.contentPreview}\n${episode.targets.join(' ')}`);
    if (!this.durable) {
      this.ephemeralPages.set(pageRef, serialized);
    } else {
      this.enqueuePersistence(async () => {
        const pagesDir = path.join(this.scopeDir, 'pages');
        await fs.ensureDir(pagesDir);
        if (!oversized) {
          const compressed = await gzipAsync(serializedBuffer);
          await persistImmutableContextPageFile(
            path.join(this.scopeDir, pageRef),
            compressed,
            async existing => (await gunzipContextPage(existing)).equals(serializedBuffer),
          );
          return;
        }
        const chunkRefs: string[] = [];
        for (let offset = 0, index = 0; offset < serializedBuffer.length; offset += MAX_PAGE_BYTES, index += 1) {
          const chunk = serializedBuffer.subarray(offset, Math.min(serializedBuffer.length, offset + MAX_PAGE_BYTES));
          const chunkRef = `pages/${id}.part-${String(index).padStart(4, '0')}.txt.gz`;
          chunkRefs.push(chunkRef);
          const compressedChunk = await gzipAsync(chunk);
          await persistImmutableContextPageFile(
            path.join(this.scopeDir, chunkRef),
            compressedChunk,
            async existing => (await gunzipContextPage(existing)).equals(chunk),
          );
        }
        const manifest = {
          version: 1,
          contentHash: episode.contentHash,
          chunks: chunkRefs,
        };
        const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await persistImmutableContextPageFile(
          path.join(this.scopeDir, pageRef),
          manifestBytes,
          async existing => {
            if (existing.byteLength > MAX_PAGE_MANIFEST_BYTES) return false;
            try {
              return stableSerialize(JSON.parse(existing.toString('utf8'))) === stableSerialize(manifest);
            } catch {
              return false;
            }
          },
        );
      });
    }
    this.emit('episode', { episode });
    return episode;
  }

  async openPage(pageRef: string): Promise<unknown> {
    await this.flushPersistenceOperations();
    const normalized = String(pageRef || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized.startsWith('pages/') || normalized.includes('..')) {
      throw new Error('Invalid context page reference.');
    }
    const absolute = path.resolve(this.scopeDir, normalized);
    if (!absolute.startsWith(path.resolve(this.scopeDir) + path.sep)) {
      throw new Error('Context page reference escapes its scope.');
    }
    const episodeId = this.episodeIdByPageRef.get(normalized);
    const episode = episodeId ? this.episodes.get(episodeId) : undefined;
    if (!episode) throw new Error(`Unknown context page: ${normalized}`);
    if (!this.durable) {
      const serialized = this.ephemeralPages.get(normalized);
      if (serialized === undefined) throw new Error(`Unknown ephemeral context page: ${normalized}`);
      if (sha256(serialized) !== episode.contentHash) throw new Error('Context page integrity check failed.');
      try { return JSON.parse(serialized); } catch { return serialized; }
    }
    let serialized = '';
    if (normalized.endsWith('.manifest.json')) {
      const manifestStat = await fs.stat(absolute);
      if (!manifestStat.isFile() || manifestStat.size > MAX_PAGE_MANIFEST_BYTES) {
        throw new Error('Context page manifest exceeds its bounded size.');
      }
      const manifest = await fs.readJson(absolute);
      const chunkRefs = Array.isArray(manifest?.chunks) ? manifest.chunks : [];
      const expectedChunkPattern = new RegExp(`^pages/${episode.id}\\.part-[0-9]{4}\\.txt\\.gz$`);
      if (
        manifest?.version !== 1
        || manifest?.contentHash !== episode.contentHash
        || chunkRefs.length < 1
        || chunkRefs.length > MAX_PAGE_CHUNKS
        || new Set(chunkRefs.map((value: unknown) => String(value))).size !== chunkRefs.length
      ) {
        throw new Error('Context page manifest failed its integrity check.');
      }
      const chunks: Buffer[] = [];
      let expandedBytes = 0;
      for (const chunkRef of chunkRefs) {
        const normalizedChunkRef = String(chunkRef).replace(/\\/g, '/');
        if (!expectedChunkPattern.test(normalizedChunkRef)) throw new Error('Invalid page chunk reference.');
        const chunkPath = path.resolve(this.scopeDir, ...normalizedChunkRef.split('/'));
        if (!chunkPath.startsWith(path.resolve(this.scopeDir) + path.sep)) throw new Error('Invalid page chunk reference.');
        const expandedChunk = await gunzipContextPage(await fs.readFile(chunkPath));
        expandedBytes += expandedChunk.length;
        if (expandedBytes > MAX_EPISODE_BYTES) throw new Error('Context page exceeds its bounded expanded size.');
        chunks.push(expandedChunk);
      }
      serialized = Buffer.concat(chunks).toString('utf8');
      if (sha256(serialized) !== manifest?.contentHash) throw new Error('Context page integrity check failed.');
    } else {
      serialized = (await gunzipContextPage(await fs.readFile(absolute))).toString('utf8');
    }
    if (sha256(serialized) !== episode.contentHash) throw new Error('Context page integrity check failed.');
    try { return JSON.parse(serialized); } catch { return serialized; }
  }

  getEpisodeByPageRef(pageRef: string): ContextEpisode | undefined {
    const normalized = String(pageRef || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const episodeId = this.episodeIdByPageRef.get(normalized);
    const episode = episodeId ? this.episodes.get(episodeId) : undefined;
    return episode ? cloneEpisode(episode) : undefined;
  }

  private upsertFact(input: {
    key: string;
    kind: ContextFactKind;
    text: string;
    exactValues?: string[];
    targets?: string[];
    importance: number;
    epistemic: ContextEpistemicStatus;
    provenance: ContextProvenance;
  }): ContextFact {
    const text = normalizeText(input.text);
    if (!text) throw new Error('Context facts require non-empty text.');
    const key = normalizeText(input.key, 420) || `${input.kind}:${sha256(text).slice(0, 16)}`;
    const exactValues = uniqueStrings([...(input.exactValues || []), ...extractExactValues(text)], 48);
    const targets = uniqueStrings(input.targets || [], 24);
    const entities = extractEntities(text, targets);
    const observedAt = Number(input.provenance.observedAt || Date.now());
    const importance = Math.max(0, Math.min(10, input.importance));
    const activeId = this.activeFactIdByIdentity.get(activeFactIdentity(input.kind, key));
    const active = activeId ? this.facts.get(activeId) : undefined;
    const same = active
      && active.status === 'active'
      && active.text === text
      && stableSerialize(active.exactValues) === stableSerialize(exactValues)
        ? active
        : undefined;
    if (same) {
      const observations = same.observations + 1;
      const reinforced: ContextFact = {
        ...same,
        lastObservedAt: observedAt,
        observations,
        importance: Math.max(same.importance, importance),
        revision: this.revision + 1,
        retrievalCount: same.retrievalCount || 0,
        valueFactors: {
          ...same.valueFactors,
          reliability: clamp01(Math.max(same.valueFactors.reliability, initialValueFactors({
            kind: input.kind,
            epistemic: input.epistemic,
            importance,
            text,
            source: input.provenance.source,
            observations,
          }).reliability)),
          usageHistory: clamp01(observations / (observations + 1)),
        },
        entities: uniqueStrings([...same.entities, ...entities], 32),
        targets: uniqueStrings([...same.targets, ...targets], 24),
        provenance: [...same.provenance, input.provenance].slice(-MAX_PROVENANCE_PER_FACT),
      };
      this.emit('upsert', { fact: reinforced });
      return reinforced;
    }

    const id = `cf_${sha256(`${this.scopeId}\u0000${key}\u0000${text}\u0000${observedAt}\u0000${this.revision}`).slice(0, 18)}`;
    const superseded: ContextFact[] = [];
    if (active && active.status === 'active') {
      superseded.push(active);
      this.emit('upsert', {
        fact: {
          ...active,
          status: 'superseded',
          supersededBy: id,
          validTo: observedAt,
          invalidatedAt: observedAt,
          lastObservedAt: observedAt,
          revision: this.revision + 1,
        },
      });
    }

    const fact: ContextFact = {
      id,
      key,
      kind: input.kind,
      network: networkForKind(input.kind, input.epistemic),
      status: 'active',
      epistemic: input.epistemic,
      text,
      exactValues,
      targets,
      importance,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      observations: 1,
      revision: this.revision + 1,
      validFrom: observedAt,
      recordedAt: Date.now(),
      entities,
      retrievalCount: 0,
      valueFactors: initialValueFactors({
        kind: input.kind,
        epistemic: input.epistemic,
        importance,
        text,
        source: input.provenance.source,
        observations: 1,
      }),
      provenance: [input.provenance],
    };
    this.emit('upsert', { fact });
    this.vectorizer.addDocument(this.searchableFactText(fact));
    for (const prior of superseded) this.createLink(prior.id, fact.id, 'contradicts', 1);
    this.connectFact(fact);
    return fact;
  }

  private createLink(
    fromFactId: string,
    toFactId: string,
    relation: ContextLink['relation'],
    weight: number,
  ): void {
    if (!fromFactId || !toFactId || fromFactId === toFactId) return;
    const id = `cl_${sha256(`${fromFactId}\u0000${toFactId}\u0000${relation}`).slice(0, 18)}`;
    if (this.links.has(id)) return;
    this.emit('link', {
      link: {
        id,
        fromFactId,
        toFactId,
        relation,
        weight: clamp01(weight),
        createdAt: Date.now(),
      },
    });
  }

  private connectFact(fact: ContextFact): void {
    const targetKeys = new Set(fact.targets.map(normalizeKey).filter(Boolean));
    const entityKeys = new Set(fact.entities.map(normalizeKey).filter(Boolean));
    const candidates: ContextFact[] = [];
    const recentIds = Array.from(this.recentFactIds.keys());
    for (let index = recentIds.length - 1; index >= 0 && candidates.length < 240; index -= 1) {
      if (recentIds[index] === fact.id) continue;
      const candidate = this.facts.get(recentIds[index]);
      if (candidate) candidates.push(candidate);
    }
    let linked = 0;
    for (const other of candidates) {
      const sameTarget = other.targets.some(target => targetKeys.has(normalizeKey(target)));
      const sharedEntity = other.entities.some(entity => entityKeys.has(normalizeKey(entity)));
      if (!sameTarget && !sharedEntity) continue;
      this.createLink(other.id, fact.id, sameTarget ? 'same_target' : 'shared_entity', sameTarget ? 0.9 : 0.65);
      linked += 1;
      if (linked >= 16) break;
    }
    const prior = candidates[0];
    if (prior && prior.lastObservedAt <= fact.lastObservedAt) {
      if (fact.kind === 'failure') this.createLink(fact.id, prior.id, 'caused_by', 0.35);
      else this.createLink(prior.id, fact.id, 'followed_by', 0.35);
    }
  }

  observeUserRequest(
    request: string,
    mode: 'new' | 'continuation' | 'retry' = 'new',
    runId = '',
  ): void {
    request = visibleUserRequest(request);
    const text = normalizeText(request);
    if (!text) return;
    const stableRunId = normalizeText(runId, 220);
    const liveOriginId = stableRunId ? `user-run:${stableRunId}` : '';
    const transcriptOriginId = stableRunId ? `chat-trace:${stableRunId}:user` : '';
    // Key rotation and provider failover can re-enter an execution loop for
    // the same immutable UI turn. That is transport recovery, not another
    // user observation; duplicating it bloats the ledger and overweights the
    // request in retrieval. Recognize both live and hydrated transcript IDs.
    if (
      liveOriginId
      && (
        this.episodeIdByOrigin.has(liveOriginId)
        || this.episodeIdByOrigin.has(transcriptOriginId)
        || this.episodeIdByOrigin.has(`chat-trace:user-turn-${stableRunId}:user`)
      )
    ) return;
    const now = Date.now();
    const sourceId = `request_${sha256(stableRunId || `${now}\u0000${this.revision}\u0000${text}`).slice(0, 20)}`;
    const episode = this.archiveEpisode({
      source: 'user',
      header: `User request (${mode})`,
      content: { mode, request },
      originId: liveOriginId || undefined,
    });
    const provenance: ContextProvenance = {
      source: 'user',
      sourceId,
      observedAt: now,
      mutationEpoch: this.mutationEpoch,
      pageRef: episode.pageRef,
    };
    // Task boundaries retire the old root explicitly. Every other message is
    // interpreted with that root, not through a list of continuation words.
    if (!this.activeFactIdByIdentity.has(activeFactIdentity('objective', 'objective:root'))) {
      this.upsertFact({
        key: 'objective:root', kind: 'objective', text, importance: 10,
        epistemic: 'user_asserted', provenance,
      });
    }
    // The latest-message slot is only a pointer. Keep each human update as
    // its own ordered source so an unrelated follow-up cannot erase a prior
    // correction or addition during compaction. Meaning is reconciled by the
    // model; different text alone is not a semantic contradiction.
    this.upsertFact({
      key: `objective:directive:${sourceId}`, kind: 'objective',
      text, importance: 10, epistemic: 'user_asserted', provenance,
    });
    this.upsertFact({
      key: 'objective:current-directive', kind: 'objective',
      text,
      importance: 10,
      epistemic: 'user_asserted', provenance,
    });
    for (const clause of extractConstraintClauses(String(request || ''))) {
      const subject = normalizeKey(clause) || sha256(clause).slice(0, 16);
      this.upsertFact({
        key: `constraint:${subject}`, kind: 'constraint', text: clause,
        importance: 10, epistemic: 'user_asserted', provenance,
      });
    }
  }

  /**
   * Import the UI's durable transcript into the provider-neutral page store.
   * This is a migration/recovery path, not the normal write path: live turns
   * are recorded by observeUserRequest()/recordAssistantResponse(). Stable
   * origin IDs make repeated hydration idempotent without incorrectly merging
   * two intentionally identical messages from different turns.
   */
  importDialogueTurns(turns: Array<{
    originId: string;
    role: 'user' | 'assistant';
    text: string;
    createdAt?: number;
  }>): number {
    let imported = 0;
    for (const turn of turns) {
      const originId = normalizeText(turn?.originId, 700);
      const exactText = String(turn?.text ?? '').replace(/\u0000/g, '');
      const liveRun = originId.match(/^chat-trace:(.+):(user|assistant)$/);
      const liveOriginAlias = liveRun
        ? `${liveRun[2]}-run:${normalizeText(liveRun[1], 220)}`
        : originId.startsWith('chat-steering:')
          ? `human-update:steering:${originId.slice('chat-steering:'.length)}`
          : '';
      if (
        !originId
        || !exactText.trim()
        || this.episodeIdByOrigin.has(originId)
        // The live request path records run-owned pages before the UI snapshot
        // receives its stable trace ID. Recognize that alias so next-turn
        // hydration does not archive the same user/assistant turn a second time.
        || Boolean(liveOriginAlias && this.episodeIdByOrigin.has(liveOriginAlias))
      ) continue;
      this.archiveEpisode({
        source: turn.role === 'user' ? 'user' : 'runtime',
        header: turn.role === 'user' ? 'Imported user message' : 'Imported assistant response',
        content: { role: turn.role, text: exactText },
        originId,
        createdAt: turn.createdAt,
      });
      imported += 1;
    }
    return imported;
  }

  /** Source-app tool records are historical evidence, never live executions or
   * permission grants. Archive exact text without changing current tool facts. */
  importHistoricalObservations(records: Array<{ originId: string; text: string; toolName: string; createdAt?: number }>): number {
    let imported = 0;
    for (const record of records) {
      if (!record.originId || !record.text.trim() || this.episodeIdByOrigin.has(record.originId)) continue;
      this.archiveEpisode({ source: 'tool', header: `Imported historical tool record: ${record.toolName}`, content: { text: record.text, historical: true }, toolName: record.toolName, originId: record.originId, createdAt: record.createdAt });
      imported++;
    }
    return imported;
  }

  /**
   * Retire prior objective anchors and decisions at a task boundary. A
   * heuristic cannot revoke human constraints, resolve a failure, or settle a
   * pending process. Those records retain their source scope for interpretation.
   * Exact pages, artifacts, evidence, and preferences remain recallable.
   */
  beginTaskBoundary(reason = 'A new objective started in the same chat.'): void {
    const now = Date.now();
    const sourceId = `task_boundary_${sha256(`${now}\u0000${reason}\u0000${this.revision}`).slice(0, 16)}`;
    const episode = this.archiveEpisode({
      source: 'runtime',
      header: 'In-chat task boundary',
      content: { reason, at: now, priorMutationEpoch: this.mutationEpoch },
      originId: sourceId,
      createdAt: now,
    });
    for (const fact of this.activeFactsSnapshot()) {
      if (
        fact.status !== 'active' ||
        !['objective', 'decision'].includes(fact.kind)
      ) continue;
      this.emit('upsert', {
        fact: {
          ...fact,
          status: 'resolved',
          resolvedBy: sourceId,
          validTo: now,
          invalidatedAt: now,
          lastObservedAt: now,
          revision: this.revision + 1,
          provenance: [...fact.provenance, {
            source: 'runtime' as const,
            sourceId,
            observedAt: now,
            mutationEpoch: this.mutationEpoch,
            pageRef: episode.pageRef,
          }].slice(-MAX_PROVENANCE_PER_FACT),
        },
      });
    }
  }

  observeSteering(text: string, sourceId = '', origin: 'human' | 'agent' = 'human'): void {
    const normalized = normalizeText(text);
    if (!normalized) return;
    sourceId = sourceId || `steering_${Date.now()}_${this.revision}`;
    if (this.provenanceSourceIds.has(sourceId)) return;
    const episode = this.archiveEpisode({
      source: origin === 'human' ? 'steering' : 'runtime',
      header: origin === 'human' ? 'User steering update' : 'Agent-proposed guidance',
      content: { sourceId, text, origin },
      originId: `${origin === 'human' ? 'human' : 'agent'}-update:${sourceId}`,
    });
    const provenance: ContextProvenance = {
      source: origin === 'human' ? 'steering' : 'runtime', sourceId, observedAt: Date.now(), mutationEpoch: this.mutationEpoch,
      pageRef: episode.pageRef,
    };
    if (origin === 'agent') {
      this.upsertFact({
        key: 'next_action:agent-guidance', kind: 'next_action',
        text: `Agent-proposed guidance, subject to the human user's scope and constraints: ${normalized}`,
        importance: 8, epistemic: 'inferred', provenance,
      });
      return;
    }
    // Do not replace the previous update wholesale: this update may change
    // only one choice or ask a question while earlier work remains pending.
    this.upsertFact({
      key: `objective:directive:${sourceId}`, kind: 'objective', text: normalized,
      importance: 10, epistemic: 'user_asserted', provenance,
    });
    this.upsertFact({
      key: 'objective:current-directive', kind: 'objective', text: normalized,
      importance: 10, epistemic: 'user_asserted', provenance,
    });
    for (const clause of extractConstraintClauses(normalized)) {
      this.upsertFact({
        key: `constraint:${normalizeKey(clause) || sha256(clause).slice(0, 16)}`,
        kind: 'constraint', text: clause, importance: 10,
        epistemic: 'user_asserted', provenance,
      });
    }
  }

  recordTool(
    toolName: string,
    args: Record<string, any> = {},
    result: any = {},
    rawResult: any = result,
  ): string {
    const semantics = classifyToolSemantics(toolName, args);
    const normalizedToolName = String(toolName || '').trim().toLowerCase();
    const success = toolResultSucceeded(rawResult);
    const outcome = getToolResultOutcome(rawResult);
    let targets = extractToolTargets(args, rawResult);
    if (
      success
      && normalizedToolName.startsWith('workspace_')
      && ['observation', 'verification'].includes(semantics.effect)
    ) {
      targets = enrichWorkspaceObservationTargets(targets, args, rawResult);
    }
    const changedState = toolResultChangedState(rawResult, semantics);
    if (changedState) this.mutationEpoch += 1;
    const resultHash = sha256(stableSerialize(rawResult));
    const sourceId = `tool_${sha256(`${toolName}\u0000${stableSerialize(args)}\u0000${this.revision}`).slice(0, 16)}`;
    const observedAt = Date.now();
    const episode = this.archiveEpisode({
      source: 'tool',
      header: `${toolName}: ${outcome} (${semantics.effect})`,
      content: { toolName, arguments: args, result: rawResult, semantics, changedState, mutationEpoch: this.mutationEpoch },
      toolName,
      targets,
    });
    const provenance: ContextProvenance = {
      source: 'tool', sourceId, observedAt, toolName, resultHash,
      mutationEpoch: this.mutationEpoch,
      pageRef: episode.pageRef,
      ...(
        normalizedToolName.startsWith('workspace_')
        && ['observation', 'verification'].includes(semantics.effect)
          ? {
              observationScope: 'workspace' as const,
              targetSnapshots: captureTargetSnapshots(targets),
            }
          : semantics.effect === 'observation'
            ? { observationScope: 'external' as const }
            : {}
      ),
    };
    const reusableWorkspaceObservation = provenance.observationScope === 'workspace';
    const summary = summarizeResult(
      toolName,
      args,
      result,
      semantics.isMutation && !changedState ? 'observation' : semantics.effect,
      reusableWorkspaceObservation ? MAX_REUSABLE_OBSERVATION : MAX_RESULT_SUMMARY,
    );
    const exactValues = uniqueStrings([
      ...targets,
      result?.exitCode,
      result?.exit_code,
      result?.code,
      ...extractExactValues(summary),
    ], 48);

    if (changedState && normalizedToolName.startsWith('workspace_')) {
      this.invalidateWorkspaceObservationsForTargets(targets, sourceId, observedAt);
    }
    const workId = String(rawResult?.taskId || rawResult?.backgroundTaskId || args?.taskId || '').trim();
    const pendingKey = `next_action:tool:${normalizedToolName}:${workId || sha256(stableSerialize(args)).slice(0, 16)}`;
    if (outcome === 'pending') {
      this.upsertFact({
        key: pendingKey, kind: 'next_action',
        text: `${toolName} accepted; completion is pending${workId ? ` (taskId=${workId})` : ''}. ${summary}`,
        exactValues: uniqueStrings([...exactValues, workId], 48), targets,
        importance: 9, epistemic: 'observed', provenance,
      });
      return episode.pageRef;
    }
    const pendingId = this.activeFactIdByIdentity.get(activeFactIdentity('next_action', pendingKey));
    if (pendingId) this.invalidateFact(pendingId, `${toolName} reported ${outcome}`);
    if (outcome === 'noop') return episode.pageRef;

    if (!success) {
      const signature = sha256(`${toolName}\u0000${stableSerialize(args)}`).slice(0, 16);
      this.upsertFact({
        key: `failure:${signature}`, kind: 'failure', text: summary,
        exactValues, targets, importance: 9, epistemic: 'observed', provenance,
      });
      return episode.pageRef;
    }

    if (changedState) {
      const stateTargets = targets.length > 0 ? targets : [`${toolName}:workspace-state`];
      for (const target of stateTargets.slice(0, 12)) {
        this.upsertFact({
          key: `state:${normalizeKey(target)}`, kind: semantics.effect === 'artifact' ? 'artifact' : 'state',
          text: summary, exactValues, targets: [target], importance: 9,
          epistemic: 'observed', provenance,
        });
      }
    } else if (semantics.isVerification) {
      this.upsertFact({
        key: `verification:epoch:${this.mutationEpoch}:${sha256(stableSerialize(args)).slice(0, 10)}`,
        kind: 'evidence', text: summary, exactValues, targets, importance: 10,
        epistemic: 'observed', provenance,
      });
      this.resolveFailuresForTargets(targets, sourceId);
    } else if (semantics.isExternalSideEffect) {
      this.upsertFact({
        key: `external:${sha256(`${toolName}\u0000${stableSerialize(args)}`).slice(0, 16)}`,
        kind: 'evidence', text: summary, exactValues, targets, importance: 10,
        epistemic: 'observed', provenance,
      });
    } else if (semantics.effect === 'coordination') {
      const coordinationKind: ContextFactKind = toolName === 'task_checkpoint' ? 'decision' : 'next_action';
      this.upsertFact({
        key: `${coordinationKind}:${sha256(`${toolName}\u0000${stableSerialize(args)}`).slice(0, 16)}`,
        kind: coordinationKind, text: summary, exactValues, targets,
        importance: 8, epistemic: 'observed', provenance,
      });
    } else if (
      reusableWorkspaceObservation
      && normalizedToolName === 'workspace_run_command'
      && semantics.effect === 'observation'
      && Array.isArray(args.commands)
      && args.commands.length > 1
    ) {
      // Preserve each parallel source read as its own reusable unit. The
      // terminal returns one chronological aggregate string to the provider;
      // treating that aggregate as one fact made its bounded preview favor the
      // first command and forced later turns to reopen the remaining files.
      const childResults = Array.isArray(rawResult?.results) ? rawResult.results : [];
      args.commands.slice(0, 32).forEach((entry: any, index: number) => {
        const childArgs = {
          ...(entry && typeof entry === 'object' ? entry : { command: String(entry || '') }),
          cwd: entry?.cwd || args.cwd,
        };
        const childRaw = {
          ...(childResults[index] || {}),
          stdout: batchCommandOutput(rawResult?.stdout, index),
          stderr: batchCommandOutput(rawResult?.stderr, index),
        };
        const childTargets = enrichWorkspaceObservationTargets(
          extractToolTargets(childArgs, childRaw),
          childArgs,
          childRaw,
        );
        const childSourceId = `${sourceId}_part_${index + 1}`;
        const childProvenance: ContextProvenance = {
          ...provenance,
          sourceId: childSourceId,
          resultHash: sha256(stableSerialize(childRaw)),
          targetSnapshots: captureTargetSnapshots(childTargets),
        };
        const childSummary = summarizeResult(
          toolName,
          childArgs,
          childRaw,
          'observation',
          MAX_REUSABLE_OBSERVATION,
        );
        this.upsertFact({
          key: `evidence:${sha256(`${toolName}\u0000${stableSerialize(childArgs)}`).slice(0, 16)}`,
          kind: 'evidence',
          text: childSummary,
          exactValues: uniqueStrings([
            ...childTargets,
            childRaw?.exitCode,
            childRaw?.exit_code,
            childRaw?.code,
            ...extractExactValues(childSummary),
          ], 48),
          targets: childTargets,
          importance: 8,
          epistemic: 'observed',
          provenance: childProvenance,
        });
      });
    } else if (semantics.effect === 'observation' || semantics.effect === 'command' || semantics.isMutation) {
      const observationSignature = sha256(`${toolName}\u0000${stableSerialize(args)}`).slice(0, 16);
      this.upsertFact({
        key: `evidence:${observationSignature}`,
        kind: 'evidence', text: summary, exactValues, targets,
        importance: reusableWorkspaceObservation
          ? 8
          : /web|research|scrap/i.test(toolName)
            ? 7
            : semantics.isMutation
              ? 7
              : 5,
        epistemic: 'observed', provenance,
      });
    }
    return episode.pageRef;
  }

  /**
   * A local read is authoritative only until an overlapping local mutation.
   * Resolve just those observations; unrelated file knowledge remains fresh
   * and useful on later user turns instead of being discarded by one global
   * workspace epoch.
   */
  private invalidateWorkspaceObservationsForTargets(
    mutationTargets: string[],
    resolvedBy: string,
    invalidatedAt: number,
  ): void {
    for (const fact of this.activeFactsSnapshot()) {
      if (fact.kind !== 'evidence' || fact.status !== 'active') continue;
      const latest = fact.provenance[fact.provenance.length - 1];
      const isWorkspaceObservation = latest?.observationScope === 'workspace'
        || String(latest?.toolName || '').toLowerCase().startsWith('workspace_');
      if (!isWorkspaceObservation) continue;
      const hasVerifiedTargetIdentity = Array.isArray(latest?.targetSnapshots)
        && latest.targetSnapshots.length > 0;
      // A search command can contain path-shaped regex text while omitting an
      // explicit search root. If no reported target could be matched to a real
      // local object, its scope is unknown and every workspace mutation must
      // invalidate it conservatively instead of trusting a guessed path.
      if (hasVerifiedTargetIdentity && !targetsOverlap(fact.targets, mutationTargets)) continue;
      this.emit('upsert', {
        fact: {
          ...fact,
          status: 'superseded',
          validTo: invalidatedAt,
          invalidatedAt,
          resolvedBy,
          lastObservedAt: invalidatedAt,
          revision: this.revision + 1,
        },
      });
    }
  }

  /**
   * Detect an out-of-agent file change just before an observation can enter a
   * prompt. Retrieval used to stat every remembered file on every provider
   * cycle, making larger coding chats slower as their evidence graph grew.
   * Ranked, lazy validation keeps the same freshness guarantee for evidence
   * the model may use while leaving unrelated durable observations untouched.
   */
  private ensureWorkspaceObservationFresh(
    fact: ContextFact,
    observedAt: number,
    currentStatCache: Map<string, CurrentTargetSnapshot>,
  ): boolean {
    const latest = fact.provenance[fact.provenance.length - 1];
    if (
      fact.kind !== 'evidence'
      || fact.status !== 'active'
      || latest?.observationScope !== 'workspace'
      || !Array.isArray(latest.targetSnapshots)
      || latest.targetSnapshots.length === 0
    ) return fact.status === 'active';
    if (targetSnapshotsStillMatch(latest.targetSnapshots, currentStatCache)) return true;
    const sourceId = `external_change_${sha256(`${fact.id}\u0000${observedAt}`).slice(0, 16)}`;
    this.emit('upsert', {
      fact: {
        ...fact,
        status: 'superseded',
        validTo: observedAt,
        invalidatedAt: observedAt,
        resolvedBy: sourceId,
        lastObservedAt: observedAt,
        revision: this.revision + 1,
      },
    });
    return false;
  }

  private resolveFailuresForTargets(targets: string[], resolvedBy: string): void {
    const normalizedTargets = new Set(targets.map(normalizeKey).filter(Boolean));
    if (normalizedTargets.size === 0) return;
    for (const fact of this.activeFactsSnapshot()) {
      if (fact.kind !== 'failure' || fact.status !== 'active') continue;
      if (!fact.targets.some(target => normalizedTargets.has(normalizeKey(target)))) continue;
      this.emit('upsert', {
        fact: {
          ...fact,
          status: 'resolved',
          resolvedBy,
          validTo: Date.now(),
          invalidatedAt: Date.now(),
          lastObservedAt: Date.now(),
          revision: this.revision + 1,
        },
      });
    }
  }

  recordAssistantResponse(
    answer: string,
    outcome: 'completed' | 'stopped' | 'failed' = 'completed',
    runId = '',
  ): void {
    const exactAnswer = String(answer ?? '').replace(/\u0000/g, '');
    if (!exactAnswer.trim()) return;
    const answerSummary = normalizeText(exactAnswer, 1_500);
    const now = Date.now();
    const stableRunId = normalizeText(runId, 220);
    const sourceId = stableRunId
      ? `assistant_${normalizeKey(stableRunId).slice(0, 120) || sha256(stableRunId).slice(0, 16)}`
      : `assistant_${sha256(`${outcome}\u0000${exactAnswer}`).slice(0, 16)}`;
    // Provider-specific completion paths and the central registry may both
    // observe the same terminal boundary. Persist it once per run.
    if (this.provenanceSourceIds.has(sourceId)) return;
    const episode = this.archiveEpisode({
      source: 'runtime',
      header: `Assistant response (${outcome})`,
      content: { outcome, runId: stableRunId || undefined, answer: exactAnswer },
      originId: stableRunId ? `assistant-run:${stableRunId}` : undefined,
      createdAt: now,
    });
    const provenance: ContextProvenance = {
      source: 'runtime', sourceId,
      observedAt: now, mutationEpoch: this.mutationEpoch, pageRef: episode.pageRef,
    };
    if (outcome !== 'completed') {
      const kind: ContextFactKind = outcome === 'failed' ? 'failure' : 'next_action';
      this.upsertFact({
        key: `${kind}:terminal:${sourceId}`,
        kind,
        text: outcome === 'failed'
          ? `Run failed and may need recovery: ${answerSummary}`
          : `Run stopped before the objective was fully settled. Resume from the exact assistant page if the user continues: ${normalizeText(exactAnswer, 1_200)}`,
        importance: 9,
        epistemic: 'observed',
        provenance,
      });
      // A stop or provider failure does not establish that retrieved context
      // was wrong. Keep the event without teaching a false failure lesson.
      this.recentRetrievedFactIds = [];
      return;
    }
    this.upsertFact({
      key: `milestone:completion:${this.mutationEpoch}`, kind: 'milestone',
      text: `Assistant reply finished at mutation epoch ${this.mutationEpoch}. Completion claims below are assistant-reported, not independent verification: ${answerSummary}`,
      importance: 9, epistemic: 'inferred', provenance,
    });
    // Finishing a reply is not evidence that its task or retrieved memories
    // were correct. Learn from specific context failures, not finality alone.
    this.recentRetrievedFactIds = [];
    for (const fact of this.activeFactsSnapshot()) {
      // Returning a final reply settles this query, not the entire root task
      // or every pending action. Those need explicit task/evidence transitions.
      if (fact.status !== 'active' || fact.kind !== 'objective' || fact.key !== 'objective:current-directive') continue;
      this.emit('upsert', {
        fact: {
          ...fact,
          status: 'resolved',
          resolvedBy: provenance.sourceId,
          validTo: now,
          invalidatedAt: now,
          lastObservedAt: now,
          revision: this.revision + 1,
        },
      });
    }
  }

  markCompleted(answer: string, runId = ''): void {
    this.recordAssistantResponse(answer, 'completed', runId);
  }

  /** An old root anchor is not evidence that the previous reply is still open. */
  hasUnsettledUserRequest(): boolean {
    return this.activeFactIdByIdentity.has(activeFactIdentity('objective', 'objective:current-directive'));
  }

  /** Ordered human source turns for task policy, excluding tool and agent inference. */
  getActiveHumanDirectives(): Array<{ id: string; text: string }> {
    return this.activeFactsSnapshot()
      .filter(fact => fact.status === 'active' && fact.kind === 'objective'
        && fact.key.startsWith('objective:directive:') && fact.epistemic === 'user_asserted'
        && fact.provenance.some(source => source.source === 'user' || source.source === 'steering'))
      .sort((a, b) => a.revision - b.revision)
      .map(fact => ({ id: fact.id, text: fact.text }));
  }

  recordContextFailure(reason: string, missingKinds: ContextFactKind[] = [], penalizeRetrievedFacts = true): void {
    const normalizedReason = normalizeText(reason, 900);
    const guideline = missingKinds.length > 0
      ? `Prior compression/retrieval failed because it omitted ${uniqueStrings(missingKinds).join(', ')} state; retain and re-check those records before the next irreversible decision.`
      : `Prior compression/retrieval failure: ${normalizedReason || 'continuity loss'}; preserve the causal inputs needed to avoid recurrence.`;
    const next = clonePolicy(this.memoryPolicy);
    next.failedOutcomes += 1;
    next.learnedGuidelines = uniqueStrings([...next.learnedGuidelines, guideline], 18);
    const affectedKinds = uniqueStrings(missingKinds, 12) as ContextFactKind[];
    if (affectedKinds.length > 0) {
      const boosts = { ...(next.kindUtilityBoosts || {}) };
      for (const kind of affectedKinds) {
        boosts[kind] = clamp01(Number(boosts[kind] || 0) + 0.12);
      }
      next.kindUtilityBoosts = boosts;
    }
    const retrieved = this.recentRetrievedFactIds
      .map(id => this.facts.get(id))
      .filter((fact): fact is ContextFact => Boolean(fact));
    if (penalizeRetrievedFacts && retrieved.length > 0) {
      const keys = Object.keys(next.weights) as Array<keyof MemoryValueFactors>;
      for (const key of keys) {
        const mean = retrieved.reduce((sum, fact) => sum + fact.valueFactors[key], 0) / retrieved.length;
        next.weights[key] = Math.max(0.15, Math.min(2.5, next.weights[key] * Math.exp(-0.01 * (mean - 0.35))));
      }
    }
    this.recentRetrievedFactIds = [];
    this.emit('policy', { memoryPolicy: next });
  }

  recordCompactionFeedback(audit: ContextCapsuleAudit, manifest: ContextContinuityManifest): void {
    if (audit.missingFactIds.length === 0) return;
    const missingSet = new Set(audit.missingFactIds);
    const kinds = uniqueStrings(
      manifest.facts.filter(fact => missingSet.has(fact.id)).map(fact => fact.kind),
      12,
    ) as ContextFactKind[];
    this.recordContextFailure(
      `Generated capsule omitted ${audit.missingFactIds.length} authoritative continuity records.`,
      kinds,
      // Compression loss is evidence about omitted kinds, not proof that the
      // last query's successfully retrieved facts were poor retrieval choices.
      false,
    );
  }

  buildContinuityManifest(): ContextContinuityManifest {
    const active = this.activeFactsSnapshot();
    const critical = active.filter(isCriticalFact);
    const latestStateByTarget = new Map<string, ContextFact>();
    for (const fact of active.filter(item => ['state', 'artifact', 'evidence'].includes(item.kind))) {
      const latestProvenance = fact.provenance[fact.provenance.length - 1];
      const key = fact.targets[0]
        ? `${fact.kind}:${normalizeKey(fact.targets[0])}`
        : `${fact.kind}:epoch:${latestProvenance?.mutationEpoch ?? this.mutationEpoch}`;
      const previous = latestStateByTarget.get(key);
      if (!previous || previous.lastObservedAt < fact.lastObservedAt) latestStateByTarget.set(key, fact);
    }
    const criticalKindPriority: Partial<Record<ContextFactKind, number>> = {
      objective: 10,
      constraint: 9,
      next_action: 8,
      failure: 7,
      decision: 6,
      preference: 5,
    };
    const ordered = Array.from(new Map(
      [...critical, ...latestStateByTarget.values()]
        .sort((a, b) =>
          b.importance - a.importance
          || Number(criticalKindPriority[b.kind] || 0) - Number(criticalKindPriority[a.kind] || 0)
          || b.lastObservedAt - a.lastObservedAt
          || b.revision - a.revision
        )
        .map(fact => [fact.id, fact]),
    ).values());
    const facts: ContextManifestFact[] = [];
    const mandatoryIds = new Set(critical.map(fact => fact.id));
    const omittedCritical: ContextFact[] = [];
    let usedChars = 0;
    for (const fact of ordered) {
      const mandatory = mandatoryIds.has(fact.id);
      if (facts.length >= MAX_MANIFEST_FACTS) {
        if (mandatory) omittedCritical.push(fact);
        continue;
      }
      const textLimit = fact.kind === 'objective'
        ? 2_400
        : fact.kind === 'constraint'
          ? 1_200
          : fact.kind === 'evidence'
            ? MAX_REUSABLE_OBSERVATION
            : 2_000;
      const manifestFact: ContextManifestFact = {
        id: fact.id,
        key: fact.key,
        revision: fact.revision,
        fingerprint: factFingerprint(fact),
        kind: fact.kind,
        status: fact.status,
        epistemic: fact.epistemic,
        text: normalizeText(fact.text, textLimit),
        exactValues: boundedValues(fact.exactValues, 1_200),
        source: sourceLabel(fact),
        importance: fact.importance,
        network: fact.network,
        validFrom: fact.validFrom,
        validTo: fact.validTo,
        pageRefs: uniqueStrings(fact.provenance.map(item => item.pageRef).filter(Boolean) as string[], 8),
      };
      const renderedLength = renderManifestFact(manifestFact).length;
      if (usedChars + renderedLength > MAX_MANIFEST_CHARS) {
        if (mandatory) omittedCritical.push(fact);
        continue;
      }
      facts.push(manifestFact);
      usedChars += renderedLength;
    }
    const omittedCriticalPageRefs = uniqueStrings(
      omittedCritical.flatMap(fact => fact.provenance.map(item => item.pageRef).filter(Boolean)),
      64,
    );
    const body = {
      version: 1 as const,
      scopeId: this.scopeId,
      revision: this.revision,
      mutationEpoch: this.mutationEpoch,
      createdAt: Date.now(),
      facts,
      ...(omittedCritical.length > 0 ? {
        omittedCriticalCount: omittedCritical.length,
        omittedCriticalPageRefs,
      } : {}),
      learnedGuidelines: [...this.memoryPolicy.learnedGuidelines],
      pageRefs: uniqueStrings([
        ...facts.flatMap(fact => fact.pageRefs),
        ...omittedCriticalPageRefs,
      ], 64),
    };
    return { ...body, manifestHash: sha256(stableSerialize(body)) };
  }

  private adaptiveWorkingSetTokenBudget(query: string, facts: Iterable<ContextFact> = this.facts.values()): number {
    let binding = 0;
    let unresolvedFailures = 0;
    let decisionLoad = 0;
    let hasFreshVerification = false;
    for (const fact of facts) {
      if (fact.status !== 'active') continue;
      if (['objective', 'constraint', 'preference'].includes(fact.kind)) binding += 1;
      if (fact.kind === 'failure') unresolvedFailures += 1;
      if (['decision', 'next_action'].includes(fact.kind)) decisionLoad += 1;
      if (
        fact.kind === 'evidence'
        && fact.provenance.some(item => item.mutationEpoch === this.mutationEpoch)
      ) hasFreshVerification = true;
    }
    const queryComplexity = Math.min(1_800, queryTerms(query).size * 45 + extractExactValues(query).length * 90);
    const verificationPressure = this.mutationEpoch > 0 && !hasFreshVerification ? 900 : 0;
    return Math.max(2_200, Math.min(9_000, Math.round(
      2_200
      + Math.min(1_800, binding * 180)
      + Math.min(1_200, unresolvedFailures * 300)
      + Math.min(900, decisionLoad * 120)
      + queryComplexity
      + verificationPressure,
    )));
  }

  private expandContinuationRetrievalQuery(query: string): string {
    const priority: Partial<Record<ContextFactKind, number>> = {
      objective: 7,
      next_action: 6,
      failure: 5,
      decision: 4,
      constraint: 3,
      artifact: 2,
      state: 1,
    };
    const anchors = boundedTop(
      this.activeFactsSnapshot().filter(fact =>
        fact.status === 'active' && Boolean(priority[fact.kind])
      ),
      12,
      (left, right) =>
        Number(priority[right.kind] || 0) - Number(priority[left.kind] || 0)
        || right.importance - left.importance
        || right.lastObservedAt - left.lastObservedAt,
    );
    if (anchors.length === 0) return query;
    return normalizeText([query, ...anchors.map(fact => [
      fact.text,
      fact.exactValues.join(' '),
      fact.targets.join(' '),
    ].filter(Boolean).join('\n'))].join('\n'), 12_000);
  }

  retrieve(
    query: string,
    tokenBudget?: number,
    options: { excludeCurrentRequestEcho?: boolean } = {},
  ): ContextRetrievalResult {
    const now = Date.now();
    const currentStatCache = new Map<string, CurrentTargetSnapshot>();
    const freshnessByFactId = new Map<string, boolean>();
    const ensureFresh = (fact: ContextFact): boolean => {
      const cached = freshnessByFactId.get(fact.id);
      if (cached !== undefined) return cached;
      const fresh = this.ensureWorkspaceObservationFresh(fact, now, currentStatCache);
      freshnessByFactId.set(fact.id, fresh);
      return fresh;
    };
    const retrievalQuery = this.expandContinuationRetrievalQuery(query);
    const terms = queryTerms(retrievalQuery);
    const normalizedQueryText = normalizeText(query);
    const normalizedQueryKey = normalizeKey(query);
    const searchableByFactId = new Map<string, string>();
    const lexicalByFactId = new Map<string, number>();
    const semanticByFactId = new Map<string, number>();
    const searchableFor = (fact: ContextFact): string => {
      let searchable = searchableByFactId.get(fact.id);
      if (searchable === undefined) {
        searchable = this.searchableFactText(fact);
        searchableByFactId.set(fact.id, searchable);
      }
      return searchable;
    };
    const lexicalFor = (fact: ContextFact): number => {
      let score = lexicalByFactId.get(fact.id);
      if (score === undefined) {
        score = relevance(searchableFor(fact), terms);
        lexicalByFactId.set(fact.id, score);
      }
      return score;
    };
    const isCurrentRequestEcho = (fact: ContextFact) => {
      if (!options.excludeCurrentRequestEcho || !['objective', 'constraint'].includes(fact.kind)) return false;
      const factText = normalizeText(fact.text);
      if (factText === normalizedQueryText) return true;
      const factKey = normalizeKey(fact.text);
      return fact.kind === 'constraint'
        && factKey.length >= 4
        && normalizedQueryKey.includes(factKey);
    };
    const queryVector = this.vectorizer.vectorize(retrievalQuery);
    const semanticFor = (fact: ContextFact): number => {
      let score = semanticByFactId.get(fact.id);
      if (score === undefined) {
        score = cosineSimilarity(queryVector, this.vectorizer.vectorize(searchableFor(fact)));
        semanticByFactId.set(fact.id, score);
      }
      return score;
    };
    const activeFacts = this.activeFactsSnapshot();
    const matchedFactIds = new Set<string>();
    // Process selective terms first. A common leading word must not consume the
    // entire bounded pool before a later file name, identifier, or exact value
    // gets a chance to contribute its historical matches.
    const queryPostings = Array.from(terms)
      .slice(0, MAX_LEXICAL_TERMS_PER_FACT)
      .map(term => ({ term, postings: this.lexicalFactIdsByTerm.get(term) }))
      .filter((entry): entry is { term: string; postings: Map<string, true> } => Boolean(entry.postings))
      .sort((left, right) => left.postings.size - right.postings.size);
    for (const { postings } of queryPostings) {
      const postingIds = Array.from(postings.keys());
      for (let index = postingIds.length - 1; index >= 0; index -= 1) {
        matchedFactIds.add(postingIds[index]);
        if (matchedFactIds.size >= MAX_LEXICAL_MATCH_POOL) break;
      }
      if (matchedFactIds.size >= MAX_LEXICAL_MATCH_POOL) break;
    }
    const queryMatchedFacts = Array.from(matchedFactIds)
      .map(id => this.facts.get(id))
      .filter((fact): fact is ContextFact => fact !== undefined && !isCurrentRequestEcho(fact));
    const recentHistoricalFacts: ContextFact[] = [];
    const recentFactIds = Array.from(this.recentFactIds.keys());
    for (let index = recentFactIds.length - 1; index >= 0; index -= 1) {
      const fact = this.facts.get(recentFactIds[index]);
      if (fact && fact.status !== 'active' && fact.importance >= 8 && !isCurrentRequestEcho(fact)) {
        recentHistoricalFacts.push(fact);
      }
    }
    const activeCriticalCandidates = boundedTop(
      activeFacts.filter(fact => isCriticalFact(fact) && !isCurrentRequestEcho(fact)),
      320,
      (left, right) => right.importance - left.importance || right.lastObservedAt - left.lastObservedAt,
    );
    const queryMatchedCandidates = boundedTop(
      queryMatchedFacts.filter(fact => lexicalFor(fact) > 0),
      240,
      (left, right) => lexicalFor(right) - lexicalFor(left) || right.lastObservedAt - left.lastObservedAt,
    );
    const recentActiveCandidates = boundedTop(
      activeFacts.filter(fact => !isCriticalFact(fact) && !isCurrentRequestEcho(fact)),
      240,
      (left, right) => right.lastObservedAt - left.lastObservedAt,
    );
    const recentHistoricalCandidates = boundedTop(
      recentHistoricalFacts,
      80,
      (left, right) => right.lastObservedAt - left.lastObservedAt,
    );
    // Semantic ranking is intentionally bounded. Exact historical records stay
    // durable and lexical-recallable, but thousands of superseded objectives
    // must not each allocate a dense vector for a one-word continuation.
    const candidates = Array.from(new Map<string, ContextFact>([
      ...activeCriticalCandidates,
      ...queryMatchedCandidates,
      ...recentActiveCandidates,
      ...recentHistoricalCandidates,
    ].map(fact => [fact.id, fact] as [string, ContextFact])).values())
      .slice(0, MAX_SEMANTIC_FACT_CANDIDATES);
    const strategyCounts: ContextRetrievalResult['strategyCounts'] = {
      lexical: 0,
      semantic: 0,
      graph: 0,
      temporal: 0,
      value: 0,
    };
    const fused = new Map<string, number>();
    const addRanking = (
      strategy: keyof ContextRetrievalResult['strategyCounts'],
      ranking: Array<{ id: string; score: number }>,
      weight = 1,
    ) => {
      const useful = ranking.filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 180);
      strategyCounts[strategy] = useful.length;
      useful.forEach((item, index) => {
        fused.set(item.id, (fused.get(item.id) || 0) + weight / (48 + index + 1));
      });
    };

    addRanking('lexical', candidates.map(fact => ({
      id: fact.id,
      score: lexicalFor(fact)
        + (normalizedQueryKey.length > 0 && normalizeKey(fact.text).includes(normalizedQueryKey) && query.trim().length > 3 ? 0.4 : 0),
    })), 1.15);
    addRanking('semantic', candidates.map(fact => ({
      id: fact.id,
      score: semanticFor(fact),
    })), 1.25);
    addRanking('temporal', candidates.map(fact => {
      const ageHours = Math.max(0, now - fact.lastObservedAt) / 3_600_000;
      return { id: fact.id, score: (fact.status === 'active' ? 0.6 : 0) + 1 / (1 + ageHours / 18) };
    }), 0.7);
    addRanking('value', candidates.map(fact => ({
      id: fact.id,
      score: memoryValue(fact.valueFactors, this.memoryPolicy.weights)
        + fact.importance / 10
        + Number(this.memoryPolicy.kindUtilityBoosts?.[fact.kind] || 0)
        + (fact.epistemic === 'observed'
          ? Number(this.memoryPolicy.kindUtilityBoosts?.[fact.kind] || 0) * 0.4
          : 0),
    })), 1.15);

    // Graph traversal starts only from query-grounded lexical/semantic hits.
    // Starting from the value or recency lists would make every small memory
    // graph a seed and erase the distinction between retrieval and expansion.
    const groundedSeeds = candidates.map(fact => ({
      id: fact.id,
      score: lexicalFor(fact) * 1.2 + semanticFor(fact),
    })).filter(item => item.score > 0.05);
    const seedIds = new Set(groundedSeeds
      .sort((a, b) => b.score - a.score)
      .slice(0, 18)
      .map(item => item.id));
    const graphScores = new Map<string, number>();
    let frontier = Array.from(seedIds).map(id => ({ id, strength: 1, depth: 0 }));
    const visited = new Set(seedIds);
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const node of frontier) {
        if (node.depth >= 2) continue;
        for (const [neighbor, edgeWeight] of this.linkAdjacency.get(node.id) || []) {
          if (!neighbor || !this.facts.has(neighbor)) continue;
          const strength = node.strength * edgeWeight * 0.72;
          graphScores.set(neighbor, Math.max(graphScores.get(neighbor) || 0, strength));
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          next.push({ id: neighbor, strength, depth: node.depth + 1 });
        }
      }
      frontier = next.slice(0, 120);
    }
    addRanking('graph', Array.from(graphScores, ([id, score]) => ({ id, score })), 1.05);

    for (const fact of candidates) {
      if (isCriticalFact(fact)) fused.set(fact.id, (fused.get(fact.id) || 0) + 0.12);
      if (fact.status === 'superseded') fused.set(fact.id, (fused.get(fact.id) || 0) - 0.015);
    }
    const ranked = Array.from(fused.entries())
      .map(([id, score]) => ({ fact: this.facts.get(id), score }))
      .filter((item): item is { fact: ContextFact; score: number } => Boolean(item.fact))
      .sort((a, b) => b.score - a.score || b.fact.lastObservedAt - a.fact.lastObservedAt);

    const selected: ContextFact[] = [];
    const selectedIds = new Set<string>();
    const resolvedTokenBudget = tokenBudget ?? this.adaptiveWorkingSetTokenBudget(query, activeFacts);
    const budgetChars = Math.max(1_200, Math.floor(resolvedTokenBudget * 4));
    let usedChars = 0;
    const mandatoryCandidates = activeFacts
      .filter(fact =>
        ['objective', 'constraint'].includes(fact.kind)
        && !isCurrentRequestEcho(fact)
      )
      .sort((a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'objective' ? -1 : 1)
        || lexicalFor(b) - lexicalFor(a)
        || b.importance - a.importance
        || b.lastObservedAt - a.lastObservedAt
      );
    const mandatory: ContextFact[] = [];
    const mandatoryIds = new Set<string>();
    let mandatoryChars = 0;
    const mandatoryCharBudget = Math.max(1_200, Math.floor(budgetChars * 0.55));
    for (const fact of mandatoryCandidates) {
      const chars = this.renderWorkingFact(fact).length + 1;
      if (mandatory.length > 0 && mandatoryChars + chars > mandatoryCharBudget) continue;
      mandatory.push(fact);
      mandatoryIds.add(fact.id);
      mandatoryChars += chars;
    }
    // Keep a small recent-file frontier in every coding continuation. Pure
    // lexical retrieval performs badly for messages such as "continue" even
    // though the last observed source is exactly what the model needs. The
    // normal character budget still bounds this list, and exact pages remain
    // available when the preview is insufficient.
    const reusableWorkspaceCandidates = boundedTop(
      activeFacts.filter(fact => {
        if (fact.kind !== 'evidence' || fact.status !== 'active') return false;
        const latest = fact.provenance[fact.provenance.length - 1];
        return latest?.observationScope === 'workspace';
      }),
      MAX_WORKSPACE_FRESHNESS_CANDIDATES,
      (a, b) => {
        const relevanceDelta = lexicalFor(b) - lexicalFor(a);
        return relevanceDelta || b.lastObservedAt - a.lastObservedAt;
      },
    );
    const reusableWorkspaceObservations: ContextFact[] = [];
    for (const fact of reusableWorkspaceCandidates) {
      if (!ensureFresh(fact)) continue;
      reusableWorkspaceObservations.push(fact);
      if (reusableWorkspaceObservations.length >= 5) break;
    }
    for (const fact of [...mandatory, ...reusableWorkspaceObservations, ...ranked.map(item => item.fact)]) {
      if (selectedIds.has(fact.id)) continue;
      if (!ensureFresh(fact)) continue;
      const chars = this.renderWorkingFact(fact).length + 1;
      const isMandatory = mandatoryIds.has(fact.id);
      if (!isMandatory && selected.length > 0 && usedChars + chars > budgetChars * 0.82) continue;
      selected.push(fact);
      selectedIds.add(fact.id);
      usedChars += chars;
      if (usedChars >= budgetChars * 0.82 && !isMandatory) break;
    }

    const selectedPageRefs = new Set(selected.flatMap(fact =>
      fact.provenance.map(item => item.pageRef).filter(Boolean) as string[]
    ));
    const episodeCandidates = boundedTop(
      Array.from(this.recentEpisodeIds.keys())
        .map(id => this.episodes.get(id))
        .filter((episode): episode is ContextEpisode => Boolean(episode)),
      MAX_RECENT_EPISODE_CANDIDATES,
      (left, right) => right.createdAt - left.createdAt,
    )
      .map(episode => {
        const searchable = this.searchableEpisodeText(episode);
        const lexical = relevance(searchable, terms);
        const semantic = cosineSimilarity(queryVector, this.vectorizer.vectorize(searchable));
        const referenced = selectedPageRefs.has(episode.pageRef);
        const ageHours = Math.max(0, now - episode.createdAt) / 3_600_000;
        return { episode, score: lexical * 1.3 + semantic + (referenced ? 1.5 : 0) + 0.2 / (1 + ageHours / 24) };
      })
      .filter(item => item.score > 0.12)
      .sort((a, b) => b.score - a.score);
    const episodes: ContextEpisode[] = [];
    for (const { episode } of episodeCandidates) {
      const chars = this.renderEpisodePointer(episode).length + 1;
      if (usedChars + chars > budgetChars) continue;
      episodes.push(episode);
      usedChars += chars;
      if (episodes.length >= 16) break;
    }

    this.recentRetrievedFactIds = uniqueStrings(
      [...this.recentRetrievedFactIds, ...selected.map(fact => fact.id)],
      160,
    );
    for (const fact of selected) {
      fact.retrievalCount += 1;
      fact.valueFactors.usageHistory = clamp01(fact.retrievalCount / (fact.retrievalCount + 5));
    }
    return {
      facts: selected.map(normalizeStoredFact),
      episodes: episodes.map(cloneEpisode),
      strategyCounts,
      estimatedTokens: Math.ceil(usedChars / 4),
      omittedActiveCritical: Math.max(0, mandatoryCandidates.length - mandatory.length),
    };
  }

  search(query: string, tokenBudget?: number): ContextRetrievalResult {
    return this.retrieve(query, tokenBudget);
  }

  compileWorkingSet(query: string, maxChars?: number): string {
    const normalizedQuery = normalizeText(query, 12_000);
    const boundedMaxChars = typeof maxChars === 'number'
      ? Math.floor(Math.min(MAX_WORKING_SET_CHARS * 2, maxChars))
      : 0;
    const cacheKey = sha256(`${normalizedQuery}\u0000${boundedMaxChars || 'adaptive'}`);
    const cached = this.compiledWorkingSetCache.get(cacheKey);
    if (
      cached
      && cached.revision === this.revision
      && cached.mutationEpoch === this.mutationEpoch
    ) {
      const observedAt = Date.now();
      const currentStatCache = new Map<string, CurrentTargetSnapshot>();
      let allSelectedWorkspaceFactsFresh = true;
      for (const factId of cached.workspaceFactIds) {
        const fact = this.facts.get(factId);
        if (!fact || !this.ensureWorkspaceObservationFresh(fact, observedAt, currentStatCache)) {
          allSelectedWorkspaceFactsFresh = false;
          break;
        }
      }
      if (allSelectedWorkspaceFactsFresh && cached.revision === this.revision) {
        // LRU touch. The exact same prompt state should not redo lexical,
        // semantic, temporal, graph, and value fusion on every provider loop.
        this.compiledWorkingSetCache.delete(cacheKey);
        this.compiledWorkingSetCache.set(cacheKey, cached);
        return cached.value;
      }
      this.compiledWorkingSetCache.delete(cacheKey);
    }
    const result = this.retrieve(
      query,
      boundedMaxChars > 0 ? Math.floor(boundedMaxChars / 4) : undefined,
      { excludeCurrentRequestEcho: true },
    );
    const value = result.facts.length === 0 && result.episodes.length === 0
      ? ''
      : [
          '[CONTEXT FABRIC - TEMPORAL EPISTEMIC WORKING SET]',
          `scope=${this.scopeId} revision=${this.revision} mutation_epoch=${this.mutationEpoch} active_critical=${this.activeFactsSnapshot().filter(isCriticalFact).length} estimated_tokens=${result.estimatedTokens}`,
          `retrieval=lexical:${result.strategyCounts.lexical},semantic:${result.strategyCounts.semantic},graph:${result.strategyCounts.graph},temporal:${result.strategyCounts.temporal},learned_value:${result.strategyCounts.value}`,
          'Interpret these source records with the current human request. Active means stored, not necessarily still applicable. Later human corrections replace earlier choices in the same scope; preserve compatible requirements. A root objective is a task anchor, not proof of unfinished work. Extracted clauses can include quotations or examples: use their source context. A fresh workspace observation should be reused; open its page only when omitted detail matters.',
          ...(result.omittedActiveCritical > 0
            ? [`binding_frontier=${result.facts.filter(fact => isCriticalFact(fact)).length} selected; ${result.omittedActiveCritical} lower-ranked active binding records remain durable and are available through context_memory search.`]
            : []),
          ...result.facts.map(fact => this.renderWorkingFact(fact)),
          ...(result.episodes.length > 0 ? ['## Exact source pages (open only when decision-relevant)', ...result.episodes.map(episode => this.renderEpisodePointer(episode))] : []),
          '[END CONTEXT FABRIC]',
        ].join('\n');
    this.compiledWorkingSetCache.set(cacheKey, {
      revision: this.revision,
      mutationEpoch: this.mutationEpoch,
      value,
      workspaceFactIds: result.facts.filter(fact => {
        const latest = fact.provenance[fact.provenance.length - 1];
        return fact.status === 'active' && latest?.observationScope === 'workspace';
      }).map(fact => fact.id),
    });
    while (this.compiledWorkingSetCache.size > MAX_COMPILED_WORKING_SET_CACHE) {
      const oldest = this.compiledWorkingSetCache.keys().next().value;
      if (!oldest) break;
      this.compiledWorkingSetCache.delete(oldest);
    }
    return value;
  }

  private renderWorkingFact(fact: ContextFact): string {
    const exactValues = renderBoundedValues(fact.exactValues, 1_200);
    const exact = exactValues ? ` | exact=${exactValues}` : '';
    const pages = uniqueStrings(fact.provenance.map(item => item.pageRef).filter(Boolean) as string[], 4);
    const pageText = pages.length > 0 ? ` | pages=${pages.join(',')}` : '';
    const validity = `${new Date(fact.validFrom).toISOString()}${fact.validTo ? `..${new Date(fact.validTo).toISOString()}` : '..present'}`;
    const latest = fact.provenance[fact.provenance.length - 1];
    const workspaceObservation = latest?.observationScope === 'workspace';
    const freshness = workspaceObservation
      ? fact.status === 'active'
        ? '; freshness=fresh-until-overlapping-mutation; reuse=yes'
        : '; freshness=stale-after-mutation; reuse=no'
      : '';
    const resultIdentity = workspaceObservation && latest?.resultHash
      ? ` | result_sha256=${latest.resultHash}`
      : '';
    const textLimit = fact.kind === 'objective'
      ? 2_400
      : fact.kind === 'constraint'
        ? 1_200
        : fact.kind === 'evidence'
          ? MAX_REUSABLE_OBSERVATION
          : 2_000;
    const renderedText = normalizeText(fact.text, textLimit);
    return `- [ctx:${fact.id}; ${fact.network}/${fact.kind}; ${fact.status}; ${fact.epistemic}; valid=${validity}; revision=${fact.revision}; source=${sourceLabel(fact)}${instructionRecordRole(fact.key)}${freshness}] ${renderedText}${exact}${resultIdentity}${pageText}`;
  }

  private renderEpisodePointer(episode: ContextEpisode): string {
    return `- [page:${episode.pageRef}; sha256:${episode.contentHash}; source=${episode.source}${episode.toolName ? `:${episode.toolName}` : ''}] ${episode.header} :: ${episode.contentPreview}`;
  }

  remember(input: {
    text: string;
    kind?: ContextFactKind;
    key?: string;
    importance?: number;
    epistemic?: ContextEpistemicStatus;
    targets?: string[];
    sourceId?: string;
  }): ContextFact {
    const text = normalizeText(input.text);
    if (!text) throw new Error('Memory text is required.');
    const kind = input.kind || 'reference';
    const epistemic = input.epistemic || 'inferred';
    const sourceId = input.sourceId || `memory_${sha256(text).slice(0, 14)}`;
    const episode = this.archiveEpisode({
      source: 'runtime',
      header: `Explicit memory (${kind}/${epistemic})`,
      content: input,
      targets: input.targets,
    });
    return this.upsertFact({
      key: input.key || `${kind}:${normalizeKey(text).slice(0, 220) || sha256(text).slice(0, 16)}`,
      kind,
      text,
      importance: input.importance ?? 7,
      epistemic,
      targets: input.targets,
      provenance: {
        source: 'runtime',
        sourceId,
        observedAt: Date.now(),
        mutationEpoch: this.mutationEpoch,
        pageRef: episode.pageRef,
      },
    });
  }

  invalidateFact(factId: string, reason: string): ContextFact {
    const existing = this.facts.get(factId);
    if (!existing) throw new Error(`Unknown context fact: ${factId}`);
    if (existing.status !== 'active') return normalizeStoredFact(existing);
    const now = Date.now();
    const invalidationProvenance: ContextProvenance = {
      source: 'runtime',
      sourceId: `invalidate_${sha256(reason).slice(0, 14)}`,
      observedAt: now,
      mutationEpoch: this.mutationEpoch,
    };
    const invalidated: ContextFact = {
      ...existing,
      status: 'resolved',
      validTo: now,
      invalidatedAt: now,
      resolvedBy: `manual_${sha256(reason).slice(0, 14)}`,
      lastObservedAt: now,
      revision: this.revision + 1,
      provenance: [...existing.provenance, invalidationProvenance].slice(-MAX_PROVENANCE_PER_FACT),
    };
    this.emit('upsert', { fact: invalidated });
    return normalizeStoredFact(invalidated);
  }

  getMemoryPolicy(): MemoryPolicyState {
    return clonePolicy(this.memoryPolicy);
  }

  recordCompactionCheckpoint(compactionId: string, manifestHash: string, capsule: string): void {
    if (!/^[A-Za-z0-9_-]{1,220}$/.test(compactionId) || !/^[0-9a-f]{64}$/i.test(manifestHash)) {
      throw new Error('Invalid Context Fabric compaction checkpoint identity.');
    }
    this.emit('checkpoint', {
      checkpoint: { compactionId, manifestHash, capsuleHash: sha256(capsule) },
    });
  }

  getLatestCompactionCheckpoint(): ContextCompactionCheckpoint | null {
    return this.latestCompactionCheckpoint
      ? { ...this.latestCompactionCheckpoint }
      : null;
  }

  getRevision(): number {
    return this.revision;
  }

  listFacts(): ContextFact[] {
    return Array.from(this.facts.values()).map(normalizeStoredFact);
  }

  hasFactKind(kind: ContextFactKind): boolean {
    return this.factKindsPresent.has(kind);
  }

  hasActiveFactKind(kind: ContextFactKind): boolean {
    for (const factId of this.activeFactIdByIdentity.values()) {
      const fact = this.facts.get(factId);
      if (fact?.kind === kind && fact.status === 'active') return true;
    }
    return false;
  }

  listEpisodes(): ContextEpisode[] {
    return Array.from(this.episodes.values()).map(cloneEpisode);
  }

  listLinks(): ContextLink[] {
    return Array.from(this.links.values()).map(link => ({ ...link }));
  }

  snapshot(): ContextFabricSnapshot {
    const snapshot: ContextFabricSnapshot = {
      version: 1,
      scopeId: this.scopeId,
      revision: this.revision,
      mutationEpoch: this.mutationEpoch,
      lastEventHash: this.lastEventHash,
      eventHashVersion: 2,
      ...(this.replaySafe ? { replaySafe: true as const } : {}),
      ...(this.legacyEventPrefixSequence > 0 && this.legacyEventPrefixHash
        ? {
            legacyEventPrefix: {
              sequence: this.legacyEventPrefixSequence,
              hash: this.legacyEventPrefixHash,
            },
          }
        : {}),
      facts: this.listFacts(),
      episodes: this.listEpisodes(),
      links: this.listLinks(),
      memoryPolicy: this.getMemoryPolicy(),
      ...(this.latestCompactionCheckpoint
        ? { latestCompactionCheckpoint: { ...this.latestCompactionCheckpoint } }
        : {}),
      ...(!this.durable ? { ephemeralPageContents: Object.fromEntries(this.ephemeralPages) } : {}),
    };
    return { ...snapshot, snapshotHash: calculateSnapshotHash(snapshot) };
  }

  restore(snapshot: ContextFabricSnapshot): void {
    if (snapshot.version !== 1 || snapshot.scopeId !== this.scopeId) return;
    const snapshotRevision = Number(snapshot.revision);
    if (!Number.isFinite(snapshotRevision) || snapshotRevision < 0 || snapshotRevision < this.revision) return;
    this.revision = Math.floor(snapshotRevision);
    this.mutationEpoch = Number.isFinite(Number(snapshot.mutationEpoch))
      ? Math.max(0, Math.floor(Number(snapshot.mutationEpoch)))
      : 0;
    this.lastEventHash = /^[0-9a-f]{64}$/i.test(String(snapshot.lastEventHash || ''))
      ? String(snapshot.lastEventHash)
      : '';
    this.legacyEventPrefixSequence = Math.max(
      0,
      Math.floor(Number(snapshot.legacyEventPrefix?.sequence || 0)),
    );
    this.legacyEventPrefixHash = this.legacyEventPrefixSequence > 0
      ? String(snapshot.legacyEventPrefix?.hash || '')
      : '';
    this.replaySafe = snapshot.replaySafe === true;
    this.lastSnapshotRevision = Math.floor(snapshotRevision);
    const snapshotFacts = Array.isArray(snapshot.facts)
      ? snapshot.facts.filter(isStoredFactShape)
      : [];
    const snapshotEpisodes = Array.isArray(snapshot.episodes)
      ? snapshot.episodes.filter(isStoredEpisodeShape)
      : [];
    const snapshotLinks = Array.isArray(snapshot.links)
      ? snapshot.links.filter(link => isRecord(link) && typeof link.id === 'string')
      : [];
    this.facts = new Map(snapshotFacts.map(fact => [fact.id, normalizeStoredFact(fact)]));
    this.rebuildFactIndexes();
    this.episodes = new Map(snapshotEpisodes.map(episode => [episode.id, cloneEpisode(episode)]));
    this.episodeIdByOrigin = new Map(snapshotEpisodes
      .filter(episode => Boolean(episode.originId))
      .map(episode => [episode.originId!, episode.id] as [string, string]));
    this.episodeIdByPageRef = new Map(snapshotEpisodes.map(episode => [episode.pageRef, episode.id]));
    this.recentEpisodeIds = new Map(snapshotEpisodes
      .sort((left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence)
      .slice(-MAX_RECENT_EPISODE_INDEX)
      .map(episode => [episode.id, true] as [string, true]));
    this.links = new Map(snapshotLinks.map(link => [link.id, { ...link } as ContextLink]));
    this.rebuildLinkAdjacency();
    this.ephemeralPages = new Map(
      isRecord(snapshot.ephemeralPageContents)
        ? Object.entries(snapshot.ephemeralPageContents).filter(([, content]) => typeof content === 'string') as Array<[string, string]>
        : [],
    );
    const checkpoint = snapshot.latestCompactionCheckpoint;
    this.latestCompactionCheckpoint = checkpoint
      && /^[A-Za-z0-9_-]{1,220}$/.test(String(checkpoint.compactionId || ''))
      && /^[0-9a-f]{64}$/i.test(String(checkpoint.manifestHash || ''))
      && /^[0-9a-f]{64}$/i.test(String(checkpoint.capsuleHash || ''))
      && Number.isFinite(Number(checkpoint.recordedAt))
      && Number.isFinite(Number(checkpoint.sequence))
      && Number(checkpoint.sequence) <= snapshotRevision
        ? {
            compactionId: checkpoint.compactionId,
            manifestHash: checkpoint.manifestHash,
            capsuleHash: checkpoint.capsuleHash,
            recordedAt: Math.max(0, Math.floor(Number(checkpoint.recordedAt))),
            sequence: Math.max(0, Math.floor(Number(checkpoint.sequence))),
          }
        : null;
    if (
      isRecord(snapshot.memoryPolicy)
      && isRecord(snapshot.memoryPolicy.weights)
      && Array.isArray(snapshot.memoryPolicy.learnedGuidelines)
    ) {
      this.memoryPolicy = clonePolicy({
        ...this.memoryPolicy,
        ...snapshot.memoryPolicy,
        weights: { ...DEFAULT_MEMORY_WEIGHTS, ...(snapshot.memoryPolicy.weights || {}) },
        learnedGuidelines: snapshot.memoryPolicy.learnedGuidelines || this.memoryPolicy.learnedGuidelines,
      });
    }
    this.rebuildVectorizer();
  }

  /** Commit append-only events without serializing the full materialized graph. */
  async flushLedger(): Promise<void> {
    if (!this.durable) return;
    await this.flushPersistenceOperations();
  }

  /** Commit exact events; acceleration checkpoints are independently debounced. */
  async flush(): Promise<void> {
    if (!this.durable) return;
    await this.flushPersistenceOperations();
    // Terminal correctness depends only on the append-only ledger. A complete
    // snapshot is intentionally deferred and debounced; eagerly rebuilding it
    // here made every completed turn O(total chat history).
    this.scheduleSnapshot();
    await this.snapshotWriteQueue;
  }

  private async persistSnapshotCheckpoint(): Promise<void> {
    if (!this.durable) return;
    const writeSnapshot = async () => {
      // Serialize capture as well as the write. Otherwise two overlapping
      // checkpoints could capture revisions in one order and finish in another,
      // allowing an older acceleration snapshot to overwrite a newer one.
      await this.flushPersistenceOperations();
      if (!this.replaySafe || this.lastSnapshotRevision >= this.revision) return;
      const snapshot = this.snapshot();
      await fs.ensureDir(this.scopeDir);
      let lastSnapshotError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const temporary = path.join(this.scopeDir, `.snapshot.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
        try {
          await fs.writeJson(temporary, snapshot, { spaces: 2 });
          await fs.move(temporary, this.snapshotPath, { overwrite: true });
          this.lastSnapshotRevision = snapshot.revision;
          return;
        } catch (error) {
          lastSnapshotError = error;
          await fs.remove(temporary).catch(() => undefined);
        }
      }
      throw (lastSnapshotError instanceof Error
        ? lastSnapshotError
        : new Error(`Context Fabric snapshot persistence failed: ${String(lastSnapshotError || 'unknown error')}`));
    };
    const queuedWrite = this.snapshotWriteQueue.then(writeSnapshot, writeSnapshot);
    this.snapshotWriteQueue = queuedWrite.catch(() => undefined);
    await queuedWrite;
  }
}

type ContextFabricReference = { deref: () => ContextFabric | undefined };
const WeakContextFabricReference = (globalThis as any).WeakRef as
  | (new (value: ContextFabric) => ContextFabricReference)
  | undefined;
const activeFabrics = new Map<string, ContextFabricReference>();
const ephemeralFabrics = new Map<string, ContextFabricReference>();
const recentFabrics = new Map<string, ContextFabric>();
const MAX_STRONGLY_RETAINED_FABRICS = 24;

const retainContextFabricWeakly = (fabric: ContextFabric): ContextFabricReference =>
  WeakContextFabricReference
    ? new WeakContextFabricReference(fabric)
    // WeakRef exists in every supported desktop runtime. Keep a compatibility
    // holder for unusual embedders rather than making context unavailable.
    : { deref: () => fabric };

const touchRecentContextFabric = (scopeId: string, fabric: ContextFabric): void => {
  recentFabrics.delete(scopeId);
  recentFabrics.set(scopeId, fabric);
  while (recentFabrics.size > MAX_STRONGLY_RETAINED_FABRICS) {
    const oldestScopeId = recentFabrics.keys().next().value;
    if (!oldestScopeId) break;
    recentFabrics.delete(oldestScopeId);
  }
  // Weak-map keys themselves are strong. Opportunistically remove dead keys
  // after many distinct chats without paying this scan on ordinary turns.
  if (activeFabrics.size > MAX_STRONGLY_RETAINED_FABRICS * 8) {
    for (const [candidateScopeId, reference] of activeFabrics) {
      if (!reference.deref()) activeFabrics.delete(candidateScopeId);
    }
  }
};

export async function getContextFabricForChat(
  scopeId: string,
  options: ContextFabricOptions = {},
): Promise<ContextFabric> {
  if (options.durable === false) {
    let ephemeral = ephemeralFabrics.get(scopeId)?.deref();
    let createdEphemeral = false;
    if (!ephemeral) {
      ephemeral = new ContextFabric(scopeId, options);
      ephemeralFabrics.set(scopeId, retainContextFabricWeakly(ephemeral));
      createdEphemeral = true;
    }
    try {
      await ephemeral.initialize();
      return ephemeral;
    } catch (error) {
      if (createdEphemeral && ephemeralFabrics.get(scopeId)?.deref() === ephemeral) {
        ephemeralFabrics.delete(scopeId);
      }
      throw error;
    }
  }
  let fabric = activeFabrics.get(scopeId)?.deref();
  let createdForThisRequest = false;
  if (!fabric) {
    fabric = new ContextFabric(scopeId, options);
    activeFabrics.set(scopeId, retainContextFabricWeakly(fabric));
    createdForThisRequest = true;
  }
  touchRecentContextFabric(scopeId, fabric);
  // An existing live fabric already contains the newest admitted events.
  // Reapplying a survivor snapshot here could replace same-revision state or
  // move it onto an uncommitted hash. Snapshots are construction-time seeds;
  // the live instance and its serialized persist queue remain authoritative.
  try {
    await fabric.initialize();
    if (!createdForThisRequest) await fabric.refreshDurableState();
    return fabric;
  } catch (error) {
    // A failed first hydration can leave partially reconstructed in-memory
    // state. Never pin that instance to the chat indefinitely: every caller
    // sharing the same initialization promise observes the same failure, and
    // the next request gets a clean reconstruction from durable storage.
    if (createdForThisRequest) {
      if (activeFabrics.get(scopeId)?.deref() === fabric) activeFabrics.delete(scopeId);
      if (recentFabrics.get(scopeId) === fabric) recentFabrics.delete(scopeId);
    } else {
      // A refresh failure can be caused by a transient lock/filter-driver
      // interruption or a recoverable durable-ledger problem. Keep the last
      // fully materialized instance strongly reachable; never turn a failed
      // freshness check into in-memory context erasure.
      touchRecentContextFabric(scopeId, fabric);
    }
    throw error;
  }
}
