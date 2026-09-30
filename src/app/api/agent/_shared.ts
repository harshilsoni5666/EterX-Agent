import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import {
  AGENT_SESSION_COOKIE,
  AGENT_SESSION_MAX_AGE,
  isSafeAgentSessionId as isSafeSessionId,
  serializeAgentSessionCookie,
} from '../../../lib/agent-api-session-cookie';
import { normalizeAttachmentMime } from '../../../lib/agent/attachment-pipeline';

export const MAX_AGENT_ID_LENGTH = 96;
export const MAX_CHAT_ID_LENGTH = 160;
export const MAX_RUN_ID_LENGTH = 160;

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const CHAT_ID_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
const RESPONSE_KEY_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
const RUN_ID_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
const OWNER_RECORD_TTL_MS = AGENT_SESSION_MAX_AGE * 1000;
const OWNER_PRUNE_INTERVAL_MS = 60_000;

type OwnerRecord = {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
};

export type AgentApiSession = {
  sessionId: string;
  needsCookie: boolean;
  cookieValue: string;
};

const globalForAgentApi = globalThis as typeof globalThis & {
  __eterxAgentChatOwners?: Map<string, OwnerRecord>;
};

const chatOwners =
  globalForAgentApi.__eterxAgentChatOwners ||
  (globalForAgentApi.__eterxAgentChatOwners = new Map<string, OwnerRecord>());
let lastOwnerPruneAt = 0;

export function jsonError(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, error: message, ...extra }, { status });
}

export function rejectCrossOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!origin) return null;

  try {
    const source = new URL(origin);
    const destination = new URL(req.url);
    if (source.origin === destination.origin) return null;

    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    const sourcePort = source.port || (source.protocol === 'https:' ? '443' : '80');
    const destinationPort = destination.port || (destination.protocol === 'https:' ? '443' : '80');
    if (
      source.protocol === destination.protocol
      && sourcePort === destinationPort
      && loopbackHosts.has(source.hostname)
      && loopbackHosts.has(destination.hostname)
    ) {
      return null;
    }
  } catch {
    return jsonError('Invalid request origin.', 400);
  }

  return jsonError('Cross-origin agent API requests are not allowed.', 403);
}

function makeSessionId() {
  return randomUUID();
}

export function getOrCreateAgentApiSession(req: NextRequest): AgentApiSession {
  const existing = req.cookies.get(AGENT_SESSION_COOKIE)?.value || '';
  if (isSafeSessionId(existing)) {
    return {
      sessionId: existing,
      needsCookie: false,
      cookieValue: serializeAgentSessionCookie(existing, req.nextUrl.protocol === 'https:'),
    };
  }

  const sessionId = makeSessionId();
  return {
    sessionId,
    needsCookie: true,
    cookieValue: serializeAgentSessionCookie(sessionId, req.nextUrl.protocol === 'https:'),
  };
}

export function attachAgentApiSessionCookie<T extends Response>(response: T, session: AgentApiSession): T {
  if (session.needsCookie) {
    response.headers.append('Set-Cookie', session.cookieValue);
  }
  return response;
}

function pruneOwnerRecords(now = Date.now()) {
  for (const [chatId, record] of chatOwners.entries()) {
    if (now - record.updatedAt > OWNER_RECORD_TTL_MS) chatOwners.delete(chatId);
  }
}

export function ensureChatOwner(chatId: string, sessionId: string): boolean {
  if (!isSafeChatId(chatId) || !isSafeSessionId(sessionId)) return false;
  const now = Date.now();
  // Polling touches this map many times per second when several agents are
  // live. Pruning on every request turns a cheap ownership check into an
  // O(number of chats) scan and scales poorly with long-lived sessions.
  if (now - lastOwnerPruneAt >= OWNER_PRUNE_INTERVAL_MS) {
    pruneOwnerRecords(now);
    lastOwnerPruneAt = now;
  }

  const existing = chatOwners.get(chatId);
  if (existing && existing.sessionId !== sessionId) return false;

  chatOwners.set(chatId, existing
    ? { ...existing, updatedAt: now }
    : { sessionId, createdAt: now, updatedAt: now });
  return true;
}

export function requireChatOwner(chatId: string, sessionId: string) {
  if (!ensureChatOwner(chatId, sessionId)) {
    return jsonError('This browser session does not own this chat.', 403);
  }
  return null;
}

export function isChatOwnedBySession(chatId: string, sessionId: string): boolean {
  return chatOwners.get(chatId)?.sessionId === sessionId;
}

export async function readJsonObject(req: NextRequest): Promise<Record<string, any>> {
  try {
    const body = await req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { }
  return {};
}

export function cleanString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

export const cleanContextText = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\u0000/g, '') : '';

function cleanPathLike(value: unknown, maxLength: number): string {
  return cleanString(value, maxLength).replace(/[\x00-\x1F]/g, '');
}

export function isSafeAgentId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_AGENT_ID_LENGTH &&
    AGENT_ID_PATTERN.test(value);
}

export function isSafeChatId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CHAT_ID_LENGTH &&
    CHAT_ID_PATTERN.test(value);
}

export function isSafeRunId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RUN_ID_LENGTH &&
    RUN_ID_PATTERN.test(value);
}

export function isSafeResponseKey(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    RESPONSE_KEY_PATTERN.test(value);
}

export function parseInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

export type RunnerMessage = { role: 'user' | 'model'; content: string; contextTurnId?: string };

export function normalizeRunnerMessages(raw: unknown): { messages?: RunnerMessage[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'messages array is required.' };
  }
  const messages: RunnerMessage[] = [];
  for (const item of raw) {
    const role = item?.role === 'user'
      ? 'user'
      : item?.role === 'model' || item?.role === 'assistant'
        ? 'model'
        : null;
    const content = cleanContextText(item?.content);

    if (!role) return { error: 'Each message role must be user, model, or assistant.' };
    if (!content.trim()) return { error: 'Each message must include non-empty content.' };

    const contextTurnId = cleanString(item?.contextTurnId, 512);
    messages.push({ role, content, ...(contextTurnId ? { contextTurnId } : {}) });
  }

  return { messages };
}

export function normalizeHistory(raw: unknown): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }>; contextTurnId?: string }> {
  if (!Array.isArray(raw)) return [];
  const history: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }>; contextTurnId?: string }> = [];

  for (const item of raw) {
    const role = item?.role === 'model' || item?.role === 'assistant'
      ? 'model'
      : item?.role === 'user'
        ? 'user'
        : null;
    if (!role) continue;

    const parts: Array<{ text: string }> = [];
    if (Array.isArray(item?.parts)) {
      for (const part of item.parts) {
        const text = cleanContextText(part?.text);
        if (text.trim()) parts.push({ text });
      }
    } else {
      const text = cleanContextText(item?.content || item?.text);
      if (text.trim()) parts.push({ text });
    }

    const contextTurnId = cleanString(item?.contextTurnId, 512);
    if (parts.length > 0) history.push({ role, parts, ...(contextTurnId ? { contextTurnId } : {}) });
  }

  return history;
}

export function normalizeArray(raw: unknown, maxItems = 50): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, maxItems);
}

export function normalizeMediaAttachments(raw: unknown): any[] {
  if (!Array.isArray(raw)) return [];

  return raw.slice(0, 50)
    .map((item: any, index) => {
      const name = cleanPathLike(item?.name || item?.file?.name, 260) || `attachment_${index + 1}`;
      const mimeType = normalizeAttachmentMime(
        name,
        cleanString(item?.mimeType || item?.file?.type, 120) || 'application/octet-stream',
      );
      const path = cleanPathLike(item?.localPath || item?.path, 1200);
      const data = cleanString(item?.data, 12_000_000);
      const inlineDataValue = typeof item?.inlineData === 'string'
        ? { data: cleanString(item.inlineData, 12_000_000), mimeType }
        : item?.inlineData && typeof item.inlineData === 'object'
          ? {
              data: cleanString(item.inlineData.data, 12_000_000),
              mimeType: cleanString(item.inlineData.mimeType || mimeType, 120) || mimeType,
            }
          : null;

      const normalized: any = {
        id: cleanString(item?.id, 120) || randomUUID(),
        name,
        mimeType,
      };
      if (path) normalized.path = path;
      if (data) normalized.data = data;
      if (inlineDataValue?.data) normalized.inlineData = inlineDataValue;

      return normalized;
    })
    .filter(item => item.path || item.data || item.inlineData);
}
