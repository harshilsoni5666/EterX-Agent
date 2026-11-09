'use client';

export type ManagedTerminalTask = {
  id: string;
  command: string;
  program?: string;
  args?: string[];
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'killed' | 'unknown';
  cwd: string;
  startedAt: number;
  completedAt?: number;
  exitCode: number | null;
  background?: boolean;
  initialOutput?: string;
};
export type ManagedTerminalSnapshot = ManagedTerminalTask & {
  taskId: string;
  output: string;
  outputStart: number;
  outputEnd: number;
  running: boolean;
  hasMoreOutput?: boolean;
  outputReadError?: string;
  outputPersistenceError?: string;
  statusPersistenceError?: string;
};

async function request(url: string, options?: RequestInit) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options?.signal?.addEventListener('abort', abort, { once: true });
  if (options?.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, options?.method === 'POST' ? 15_000 : 8_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Terminal request failed (${response.status}).`);
    return data;
  } catch (error) {
    if (controller.signal.aborted && !options?.signal?.aborted) throw new Error('Terminal connection is taking longer than expected.');
    throw error;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', abort);
  }
}
export const managedTerminalCache = new Map<string, ManagedTerminalTask[]>();
const listVersions = new Map<string, number>();
export async function listManagedTerminals(chatId: string, signal?: AbortSignal): Promise<ManagedTerminalTask[]> {
  const version = (listVersions.get(chatId) || 0) + 1;
  listVersions.set(chatId, version);
  const tasks = (await request(`/api/agent/terminal?${new URLSearchParams({ chatId })}`, { signal })).tasks;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (listVersions.get(chatId) !== version) return managedTerminalCache.get(chatId) || tasks;
  managedTerminalCache.set(chatId, tasks);
  return tasks;
}
const pendingSnapshots = new Map<string, Promise<ManagedTerminalSnapshot>>();
export async function readManagedTerminal(chatId: string, taskId: string, sinceOffset: number, signal?: AbortSignal): Promise<ManagedTerminalSnapshot> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const key = `${chatId}:${taskId}:${sinceOffset}`;
  let pending = pendingSnapshots.get(key);
  if (!pending) {
    pending = request(`/api/agent/terminal?${new URLSearchParams({ chatId, taskId, sinceOffset: String(sinceOffset) })}`)
      .then(data => ({ ...data.task, id: data.task.taskId })).finally(() => pendingSnapshots.delete(key));
    pendingSnapshots.set(key, pending!);
  }
  const task = await pending;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return task!;
}
export async function stopManagedTerminal(chatId: string, taskId: string): Promise<ManagedTerminalSnapshot> {
  const task = (await request('/api/agent/terminal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId, taskId }),
  })).task;
  listVersions.set(chatId, (listVersions.get(chatId) || 0) + 1);
  const cached = managedTerminalCache.get(chatId);
  if (cached) managedTerminalCache.set(chatId, cached.map(item => item.id === taskId ? { ...item, ...task, id: taskId } : item));
  window.dispatchEvent(new CustomEvent('eterx-terminal-task-changed', { detail: { chatId, taskId } }));
  return { ...task, id: taskId };
}
