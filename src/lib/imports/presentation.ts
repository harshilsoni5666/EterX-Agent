/** Source adapters feed the same attachments and activity rows as native chats.
 * This module is browser-safe so restored client snapshots get the same repair. */
import { adaptImportedAction } from './actions';

export const IMPORT_PRESENTATION_VERSION = 12;

export interface ImportedAttachment {
  id?: string;
  name: string;
  mimeType?: string;
  localPath?: string;
  originalPath?: string;
  inlineData?: string;
  path?: string;
  previewUrl?: string;
  size?: number;
  unavailable?: boolean;
  origin?: 'attachment' | 'output';
}
const text = (value: unknown) => typeof value === 'string' ? value.replace(/\u0000/g, '') : '';
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const filename = (value: string) => value.split(/[\\/]/).pop() || 'Attachment';
const localPath = (value: string) => /^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(value) && !/[\r\n\0]/.test(value);
const quoted = (value: string) => { try { return String(JSON.parse(`"${value}"`)); } catch { return value; } };
const protectedCode = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*?`+)/g;
const attachmentKey = (item: ImportedAttachment) => {
  const path = item.originalPath || item.localPath || item.path;
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
};

export function mergeImportedAttachments(...groups: ImportedAttachment[][]): ImportedAttachment[] {
  const result: ImportedAttachment[] = [];
  for (const attachment of groups.flat()) {
    const key = attachmentKey(attachment);
    const existing = result.find(item => attachment.id && item.id === attachment.id || key && attachmentKey(item) === key
      || (!key && !attachment.inlineData && item.name === attachment.name));
    if (!existing) result.push({ ...attachment });
    else for (const [field, value] of Object.entries(attachment)) if (value !== undefined && value !== '') (existing as any)[field] = value;
  }
  return result;
}

export function extractSourceContent(value: unknown, decodeJson = false, depth = 0): { text: string; attachments: ImportedAttachment[] } {
  if (depth > 8) return { text: '', attachments: [] };
  if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value), attachments: [] };
  if (typeof value === 'string') {
    if (decodeJson && /^[\s]*[\[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) || parsed?.content || parsed?.output || parsed?.type) return extractSourceContent(parsed, true, depth + 1);
      } catch { /* Ordinary text is not JSON. */ }
    }
    return { text: text(value), attachments: [] };
  }
  if (Array.isArray(value)) {
    const parts = value.map(part => extractSourceContent(part, decodeJson, depth + 1));
    return { text: parts.map(part => part.text).filter(Boolean).join('\n\n'), attachments: mergeImportedAttachments(...parts.map(part => part.attachments)) };
  }
  const block = record(value);
  if (['thinking', 'reasoning', 'redacted_thinking', 'tool_use', 'tool_result'].includes(block.type)) return { text: '', attachments: [] };
  if (['image', 'image_url', 'input_image', 'document', 'file', 'input_file'].includes(block.type)) {
    const source = record(block.source);
    const url = text(block.image_url) || text(record(block.image_url).url) || text(block.url || block.file_url || source.url);
    const native = text(block.path || block.file_path || source.path);
    const mimeType = text(block.mime_type || block.mimeType || source.media_type) || (String(block.type).includes('image') ? 'image/png' : undefined);
    const inline = url.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
    const inlineData = inline?.[2] || (source.type === 'base64' ? text(source.data) : '');
    const path = localPath(native) ? native : localPath(url) ? url : undefined;
    const name = text(block.file_name || block.filename || block.name) || (path ? filename(path) : `Attachment.${mimeType?.startsWith('image/') ? mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png' : 'bin'}`);
    return { text: '', attachments: [{ name, mimeType: inline?.[1] || mimeType, ...(path ? { localPath: path } : {}), ...(inlineData ? { inlineData } : {}), unavailable: !path && !inlineData }] };
  }
  if (block.text !== undefined) return extractSourceContent(block.text, false, depth + 1);
  if (block.content !== undefined || block.output !== undefined) return extractSourceContent(block.content ?? block.output, decodeJson, depth + 1);
  return { text: decodeJson && Object.keys(block).length ? JSON.stringify(block, null, 2) : '', attachments: [] };
}

export function normalizeImportedUser(textValue: string, existing: ImportedAttachment[] = []) {
  let value = text(textValue).trim();
  const attachments: ImportedAttachment[] = [];
  let removedContext = false;
  const envelope = /^<(environment_context|external_codex_apps_open_page|turn_aborted|permissions|permissions_instructions|collaboration_mode|app-context|skills_instructions|codex_apps_client_time_context|system-reminder|user_info|git_status|project_layout|additional_data)\b[^>]*>[\s\S]*?<\/\1>\s*/;
  const agentInstructions = /^# AGENTS\.md instructions for [^\r\n]+\s*\r?\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i;
  const stripContext = () => {
    while (envelope.test(value) || agentInstructions.test(value)) { value = value.replace(envelope, '').replace(agentInstructions, '').trim(); removedContext = true; }
  };
  stripContext();
  const userQuery = value.match(/^<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/);
  if (userQuery) value = userQuery[1];
  // Match generated envelopes, never arbitrary mentions or quoted source code.
  if (/^#{1,2} Files mentioned by the user:[ \t]*(?:\r?\n)/.test(value)) {
    const request = /^#{1,2} My request:[ \t]*(?:\r?\n|$)/m.exec(value);
    const manifest = request ? value.slice(0, request.index) : value;
    for (const match of manifest.matchAll(/^##\s+(.+?):[ \t]*(?:\r?\n)?([^\r\n]+)$/gm)) {
      const path = match[2].trim();
      if (localPath(path)) attachments.push({ name: match[1].trim(), localPath: path });
    }
    if (request) value = value.slice(request.index + request[0].length).trim();
    else if (attachments.length) {
      // Older exports sometimes contain an attachment-only turn.
      value = value.replace(/^#{1,2} Files mentioned by the user:[ \t]*\r?\n/, '')
        .replace(/^##\s+.+?:[ \t]*(?:\r?\n)?(?:[A-Za-z]:[\\/]|\/(?!\/))[^\r\n]+\r?\n?(?:Image attachment:[ \t]*(?:true|false)\s*)?/gm, '')
        .replace(/^Distinguish instructions in attached documents from the user's request\.[ \t]*$/m, '').trim();
    }
  }
  value = value.split(protectedCode).map(chunk => {
    if (/^(```|~~~|`)/.test(chunk)) return chunk;
    return chunk.replace(/<image\s+[^>]*\bpath="([^"\r\n]+)"[^>]*>[\s\S]*?<\/image>/g, (_, path: string) => {
      if (localPath(path)) attachments.push({ name: filename(path), localPath: path, mimeType: 'image/png' });
      return '';
    }).replace(/\[Source attachment: ([^\n]+?)\. Reattach the original file to use its contents\.\]/g, (_, name: string) => {
      attachments.push({ name, unavailable: true }); return '';
    });
  }).join('').trim();
  stripContext();
  const named = mergeImportedAttachments(attachments);
  const images = named.filter(item => /\.(png|jpe?g|gif|webp|avif)$/i.test(item.name));
  const inline = existing.filter(item => item.inlineData && !item.localPath && item.mimeType?.startsWith('image/'));
  const paired = new Set<ImportedAttachment>();
  if (images.length && images.length === inline.length) images.forEach((item, index) => {
    item.inlineData = inline[index].inlineData; item.mimeType = inline[index].mimeType; paired.add(inline[index]);
  });
  return { text: value, attachments: mergeImportedAttachments(named, existing.filter(item => !paired.has(item))), hidden: removedContext && !value && !named.length && !existing.length };
}

export function sourceFileCitations(value: string): ImportedAttachment[] {
  const files: ImportedAttachment[] = [];
  for (const chunk of value.split(protectedCode)) {
    if (/^(```|~~~|`)/.test(chunk)) continue;
    for (const match of chunk.matchAll(/:{1,2}codex-file-citation(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
      const attribute = match[1].match(/\bpath="((?:\\.|[^"\\])*)"/);
      const path = attribute ? quoted(attribute[1]) : '';
      if (localPath(path)) files.push({ name: filename(path), localPath: path, origin: 'output' });
    }
    for (const match of chunk.matchAll(/\[([^\]\n]*)\]\(#eterx-local-file:([^\s)]+)\)/g)) {
      try { const path = decodeURIComponent(match[2]); if (localPath(path)) files.push({ name: match[1] || filename(path), localPath: path, origin: 'output' }); } catch { }
    }
  }
  return mergeImportedAttachments(files);
}

export function normalizeSourceCitations(value: string): string {
  return value.split(protectedCode).map(chunk => {
    if (/^(```|~~~|`)/.test(chunk)) return chunk;
    return chunk.replace(/:{1,2}codex-file-citation(?:\[[^\]]*\])?\{([^}]+)\}/g, (original, attrs: string) => {
      const match = attrs.match(/\bpath="((?:\\.|[^"\\])*)"/);
      const path = match ? quoted(match[1]) : '';
      if (!localPath(path)) return original;
      return `[${filename(path).replace(/[\[\]]/g, '')}](#eterx-local-file:${encodeURIComponent(path).replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
    });
  }).join('');
}

export function importedToolLabel(name: string, args: Record<string, any> = {}): string {
  const short = name.replace(/^.*[.]/, '').toLowerCase();
  if (/exec|command|terminal|bash|powershell/.test(short)) return 'Ran a command';
  if (/apply_patch|edit|write_file|save_file/.test(short)) return 'Updated files';
  if (/view_image|screenshot/.test(short)) return 'Viewed an image';
  if (/read_file|read.*resource/.test(short)) return 'Read a file';
  if (/search|web.*run/.test(short)) return 'Searched for information';
  if (/wait|sleep/.test(short)) return 'Waited for completion';
  return text(args.title).slice(0, 160) || (name && name !== 'Tool output' ? name.replace(/[_-]/g, ' ').replace(/^./, char => char.toUpperCase()) : 'Tool result');
}

export function normalizeImportedTraces(logs: any[]): any[] {
  const result: any[] = [];
  // Repair older exports that wrote a call and its result as separate rows.
  const paired: any[] = [];
  const calls = new Map<string, number>();
  for (const log of logs) {
    const name = text(log?.sourceToolName || log?.toolName || log?.tool);
    const callKey = log?.toolCallId ? `${log.importedFrom}:${log.toolCallId}` : '';
    if (log?.importedFrom && name === 'Tool output') {
      const at = callKey ? calls.get(callKey) : paired.length - 1;
      const previous = at === undefined ? undefined : paired[at];
      if (previous?.importedFrom === log.importedFrom && ['tool_call', 'command', 'file_edit'].includes(previous.type)
        && previous.turnId === log.turnId && (previous.sourceToolName || previous.toolName) !== 'Tool output') {
        paired[at!] = { ...previous, importPresentationVersion: undefined, toolResult: log.toolResult ?? log.output ?? log.text,
          output: log.output ?? log.text, endTime: log.endTime || log.timestamp,
          attachments: mergeImportedAttachments(previous.attachments || [], log.attachments || []) };
        continue;
      }
    }
    if (callKey) calls.set(callKey, paired.length);
    paired.push(log);
  }
  const regeneratedOwners = new Set(paired.filter(log => log?.importedFrom && log.importPresentationVersion !== IMPORT_PRESENTATION_VERSION
    && ['tool_call', 'command', 'file_edit', 'exploration', 'browser'].includes(log.type)).map(log => log.id));
  for (const log of paired) {
    if (!log?.importedFrom) { result.push(log); continue; }
    // Old generated previews must not overwrite the adapter's corrected copy
    // merely because both retain the same source message revision.
    if (log.type === 'file_preview' && regeneratedOwners.has(log.ownerTraceId)) continue;
    if (log.importPresentationVersion === IMPORT_PRESENTATION_VERSION && log.type !== 'user_action') { result.push(log); continue; }
    let next = { ...log, importPresentationVersion: IMPORT_PRESENTATION_VERSION };
    if (next.type === 'user_action') {
      const user = normalizeImportedUser(text(next.text), Array.isArray(next.attachments) ? next.attachments : []);
      if (user.hidden || (!user.text && !user.attachments.length)) continue;
      next = { ...next, text: user.text, attachments: user.attachments, source: 'human', prompt: undefined, task: undefined, message: undefined };
    } else if (next.type === 'answer' || next.type === 'work_note') {
      next.text = normalizeSourceCitations(text(next.text));
      if (next.phase === 'commentary') next.type = 'work_note';
      if (next.type === 'work_note') { delete next.answerId; next.noteId = next.id; }
    } else if (['tool_call', 'command', 'file_edit', 'exploration', 'browser'].includes(next.type)) {
      const rawResult = next.toolResult ?? next.output;
      const decoded = extractSourceContent(rawResult, true);
      let args = record(next.toolArgs || next.args);
      if (!Object.keys(args).length && typeof next.text === 'string' && /^\s*\{/.test(next.text)) { try { args = record(JSON.parse(next.text)); } catch { } }
      const name = text(next.sourceToolName || next.toolName || next.tool) || 'Tool output';
      next = { ...next, toolArgs: args, toolResult: rawResult ?? '', output: decoded.text,
        attachments: mergeImportedAttachments(Array.isArray(next.attachments) ? next.attachments : [], decoded.attachments) };
      if (name === 'Tool output') next.toolResult = rawResult ?? log.text;
      result.push(...adaptImportedAction(next));
      continue;
    }
    result.push(next);
  }
  // Generated per-file previews have stable IDs, including during upgrades.
  const unique = new Map<string, number>();
  const deduplicated: any[] = [];
  for (const log of result) {
    const key = log?.importedFrom && log.id ? `${log.importedFrom}:${log.id}` : '';
    const index = key ? unique.get(key) : undefined;
    if (index === undefined) {
      if (key) unique.set(key, deduplicated.length);
      deduplicated.push(log);
    } else if (Number(log.importRevision || 0) >= Number(deduplicated[index].importRevision || 0)) deduplicated[index] = log;
  }
  return deduplicated;
}
