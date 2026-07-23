import fs from 'fs-extra';
import path from 'path';

/**
 * Local JSONL trace sink for debugging every live run.
 * ETERX_TRACE_FILE can override the default project-local path.
 * It is deliberately fire-and-forget and never affects the agent loop.
 */
export function writeRuntimeTrace(kind: string, data: Record<string, unknown>): void {
  const target = String(process.env.ETERX_TRACE_FILE || path.resolve(process.cwd(), 'logs', 'syn-live.jsonl')).trim();

  const record = {
    ts: new Date().toISOString(),
    kind,
    ...redact(data),
  };
  const resolvedTarget = path.resolve(target);
  const readableTarget = resolvedTarget.replace(/\.jsonl$/i, '-readable.md');
  const readable = formatReadableRecord(record);

  void fs.ensureDir(path.dirname(resolvedTarget))
    .then(() => Promise.all([
      fs.appendFile(resolvedTarget, `${JSON.stringify(record)}\n`, 'utf8'),
      fs.appendFile(readableTarget, readable, 'utf8'),
    ]))
    .catch(() => undefined);
}

function formatReadableRecord(record: Record<string, any>): string {
  const title = String(record.kind || 'runtime_event').replace(/_/g, ' ').toUpperCase();
  const lines = [`\n## ${title} — ${record.ts}\n`];

  if (record.kind === 'model_request') {
    lines.push(`Provider: **${record.provider || 'unknown'}**  `);
    lines.push(`Model: **${record.model || 'unknown'}**\n`);
    lines.push('### Sent to API\n```json\n');
    lines.push(JSON.stringify(record.request || {
      systemInstruction: record.systemInstruction,
      contents: record.contents,
      toolCount: record.toolCount,
    }, null, 2));
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
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}
