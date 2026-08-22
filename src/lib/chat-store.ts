import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { stableScopeSegment } from './agent/context-scope';
import { getEterxDataDir, getEterxWorkspaceDir } from './agent/storage-paths';
import { filterUserVisibleTraces } from './agent/trace-visibility';
import {
  mergeFeedTraceHistories,
  recoverMissingUserTurnBoundaries,
  settleFeedTraceLifecycles,
  type RecoveredUserRequest,
} from './chat-feed-lifecycle';

const CHAT_STORE_DIR = path.join(getEterxDataDir(), 'chats');
const CHAT_STORE_PATH = path.join(CHAT_STORE_DIR, 'chats.json');
const CHAT_STORE_BACKUP_PATH = path.join(CHAT_STORE_DIR, 'chats.backup.json');
const CHAT_STORE_VERSION = 1;
const CONTEXT_FABRIC_ROOT = getEterxWorkspaceDir('.context', 'fabric');
const gunzipAsync = promisify(gunzip);

export interface PersistedChatSnapshot {
  version: number;
  savedAt: number;
  lastMutationId?: string;
  chats: unknown[];
}

export interface ChatSnapshotWriteResult extends PersistedChatSnapshot {
  applied: boolean;
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

function normalizeChatTitle(value: unknown): string {
  const title = String(value || '').trim();
  if (!title || /^[*#\-\s]*(?:input\s*:\s*)?current\s+title$/i.test(title)) {
    return 'New chat';
  }
  return title;
}

function normalizePersistedChat(chat: any): any | null {
  if (!chat || typeof chat !== 'object' || chat.id === undefined || chat.id === null) return null;

  const title = normalizeChatTitle(chat.title || chat.name);

  const sourceLogs = Array.isArray(chat.traceLogs)
    ? chat.traceLogs
    : Array.isArray(chat.logs)
      ? chat.logs
      : Array.isArray(chat.messages)
        ? chat.messages
        : [];
  const traceLogs = settleFeedTraceLifecycles(recoverMissingUserTurnBoundaries(filterUserVisibleTraces(sourceLogs.map((message: any, index: number) => {
    if (message && typeof message.type === 'string') return message;
    const role = String(message?.role || message?.sender || message?.author || '').toLowerCase();
    return {
      ...(message && typeof message === 'object' ? message : {}),
      type: role === 'user' || role === 'human' ? 'user_action' : 'answer',
      text: legacyMessageText(message),
      id: String(message?.id || `${String(chat.id)}-legacy-${index}`),
      ...(Number.isFinite(message?.timestamp) ? { timestamp: message.timestamp } : {}),
    };
  }))));

  return {
    ...chat,
    id: String(chat.id),
    title,
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

function normalizeRecoveredRequestText(value: unknown): string {
  return String(value || '')
    .replace(/^\s*\[USER REQUEST\]\s*(?:\r?\n)?/i, '')
    .trim();
}

function requestPayload(value: unknown): any | null {
  if (value && typeof value === 'object') return value;
  const serialized = String(value || '').trim();
  if (!serialized) return null;
  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function resolveContextPagePath(scopeDir: string, pageRef: unknown): string | null {
  const normalized = String(pageRef || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized.startsWith('pages/') || normalized.includes('..')) return null;
  const scopeRoot = path.resolve(scopeDir);
  const absolute = path.resolve(scopeRoot, normalized);
  return absolute.startsWith(`${scopeRoot}${path.sep}`) ? absolute : null;
}

async function readContextPage(scopeDir: string, pageRef: unknown): Promise<any | null> {
  const absolute = resolveContextPagePath(scopeDir, pageRef);
  if (!absolute) return null;
  try {
    let serialized = '';
    if (absolute.endsWith('.manifest.json')) {
      const manifest = await fs.readJson(absolute);
      const chunks: Buffer[] = [];
      for (const chunkRef of Array.isArray(manifest?.chunks) ? manifest.chunks : []) {
        const chunkPath = resolveContextPagePath(scopeDir, chunkRef);
        if (!chunkPath) return null;
        chunks.push(await gunzipAsync(await fs.readFile(chunkPath)));
      }
      serialized = Buffer.concat(chunks).toString('utf8');
    } else {
      serialized = (await gunzipAsync(await fs.readFile(absolute))).toString('utf8');
    }
    return requestPayload(serialized);
  } catch {
    return null;
  }
}

async function loadRecoveredUserRequests(chatId: string): Promise<RecoveredUserRequest[]> {
  const scopeDir = path.join(CONTEXT_FABRIC_ROOT, stableScopeSegment(chatId));
  const episodes = new Map<string, any>();

  try {
    const lines = String(await fs.readFile(path.join(scopeDir, 'events.jsonl'), 'utf8')).split(/\r?\n/);
    lines.forEach(line => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        const episode = event?.operation === 'episode' ? event.episode : null;
        if (episode?.source !== 'user') return;
        episodes.set(String(episode.id || episode.contentHash || `${episode.createdAt}:${episodes.size}`), episode);
      } catch {
        // A partially appended tail line must not prevent older requests from
        // repairing the transcript after an interrupted desktop shutdown.
      }
    });
  } catch {
    // The compact snapshot below is the fallback for migrated fabrics that
    // predate the append-only event ledger.
  }

  try {
    const snapshot = await fs.readJson(path.join(scopeDir, 'snapshot.json'));
    (Array.isArray(snapshot?.episodes) ? snapshot.episodes : []).forEach((episode: any) => {
      if (episode?.source !== 'user') return;
      episodes.set(String(episode.id || episode.contentHash || `${episode.createdAt}:${episodes.size}`), episode);
    });
  } catch {
    // An events-only fabric is valid while its debounced snapshot is pending.
  }

  const recovered: RecoveredUserRequest[] = [];
  const seen = new Set<string>();
  for (const episode of episodes.values()) {
    const header = String(episode?.header || '').trim();
    if (!/^user request\b/i.test(header) || /\bretry\b/i.test(header)) continue;
    const preview = requestPayload(episode?.contentPreview);
    if (String(preview?.mode || '').toLowerCase() === 'retry') continue;
    const full = await readContextPage(scopeDir, episode?.pageRef);
    const payload = full || preview;
    if (payload?.mode && String(payload.mode).toLowerCase() !== 'new') continue;
    const text = normalizeRecoveredRequestText(payload?.request);
    if (!text) continue;
    const timestamp = Number(episode?.createdAt || 0);
    const identity = `${Number.isFinite(timestamp) ? timestamp : 0}:${text}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    recovered.push({ text, ...(Number.isFinite(timestamp) && timestamp > 0 ? { timestamp } : {}) });
  }
  return recovered.sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
}

async function hydrateRecoveredUserBoundaries(snapshot: PersistedChatSnapshot): Promise<PersistedChatSnapshot> {
  const chats = await Promise.all((snapshot.chats as any[]).map(async chat => {
    const traceLogs = Array.isArray(chat?.traceLogs) ? chat.traceLogs : [];
    const needsExactRequest = traceLogs.some(log =>
      (log?._recoveredBoundary === true && log?._recoveredExactText !== true) ||
      (log?.type === 'user_action' && !String(log?.text || '').trim()),
    );
    if (!needsExactRequest) return chat;
    const requests = await loadRecoveredUserRequests(String(chat.id || ''));
    return {
      ...chat,
      traceLogs: settleFeedTraceLifecycles(recoverMissingUserTurnBoundaries(traceLogs, requests)),
    };
  }));
  return { ...snapshot, chats };
}

function normalizeSnapshot(value: any): PersistedChatSnapshot {
  const chats = Array.isArray(value)
    ? value
    : value?.chats || value?.chatHistory || value?.sessions;
  if (!Array.isArray(chats)) return emptySnapshot();
  return {
    version: CHAT_STORE_VERSION,
    savedAt: Number.isFinite(value?.savedAt) ? Math.max(0, value.savedAt) : 0,
    ...(typeof value?.lastMutationId === 'string' && value.lastMutationId
      ? { lastMutationId: value.lastMutationId.slice(0, 200) }
      : {}),
    chats: chats
      .map(normalizePersistedChat)
      .filter(Boolean),
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
    const normalized = await hydrateRecoveredUserBoundaries(normalizeSnapshot(raw));
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
        cachedSnapshot = await hydrateRecoveredUserBoundaries(normalizeSnapshot(await fs.readJson(CHAT_STORE_BACKUP_PATH)));
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
      cachedSnapshot = await hydrateRecoveredUserBoundaries(normalizeSnapshot(await fs.readJson(CHAT_STORE_BACKUP_PATH)));
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

export async function saveChatSnapshot(chats: unknown[], savedAt: number, mutationId = ''): Promise<ChatSnapshotWriteResult> {
  const requested = normalizeSnapshot({ chats, savedAt, lastMutationId: mutationId });
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    if (mutationId && current.lastMutationId === mutationId) return { ...current, applied: true };
    if (requested.savedAt < current.savedAt) return { ...current, applied: false };
    const currentById = new Map((current.chats as any[]).map(chat => [chat.id, chat]));
    const mergedChats = (requested.chats as any[]).map(chat => {
      const durable = currentById.get(chat.id);
      if (!durable) return chat;
      return {
        ...durable,
        ...chat,
        traceLogs: mergeFeedTraceHistories(
          durable.traceLogs || [],
          chat.traceLogs || [],
        ),
      };
    });
    const next = await hydrateRecoveredUserBoundaries(normalizeSnapshot({
      ...requested,
      chats: mergedChats,
      savedAt: Math.max(requested.savedAt, current.savedAt + 1),
      lastMutationId: mutationId,
    }));
    await writeAtomic(next);
    cachedSnapshot = next;
    cachedSnapshotFileSignature = null;
    return { ...next, applied: true };
  });
  const stored = await writeQueue as ChatSnapshotWriteResult;
  return { ...stored, chats: [...stored.chats] };
}

export async function patchChatSnapshot(
  chats: unknown[],
  chatIds: string[],
  savedAt: number,
  deletedChatIds: unknown[] = [],
  mutationId = '',
): Promise<ChatSnapshotWriteResult> {
  const safeIds = Array.from(new Set(chatIds.filter(id => typeof id === 'string' && id.length > 0)));
  const deletedIds = new Set(
    deletedChatIds
      .filter(id => typeof id === 'string' && id.length > 0)
      .map(id => String(id)),
  );
  const changed = normalizeSnapshot({ chats, savedAt }).chats as any[];
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    if (mutationId && current.lastMutationId === mutationId) return { ...current, applied: true };
    if (savedAt < current.savedAt) return { ...current, applied: false };
    const byId = new Map((current.chats as any[]).map(chat => [chat.id, chat]));
    for (const chat of changed) {
      const durable = byId.get(chat.id);
      byId.set(chat.id, durable ? {
        ...durable,
        ...chat,
        traceLogs: mergeFeedTraceHistories(
          durable.traceLogs || [],
          chat.traceLogs || [],
        ),
      } : chat);
    }
    deletedIds.forEach(id => byId.delete(id));
    const orderedIds = new Set(safeIds);
    const next = await hydrateRecoveredUserBoundaries(normalizeSnapshot({
      savedAt: Math.max(savedAt, current.savedAt + 1),
      lastMutationId: mutationId,
      // The client list can be stale while a restore or another tab is in
      // flight. Preserve durable chats omitted by that list; only explicit
      // deletion IDs are allowed to remove existing records.
      chats: [
        ...safeIds.map(id => byId.get(id)).filter(Boolean),
        ...(current.chats as any[]).filter(chat => !orderedIds.has(chat.id) && byId.has(chat.id)),
      ],
    }));
    await writeAtomic(next);
    cachedSnapshot = next;
    cachedSnapshotFileSignature = null;
    return { ...next, applied: true };
  });
  const stored = await writeQueue as ChatSnapshotWriteResult;
  return { ...stored, chats: [...stored.chats] };
}
