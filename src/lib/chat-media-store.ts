import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';
import { getEterxDataDir } from './agent/storage-paths';
import { normalizeAttachmentMime } from './agent/attachment-pipeline';
import { stableScopeSegment } from './agent/context-scope';

/**
 * Durable, chat-scoped media storage.
 *
 * The renderer may only know a temporary upload path. Once a message is
 * accepted, the original bytes are copied into this per-chat vault. Provider
 * adapters always read from the vault, so a later turn can resolve the same
 * image, document, audio file, or video without asking the user to attach it
 * again. No media is resized, transcoded, or converted here.
 */
export type ChatMediaAttachment = {
  id: string;
  name: string;
  mimeType: string;
  path: string;
  size: number;
  createdAt: number;
};

const CHAT_MEDIA_ROOT = path.join(getEterxDataDir(), 'chat-media');
const MAX_CHAT_MEDIA = 200;
const MAX_REQUEST_MEDIA = 50;
const MEDIA_REFERENCE_PATTERN = /\b(?:image|images|photo|photos|picture|pictures|screenshot|screenshots|video|videos|media|attachment|attachments|attached|document|documents|pdf|spreadsheet|audio|recording|view|see|analy[sz]e|compare|above|earlier|previous|before|it|this|that|these|those)\b/i;

const safeMediaName = (value: unknown, fallback = 'attachment') => {
  const raw = String(value || '').trim() || fallback;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const extension = path.extname(cleaned);
  const stem = path.basename(cleaned, extension).slice(0, 140) || fallback;
  return `${stem}${extension}`;
};

const getChatMediaDir = (chatId: string) => path.join(
  CHAT_MEDIA_ROOT,
  stableScopeSegment(String(chatId || 'chat'), 140),
);

const getManifestPath = (chatId: string) => path.join(getChatMediaDir(chatId), 'manifest.json');

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const decodeBase64 = (value: string) => {
  const clean = String(value || '').trim().replace(/^data:[^;]+;base64,/, '');
  return clean ? Buffer.from(clean, 'base64') : null;
};

async function readManifest(chatId: string): Promise<ChatMediaAttachment[]> {
  try {
    const value = await fs.readJson(getManifestPath(chatId));
    if (!Array.isArray(value)) return [];
    return value
      .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.path === 'string')
      .map(item => ({
        id: String(item.id),
        name: String(item.name || path.basename(item.path)),
        mimeType: normalizeAttachmentMime(String(item.name || item.path), String(item.mimeType || '')),
        path: String(item.path),
        size: Number.isFinite(Number(item.size)) ? Math.max(0, Number(item.size)) : 0,
        createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : 0,
      }))
      .filter(item => isInside(getChatMediaDir(chatId), item.path) && fs.existsSync(item.path))
      .slice(-MAX_CHAT_MEDIA);
  } catch {
    return [];
  }
}

async function writeManifest(chatId: string, entries: ChatMediaAttachment[]) {
  const dir = getChatMediaDir(chatId);
  await fs.ensureDir(dir);
  const temporaryPath = path.join(dir, `.manifest.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(entries.slice(-MAX_CHAT_MEDIA))}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.move(temporaryPath, getManifestPath(chatId), { overwrite: true });
}

export async function registerChatMediaAttachments(
  chatId: string,
  rawAttachments: any[] = [],
): Promise<ChatMediaAttachment[]> {
  const safeChatId = String(chatId || '').trim();
  if (!safeChatId) return [];

  const dir = getChatMediaDir(safeChatId);
  const existing = await readManifest(safeChatId);
  const byId = new Map(existing.map(item => [item.id, item]));

  for (const [index, attachment] of rawAttachments.slice(0, MAX_REQUEST_MEDIA).entries()) {
    const id = String(attachment?.id || `attachment_${index + 1}`).slice(0, 120);
    const name = safeMediaName(attachment?.name || attachment?.file?.name, `attachment_${index + 1}`);
    const mimeType = normalizeAttachmentMime(name, attachment?.mimeType || attachment?.file?.type);
    const existingEntry = byId.get(id);
    if (existingEntry && fs.existsSync(existingEntry.path)) {
      byId.set(id, { ...existingEntry, name, mimeType });
      continue;
    }

    const sourcePath = String(attachment?.path || '').trim();
    const inlineValue = typeof attachment?.inlineData === 'string'
      ? attachment.inlineData
      : attachment?.inlineData?.data || attachment?.data || '';
    const targetPath = path.join(dir, `${Date.now()}_${randomUUID().slice(0, 10)}_${name}`);

    try {
      await fs.ensureDir(dir);
      if (sourcePath && fs.existsSync(sourcePath) && (await fs.stat(sourcePath)).isFile()) {
        if (!isInside(dir, sourcePath)) await fs.copyFile(sourcePath, targetPath);
        else await fs.copyFile(sourcePath, targetPath);
      } else {
        const bytes = decodeBase64(String(inlineValue || ''));
        if (!bytes || bytes.length === 0) continue;
        await fs.writeFile(targetPath, bytes);
      }

      const stat = await fs.stat(targetPath);
      byId.set(id, {
        id,
        name,
        mimeType,
        path: targetPath,
        size: stat.size,
        createdAt: Date.now(),
      });
    } catch (error) {
      console.warn(`[ChatMediaStore] Could not persist ${name}:`, error);
    }
  }

  const next = [...byId.values()].sort((left, right) => left.createdAt - right.createdAt).slice(-MAX_CHAT_MEDIA);
  await writeManifest(safeChatId, next);
  return next;
}

export async function resolveChatMediaForRequest(
  chatId: string,
  prompt: string,
  currentAttachments: any[] = [],
): Promise<ChatMediaAttachment[]> {
  const registered = await registerChatMediaAttachments(chatId, currentAttachments);
  const manifest = await readManifest(chatId);
  if (manifest.length === 0) return registered;

  const currentIds = new Set(currentAttachments.map(item => String(item?.id || '')).filter(Boolean));
  const mentionsMedia = MEDIA_REFERENCE_PATTERN.test(String(prompt || ''));
  if (!mentionsMedia) {
    if (currentIds.size === 0) return registered;

    const current = manifest.filter(item => currentIds.has(item.id)).slice(0, MAX_REQUEST_MEDIA);
    const missingCurrent = currentAttachments.filter(item => {
      const id = String(item?.id || '');
      return id && !current.some(entry => entry.id === id);
    });
    return [...current, ...missingCurrent];
  }

  // A visual reference such as “the image above”, “compare the screenshots”,
  // or “look at it again” resolves the complete chat media set. This gives the
  // model stable ordinal context while avoiding unrelated media on text-only
  // turns. The provider layer may still omit unsupported media types safely.
  return manifest.slice(-MAX_REQUEST_MEDIA);
}

/** Remove attachment bytes only after the chat record deletion is durable. */
export async function removeChatMedia(chatIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(chatIds.map(id => String(id || '').trim()).filter(Boolean)));
  await Promise.all(uniqueIds.map(async chatId => {
    const directory = getChatMediaDir(chatId);
    if (!isInside(CHAT_MEDIA_ROOT, directory) || path.resolve(directory) === path.resolve(CHAT_MEDIA_ROOT)) return;
    await fs.remove(directory).catch(error => {
      console.warn(`[ChatMediaStore] Could not remove media for ${chatId}:`, error);
    });
  }));
}

export function getChatMediaReferencePattern() {
  return MEDIA_REFERENCE_PATTERN;
}

export const CHAT_MEDIA_LIMITS = {
  maxChatMedia: MAX_CHAT_MEDIA,
  maxRequestMedia: MAX_REQUEST_MEDIA,
};
