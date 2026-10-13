import assert from 'node:assert/strict';
import {
  DEFAULT_SUB_AGENT_RUNTIME_SETTINGS,
  buildSubAgentPinnedContext,
  normalizeSubAgentRuntimeSettings,
} from '../src/lib/agent/sub-agent-settings';
import { buildSubAgentStrategy } from '../src/lib/agent/roles/sub_agent_strategy';
import {
  SubAgentSpawner,
  agentMessageBus,
  clearPendingResults,
  resetCancelFlag,
} from '../src/lib/agent/roles/sub_agent';
import { interAgentMailbox } from '../src/lib/agent/roles/inter_agent_comm';
import { spawnSubAgentTool } from '../src/lib/agent/tools/core/spawn_sub_agent';
import { swarmCoordinator } from '../src/lib/agent/swarm-coordinator';
import { assessDelegatedAgent } from '../src/lib/agent/delegation-evidence';

const uniqueId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

function recommendedAgentCount(strategy: ReturnType<typeof buildSubAgentStrategy>): number {
  const call = strategy.recommendedToolCall;
  if (!call) return 0;
  if (call.mode === 'specialist') return call.tasks.length;
  if (call.mode === 'spawn') return call.tasks.length;
  return strategy.estimatedAgentCount;
}

function testDelegationRequiresExplicitOptIn(): void {
  assert.equal(
    DEFAULT_SUB_AGENT_RUNTIME_SETTINGS.enabled,
    false,
    'fresh installs must not grant background-agent spawning by default',
  );

  const omitted = normalizeSubAgentRuntimeSettings({});
  assert.equal(omitted.enabled, false, 'missing or legacy settings must fail closed');
  assert.deepEqual(buildSubAgentPinnedContext(omitted), {
    disableSubAgents: true,
    allowAgentSpawning: false,
    maxSubAgents: DEFAULT_SUB_AGENT_RUNTIME_SETTINGS.maxSubAgents,
    maxRetries: DEFAULT_SUB_AGENT_RUNTIME_SETTINGS.maxRetries,
  });

  const explicit = normalizeSubAgentRuntimeSettings({ autoSubAgents: true });
  assert.equal(explicit.enabled, true, 'the user-facing opt-in must still enable delegation');
  assert.equal(buildSubAgentPinnedContext(explicit).allowAgentSpawning, true);
}

function testAdviceDoesNotTurnDomainKeywordsIntoRandomSpawns(): void {
  const automatic = buildSubAgentStrategy(
    'Review the architecture of the event routing pipeline and identify maintainability risks.',
  );
  assert.equal(
    automatic.shouldSpawn,
    false,
    'a domain keyword alone must not autonomously launch a specialist',
  );
  assert.equal(automatic.recommendedToolCall, null);

  const explicit = buildSubAgentStrategy(
    'Use exactly one sub-agent for deep work to review the architecture of the event routing pipeline.',
  );
  assert.equal(explicit.shouldSpawn, true);
  assert.equal(recommendedAgentCount(explicit), 1, 'an explicit single-worker request must remain single-worker');

  const spawner = new SubAgentSpawner();
  const brief = (spawner as any).buildDeepBrief(
    explicit.recommendedAgents[0].task,
    'Architecture-Review',
    uniqueId('deep_work'),
  ) as string;
  assert.match(brief, /work (?:deeply|as one deep)|deepest useful solution/i);
  assert.match(brief, /may plan and delegate narrower independent outcomes with spawn_sub_agent/i);
  assert.match(brief, /verify (?:your work|behavior in proportion to risk)/i);
  assert.ok(
    brief.includes(explicit.recommendedAgents[0].task),
    'the worker must receive the complete delegated task rather than a shallow role label',
  );
}

async function testConfiguredLimitIsAConcurrencyCapNotTaskLoss(): Promise<void> {
  const projectId = uniqueId('subagent_cap');
  const spawner = new SubAgentSpawner();
  let inFlight = 0;
  let maxInFlight = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  (spawner as any).spawnAgent = async (
    task: string,
    _context: unknown,
    _agentIndex: number,
    _parentContext?: string,
    _onTrace?: unknown,
    customName?: string,
    _modelOverride?: unknown,
    customAgentId?: string,
  ) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate;
    inFlight--;
    return {
      agentId: customAgentId,
      name: customName,
      result: `finished ${task}`,
      success: true,
      durationMs: 1,
      traceLog: [],
    };
  };

  try {
    const first = spawner.spawnParallelFireAndForget(
      ['one', 'two', 'three', 'four'].map(task => ({ task })),
      { projectId, maxSubAgents: 2 } as any,
    );
    assert.equal(first.agents.length, 4, 'all delegated tasks must be admitted to the bounded queue');
    assert.deepEqual(
      first.notStartedTasks.map(task => task.task),
      [],
      'tasks above the concurrency cap must be queued rather than discarded',
    );

    const whileFull = spawner.spawnParallelFireAndForget(
      [{ task: 'five' }],
      { projectId, maxSubAgents: 2 } as any,
    );
    assert.equal(whileFull.agents.length, 1, 'new work must join the queue while all slots are occupied');
    assert.deepEqual(whileFull.notStartedTasks.map(task => task.task), []);
    const startDeadline = Date.now() + 2_000;
    while ((inFlight < 2 || spawner.getOccupiedSlotCount(projectId) < 2) && Date.now() < startDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(spawner.getOccupiedSlotCount(projectId), 2);

    release();
    await spawner.waitForAll(projectId);
    assert.equal(maxInFlight, 2);
    assert.equal(spawner.getOccupiedSlotCount(projectId), 0);
  } finally {
    release();
    await spawner.waitForAll(projectId);
    await interAgentMailbox.clearProject(projectId);
    resetCancelFlag(projectId);
  }
}

async function testBlockingModesCannotBypassTheConcurrencyCap(): Promise<void> {
  const projectId = uniqueId('subagent_cross_mode_cap');
  const spawner = new SubAgentSpawner();
  let inFlight = 0;
  let maxInFlight = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let overflowAttempt: Promise<unknown> | undefined;

  (spawner as any).spawnAgent = async (
    task: string,
    _context: unknown,
    _agentIndex: number,
    _parentContext?: string,
    _onTrace?: unknown,
    customName?: string,
    _modelOverride?: unknown,
    customAgentId?: string,
  ) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate;
    inFlight--;
    return {
      agentId: customAgentId || `blocking-${task}`,
      name: customName || task,
      result: `finished ${task}`,
      success: true,
      durationMs: 1,
      traceLog: [],
    };
  };

  try {
    spawner.spawnParallelFireAndForget(
      [{ task: 'background-one' }, { task: 'background-two' }],
      { projectId, maxSubAgents: 2 } as any,
    );
    assert.equal(spawner.getOccupiedSlotCount(projectId), 2);

    overflowAttempt = spawner.spawnParallel(
      [{ task: 'blocking-overflow' }],
      { projectId, maxSubAgents: 2 } as any,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(
      maxInFlight <= 2,
      'specialist/consensus/debate blocking paths must not bypass slots occupied by background workers',
    );
  } finally {
    release();
    await Promise.allSettled([
      spawner.waitForAll(projectId),
      ...(overflowAttempt ? [overflowAttempt] : []),
    ]);
    await interAgentMailbox.clearProject(projectId);
    resetCancelFlag(projectId);
  }
}

async function testConsensusSharesTheGlobalProjectCap(): Promise<void> {
  const projectId = uniqueId('subagent_consensus_cap');
  const spawner = new SubAgentSpawner();
  let inFlight = 0;
  let maxInFlight = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let consensusAttempt: Promise<unknown> | undefined;

  (spawner as any).spawnAgent = async (
    task: string,
    _context: unknown,
    _agentIndex: number,
    _parentContext?: string,
    _onTrace?: unknown,
    customName?: string,
    _modelOverride?: unknown,
    customAgentId?: string,
  ) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate;
    inFlight--;
    return {
      agentId: customAgentId || `consensus-${task.length}`,
      name: customName || 'Consensus-Worker',
      result: 'Verified: yes. Bounded consensus result.',
      success: true,
      durationMs: 1,
      traceLog: [],
    };
  };

  try {
    spawner.spawnParallelFireAndForget(
      [{ task: 'background-one' }, { task: 'background-two' }],
      { projectId, maxSubAgents: 2 } as any,
    );
    assert.equal(spawner.getOccupiedSlotCount(projectId), 2);

    consensusAttempt = spawner.spawnConsensus(
      'Evaluate the same decision from independent perspectives.',
      { projectId, maxSubAgents: 2 } as any,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(
      maxInFlight <= 2,
      'consensus must share the same per-project slots as fire-and-forget and direct parallel runs',
    );
  } finally {
    release();
    await Promise.allSettled([
      spawner.waitForAll(projectId),
      ...(consensusAttempt ? [consensusAttempt] : []),
    ]);
    await interAgentMailbox.clearProject(projectId);
    resetCancelFlag(projectId);
  }
}

async function testMessagesAreBoundToTheRecipientRun(): Promise<void> {
  const projectId = uniqueId('subagent_messages');
  const name = 'Reusable-Worker';
  const oldRun = 'worker-run-old';
  const newRun = 'worker-run-new';
  const oldChat = `${projectId}::sub-agent::${oldRun}`;
  const newChat = `${projectId}::sub-agent::${newRun}`;

  try {
    interAgentMailbox.registerAgent(projectId, name, {
      role: 'sub_agent',
      agentId: oldRun,
      subAgentChatId: oldChat,
      status: 'running',
    });
    const oldMessage = interAgentMailbox.send({
      from: 'Main',
      to: name,
      projectId,
      type: 'coordination',
      subject: 'old-run instruction',
      body: 'Only the old run may consume this.',
    });
    assert.equal(oldMessage.metadata?.recipientAgentId, oldRun);
    assert.equal(interAgentMailbox.checkMailbox(projectId, name, { agentId: oldRun }).length, 1);

    interAgentMailbox.registerAgent(projectId, name, {
      role: 'sub_agent',
      agentId: newRun,
      subAgentChatId: newChat,
      status: 'running',
    });
    assert.deepEqual(
      interAgentMailbox.checkMailbox(projectId, name, { agentId: newRun }),
      [],
      'reusing a display name must not deliver unread instructions from its predecessor',
    );

    const currentMessage = interAgentMailbox.send({
      from: 'Main',
      to: name,
      projectId,
      type: 'coordination',
      subject: 'new-run instruction',
      body: 'Only the current run may consume this.',
    });
    assert.equal(currentMessage.metadata?.recipientAgentId, newRun);

    interAgentMailbox.send({
      from: 'Main',
      to: name,
      projectId,
      type: 'coordination',
      subject: 'late stale instruction',
      body: 'This message still targets the superseded run.',
      metadata: { recipientAgentId: oldRun, recipientSubAgentChatId: oldChat },
    });
    assert.deepEqual(
      interAgentMailbox.checkMailbox(projectId, name, { agentId: newRun }).map(message => message.subject),
      ['new-run instruction'],
      'run-filtered reads must reject explicitly stale deliveries',
    );
  } finally {
    // send() persists best-effort; give those writes a chance to settle before cleanup.
    await new Promise(resolve => setTimeout(resolve, 25));
    await interAgentMailbox.clearProject(projectId);
  }
}

async function testCollectionIsNonBlockingAndExposesExactResultPayloads(): Promise<void> {
  const projectId = uniqueId('subagent_collection');
  const name = 'Lifecycle-Worker';
  const agentId = 'lifecycle-run-current';
  const subAgentChatId = `${projectId}::sub-agent::${agentId}`;
  const execute = spawnSubAgentTool.execute as any;
  const task = 'Inspect the lifecycle state.';

  try {
    swarmCoordinator.admit([{ id: agentId, name, task }], { projectId });
    swarmCoordinator.start(agentId);

    const running = await execute(
      { mode: 'collect', agentName: name, agentId },
      { projectId, allowAgentSpawning: true },
    );
    assert.equal(running.snapshotOnly, true);
    assert.equal(running.shouldPoll, false);
    assert.equal(running.collection.pendingCount, 1);
    assert.equal(running.evidenceReady, false);
    assert.equal(running.agents[0].delegationEvidence.resultUsability, 'pending');

    const exactResult = 'Root cause: stale run IDs reached the successor mailbox. Verified: yes.';
    const completedAt = Date.now();
    const retained = {
      projectId,
      agentId,
      subAgentChatId,
      name,
      task,
      result: exactResult,
      success: true,
      status: 'completed' as const,
      traceLog: ['inspected', 'verified'],
      completedAt,
      durationMs: 50,
      attempt: swarmCoordinator.get(agentId)!.attempt,
      delegationEvidence: assessDelegatedAgent({
        agentId, subAgentChatId, name, task, status: 'completed', success: true,
        result: exactResult, traceLog: ['inspected', 'verified'], completedAt,
      }),
    };
    await agentMessageBus.writeRetainedResult(retained);
    swarmCoordinator.settle(agentId, 'completed', undefined, exactResult);
    await agentMessageBus.writeAgentStatus(name, {
      status: 'completed', task, agentId, subAgentChatId,
      result: exactResult, traceLog: ['inspected', 'verified'],
      startedAt: completedAt - 50, completedAt,
    }, projectId);

    const completedContext = { projectId, allowAgentSpawning: true };
    const completed = await execute(
      { mode: 'collect', agentName: name, agentId },
      completedContext,
    );
    assert.equal(completed.shouldPoll, false);
    assert.equal(completed.fullyGrounded, true);
    assert.equal(completed.collection.usableCount, 1);
    assert.equal(completed.agents[0].agentId, agentId);
    assert.equal(completed.agents[0].subAgentChatId, subAgentChatId);
    assert.equal(completed.agents[0].result, exactResult);
    assert.equal(completed.agents[0].delegationEvidence.evidenceReady, true);
    assert.equal(completed.agents[0].delegationEvidence.verificationStatus, 'verified');

    const staleRun = await execute(
      { mode: 'collect', agentName: name, agentId: 'lifecycle-run-stale' },
      { projectId, allowAgentSpawning: true },
    );
    assert.equal(staleRun.agents.length, 0, 'collection by run ID must not expose a successor payload');
    assert.equal(staleRun.evidenceReady, false);

    const firstStatus = await execute(
      { mode: 'status', agentName: name, agentId },
      completedContext,
    );
    assert.equal(firstStatus.agents[0].status, 'completed');
    assert.equal(firstStatus.shouldPoll, false);

    const repeated = await execute(
      { mode: 'status', agentName: name, agentId },
      completedContext,
    );
    assert.equal(repeated.repeatSuppressed, true);
    assert.equal(repeated.shouldPoll, false);
    assert.equal(repeated.agents.length, 0);
  } finally {
    clearPendingResults(projectId);
    await agentMessageBus.clearAll(projectId);
    await interAgentMailbox.clearProject(projectId);
    resetCancelFlag(projectId);
  }
}

async function main(): Promise<void> {
  const checks: Array<[string, () => void | Promise<void>]> = [
    ['explicit delegation opt-in', testDelegationRequiresExplicitOptIn],
    ['no keyword-triggered random spawning', testAdviceDoesNotTurnDomainKeywordsIntoRandomSpawns],
    ['concurrent-agent admission cap', testConfiguredLimitIsAConcurrencyCapNotTaskLoss],
    ['cross-mode concurrent-agent cap', testBlockingModesCannotBypassTheConcurrencyCap],
    ['consensus shared concurrent-agent cap', testConsensusSharesTheGlobalProjectCap],
    ['run-bound inter-agent messaging', testMessagesAreBoundToTheRecipientRun],
    ['non-blocking result collection', testCollectionIsNonBlockingAndExposesExactResultPayloads],
  ];
  const failures: Array<{ name: string; error: unknown }> = [];
  for (const [name, check] of checks) {
    try {
      await check();
    } catch (error) {
      failures.push({ name, error });
      console.error(`FAILED: ${name}`);
      console.error(error);
    }
  }
  assert.equal(
    failures.length,
    0,
    `${failures.length} sub-agent runtime regression check(s) failed: ${failures.map(failure => failure.name).join(', ')}`,
  );
  console.log('Sub-agent runtime integration checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
