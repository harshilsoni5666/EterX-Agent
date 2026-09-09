import fs from 'fs-extra';
import path from 'path';
import { getEterxDataDir } from './agent/storage-paths';
import { normalizeScheduledTask, type ScheduledTaskRecord } from './scheduled-tasks';

const STORE_DIR = path.join(getEterxDataDir(), 'scheduled-tasks');
const STORE_PATH = path.join(STORE_DIR, 'tasks.json');
const STORE_BACKUP_PATH = path.join(STORE_DIR, 'tasks.backup.json');
const MAX_TASKS = 2000;

const preserveCorruptTasks = async (source: string) => {
  if (source !== STORE_PATH || !fs.existsSync(source)) return;
  const preserved = path.join(STORE_DIR, `tasks.corrupt-${Date.now()}.json`);
  await fs.move(source, preserved, { overwrite: false }).catch(() => {});
};

export interface ScheduledTaskSnapshot {
  version: 1;
  savedAt: number;
  tasks: ScheduledTaskRecord[];
}

let cache: ScheduledTaskSnapshot | null = null;
let cacheFingerprint = '';
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
  // The agent tool and the API route can be loaded by separate Next/Electron
  // module runtimes. A module-level cache can therefore be stale even though
  // another runtime has already committed a newer tasks.json.
  try {
    const source = await fs.pathExists(STORE_PATH) ? STORE_PATH : STORE_BACKUP_PATH;
    const stats = await fs.stat(source);
    const fingerprint = `${source}:${stats.size}:${stats.mtimeMs}`;
    if (cache && cacheFingerprint === fingerprint) return cache;
    const raw = await fs.readJson(source);
    if (!raw || !Array.isArray(raw.tasks)) throw new Error('Invalid scheduled task snapshot');
    cache = normalizeSnapshot(raw);
    cacheFingerprint = fingerprint;
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && await fs.pathExists(STORE_PATH)) await preserveCorruptTasks(STORE_PATH);
    try {
      const stats = await fs.stat(STORE_BACKUP_PATH);
      const fingerprint = `${STORE_BACKUP_PATH}:${stats.size}:${stats.mtimeMs}`;
      if (cache && cacheFingerprint === fingerprint) return cache;
      cache = normalizeSnapshot(await fs.readJson(STORE_BACKUP_PATH));
      cacheFingerprint = fingerprint;
    } catch {
      cache = emptySnapshot();
      cacheFingerprint = '';
    }
  }
  return cache;
}

async function writeAtomic(snapshot: ScheduledTaskSnapshot): Promise<void> {
  await fs.ensureDir(STORE_DIR);
  const temporary = path.join(STORE_DIR, `.tasks.${process.pid}.${Date.now()}.tmp`);
  await fs.writeJson(temporary, snapshot, { spaces: 2 });
  if (await fs.pathExists(STORE_PATH)) {
    await fs.copyFile(STORE_PATH, STORE_BACKUP_PATH).catch(() => {});
  }
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
    const current = await readDisk();
    if (next.savedAt < current.savedAt) return current;
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
