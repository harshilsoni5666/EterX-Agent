import { formatUnknownError } from '../error-format';

export type CuaResponse = {
  value: any;
  image?: { data: string; mimeType: string };
};

/** CLI JSON may have a diagnostic line before or after the actual result. */
export function parseCuaJson(stdout: string): any | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { /* Find a complete JSON document below. */ }
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, end + 1)); } catch { break; }
        }
      }
    }
  }
  return undefined;
}

function failed(value: any): boolean {
  return Boolean(value && typeof value === 'object' && (
    value.isError === true || value.is_error === true || value.error
    || value.success === false || value.ok === false
    || (Array.isArray(value.errors) && value.errors.length)
    || [value.status, value.effect].some(status =>
      ['error', 'failed', 'denied', 'refused', 'blocked', 'background_unavailable'].includes(String(status || '').toLowerCase()))
  ));
}

function contentText(value: any): string {
  return (Array.isArray(value?.content) ? value.content : [])
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text).join('\n');
}

export class CuaToolError extends Error {
  constructor(message: string, readonly inputRefused = false) { super(message); }
}

/** Keep image content separate from metadata; unwrapping must not discard pixels. */
export function decodeCuaResponse(stdout: string): CuaResponse {
  const text = stdout.trim();
  const value = parseCuaJson(text);
  if (value === undefined) {
    // Successful CLI actions can print a plain confirmation instead of JSON.
    // An empty/malformed response is never proof of successful execution.
    if (!text || /^[\[{]/.test(text)) throw new Error('Cua Driver returned an empty or unreadable response. Observe before repeating input.');
    return { value: { message: text.slice(0, 4000) } };
  }
  return decodeCuaToolResult(value);
}

export function decodeCuaToolResult(value: any): CuaResponse {
  let image: CuaResponse['image'];
  for (let depth = 0; depth < 8; depth += 1) {
    if (failed(value)) {
      const structured = value.structuredContent ?? value.structured_content;
      const code = String(structured?.code || value.code || '');
      const message = formatUnknownError(value.error || value.errors || contentText(value) || structured?.error || structured?.message
        || structured?.reason || value.message || value.reason || structured?.suggestion || code, 'The desktop driver refused this action.', 650);
      const refused = /^(desktop_coordinate_scope_required|desktop_escalation_required|desktop_scope_disabled|window_scope_disabled|invalid_capture_scope|capture_scope_conflict|invalid_target|stale_element_token|stale_capture_id)$/.test(code);
      throw new CuaToolError(code && !message.includes(code) ? `${message} (${code})` : message, refused);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, image };
    if ((value.jsonrpc === '2.0' || typeof value.ok === 'boolean') && 'result' in value) {
      value = value.result;
      continue;
    }
    const blocks: any[] = Array.isArray(value.content) ? value.content : [];
    const block = blocks.find(item => item?.type === 'image' && typeof item.data === 'string' && item.data.length);
    if (block) image = { data: block.data, mimeType: block.mimeType || 'image/png' };
    if (typeof value.screenshot_png_b64 === 'string' && value.screenshot_png_b64.length) {
      image = { data: value.screenshot_png_b64, mimeType: value.screenshot_mime_type || 'image/png' };
      const { screenshot_png_b64: _pixels, ...metadata } = value;
      value = metadata;
    }
    const structured = value.structuredContent ?? value.structured_content;
    if (structured != null) {
      value = structured;
      continue;
    }
    if (blocks.length) {
      let parsed: any | undefined;
      for (const item of blocks) {
        if (item?.type !== 'text' || typeof item.text !== 'string') continue;
        try { parsed = JSON.parse(item.text); break; } catch { /* Keep the text summary when no JSON is present. */ }
      }
      if (parsed !== undefined) { value = parsed; continue; }
      value = { message: contentText(value).slice(0, 4000) };
    }
    return { value, image };
  }
  throw new Error('Cua Driver returned too many nested response envelopes.');
}

/** Process failures must preserve the driver's reason without echoing argv or input. */
export function cuaProcessFailure(stdout: string, stderr: string, stdin?: string): string {
  let detail = '';
  if (parseCuaJson(stdout) !== undefined) {
    try {
      const { value } = decodeCuaResponse(stdout);
      detail = typeof value?.message === 'string' ? value.message : '';
    } catch (error: any) { detail = String(error?.message || ''); }
  }
  detail ||= stderr.trim() || stdout.trim();
  return cuaDiagnostic(detail, stdin ? parseCuaJson(stdin) : undefined);
}

export function cuaDiagnostic(detail: string, input?: Record<string, unknown>): string {
  for (const key of ['text', 'value']) {
    const value = input?.[key];
    if (typeof value !== 'string' || !value) continue;
    for (const form of new Set([JSON.stringify(value).slice(1, -1), value])) {
      detail = detail.split(form).join('[input omitted]');
    }
  }
  return detail.replace(/\x1b\[[0-9;]*m/g, '').replace(/[A-Za-z0-9+/]{512,}={0,2}/g, '[image data omitted]')
    .replace(/\s+/g, ' ').trim().slice(0, 650);
}
