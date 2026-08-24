import fs from 'fs-extra';
import path from 'path';
import { getEterxWorkspaceDir } from './storage-paths';

const DEFAULT_MAX_TRACE_BYTES = 64 * 1024 * 1024;
const DEFAULT_TRACE_ARCHIVES = 3;
let traceWriteQueue: Promise<void> = Promise.resolve();

/**
 * Local JSONL trace sink for debugging every live run.
 * ETERX_TRACE_FILE can override the default project-local path.
 * It is deliberately fire-and-forget and never affects the agent loop.
 */
export function writeRuntimeTrace(kind: string, data: Record<string, unknown>): void {
  const target = String(process.env.ETERX_TRACE_FILE || getEterxWorkspaceDir('logs', 'syn-live.jsonl')).trim();
  const traceData = kind === 'model_request'
    ? process.env.ETERX_TRACE_FULL_PAYLOAD === '1' ? data : summarizeModelRequest(data)
    : boundTraceValue(data);
  const record = {
    ts: new Date().toISOString(),
    kind,
    ...redact(traceData),
  };
  const resolvedTarget = path.resolve(target);
  const readableTarget = resolvedTarget.replace(/\.jsonl$/i, '-readable.md');
  const jsonLine = `${JSON.stringify(record)}\n`;
  const readable = process.env.ETERX_TRACE_READABLE === '1' ? formatReadableRecord(record) : '';

  // Serialize writes through one short queue so concurrent agent loops cannot
  // race rotation or interleave records. Tracing remains fire-and-forget.
  traceWriteQueue = traceWriteQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.ensureDir(path.dirname(resolvedTarget));
      await rotateTraceIfNeeded(resolvedTarget, Buffer.byteLength(jsonLine));
      await fs.appendFile(resolvedTarget, jsonLine, 'utf8');
      if (readable) {
        await rotateTraceIfNeeded(readableTarget, Buffer.byteLength(readable));
        await fs.appendFile(readableTarget, readable, 'utf8');
      }
    })
    .catch(() => undefined);
}

function summarizeModelRequest(data: Record<string, unknown>): Record<string, unknown> {
  const request = data.request && typeof data.request === 'object'
    ? data.request as Record<string, unknown>
    : data;
  const messages = Array.isArray(request.messages)
    ? request.messages
    : Array.isArray(request.contents)
      ? request.contents
      : Array.isArray(data.contents)
        ? data.contents
        : [];
  const tools = Array.isArray(request.tools)
    ? request.tools
    : Array.isArray(data.tools)
      ? data.tools
      : [];
  const system = request.systemInstruction ?? request.system ?? data.systemInstruction ?? data.system ?? '';
  const scalarKeys = [
    'provider', 'model', 'projectId', 'chatId', 'interaction', 'cacheActive',
    'cachedContent', 'stream', 'toolCount', 'requestId', 'runId',
  ];
  const identity = Object.fromEntries(scalarKeys
    .filter(key => ['string', 'number', 'boolean'].includes(typeof data[key]))
    .map(key => [key, data[key]]));

  return {
    ...identity,
    fullPayloadCaptured: false,
    requestSummary: {
      requestKeys: Object.keys(request).sort(),
      messageCount: messages.length,
      toolCount: tools.length || Number(data.toolCount) || 0,
      messageTextChars: countStringChars(messages),
      systemChars: countStringChars(system),
      toolSchemaChars: estimateJsonChars(tools),
      attachmentParts: countAttachmentParts(messages),
    },
  };
}

function countStringChars(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object' || seen.has(value as object)) return 0;
  seen.add(value as object);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countStringChars(item, seen), 0);
  return Object.values(value as Record<string, unknown>)
    .reduce((sum, item) => sum + countStringChars(item, seen), 0);
}

function countAttachmentParts(value: unknown, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return 0;
  seen.add(value as object);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countAttachmentParts(item, seen), 0);
  const record = value as Record<string, unknown>;
  const current = record.inlineData || record.fileData || record.image_url || record.input_audio ? 1 : 0;
  return current + Object.values(record).reduce((sum, item) => sum + countAttachmentParts(item, seen), 0);
}

function estimateJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function boundTraceValue(value: unknown, depth = 0): any {
  if (typeof value === 'string') {
    if (value.length <= 16_000) return value;
    return `${value.slice(0, 12_000)}\n...[${value.length - 14_000} trace chars omitted]...\n${value.slice(-2_000)}`;
  }
  if (depth >= 10) return '[TRACE_DEPTH_LIMIT]';
  if (Array.isArray(value)) {
    const bounded = value.slice(0, 100).map(item => boundTraceValue(item, depth + 1));
    if (value.length > 100) bounded.push(`[${value.length - 100} trace items omitted]`);
    return bounded;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.slice(0, 120).map(([key, item]) => [key, boundTraceValue(item, depth + 1)]));
  }
  return value;
}

async function rotateTraceIfNeeded(target: string, incomingBytes: number): Promise<void> {
  const configuredMax = Number(process.env.ETERX_TRACE_MAX_BYTES);
  const maxBytes = Number.isFinite(configuredMax)
    ? Math.max(1024 * 1024, Math.floor(configuredMax))
    : DEFAULT_MAX_TRACE_BYTES;
  const configuredArchives = Number(process.env.ETERX_TRACE_ARCHIVES);
  const archiveCount = Number.isFinite(configuredArchives)
    ? Math.max(1, Math.min(10, Math.floor(configuredArchives)))
    : DEFAULT_TRACE_ARCHIVES;
  const currentSize = (await fs.stat(target).catch(() => null))?.size || 0;
  if (currentSize + incomingBytes <= maxBytes) return;

  await fs.remove(`${target}.${archiveCount}`).catch(() => undefined);
  for (let index = archiveCount - 1; index >= 1; index--) {
    const from = `${target}.${index}`;
    const to = `${target}.${index + 1}`;
    if (await fs.pathExists(from)) await fs.move(from, to, { overwrite: true });
  }
  if (await fs.pathExists(target)) await fs.move(target, `${target}.1`, { overwrite: true });
}

function formatReadableRecord(record: Record<string, any>): string {
  const title = String(record.kind || 'runtime_event').replace(/_/g, ' ').toUpperCase();
  const lines = [`\n## ${title} — ${record.ts}\n`];

  if (record.kind === 'model_request') {
    lines.push(`Provider: **${record.provider || 'unknown'}**  `);
    lines.push(`Model: **${record.model || 'unknown'}**\n`);
    lines.push('### Request metrics\n```json\n');
    lines.push(JSON.stringify(record.requestSummary || record.request || {}, null, 2));
    lines.push('\n```\n');
  } else if (record.kind === 'agent_trace') {
    const event = record.event || {};
    lines.push(`Event: **${event.type || 'unknown'}**  `);
    if (event.toolName || event.tool) lines.push(`Tool: **${event.toolName || event.tool}**  `);
    lines.push('\n### Returned / runtime output\n```json\n');
    lines.push(JSON.stringify(event, null, 2));
    lines.push('\n```\n');
  } else if (record.kind === 'synapse_injection') {
    lines.push('### Context injected into the model\n```text\n');
    lines.push(String(record.renderedContext || '(no Synapse context injected)'));
    lines.push('\n```\n');
    lines.push(`State: **${record.state}**, confidence: **${record.confidence}**, selected records: **${record.decisionSurface?.finalCount ?? 0}**\n`);
  } else {
    lines.push('```json\n', JSON.stringify(record, null, 2), '\n```\n');
  }

  return lines.join('');
}

function redact(value: unknown): any {
  if (typeof value === 'string') {
    return value
      .replace(/(AIza[0-9A-Za-z_-]{20,})/g, '[REDACTED_GOOGLE_KEY]')
      .replace(/(sk-[A-Za-z0-9_-]{20,})/g, '[REDACTED_API_KEY]')
      .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (/^(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|secret|password|credential)$/i.test(key)) {
        return [key, '[REDACTED_SECRET]'];
      }
      return [key, redact(item)];
    }));
  }
  return value;
}
