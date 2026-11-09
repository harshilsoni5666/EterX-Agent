import fs from 'fs-extra';
import { randomUUID } from 'crypto';
import { getEterxWorkspaceDir } from '../storage-paths';
import type { ProxyInterventionLevel, ProxyManagerDirective } from './user-proxy-runtime';

export type ProxyControlState = {
  version: 1;
  chatId: string;
  enabled: boolean;
  paused: boolean;
  intervention: ProxyInterventionLevel;
  modelSelection: string;
  followChatModel: boolean;
  dormantDirectives: ProxyManagerDirective[];
  taskQueue: ProxyQueuedTask[];
  stopGeneration: number;
  revision: number;
  updatedAt: number;
};

export type ProxyControlSettings = Pick<ProxyControlState, 'enabled' | 'paused' | 'intervention' | 'modelSelection' | 'followChatModel'>;

export type ProxyQueuedTask = {
  id: string;
  prompt: string;
  rationale: string;
  dependency?: string;
  createdAt: number;
  status: 'pending' | 'starting' | 'started' | 'completed' | 'failed' | 'cancelled';
  runId?: string;
  error?: string;
  mediaAttachments?: ProxyTaskInput['mediaAttachments'];
  model?: ProxyTaskInput['model'];
  workspace?: ProxyTaskInput['workspace'];
  dependsOnTaskId?: string;
  result?: string;
  completedAt?: number;
};

export type ProxyTaskInput = {
  prompt: string;
  rationale?: string;
  dependency?: string;
  mediaAttachments?: Array<{ id?: string; name?: string; path: string; mimeType: string }>;
  model?: { provider: string; modelId: string };
  workspace?: { path: string | null; paths: string[]; runLocation: 'local' | 'sandbox' | 'worktree' };
};

const MAX_TASKS = 20;
const proxyControlGlobal = globalThis as typeof globalThis & {
  __eterxProxyControlListeners?: Map<string, Set<(state: ProxyControlState) => void>>;
};
const controlListeners = proxyControlGlobal.__eterxProxyControlListeners
  || (proxyControlGlobal.__eterxProxyControlListeners = new Map<string, Set<(state: ProxyControlState) => void>>());
export function subscribeProxyControl(chatId: string, listener: (state: ProxyControlState) => void): () => void {
  const listeners = controlListeners.get(chatId) || new Set();
  listeners.add(listener);
  controlListeners.set(chatId, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) controlListeners.delete(chatId); };
}

const compact = (value: unknown, max: number): string =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Keep executable instructions intact, including indentation and line breaks.
const promptText = (value: unknown): string => String(value ?? '').replace(/\u0000/g, '').trim();
const retainTaskQueue = (tasks: ProxyQueuedTask[]): ProxyQueuedTask[] => {
  const settled = tasks.filter(task => !['pending', 'starting'].includes(task.status)).slice(-MAX_TASKS);
  const retained = new Set(settled.map(task => task.id));
  tasks.filter(task => ['pending', 'starting', 'started'].includes(task.status)).forEach(task => {
    if (task.dependsOnTaskId) retained.add(task.dependsOnTaskId);
  });
  return tasks.filter(task => ['pending', 'starting'].includes(task.status) || retained.has(task.id));
};

const controlPath = (chatId: string): string => {
  const safe = chatId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 140);
  return getEterxWorkspaceDir('autonomy', 'proxy-control', `${safe}.json`);
};

export function readProxyControl(chatId: string): ProxyControlState {
  const target = controlPath(chatId);
  for (const source of [target, `${target}.backup`]) {
    try {
      if (!fs.existsSync(source)) continue;
      const saved = fs.readJsonSync(source);
      if (saved?.version === 1 && saved?.chatId === chatId) {
        return {
        version: 1,
        chatId,
        // Autonomy is strictly opt-in. Older or partially-written control
        // records without an explicit boolean must never reactivate Proxy.
        enabled: saved.enabled === true,
        paused: saved.enabled === true && saved.paused === true,
        intervention: ['minimal', 'normal', 'high'].includes(saved.intervention) ? saved.intervention : 'normal',
        modelSelection: compact(saved.modelSelection, 320) || 'auto',
        followChatModel: saved.followChatModel !== false,
        dormantDirectives: Array.isArray(saved.dormantDirectives) ? saved.dormantDirectives.filter((item: any) => item && typeof item.message === 'string' && (!item.expiresAt || item.expiresAt > Date.now())) : [],
        taskQueue: Array.isArray(saved.taskQueue) ? retainTaskQueue(saved.taskQueue.filter((task: any) => task && typeof task.id === 'string' && typeof task.prompt === 'string')) : [],
        stopGeneration: Number(saved.stopGeneration || 0),
        revision: typeof saved.revision === 'number' && Number.isFinite(saved.revision) ? Math.max(0, saved.revision) : 1,
        updatedAt: Number(saved.updatedAt || Date.now()),
        };
      }
    } catch {
      if (source === target) try { fs.renameSync(target, `${target}.corrupt-${Date.now()}`); } catch { }
    }
  }
  return {
    version: 1,
    chatId,
    enabled: false,
    paused: false,
    intervention: 'normal',
    modelSelection: 'auto',
    followChatModel: true,
    dormantDirectives: [],
    taskQueue: [],
    stopGeneration: 0,
    revision: 0,
    updatedAt: Date.now(),
  };
}

function writeProxyControl(state: ProxyControlState): void {
  state.updatedAt = Date.now();
  fs.ensureDirSync(getEterxWorkspaceDir('autonomy', 'proxy-control'));
  const target = controlPath(state.chatId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeJsonSync(temporary, {
      ...state,
      dormantDirectives: state.dormantDirectives,
      taskQueue: retainTaskQueue(state.taskQueue),
      updatedAt: Date.now(),
    }, { spaces: 2 });
    if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.backup`);
    fs.moveSync(temporary, target, { overwrite: true });
  } finally {
    if (fs.existsSync(temporary)) fs.removeSync(temporary);
  }
}

export function updateProxyControl(
  chatId: string,
  patch: Partial<ProxyControlSettings>,
): ProxyControlState {
  const state = readProxyControl(chatId);
  if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled;
  if (typeof patch.paused === 'boolean') state.paused = patch.paused;
  if (!state.enabled) state.paused = false;
  if (patch.enabled === false || patch.paused === true) state.stopGeneration += 1;
  if (patch.intervention && ['minimal', 'normal', 'high'].includes(patch.intervention)) {
    state.intervention = patch.intervention;
  }
  if (typeof patch.modelSelection === 'string') {
    state.modelSelection = compact(patch.modelSelection, 320) || 'auto';
  }
  if (typeof patch.followChatModel === 'boolean') state.followChatModel = patch.followChatModel;
  // A model/catalog refresh does not constitute opting into or out of
  // autonomy. Leave an unconfigured record eligible for first-run bootstrap.
  if (state.revision > 0 || typeof patch.enabled === 'boolean' || typeof patch.paused === 'boolean') state.revision += 1;
  writeProxyControl(state);
  for (const listener of controlListeners.get(chatId) || []) listener(state);
  return state;
}

// Main can be launched through /api/chat, /api/agent/start, or an internal
// dispatcher. Bootstrap the first explicit selection in their shared registry;
// subsequent launches must never undo a newer toggle, pause, or model choice.
export function initializeProxyControl(chatId: string, autonomy: any): ProxyControlState {
  const current = readProxyControl(chatId);
  if (current.revision > 0 || typeof autonomy?.enabled !== 'boolean') return current;
  return updateProxyControl(chatId, {
    enabled: autonomy.enabled,
    paused: autonomy.paused === true,
    intervention: autonomy.intervention,
    modelSelection: autonomy.proxyModelSelection,
  });
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
    expiresAt: input.expiresAt || (input.scope === 'persistent_mandate' ? Date.now() + 30 * 24 * 60 * 60_000 : undefined),
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
  return enqueueProxyTasks(chatId, [{ prompt, rationale, dependency: options.dependency }], options.supersedesTaskId)[0];
}

export function enqueueProxyTasks(
  chatId: string,
  inputs: ProxyTaskInput[],
  supersedesTaskId?: string,
): ProxyQueuedTask[] {
  const state = readProxyControl(chatId);
  const superseded = supersedesTaskId
    ? state.taskQueue.find(item => item.id === supersedesTaskId && item.status === 'pending')
    : undefined;
  if (supersedesTaskId && !superseded) {
    throw new Error('That queued task is no longer pending. Refresh its status before replacing it.');
  }
  if (!inputs.length || inputs.some(input => !promptText(input.prompt))) {
    throw new Error('Every queued task needs a complete instruction.');
  }
  const pendingCount = state.taskQueue.filter(item => ['pending', 'starting'].includes(item.status)).length;
  if (pendingCount + inputs.length - (superseded ? 1 : 0) > MAX_TASKS) {
    throw new Error(`The task queue has room for ${Math.max(0, MAX_TASKS - pendingCount)} more tasks. No tasks were changed.`);
  }
  const tasks: ProxyQueuedTask[] = inputs.map(input => ({
    id: randomUUID(),
    prompt: promptText(input.prompt),
    rationale: compact(input.rationale, 1200),
    dependency: promptText(input.dependency) || undefined,
    mediaAttachments: input.mediaAttachments?.length ? input.mediaAttachments : undefined,
    model: input.model,
    workspace: input.workspace,
    createdAt: Date.now(),
    status: 'pending',
  }));
  const priorTasks = superseded ? state.taskQueue.slice(0, state.taskQueue.indexOf(superseded)) : state.taskQueue;
  const previousTaskId = superseded?.dependsOnTaskId || [...priorTasks].reverse().find(item => ['pending', 'starting', 'started'].includes(item.status))?.id;
  tasks.forEach((task, index) => {
    if (task.dependency) task.dependsOnTaskId = index > 0 ? tasks[index - 1].id : previousTaskId;
  });
  if (superseded) {
    // Preserve queue order when revising a task with dependent successors.
    const index = state.taskQueue.indexOf(superseded);
    superseded.status = 'cancelled';
    superseded.error = 'Replaced by a newer side-agent instruction.';
    state.taskQueue.splice(index, 0, ...tasks);
    for (const successor of state.taskQueue) {
      if (successor.dependsOnTaskId === superseded.id && successor.status === 'pending') successor.dependsOnTaskId = tasks[tasks.length - 1].id;
    }
  } else {
    state.taskQueue.push(...tasks);
  }
  writeProxyControl(state);
  return tasks;
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
  if (!task || task.status === 'cancelled') return;
  task.status = result.status;
  task.runId = result.runId;
  task.error = compact(result.error, 1200) || undefined;
  writeProxyControl(state);
}

export function getPendingProxyTaskCount(chatId: string): number {
  return readProxyControl(chatId).taskQueue.filter(item => item.status === 'pending' || item.status === 'starting').length;
}

export function completeProxyTask(chatId: string, taskId: string, runId: string, status: 'completed' | 'failed' | 'stopped', result: string): void {
  const state = readProxyControl(chatId);
  const task = state.taskQueue.find(item => item.id === taskId && item.runId === runId);
  if (!task) return;
  task.status = status === 'stopped' ? 'cancelled' : status;
  task.result = result;
  task.completedAt = Date.now();
  writeProxyControl(state);
}

export function cancelPendingProxyTasks(
  chatId: string,
  reason = 'Cancelled after Main was stopped by the user.',
  admittedAtOrBefore = Number.POSITIVE_INFINITY,
): number {
  const state = readProxyControl(chatId);
  let cancelled = 0;
  for (const task of state.taskQueue) {
    if (task.status !== 'pending' && task.status !== 'starting') continue;
    if (Number(task.createdAt || 0) > admittedAtOrBefore) continue;
    task.status = 'cancelled';
    task.error = compact(reason, 1200);
    cancelled += 1;
  }
  state.stopGeneration += 1;
  writeProxyControl(state);
  return cancelled;
}
