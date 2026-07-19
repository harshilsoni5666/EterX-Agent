import assert from 'node:assert/strict';
import {
  adaptiveResonanceBudget,
  selectContextByResonance,
  type ResonanceCandidate,
} from '../src/lib/agent/memory/context-resonance';
import { SynapseGraph } from '../src/lib/agent/memory/synapse-graph';

function candidate(overrides: Partial<ResonanceCandidate> & Pick<ResonanceCandidate, 'id' | 'content'>): ResonanceCandidate {
  return {
    tier: 3,
    semanticSimilarity: 0.6,
    confidence: 0.7,
    freshness: 0.7,
    causalSupport: 0,
    validated: false,
    injectionCount: 0,
    estimatedTokens: 80,
    ...overrides,
  };
}

function main() {
  const diverse = selectContextByResonance([
    candidate({ id: 'duplicate-a', content: 'TypeScript build failed in agent runner because ProjectContext lacks workspaceId', semanticSimilarity: 0.91 }),
    candidate({ id: 'duplicate-b', content: 'TypeScript build failed in the agent runner: ProjectContext has no workspaceId', semanticSimilarity: 0.90 }),
    candidate({ id: 'causal-fix', content: 'The workspaceId value is supplied by orchestrator before the provider loop starts', semanticSimilarity: 0.78, causalSupport: 1, validated: true }),
  ], 'Drift', 170, 2);

  assert.equal(diverse.selected.length, 2, 'the selector should fill the two-item budget');
  assert.ok(diverse.selected.some(item => item.candidate.id === 'causal-fix'), 'causal validated evidence should survive duplicate pressure');
  assert.ok(
    !(diverse.selected.some(item => item.candidate.id === 'duplicate-a') && diverse.selected.some(item => item.candidate.id === 'duplicate-b')),
    'near-duplicate memories should not consume the entire capsule',
  );
  assert.ok(diverse.diversity > 0.5, 'selection telemetry should report useful diversity');

  const transition = selectContextByResonance([
    candidate({ id: 'fresh-irrelevant', content: 'Latest CSS theme color inventory', semanticSimilarity: 0.05, freshness: 1 }),
    candidate({ id: 'older-relevant', content: 'Synapse graph context injection and token budget routing', semanticSimilarity: 0.96, freshness: 0.35 }),
  ], 'Transition', 80, 1);
  assert.equal(transition.selected[0]?.candidate.id, 'older-relevant', 'topic transitions must prefer semantic resonance over raw recency');

  const fatigue = selectContextByResonance([
    candidate({ id: 'repeated', content: 'Repeated but relevant build fact', semanticSimilarity: 0.9, injectionCount: 12 }),
    candidate({ id: 'new-evidence', content: 'New verification evidence from the latest test run', semanticSimilarity: 0.72, validated: true }),
  ], 'Continuity', 80, 1);
  assert.equal(fatigue.selected[0]?.candidate.id, 'new-evidence', 'repetition fatigue should make room for new evidence');

  const constrained = selectContextByResonance([
    candidate({ id: 'too-large', content: 'large artifact', estimatedTokens: 500, semanticSimilarity: 1 }),
    candidate({ id: 'fits', content: 'compact verified fact', estimatedTokens: 40, validated: true }),
  ], 'Continuity', 50);
  assert.deepEqual(constrained.selected.map(item => item.candidate.id), ['fits']);
  assert.ok(constrained.usedTokens <= 50, 'selection must never exceed its token budget');

  assert.ok(adaptiveResonanceBudget('Transition', 500) > adaptiveResonanceBudget('Continuity', 500));
  assert.ok(adaptiveResonanceBudget('Continuity', 500) > adaptiveResonanceBudget('Warmup', 500));

  const graph = new SynapseGraph();
  graph.processTurn('Fix the agent context injection timeout in the Synapse Graph');
  graph.registerToolResult(
    'workspace_read_file',
    { filename: 'src/lib/agent/memory/synapse-graph.ts' },
    'The timeout comes from repeating the same context record after every tool call.',
  );
  const firstPulse = graph.refreshReasoningContext('Fix the agent context injection timeout in the Synapse Graph');
  assert.match(firstPulse.renderedContext, /repeating the same context record/i, 'new tool evidence should enter the next reasoning pulse');
  assert.ok(firstPulse.selectedNewEvidence > 0);
  const repeatedPulse = graph.refreshReasoningContext('Fix the agent context injection timeout in the Synapse Graph');
  assert.equal(repeatedPulse.selectedNewEvidence, 0, 'the same evidence must not be re-injected within one turn');

  console.log('context resonance integration ok');
}

main();
