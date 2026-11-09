import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ImportCategory, ImportItemSummary, ImportProvider } from './types';
import { extractSourceContent, IMPORT_PRESENTATION_VERSION, mergeImportedAttachments, normalizeImportedUser, sourceFileCitations, type ImportedAttachment } from './presentation';

type Obj = Record<string, any>;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
export const string = (value: unknown): string => typeof value === 'string' ? value.replace(/\u0000/g, '') : '';
export const timestamp = (value: unknown, fallback = 0): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Date.parse(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number < 1e11 ? number * 1000 : number : fallback;
};
export interface ImportedMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp: number;
  tool?: string;
  phase?: string;
  attachments?: ImportedAttachment[];
  callId?: string;
  toolEvent?: 'call' | 'result';
  toolInput?: Record<string, unknown>;
  toolFailed?: boolean;
  toolResult?: unknown;
}
export interface ImportItem extends ImportItemSummary {
  sourcePath: string;
  sourceId: string;
  fingerprint: string;
  content?: string;
  messages?: ImportedMessage[];
  config?: Obj;
  files?: Array<{ name: string; content: string; encoding?: 'base64' }>;
}

function message(raw: Obj, index: number, fallback: number): ImportedMessage | null {
  const payload = object(raw.message);
  const role = String(payload.role || raw.role || raw.sender || (raw.type === 1 ? 'user' : raw.type === 2 ? 'assistant' : raw.type) || '').toLowerCase();
  if (!['user', 'human', 'assistant', 'model', 'tool'].includes(role)) return null;
  const phase = raw.phase || raw.channel || payload.phase || payload.channel;
  if (phase === 'analysis' || raw.isMeta === true) return null;
  const decoded = extractSourceContent(payload.content ?? raw.content ?? raw.text ?? raw.message);
  const files = Array.isArray(raw.attachments) ? raw.attachments : Array.isArray(raw.files) ? raw.files : [];
  const attachments = mergeImportedAttachments(decoded.attachments, files.map((value: unknown) => {
    const file = object(value);
    return { name: string(file.file_name || file.filename || file.name) || 'Attachment', localPath: string(file.localPath || file.path) || undefined, mimeType: string(file.mimeType || file.mime_type) || undefined, inlineData: string(file.inlineData || file.data) || undefined };
  }));
  const user = role === 'user' || role === 'human' ? normalizeImportedUser(decoded.text, attachments) : null;
  if (user?.hidden) return null;
  const text = user ? user.text : decoded.text;
  const media = user ? user.attachments : mergeImportedAttachments(attachments, sourceFileCitations(text));
  if (!text.trim() && !media.length) return null;
  return {
    id: string(raw.uuid || raw.id || raw.bubbleId || payload.id) || `row-${index}`,
    role: role === 'user' || role === 'human' ? 'user' : role === 'tool' ? 'tool' : 'assistant',
    text,
    timestamp: timestamp(raw.timestamp || raw.created_at || raw.createdAt, fallback + index),
    ...(media.length ? { attachments: media } : {}),
    ...(['commentary', 'final', 'final_answer'].includes(phase) ? { phase } : {}),
  };
}

function makeChat(provider: ImportProvider, sourcePath: string, sourceId: string, title: string, workspace: string, messages: ImportedMessage[], modified: number): ImportItem | null {
  // Appended revisions replace the same source message without moving its
  // position. This also retains the settled version of a streamed message.
  const byMessageId = new Map<string, ImportedMessage>();
  for (const item of messages) byMessageId.set(`${item.id}:${item.role}`, item);
  const unique = [...byMessageId.values()];
  // Some providers omit commentary channels. Text immediately followed by a
  // tool call in the same turn is progress, not a second final answer.
  for (let index = 0; index < unique.length - 1; index++) {
    if (unique[index].role === 'assistant' && !unique[index].phase && unique[index + 1].role === 'tool' && unique[index + 1].toolEvent !== 'result') unique[index].phase = 'commentary';
  }
  if (!unique.some(item => item.role !== 'tool')) return null;
  const firstUser = unique.find(item => item.role === 'user')?.text.replace(/\s+/g, ' ').trim() || 'Imported conversation';
  const name = (title.trim() || firstUser).slice(0, 200);
  const id = `${provider}-${digest(`chat:${sourceId}`).slice(0, 32)}`;
  const messageTimes = unique.map(item => item.timestamp).filter(value => value >= 1e11).slice(-100);
  return {
    id, category: 'chats', name, detail: `${unique.filter(item => item.role !== 'tool').length} messages`,
    sourceId, sourcePath, workspace: workspace || undefined, messages: unique,
    updatedAt: /\.jsonl\.zst$/i.test(sourcePath) && messageTimes.length ? Math.max(...messageTimes) : Math.max(modified, ...messageTimes), count: unique.length,
    fingerprint: digest(JSON.stringify([IMPORT_PRESENTATION_VERSION, name, workspace, unique])),
  };
}

export function parseJsonLines(provider: ImportProvider, content: string, sourcePath: string, modified: number, warnings: string[]): ImportItem[] {
  const records: Obj[] = [];
  let invalid = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(object(JSON.parse(line))); } catch { invalid++; }
  }
  if (invalid) warnings.push(`${path.basename(sourcePath)}: ${invalid} incomplete or invalid record(s) skipped; complete messages were retained.`);
  let sourceId = path.basename(sourcePath).replace(/\.(jsonl(?:\.zst)?|txt)$/i, '');
  let title = '';
  let workspace = '';
  const messages: ImportedMessage[] = [];
  const fallbackMessages: ImportedMessage[] = [];
  for (const [index, row] of records.entries()) {
    const payload = object(row.payload);
    if (row.type === 'session_meta') {
      sourceId = string(payload.id) || sourceId;
      workspace = string(payload.cwd) || workspace;
    }
    if (row.sessionId) sourceId = string(row.sessionId) || sourceId;
    workspace = string(row.cwd) || workspace;
    if (row.type === 'custom-title') title = string(row.customTitle) || title;
    if (row.type === 'summary' && !title) title = string(row.summary).slice(0, 200);
    if (provider === 'codex') {
      if (row.type === 'response_item' && payload.type === 'message') {
        const item = message({ ...payload, timestamp: row.timestamp, id: payload.id || `response-${index}` }, index, modified);
        if (item) messages.push(item);
      } else if (row.type === 'response_item' && ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(payload.type)) {
        const output = payload.arguments ?? payload.input ?? payload.output;
        const decoded = extractSourceContent(output, true);
        let args = object(output);
        if (typeof output === 'string') { try { args = object(JSON.parse(output)); } catch { args = { code: output }; } }
        const isResult = payload.type.endsWith('_output');
        messages.push({ id: `${payload.call_id || index}-${payload.type}`, role: 'tool', tool: string(payload.name) || 'Tool output', text: decoded.text,
          callId: string(payload.call_id) || undefined, toolEvent: isResult ? 'result' : 'call', ...(isResult ? { toolResult: output } : { toolInput: args }),
          attachments: decoded.attachments, toolFailed: payload.is_error === true || payload.isError === true, timestamp: timestamp(row.timestamp, modified + index) });
      } else if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
        const images = Array.isArray(payload.images) ? payload.images.map((image: unknown) => typeof image === 'string' ? { type: 'input_image', image_url: image } : image) : [];
        const item = message({ id: `event-${index}`, role: payload.type === 'user_message' ? 'user' : 'assistant', content: [{ type: 'input_text', text: payload.message }, ...images], phase: payload.phase, timestamp: row.timestamp }, index, modified);
        if (item) fallbackMessages.push(item);
      }
    } else {
      const item = message(row, index, modified);
      if (item) messages.push(item);
      const blocks = object(row.message).content;
      if (Array.isArray(blocks)) for (const [blockIndex, raw] of blocks.entries()) {
        const block = object(raw);
        if (block.type !== 'tool_use' && block.type !== 'tool_result') continue;
        const decoded = extractSourceContent(block.content, true);
        messages.push({ id: `${row.uuid || index}-tool-${blockIndex}`, role: 'tool', tool: string(block.name) || 'Tool output', text: block.type === 'tool_use' ? JSON.stringify(block.input ?? {}) : decoded.text,
          callId: string(block.id || block.tool_use_id) || undefined, toolEvent: block.type === 'tool_use' ? 'call' : 'result', toolInput: block.type === 'tool_use' ? object(block.input) : undefined,
          ...(block.type === 'tool_result' ? { toolResult: block.content } : {}),
          attachments: decoded.attachments, toolFailed: block.is_error === true, timestamp: timestamp(row.timestamp, modified + index) });
      }
    }
  }
  if (provider === 'codex') {
    const represented = new Map<string, ImportedMessage[]>();
    for (const item of messages) {
      const key = `${item.role}:${item.text.trim()}`;
      const values = represented.get(key) || []; values.push(item); represented.set(key, values);
    }
    for (const item of fallbackMessages) {
      const key = `${item.role}:${item.text.trim()}`;
      const existing = represented.get(key)?.shift();
      if (existing) { existing.phase ||= item.phase; existing.attachments = mergeImportedAttachments(existing.attachments || [], item.attachments || []); }
      else if (item.text.trim() || item.attachments?.length) messages.push(item);
    }
    messages.sort((a, b) => a.timestamp - b.timestamp);
  }
  if (provider === 'claude' && (/[\\/]subagents[\\/]/i.test(sourcePath) || /^agent-/.test(path.basename(sourcePath)))) {
    sourceId = `${sourceId}:subagent:${path.basename(sourcePath).replace(/\.jsonl$/i, '')}`;
    title ||= `Agent · ${(messages.find(item => item.role === 'user')?.text || 'Imported work').replace(/\s+/g, ' ').slice(0, 150)}`;
  }
  const chat = makeChat(provider, sourcePath, sourceId, title, workspace, messages, modified);
  return chat ? [chat] : [];
}

export function parseJsonExport(provider: ImportProvider, data: unknown, sourcePath: string, modified: number): ImportItem[] {
  const root = object(data);
  const records = Array.isArray(data) ? data : Array.isArray(root.conversations) ? root.conversations : Array.isArray(root.chats) ? root.chats : [data];
  // An array of messages is a single conversation, an array of chats is not.
  const conversations = records.length && records.every(row => object(row).role || object(row).sender) ? [{ messages: records }] : records;
  return conversations.flatMap((raw, index) => {
    const row = object(raw);
    const rawMessages = row.chat_messages || row.messages || row.conversation || row.bubbles || row.tabs;
    if (!Array.isArray(rawMessages)) return [];
    const messages = rawMessages.flatMap((value, i): ImportedMessage[] => {
      const raw = object(value);
      const main = message(raw, i, modified);
      const result: ImportedMessage[] = main ? [main] : [];
      const blocks = object(raw.message).content ?? raw.content;
      if (Array.isArray(blocks)) for (const [index, value] of blocks.entries()) {
        const block = object(value);
        if (block.type === 'tool_use' || block.type === 'tool_result') {
          const decoded = extractSourceContent(block.content, true);
          result.push({ id: `${raw.uuid || raw.id || i}-tool-${index}`, role: 'tool', tool: string(block.name) || 'Tool output',
            text: block.type === 'tool_use' ? JSON.stringify(block.input ?? {}) : decoded.text,
            callId: string(block.id || block.tool_use_id) || undefined, toolEvent: block.type === 'tool_use' ? 'call' : 'result',
            toolInput: block.type === 'tool_use' ? object(block.input) : undefined, attachments: decoded.attachments,
            ...(block.type === 'tool_result' ? { toolResult: block.content } : {}),
            toolFailed: block.is_error === true, timestamp: timestamp(raw.timestamp || raw.created_at, modified + i) });
        }
      }
      const tool = object(raw.toolFormerData);
      if (Object.keys(tool).length) {
        let input = tool.params ?? tool.parameters ?? tool.arguments ?? tool.input;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { input }; } }
        const callId = string(tool.toolCallId || tool.tool_call_id) || `${raw.bubbleId || raw.id || i}-tool`;
        const toolName = string(tool.name || tool.toolName || tool.tool) || 'Cursor tool';
        const output = tool.result ?? tool.output ?? tool.rawResult;
        result.push({ id: `${raw.bubbleId || raw.id || i}-tool`, role: 'tool', tool: toolName, text: JSON.stringify(input ?? {}), callId, toolEvent: 'call', toolInput: object(input), timestamp: timestamp(raw.createdAt, modified + i) });
        if (output !== undefined) {
          const decoded = extractSourceContent(output, true);
          result.push({ id: `${raw.bubbleId || raw.id || i}-tool-result`, role: 'tool', tool: toolName, text: decoded.text, callId, toolEvent: 'result', toolResult: output, toolFailed: tool.isError === true, attachments: decoded.attachments, timestamp: timestamp(raw.createdAt, modified + i) });
        }
      }
      return result;
    });
    const chat = makeChat(provider, sourcePath, string(row.uuid || row.id || row.composerId || row.sessionId) || `${path.basename(sourcePath)}:${index}`, string(row.name || row.title), string(row.cwd || row.workspacePath || row.projectPath), messages, timestamp(row.updated_at || row.updatedAt || row.lastUpdatedAt, modified));
    return chat ? [chat] : [];
  });
}

/** Cursor's text transcripts and exported Markdown use explicit role headings. */
export function parseTextTranscript(provider: ImportProvider, content: string, sourcePath: string, modified: number): ImportItem[] {
  const messages: ImportedMessage[] = [];
  const lines = content.split(/\r?\n/);
  let active: { role: ImportedMessage['role']; lines: string[] } | null = null;
  let fence = '';
  const flush = () => {
    if (!active) return;
    const text = active.lines.join('\n').replace(/^\s*<user_query>\s*|\s*<\/user_query>\s*$/g, '').trim();
    if (text) messages.push({ id: `message-${messages.length}`, role: active.role, text, timestamp: modified + messages.length });
  };
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = ''; }
    const role = !fence && line.match(/^(?:#{1,3}\s+|\*\*|\[)?(user|human|assistant|claude|cursor|codex)(?:\*\*|\])?\s*:?\s*$/i);
    if (role) { flush(); active = { role: /user|human/i.test(role[1]) ? 'user' : 'assistant', lines: [] }; }
    else if (active) active.lines.push(line);
  }
  flush();
  const title = content.match(/^# (.+)$/m)?.[1] || '';
  const sourceId = path.basename(sourcePath).replace(/\.(md|txt)$/i, '');
  const chat = makeChat(provider, sourcePath, sourceId, title, '', messages, modified);
  return chat ? [chat] : [];
}

export function frontmatter(content: string): { name: string; description: string; body: string } {
  const match = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  const get = (key: string) => {
    const value = (match?.[1].match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))?.[1] || '').trim();
    if (/^[|>][-+]?\s*$/.test(value)) {
      return (match?.[1].match(new RegExp(`^${key}:[^\\n]*\\n((?:[ \\t]+[^\\n]*(?:\\n|$))+)`, 'm'))?.[1] || '').trim().replace(/\s+/g, ' ');
    }
    if (value.startsWith('"')) { try { return String(JSON.parse(value)); } catch { } }
    return value.replace(/^["']|["']$/g, '');
  };
  return { name: get('name'), description: get('description'), body: match ? match[2].trim() : content.trim() };
}

export function setupItem(provider: ImportProvider, category: ImportCategory, sourcePath: string, content: string, modified: number, workspace?: string, name?: string, config?: Obj): ImportItem {
  const parsed = frontmatter(content);
  // Versioned plugin caches must update the same imported skill after upgrades.
  const stablePath = sourcePath.includes(`${path.sep}cache${path.sep}`)
    ? sourcePath.replace(/([\\/])v?\d+\.\d+(?:\.[\w.-]+)?(?=[\\/])/g, '$1[version]') : sourcePath;
  const id = `${provider}-${digest(`${category}:${stablePath}`).slice(0, 32)}`;
  const compatibilityNote = category === 'skills' && /mcp__codex_app|mcp__cua_repl|artifactSession|plugin:\/\/|skill:\/\//.test(content)
    ? 'References source-app tools. Saved paused until adapted to EterX’s available tools.' : undefined;
  return {
    id, category, sourceId: sourcePath, sourcePath, content, config, workspace, compatibilityNote,
    name: name || parsed.name || path.basename(sourcePath),
    detail: parsed.description || (workspace ? path.basename(workspace) : 'Personal setup'),
    updatedAt: modified, fingerprint: digest(JSON.stringify([content, config, workspace])),
  };
}

/** Small, non-evaluating reader for Codex's scalar/array/table configuration.
 * Unsupported TOML is reported, never interpreted as JavaScript or a command. */
export function parseCodexConfig(text: string): { config: Obj; unsupported: number } {
  const config: Obj = Object.create(null);
  let section: Obj = config;
  let unsupported = 0;
  const safe = (key: string) => !['__proto__', 'prototype', 'constructor'].includes(key);
  const parts = (value: string) => (value.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^.]+/g) || []).map(item => item.trim().replace(/^["']|["']$/g, ''));
  const uncomment = (value: string) => {
    let quote = '';
    for (let i = 0; i < value.length; i++) {
      if (quote === '"' && value[i] === '\\') { i++; continue; }
      if (quote) { if (value[i] === quote) quote = ''; }
      else if (value[i] === '"' || value[i] === "'") quote = value[i];
      else if (value[i] === '#') return value.slice(0, i).trim();
    }
    return value.trim();
  };
  const splitValues = (value: string) => {
    const result: string[] = [];
    let quote = '', depth = 0, start = 0;
    for (let i = 0; i < value.length; i++) {
      const character = value[i];
      if (quote === '"' && character === '\\') { i++; continue; }
      if (quote) { if (character === quote) quote = ''; continue; }
      if (character === '"' || character === "'") quote = character;
      else if (character === '[' || character === '{') depth++;
      else if (character === ']' || character === '}') depth--;
      else if (character === ',' && depth === 0) { result.push(value.slice(start, i)); start = i + 1; }
    }
    if (quote || depth) throw new Error('Incomplete value');
    result.push(value.slice(start));
    return result.map(part => part.trim()).filter(Boolean);
  };
  const scalar = (value: string): any => {
    const cleaned = uncomment(value);
    if (cleaned.startsWith("'") && cleaned.endsWith("'")) return cleaned.slice(1, -1);
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) return splitValues(cleaned.slice(1, -1)).map(scalar);
    if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
      const result: Obj = Object.create(null);
      for (const entry of splitValues(cleaned.slice(1, -1))) {
        const pair = entry.match(/^([\w-]+|"(?:\\.|[^"\\])*"|'[^']*')\s*=\s*([\s\S]+)$/);
        if (!pair) throw new Error('Unsupported inline table');
        const key = pair[1].replace(/^["']|["']$/g, '');
        if (safe(key)) result[key] = scalar(pair[2]);
      }
      return result;
    }
    if (/^(?:"|true$|false$)/.test(cleaned)) return JSON.parse(cleaned);
    if (/^[+-]?\d[\d_.eE+-]*$/.test(cleaned)) { const value = Number(cleaned.replace(/_/g, '')); if (Number.isFinite(value)) return value; }
    throw new Error('Unsupported value');
  };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = uncomment(lines[index]);
    if (!line || line.startsWith('#')) continue;
    const table = line.match(/^\[([^\[\]]+)\](?:\s*#.*)?$/);
    if (table) {
      section = config;
      for (const key of parts(table[1])) {
        if (!safe(key)) { section = Object.create(null); break; }
        if (!section[key] || typeof section[key] !== 'object') section[key] = Object.create(null);
        section = section[key];
      }
      continue;
    }
    const pair = line.match(/^([\w.-]+|"[^"]+")\s*=\s*(.*)$/);
    if (!pair || !safe(pair[1])) { unsupported++; continue; }
    try {
      let value = pair[2];
      if (value.startsWith('[')) while (!/\]$/.test(value.trim()) && index + 1 < lines.length) value += uncomment(lines[++index]);
      if (value.startsWith('"""') || value.startsWith("'''")) {
        const quote = value.slice(0, 3);
        value = value.slice(3);
        while (!value.includes(quote) && index + 1 < lines.length) value += `\n${lines[++index]}`;
        const key = pair[1].replace(/^"|"$/g, '');
        if (safe(key)) section[key] = value.split(quote)[0];
      } else {
        const key = pair[1].replace(/^"|"$/g, '');
        if (safe(key)) section[key] = scalar(value);
      }
    } catch { unsupported++; }
  }
  return { config, unsupported };
}
