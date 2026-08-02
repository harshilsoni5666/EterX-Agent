import fs from 'fs-extra';
import path from 'path';
import { getEterxDataDir } from './agent/storage-paths';
import { normalizeScheduledTask, type ScheduledTaskRecord } from './scheduled-tasks';

const STORE_DIR = path.join(getEterxDataDir(), 'scheduled-tasks');
const STORE_PATH = path.join(STORE_DIR, 'tasks.json');
const MAX_TASKS = 2000;

export interface ScheduledTaskSnapshot {
  version: 1;
  savedAt: number;
  tasks: ScheduledTaskRecord[];
}

let cache: ScheduledTaskSnapshot | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

const emptySnapshot = (): ScheduledTaskSnapshot => ({ version: 1, savedAt: 0, tasks: [] });

function normalizeSnapshot(value: any): ScheduledTaskSnapshot {
  return {
    version: 1,
    savedAt: Number.isFinite(Number(value?.savedAt)) ? Number(value.savedAt) : 0,
    tasks: Array.isArray(value?.tasks)
      ? value.tasks.filter((task: any) => task && typeof task === 'object').map(normalizeScheduledTask).slice(0, MAX_TASKS)
      : [],
  };
}

async function readDisk(): Promise<ScheduledTaskSnapshot> {
  if (cache) return cache;
  try {
    cache = normalizeSnapshot(await fs.readJson(STORE_PATH));
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && await fs.pathExists(STORE_PATH)) {
      await fs.ensureDir(STORE_DIR);
      await fs.move(STORE_PATH, path.join(STORE_DIR, `tasks.corrupt-${Date.now()}.json`), { overwrite: false }).catch(() => {});
    }
    cache = emptySnapshot();
  }
  return cache;
}

async function writeAtomic(snapshot: ScheduledTaskSnapshot): Promise<void> {
  await fs.ensureDir(STORE_DIR);
  const temporary = path.join(STORE_DIR, `.tasks.${process.pid}.${Date.now()}.tmp`);
  await fs.writeJson(temporary, snapshot, { spaces: 2 });
  await fs.move(temporary, STORE_PATH, { overwrite: true });
}

export async function loadScheduledTaskSnapshot(): Promise<ScheduledTaskSnapshot> {
  await writeQueue.catch(() => {});
  const snapshot = await readDisk();
  return { ...snapshot, tasks: snapshot.tasks.map(task => ({ ...task, history: [...(task.history || [])] })) };
}

export async function saveScheduledTaskSnapshot(tasks: ScheduledTaskRecord[], savedAt = Date.now()): Promise<ScheduledTaskSnapshot> {
  const next = normalizeSnapshot({ tasks, savedAt });
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await writeAtomic(next);
    cache = next;
    return next;
  });
  return writeQueue as Promise<ScheduledTaskSnapshot>;
}

export async function mutateScheduledTasks(
  mutation: (tasks: ScheduledTaskRecord[]) => ScheduledTaskRecord[] | void,
): Promise<ScheduledTaskSnapshot> {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const current = await readDisk();
    const working = current.tasks.map(task => normalizeScheduledTask(task));
    const result = mutation(working);
    const next = normalizeSnapshot({ tasks: result || working, savedAt: Date.now() });
    await writeAtomic(next);
    cache = next;
    return next;
  });
  return writeQueue as Promise<ScheduledTaskSnapshot>;
}
