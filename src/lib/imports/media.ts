import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chatMediaHref, registerChatMediaAttachments } from '../chat-media-store';
import { normalizeAttachmentMime } from '../agent/attachment-pipeline';
import { mergeImportedAttachments, normalizeImportedTraces, sourceFileCitations, type ImportedAttachment } from './presentation';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const pathKey = (value: string) => process.platform === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value;
const href = (value: string) => `#eterx-local-file:${encodeURIComponent(value).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;

/** Copy only media explicitly referenced by an imported chat. No directories or
 * remote URLs are searched. Provider-native inline images are retained as-is. */
export async function retainImportedMedia(chatId: string, sourceLogs: any[], warnings: string[]): Promise<any[]> {
  const logs = normalizeImportedTraces(sourceLogs);
  const byLog = new Map<any, ImportedAttachment[]>();
  const candidates: ImportedAttachment[] = [];
  for (const log of logs) {
    if (!log.importedFrom) continue;
    const attachments = mergeImportedAttachments(log.attachments || [], ['answer', 'work_note'].includes(log.type) ? sourceFileCitations(log.text || '') : []);
    byLog.set(log, attachments);
    candidates.push(...attachments);
  }
  const unique = mergeImportedAttachments(candidates);
  const accepted: ImportedAttachment[] = [];
  let bytes = 0;
  for (const item of unique) {
    const source = item.localPath || item.path || '';
    item.id ||= `import-media-${digest(source || item.inlineData || item.name).slice(0, 28)}`;
    item.mimeType = normalizeAttachmentMime(item.name, item.mimeType || '');
    const stat = source && path.isAbsolute(source) && !/^(\\\\|\/\/)/.test(source) ? await fs.lstat(source).catch(() => null) : null;
    const fileAvailable = stat !== null && stat.isFile() && !stat.isSymbolicLink();
    const size = fileAvailable ? stat.size : item.inlineData ? Math.ceil(item.inlineData.length * 3 / 4) : 0;
    if (!size || size > 64 * 1024 * 1024 || bytes + size > 512 * 1024 * 1024) {
      item.unavailable = true;
      continue;
    }
    bytes += size;
    accepted.push({ ...item, ...(fileAvailable ? {} : { localPath: undefined, path: undefined }), size, unavailable: false });
  }
  const saved = accepted.length ? await registerChatMediaAttachments(chatId, accepted) : await registerChatMediaAttachments(chatId, []);
  const resolve = (item: ImportedAttachment): ImportedAttachment => {
    const original = item.localPath || item.path || '';
    const id = item.id || `import-media-${digest(original || item.inlineData || item.name).slice(0, 28)}`;
    const entry = saved.find(entry => entry.id === id || original && [entry.path, entry.originalPath].some(value => value && pathKey(value) === pathKey(original)));
    if (entry) return { id: entry.id, name: item.name || entry.name, mimeType: entry.mimeType, size: entry.size, localPath: entry.path, originalPath: entry.originalPath || original, previewUrl: chatMediaHref(chatId, entry.id), origin: item.origin, unavailable: false };
    if (warnings.length < 100) warnings.push(`${item.name}: original attachment is missing or exceeds the import media limit. Its card is retained; reattach the file to restore access.`);
    return { id, name: item.name, mimeType: item.mimeType || normalizeAttachmentMime(item.name, ''), originalPath: original || undefined, origin: item.origin, unavailable: true };
  };
  return logs.map(log => {
    const attachments = byLog.get(log);
    if (!attachments?.length) return log;
    const resolved = attachments.map(resolve);
    let text = String(log.text || '');
    attachments.forEach((original, index) => {
      const target = resolved[index];
      if (original.origin === 'output' && original.localPath && target.localPath) text = text.split(href(original.localPath)).join(href(target.localPath));
    });
    const images = resolved.filter(item => !item.unavailable && item.mimeType?.startsWith('image/')).map(item => ({ name: item.name, path: item.localPath, displayUrl: item.previewUrl }));
    return { ...log, text, attachments: resolved,
      ...(['tool_call', 'command', 'exploration', 'browser'].includes(log.type) && images.length ? { toolResult: { ...(log.toolResult && typeof log.toolResult === 'object' ? log.toolResult : {}), output: log.output || '', images } } : {}) };
  });
}
