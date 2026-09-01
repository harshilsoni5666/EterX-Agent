import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { taskStore } from '../src/lib/agent/task-store';
import { SessionStateManager } from '../src/lib/agent/session';
import { detectChatBoundary } from '../src/lib/agent/chat-boundary';
import { getEterxWorkspaceDir } from '../src/lib/agent/storage-paths';
import { normalizeHistory } from '../src/app/api/agent/_shared';
import { buildSubAgentStrategy } from '../src/lib/agent/roles/sub_agent_strategy';
import { buildProxyTaskHistory } from '../src/lib/agent/agent-registry';
import { getSubAgentAssetName } from '../src/components/chat/agent-icons';
import {
  awaitIfPaused,
  cancelAgent,
  cancelAllSubAgents,
  isCancelled,
  pauseAgent,
  resetCancelFlag,
  globalSubAgentSpawner,
} from '../src/lib/agent/roles/sub_agent';

async function testStaleRunCannotCorruptSuccessor(): Promise<void> {
  const chatId = `lifecycle_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const taskPath = path.join(getEterxWorkspaceDir('.tasks'), `${chatId}.json`);
  try {
    await taskStore.createTask(chatId, 'first turn', 'run-a');
    await taskStore.createTask(chatId, 'second turn', 'run-b');

    taskStore.addTrace(chatId, { type: 'answer', text: 'stale answer' }, 'run-a');
    await taskStore.completeTask(chatId, 'stale completion', true, 'completed', 'run-a');

    const current = await taskStore.getTask(chatId);
    assert.equal(current?.runId, 'run-b');
    assert.equal(current?.status, 'running');
    assert.equal(current?.finalAnswer, '');
    assert.equal(current?.traceLogs.length, 0);

    await taskStore.completeTask(chatId, 'fresh completion', true, 'completed', 'run-b');
    const completed = await taskStore.getTask(chatId);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.finalAnswer, 'fresh completion');
  } finally {
    taskStore.clearCache(chatId);
    await fs.remove(taskPath);
  }
}

async function testNewTaskResetRemovesTaskContamination(): Promise<void> {
  const chatId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const sessionPath = path.join(getEterxWorkspaceDir('.session'), `${chatId}.json`);
  const manager = new SessionStateManager();
  try {
    manager.setLastUserMessageForChat(chatId, 'build the old dashboard');
    manager.setLastAgentOutputForChat(chatId, 'Old dashboard completed');
    manager.addActionForChat(chatId, 'Edited old-dashboard.tsx');
    manager.setTaskPlanForChat(chatId, [{ name: 'old step', status: 'pending' }]);
    assert.equal(manager.hasActiveSessionForChat(chatId), true);

    manager.resetTaskStateForChat(chatId);
    const reset = manager.getStateForChat(chatId);
    assert.equal(reset.lastUserMessage, '');
    assert.equal(reset.lastAgentOutput, '');
    assert.deepEqual(reset.actionSummary, []);
    assert.deepEqual(reset.taskPlanSteps, []);
    assert.equal(manager.hasActiveSessionForChat(chatId), false);
  } finally {
    await fs.remove(sessionPath);
  }
}

function testBoundarySeparatesIndependentTurns(): void {
  const result = detectChatBoundary({
    newMessage: 'Please create a payroll reconciliation spreadsheet for July with variance formulas and an exceptions tab.',
    lastUserMessage: 'Build a React weather dashboard with animated charts and a dark theme.',
    lastAgentOutput: 'The weather dashboard is complete and verified.',
    activeTaskPlan: [{ name: 'dashboard', status: 'done' }],
    recentToolNames: ['workspace_write_file'],
    recentFileNames: ['weather-dashboard.tsx'],
    pendingAskUser: false,
  });
  assert.equal(result.decision, 'new_task');
  assert.equal(result.shouldResetSession, true);
}

async function testCancellationIsGlobalAndWakesPausedAgents(): Promise<void> {
  const firstProject = `cancel_a_${Date.now()}`;
  const nextProject = `cancel_b_${Date.now()}`;
  const unknownProject = `cancel_unknown_${Date.now()}`;

  resetCancelFlag();
  resetCancelFlag(firstProject);
  pauseAgent(firstProject, 'Ada', () => undefined);

  let pauseReleased = false;
  const pausedWait = awaitIfPaused(firstProject, 'Ada').then(() => {
    pauseReleased = true;
  });
  cancelAgent(firstProject);
  await Promise.race([
    pausedWait,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Paused agent did not wake on cancellation')), 250)),
  ]);
  assert.equal(pauseReleased, true);
  assert.equal(isCancelled(firstProject), true);

  cancelAllSubAgents();
  assert.equal(isCancelled(unknownProject), true, 'global stop must cover chats without a pre-existing flag');

  // Starting new work clears the global edge-trigger, but must not resurrect
  // runs that were explicitly marked cancelled by the emergency stop.
  resetCancelFlag(nextProject);
  assert.equal(isCancelled(nextProject), false);
  assert.equal(isCancelled(firstProject), true);
  assert.equal(isCancelled(unknownProject), false);
  resetCancelFlag();
}

async function testLongTracePollingStaysIncrementalAfterCompaction(): Promise<void> {
  const chatId = `long_trace_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const taskPath = path.join(getEterxWorkspaceDir('.tasks'), `${chatId}.json`);
  try {
    await taskStore.createTask(chatId, 'long running task', 'long-run');
    for (let index = 0; index < 900; index++) {
      taskStore.addTrace(chatId, { type: 'thought', text: `trace-${index}`, _traceIdx: index }, 'long-run');
    }
    const incremental = await taskStore.getPollState(chatId, 895);
    assert.deepEqual(incremental.traces.map(trace => trace._traceIdx), [896, 897, 898, 899]);
    assert.equal(incremental.maxIndex, 899);
  } finally {
    taskStore.clearCache(chatId);
    await fs.remove(taskPath);
  }
}

function testHistoryIntegrityAndSubAgentIdentityBounds(): void {
  const rawHistory = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'model',
    parts: [{ text: `${index}:` + 'x'.repeat(59_998) }],
  }));
  const normalized = normalizeHistory(rawHistory);
  assert.equal(normalized.length, rawHistory.length, 'normalization must not discard old dialogue turns');
  assert.equal(normalized[0].parts[0].text, rawHistory[0].parts[0].text);
  assert.ok(normalized.at(-1)?.parts[0].text.startsWith('11:'));

  const roleNames = globalSubAgentSpawner.getAgentNames();
  const iconNames = fs.readdirSync(path.join(process.cwd(), 'public', 'icons', 'sub-agents'))
    .filter(file => file.endsWith('.png'))
    .map(file => path.basename(file, '.png'))
    .sort();
  assert.deepEqual(roleNames, ['Task-Research', 'Runtime-Control', 'Interface-Review']);
  for (const roleName of roleNames) {
    assert.equal(iconNames.includes(getSubAgentAssetName(roleName)), true, `role ${roleName} must resolve to a shipped avatar`);
  }
  const strategy = buildSubAgentStrategy('Deeply review and fix frontend and backend concurrency bugs in parallel.');
  assert.equal(strategy.recommendedAgents.some(agent => Boolean(agent.name)), false, 'strategies must not bind identities to roles');
}

async function testExpectedRunCannotMutateLegacyTaskWithoutRunIdentity(): Promise<void> {
  const chatId = `legacy_run_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const taskPath = path.join(getEterxWorkspaceDir('.tasks'), `${chatId}.json`);
  try {
    // Older persisted tasks may not have a runId. A caller carrying a newer
    // run token must not be allowed to mutate that ambiguous legacy state.
    await taskStore.createTask(chatId, 'legacy task');
    taskStore.addTrace(chatId, { type: 'answer', text: 'stale trace' }, 'new-run');
    await taskStore.completeTask(chatId, 'stale completion', true, 'completed', 'new-run');
    await taskStore.stopTask(chatId, 'stale stop', 'new-run');

    const current = await taskStore.getTask(chatId);
    assert.equal(current?.status, 'running');
    assert.equal(current?.finalAnswer, '');
    assert.equal(current?.traceLogs.length, 0);
  } finally {
    taskStore.clearCache(chatId);
    await fs.remove(taskPath);
  }
}

function testProxyTaskHistoryIsolation(): void {
  const baseHistory = [{ role: 'user', parts: [{ text: 'original request' }] }];
  const independent = buildProxyTaskHistory(baseHistory, 'previous proxy prompt', 'previous answer', false);
  assert.deepEqual(independent, baseHistory);
  assert.equal(JSON.stringify(independent).includes('previous answer'), false);

  const dependent = buildProxyTaskHistory(baseHistory, 'previous proxy prompt', 'previous answer', true);
  assert.deepEqual(dependent.slice(-2), [
    { role: 'user', parts: [{ text: 'previous proxy prompt' }] },
    { role: 'model', parts: [{ text: 'previous answer' }] },
  ]);
}

async function main(): Promise<void> {
  await testStaleRunCannotCorruptSuccessor();
  await testExpectedRunCannotMutateLegacyTaskWithoutRunIdentity();
  await testNewTaskResetRemovesTaskContamination();
  testBoundarySeparatesIndependentTurns();
  await testCancellationIsGlobalAndWakesPausedAgents();
  await testLongTracePollingStaysIncrementalAfterCompaction();
  testHistoryIntegrityAndSubAgentIdentityBounds();
  testProxyTaskHistoryIsolation();
  console.log('Agent lifecycle integration checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
