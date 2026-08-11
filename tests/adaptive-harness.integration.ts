import assert from 'node:assert/strict';
import { AdaptiveHarness } from '../src/lib/agent/adaptive-harness';

function testDirectAnswersDoNotInheritAWorkflow(): void {
  const harness = new AdaptiveHarness('Explain dependency injection in two paragraphs.', 'direct');
  assert.deepEqual(harness.getOpenObligations(), []);
  assert.deepEqual(harness.selectModes(), ['convergence']);
  assert.equal(harness.reviewCompletion('Dependency injection supplies dependencies from outside an object.').approved, true);
}

function testMutationCreatesCausalVerificationObligation(): void {
  const harness = new AdaptiveHarness('Implement the parser fix and verify it with tests.', 'mutation');
  assert.equal(harness.getOpenObligations().some(item => item.kind === 'produce_outcome'), true);

  harness.recordTool('workspace_read_file', { filename: 'parser.ts' }, { success: true, content: 'old' });
  harness.recordTool('workspace_apply_patch', { filename: 'parser.ts', patch: 'change' }, { success: true, path: 'parser.ts' });
  assert.equal(harness.evidence.currentMutationEpoch(), 1);
  assert.equal(harness.evidence.hasFreshVerificationEvidence(), false);
  assert.equal(harness.getOpenObligations().some(item => item.kind === 'verify_latest_state'), true);

  harness.recordTool('workspace_run_command', { command: 'npm test' }, { success: true, exitCode: 0 });
  assert.equal(harness.evidence.hasFreshVerificationEvidence(), true);
  assert.equal(harness.getOpenObligations().length, 0);
  assert.equal(harness.reviewCompletion('Implemented the parser fix and the focused tests pass.').approved, true);
}

function testLaterMutationInvalidatesEarlierProof(): void {
  const harness = new AdaptiveHarness('Refactor the cache and run the tests.', 'freshness');
  harness.recordTool('workspace_edit_file', { filename: 'cache.ts' }, { success: true, path: 'cache.ts' });
  harness.recordTool('workspace_verify_code', { filename: 'cache.ts' }, { success: true, verified: true });
  assert.equal(harness.evidence.hasFreshVerificationEvidence(), true);

  harness.recordTool('workspace_edit_file', { filename: 'cache.ts' }, { success: true, path: 'cache.ts' });
  assert.equal(harness.evidence.currentMutationEpoch(), 2);
  assert.equal(harness.evidence.hasFreshVerificationEvidence(), false);
  const review = harness.reviewCompletion('The refactor is complete and verified.');
  assert.equal(review.approved, false);
  assert.match(review.issues.join(' '), /Mutation epoch 2|no successful evaluation/i);
}

function testFailedEvaluationTriggersRecoveryAndEvolution(): void {
  const harness = new AdaptiveHarness('Optimize this implementation until the benchmark and tests pass.', 'evolve');
  harness.recordTool('workspace_edit_file', { filename: 'engine.ts' }, { success: true, path: 'engine.ts' });
  harness.recordTool('workspace_run_command', { command: 'npm test' }, { success: false, exitCode: 1, error: 'case A failed' });
  harness.recordTool('workspace_run_command', { command: 'npm run benchmark' }, { success: false, exitCode: 1, error: 'score regressed' });

  const modes = harness.selectModes();
  assert.equal(modes.includes('evolutionary_search'), true);
  assert.equal(modes.includes('recovery'), true);
  assert.equal(harness.rankOperatorFrontier().includes('branch_strategy'), true);
  assert.equal(harness.getOpenObligations().some(item => item.kind === 'repair_failed_evaluation'), true);
}

function testResearchAndExternalActionsUseDifferentProof(): void {
  const research = new AdaptiveHarness('Research the latest agent harness architectures on the web with sources.', 'research');
  assert.equal(research.reviewCompletion('Here is the answer.').approved, false);
  research.recordTool('web_search', { query: 'agent harness architecture' }, { success: true, results: [{ url: 'https://example.test' }] });
  assert.equal(research.reviewCompletion('The sourced synthesis is ready.').approved, true);

  const external = new AdaptiveHarness('Send the approved update to the Slack channel.', 'external');
  assert.equal(external.getOpenObligations().some(item => item.kind === 'complete_external_action'), true);
  external.recordTool('slack_controller', { action: 'send', channel: 'ops' }, { success: true, messageId: 'm-1' });
  assert.equal(external.getOpenObligations().length, 0);
  assert.equal(external.reviewCompletion('Sent the approved update to the ops channel.').approved, true);
}

function testSnapshotSurvivesProviderRetry(): void {
  const first = new AdaptiveHarness('Implement and test the retry-safe change.', 'retry');
  first.recordTool('workspace_edit_file', { filename: 'retry.ts' }, { success: true, path: 'retry.ts' });
  const restored = new AdaptiveHarness(first.objective, 'retry', first.snapshot());

  assert.equal(restored.evidence.currentMutationEpoch(), 1);
  assert.equal(restored.getOpenObligations().some(item => item.kind === 'verify_latest_state'), true);
  restored.recordTool('workspace_run_command', { command: 'npm test' }, { success: true, exitCode: 0 });
  assert.equal(restored.getOpenObligations().length, 0);
}

function testEvolutionaryPortfolioPreservesBestCandidate(): void {
  const harness = new AdaptiveHarness('Optimize the engine until the benchmark score is above 90%.', 'portfolio');
  harness.recordTool('workspace_edit_file', { filename: 'engine.ts', change: 'candidate-a' }, { success: true, path: 'engine.ts' });
  harness.recordTool('workspace_run_command', { command: 'npm run benchmark' }, { success: true, exitCode: 0, score: 92 });
  harness.recordTool('workspace_edit_file', { filename: 'engine.ts', change: 'candidate-b' }, { success: true, path: 'engine.ts' });
  harness.recordTool('workspace_run_command', { command: 'npm run benchmark' }, { success: true, exitCode: 0, score: 80 });

  const portfolio = harness.getStrategyPortfolio();
  assert.deepEqual(portfolio.map(candidate => candidate.score), [92, 80]);
  assert.equal(harness.getOpenObligations().some(item => item.kind === 'preserve_best_candidate'), true);
  assert.equal(harness.reviewCompletion('Optimization is complete.').approved, false);
  assert.match(harness.compileContext(), /never discard the best measured candidate|regressed below best/i);
}

function testProviderNeutrality(): void {
  const providers = ['gemini', 'openai-compatible', 'anthropic'];
  const surfaces = providers.map(provider => {
    const harness = new AdaptiveHarness('Build the feature and verify it.', provider);
    harness.recordTool('workspace_write_file', { filename: 'feature.ts' }, { success: true, path: 'feature.ts' });
    return {
      modes: harness.selectModes(),
      obligations: harness.getOpenObligations().map(item => item.kind),
      frontier: harness.rankOperatorFrontier(),
    };
  });
  assert.deepEqual(surfaces[1], surfaces[0]);
  assert.deepEqual(surfaces[2], surfaces[0]);
}

function main(): void {
  testDirectAnswersDoNotInheritAWorkflow();
  testMutationCreatesCausalVerificationObligation();
  testLaterMutationInvalidatesEarlierProof();
  testFailedEvaluationTriggersRecoveryAndEvolution();
  testResearchAndExternalActionsUseDifferentProof();
  testSnapshotSurvivesProviderRetry();
  testEvolutionaryPortfolioPreservesBestCandidate();
  testProviderNeutrality();
  console.log('Adaptive harness integration checks passed.');
}

main();
