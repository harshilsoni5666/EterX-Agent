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

  /** Multi-modal semantic facets (sub-centroids) */
  facets?: Array<{
    centroid: number[];
    ewma: number[];
    updateCount: number;
  }>;

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
      facets: [
        {
          centroid: [...centroid],
          ewma: [...ewma],
          updateCount: 1,
        }
      ],
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
   * Updates matching semantic facets, spawns new facets, and merges collinear ones.
   */
  update(state: CentroidState, queryVector: number[], turn: number): CentroidState {
    const dim = Math.max(state.anchor.length, queryVector.length);
    const { alpha, lambda } = this.config;

    // Ensure all vectors are the same dimension
    this.padToLength(state.anchor, dim);
    this.padToLength(state.ewma, dim);
    this.padToLength(state.centroid, dim);
    const paddedQuery = [...queryVector];
    this.padToLength(paddedQuery, dim);

    // Initialize facets if not present
    if (!state.facets || state.facets.length === 0) {
      state.facets = [
        {
          centroid: [...state.centroid],
          ewma: [...state.ewma],
          updateCount: state.updateCount,
        }
      ];
    }

    // Pad existing facets
    for (const facet of state.facets) {
      this.padToLength(facet.centroid, dim);
      this.padToLength(facet.ewma, dim);
    }

    // Find best matching facet
    let bestFacetIdx = 0;
    let bestSim = -2;
    for (let i = 0; i < state.facets.length; i++) {
      const sim = this.cosine(paddedQuery, state.facets[i].centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestFacetIdx = i;
      }
    }

    // If different from existing facets and we have space, create new facet
    if (bestSim < 0.35 && state.facets.length < 3) {
      const newFacet = {
        centroid: l2Normalize([...paddedQuery]),
        ewma: [...paddedQuery],
        updateCount: 1,
      };
      state.facets.push(newFacet);
      console.log(`[CentroidEngine] 🚀 Spawned new semantic facet (total facets: ${state.facets.length})`);
    } else {
      // Update matched facet
      const facet = state.facets[bestFacetIdx];
      for (let i = 0; i < dim; i++) {
        facet.ewma[i] = lambda * paddedQuery[i] + (1 - lambda) * facet.ewma[i];
      }
      const blendedFacet = new Array<number>(dim);
      for (let i = 0; i < dim; i++) {
        blendedFacet[i] = alpha * state.anchor[i] + (1 - alpha) * facet.ewma[i];
      }
      facet.centroid = l2Normalize(blendedFacet);
      facet.updateCount++;
    }

    // Merge highly collinear facets (topic coalescence)
    if (state.facets.length > 1) {
      let merged = false;
      for (let i = 0; i < state.facets.length; i++) {
        for (let j = i + 1; j < state.facets.length; j++) {
          const sim = this.cosine(state.facets[i].centroid, state.facets[j].centroid);
          if (sim > 0.85) {
            const fi = state.facets[i];
            const fj = state.facets[j];
            const total = fi.updateCount + fj.updateCount;
            const wI = fi.updateCount / total;
            const wJ = fj.updateCount / total;

            for (let k = 0; k < dim; k++) {
              fi.ewma[k] = wI * fi.ewma[k] + wJ * fj.ewma[k];
              fi.centroid[k] = wI * fi.centroid[k] + wJ * fj.centroid[k];
            }
            fi.centroid = l2Normalize(fi.centroid);
            fi.updateCount = total;

            state.facets.splice(j, 1);
            console.log(`[CentroidEngine] 🤝 Merged collinear facets (remaining: ${state.facets.length})`);
            merged = true;
            break;
          }
        }
        if (merged) break;
      }
    }

    // ── Global EWMA update for compatibility (Eq. 3) ───────────────────────
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
   */
  rollback(state: CentroidState, toTurn: number): CentroidState | null {
    const snapshot = state.history.find(h => h.turn === toTurn);
    if (!snapshot) return null;

    state.centroid = [...snapshot.centroid];
    state.ewma = [...snapshot.ewma];
    state.history = state.history.filter(h => h.turn <= toTurn);

    return state;
  }

  /**
   * Compute the centroid drift between two states.
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
   * Get configuration.
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
      facets: state.facets ? state.facets.map(f => ({
        centroid: [...f.centroid],
        ewma: [...f.ewma],
        updateCount: f.updateCount,
      })) : undefined,
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
      facets: Array.isArray(raw.facets)
        ? raw.facets.map((f: any) => ({
            centroid: [...f.centroid],
            ewma: [...f.ewma],
            updateCount: f.updateCount || 0,
          }))
        : undefined,
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
