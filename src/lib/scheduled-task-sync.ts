import { appStorage } from './client-storage';
import { SCHEDULED_TASKS_STORAGE_KEY, SCHEDULED_TASKS_UPDATED_EVENT, type ScheduledTaskRecord, type ScheduledFocusUpdate } from './scheduled-tasks';

let writeChain: Promise<boolean> = Promise.resolve(true);
let writeSequence = 0;
const SYNC_PENDING_KEY = 'eterx_scheduled_tasks_sync_pending';
let updatingFocus = false;

export const scheduledTaskFocusWriteInFlight = () => updatingFocus;

export function pendingScheduledTaskWriteAt(): number {
  return Number(appStorage.getItem(SYNC_PENDING_KEY)?.split('-')[0]) || 0;
}

export function updateScheduledTaskFocus(id: string, update: ScheduledFocusUpdate): Promise<void> {
  const write = async () => {
    updatingFocus = true;
    const syncToken = Date.now() + '-' + (++writeSequence);
    appStorage.setItem(SYNC_PENDING_KEY, syncToken);
    try {
      const response = await fetch('/api/scheduled-tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...update }),
        signal: AbortSignal.timeout(10_000),
      });
      const snapshot = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(snapshot?.tasks)) {
        throw new Error(snapshot?.error || 'Unable to save the scheduled task.');
      }
      if (appStorage.getItem(SYNC_PENDING_KEY) === syncToken) {
        appStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify(snapshot.tasks));
        const task = snapshot.tasks.find((item: ScheduledTaskRecord) => item.id === id);
        if (update.action === 'reschedule' && update.at === 'now' && task?.status === 'queued') {
          window.dispatchEvent(new CustomEvent('eterx_trigger_scheduled_task', { detail: { task } }));
        }
        window.dispatchEvent(new CustomEvent(SCHEDULED_TASKS_UPDATED_EVENT));
      }
    } finally {
      updatingFocus = false;
      if (appStorage.getItem(SYNC_PENDING_KEY) === syncToken) appStorage.removeItem(SYNC_PENDING_KEY);
    }
  };
  const prior = writeChain;
  const queued = prior.then(saved => {
    if (!saved) throw new Error('Earlier task changes are still unsaved. Try again after they sync.');
    return write();
  });
  writeChain = queued.then(() => true, () => prior);
  return queued;
}

/**
 * Keep the renderer cache and the AppData scheduled-task store in one
 * serialized write queue. A fire-and-forget PUT could otherwise still be in
 * flight when Electron stopped the local server during quit or update.
 */
export function persistScheduledTasks(tasks: ScheduledTaskRecord[]): Promise<boolean> {
  const syncToken = `${Date.now()}-${++writeSequence}`;
  appStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify(tasks));
  appStorage.setItem('eterx_scheduled_tasks_sync_pending', syncToken);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SCHEDULED_TASKS_UPDATED_EVENT));
  }

  const write = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch('/api/scheduled-tasks', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks }),
          keepalive: true,
        });
        if (!response.ok) throw new Error(`Scheduled task write failed: ${response.status}`);
        if (appStorage.getItem('eterx_scheduled_tasks_sync_pending') === syncToken) {
          appStorage.removeItem('eterx_scheduled_tasks_sync_pending');
        }
        return true;
      } catch {
        if (attempt < 2 && typeof window !== 'undefined') {
          await new Promise(resolve => window.setTimeout(resolve, 150 * (attempt + 1)));
        }
      }
    }
    return false;
  };

  writeChain = writeChain.then(write, write);
  return writeChain;
}

export async function flushScheduledTaskWrites(): Promise<boolean> {
  const committed = await writeChain;
  if (committed) return true;

  // A transient localhost failure must not poison the queue for the rest of
  // the session. The current task snapshot is still in AppData-backed memory,
  // so resubmit that snapshot before an update/quit reports failure.
  try {
    const raw = appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY);
    const tasks = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(tasks)) return false;
    return await persistScheduledTasks(tasks);
  } catch {
    return false;
  }
}
