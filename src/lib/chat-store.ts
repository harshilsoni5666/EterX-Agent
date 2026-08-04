import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { getEterxDataDir } from './agent/storage-paths';

const CHAT_STORE_DIR = path.join(getEterxDataDir(), 'chats');
const CHAT_STORE_PATH = path.join(CHAT_STORE_DIR, 'chats.json');
const CHAT_STORE_BACKUP_PATH = path.join(CHAT_STORE_DIR, 'chats.backup.json');
const CHAT_STORE_VERSION = 1;
const MAX_CHATS = 2000;

export interface PersistedChatSnapshot {
  version: number;
  savedAt: number;
  chats: unknown[];
}

let cachedSnapshot: PersistedChatSnapshot | null = null;
let cachedSnapshotFileSignature: string | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

const emptySnapshot = (): PersistedChatSnapshot => ({
  version: CHAT_STORE_VERSION,
  savedAt: 0,
  chats: [],
});

function legacyMessageText(message: any): string {
  const content = message?.content ?? message?.text ?? message?.output ?? message?.message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : String(part?.text || part?.content || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return String(content.text || content.value || content.content || '');
  }
  return '';
}

function normalizePersistedChat(chat: any): any | null {
  if (!chat || typeof chat !== 'object' || chat.id === undefined || chat.id === null) return null;

  const sourceLogs = Array.isArray(chat.traceLogs)
    ? chat.traceLogs
    : Array.isArray(chat.logs)
      ? chat.logs
      : Array.isArray(chat.messages)
        ? chat.messages
        : [];
  const traceLogs = sourceLogs.map((message: any, index: number) => {
    if (message && typeof message.type === 'string') return message;
    const role = String(message?.role || message?.sender || message?.author || '').toLowerCase();
    return {
      ...(message && typeof message === 'object' ? message : {}),
      type: role === 'user' || role === 'human' ? 'user_action' : 'answer',
      text: legacyMessageText(message),
      id: String(message?.id || `${String(chat.id)}-legacy-${index}`),
      ...(Number.isFinite(message?.timestamp) ? { timestamp: message.timestamp } : {}),
    };
  });

  return {
    ...chat,
    id: String(chat.id),
    title: String(chat.title || chat.name || 'New chat'),
    updatedAt: Number.isFinite(chat.updatedAt)
      ? chat.updatedAt
      : Number.isFinite(chat.updated_at)
        ? chat.updated_at
        : Number.isFinite(chat.createdAt)
          ? chat.createdAt
          : 0,
    traceLogs,
  };
}

function normalizeSnapshot(value: any): PersistedChatSnapshot {
  const chats = Array.isArray(value)
    ? value
    : value?.chats || value?.chatHistory || value?.sessions;
  if (!Array.isArray(chats)) return emptySnapshot();
  return {
    version: CHAT_STORE_VERSION,
    savedAt: Number.isFinite(value?.savedAt) ? Math.max(0, value.savedAt) : 0,
    chats: chats
      .map(normalizePersistedChat)
      .filter(Boolean)
      .slice(0, MAX_CHATS),
  };
}

function legacyChatStorePaths(): string[] {
  const home = os.homedir();
  const roots = [
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.XDG_DATA_HOME,
    path.join(home, 'Library', 'Application Support'),
    path.join(home, '.local', 'share'),
  ].filter(Boolean) as string[];
  const candidates = [
    path.join(process.cwd(), 'data', 'chats', 'chats.json'),
    path.join(process.cwd(), 'data', 'chats.json'),
    path.join(process.cwd(), 'chats', 'chats.json'),
  ];

  for (const root of roots) {
    for (const appName of ['EterX', 'eterx']) {
      candidates.push(path.join(root, appName, 'data', 'chats', 'chats.json'));
      candidates.push(path.join(root, appName, 'data', 'chats.json'));
      candidates.push(path.join(root, appName, 'chats', 'chats.json'));
    }
  }

  const canonicalPath = path.resolve(CHAT_STORE_PATH);
  const canonicalKey = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  return Array.from(new Set(candidates.map(candidate => path.resolve(candidate))))
    .filter(candidate => {
      const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      return key !== canonicalKey;
    });
}

async function readLegacySnapshot(): Promise<PersistedChatSnapshot | null> {
  for (const candidate of legacyChatStorePaths()) {
    try {
      const legacy = normalizeSnapshot(await fs.readJson(candidate));
      if (legacy.chats.length === 0) continue;
      console.warn(`[ChatStore] Imported legacy chat snapshot from ${candidate}`);
      return legacy;
    } catch {
      // Missing or malformed legacy candidates are ignored; the canonical
      // store and its recovery copy remain authoritative when present.
    }
  }
  return null;
}

async function readFromDisk(): Promise<PersistedChatSnapshot> {
  try {
    const stat = await fs.stat(CHAT_STORE_PATH);
    const fileSignature = `${ stat.mtimeMs }:${ stat.size }`;
    if (cachedSnapshot && cachedSnapshotFileSignature === fileSignature) {
      return cachedSnapshot;
    }

    const raw = await fs.readJson(CHAT_STORE_PATH);
    if (!raw || (
      !Array.isArray(raw) &&
      !Array.isArray(raw.chats) &&
      !Array.isArray(raw.chatHistory) &&
      !Array.isArray(raw.sessions)
    )) {
      throw new Error('Invalid chat snapshot');
    }
    const normalized = normalizeSnapshot(raw);
    // A first launch may have created an empty marker before the legacy
    // location was discovered. An unsaved empty marker is not authoritative;
    // import real legacy chats when they still exist.
    if (normalized.chats.length === 0 && normalized.savedAt === 0) {
      const legacySnapshot = await readLegacySnapshot();
      if (legacySnapshot) {
        cachedSnapshot = legacySnapshot;
        cachedSnapshotFileSignature = null;
        return cachedSnapshot;
      }
    }
    cachedSnapshot = normalized;
    cachedSnapshotFileSignature = fileSignature;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      const legacySnapshot = await readLegacySnapshot();
      if (legacySnapshot) {
        cachedSnapshot = legacySnapshot;
        cachedSnapshotFileSignature = null;
        return cachedSnapshot;
      }
      try {
        cachedSnapshot = normalizeSnapshot(await fs.readJson(CHAT_STORE_BACKUP_PATH));
        cachedSnapshotFileSignature = null;
        return cachedSnapshot;
      } catch {
        cachedSnapshot = emptySnapshot();
        cachedSnapshotFileSignature = null;
        return cachedSnapshot;
      }
    }

    if (await fs.pathExists(CHAT_STORE_PATH)) {
      const corruptPath = path.join(CHAT_STORE_DIR, `chats.corrupt-${Date.now()}.json`);
      await fs.move(CHAT_STORE_PATH, corruptPath, { overwrite: false }).catch(() => {});
      console.warn(`[ChatStore] Preserved unreadable chat data at ${corruptPath}`);
    }
    try {
      cachedSnapshot = normalizeSnapshot(await fs.readJson(CHAT_STORE_BACKUP_PATH));
    } catch {
      cachedSnapshot = emptySnapshot();
    }
    cachedSnapshotFileSignature = null;
  }
  return cachedSnapshot;
}

async function writeAtomic(snapshot: PersistedChatSnapshot): Promise<void> {
  await fs.ensureDir(CHAT_STORE_DIR);
  const temporaryPath = path.join(CHAT_STORE_DIR, `.chats.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
  // Keep a same-directory recovery copy before replacing the authoritative
  // file. Both files remain inside the per-user AppData chat store.
  if (await fs.pathExists(CHAT_STORE_PATH)) {
    await fs.copyFile(CHAT_STORE_PATH, CHAT_STORE_BACKUP_PATH).catch(() => {});
  }
  await fs.move(temporaryPath, CHAT_STORE_PATH, { overwrite: true });
}

export async function loadChatSnapshot(): Promise<PersistedChatSnapshot> {
  await writeQueue.catch(() => {});
  return { ...(await readFromDisk()), chats: [...(cachedSnapshot?.chats || [])] };
}

export async function loadChatById(chatId: string): Promise<unknown | null> {
  await writeQueue.catch(() => {});
  const snapshot = await readFromDisk();
  return (snapshot.chats as any[]).find(chat => chat?.id === chatId) || null;
}

export async function saveChatSnapshot(chats: unknown[], savedAt: number): Promise<PersistedChatSnapshot> {
  const requested = normalizeSnapshot({ chats, savedAt });
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    if (requested.savedAt < current.savedAt) return current;
    await writeAtomic(requested);
    cachedSnapshot = requested;
    cachedSnapshotFileSignature = null;
    return requested;
  });
  const stored = await writeQueue as PersistedChatSnapshot;
  return { ...stored, chats: [...stored.chats] };
}

export async function patchChatSnapshot(
  chats: unknown[],
  chatIds: string[],
  savedAt: number,
  deletedChatIds: unknown[] = [],
): Promise<PersistedChatSnapshot> {
  const safeIds = Array.from(new Set(chatIds.filter(id => typeof id === 'string' && id.length > 0))).slice(0, MAX_CHATS);
  const deletedIds = new Set(
    deletedChatIds
      .filter(id => typeof id === 'string' && id.length > 0)
      .map(id => String(id)),
  );
  const changed = normalizeSnapshot({ chats, savedAt }).chats as any[];
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    if (savedAt < current.savedAt) return current;
    const byId = new Map((current.chats as any[]).map(chat => [chat.id, chat]));
    for (const chat of changed) byId.set(chat.id, chat);
    deletedIds.forEach(id => byId.delete(id));
    const orderedIds = new Set(safeIds);
    const next = normalizeSnapshot({
      savedAt,
      // The client list can be stale while a restore or another tab is in
      // flight. Preserve durable chats omitted by that list; only explicit
      // deletion IDs are allowed to remove existing records.
      chats: [
        ...safeIds.map(id => byId.get(id)).filter(Boolean),
        ...(current.chats as any[]).filter(chat => !orderedIds.has(chat.id) && byId.has(chat.id)),
      ],
    });
    await writeAtomic(next);
    cachedSnapshot = next;
    cachedSnapshotFileSignature = null;
    return next;
  });
  const stored = await writeQueue as PersistedChatSnapshot;
  return { ...stored, chats: [...stored.chats] };
}
