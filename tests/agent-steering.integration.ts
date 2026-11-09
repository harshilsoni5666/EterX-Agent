import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { AgentOrchestrator } from '../src/lib/agent/orchestrator';
import { agentRegistry } from '../src/lib/agent/agent-registry';
import { POST as postSteer } from '../src/app/api/agent/steer/route';

type ControlledRun = {
  chatId: string;
  runId: string;
  release: () => void;
  gateKeys: string[];
};

const originalExecutePipeline = AgentOrchestrator.prototype.executePipeline;
const gates = new Map<string, { entered: Promise<void>; resolveEntered: () => void; release: Promise<void>; resolveRelease: () => void }>();

(AgentOrchestrator.prototype as any).executePipeline = async (_userId: string, projectId: string) => {
  const gate = gates.get(projectId);
  if (!gate) throw new Error(`Missing test gate for ${projectId}`);
  gate.resolveEntered();
  await gate.release;
  return { success: true, finalAnswer: 'controlled test answer', modelMode: 'think' };
};

async function startControlledRun(chatId: string, runId: string, telegramChatId?: string): Promise<ControlledRun> {
  let resolveEntered!: () => void;
  let resolveRelease!: () => void;
  const gate = {
    entered: new Promise<void>(resolve => { resolveEntered = resolve; }),
    resolveEntered,
    release: new Promise<void>(resolve => { resolveRelease = resolve; }),
    resolveRelease,
  };
  const gateKeys = [chatId];
  if (telegramChatId) gateKeys.push(`telegram-${telegramChatId}`);
  gateKeys.forEach(key => gates.set(key, gate));

  const result = agentRegistry.startAgent(
    chatId,
    'controlled steering test',
    [],
    'think',
    'test-user',
    {
      disableTaskStore: true,
      disableWorkspaceInit: true,
      disableMemoryHydration: true,
      disableLongTermMemory: true,
      persistSession: false,
      exportTranscript: false,
      selectedModelProvider: 'openai',
      selectedModelName: 'test-model',
      ...(telegramChatId ? { telegram: { chatId: telegramChatId } } : {}),
    },
    [],
    'Test User',
    undefined,
    undefined,
    runId,
  );
  assert.equal(result.status, 'started');
  await gate.entered;
  return { chatId, runId, release: resolveRelease, gateKeys };
}

async function settle(run: ControlledRun): Promise<void> {
  agentRegistry.stopAgent(run.chatId, 'test cleanup', undefined, run.runId);
  run.release();
  await agentRegistry.waitForStoppedRunToSettle(run.chatId, 2_000);
  run.gateKeys.forEach(key => gates.delete(key));
}

async function testRunOwnershipAndRuntimeAliasIsolation(): Promise<void> {
  const runA = await startControlledRun(`steering-a-${Date.now()}`, `run-a-${Date.now()}`);
  const runB = await startControlledRun(`steering-b-${Date.now()}`, `run-b-${Date.now()}`);
  try {
    assert.equal(
      agentRegistry.addSteeringMessage(runA.chatId, 'wrong run', 'wrong-run-id', undefined, runB.runId),
      false,
      'a steering message for another run must be rejected',
    );
    assert.deepEqual(agentRegistry.peekSteeringQueue(runA.chatId), []);

    assert.equal(
      agentRegistry.addSteeringMessage(runB.chatId, 'right run', 'right-run-id', undefined, runB.runId),
      true,
    );
    assert.deepEqual(agentRegistry.peekSteeringQueue(runB.chatId).map(item => item.text), ['right run']);
  } finally {
    await settle(runA);
    await settle(runB);
  }

  const alias = `telegram-alias-${Date.now()}`;
  const aliasedRun = await startControlledRun(`steering-owner-${Date.now()}`, `run-alias-${Date.now()}`, alias);
  try {
    assert.equal(
      agentRegistry.addSteeringMessage(alias, 'must not cross chats', 'alias-id'),
      false,
      'a runtime alias must not admit steering into a different chat key',
    );
  } finally {
    await settle(aliasedRun);
  }
}

async function testRouteBindsLegacyAdmissionToCurrentRun(): Promise<void> {
  const run = await startControlledRun(`steering-route-${Date.now()}`, `run-route-${Date.now()}`);
  try {
    const staleResponse = await postSteer(new NextRequest('http://localhost/api/agent/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: run.chatId, message: 'stale route guidance', runId: 'different-run' }),
    }));
    assert.equal(staleResponse.status, 409);
    assert.deepEqual(agentRegistry.peekSteeringQueue(run.chatId), []);
    const sessionCookie = staleResponse.headers.get('set-cookie')?.split(';', 1)[0] || '';

    // Older clients may omit runId. The route must bind that request to the
    // run it observed, rather than allowing a later successor to receive it.
    const legacyResponse = await postSteer(new NextRequest('http://localhost/api/agent/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sessionCookie ? { cookie: sessionCookie } : {}) },
      body: JSON.stringify({ chatId: run.chatId, message: 'legacy route guidance' }),
    }));
    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(agentRegistry.peekSteeringQueue(run.chatId).map(item => item.text), ['legacy route guidance']);
  } finally {
    await settle(run);
  }
}

async function testDuplicateSteeringIdsAreIdempotent(): Promise<void> {
  const run = await startControlledRun(`steering-duplicate-${Date.now()}`, `run-duplicate-${Date.now()}`);
  try {
    assert.equal(agentRegistry.addSteeringMessage(run.chatId, 'original guidance', 'same-id', undefined, run.runId), true);
    assert.equal(agentRegistry.addSteeringMessage(run.chatId, 'rewritten guidance', 'same-id', undefined, run.runId), true);
    assert.deepEqual(
      agentRegistry.peekSteeringQueue(run.chatId).map(item => item.text),
      ['original guidance'],
      'a retry must not rewrite or duplicate an already-admitted message',
    );

    const queuedBeforeDrain = agentRegistry.getTraces(run.chatId, -1).traces.filter(trace => trace.type === 'steering_queued');
    assert.equal(queuedBeforeDrain.length, 1);
    assert.equal(agentRegistry.drainSteeringQueue(run.chatId).length, 1);
    assert.equal(agentRegistry.addSteeringMessage(run.chatId, 'late duplicate', 'same-id', undefined, run.runId), true);
    assert.deepEqual(agentRegistry.peekSteeringQueue(run.chatId), [], 'an applied ID must remain idempotent');
    const queuedAfterRetry = agentRegistry.getTraces(run.chatId, -1).traces.filter(trace => trace.type === 'steering_queued');
    assert.equal(queuedAfterRetry.length, 1);
  } finally {
    await settle(run);
  }
}

async function testStopDropsUndrainedGuidance(): Promise<void> {
  const run = await startControlledRun(`steering-stop-${Date.now()}`, `run-stop-${Date.now()}`);
  try {
    assert.equal(agentRegistry.addSteeringMessage(run.chatId, 'stale after stop', 'stop-id', undefined, run.runId), true);
    assert.equal(agentRegistry.stopAgent(run.chatId, 'test stop', undefined, run.runId), true);
    assert.deepEqual(agentRegistry.peekSteeringQueue(run.chatId), [], 'stop must discard undrained guidance');
    assert.deepEqual(agentRegistry.drainSteeringQueue(run.chatId), [], 'a stopped run must not drain guidance');
    assert.equal(agentRegistry.addSteeringMessage(run.chatId, 'too late', 'late-id', undefined, run.runId), false);
    run.release();
    await agentRegistry.waitForStoppedRunToSettle(run.chatId, 2_000);
    run.gateKeys.forEach(key => gates.delete(key));
  } finally {
    if (gates.has(run.chatId)) await settle(run);
  }
}

async function main(): Promise<void> {
  try {
    await testRunOwnershipAndRuntimeAliasIsolation();
    await testRouteBindsLegacyAdmissionToCurrentRun();
    await testDuplicateSteeringIdsAreIdempotent();
    await testStopDropsUndrainedGuidance();
    console.log('Agent steering integration checks passed.');
  } finally {
    (AgentOrchestrator.prototype as any).executePipeline = originalExecutePipeline;
    gates.clear();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
