import type { SynapseState } from './divergence';

export interface ResonanceCandidate {
  id: string;
  content: string;
  tier: 1 | 2 | 3;
  semanticSimilarity: number;
  confidence: number;
  freshness: number;
  causalSupport: number;
  validated: boolean;
  injectionCount: number;
  estimatedTokens: number;
}

export interface ResonanceSelection {
  candidate: ResonanceCandidate;
  utility: number;
  selectionScore: number;
  redundancy: number;
  reason: string;
}

export interface ResonanceSelectionResult {
  selected: ResonanceSelection[];
  usedTokens: number;
  rejectedByBudget: number;
  meanUtility: number;
  diversity: number;
}

const STATE_WEIGHTS: Record<SynapseState, {
  semantic: number;
  confidence: number;
  freshness: number;
  causal: number;
  validation: number;
}> = {
  Warmup: { semantic: 0.28, confidence: 0.24, freshness: 0.28, causal: 0.08, validation: 0.12 },
  Continuity: { semantic: 0.27, confidence: 0.25, freshness: 0.20, causal: 0.13, validation: 0.15 },
  Drift: { semantic: 0.36, confidence: 0.20, freshness: 0.12, causal: 0.17, validation: 0.15 },
  Transition: { semantic: 0.43, confidence: 0.20, freshness: 0.10, causal: 0.15, validation: 0.12 },
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_./\\-]+/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function maxRedundancy(candidate: Set<string>, selected: Array<Set<string>>): number {
  let max = 0;
  for (const existing of selected) max = Math.max(max, jaccard(candidate, existing));
  return max;
}

function baseUtility(candidate: ResonanceCandidate, state: SynapseState): number {
  if (candidate.tier === 1) return 2 + clamp01(candidate.confidence);
  const weights = STATE_WEIGHTS[state];
  const evidence = candidate.validated ? 1 : 0;
  const raw =
    clamp01(candidate.semanticSimilarity) * weights.semantic +
    clamp01(candidate.confidence) * weights.confidence +
    clamp01(candidate.freshness) * weights.freshness +
    clamp01(candidate.causalSupport) * weights.causal +
    evidence * weights.validation;

  // Repeated context consumes attention even when it remains relevant. The
  // fatigue curve is deliberately gentle so durable facts remain retrievable.
  const fatigue = 1 / (1 + Math.max(0, candidate.injectionCount) * 0.16);
  return raw * fatigue;
}

/**
 * Greedy budgeted maximum-marginal-relevance selection.
 *
 * Unlike a top-k relevance list, this objective rewards causal/validated
 * evidence and penalizes near-duplicate context. It is deterministic so the
 * same graph state produces the same capsule and can be benchmarked.
 */
export function selectContextByResonance(
  candidates: ResonanceCandidate[],
  state: SynapseState,
  tokenBudget: number,
  maxItems = 18,
): ResonanceSelectionResult {
  const budget = Math.max(0, Math.floor(tokenBudget));
  const remaining = candidates
    .filter(candidate => candidate.content.trim() && candidate.estimatedTokens > 0)
    .map(candidate => ({
      candidate,
      utility: baseUtility(candidate, state),
      tokenSet: tokens(candidate.content),
    }));
  const selected: ResonanceSelection[] = [];
  const selectedTokens: Array<Set<string>> = [];
  let usedTokens = 0;
  let rejectedByBudget = 0;

  while (remaining.length > 0 && selected.length < maxItems) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestRedundancy = 0;

    for (let index = 0; index < remaining.length; index++) {
      const item = remaining[index];
      const cost = item.candidate.estimatedTokens;
      if (usedTokens + cost > budget) continue;
      const redundancy = maxRedundancy(item.tokenSet, selectedTokens);
      const diversityPenalty = item.candidate.tier === 1 ? 0 : redundancy * 0.34;
      const lengthPenalty = item.candidate.tier === 1 ? 1 : 1 + Math.max(0, cost - 180) / 900;
      const score = (item.utility - diversityPenalty) / lengthPenalty;
      if (score > bestScore || (score === bestScore && item.candidate.id < (remaining[bestIndex]?.candidate.id || ''))) {
        bestIndex = index;
        bestScore = score;
        bestRedundancy = redundancy;
      }
    }

    if (bestIndex < 0) {
      rejectedByBudget += remaining.length;
      break;
    }

    const [best] = remaining.splice(bestIndex, 1);
    // Negative marginal utility means the capsule is better without this item.
    if (bestScore <= 0 && best.candidate.tier !== 1) continue;
    selected.push({
      candidate: best.candidate,
      utility: best.utility,
      selectionScore: bestScore,
      redundancy: bestRedundancy,
      reason: [
        `semantic=${clamp01(best.candidate.semanticSimilarity).toFixed(2)}`,
        `trust=${clamp01(best.candidate.confidence).toFixed(2)}`,
        `fresh=${clamp01(best.candidate.freshness).toFixed(2)}`,
        `causal=${clamp01(best.candidate.causalSupport).toFixed(2)}`,
        best.candidate.validated ? 'validated' : 'unvalidated',
        `redundancy=${bestRedundancy.toFixed(2)}`,
      ].join(', '),
    });
    selectedTokens.push(best.tokenSet);
    usedTokens += best.candidate.estimatedTokens;
  }

  const meanUtility = selected.length
    ? selected.reduce((sum, item) => sum + item.utility, 0) / selected.length
    : 0;
  const diversity = selected.length <= 1
    ? 1
    : 1 - selected.reduce((sum, item) => sum + item.redundancy, 0) / selected.length;

  return { selected, usedTokens, rejectedByBudget, meanUtility, diversity };
}

export function adaptiveResonanceBudget(state: SynapseState, recordCount: number): number {
  const base: Record<SynapseState, number> = {
    Warmup: 1200,
    Continuity: 1800,
    Drift: 3000,
    Transition: 4200,
  };
  const scale = Math.min(1.35, 1 + Math.log10(Math.max(1, recordCount)) * 0.08);
  return Math.round(base[state] * scale);
}
