import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { isTrustedDesktopSubscriptionRequest } from '../../../../lib/agent/codex-subscription-runtime';
import { getActiveDirectChatRuns } from '../../../../lib/agent/manual-compaction';
import { globalSubAgentSpawner } from '../../../../lib/agent/roles/sub_agent';
import {
  beginSubscriptionHandoff, endSubscriptionHandoff, isSubscriptionHandoff,
} from '../../../../lib/agent/subscription-handoff';
import { taskStore } from '../../../../lib/agent/task-store';
import { jsonError, readJsonObject } from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const runningMainAgents = () => agentRegistry.getAllStatus().filter(run => run.status === 'running');
const runningWorkers = () => globalSubAgentSpawner.getAgentStatus()
  .filter(run => ['spawning', 'running', 'waiting', 'paused'].includes(run.status));

async function stopRunningAgents(): Promise<boolean> {
  const chats = runningMainAgents();
  const direct = getActiveDirectChatRuns();
  const workers = runningWorkers();
  agentRegistry.stopAll();
  for (const run of direct) run.controls?.cancel();

  const stopped = Promise.all([
    ...chats.map(run => agentRegistry.waitForStoppedRunToSettle(run.chatId, 15_000)),
    ...direct.map(async run => { await run.finished; return true; }),
    ...workers.map(async worker => { await worker.promise?.catch(() => undefined); return true; }),
  ]).then(async results => {
    await taskStore.flushPendingWrites(chats.map(run => run.chatId));
    return results.every(Boolean);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([stopped, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 16_000); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: NextRequest) {
  if (!isTrustedDesktopSubscriptionRequest(request)) return jsonError('Desktop authorization is required.', 403);
  const { action, id, mode } = await readJsonObject(request);
  if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) return jsonError('Invalid account change.');

  if (action === 'release') {
    endSubscriptionHandoff(id);
    return NextResponse.json({ ok: true });
  }

  if (action === 'stop') {
    if (!isSubscriptionHandoff(id, 'stop')) return jsonError('The account change is no longer active.', 409);
    if (!await stopRunningAgents()) return jsonError('EterX could not finish stopping all active work. Try switching again when the runs have stopped.', 409);
    return NextResponse.json({ ok: true });
  }

  if (action !== 'begin' || (mode !== 'idle' && mode !== 'stop' && mode !== 'resume')) {
    return jsonError('Invalid account change action.');
  }

  const workers = runningWorkers();
  const direct = getActiveDirectChatRuns();
  const activeWork = runningMainAgents().length + workers.length + direct.length;
  if (mode === 'idle' && activeWork > 0) return NextResponse.json({ held: false, activeWork });
  if (!beginSubscriptionHandoff(id, mode)) return jsonError('Another account change is already in progress.', 409);

  const models = new Set(agentRegistry.getRunningCodexModels());
  for (const run of direct) if (run.controls?.codexModel) models.add(run.controls.codexModel);
  for (const worker of workers) {
    const context = worker.originContext as typeof worker.originContext & { selectedModelProvider?: string; selectedModelName?: string };
    if (context.selectedModelProvider === 'codex' && typeof context.selectedModelName === 'string') {
      models.add(context.selectedModelName);
    }
  }
  return NextResponse.json({ held: true, activeWork, models: [...models] });
}
