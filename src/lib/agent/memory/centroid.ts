/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX-SYNAPSE — Centroid Engine
 * ═══════════════════════════════════════════════════════════════
 *
 * Implements the Anchor-EWMA centroid model from the PCCA paper.
 * Maintains a running centroid per cognitive node that blends:
 *   - Anchor vector (first query, captures original topic intent)
 *   - EWMA vector (running average, tracks topic evolution)
 *
 * Equations implemented:
 *   EWMA(t)   = λ · Q_t + (1 - λ) · EWMA(t-1)              [Eq. 3]
 *   N_active  = normalize(α · anchor + (1-α) · EWMA(t))     [Eq. 4]
 *
 * Design improvements over paper:
 *   - α and λ are configurable per-session (paper hardcodes α=0.30, λ=0.15)
 *   - Centroid clamping prevents degenerate vectors (all zeros)
 *   - History tracking enables centroid rollback on state transition
 */

import { l2Normalize } from './divergence';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default anchor weight. How much the original topic "anchors" the centroid. */
const DEFAULT_ALPHA = 0.30;

/** Default EWMA smoothing factor. Higher = more responsive to recent turns. */
const DEFAULT_LAMBDA = 0.15;

/** Maximum centroid history entries (for rollback/debugging). */
const MAX_CENTROID_HISTORY = 30;

/** Minimum L2 magnitude for a valid centroid. Below this → degenerate. */
const MIN_CENTROID_MAGNITUDE = 0.001;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CentroidConfig {
  /** Anchor weight α ∈ [0, 1]. Default 0.30. */
  alpha: number;

  /** EWMA smoothing λ ∈ [0, 1]. Default 0.15. */
  lambda: number;
}

export interface CentroidSnapshot {
  /** The blended, normalized centroid vector. */
  centroid: number[];

  /** Raw EWMA vector before anchor blending. */
  ewma: number[];

  /** Turn number this snapshot was taken at. */
  turn: number;

  /** Timestamp. */
  ts: number;
}

export interface CentroidState {
  /** The anchor vector (first query of the node). */
  anchor: number[];

  /** Current EWMA vector. */
  ewma: number[];

  /** Current blended + normalized centroid. */
  centroid: number[];

  /** Number of update steps applied. */
  updateCount: number;

  /** History of centroid snapshots for rollback. */
  history: CentroidSnapshot[];
}

// ─── Centroid Engine ──────────────────────────────────────────────────────────

export class CentroidEngine {
  private config: CentroidConfig;

  constructor(config?: Partial<CentroidConfig>) {
    this.config = {
      alpha: config?.alpha ?? DEFAULT_ALPHA,
      lambda: config?.lambda ?? DEFAULT_LAMBDA,
    };
  }

  /**
   * Create an initial centroid state from the first query vector.
   * The anchor is set permanently; EWMA starts as a copy of the anchor.
   */
  createInitial(queryVector: number[], turn: number): CentroidState {
    const anchor = [...queryVector];
    const ewma = [...queryVector];
    const centroid = l2Normalize([...queryVector]);

    return {
      anchor,
      ewma,
      centroid,
      updateCount: 1,
      history: [
        {
          centroid: [...centroid],
          ewma: [...ewma],
          turn,
          ts: Date.now(),
        },
      ],
    };
  }

  /**
   * Update the centroid with a new query vector.
   *
   * Implements:
   *   EWMA(t) = λ · Q_t + (1-λ) · EWMA(t-1)
   *   Centroid = normalize(α · anchor + (1-α) · EWMA(t))
   *
   * @param state - Current centroid state (mutated in place)
   * @param queryVector - New query's TF-IDF vector
   * @param turn - Current turn number
   * @returns The updated centroid state
   */
  update(state: CentroidState, queryVector: number[], turn: number): CentroidState {
    const dim = Math.max(state.anchor.length, queryVector.length);
    const { alpha, lambda } = this.config;

    // Ensure all vectors are the same dimension (pad with zeros if vocabulary grew)
    this.padToLength(state.anchor, dim);
    this.padToLength(state.ewma, dim);
    this.padToLength(state.centroid, dim);
    const paddedQuery = [...queryVector];
    this.padToLength(paddedQuery, dim);

    // ── EWMA update (Eq. 3) ───────────────────────────────────────────────
    for (let i = 0; i < dim; i++) {
      state.ewma[i] = lambda * paddedQuery[i] + (1 - lambda) * state.ewma[i];
    }

    // ── Blended centroid (Eq. 4) ──────────────────────────────────────────
    const blended = new Array<number>(dim);
    for (let i = 0; i < dim; i++) {
      blended[i] = alpha * state.anchor[i] + (1 - alpha) * state.ewma[i];
    }

    // ── L2 normalize ──────────────────────────────────────────────────────
    const normalized = l2Normalize(blended);

    // ── Degenerate check ──────────────────────────────────────────────────
    const mag = Math.sqrt(normalized.reduce((s, v) => s + v * v, 0));
    if (mag < MIN_CENTROID_MAGNITUDE) {
      // Centroid collapsed — fall back to anchor
      console.warn('[CentroidEngine] ⚠️ Centroid collapsed. Falling back to anchor.');
      state.centroid = l2Normalize([...state.anchor]);
    } else {
      state.centroid = normalized;
    }

    // ── Record snapshot ───────────────────────────────────────────────────
    state.updateCount++;
    state.history.push({
      centroid: [...state.centroid],
      ewma: [...state.ewma],
      turn,
      ts: Date.now(),
    });

    // Trim history
    if (state.history.length > MAX_CENTROID_HISTORY) {
      state.history = state.history.slice(-MAX_CENTROID_HISTORY);
    }

    return state;
  }

  /**
   * Roll back the centroid to a previous turn.
   * Used when a state transition causes the active node to change.
   * Returns null if the requested turn isn't in history.
   */
  rollback(state: CentroidState, toTurn: number): CentroidState | null {
    const snapshot = state.history.find(h => h.turn === toTurn);
    if (!snapshot) return null;

    state.centroid = [...snapshot.centroid];
    state.ewma = [...snapshot.ewma];
    // Trim history to the rollback point
    state.history = state.history.filter(h => h.turn <= toTurn);

    return state;
  }

  /**
   * Compute the centroid drift between two states.
   * Returns the cosine distance (0 = identical, 1 = orthogonal).
   */
  computeDrift(stateA: CentroidState, stateB: CentroidState): number {
    return 1 - this.cosine(stateA.centroid, stateB.centroid);
  }

  /**
   * Get the current blended centroid vector.
   */
  getCentroid(state: CentroidState): number[] {
    return [...state.centroid];
  }

  /**
   * Get configuration (for inspection/debugging).
   */
  getConfig(): CentroidConfig {
    return { ...this.config };
  }

  /**
   * Export state for persistence.
   */
  exportState(state: CentroidState): CentroidState {
    return {
      anchor: [...state.anchor],
      ewma: [...state.ewma],
      centroid: [...state.centroid],
      updateCount: state.updateCount,
      history: state.history.map(h => ({
        centroid: [...h.centroid],
        ewma: [...h.ewma],
        turn: h.turn,
        ts: h.ts,
      })),
    };
  }

  /**
   * Import state from persistence.
   */
  importState(raw: CentroidState): CentroidState {
    return {
      anchor: [...raw.anchor],
      ewma: [...raw.ewma],
      centroid: [...raw.centroid],
      updateCount: raw.updateCount || 0,
      history: Array.isArray(raw.history)
        ? raw.history.map(h => ({
            centroid: [...h.centroid],
            ewma: [...h.ewma],
            turn: h.turn,
            ts: h.ts,
          }))
        : [],
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /** Pad a vector with zeros to reach target length. */
  private padToLength(v: number[], len: number): void {
    while (v.length < len) {
      v.push(0);
    }
  }

  /** Cosine similarity between two vectors. */
  private cosine(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;

    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }

    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }
}
