/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX-SYNAPSE — Divergence Engine
 * ═══════════════════════════════════════════════════════════════
 *
 * Implements the divergence-gated state machine from the PCCA paper
 * WITHOUT requiring external embedding API calls.
 *
 * Core innovations over paper:
 *   1. Local TF-IDF vectorizer (zero network calls, ~0.5ms per turn)
 *   2. Adaptive warmup (exits early if first two turns are clearly distinct)
 *   3. Graceful degradation (confidence floor gating)
 *   4. Vocabulary pruning (caps at MAX_VOCAB_SIZE to bound memory)
 *
 * Equations implemented:
 *   Ω(t) = 1 - cos(Q_t, N_active)          [Eq. 2]
 *   State transitions: Continuity → Drift → Transition
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum vocabulary size for TF-IDF. Bounds memory at ~80KB. */
const MAX_VOCAB_SIZE = 200;

/** Minimum warmup turns before divergence gating activates. */
const MIN_WARMUP_TURNS = 2;

/** Default warmup turns (paper says 3, we use adaptive). */
const DEFAULT_WARMUP_TURNS = 3;

/** Divergence threshold: below this → Continuity (same topic). */
const DEFAULT_THETA_DRIFT = 0.35;

/** Divergence threshold: above this → Transition (new topic). */
const DEFAULT_THETA_TRANSITION = 0.65;

/** Early warmup exit: if turns 1 & 2 diverge this much, skip remaining warmup. */
const WARMUP_EXIT_THRESHOLD = 0.50;

/** Below this confidence, the Synapse system outputs nothing (graceful degradation). */
const CONFIDENCE_FLOOR = 0.30;

/**
 * Stop-words removed from TF-IDF to improve signal-to-noise.
 * Kept small to avoid over-filtering domain terms.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'to', 'is',
  'it', 'that', 'this', 'with', 'on', 'at', 'by', 'from', 'as',
  'be', 'was', 'are', 'were', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'can', 'not', 'but', 'so', 'if', 'then', 'than', 'too', 'very',
  'just', 'about', 'also', 'into', 'some', 'such', 'only', 'other',
  'its', 'his', 'her', 'my', 'your', 'our', 'their', 'what', 'which',
  'who', 'when', 'where', 'how', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'no', 'any', 'i', 'me', 'we', 'you', 'he',
  'she', 'they', 'them', 'us', 'up', 'out', 'there', 'here',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export type SynapseState = 'Continuity' | 'Drift' | 'Transition' | 'Warmup';

export interface DivergenceResult {
  /** Raw divergence score Ω(t) ∈ [0, 1]. 0 = identical, 1 = orthogonal. */
  omega: number;

  /** Current state of the divergence gate. */
  state: SynapseState;

  /** Confidence in this measurement. Below CONFIDENCE_FLOOR → system should degrade gracefully. */
  confidence: number;

  /** Whether the warmup period was exited early due to semantic dissimilarity. */
  earlyWarmupExit: boolean;

  /** The TF-IDF vector for the current query (for centroid engine consumption). */
  queryVector: number[];

  /** Number of vocabulary terms used for this computation. */
  vocabSize: number;
}

export interface DivergenceConfig {
  /** Drift threshold θ_drift. Default 0.35. */
  thetaDrift: number;

  /** Transition threshold θ_transition. Default 0.65. */
  thetaTransition: number;

  /** Number of warmup turns. Default 3 (but adaptive exit may shorten). */
  warmupTurns: number;

  /** Maximum vocabulary size. Default 200. */
  maxVocabSize: number;
}

// ─── TF-IDF Vectorizer ───────────────────────────────────────────────────────

function splitCamelAndSnake(token: string): string[] {
  const parts = token.split(/[_-]+/);
  const result: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    // Split camelCase
    const camelParts = part.split(/(?=[A-Z])/);
    for (const cp of camelParts) {
      if (cp) result.push(cp.toLowerCase());
    }
    if (camelParts.length > 1) {
      result.push(part.toLowerCase());
    }
  }
  if (parts.length > 1) {
    result.push(token.toLowerCase());
  }
  return result;
}

/**
 * Lightweight in-process TF-IDF vectorizer.
 * Builds vocabulary incrementally from registered documents.
 * No external dependencies — pure TypeScript arithmetic.
 */
export class TfIdfVectorizer {
  /** term → index in the vector space */
  private vocabulary: Map<string, number> = new Map();

  /** term → document frequency count */
  private documentFrequency: Map<string, number> = new Map();

  /** Total number of documents registered */
  private documentCount = 0;

  /** Ordered list of terms for consistent vector indexing */
  private termOrder: string[] = [];

  /** Maximum vocabulary size before pruning */
  private maxVocab: number;

  constructor(maxVocab = MAX_VOCAB_SIZE) {
    this.maxVocab = maxVocab;
  }

  /**
   * Tokenize text into normalized terms, removing stop-words and short tokens.
   * Performs camelCase/snake_case splitting and hierarchical N-gram extraction.
   */
  tokenize(text: string): string[] {
    const rawTokens = text
      .replace(/[^a-zA-Z0-9_\-./\\]+/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const unigrams: string[] = [];
    for (const tok of rawTokens) {
      const lowerTok = tok.toLowerCase();
      if (STOP_WORDS.has(lowerTok)) continue;
      const subTokens = splitCamelAndSnake(tok);
      for (const st of subTokens) {
        if (st.length > 2 && !STOP_WORDS.has(st)) {
          unigrams.push(st);
        }
      }
    }
    const ngrams: string[] = [...unigrams];
    // Bigrams
    for (let i = 0; i < unigrams.length - 1; i++) {
      ngrams.push(`${unigrams[i]} ${unigrams[i + 1]}`);
    }
    // Trigrams
    for (let i = 0; i < unigrams.length - 2; i++) {
      ngrams.push(`${unigrams[i]} ${unigrams[i + 1]} ${unigrams[i + 2]}`);
    }

    return ngrams;
  }

  /**
   * Register a new document.
   * Updates vocabulary and document frequency counts.
   */
  addDocument(text: string): void {
    const terms = this.tokenize(text);
    const uniqueTerms = new Set(terms);
    this.documentCount++;

    for (const term of uniqueTerms) {
      this.documentFrequency.set(
        term,
        (this.documentFrequency.get(term) || 0) + 1,
      );

      if (!this.vocabulary.has(term)) {
        if (this.vocabulary.size >= this.maxVocab) {
          this.pruneVocabulary();
        }
        if (this.vocabulary.size < this.maxVocab) {
          const idx = this.termOrder.length;
          this.vocabulary.set(term, idx);
          this.termOrder.push(term);
        }
      }
    }
  }

  /**
   * Compute the TF-IDF vector for a given text.
   * Returns a dense number[] of length = current vocabulary size.
   */
  vectorize(text: string): number[] {
    const terms = this.tokenize(text);
    const dim = this.termOrder.length;
    if (dim === 0) return [];

    // Term frequency
    const tf = new Map<string, number>();
    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    const vector = new Array<number>(dim).fill(0);
    const dynamicStop = this.getDynamicStopWords();

    for (const [term, count] of tf.entries()) {
      const idx = this.vocabulary.get(term);
      if (idx === undefined) continue;
      if (dynamicStop.has(term)) continue;

      // Logarithmic TF
      const logTf = 1 + Math.log(count);

      // Smoothed IDF
      const df = this.documentFrequency.get(term) || 1;
      const idf = Math.log((this.documentCount + 1) / (df + 1)) + 1;

      vector[idx] = logTf * idf;
    }

    return l2Normalize(vector);
  }

  /**
   * Get the current vocabulary size.
   */
  getDimension(): number {
    return this.termOrder.length;
  }

  /** Get dynamic stop words (frequency > 70% in corpus) */
  private getDynamicStopWords(): Set<string> {
    const dynamicStop = new Set<string>();
    if (this.documentCount < 5) return dynamicStop;
    for (const [term, df] of this.documentFrequency.entries()) {
      if (df / this.documentCount > 0.70) {
        dynamicStop.add(term);
      }
    }
    return dynamicStop;
  }

  /**
   * Prune vocabulary to maxVocab by removing lowest-DF terms.
   */
  private pruneVocabulary(): void {
    if (this.vocabulary.size <= this.maxVocab * 0.8) return;

    const sorted = [...this.documentFrequency.entries()]
      .sort((a, b) => b[1] - a[1]);

    const keepCount = Math.floor(this.maxVocab * 0.7);
    const keepTerms = new Set(sorted.slice(0, keepCount).map(([term]) => term));

    this.vocabulary.clear();
    this.termOrder = [];

    for (const term of keepTerms) {
      this.vocabulary.set(term, this.termOrder.length);
      this.termOrder.push(term);
    }

    for (const term of this.documentFrequency.keys()) {
      if (!keepTerms.has(term)) {
        this.documentFrequency.delete(term);
      }
    }
  }

  /**
   * Export state for persistence.
   */
  exportState(): {
    vocabulary: [string, number][];
    documentFrequency: [string, number][];
    documentCount: number;
    termOrder: string[];
  } {
    return {
      vocabulary: [...this.vocabulary.entries()],
      documentFrequency: [...this.documentFrequency.entries()],
      documentCount: this.documentCount,
      termOrder: [...this.termOrder],
    };
  }

  /**
   * Import state from persistence.
   */
  importState(state: {
    vocabulary: [string, number][];
    documentFrequency: [string, number][];
    documentCount: number;
    termOrder: string[];
  }): void {
    this.vocabulary = new Map(state.vocabulary);
    this.documentFrequency = new Map(state.documentFrequency);
    this.documentCount = state.documentCount;
    this.termOrder = [...state.termOrder];
  }
}

// ─── Vector Math ──────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two dense vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * L2-normalize a vector in place.
 */
export function l2Normalize(v: number[]): number[] {
  let mag = 0;
  for (let i = 0; i < v.length; i++) {
    mag += v[i] * v[i];
  }
  mag = Math.sqrt(mag);
  if (mag === 0) return v;
  for (let i = 0; i < v.length; i++) {
    v[i] /= mag;
  }
  return v;
}

/**
 * Compute divergence: Ω(t) = 1 - cos(query, centroid).
 */
export function computeDivergence(queryVector: number[], centroidVector: number[]): number {
  const sim = cosineSimilarity(queryVector, centroidVector);
  return Math.max(0, Math.min(1, 1 - sim));
}

// ─── Divergence Engine ────────────────────────────────────────────────────────

/**
 * The divergence-gated state machine.
 */
export class DivergenceEngine {
  private config: DivergenceConfig;
  private turnCount = 0;
  private warmupComplete = false;
  private earlyWarmupExit = false;
  private smoothedOmega = 0;

  /** Divergence history for adaptive analysis */
  private omegaHistory: number[] = [];

  /** Vectors from warmup turns for early exit detection */
  private warmupVectors: number[][] = [];

  constructor(config?: Partial<DivergenceConfig>) {
    this.config = {
      thetaDrift: config?.thetaDrift ?? DEFAULT_THETA_DRIFT,
      thetaTransition: config?.thetaTransition ?? DEFAULT_THETA_TRANSITION,
      warmupTurns: config?.warmupTurns ?? DEFAULT_WARMUP_TURNS,
      maxVocabSize: config?.maxVocabSize ?? MAX_VOCAB_SIZE,
    };
  }

  /**
   * Evaluate the current turn against the active centroid.
   */
  evaluate(queryVector: number[], activeCentroid: number[]): DivergenceResult {
    this.turnCount++;

    // ── Warmup phase ──────────────────────────────────────────────────────
    if (!this.warmupComplete) {
      this.warmupVectors.push([...queryVector]);

      if (this.turnCount >= MIN_WARMUP_TURNS && this.warmupVectors.length >= 2) {
        const omega01 = computeDivergence(
          this.warmupVectors[0],
          this.warmupVectors[this.warmupVectors.length - 1],
        );

        if (omega01 >= WARMUP_EXIT_THRESHOLD) {
          this.warmupComplete = true;
          this.earlyWarmupExit = true;
          console.log(
            `[DivergenceEngine] ⚡ Early warmup exit at turn ${this.turnCount} (Ω₀₁=${omega01.toFixed(3)} ≥ ${WARMUP_EXIT_THRESHOLD})`,
          );
        }
      }

      if (!this.warmupComplete && this.turnCount < this.config.warmupTurns) {
        return {
          omega: 0,
          state: 'Warmup',
          confidence: 0,
          earlyWarmupExit: false,
          queryVector,
          vocabSize: queryVector.length,
        };
      }

      this.warmupComplete = true;
    }

    // ── Divergence computation & smoothing ──────────────────────────────────
    const rawOmega = computeDivergence(queryVector, activeCentroid);
    if (this.turnCount === 1 || this.smoothedOmega === 0) {
      this.smoothedOmega = rawOmega;
    } else {
      const beta = 0.40; // Blend factor for temporal smoothing
      this.smoothedOmega = beta * rawOmega + (1 - beta) * this.smoothedOmega;
    }

    const omega = this.smoothedOmega;
    this.omegaHistory.push(omega);

    if (this.omegaHistory.length > 50) {
      this.omegaHistory = this.omegaHistory.slice(-50);
    }

    // ── Confidence estimation ─────────────────────────────────────────────
    const vocabConfidence = Math.min(1, queryVector.length / 20);
    const turnConfidence = Math.min(1, this.turnCount / 5);
    const vectorMag = Math.sqrt(queryVector.reduce((s, v) => s + v * v, 0));
    const magConfidence = Math.min(1, vectorMag / 2);
    const confidence = vocabConfidence * 0.3 + turnConfidence * 0.3 + magConfidence * 0.4;

    // ── State evaluation ──────────────────────────────────────────────────
    let state: SynapseState;
    if (omega < this.config.thetaDrift) {
      state = 'Continuity';
    } else if (omega < this.config.thetaTransition) {
      state = 'Drift';
    } else {
      state = 'Transition';
    }

    return {
      omega,
      state,
      confidence,
      earlyWarmupExit: this.earlyWarmupExit,
      queryVector,
      vocabSize: queryVector.length,
    };
  }

  /**
   * Get the trend of divergence over the last N turns.
   */
  getTrend(window = 5): 'stable' | 'increasing' | 'decreasing' {
    if (this.omegaHistory.length < window) return 'stable';

    const recent = this.omegaHistory.slice(-window);
    let increasing = 0;
    let decreasing = 0;

    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1] + 0.05) increasing++;
      else if (recent[i] < recent[i - 1] - 0.05) decreasing++;
    }

    if (increasing > decreasing + 1) return 'increasing';
    if (decreasing > increasing + 1) return 'decreasing';
    return 'stable';
  }

  /**
   * Whether the system should gracefully degrade.
   */
  shouldDegrade(confidence: number): boolean {
    return confidence < CONFIDENCE_FLOOR;
  }

  /**
   * Get the current turn count.
   */
  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * Get divergence history for debugging/analysis.
   */
  getOmegaHistory(): number[] {
    return [...this.omegaHistory];
  }

  /**
   * Reset engine state.
   */
  reset(): void {
    this.turnCount = 0;
    this.warmupComplete = false;
    this.earlyWarmupExit = false;
    this.smoothedOmega = 0;
    this.omegaHistory = [];
    this.warmupVectors = [];
  }

  /**
   * Export state for persistence.
   */
  exportState(): {
    turnCount: number;
    warmupComplete: boolean;
    earlyWarmupExit: boolean;
    omegaHistory: number[];
    warmupVectors: number[][];
    smoothedOmega: number;
  } {
    return {
      turnCount: this.turnCount,
      warmupComplete: this.warmupComplete,
      earlyWarmupExit: this.earlyWarmupExit,
      omegaHistory: [...this.omegaHistory],
      warmupVectors: this.warmupVectors.map(v => [...v]),
      smoothedOmega: this.smoothedOmega,
    };
  }

  /**
   * Import state from persistence.
   */
  importState(state: {
    turnCount: number;
    warmupComplete: boolean;
    earlyWarmupExit: boolean;
    omegaHistory: number[];
    warmupVectors: number[][];
    smoothedOmega?: number;
  }): void {
    this.turnCount = state.turnCount;
    this.warmupComplete = state.warmupComplete;
    this.earlyWarmupExit = state.earlyWarmupExit;
    this.omegaHistory = [...state.omegaHistory];
    this.warmupVectors = state.warmupVectors.map(v => [...v]);
    this.smoothedOmega = state.smoothedOmega ?? (this.omegaHistory.length > 0 ? this.omegaHistory[this.omegaHistory.length - 1] : 0);
  }
}
