import {
  selectContextByResonance,
  type ResonanceCandidate,
} from '../src/lib/agent/memory/context-resonance';
import type { SynapseState } from '../src/lib/agent/memory/divergence';

type Scenario = {
  name: string;
  state: SynapseState;
  budget: number;
  maxItems: number;
  candidates: ResonanceCandidate[];
  relevant: Set<string>;
};

const c = (id: string, content: string, values: Partial<ResonanceCandidate> = {}): ResonanceCandidate => ({
  id,
  content,
  tier: 3,
  semanticSimilarity: 0.5,
  confidence: 0.7,
  freshness: 0.7,
  causalSupport: 0,
  validated: false,
  injectionCount: 0,
  estimatedTokens: 70,
  ...values,
});

const scenarios: Scenario[] = [
  {
    name: 'duplicate-flood', state: 'Drift', budget: 220, maxItems: 3,
    candidates: [
      c('symptom-a', 'TypeScript failed because ProjectContext has no workspaceId property', { semanticSimilarity: 0.96 }),
      c('symptom-b', 'Build failure: workspaceId is missing from ProjectContext type', { semanticSimilarity: 0.95 }),
      c('symptom-c', 'ProjectContext type error says workspaceId does not exist', { semanticSimilarity: 0.94 }),
      c('root-cause', 'Orchestrator adds workspaceId dynamically before every provider loop', { semanticSimilarity: 0.77, causalSupport: 1, validated: true }),
      c('verification', 'Typecheck passed after declaring workspaceId on RuntimeProjectContext', { semanticSimilarity: 0.70, causalSupport: 0.8, validated: true }),
    ],
    relevant: new Set(['symptom-a', 'root-cause', 'verification']),
  },
  {
    name: 'repetition-fatigue', state: 'Continuity', budget: 80, maxItems: 1,
    candidates: [
      c('old-repeat', 'The command npm test fails in the context suite', { semanticSimilarity: 0.95, injectionCount: 14 }),
      c('new-proof', 'The focused context test now passes after causal evidence routing', { semanticSimilarity: 0.76, validated: true, freshness: 1 }),
    ],
    relevant: new Set(['new-proof']),
  },
  {
    name: 'topic-transition', state: 'Transition', budget: 80, maxItems: 1,
    candidates: [
      c('recent-noise', 'Latest visual theme palette and CSS token list', { semanticSimilarity: 0.04, freshness: 1 }),
      c('older-topic', 'Synapse graph context injection token routing and retrieval', { semanticSimilarity: 0.97, freshness: 0.25 }),
    ],
    relevant: new Set(['older-topic']),
  },
  {
    name: 'causal-bridge', state: 'Drift', budget: 150, maxItems: 2,
    candidates: [
      c('lexical-match', 'Context timeout context timeout context timeout', { semanticSimilarity: 0.98 }),
      c('tool-evidence', 'Exit code 1 at line 742', { semanticSimilarity: 0.18, causalSupport: 1, validated: true }),
      c('unrelated', 'Browser screenshot dimensions are 1280 by 720', { semanticSimilarity: 0.12, freshness: 1 }),
    ],
    relevant: new Set(['lexical-match', 'tool-evidence']),
  },
];

function baselineSelect(scenario: Scenario): string[] {
  let used = 0;
  const selected: string[] = [];
  const ranked = [...scenario.candidates].sort((a, b) => {
    const score = (item: ResonanceCandidate) => item.semanticSimilarity * 0.65 + item.confidence * 0.2 + item.freshness * 0.15;
    return score(b) - score(a);
  });
  for (const item of ranked) {
    if (selected.length >= scenario.maxItems) break;
    if (used + item.estimatedTokens > scenario.budget) continue;
    selected.push(item.id);
    used += item.estimatedTokens;
  }
  return selected;
}

function score(selected: string[], relevant: Set<string>) {
  const hits = selected.filter(id => relevant.has(id)).length;
  return {
    precision: selected.length ? hits / selected.length : 0,
    recall: relevant.size ? hits / relevant.size : 0,
    hits,
  };
}

let baselinePrecision = 0;
let baselineRecall = 0;
let resonancePrecision = 0;
let resonanceRecall = 0;

console.log('EterX Context Resonance synthetic adversarial benchmark');
console.log('scenario\tbaseline(P/R)\tresonance(P/R)\tbaseline ids\tresonance ids');
for (const scenario of scenarios) {
  const baseline = baselineSelect(scenario);
  const resonance = selectContextByResonance(scenario.candidates, scenario.state, scenario.budget, scenario.maxItems)
    .selected.map(item => item.candidate.id);
  const b = score(baseline, scenario.relevant);
  const r = score(resonance, scenario.relevant);
  baselinePrecision += b.precision;
  baselineRecall += b.recall;
  resonancePrecision += r.precision;
  resonanceRecall += r.recall;
  console.log(`${scenario.name}\t${b.precision.toFixed(2)}/${b.recall.toFixed(2)}\t${r.precision.toFixed(2)}/${r.recall.toFixed(2)}\t${baseline.join(',')}\t${resonance.join(',')}`);
}

const count = scenarios.length;
console.log(JSON.stringify({
  benchmark: 'synthetic-adversarial-v1',
  scenarios: count,
  baseline: { meanPrecision: baselinePrecision / count, meanRecall: baselineRecall / count },
  contextResonance: { meanPrecision: resonancePrecision / count, meanRecall: resonanceRecall / count },
}, null, 2));
