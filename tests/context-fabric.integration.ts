import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {
  ContextFabric,
  auditContinuityCapsule,
  repairContinuityCapsule,
} from '../src/lib/agent/context-fabric';

async function withTemporaryRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-context-fabric-'));
  try {
    await run(root);
  } finally {
    await fs.remove(root);
  }
}

async function testLosslessPageRoundTrip(): Promise<void> {
  await withTemporaryRoot(async root => {
    const fabric = new ContextFabric('lossless-page', { storageRoot: root });
    await fabric.initialize();
    const request = 'Implement the context fabric. Never use git. Preserve exact value run_abc12345 and C:\\workspace\\agent.ts.';
    fabric.observeUserRequest(request);
    await fabric.flush();

    const episode = fabric.listEpisodes().find(item => item.source === 'user');
    assert.ok(episode?.pageRef);
    const recovered = await fabric.openPage(episode!.pageRef) as any;
    assert.equal(recovered.request, request);
    assert.equal(episode!.contentHash.length, 64);
    assert.ok(fabric.buildContinuityManifest().pageRefs.includes(episode!.pageRef));
  });
}

async function testRawToolResultSurvivesPromptCompaction(): Promise<void> {
  await withTemporaryRoot(async root => {
    const fabric = new ContextFabric('raw-tool-page', { storageRoot: root });
    await fabric.initialize();
    const sentinel = 'EXACT_MIDDLE_EVIDENCE_7f9c2a';
    const raw = { success: true, stdout: `${'head '.repeat(5_000)}${sentinel}${' tail'.repeat(5_000)}`, exitCode: 0 };
    const promptSized = { success: true, stdout: 'head ... compacted ... tail', exitCode: 0, _compacted: true };
    fabric.recordTool('workspace_run_command', { command: 'verify-all' }, promptSized, raw);
    await fabric.flush();
    const episode = fabric.listEpisodes().find(item => item.toolName === 'workspace_run_command')!;
    const recovered = await fabric.openPage(episode.pageRef) as any;
    assert.match(recovered.result.stdout, new RegExp(sentinel));
    assert.equal(recovered.result._compacted, undefined);
  });
}

function testBitemporalContradictionsPreserveHistory(): void {
  const fabric = new ContextFabric('bitemporal', { durable: false });
  const first = fabric.remember({
    key: 'state:provider-quality',
    kind: 'state',
    epistemic: 'observed',
    importance: 9,
    text: 'Provider quality state is Gemini-only.',
  });
  const second = fabric.remember({
    key: 'state:provider-quality',
    kind: 'state',
    epistemic: 'observed',
    importance: 10,
    text: 'Provider quality state is equal across Gemini, Anthropic, OpenAI, and Mistral.',
  });

  const facts = fabric.listFacts();
  const historical = facts.find(fact => fact.id === first.id)!;
  const current = facts.find(fact => fact.id === second.id)!;
  assert.equal(historical.status, 'superseded');
  assert.equal(historical.supersededBy, current.id);
  assert.ok(historical.validTo);
  assert.equal(current.status, 'active');
  assert.equal(current.validTo, undefined);
  assert.ok(fabric.listLinks().some(link =>
    link.fromFactId === historical.id
    && link.toFactId === current.id
    && link.relation === 'contradicts'));
}

async function testEphemeralSnapshotKeepsExactPages(): Promise<void> {
  const first = new ContextFabric('ephemeral-pages', { durable: false });
  first.observeUserRequest('Private in-memory request with exact token ephemeral_42.');
  const snapshot = first.snapshot();
  const restored = new ContextFabric('ephemeral-pages', { durable: false, snapshot });
  const pageRef = restored.listEpisodes()[0].pageRef;
  const raw = await restored.openPage(pageRef) as any;
  assert.match(raw.request, /ephemeral_42/);
}

function testGraphRetrievalBridgesVocabularyMismatch(): void {
  const fabric = new ContextFabric('graph-retrieval', { durable: false });
  const evidence = fabric.remember({
    kind: 'evidence',
    epistemic: 'observed',
    text: 'The cobalt checksum detects stale eviction records.',
    targets: ['src/cache-engine.ts'],
  });
  const decision = fabric.remember({
    kind: 'decision',
    epistemic: 'inferred',
    text: 'Retain the dual-clock invalidation architecture.',
    targets: ['src/cache-engine.ts'],
  });
  const result = fabric.search('cobalt checksum eviction', 1_500);
  assert.ok(result.facts.some(fact => fact.id === evidence.id));
  assert.ok(result.facts.some(fact => fact.id === decision.id));
  assert.ok(result.strategyCounts.graph > 0);
}

function testRepeatedCompactionCannotLoseBindingFacts(): void {
  const fabric = new ContextFabric('repeated-compaction', { durable: false });
  fabric.observeUserRequest('Build the advanced harness. Do not use git. Every provider must receive equal context quality.');
  fabric.remember({ kind: 'next_action', text: 'Run contradiction and restart tests.', importance: 9 });
  const manifest = fabric.buildContinuityManifest();

  const first = repairContinuityCapsule('# Active objective\nBuild the advanced harness.', manifest);
  assert.equal(first.audit.missingFactIds.length, 0);
  assert.equal(auditContinuityCapsule(first.capsule, manifest).coverageRatio, 1);
  const second = repairContinuityCapsule(first.capsule, manifest);
  assert.equal(second.capsule, first.capsule);
  for (const fact of manifest.facts) assert.match(second.capsule, new RegExp(`ctx:${fact.id}`));
}

function testPolicyLearnsFromContinuityFailure(): void {
  const fabric = new ContextFabric('policy-learning', { durable: false });
  fabric.observeUserRequest('Preserve exact constraints and verification state.');
  const manifest = fabric.buildContinuityManifest();
  const audit = auditContinuityCapsule('A capsule that omitted everything.', manifest);
  fabric.recordCompactionFeedback(audit, manifest);
  const policy = fabric.getMemoryPolicy();
  assert.equal(policy.failedOutcomes, 1);
  assert.ok(policy.learnedGuidelines.some(guideline => /omitted|retain and re-check/i.test(guideline)));
}

async function testRestartRestoresPagesGraphAndPolicy(): Promise<void> {
  await withTemporaryRoot(async root => {
    const first = new ContextFabric('restart', { storageRoot: root });
    await first.initialize();
    first.observeUserRequest('Keep raw observations across restart. Never use git.');
    first.remember({ kind: 'decision', text: 'Use lossless pages plus temporal graph retrieval.', targets: ['context-fabric.ts'] });
    first.recordContextFailure('A prior capsule lost the decision.', ['decision']);
    await first.flush();
    const snapshot = first.snapshot();

    const restored = new ContextFabric('restart', { storageRoot: root });
    await restored.initialize();
    assert.equal(restored.listFacts().length, snapshot.facts.length);
    assert.equal(restored.listEpisodes().length, snapshot.episodes!.length);
    assert.equal(restored.listLinks().length, snapshot.links!.length);
    assert.equal(restored.getMemoryPolicy().failedOutcomes, 1);
    const requestPage = restored.listEpisodes().find(item => item.source === 'user')!;
    const raw = await restored.openPage(requestPage.pageRef) as any;
    assert.match(raw.request, /Never use git/);
  });
}

function testProviderNeutralWorkingSet(): void {
  const source = new ContextFabric('provider-neutral', { durable: false });
  source.observeUserRequest('All model providers must get equal memory quality.');
  source.recordTool('workspace_apply_patch', { filename: 'provider.ts' }, { success: true, path: 'provider.ts' });
  const snapshot = source.snapshot();
  const outputs = ['gemini', 'anthropic', 'openai', 'mistral'].map(() => {
    const fabric = new ContextFabric('provider-neutral', { durable: false, snapshot });
    return {
      manifest: fabric.buildContinuityManifest().facts.map(fact => ({
        id: fact.id,
        kind: fact.kind,
        text: fact.text,
        pages: fact.pageRefs,
      })),
      workingSet: fabric.compileWorkingSet('provider memory quality', 12_000),
    };
  });
  assert.deepEqual(outputs[1], outputs[0]);
  assert.deepEqual(outputs[2], outputs[0]);
  assert.deepEqual(outputs[3], outputs[0]);
}

async function main(): Promise<void> {
  await testLosslessPageRoundTrip();
  await testRawToolResultSurvivesPromptCompaction();
  testBitemporalContradictionsPreserveHistory();
  await testEphemeralSnapshotKeepsExactPages();
  testGraphRetrievalBridgesVocabularyMismatch();
  testRepeatedCompactionCannotLoseBindingFacts();
  testPolicyLearnsFromContinuityFailure();
  await testRestartRestoresPagesGraphAndPolicy();
  testProviderNeutralWorkingSet();
  console.log('Context Fabric integration checks passed.');
}

void main();
