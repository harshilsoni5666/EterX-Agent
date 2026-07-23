import assert from 'node:assert/strict';
import { adaptiveResonanceBudget, selectContextByResonance, type ResonanceCandidate } from '../src/lib/agent/memory/context-resonance';

const candidate = (id: string, content: string, values: Partial<ResonanceCandidate> = {}): ResonanceCandidate => ({
  id,
  content,
  tier: 3,
  semanticSimilarity: 0.5,
  confidence: 0.7,
  freshness: 0.7,
  causalSupport: 0,
  validated: false,
  injectionCount: 0,
  estimatedTokens: 60,
  ...values,
});

function main(): void {
  const result = selectContextByResonance([
    candidate('duplicate-a', 'ProjectContext workspaceId type error during build', { semanticSimilarity: 0.98 }),
    candidate('duplicate-b', 'Build type error because workspaceId is absent from ProjectContext', { semanticSimilarity: 0.97 }),
    candidate('root-cause', 'Orchestrator dynamically assigns workspaceId without declaring it', { semanticSimilarity: 0.78, causalSupport: 1, validated: true }),
    candidate('proof', 'Typecheck passed after declaring the runtime field', { semanticSimilarity: 0.7, causalSupport: 0.8, validated: true }),
  ], 'Drift', 180, 3);

  const ids = result.selected.map(item => item.candidate.id);
  assert.ok(ids.includes('root-cause'));
  assert.ok(ids.includes('proof'));
  assert.ok(!(ids.includes('duplicate-a') && ids.includes('duplicate-b')));
  assert.ok(result.usedTokens <= 180);
  assert.ok(result.diversity > 0.4);
  assert.ok(adaptiveResonanceBudget('Transition', 1000) > adaptiveResonanceBudget('Warmup', 1000));
  console.log('Context resonance integration checks passed.');
}

main();
