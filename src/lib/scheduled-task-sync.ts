import { appStorage } from './client-storage';
import { SCHEDULED_TASKS_STORAGE_KEY, SCHEDULED_TASKS_UPDATED_EVENT, type ScheduledTaskRecord } from './scheduled-tasks';

let writeChain: Promise<boolean> = Promise.resolve(true);
let writeSequence = 0;

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
  return writeChain;
}
