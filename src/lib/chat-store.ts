import fs from 'fs-extra';
import path from 'path';
import { getEterxDataDir } from './agent/storage-paths';

const CHAT_STORE_DIR = path.join(getEterxDataDir(), 'chats');
const CHAT_STORE_PATH = path.join(CHAT_STORE_DIR, 'chats.json');
const CHAT_STORE_VERSION = 1;
const MAX_CHATS = 2000;

export interface PersistedChatSnapshot {
  version: number;
  savedAt: number;
  chats: unknown[];
}

let cachedSnapshot: PersistedChatSnapshot | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

const emptySnapshot = (): PersistedChatSnapshot => ({
  version: CHAT_STORE_VERSION,
  savedAt: 0,
  chats: [],
});

function normalizeSnapshot(value: any): PersistedChatSnapshot {
  if (!value || !Array.isArray(value.chats)) return emptySnapshot();
  return {
    version: CHAT_STORE_VERSION,
    savedAt: Number.isFinite(value.savedAt) ? Math.max(0, value.savedAt) : 0,
    chats: value.chats
      .filter((chat: any) => chat && typeof chat === 'object' && typeof chat.id === 'string')
      .slice(0, MAX_CHATS),
  };
}

async function readFromDisk(): Promise<PersistedChatSnapshot> {
  if (cachedSnapshot) return cachedSnapshot;
  try {
    cachedSnapshot = normalizeSnapshot(await fs.readJson(CHAT_STORE_PATH));
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && await fs.pathExists(CHAT_STORE_PATH)) {
      const corruptPath = path.join(CHAT_STORE_DIR, `chats.corrupt-${Date.now()}.json`);
      await fs.move(CHAT_STORE_PATH, corruptPath, { overwrite: false }).catch(() => {});
      console.warn(`[ChatStore] Preserved unreadable chat data at ${corruptPath}`);
    }
    cachedSnapshot = emptySnapshot();
  }
  return cachedSnapshot;
}

async function writeAtomic(snapshot: PersistedChatSnapshot): Promise<void> {
  await fs.ensureDir(CHAT_STORE_DIR);
  const temporaryPath = path.join(CHAT_STORE_DIR, `.chats.${process.pid}.${Date.now()}.tmp`);
  await fs.writeJson(temporaryPath, snapshot);
  await fs.move(temporaryPath, CHAT_STORE_PATH, { overwrite: true });
}

export async function loadChatSnapshot(): Promise<PersistedChatSnapshot> {
  await writeQueue.catch(() => {});
  return { ...(await readFromDisk()), chats: [...(cachedSnapshot?.chats || [])] };
}

export async function saveChatSnapshot(chats: unknown[], savedAt: number): Promise<PersistedChatSnapshot> {
  const requested = normalizeSnapshot({ chats, savedAt });
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    if (requested.savedAt < current.savedAt) return current;
    await writeAtomic(requested);
    cachedSnapshot = requested;
    return requested;
  });
  const stored = await writeQueue as PersistedChatSnapshot;
  return { ...stored, chats: [...stored.chats] };
}

export async function patchChatSnapshot(chats: unknown[], chatIds: string[], savedAt: number): Promise<PersistedChatSnapshot> {
  const safeIds = Array.from(new Set(chatIds.filter(id => typeof id === 'string' && id.length > 0))).slice(0, MAX_CHATS);
  const changed = normalizeSnapshot({ chats, savedAt }).chats as any[];
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    if (savedAt < current.savedAt) return current;
    const byId = new Map((current.chats as any[]).map(chat => [chat.id, chat]));
    for (const chat of changed) byId.set(chat.id, chat);
    const next = normalizeSnapshot({
      savedAt,
      chats: safeIds.map(id => byId.get(id)).filter(Boolean),
    });
    await writeAtomic(next);
    cachedSnapshot = next;
    return next;
  });
  const stored = await writeQueue as PersistedChatSnapshot;
  return { ...stored, chats: [...stored.chats] };
}
