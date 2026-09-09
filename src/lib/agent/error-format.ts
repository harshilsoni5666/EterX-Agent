import { describeTimeout } from './timeout-error';

/** Convert provider/tool error payloads into stable user-visible text. */
export const formatUnknownError = (
  value: unknown,
  fallback = 'Unknown error',
  maxLength = 12_000,
): string => {
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown, depth: number): string => {
    if (candidate === null || candidate === undefined) return '';
    if (candidate instanceof Error) return visit(candidate.message || candidate.name, depth + 1);
    if (typeof candidate === 'string') {
      const text = candidate.trim();
      if (!text || text === '[object Object]') return '';
      const legacyTaskFailure = text.match(/^taskId:\s*[^;]+;\s*success:\s*false;\s*finalAnswer:\s*([\s\S]*?)(?:;\s*(?:artifactsGenerated|executionTimeMs|complexity|modelMode):|$)/i);
      if (legacyTaskFailure) return legacyTaskFailure[1].trim();
      if (depth < 4 && ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) {
        try {
          const parsed = JSON.parse(text);
          const nested = visit(parsed, depth + 1);
          if (nested) return nested;
        } catch { /* Plain text that only resembles JSON. */ }
      }
      return text;
    }
    if (typeof candidate === 'number' || typeof candidate === 'boolean' || typeof candidate === 'bigint') {
      return String(candidate);
    }
    if (typeof candidate !== 'object' || depth > 6) return '';
    if (seen.has(candidate)) return '';
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      return candidate
        .slice(0, 40)
        .map(item => visit(item, depth + 1))
        .filter(Boolean)
        .join('; ');
    }

    const record = candidate as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'reason', 'finalAnswer', 'data', 'cause']) {
      if (!(key in record) || record[key] === candidate) continue;
      const nested = visit(record[key], depth + 1);
      if (nested) return nested;
    }

    // JSON.stringify either throws on circular provider payloads or silently
    // produces an unhelpful object-shaped blob. Build a small readable
    // projection instead; `visit` owns cycle and depth protection for every
    // nested object, including self-referential arrays.
    return Object.entries(record)
      .slice(0, 30)
      .map(([key, nested]) => {
        if (nested === candidate) return '';
        const text = visit(nested, depth + 1);
        return text ? `${key}: ${text}` : '';
      })
      .filter(Boolean)
      .join('; ');
  };

  const formatted = visit(value, 0).replace(/\s+/g, ' ').trim();
  const timeout = describeTimeout(value);
  const detail = timeout && !formatted.startsWith(timeout.label)
    ? `${timeout.label}${formatted ? `: ${formatted}` : ''}`
    : formatted;
  return (detail || fallback).slice(0, Math.max(1, maxLength));
};
