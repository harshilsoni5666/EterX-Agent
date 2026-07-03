/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX-SYNAPSE — Injection Policy Engine (Φ Function)
 * ═══════════════════════════════════════════════════════════════
 *
 * The Φ function that converts SynapseGraph state into a ranked
 * context payload for LLM injection.
 *
 * Tier Architecture:
 *   Tier 1: System rules + guardrails        → ALWAYS included
 *   Tier 2: Active session state + memory     → By relevance
 *   Tier 3: Working context + tool results    → By recency
 *
 * Design improvements over paper:
 *   - Token budget enforcement (drift injections capped at 20%)
 *   - Source freshness preference (newest validated version wins)
 *   - Confidence gating (below floor → inject nothing, degrade gracefully)
 *   - Position bias exploitation (critical items placed at top)
 *   - Grounding check (compare active topic against recent user messages)
 *
 * Equation implemented:
 *   S(node_i) = W(edge_active→i) × max(0, cos(Q_t, centroid_i))  [Eq. 9]
 */

import { cosineSimilarity } from './divergence';
import type { SynapseState } from './divergence';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum fraction of token budget that drift injections can consume. */
const DRIFT_BUDGET_FRACTION = 0.20;

/** Default total token budget for context injection. */
const DEFAULT_TOKEN_BUDGET = 8000;

/** Minimum confidence to produce any injection. Below → graceful degradation. */
const CONFIDENCE_FLOOR = 0.30;

/** Maximum drift injection items per payload. */
const MAX_DRIFT_ITEMS = 6;

/** Maximum tier-2 items. */
const MAX_TIER2_ITEMS = 10;

/** Maximum tier-3 items. */
const MAX_TIER3_ITEMS = 15;

/** Chars per token (rough approximation for budget enforcement). */
const CHARS_PER_TOKEN = 4;

/** Minimum reactivation score for L2 node injection. */
const MIN_REACTIVATION_SCORE = 0.15;

/** Grounding check: minimum keyword overlap between topic summary and recent messages. */
const GROUNDING_OVERLAP_MIN = 0.15;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InjectionItem {
  /** Unique ID for deduplication. */
  id: string;

  /** The actual text content to inject. */
  content: string;

  /** Tier: 1 (system), 2 (session), 3 (working). */
  tier: 1 | 2 | 3;

  /** Computed relevance weight. Higher = more important. */
  weight: number;

  /** Source system that provided this item. */
  source: string;

  /** Reason this item was included (for debugging). */
  reason: string;

  /** Estimated token cost. */
  estimatedTokens: number;

  /** Source hash for freshness tracking. */
  sourceHash?: string;

  /** Whether this item is a drift injection (from L2 topology). */
  isDriftInjection: boolean;
}

export interface InjectionPayload {
  /** Ordered list of items to inject (position 0 = top of context). */
  items: InjectionItem[];

  /** Total estimated tokens consumed by this payload. */
  totalTokens: number;

  /** The Synapse state that produced this payload. */
  state: SynapseState;

  /** Confidence in this payload's relevance. */
  confidence: number;

  /** Whether the system is in graceful degradation mode. */
  degraded: boolean;

  /** Grounding check result: did the topic summary pass validation? */
  groundingCheck: boolean;

  /** Debug metadata. */
  debug: {
    turnNumber: number;
    omega: number;
    driftItemCount: number;
    tier1Count: number;
    tier2Count: number;
    tier3Count: number;
    budgetUsed: number;
    budgetTotal: number;
  };
}

export interface RegisteredInput {
  /** Unique stable identifier. */
  id: string;

  /** Priority tier. */
  tier: 1 | 2 | 3;

  /** SHA-256 hash of content for freshness detection. */
  sourceHash: string;

  /** Computed weight (importance × recency). */
  weight: number;

  /** Last turn this input was utilized by the model. */
  lastUtilizedTurn: number;

  /** Validity state. */
  validityState: 'valid' | 'superseded' | 'stale';

  /** The actual content. */
  content: string;

  /** Where this input came from. */
  sourceType: 'user_turn' | 'tool_result' | 'file' | 'search' | 'system_rule';

  /** Version chain: IDs of previous versions (for freshness). */
  versionChain: string[];
}

export interface ArchivedNodeSummary {
  /** Node ID in the topology ledger. */
  nodeId: string;

  /** Human-readable topic summary. */
  topicSummary: string;

  /** Centroid vector for cosine matching. */
  centroidVector: number[];

  /** Edge weight from the active node to this node. */
  edgeWeight: number;

  /** Verified completions (things confirmed done). */
  verifiedCompletions: string[];
}

export interface InjectionPolicyConfig {
  /** Total token budget. Default 8000. */
  tokenBudget: number;

  /** Fraction of budget for drift injections. Default 0.20. */
  driftBudgetFraction: number;
}

// ─── Injection Policy Engine ──────────────────────────────────────────────────

export class InjectionPolicyEngine {
  private config: InjectionPolicyConfig;

  constructor(config?: Partial<InjectionPolicyConfig>) {
    this.config = {
      tokenBudget: config?.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      driftBudgetFraction: config?.driftBudgetFraction ?? DRIFT_BUDGET_FRACTION,
    };
  }

  /**
   * Build the injection payload (Φ function).
   *
   * @param state - Current Synapse state (Continuity/Drift/Transition/Warmup)
   * @param confidence - System confidence in its state assessment
   * @param queryVector - Current query's TF-IDF vector
   * @param omega - Current divergence score
   * @param turnNumber - Current turn number
   * @param registeredInputs - All registered inputs from the input registry
   * @param archivedNodes - L2 topology ledger summaries
   * @param recentUserMessages - Last 3 user messages (for grounding check)
   */
  buildPayload(
    state: SynapseState,
    confidence: number,
    queryVector: number[],
    omega: number,
    turnNumber: number,
    registeredInputs: RegisteredInput[],
    archivedNodes: ArchivedNodeSummary[],
    recentUserMessages: string[],
  ): InjectionPayload {
    const budget = this.config.tokenBudget;
    const driftBudget = Math.floor(budget * this.config.driftBudgetFraction);

    // ── Graceful degradation check ────────────────────────────────────────
    if (confidence < CONFIDENCE_FLOOR) {
      return {
        items: [],
        totalTokens: 0,
        state,
        confidence,
        degraded: true,
        groundingCheck: true, // N/A
        debug: {
          turnNumber,
          omega,
          driftItemCount: 0,
          tier1Count: 0,
          tier2Count: 0,
          tier3Count: 0,
          budgetUsed: 0,
          budgetTotal: budget,
        },
      };
    }

    // ── Collect items by tier ──────────────────────────────────────────────
    const items: InjectionItem[] = [];
    let usedTokens = 0;

    // Tier 1: System rules — always included
    const tier1Items = this.collectTier1(registeredInputs);
    for (const item of tier1Items) {
      if (usedTokens + item.estimatedTokens <= budget) {
        items.push(item);
        usedTokens += item.estimatedTokens;
      }
    }

    // ── Drift injections (only in Drift or Transition state) ──────────────
    let driftItemCount = 0;
    if ((state === 'Drift' || state === 'Transition') && archivedNodes.length > 0) {
      const driftItems = this.buildDriftInjections(
        queryVector,
        archivedNodes,
        driftBudget,
      );
      for (const item of driftItems) {
        if (usedTokens + item.estimatedTokens <= budget) {
          items.push(item);
          usedTokens += item.estimatedTokens;
          driftItemCount++;
        }
      }
    }

    // Tier 2: Session state — by relevance
    const tier2Items = this.collectTier2(registeredInputs, queryVector, turnNumber);
    for (const item of tier2Items) {
      if (usedTokens + item.estimatedTokens <= budget) {
        items.push(item);
        usedTokens += item.estimatedTokens;
      }
    }

    // Tier 3: Working context — by recency
    const tier3Items = this.collectTier3(registeredInputs, turnNumber);
    for (const item of tier3Items) {
      if (usedTokens + item.estimatedTokens <= budget) {
        items.push(item);
        usedTokens += item.estimatedTokens;
      }
    }

    // ── Grounding check ───────────────────────────────────────────────────
    const groundingCheck = this.performGroundingCheck(
      items.filter(i => i.isDriftInjection),
      recentUserMessages,
    );

    // If grounding fails, remove drift injections (they're wrong-topic)
    if (!groundingCheck) {
      const filteredItems = items.filter(i => !i.isDriftInjection);
      const filteredTokens = filteredItems.reduce((s, i) => s + i.estimatedTokens, 0);
      return {
        items: filteredItems,
        totalTokens: filteredTokens,
        state,
        confidence,
        degraded: false,
        groundingCheck: false,
        debug: {
          turnNumber,
          omega,
          driftItemCount: 0,
          tier1Count: tier1Items.length,
          tier2Count: tier2Items.length,
          tier3Count: tier3Items.length,
          budgetUsed: filteredTokens,
          budgetTotal: budget,
        },
      };
    }

    return {
      items,
      totalTokens: usedTokens,
      state,
      confidence,
      degraded: false,
      groundingCheck: true,
      debug: {
        turnNumber,
        omega,
        driftItemCount,
        tier1Count: tier1Items.length,
        tier2Count: tier2Items.length,
        tier3Count: tier3Items.length,
        budgetUsed: usedTokens,
        budgetTotal: budget,
      },
    };
  }

  /**
   * Render the injection payload as a string block for system prompt insertion.
   */
  renderPayload(payload: InjectionPayload): string {
    if (payload.degraded || payload.items.length === 0) return '';

    const parts: string[] = [];

    // Drift injections get a special header
    const driftItems = payload.items.filter(i => i.isDriftInjection);
    const normalItems = payload.items.filter(i => !i.isDriftInjection);

    if (driftItems.length > 0) {
      parts.push('━━━ SYNAPSE TOPIC CONTEXT (from prior conversation threads) ━━━');
      for (const item of driftItems) {
        parts.push(`[${item.source}] ${item.content}`);
      }
      parts.push('━━━ END TOPIC CONTEXT ━━━');
    }

    // Normal items rendered inline (tier 1 first, then 2, then 3)
    const sorted = [...normalItems].sort((a, b) => a.tier - b.tier || b.weight - a.weight);
    for (const item of sorted) {
      parts.push(item.content);
    }

    return parts.join('\n');
  }

  // ── Tier collectors ─────────────────────────────────────────────────────────

  /**
   * Tier 1: System rules — always included, no filtering.
   */
  private collectTier1(inputs: RegisteredInput[]): InjectionItem[] {
    return inputs
      .filter(i => i.tier === 1 && i.validityState === 'valid')
      .sort((a, b) => b.weight - a.weight)
      .map(i => ({
        id: i.id,
        content: i.content,
        tier: 1 as const,
        weight: i.weight,
        source: i.sourceType,
        reason: 'System rule (always included)',
        estimatedTokens: this.estimateTokens(i.content),
        sourceHash: i.sourceHash,
        isDriftInjection: false,
      }));
  }

  /**
   * Tier 2: Session state — ranked by relevance to current query.
   */
  private collectTier2(
    inputs: RegisteredInput[],
    queryVector: number[],
    turnNumber: number,
  ): InjectionItem[] {
    return inputs
      .filter(i => i.tier === 2 && i.validityState === 'valid')
      .map(i => ({
        input: i,
        // Relevance = weight × recency boost
        relevance: i.weight * Math.max(0.3, 1 - (turnNumber - i.lastUtilizedTurn) * 0.05),
      }))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, MAX_TIER2_ITEMS)
      .map(({ input, relevance }) => ({
        id: input.id,
        content: input.content,
        tier: 2 as const,
        weight: relevance,
        source: input.sourceType,
        reason: `Session state (relevance: ${relevance.toFixed(2)})`,
        estimatedTokens: this.estimateTokens(input.content),
        sourceHash: input.sourceHash,
        isDriftInjection: false,
      }));
  }

  /**
   * Tier 3: Working context — ranked by recency.
   * Prefers newest validated version of any input.
   */
  private collectTier3(
    inputs: RegisteredInput[],
    turnNumber: number,
  ): InjectionItem[] {
    // Deduplicate by source hash — keep only the newest version
    const bySource = new Map<string, RegisteredInput>();
    for (const input of inputs) {
      if (input.tier !== 3 || input.validityState !== 'valid') continue;
      const existing = bySource.get(input.sourceHash);
      if (!existing || input.lastUtilizedTurn > existing.lastUtilizedTurn) {
        bySource.set(input.sourceHash, input);
      }
    }

    return [...bySource.values()]
      .sort((a, b) => b.lastUtilizedTurn - a.lastUtilizedTurn)
      .slice(0, MAX_TIER3_ITEMS)
      .map(input => ({
        id: input.id,
        content: input.content,
        tier: 3 as const,
        weight: input.weight,
        source: input.sourceType,
        reason: `Working context (turn ${input.lastUtilizedTurn})`,
        estimatedTokens: this.estimateTokens(input.content),
        sourceHash: input.sourceHash,
        isDriftInjection: false,
      }));
  }

  // ── Drift injection builder ─────────────────────────────────────────────────

  /**
   * Build drift injections from L2 topology.
   * Implements Eq. 9: S(node_i) = W(edge) × max(0, cos(Q, centroid_i))
   */
  private buildDriftInjections(
    queryVector: number[],
    archivedNodes: ArchivedNodeSummary[],
    tokenBudget: number,
  ): InjectionItem[] {
    // Score each archived node
    const scored = archivedNodes
      .map(node => {
        const cosine = cosineSimilarity(queryVector, node.centroidVector);
        const score = node.edgeWeight * Math.max(0, cosine);
        return { node, score };
      })
      .filter(({ score }) => score >= MIN_REACTIVATION_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_DRIFT_ITEMS);

    // Build injection items within budget
    const items: InjectionItem[] = [];
    let usedTokens = 0;

    for (const { node, score } of scored) {
      const parts: string[] = [`📌 Prior topic: ${node.topicSummary}`];

      if (node.verifiedCompletions.length > 0) {
        parts.push(`  Completed: ${node.verifiedCompletions.slice(0, 3).join(', ')}`);
      }

      const content = parts.join('\n');
      const tokens = this.estimateTokens(content);

      if (usedTokens + tokens <= tokenBudget) {
        items.push({
          id: `drift_${node.nodeId}`,
          content,
          tier: 2,
          weight: score,
          source: `L2:${node.nodeId}`,
          reason: `Drift injection (score: ${score.toFixed(3)}, edge: ${node.edgeWeight.toFixed(3)})`,
          estimatedTokens: tokens,
          isDriftInjection: true,
        });
        usedTokens += tokens;
      }
    }

    return items;
  }

  // ── Grounding check ─────────────────────────────────────────────────────────

  /**
   * Verify that drift injections are topically grounded in recent user messages.
   * Prevents "smooth wrongness" (paper issue #8).
   *
   * Returns true if at least one drift injection shares significant keywords
   * with the last 3 user messages.
   */
  private performGroundingCheck(
    driftItems: InjectionItem[],
    recentUserMessages: string[],
  ): boolean {
    if (driftItems.length === 0) return true; // Nothing to check

    const userKeywords = new Set<string>();
    for (const msg of recentUserMessages) {
      const words = msg
        .toLowerCase()
        .replace(/[^a-z0-9_\-./\\]+/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3);
      for (const w of words) {
        userKeywords.add(w);
      }
    }

    if (userKeywords.size === 0) return true; // No user context to check against

    for (const item of driftItems) {
      const itemWords = item.content
        .toLowerCase()
        .replace(/[^a-z0-9_\-./\\]+/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3);

      if (itemWords.length === 0) continue;

      let overlap = 0;
      for (const w of itemWords) {
        if (userKeywords.has(w)) overlap++;
      }

      const overlapRatio = overlap / itemWords.length;
      if (overlapRatio >= GROUNDING_OVERLAP_MIN) {
        return true; // At least one item is grounded
      }
    }

    // None of the drift injections share meaningful keywords with user messages
    console.warn(
      `[InjectionPolicy] ⚠️ Grounding check FAILED — drift injections don't match recent user messages. Removing.`,
    );
    return false;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Rough token estimation from character count. */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
