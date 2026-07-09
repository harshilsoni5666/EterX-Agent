/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX-SYNAPSE — SynapseGraph Core Engine v2
 * ═══════════════════════════════════════════════════════════════
 *
 * Next-generation implementation based on PCCA §4.1, §4.5, §4.6.
 *
 * This is an ASSISTIVE CONTINUITY LAYER inside the existing agent
 * harness. It does NOT modify model weights, tool permissions, or
 * safety constraints. It organizes harness-visible records into a
 * decision surface for context selection.
 *
 * Storage Architecture (§4.5):
 *   Every harness-visible object is stored as FOUR linked records:
 *     1. SourceRecord  — The original object (turn, tool result, file, patch)
 *     2. VersionRecord — Hash, creation turn, version chain, supersession
 *     3. StateRecord   — Lifecycle: proposed→applied→validated→superseded
 *     4. ConfidenceRecord — Score, validation state, injection reason
 *
 * Decision Surface (§4.6):
 *   Per turn, five questions are evaluated:
 *     Q1: What is the active task?
 *     Q2: Which records are semantically close?
 *     Q3: Which records are fresh (latest valid version)?
 *     Q4: Which records have enough confidence?
 *     Q5: Which records fit the token budget?
 *
 * Performance target: <2ms per processTurn() call.
 */

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

import {
  DivergenceEngine,
  TfIdfVectorizer,
  cosineSimilarity,
  type SynapseState,
} from './divergence';
import { CentroidEngine, type CentroidState } from './centroid';
import {
  InjectionPolicyEngine,
  type InjectionPayload,
  type RegisteredInput,
  type ArchivedNodeSummary,
} from './injection-policy';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYNAPSE_DIR = path.resolve(process.cwd(), '.workspaces', '.synapse');
const EDGE_GROWTH_BETA = 0.15;
const EDGE_DECAY_GAMMA = 0.95;
const EDGE_PRUNE_THRESHOLD = 0.10;
const EDGE_STALE_TURNS = 20;
const L2_SCAN_LIMIT = 50;
const REACTIVATION_THETA = 0.40;
const REACTIVATION_MIN_CONFIDENCE = 0.50;
const MAX_L2_NODES = 100;
const MAX_RECENT_MESSAGES = 5;
const PERSIST_DEBOUNCE_MS = 3000;
const MAX_RECORDS = 500;
const MAX_PATCH_CHAIN = 30;

// ─── Structured Record Types (§4.5) ──────────────────────────────────────────

/** Source types the harness can expose to SynapseGraph. */
export type SourceType =
  | 'user_turn'
  | 'tool_result'
  | 'file_snapshot'
  | 'file_patch'
  | 'search_result'
  | 'generated_draft'
  | 'code_patch'
  | 'batch_update'
  | 'validated_completion'
  | 'system_rule'
  | 'project_goal';

/** Lifecycle states for any record (§4.5 point 3). */
export type RecordState =
  | 'proposed'
  | 'required'
  | 'applied'
  | 'rejected'
  | 'superseded'
  | 'reverted'
  | 'validated';

/**
 * A SourceRecord: the original object exposed by the harness (§4.5 point 1).
 */
export interface SourceRecord {
  /** Stable unique identifier. */
  id: string;

  /** What kind of harness object this is. */
  sourceType: SourceType;

  /** Injection tier: 1=system rules, 2=session state, 3=working context. */
  tier: 1 | 2 | 3;

  /** The actual content (capped for memory safety). */
  content: string;

  /** Turn this record was created at. */
  createdAtTurn: number;

  /** Timestamp of creation. */
  createdAt: number;

  /** Tool name that produced this (if sourceType is 'tool_result'). */
  toolName?: string;

  /** File path (if sourceType is 'file_snapshot', 'file_patch', 'code_patch'). */
  filePath?: string;

  /** Tags for keyword matching. */
  tags: string[];
}

/**
 * A VersionRecord: tracks hash, version chain, supersession (§4.5 point 2).
 */
export interface VersionRecord {
  /** ID of the SourceRecord this version belongs to. */
  sourceId: string;

  /** SHA-256 hash of the content (first 16 chars). */
  sourceHash: string;

  /** Turn this version was created at. */
  creationTurn: number;

  /** ID of the previous version (null if first). */
  previousVersionId: string | null;

  /** ID of the newest version (self if latest). */
  newestVersionId: string;

  /** Whether this version has been superseded. */
  isSuperseded: boolean;

  /** Turn it was superseded at (null if still current). */
  supersededAtTurn: number | null;
}

/**
 * A StateRecord: lifecycle tracking (§4.5 point 3).
 */
export interface StateRecord {
  /** ID of the SourceRecord. */
  sourceId: string;

  /** Current lifecycle state. */
  state: RecordState;

  /** Turn the state last changed. */
  changedAtTurn: number;

  /** Who changed it (system, user, tool). */
  changedBy: string;
}

/**
 * A ConfidenceRecord: injection worthiness (§4.5 point 4).
 */
export interface ConfidenceRecord {
  /** ID of the SourceRecord. */
  sourceId: string;

  /** Confidence score [0, 1]. */
  confidence: number;

  /** Has this been validated by a subsequent action? */
  validated: boolean;

  /** Why this record may be useful for the next model call. */
  injectionReason: string;

  /** Last turn this record was included in an injection payload. */
  lastInjectedTurn: number;

  /** How many times this has been injected. */
  injectionCount: number;
}

/**
 * A PatchRecord: code edit chain tracking (§4.5 coding sessions).
 */
export interface PatchRecord {
  /** ID of the associated SourceRecord. */
  sourceId: string;

  /** Affected file path. */
  filePath: string;

  /** Hash of file before patch. */
  previousHash: string;

  /** Hash of file after patch. */
  newHash: string;

  /** Short diff summary. */
  diffSummary: string;

  /** Why this patch was applied. */
  rationale: string;

  /** IDs of patches this depends on. */
  dependsOn: string[];

  /** Whether patch has been applied. */
  applied: boolean;

  /** Whether patch has been reverted. */
  reverted: boolean;

  /** Turn applied at. */
  appliedAtTurn: number;
}

export interface RecordLink {
  targetId: string;
  relationType: 'parent' | 'child' | 'patch_of' | 'tool_result_of' | 'caused_by' | 'semantic_ref';
}

/**
 * A unified structured record combining all four record types.
 * Stored as a single object for O(1) lookup performance.
 */
export interface StructuredRecord {
  source: SourceRecord;
  version: VersionRecord;
  state: StateRecord;
  confidence: ConfidenceRecord;
  patch?: PatchRecord;
  links?: RecordLink[];
}

// ─── Cognitive Node ───────────────────────────────────────────────────────────

export interface CognitiveNode {
  nodeId: string;
  topicSummary: string;
  centroidState: CentroidState;
  turnCount: number;
  verifiedCompletions: string[];
  createdAt: number;
  archivedAt?: number;
  lastActiveTurn: number;
  /** IDs of records associated with this node. */
  recordIds: string[];
}

interface SynapseEdge {
  fromNodeId: string;
  toNodeId: string;
  weight: number;
  lastTraversedTurn: number;
  traversalCount: number;
  createdAt: number;
}

// ─── Decision Surface Result (§4.6) ──────────────────────────────────────────

interface DecisionSurface {
  /** Q1: Active task summary. */
  activeTask: string;
  /** Q2: Records semantically close to query. */
  semanticMatches: StructuredRecord[];
  /** Q3: Records that are fresh (latest valid version). */
  freshRecords: StructuredRecord[];
  /** Q4: Records with sufficient confidence. */
  confidentRecords: StructuredRecord[];
  /** Q5: Records that fit token budget. */
  budgetFitting: StructuredRecord[];
  /** The final ranked set after all 5 filters. */
  finalSet: StructuredRecord[];
}

// ─── Graph State ──────────────────────────────────────────────────────────────

interface GraphState {
  activeNodeId: string | null;
  l1Nodes: Map<string, CognitiveNode>;
  l2Nodes: Map<string, CognitiveNode>;
  edges: Map<string, SynapseEdge>;
  /** The structured record store (§4.5). */
  records: Map<string, StructuredRecord>;
  /** Version chains: sourceHash → latest sourceId. */
  latestVersionIndex: Map<string, string>;
  /** Patch chains per file: filePath → ordered sourceId[]. */
  patchChains: Map<string, string[]>;
  recentUserMessages: string[];
  turnCount: number;
  chatId: string;
  projectId: string;
}

// ─── ProcessTurn Result ───────────────────────────────────────────────────────

export interface ProcessTurnResult {
  payload: InjectionPayload;
  renderedContext: string;
  state: SynapseState;
  omega: number;
  confidence: number;
  topicTransition: boolean;
  topicReactivated: boolean;
  reactivatedNodeId?: string;
  /** Performance: ms taken by processTurn. */
  processingTimeMs: number;
  /** Decision surface debug info. */
  decisionSurface: {
    semanticMatchCount: number;
    freshCount: number;
    confidentCount: number;
    budgetFitCount: number;
    finalCount: number;
    totalRecords: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().substring(0, 12)}`;
}

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}

function edgeKey(a: string, b: string): string {
  return `${a}→${b}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.tmp`);
  await fs.writeJson(tmp, data);
  await fs.move(tmp, filePath, { overwrite: true });
}

// ─── Main Class ───────────────────────────────────────────────────────────────

export class SynapseGraph {
  private divergenceEngine: DivergenceEngine;
  private centroidEngine: CentroidEngine;
  private injectionEngine: InjectionPolicyEngine;
  private vectorizer: TfIdfVectorizer;
  private state: GraphState;
  private initialized = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistPending = false;
  private graphFilePath: string | null = null;

  constructor() {
    this.divergenceEngine = new DivergenceEngine();
    this.centroidEngine = new CentroidEngine();
    this.injectionEngine = new InjectionPolicyEngine();
    this.vectorizer = new TfIdfVectorizer();
    this.state = this.emptyState('', '');
  }

  private emptyState(chatId: string, projectId: string): GraphState {
    return {
      activeNodeId: null,
      l1Nodes: new Map(),
      l2Nodes: new Map(),
      edges: new Map(),
      records: new Map(),
      latestVersionIndex: new Map(),
      patchChains: new Map(),
      recentUserMessages: [],
      turnCount: 0,
      chatId,
      projectId,
    };
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  public async initialize(chatId: string, projectId: string): Promise<void> {
    if (this.initialized && this.state.chatId === chatId) return;

    this.state.chatId = chatId;
    this.state.projectId = projectId;
    const sanitized = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.graphFilePath = path.join(SYNAPSE_DIR, sanitized, 'graph.json');
    await fs.ensureDir(path.join(SYNAPSE_DIR, sanitized));

    if (await fs.pathExists(this.graphFilePath)) {
      try {
        const raw = await fs.readJson(this.graphFilePath);
        this.importState(raw);
        console.log(
          `[SynapseGraph] 🧠 Loaded: ${this.state.records.size} records, ` +
          `${this.state.l1Nodes.size} L1, ${this.state.l2Nodes.size} L2, ` +
          `${this.state.edges.size} edges, ${this.state.patchChains.size} patch chains, turn ${this.state.turnCount}`,
        );
      } catch (err: any) {
        console.warn(`[SynapseGraph] ⚠️ Load failed: ${err.message}. Fresh start.`);
        this.state = this.emptyState(chatId, projectId);
      }
    }

    this.initialized = true;
  }

  // ── Core Turn Processing ────────────────────────────────────────────────────

  /**
   * Process a user turn through the full PCCA pipeline.
   *
   * Pipeline (all synchronous, target <2ms):
   *   1. Vectorize query
   *   2. Store as structured record (source + version + state + confidence)
   *   3. Evaluate divergence against active centroid
   *   4. Handle state transitions (create/archive/reactivate nodes)
   *   5. Update centroid
   *   6. Run 5-question decision surface (§4.6)
   *   7. Build injection payload from decision surface
   *   8. Decay topology
   *   9. Schedule persistence
   */
  public processTurn(query: string): ProcessTurnResult {
    const t0 = performance.now();
    this.state.turnCount++;
    const turn = this.state.turnCount;

    if (turn % 15 === 0) {
      this.coalesceL2Nodes();
    }

    // Track recent messages for grounding check
    this.state.recentUserMessages.push(query);
    if (this.state.recentUserMessages.length > MAX_RECENT_MESSAGES) {
      this.state.recentUserMessages = this.state.recentUserMessages.slice(-MAX_RECENT_MESSAGES);
    }

    // Step 1: Vectorize
    this.vectorizer.addDocument(query);
    const queryVector = this.vectorizer.vectorize(query);

    // Step 2: Store as structured record
    this.storeRecord({
      content: query,
      sourceType: 'user_turn',
      tier: 3,
      turn,
      tags: this.extractTags(query),
    });

    // Step 3-4: Handle first turn or divergence
    let topicTransition = false;
    let topicReactivated = false;
    let reactivatedNodeId: string | undefined;
    let divergenceState: SynapseState = 'Warmup';
    let omega = 0;
    let confidence = 0;

    if (!this.state.activeNodeId || !this.getActiveNode()) {
      // First turn — create initial node
      const node = this.createNode(query, queryVector, turn);
      this.state.activeNodeId = node.nodeId;
      this.state.l1Nodes.set(node.nodeId, node);
    } else {
      const activeNode = this.getActiveNode()!;
      const divergence = this.divergenceEngine.evaluate(queryVector, activeNode.centroidState.centroid);
      divergenceState = divergence.state;
      omega = divergence.omega;
      confidence = divergence.confidence;

      switch (divergence.state) {
        case 'Warmup':
        case 'Continuity':
          this.centroidEngine.update(activeNode.centroidState, queryVector, turn);
          activeNode.turnCount++;
          activeNode.lastActiveTurn = turn;
          for (const edge of this.state.edges.values()) {
            if (edge.toNodeId === this.state.activeNodeId) this.growEdge(edge, turn);
          }
          break;

        case 'Drift':
          this.centroidEngine.update(activeNode.centroidState, queryVector, turn);
          activeNode.turnCount++;
          activeNode.lastActiveTurn = turn;
          break;

        case 'Transition': {
          const reactivated = this.checkReactivation(queryVector, divergence.confidence, turn);
          if (reactivated) {
            topicReactivated = true;
            reactivatedNodeId = reactivated.nodeId;
            this.transitionToNode(reactivated, activeNode, queryVector, turn);
          } else {
            topicTransition = true;
            const newNode = this.createNode(query, queryVector, turn);
            this.transitionToNode(newNode, activeNode, queryVector, turn);
          }
          break;
        }
      }
    }

    // Semantic Query Expansion: combine query with active node verified completions
    let queryVectorForRetrieval = [...queryVector];
    const activeNodeForExpansion = this.getActiveNode();
    if (activeNodeForExpansion && activeNodeForExpansion.verifiedCompletions.length > 0) {
      const expandedText = query + ' ' + activeNodeForExpansion.verifiedCompletions.join(' ');
      queryVectorForRetrieval = this.vectorizer.vectorize(expandedText);
    }

    // Step 6: Run 5-question decision surface (§4.6)
    const surface = this.runDecisionSurface(queryVectorForRetrieval, turn);

    // Step 7: Build injection payload from decision surface
    const payload = this.buildPayloadFromSurface(surface, divergenceState, omega, confidence, turn, queryVectorForRetrieval);

    // Step 8: Decay topology
    this.decayTopology(turn);

    // Step 9: Schedule persistence
    this.schedulePersist();

    const processingTimeMs = performance.now() - t0;

    return {
      payload,
      renderedContext: this.injectionEngine.renderPayload(payload),
      state: divergenceState,
      omega,
      confidence,
      topicTransition,
      topicReactivated,
      reactivatedNodeId,
      processingTimeMs,
      decisionSurface: {
        semanticMatchCount: surface.semanticMatches.length,
        freshCount: surface.freshRecords.length,
        confidentCount: surface.confidentRecords.length,
        budgetFitCount: surface.budgetFitting.length,
        finalCount: surface.finalSet.length,
        totalRecords: this.state.records.size,
      },
    };
  }

  // ── Structured Record Storage (§4.5) ────────────────────────────────────────

  /**
   * Store a new harness-visible object as a structured record.
   * Implements the 4-record system: Source + Version + State + Confidence.
   * Handles version chains with latest-valid-first rule.
   */
  private storeRecord(opts: {
    content: string;
    sourceType: SourceType;
    tier: 1 | 2 | 3;
    turn: number;
    tags: string[];
    toolName?: string;
    filePath?: string;
    patchInfo?: { prevHash: string; newHash: string; diffSummary: string; rationale: string; dependsOn: string[] };
    links?: RecordLink[];
  }): StructuredRecord {
    const id = genId('rec');
    const hash = contentHash(opts.content);

    // Check if this supersedes an existing version (same source hash → exact dup, skip)
    const existingLatest = this.state.latestVersionIndex.get(hash);
    if (existingLatest) {
      const existing = this.state.records.get(existingLatest);
      if (existing) return existing; // Exact duplicate, skip
    }

    // Version chain: find if there's a previous version of the same source
    // For files/patches, chain by filePath. For others, chain by content hash similarity.
    let previousVersionId: string | null = null;
    if (opts.filePath) {
      const chain = this.state.patchChains.get(opts.filePath);
      if (chain && chain.length > 0) {
        previousVersionId = chain[chain.length - 1];
        // Supersede the old version
        const oldRecord = this.state.records.get(previousVersionId);
        if (oldRecord) {
          oldRecord.version.isSuperseded = true;
          oldRecord.version.supersededAtTurn = opts.turn;
          oldRecord.state.state = 'superseded';
          oldRecord.state.changedAtTurn = opts.turn;
        }
      }
    }

    const record: StructuredRecord = {
      source: {
        id,
        sourceType: opts.sourceType,
        tier: opts.tier,
        content: opts.content.substring(0, 800), // Cap for performance
        createdAtTurn: opts.turn,
        createdAt: Date.now(),
        toolName: opts.toolName,
        filePath: opts.filePath,
        tags: opts.tags.slice(0, 15),
      },
      version: {
        sourceId: id,
        sourceHash: hash,
        creationTurn: opts.turn,
        previousVersionId,
        newestVersionId: id,
        isSuperseded: false,
        supersededAtTurn: null,
      },
      state: {
        sourceId: id,
        state: opts.sourceType === 'system_rule' ? 'required' : 'applied',
        changedAtTurn: opts.turn,
        changedBy: 'system',
      },
      confidence: {
        sourceId: id,
        confidence: opts.sourceType === 'system_rule' ? 1.0
          : opts.sourceType === 'validated_completion' ? 0.95
          : opts.sourceType === 'user_turn' ? 0.80
          : opts.sourceType === 'tool_result' ? 0.75
          : 0.60,
        validated: opts.sourceType === 'validated_completion' || opts.sourceType === 'system_rule',
        injectionReason: '',
        lastInjectedTurn: 0,
        injectionCount: 0,
      },
      links: opts.links || [],
    };

    // Patch record for code edits (§4.5 coding sessions)
    if (opts.patchInfo && opts.filePath) {
      record.patch = {
        sourceId: id,
        filePath: opts.filePath,
        previousHash: opts.patchInfo.prevHash,
        newHash: opts.patchInfo.newHash,
        diffSummary: opts.patchInfo.diffSummary.substring(0, 300),
        rationale: opts.patchInfo.rationale.substring(0, 200),
        dependsOn: opts.patchInfo.dependsOn,
        applied: true,
        reverted: false,
        appliedAtTurn: opts.turn,
      };

      // Update patch chain
      const chain = this.state.patchChains.get(opts.filePath) || [];
      chain.push(id);
      if (chain.length > MAX_PATCH_CHAIN) chain.splice(0, chain.length - MAX_PATCH_CHAIN);
      this.state.patchChains.set(opts.filePath, chain);
    }

    // Update latest version index
    this.state.latestVersionIndex.set(hash, id);
    if (previousVersionId) {
      const oldRecord = this.state.records.get(previousVersionId);
      if (oldRecord) oldRecord.version.newestVersionId = id;
    }

    // Store
    this.state.records.set(id, record);

    // Associate with active node
    const activeNode = this.getActiveNode();
    if (activeNode) {
      activeNode.recordIds.push(id);
      if (activeNode.recordIds.length > 100) {
        activeNode.recordIds = activeNode.recordIds.slice(-100);
      }
    }

    // GC if too many records
    if (this.state.records.size > MAX_RECORDS) this.gcRecords();

    return record;
  }

  // ── 5-Question Decision Surface (§4.6) ─────────────────────────────────────

  /**
   * For each turn, answer 5 questions to build the injection set.
   * All operations are O(n) over records with early termination.
   */
  private runDecisionSurface(queryVector: number[], turn: number): DecisionSurface {
    const activeNode = this.getActiveNode();
    const activeTask = activeNode?.topicSummary || '(initializing)';

    // Pre-filter: only consider non-superseded, non-rejected records
    const candidates: StructuredRecord[] = [];
    for (const record of this.state.records.values()) {
      if (record.version.isSuperseded) continue;
      if (record.state.state === 'rejected' || record.state.state === 'reverted') continue;
      candidates.push(record);
    }

    // Q2: Semantic proximity — score each record against query
    const scored = candidates.map(r => {
      const rVec = this.vectorizer.vectorize(r.source.content);
      const sim = rVec.length > 0 && queryVector.length > 0 ? cosineSimilarity(queryVector, rVec) : 0;
      return { record: r, similarity: sim };
    });

    // Q2 answer: records with similarity > 0.15
    const semanticMatches = scored
      .filter(s => s.similarity > 0.15)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 30)
      .map(s => s.record);

    // Q3: Freshness — latest valid version of each source
    const freshRecords = candidates.filter(r =>
      !r.version.isSuperseded &&
      r.state.state !== 'superseded' &&
      r.version.newestVersionId === r.source.id,
    );

    // Q4: Confidence — records with confidence ≥ 0.5
    const confidentRecords = candidates.filter(r => r.confidence.confidence >= 0.5);

    // Q5: Token budget — intersect Q2∩Q3∩Q4, sort by weight, enforce budget
    const intersected = semanticMatches.filter(r =>
      freshRecords.includes(r) && confidentRecords.includes(r),
    );

    // Sort by: tier ASC (system first), then confidence DESC, then recency DESC
    const sorted = intersected.sort((a, b) => {
      if (a.source.tier !== b.source.tier) return a.source.tier - b.source.tier;
      if (b.confidence.confidence !== a.confidence.confidence) return b.confidence.confidence - a.confidence.confidence;
      return b.source.createdAtTurn - a.source.createdAtTurn;
    });

    // Enforce token budget (8000 tokens default)
    const budget = 8000;
    let usedTokens = 0;
    const budgetFitting: StructuredRecord[] = [];
    for (const record of sorted) {
      const tokens = estimateTokens(record.source.content);
      if (usedTokens + tokens > budget) continue;
      budgetFitting.push(record);
      usedTokens += tokens;
    }

    // Also include ALL tier-1 records (system rules always included)
    const tier1 = candidates.filter(r =>
      r.source.tier === 1 && !budgetFitting.includes(r),
    );
    const finalSet = [...tier1, ...budgetFitting];

    return {
      activeTask,
      semanticMatches,
      freshRecords,
      confidentRecords,
      budgetFitting,
      finalSet,
    };
  }

  // ── Payload Builder ─────────────────────────────────────────────────────────

  private buildPayloadFromSurface(
    surface: DecisionSurface,
    state: SynapseState,
    omega: number,
    confidence: number,
    turn: number,
    queryVector: number[],
  ): InjectionPayload {
    // Convert StructuredRecords to RegisteredInputs for the injection engine
    const registeredInputs: RegisteredInput[] = surface.finalSet.map(r => ({
      id: r.source.id,
      tier: r.source.tier,
      sourceHash: r.version.sourceHash,
      weight: r.confidence.confidence * (r.source.tier === 1 ? 10 : r.source.tier === 2 ? 5 : 3),
      lastUtilizedTurn: r.source.createdAtTurn,
      validityState: 'valid' as const,
      content: r.source.content,
      sourceType: r.source.sourceType as any,
      versionChain: r.version.previousVersionId ? [r.version.previousVersionId] : [],
      links: r.links,
    }));

    // Build archived node summaries for drift injection
    const archivedSummaries: ArchivedNodeSummary[] = [];
    for (const [nodeId, node] of this.state.l2Nodes.entries()) {
      const activeId = this.state.activeNodeId;
      const fwd = activeId ? this.state.edges.get(edgeKey(activeId, nodeId)) : null;
      const rev = activeId ? this.state.edges.get(edgeKey(nodeId, activeId!)) : null;
      const edgeWeight = Math.max(fwd?.weight || 0, rev?.weight || 0, 0.1);

      // Build adjacency list for PageRank
      const adjacentEdges: Array<{ toNodeId: string; weight: number }> = [];
      for (const edge of this.state.edges.values()) {
        if (edge.fromNodeId === nodeId) {
          adjacentEdges.push({ toNodeId: edge.toNodeId, weight: edge.weight });
        } else if (edge.toNodeId === nodeId) {
          adjacentEdges.push({ toNodeId: edge.fromNodeId, weight: edge.weight });
        }
      }

      archivedSummaries.push({
        nodeId,
        topicSummary: node.topicSummary,
        centroidVector: [...node.centroidState.centroid],
        edgeWeight,
        verifiedCompletions: [...node.verifiedCompletions],
        adjacentEdges,
      });
    }

    return this.injectionEngine.buildPayload(
      state, confidence, queryVector, omega, turn,
      registeredInputs, archivedSummaries,
      this.state.recentUserMessages,
    );
  }

  // ── Public API for Tool Results ─────────────────────────────────────────────

  /**
   * Register a tool result. Called after every tool execution.
   * Stores as a structured record with version tracking.
   */
  public registerToolResult(
    toolName: string,
    args: Record<string, any>,
    result: string,
    turn?: number,
  ): void {
    const effectiveTurn = turn ?? this.state.turnCount;
    const filePath = args.filename || args.path || args.file || undefined;
    const isFileWrite = /write|create|edit|patch|apply/.test(toolName);
    const isPatch = /patch|edit|str_replace|apply_patch/.test(toolName);

    this.vectorizer.addDocument(`${toolName}: ${result.substring(0, 200)}`);

    const sourceType: SourceType = isPatch ? 'code_patch'
      : isFileWrite ? 'file_snapshot'
      : toolName.includes('search') ? 'search_result'
      : 'tool_result';

    const links: RecordLink[] = [];
    let latestUserTurnId: string | null = null;
    const sortedRecords = [...this.state.records.values()].sort((a, b) => b.source.createdAtTurn - a.source.createdAtTurn);
    for (const rec of sortedRecords) {
      if (rec.source.sourceType === 'user_turn') {
        latestUserTurnId = rec.source.id;
        break;
      }
    }
    if (latestUserTurnId) {
      links.push({ targetId: latestUserTurnId, relationType: 'caused_by' });
    }

    const toolResultRecord = this.storeRecord({
      content: `[${toolName}] ${result.substring(0, 500)}`,
      sourceType,
      tier: 3,
      turn: effectiveTurn,
      tags: [toolName, ...this.extractTags(result.substring(0, 200))],
      toolName,
      filePath,
      patchInfo: isPatch && filePath ? {
        prevHash: contentHash(args.target || args.old_str || ''),
        newHash: contentHash(result.substring(0, 200)),
        diffSummary: (args.description || args.purpose || `${toolName} applied`).substring(0, 200),
        rationale: (args.rationale || args.reason || '').substring(0, 200),
        dependsOn: [],
      } : undefined,
      links,
    });

    if (latestUserTurnId) {
      const userTurnRec = this.state.records.get(latestUserTurnId);
      if (userTurnRec) {
        if (!userTurnRec.links) userTurnRec.links = [];
        userTurnRec.links.push({ targetId: toolResultRecord.source.id, relationType: 'child' });
      }
    }
  }

  /**
   * Register a validated completion on the active node.
   */
  public registerCompletion(description: string): void {
    const node = this.getActiveNode();
    if (!node) return;

    node.verifiedCompletions.push(description.substring(0, 120));
    if (node.verifiedCompletions.length > 10) {
      node.verifiedCompletions = node.verifiedCompletions.slice(-10);
    }

    this.storeRecord({
      content: description,
      sourceType: 'validated_completion',
      tier: 2,
      turn: this.state.turnCount,
      tags: ['completion', ...this.extractTags(description)],
    });
  }

  /**
   * Get patch chain for a file (§4.5 coding sessions).
   * Returns the ordered sequence of patches applied to a file.
   */
  public getPatchChain(filePath: string): PatchRecord[] {
    const chain = this.state.patchChains.get(filePath);
    if (!chain) return [];
    return chain
      .map(id => this.state.records.get(id)?.patch)
      .filter((p): p is PatchRecord => !!p);
  }

  /**
   * Debug info for console/UI.
   */
  public getDebugInfo(): {
    activeNodeId: string | null;
    activeTopicSummary: string;
    l1NodeCount: number;
    l2NodeCount: number;
    edgeCount: number;
    turnCount: number;
    totalRecords: number;
    patchChainCount: number;
    vocabSize: number;
  } {
    const activeNode = this.getActiveNode();
    return {
      activeNodeId: this.state.activeNodeId,
      activeTopicSummary: activeNode?.topicSummary || '(none)',
      l1NodeCount: this.state.l1Nodes.size,
      l2NodeCount: this.state.l2Nodes.size,
      edgeCount: this.state.edges.size,
      turnCount: this.state.turnCount,
      totalRecords: this.state.records.size,
      patchChainCount: this.state.patchChains.size,
      vocabSize: this.vectorizer.getDimension(),
    };
  }

  // ── Node Operations ─────────────────────────────────────────────────────────

  private createNode(query: string, queryVector: number[], turn: number): CognitiveNode {
    return {
      nodeId: genId('sn'),
      topicSummary: query.substring(0, 120),
      centroidState: this.centroidEngine.createInitial(queryVector, turn),
      turnCount: 1,
      verifiedCompletions: [],
      createdAt: Date.now(),
      lastActiveTurn: turn,
      recordIds: [],
    };
  }

  private getActiveNode(): CognitiveNode | null {
    if (!this.state.activeNodeId) return null;
    return this.state.l1Nodes.get(this.state.activeNodeId)
      || this.state.l2Nodes.get(this.state.activeNodeId)
      || null;
  }

  private transitionToNode(newNode: CognitiveNode, oldNode: CognitiveNode, queryVector: number[], turn: number): void {
    oldNode.archivedAt = Date.now();
    this.state.l2Nodes.set(oldNode.nodeId, oldNode);
    this.state.l1Nodes.delete(oldNode.nodeId);

    const key = edgeKey(oldNode.nodeId, newNode.nodeId);
    if (!this.state.edges.has(key)) {
      this.state.edges.set(key, {
        fromNodeId: oldNode.nodeId,
        toNodeId: newNode.nodeId,
        weight: 0.5,
        lastTraversedTurn: turn,
        traversalCount: 1,
        createdAt: Date.now(),
      });
    } else {
      this.growEdge(this.state.edges.get(key)!, turn);
    }

    if (this.state.l2Nodes.has(newNode.nodeId)) {
      this.state.l2Nodes.delete(newNode.nodeId);
      delete newNode.archivedAt;
    }
    this.state.l1Nodes.set(newNode.nodeId, newNode);
    this.state.activeNodeId = newNode.nodeId;
    this.centroidEngine.update(newNode.centroidState, queryVector, turn);
    newNode.lastActiveTurn = turn;
    newNode.turnCount++;
  }

  private checkReactivation(queryVector: number[], confidence: number, turn: number): CognitiveNode | null {
    if (confidence < REACTIVATION_MIN_CONFIDENCE) return null;
    const candidates = [...this.state.l2Nodes.values()]
      .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
      .slice(0, L2_SCAN_LIMIT);

    let best: CognitiveNode | null = null;
    let bestScore = 0;
    for (const node of candidates) {
      const sim = cosineSimilarity(queryVector, node.centroidState.centroid);
      if (1 - sim > REACTIVATION_THETA) continue;
      const activeId = this.state.activeNodeId;
      const fwd = activeId ? this.state.edges.get(edgeKey(activeId, node.nodeId)) : null;
      const rev = activeId ? this.state.edges.get(edgeKey(node.nodeId, activeId!)) : null;
      const ew = Math.max(fwd?.weight || 0, rev?.weight || 0);
      const score = ew * sim + sim * 0.5;
      if (score > bestScore) { bestScore = score; best = node; }
    }
    return best;
  }

  // ── Edge Operations ─────────────────────────────────────────────────────────

  private growEdge(edge: SynapseEdge, turn: number): void {
    edge.weight = edge.weight + EDGE_GROWTH_BETA * (1 - edge.weight);
    edge.lastTraversedTurn = turn;
    edge.traversalCount++;
  }

  private decayTopology(currentTurn: number): void {
    const toDelete: string[] = [];
    for (const [key, edge] of this.state.edges.entries()) {
      if (edge.lastTraversedTurn === currentTurn) continue;
      if (currentTurn - edge.lastTraversedTurn >= EDGE_STALE_TURNS) { toDelete.push(key); continue; }
      edge.weight *= EDGE_DECAY_GAMMA;
      if (edge.weight < EDGE_PRUNE_THRESHOLD) toDelete.push(key);
    }
    for (const key of toDelete) this.state.edges.delete(key);

    if (this.state.l2Nodes.size > MAX_L2_NODES) {
      const connected = new Set<string>();
      for (const e of this.state.edges.values()) { connected.add(e.fromNodeId); connected.add(e.toNodeId); }
      const orphans = [...this.state.l2Nodes.keys()].filter(id =>
        !connected.has(id) && currentTurn - (this.state.l2Nodes.get(id)!.lastActiveTurn) >= 100,
      );
      orphans.sort((a, b) => this.state.l2Nodes.get(a)!.lastActiveTurn - this.state.l2Nodes.get(b)!.lastActiveTurn);
      const del = Math.min(orphans.length, this.state.l2Nodes.size - MAX_L2_NODES);
      for (let i = 0; i < del; i++) this.state.l2Nodes.delete(orphans[i]);
    }
  }

  private coalesceL2Nodes(): void {
    const nodes = [...this.state.l2Nodes.values()];
    if (nodes.length <= 1) return;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const ni = nodes[i];
        const nj = nodes[j];
        const sim = cosineSimilarity(ni.centroidState.centroid, nj.centroidState.centroid);
        if (sim > 0.85) {
          const mergedRecords = new Set([...ni.recordIds, ...nj.recordIds]);
          ni.recordIds = [...mergedRecords].slice(-100);

          const mergedCompletions = new Set([...ni.verifiedCompletions, ...nj.verifiedCompletions]);
          ni.verifiedCompletions = [...mergedCompletions].slice(-10);

          ni.topicSummary = `${ni.topicSummary} / ${nj.topicSummary}`.substring(0, 120);

          for (const edge of this.state.edges.values()) {
            if (edge.fromNodeId === nj.nodeId) edge.fromNodeId = ni.nodeId;
            if (edge.toNodeId === nj.nodeId) edge.toNodeId = ni.nodeId;
          }

          this.state.l2Nodes.delete(nj.nodeId);
          console.log(`[SynapseGraph] 💤 Coalesced similar L2 nodes: ${nj.nodeId} into ${ni.nodeId} (similarity: ${sim.toFixed(3)})`);
          return this.coalesceL2Nodes();
        }
      }
    }
  }

  // ── Record GC ───────────────────────────────────────────────────────────────

  private gcRecords(): void {
    // Remove oldest superseded/rejected records first
    const removable = [...this.state.records.entries()]
      .filter(([, r]) => r.version.isSuperseded || r.state.state === 'rejected' || r.state.state === 'reverted')
      .sort(([, a], [, b]) => a.source.createdAtTurn - b.source.createdAtTurn);

    const removeCount = Math.min(removable.length, this.state.records.size - Math.floor(MAX_RECORDS * 0.7));
    for (let i = 0; i < removeCount; i++) {
      this.state.records.delete(removable[i][0]);
    }
  }

  // ── Tag Extraction ──────────────────────────────────────────────────────────

  private extractTags(text: string): string[] {
    return text.toLowerCase()
      .replace(/[^a-z0-9_\-./\\]+/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 10);
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  public async flush(): Promise<void> {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    if (this.persistPending || this.initialized) {
      this.persistPending = false;
      await this.persistToDisk();
    }
  }

  private schedulePersist(): void {
    this.persistPending = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.persistPending) { this.persistPending = false; this.persistToDisk().catch(() => {}); }
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistToDisk(): Promise<void> {
    if (!this.graphFilePath) return;
    try { await writeJsonAtomic(this.graphFilePath, this.exportState()); }
    catch (err: any) { console.warn(`[SynapseGraph] ⚠️ Persist failed: ${err.message}`); }
  }

  // ── Serialization ───────────────────────────────────────────────────────────

  private exportState(): Record<string, any> {
    return {
      version: 2,
      chatId: this.state.chatId,
      projectId: this.state.projectId,
      activeNodeId: this.state.activeNodeId,
      turnCount: this.state.turnCount,
      recentUserMessages: [...this.state.recentUserMessages],
      l1Nodes: Object.fromEntries([...this.state.l1Nodes.entries()].map(([id, n]) => [id, this.serializeNode(n)])),
      l2Nodes: Object.fromEntries([...this.state.l2Nodes.entries()].map(([id, n]) => [id, this.serializeNode(n)])),
      edges: Object.fromEntries([...this.state.edges.entries()]),
      records: Object.fromEntries([...this.state.records.entries()]),
      latestVersionIndex: Object.fromEntries([...this.state.latestVersionIndex.entries()]),
      patchChains: Object.fromEntries([...this.state.patchChains.entries()]),
      vectorizer: this.vectorizer.exportState(),
      divergenceEngine: this.divergenceEngine.exportState(),
    };
  }

  private importState(raw: Record<string, any>): void {
    this.state.chatId = raw.chatId || '';
    this.state.projectId = raw.projectId || '';
    this.state.activeNodeId = raw.activeNodeId || null;
    this.state.turnCount = raw.turnCount || 0;
    this.state.recentUserMessages = raw.recentUserMessages || [];

    this.state.l1Nodes = new Map();
    if (raw.l1Nodes) for (const [id, n] of Object.entries(raw.l1Nodes)) this.state.l1Nodes.set(id, this.deserializeNode(n as any));
    this.state.l2Nodes = new Map();
    if (raw.l2Nodes) for (const [id, n] of Object.entries(raw.l2Nodes)) this.state.l2Nodes.set(id, this.deserializeNode(n as any));
    this.state.edges = new Map(Object.entries(raw.edges || {}));
    this.state.records = new Map(Object.entries(raw.records || {}));
    this.state.latestVersionIndex = new Map(Object.entries(raw.latestVersionIndex || {}));
    this.state.patchChains = new Map(Object.entries(raw.patchChains || {}).map(([k, v]) => [k, v as string[]]));

    if (raw.vectorizer) this.vectorizer.importState(raw.vectorizer);
    if (raw.divergenceEngine) this.divergenceEngine.importState(raw.divergenceEngine);
  }

  private serializeNode(n: CognitiveNode): Record<string, any> {
    return { ...n, centroidState: this.centroidEngine.exportState(n.centroidState) };
  }

  private deserializeNode(raw: any): CognitiveNode {
    return {
      nodeId: raw.nodeId || genId('sn'),
      topicSummary: raw.topicSummary || '',
      centroidState: this.centroidEngine.importState(raw.centroidState || { anchor: [], ewma: [], centroid: [], updateCount: 0, history: [] }),
      turnCount: raw.turnCount || 0,
      verifiedCompletions: raw.verifiedCompletions || [],
      createdAt: raw.createdAt || Date.now(),
      archivedAt: raw.archivedAt,
      lastActiveTurn: raw.lastActiveTurn || 0,
      recordIds: raw.recordIds || [],
    };
  }
}

// ─── Per-Chat Instance Registry ───────────────────────────────────────────────

const _graphInstances: Map<string, SynapseGraph> = new Map();
const MAX_GRAPH_INSTANCES = 20;

export function getSynapseGraphForChat(chatId: string): SynapseGraph {
  const existing = _graphInstances.get(chatId);
  if (existing) return existing;
  const instance = new SynapseGraph();
  _graphInstances.set(chatId, instance);
  if (_graphInstances.size > MAX_GRAPH_INSTANCES) {
    const first = _graphInstances.keys().next().value;
    if (first) { _graphInstances.get(first)?.flush().catch(() => {}); _graphInstances.delete(first); }
  }
  return instance;
}

export async function flushSynapseGraph(chatId: string): Promise<void> {
  const instance = _graphInstances.get(chatId);
  if (instance) await instance.flush();
}
