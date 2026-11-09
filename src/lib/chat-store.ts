import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { buildChatCopy, nextChatCopyTitle } from './chat-copy';
import { copyChatMedia, removeChatMedia } from './chat-media-store';
import { getContextFabricForChat } from './agent/context-fabric';
import { getEterxDataDir } from './agent/storage-paths';
import { filterUserVisibleTraces } from './agent/trace-visibility';
import { buildTemporaryTitle, mergeChatTitleMetadata } from './chat/title-generation';
import { visibleUserRequest } from './chat-user-payload';
import { normalizeImportedTraces } from './imports/presentation';
import { importedWorkspaceMetadata } from './imports/workspace';
import {
  mergeFeedTraceHistories,
  isConclusiveSettledAnswerTrace,
  recoverMissingUserTurnBoundaries,
  settleFeedTraceLifecycles,
  type RecoveredUserRequest,
} from './chat-feed-lifecycle';

const CHAT_STORE_DIR = path.join(getEterxDataDir(), 'chats');
const CHAT_STORE_PATH = path.join(CHAT_STORE_DIR, 'chats.json');
const CHAT_STORE_BACKUP_PATH = path.join(CHAT_STORE_DIR, 'chats.backup.json');
const CHAT_STORE_VERSION = 1;

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
let pendingSnapshotRead: Promise<PersistedChatSnapshot> | null = null;
// Next can bundle the import and chat routes separately. Their writes must
// still serialize against the same durable transcript in this process.
const chatStoreGlobal = globalThis as typeof globalThis & { __eterxChatWrites?: { queue: Promise<unknown> } };
const chatWrites = chatStoreGlobal.__eterxChatWrites ||= { queue: Promise.resolve() };
const auditedDialogueChats = new Set<string>();

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

  const storedLogs = Array.isArray(chat.traceLogs)
    ? chat.traceLogs
    : Array.isArray(chat.logs)
      ? chat.logs
      : Array.isArray(chat.messages)
        ? chat.messages
        : [];
  const sourceLogs = normalizeImportedTraces(storedLogs);
  const traceLogs = settleFeedTraceLifecycles(recoverMissingUserTurnBoundaries(filterUserVisibleTraces(sourceLogs.map((message: any, index: number) => {
    if (message && typeof message.type === 'string') return ['user_action', 'steering_received', 'steering_queued'].includes(message.type)
      ? { ...message, text: visibleUserRequest(message.text) } : message;
    const role = String(message?.role || message?.sender || message?.author || '').toLowerCase();
    return {
      ...(message && typeof message === 'object' ? message : {}),
      type: role === 'user' || role === 'human' ? 'user_action' : 'answer',
      text: legacyMessageText(message),
      id: String(message?.id || `${String(chat.id)}-legacy-${index}`),
      ...(Number.isFinite(message?.timestamp) ? { timestamp: message.timestamp } : {}),
    };
  }))));

  // Older snapshots persisted the preview without its pending marker. Recover
  // only exact query previews with no recorded successful title generation.
  const firstUser = traceLogs.find((log: any) => log.type === 'user_action');
  const legacyPreview = !chat.titleState &&
    !traceLogs.some((log: any) => log.type === 'model_usage' && log.phase === 'chat_title') &&
    Boolean(firstUser?.text) && title === buildTemporaryTitle(firstUser.text);
  return {
    ...chat,
    id: String(chat.id),
    title,
    ...(legacyPreview ? { titleState: 'temporary' } : {}),
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
  return visibleUserRequest(value)
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

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface RecoveredDialogueRequest extends RecoveredUserRequest {
  episodeId: string;
  originId?: string;
}

interface RecoveredDialogueResponse {
  episodeId: string;
  originId?: string;
  text: string;
  timestamp?: number;
  runId?: string;
}

interface RecoveredDialogue {
  requests: RecoveredDialogueRequest[];
  responses: RecoveredDialogueResponse[];
}

const exactDialogueText = (value: unknown): string => String(value ?? '').replace(/\u0000/g, '');

const importedTraceIdentity = (
  originId: unknown,
  expectedRole: 'user' | 'assistant',
): string => {
  const match = String(originId || '').trim().match(/^chat-trace:(.*):(user|assistant)$/i);
  if (!match || match[2].toLowerCase() !== expectedRole) return '';
  return String(match[1] || '').trim();
};

const isMainAnswer = (log: any): boolean => Boolean(
  log?.type === 'answer' &&
  !log?.subAgentId &&
  !log?.subAgentChatId &&
  !log?.subAgent &&
  log?.isSubAgent !== true,
);

const hasExactImportedTrace = (
  traceLogs: any[],
  originId: unknown,
  role: 'user' | 'assistant',
): boolean => {
  const traceId = importedTraceIdentity(originId, role);
  if (!traceId) return false;
  return traceLogs.some((log: any) => {
    if (role === 'user' && !['user_action', 'steering_received'].includes(log?.type)) return false;
    if (role === 'assistant' && !isMainAnswer(log)) return false;
    return [log?.id, log?.answerId].some(value => String(value || '').trim() === traceId) &&
      Boolean(String(log?.text || '').trim());
  });
};

async function loadRecoveredDialogue(chatId: string, traceLogs: any[]): Promise<RecoveredDialogue> {
  const fabric = await getContextFabricForChat(chatId);
  const episodes = fabric.listEpisodes().filter(episode =>
    ['user', 'runtime'].includes(String(episode?.source || '')),
  );

  const recovered: RecoveredDialogue = { requests: [], responses: [] };
  const seenRequests = new Set<string>();
  const seenResponses = new Set<string>();
  for (const episode of episodes) {
    const header = String(episode?.header || '').trim();
    const isObservedRequest = /^user request\b/i.test(header);
    const isImportedUser = /^imported user message\b/i.test(header);
    const responseMatch = header.match(/^assistant response\s*\((completed|stopped|failed)\)/i);
    const isImportedAssistant = /^imported assistant response\b/i.test(header);
    if (!isObservedRequest && !isImportedUser && !responseMatch && !isImportedAssistant) continue;
    if (isObservedRequest && /\bretry\b/i.test(header)) continue;

    const preview = requestPayload(episode?.contentPreview);
    const timestamp = Number(episode?.createdAt || 0);
    const originId = String(episode?.originId || '').trim();
    const episodeId = String(episode?.id || episode?.contentHash || `${timestamp}:${header}`);

    if (isObservedRequest || isImportedUser) {
      if (String(preview?.mode || '').toLowerCase() === 'retry') continue;
      const runId = originId.startsWith('user-run:')
        ? originId.slice('user-run:'.length).trim()
        : '';
      if (hasExactImportedTrace(traceLogs, originId, 'user')) continue;
      const payload = await fabric.openPage(episode.pageRef).catch(() => null) as any;
      // Recovery is exact-or-nothing. A preview is deliberately never used as
      // transcript text because previews are bounded presentation metadata.
      if (!payload || String(payload?.mode || '').toLowerCase() === 'retry') continue;
      const rawText = isImportedUser ? payload?.text : payload?.request;
      const text = visibleUserRequest(exactDialogueText(rawText)).replace(/^\s*\[USER REQUEST\]\s*(?:\r?\n)?/i, '');
      if (!text.trim()) continue;
      const identity = originId || episodeId;
      if (seenRequests.has(identity)) continue;
      seenRequests.add(identity);
      recovered.requests.push({
        episodeId,
        ...(originId ? { originId } : {}),
        text,
        ...(Number.isFinite(timestamp) && timestamp > 0 ? { timestamp } : {}),
        ...(runId ? { runId } : {}),
      });
      continue;
    }

    const outcome = String(responseMatch?.[1] || preview?.outcome || 'completed').toLowerCase();
    // Failed terminal records belong in the existing error lifecycle, not in
    // an assistant answer bubble. A stopped run similarly has no guaranteed
    // completed assistant message to reconstruct.
    if (!isImportedAssistant && outcome !== 'completed') continue;
    const runId = originId.startsWith('assistant-run:')
      ? originId.slice('assistant-run:'.length).trim()
      : '';
    if (hasExactImportedTrace(traceLogs, originId, 'assistant')) continue;
    const payload = await fabric.openPage(episode.pageRef).catch(() => null) as any;
    if (!payload) continue;
    const text = exactDialogueText(isImportedAssistant ? payload?.text : payload?.answer);
    if (!text.trim()) continue;
    const identity = originId || episodeId;
    if (seenResponses.has(identity)) continue;
    seenResponses.add(identity);
    recovered.responses.push({
      episodeId,
      ...(originId ? { originId } : {}),
      text,
      ...(Number.isFinite(timestamp) && timestamp > 0 ? { timestamp } : {}),
      ...(runId ? { runId } : {}),
    });
  }
  recovered.requests.sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
  recovered.responses.sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
  return recovered;
}

const traceTimestamp = (log: any): number => {
  const value = [log?.startTime, log?.timestamp, log?.endTime]
    .map(Number)
    .find(candidate => Number.isFinite(candidate) && candidate > 0);
  if (!value) return 0;
  if (value < 10_000_000_000) return value * 1000;
  return value;
};

const recoveryIdentity = (prefix: string, value: string): string =>
  `${prefix}-${sha256(value).slice(0, 24)}`;

const chatNeedsDialogueRecovery = (traceLogs: any[]): boolean => {
  if (traceLogs.length === 0) return true;
  if (traceLogs.some((log: any) =>
    (log?._recoveredBoundary === true && log?._recoveredExactText !== true) ||
    (log?.type === 'user_action' && !String(log?.text || '').trim()),
  )) return true;

  let latestBoundary = -1;
  traceLogs.forEach((log: any, index: number) => {
    if (log?.type === 'user_action' || log?.type === 'steering_received') latestBoundary = index;
  });
  if (latestBoundary < 0) return false;
  const turnLogs = traceLogs.slice(latestBoundary + 1);
  const hasAnswer = turnLogs.some((log: any, index: number) =>
    isMainAnswer(log) && isConclusiveSettledAnswerTrace(log, index, turnLogs),
  );
  if (hasAnswer) return false;
  return turnLogs.some((log: any) => {
    const type = String(log?.type || '').toLowerCase();
    const status = String(log?.status || '').toLowerCase();
    return (type === 'done' || log?.mainTurnTerminal === true) &&
      ['completed', 'stopped'].includes(status || 'completed');
  });
};

function recoveredDialogueTraces(
  chatId: string,
  traceLogs: any[],
  dialogue: RecoveredDialogue,
): any[] {
  let working = recoverMissingUserTurnBoundaries(traceLogs, dialogue.requests);
  const additions: any[] = [];
  const claimedUserBoundaryIndexes = new Set<number>();
  const representedRequestsPerRun = new Map<string, number>();

  for (const request of dialogue.requests) {
    const importedId = importedTraceIdentity(request.originId, 'user');
    const requestAt = Number(request.timestamp || 0);
    const candidates = working
      .map((log: any, index: number) => ({ log, index }))
      .filter(({ log, index }) => {
        if (claimedUserBoundaryIndexes.has(index) || !['user_action', 'steering_received'].includes(log?.type)) return false;
        const text = normalizeRecoveredRequestText(log?.text);
        if (!text) return false;
        const exactImportedIdentity = Boolean(
          importedId && [log?.id, log?.turnId].some(value => String(value || '').trim() === importedId),
        );
        if (exactImportedIdentity) return true;
        const logRunId = String(log?.runId || log?.turnId || '').trim();
        if (request.runId && logRunId && logRunId !== request.runId) return false;
        if (exactDialogueText(text) !== exactDialogueText(request.text)) return false;
        return Boolean(request.runId && logRunId === request.runId) ||
          !requestAt || !traceTimestamp(log) || Math.abs(traceTimestamp(log) - requestAt) < 60_000;
      })
      .sort((left, right) => {
        const leftImported = importedId && [left.log?.id, left.log?.turnId]
          .some(value => String(value || '').trim() === importedId) ? 0 : 1;
        const rightImported = importedId && [right.log?.id, right.log?.turnId]
          .some(value => String(value || '').trim() === importedId) ? 0 : 1;
        if (leftImported !== rightImported) return leftImported - rightImported;
        if (requestAt) {
          const leftDistance = traceTimestamp(left.log) ? Math.abs(traceTimestamp(left.log) - requestAt) : Number.MAX_SAFE_INTEGER;
          const rightDistance = traceTimestamp(right.log) ? Math.abs(traceTimestamp(right.log) - requestAt) : Number.MAX_SAFE_INTEGER;
          if (leftDistance !== rightDistance) return leftDistance - rightDistance;
        }
        return left.index - right.index;
      });
    if (candidates.length > 0) {
      claimedUserBoundaryIndexes.add(candidates[0].index);
      if (request.runId) {
        representedRequestsPerRun.set(
          request.runId,
          (representedRequestsPerRun.get(request.runId) || 0) + 1,
        );
      }
      continue;
    }
    const stableIdentity = request.originId || request.episodeId;
    const representedInRun = request.runId ? representedRequestsPerRun.get(request.runId) || 0 : 0;
    // A long-lived run may contain several human/Proxy turns. Only its first
    // request can safely use the run ID as the turn ID; later recovered
    // requests need their own immutable boundary or ordering will collapse
    // them and their actions back into the first query.
    const turnId = importedId || (
      request.runId && representedInRun === 0
        ? request.runId
        : recoveryIdentity('recovered-turn', stableIdentity)
    );
    const timestamp = Number(request.timestamp || 0);
    additions.push({
      id: importedId || recoveryIdentity('recovered-user', stableIdentity),
      type: 'user_action',
      text: request.text,
      source: 'human',
      ownerChatId: chatId,
      ...(request.runId ? { runId: request.runId } : {}),
      turnId,
      ...(request.runId && turnId === request.runId ? { admissionId: request.runId } : {}),
      _recoveredBoundary: true,
      _recoveredExactText: true,
      _recoveredContextEpisodeId: request.episodeId,
      ...(timestamp > 0 ? { timestamp, startTime: timestamp, endTime: timestamp } : {}),
    });
    if (request.runId) representedRequestsPerRun.set(request.runId, representedInRun + 1);
  }

  working = mergeFeedTraceHistories(working, additions, dialogue.requests);
  const combinedForOwnership = [...working];
  const claimedResponseIndexes = new Set<number>();
  for (const response of dialogue.responses) {
    const importedId = importedTraceIdentity(response.originId, 'assistant');
    const responseAt = Number(response.timestamp || 0);
    const represented = combinedForOwnership
      .map((log: any, index: number) => ({ log, index }))
      .filter(({ log, index }) => {
        if (claimedResponseIndexes.has(index)) return false;
        if (!isMainAnswer(log) || exactDialogueText(log?.text) !== response.text) return false;
        if (response.runId && String(log?.runId || '').trim() !== response.runId) return false;
        if (importedId && ![log?.id, log?.answerId].some(value => String(value || '').trim() === importedId)) {
          // A context import may assign a new ID to the same terminal answer.
          // Exact text plus its immutable run and close time identifies that
          // copy without conflating repeated answers from different turns.
          if (!response.runId || !responseAt || !traceTimestamp(log) ||
            Math.abs(traceTimestamp(log) - responseAt) > 1000) return false;
        }
        return isConclusiveSettledAnswerTrace(log, index, combinedForOwnership);
      })
      .sort((left, right) => {
        if (!responseAt) return left.index - right.index;
        const leftDistance = traceTimestamp(left.log) ? Math.abs(traceTimestamp(left.log) - responseAt) : Number.MAX_SAFE_INTEGER;
        const rightDistance = traceTimestamp(right.log) ? Math.abs(traceTimestamp(right.log) - responseAt) : Number.MAX_SAFE_INTEGER;
        return leftDistance - rightDistance || left.index - right.index;
      })[0];
    if (represented) {
      claimedResponseIndexes.add(represented.index);
      continue;
    }

    const ownedBoundaries = combinedForOwnership
      .filter((log: any) =>
        (log?.type === 'user_action' || log?.type === 'steering_received') &&
        (!response.runId || String(log?.runId || '').trim() === response.runId) &&
        (!responseAt || !traceTimestamp(log) || traceTimestamp(log) <= responseAt),
      )
      .sort((left: any, right: any) => traceTimestamp(right) - traceTimestamp(left));
    const owner = ownedBoundaries[0];
    const turnId = String(owner?.turnId || response.runId || '').trim();
    const stableIdentity = response.originId || response.episodeId;
    const answerId = importedId || recoveryIdentity('recovered-answer', stableIdentity);
    const recovered = {
      id: importedId || answerId,
      answerId,
      type: 'answer',
      text: response.text,
      ownerChatId: chatId,
      ...(response.runId ? { runId: response.runId } : {}),
      ...(turnId ? { turnId } : {}),
      isStreaming: false,
      isLiveTyping: false,
      isDelta: false,
      streamState: 'closed',
      status: 'completed',
      final: true,
      _recoveredExactText: true,
      _recoveredContextEpisodeId: response.episodeId,
      ...(responseAt > 0 ? {
        timestamp: responseAt,
        startTime: responseAt,
        endTime: responseAt,
      } : {}),
    };
    additions.push(recovered);
    combinedForOwnership.push(recovered);
  }
  return mergeFeedTraceHistories(working, additions, dialogue.requests);
}

async function hydrateRecoveredDialogue(snapshot: PersistedChatSnapshot): Promise<PersistedChatSnapshot> {
  const hydrateChat = async (chat: any) => {
    const traceLogs = Array.isArray(chat?.traceLogs) ? chat.traceLogs : [];
    const chatId = String(chat?.id || '').trim();
    if (!chatId) return chat;
    const requiresRepair = chatNeedsDialogueRecovery(traceLogs);
    // Audit every durable chat once per process so a whole turn lost by an
    // interrupted snapshot write is still reconstructed. Subsequent normal
    // saves stay cheap unless the visible terminal lifecycle proves a gap.
    if (auditedDialogueChats.has(chatId) && !requiresRepair) return chat;
    let dialogue: RecoveredDialogue;
    try {
      dialogue = await loadRecoveredDialogue(chatId, traceLogs);
    } catch (error) {
      // A damaged context episode is not a damaged chat snapshot. Preserve
      // the valid conversation and leave it eligible for a later repair.
      console.warn(`[ChatStore] Dialogue recovery unavailable for ${chatId}`, error);
      return chat;
    }
    auditedDialogueChats.add(chatId);
    if (dialogue.requests.length === 0 && dialogue.responses.length === 0) return chat;
    return {
      ...chat,
      traceLogs: settleFeedTraceLifecycles(recoveredDialogueTraces(chatId, traceLogs, dialogue)),
    };
  };
  // Large histories must not open every context store simultaneously on
  // launch. A small worker pool keeps disk and memory pressure bounded.
  const chats = new Array(snapshot.chats.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, snapshot.chats.length) }, async () => {
    while (nextIndex < snapshot.chats.length) {
      const index = nextIndex++;
      chats[index] = await hydrateChat(snapshot.chats[index]);
    }
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

function readFromDisk(): Promise<PersistedChatSnapshot> {
  if (!pendingSnapshotRead) {
    pendingSnapshotRead = readSnapshotFromDisk().finally(() => {
      pendingSnapshotRead = null;
    });
  }
  return pendingSnapshotRead;
}

async function readSnapshotFromDisk(): Promise<PersistedChatSnapshot> {
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
    const normalized = await hydrateRecoveredDialogue(normalizeSnapshot(raw));
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
        cachedSnapshot = await hydrateRecoveredDialogue(normalizeSnapshot(await fs.readJson(CHAT_STORE_BACKUP_PATH)));
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
      cachedSnapshot = await hydrateRecoveredDialogue(normalizeSnapshot(await fs.readJson(CHAT_STORE_BACKUP_PATH)));
    } catch {
      cachedSnapshot = emptySnapshot();
    }
    cachedSnapshotFileSignature = null;
  }
  return cachedSnapshot;
}

async function writeAtomic(snapshot: PersistedChatSnapshot): Promise<string | null> {
  await fs.ensureDir(CHAT_STORE_DIR);
  const temporaryPath = path.join(CHAT_STORE_DIR, `.chats.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
  // Keep a same-directory recovery copy before replacing the authoritative
  // file. Both files remain inside the per-user AppData chat store.
  if (await fs.pathExists(CHAT_STORE_PATH)) {
    await fs.copyFile(CHAT_STORE_PATH, CHAT_STORE_BACKUP_PATH).catch(() => {});
  }
  await fs.move(temporaryPath, CHAT_STORE_PATH, { overwrite: true });
  // Retain the normalized snapshot after a save instead of reading and
  // rebuilding every conversation again on the very next request.
  return fs.stat(CHAT_STORE_PATH)
    .then(stat => `${stat.mtimeMs}:${stat.size}`)
    .catch(() => null);
}

export async function loadChatSnapshot(): Promise<PersistedChatSnapshot> {
  await chatWrites.queue.catch(() => {});
  const snapshot = await readFromDisk();
  return { ...snapshot, chats: [...snapshot.chats] };
}

export async function loadChatById(chatId: string): Promise<unknown | null> {
  await chatWrites.queue.catch(() => {});
  const snapshot = await readFromDisk();
  return (snapshot.chats as any[]).find(chat => chat?.id === chatId) || null;
}

function mergeChatForAction(durable: any, incoming: unknown) {
  if (!incoming) return durable;
  const candidate = normalizePersistedChat(incoming);
  if (!candidate || candidate.id !== durable.id) throw new Error('Invalid conversation snapshot.');
  const newest = Number(candidate.updatedAt || 0) >= Number(durable.updatedAt || 0) ? candidate : durable;
  const workspace = Number(candidate.workspaceSelectionUpdatedAt || 0) >= Number(durable.workspaceSelectionUpdatedAt || 0)
    ? candidate : durable;
  return {
    ...durable,
    ...newest,
    ...(durable.importOrigin ? {
      importOrigin: durable.importOrigin, importFolder: durable.importFolder,
      importPresentationVersion: durable.importPresentationVersion,
    } : {}),
    workspacePath: workspace.workspacePath ?? null,
    workspaceSelectionUpdatedAt: workspace.workspaceSelectionUpdatedAt,
    ...importedWorkspaceMetadata(durable, candidate),
    ...mergeChatTitleMetadata(durable, candidate),
    updatedAt: Math.max(Number(durable.updatedAt || 0), Number(candidate.updatedAt || 0)),
    traceLogs: mergeFeedTraceHistories(durable.traceLogs || [], candidate.traceLogs || []),
  };
}

/** Commit just the selected chat under the store lock. Other chats/imports
 * cannot reject this action by advancing the whole-history timestamp. */
export async function prepareStoredChat(sourceId: string, incoming?: unknown) {
  const operation = chatWrites.queue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    const durable = (current.chats as any[]).find(chat => chat.id === sourceId);
    if (!durable) throw new Error('Chat no longer exists. Refresh your chat list and try again.');
    const chat = mergeChatForAction(durable, incoming);
    const next = {
      ...current,
      chats: (current.chats as any[]).map(item => item.id === sourceId ? chat : item),
      savedAt: Math.max(Date.now(), current.savedAt + 1), lastMutationId: '',
    };
    cachedSnapshotFileSignature = await writeAtomic(next);
    cachedSnapshot = next;
    return { chat, savedAt: next.savedAt };
  });
  chatWrites.queue = operation;
  return operation;
}

export async function copyStoredChat(sourceId: string, incoming?: unknown, requestId?: string) {
  const operation = chatWrites.queue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    const id = requestId || randomUUID();
    const priorCopy = (current.chats as any[]).find(chat => chat.id === id);
    if (priorCopy) {
      if (priorCopy.copyRequestId !== `${sourceId}:${id}`) throw new Error('This copy request is no longer valid.');
      return { chat: priorCopy, savedAt: current.savedAt };
    }
    const durable = (current.chats as any[]).find(chat => chat.id === sourceId);
    if (!durable) throw new Error('Chat no longer exists. Refresh your chat list and try again.');
    const source = mergeChatForAction(durable, incoming);
    try {
      const replacements = await copyChatMedia(sourceId, id, source.traceLogs || []);
      const chat = normalizePersistedChat({
        ...buildChatCopy(source, id, nextChatCopyTitle(source.title, (current.chats as any[]).map(chat => chat.title)), replacements),
        copyRequestId: `${sourceId}:${id}`,
      });
      const next = {
        ...current,
        chats: [chat, ...(current.chats as any[]).map(item => item.id === sourceId ? source : item)],
        savedAt: Math.max(Date.now(), current.savedAt + 1), lastMutationId: '',
      };
      cachedSnapshotFileSignature = await writeAtomic(next);
      cachedSnapshot = next;
      return { chat, source, savedAt: next.savedAt };
    } catch (error) {
      await removeChatMedia([id]);
      throw error;
    }
  });
  chatWrites.queue = operation;
  return operation;
}

export async function saveChatSnapshot(chats: unknown[], savedAt: number, mutationId = ''): Promise<ChatSnapshotWriteResult> {
  const requested = normalizeSnapshot({ chats, savedAt, lastMutationId: mutationId });
  chatWrites.queue = chatWrites.queue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    if (mutationId && current.lastMutationId === mutationId) return { ...current, applied: true };
    if (requested.savedAt < current.savedAt) return { ...current, applied: false };
    const currentById = new Map((current.chats as any[]).map(chat => [chat.id, chat]));
    const requestedIds = new Set((requested.chats as any[]).map(chat => chat.id));
    const mergedChats = (requested.chats as any[]).map(chat => {
      const durable = currentById.get(chat.id);
      if (!durable) return chat;
      return {
        ...durable,
        ...chat,
        ...(durable.importOrigin ? { importOrigin: durable.importOrigin, importFolder: durable.importFolder, importPresentationVersion: durable.importPresentationVersion } : {}),
        ...importedWorkspaceMetadata(durable, chat),
        ...mergeChatTitleMetadata(durable, chat),
        traceLogs: mergeFeedTraceHistories(
          durable.traceLogs || [],
          chat.traceLogs || [],
        ),
      };
    });
    const next = await hydrateRecoveredDialogue(normalizeSnapshot({
      ...requested,
      chats: [
        ...mergedChats,
        // Imports can commit while an older client is saving a full snapshot.
        // Deletion remains explicit through patchChatSnapshot's deleted IDs.
        ...(current.chats as any[]).filter(chat => chat.importOrigin && !requestedIds.has(chat.id)),
      ],
      savedAt: Math.max(requested.savedAt, current.savedAt + 1),
      lastMutationId: mutationId,
    }));
    const signature = await writeAtomic(next);
    cachedSnapshot = next;
    cachedSnapshotFileSignature = signature;
    return { ...next, applied: true };
  });
  const stored = await chatWrites.queue as ChatSnapshotWriteResult;
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
  chatWrites.queue = chatWrites.queue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    if (mutationId && current.lastMutationId === mutationId) return { ...current, applied: true };
    if (savedAt < current.savedAt) return { ...current, applied: false };
    const byId = new Map((current.chats as any[]).map(chat => [chat.id, chat]));
    for (const chat of changed) {
      const durable = byId.get(chat.id);
      byId.set(chat.id, durable ? {
        ...durable,
        ...chat,
        ...(durable.importOrigin ? { importOrigin: durable.importOrigin, importFolder: durable.importFolder, importPresentationVersion: durable.importPresentationVersion } : {}),
        ...importedWorkspaceMetadata(durable, chat),
        ...mergeChatTitleMetadata(durable, chat),
        traceLogs: mergeFeedTraceHistories(
          durable.traceLogs || [],
          chat.traceLogs || [],
        ),
      } : chat);
    }
    deletedIds.forEach(id => byId.delete(id));
    const orderedIds = new Set(safeIds);
    const next = await hydrateRecoveredDialogue(normalizeSnapshot({
      savedAt: Math.max(savedAt, current.savedAt + 1),
      lastMutationId: mutationId,
      // The client list can be stale while a restore or another tab is in
      // flight. Preserve durable chats omitted by that list; only explicit
      // deletion IDs are allowed to remove existing records.
      chats: [
        ...safeIds.map(id => byId.get(id)).filter(Boolean),
        ...Array.from(byId.values()).filter(chat => !orderedIds.has(chat.id)),
      ],
    }));
    const signature = await writeAtomic(next);
    cachedSnapshot = next;
    cachedSnapshotFileSignature = signature;
    return { ...next, applied: true };
  });
  const stored = await chatWrites.queue as ChatSnapshotWriteResult;
  return { ...stored, chats: [...stored.chats] };
}

/** Imports share the normal store's write queue. The reducer sees the latest
 * durable revision, including sends/deletes that landed during discovery. */
export async function updateImportedChats(
  merge: (current: any[]) => any[],
): Promise<PersistedChatSnapshot> {
  const operation = chatWrites.queue.catch(() => {}).then(async () => {
    const current = await readFromDisk();
    const chats = merge(current.chats as any[]);
    if (chats === current.chats) return current;
    const next = normalizeSnapshot({ ...current, chats, savedAt: Math.max(Date.now(), current.savedAt + 1), lastMutationId: '' });
    cachedSnapshotFileSignature = await writeAtomic(next);
    cachedSnapshot = next;
    return next;
  });
  chatWrites.queue = operation;
  const snapshot = await operation;
  return { ...snapshot, chats: [...snapshot.chats] };
}
