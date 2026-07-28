import fs from 'fs-extra';
import { randomUUID } from 'crypto';
import { getEterxWorkspaceDir } from '../storage-paths';
import type { ProxyInterventionLevel, ProxyManagerDirective } from './user-proxy-runtime';

export type ProxyControlState = {
  version: 1;
  chatId: string;
  enabled: boolean;
  intervention: ProxyInterventionLevel;
  modelSelection: string;
  dormantDirectives: ProxyManagerDirective[];
  taskQueue: ProxyQueuedTask[];
  stopGeneration: number;
  updatedAt: number;
};

export type ProxyQueuedTask = {
  id: string;
  prompt: string;
  rationale: string;
  dependency?: string;
  createdAt: number;
  status: 'pending' | 'starting' | 'started' | 'failed' | 'cancelled';
  runId?: string;
  error?: string;
};

const MAX_DIRECTIVES = 24;
const MAX_TASKS = 20;

const compact = (value: unknown, max: number): string =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const controlPath = (chatId: string): string => {
  const safe = chatId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 140);
  return getEterxWorkspaceDir('autonomy', 'proxy-control', `${safe}.json`);
};

export function readProxyControl(chatId: string): ProxyControlState {
  try {
    const saved = fs.readJsonSync(controlPath(chatId));
    if (saved?.version === 1 && saved?.chatId === chatId) {
      return {
        version: 1,
        chatId,
        enabled: saved.enabled !== false,
        intervention: ['minimal', 'normal', 'high'].includes(saved.intervention) ? saved.intervention : 'normal',
        modelSelection: compact(saved.modelSelection, 320) || 'auto',
        dormantDirectives: Array.isArray(saved.dormantDirectives) ? saved.dormantDirectives.slice(-MAX_DIRECTIVES) : [],
        taskQueue: Array.isArray(saved.taskQueue) ? saved.taskQueue.slice(-MAX_TASKS) : [],
        stopGeneration: Number(saved.stopGeneration || 0),
        updatedAt: Number(saved.updatedAt || Date.now()),
      };
    }
  } catch { }
  return {
    version: 1,
    chatId,
    enabled: true,
    intervention: 'normal',
    modelSelection: 'auto',
    dormantDirectives: [],
    taskQueue: [],
    stopGeneration: 0,
    updatedAt: Date.now(),
  };
}

function writeProxyControl(state: ProxyControlState): void {
  fs.ensureDirSync(getEterxWorkspaceDir('autonomy', 'proxy-control'));
  const target = controlPath(state.chatId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeJsonSync(temporary, {
      ...state,
      dormantDirectives: state.dormantDirectives.slice(-MAX_DIRECTIVES),
      taskQueue: state.taskQueue.slice(-MAX_TASKS),
      updatedAt: Date.now(),
    }, { spaces: 2 });
    fs.moveSync(temporary, target, { overwrite: true });
  } finally {
    if (fs.existsSync(temporary)) fs.removeSync(temporary);
  }
}

export function updateProxyControl(
  chatId: string,
  patch: Partial<Pick<ProxyControlState, 'enabled' | 'intervention' | 'modelSelection'>>,
): ProxyControlState {
  const state = readProxyControl(chatId);
  if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled;
  if (patch.intervention && ['minimal', 'normal', 'high'].includes(patch.intervention)) {
    state.intervention = patch.intervention;
  }
  if (typeof patch.modelSelection === 'string') {
    state.modelSelection = compact(patch.modelSelection, 320) || 'auto';
  }
  writeProxyControl(state);
  return state;
}

export function saveDormantProxyDirective(
  chatId: string,
  input: Omit<ProxyManagerDirective, 'id' | 'createdAt' | 'status'>,
): ProxyManagerDirective {
  const state = readProxyControl(chatId);
  const directive: ProxyManagerDirective = {
    ...input,
    id: `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    status: 'pending',
    expiresAt: input.expiresAt || Date.now() + (input.scope === 'persistent_mandate' ? 30 : 2) * 24 * 60 * 60_000,
  };
  if (directive.supersedesDirectiveId) {
    state.dormantDirectives = state.dormantDirectives.filter(item => item.id !== directive.supersedesDirectiveId);
  }
  state.dormantDirectives.push(directive);
  writeProxyControl(state);
  return directive;
}

export function claimDormantProxyDirectives(chatId: string): ProxyManagerDirective[] {
  const state = readProxyControl(chatId);
  const now = Date.now();
  const claimed = state.dormantDirectives.filter(item => !item.expiresAt || item.expiresAt > now);
  state.dormantDirectives = [];
  writeProxyControl(state);
  return claimed;
}

export function enqueueProxyTask(
  chatId: string,
  prompt: string,
  rationale = '',
  options: { dependency?: string; supersedesTaskId?: string } = {},
): ProxyQueuedTask {
  const state = readProxyControl(chatId);
  if (options.supersedesTaskId) {
    const superseded = state.taskQueue.find(item =>
      item.id === options.supersedesTaskId && item.status === 'pending',
    );
    if (superseded) {
      superseded.status = 'cancelled';
      superseded.error = 'Replaced by a newer side-agent instruction.';
    }
  }
  const task: ProxyQueuedTask = {
    id: randomUUID(),
    prompt: compact(prompt, 12000),
    rationale: compact(rationale, 1200),
    dependency: compact(options.dependency, 1200) || undefined,
    createdAt: Date.now(),
    status: 'pending',
  };
  state.taskQueue.push(task);
  writeProxyControl(state);
  return task;
}

export function claimNextProxyTask(chatId: string): ProxyQueuedTask | null {
  const state = readProxyControl(chatId);
  // `starting` is only a short synchronous handoff state. If it survives long
  // enough to be read again, the process stopped before recording the run and
  // the task must be reclaimed instead of remaining permanently undeliverable.
  const task = state.taskQueue.find(item =>
    item.status === 'pending' || (item.status === 'starting' && !item.runId),
  );
  if (!task) return null;
  task.status = 'starting';
  writeProxyControl(state);
  return { ...task };
}

export function settleProxyTask(
  chatId: string,
  taskId: string,
  result: { status: 'started' | 'failed'; runId?: string; error?: string },
): void {
  const state = readProxyControl(chatId);
  const task = state.taskQueue.find(item => item.id === taskId);
  if (!task) return;
  task.status = result.status;
  task.runId = result.runId;
  task.error = compact(result.error, 1200) || undefined;
  writeProxyControl(state);
}

export function getPendingProxyTaskCount(chatId: string): number {
  return readProxyControl(chatId).taskQueue.filter(item => item.status === 'pending' || item.status === 'starting').length;
}

export function cancelPendingProxyTasks(chatId: string, reason = 'Cancelled after Main was stopped by the user.'): number {
  const state = readProxyControl(chatId);
  let cancelled = 0;
  for (const task of state.taskQueue) {
    if (task.status !== 'pending' && task.status !== 'starting') continue;
    task.status = 'cancelled';
    task.error = compact(reason, 1200);
    cancelled += 1;
  }
  state.stopGeneration += 1;
  writeProxyControl(state);
  return cancelled;
}
