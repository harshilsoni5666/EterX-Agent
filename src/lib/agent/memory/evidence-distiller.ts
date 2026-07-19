export interface EvidenceDigest {
  text: string;
  originalChars: number;
  compactedChars: number;
  preservedExactTokens: string[];
  status: 'success' | 'failure' | 'mixed' | 'unknown';
  omittedSegments: number;
}

const FAILURE = /(?:\b(error|failed|failure|exception|denied|invalid|missing|not found|timed? out|exit(?:ed)?\s+(?:code\s+)?[1-9]\d*)\b|["']?(?:exitCode|exit_code|passed|verified|success)["']?\s*[:=]\s*(?:false|[1-9]\d*))/i;
const SUCCESS = /(?:\b(success|succeeded|passed|verified|created|updated|written|exit(?:ed)?\s+(?:code\s+)?0)\b|["']?(?:exitCode|exit_code)["']?\s*[:=]\s*0|["']?(?:passed|verified|success)["']?\s*[:=]\s*true)/i;
const DECISION = /\b(must|should|require[sd]?|decided|because|root cause|fix(?:ed)?|changed|configured|constraint|warning)\b/i;
const PATH = /(?:[A-Za-z]:\\[^\s"'<>|]+|(?:\.\.?[\\/])?(?:[\w.-]+[\\/]){1,}[\w.-]+\.[A-Za-z0-9]{1,8})/g;
const EXACT = /(?:https?:\/\/[^\s)\]}>,]+|\b[A-Fa-f0-9]{8,64}\b|\b\d+(?:\.\d+){1,3}\b|\b\d+(?:\.\d+)?(?:ms|s|kb|mb|gb|%|px|tokens?)?\b)/gi;

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9_./\\-]+/g, ' ').split(/\s+/).filter(word => word.length > 3),
  );
}

function overlapRatio(segment: string, queryWords: Set<string>): number {
  if (queryWords.size === 0) return 0;
  const segmentWords = words(segment);
  let overlap = 0;
  for (const word of queryWords) if (segmentWords.has(word)) overlap++;
  return overlap / queryWords.size;
}

function exactTokens(text: string): string[] {
  const matches = [...(text.match(PATH) || []), ...(text.match(EXACT) || [])];
  return Array.from(new Set(matches.map(value => value.replace(/[.,;:]+$/, '')).filter(Boolean))).slice(0, 24);
}

function splitSegments(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n+|(?<=[.!?}])\s+(?=[A-Z0-9{"'`])/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function statusFor(text: string): EvidenceDigest['status'] {
  const failure = FAILURE.test(text);
  const success = SUCCESS.test(text);
  if (failure && success) return 'mixed';
  if (failure) return 'failure';
  if (success) return 'success';
  return 'unknown';
}

/**
 * Extractive, loss-aware compaction for agent evidence. It never invents a
 * summary: every retained statement is copied from the source, while paths,
 * numeric values, identifiers, errors, and decisions receive strong priority.
 */
export function distillEvidence(
  value: unknown,
  query = '',
  maxChars = 900,
): EvidenceDigest {
  const source = serialize(value).replace(/\u0000/g, '').trim();
  const limit = Math.max(160, Math.floor(maxChars));
  if (source.length <= limit) {
    return {
      text: source,
      originalChars: source.length,
      compactedChars: source.length,
      preservedExactTokens: exactTokens(source),
      status: statusFor(source),
      omittedSegments: 0,
    };
  }

  const queryWords = words(query);
  const segments = splitSegments(source);
  const scored = segments.map((segment, index) => {
    const exact = exactTokens(segment);
    let score = overlapRatio(segment, queryWords) * 4;
    if (FAILURE.test(segment)) score += 3.2;
    if (SUCCESS.test(segment)) score += 1.6;
    if (DECISION.test(segment)) score += 2.2;
    if (exact.length > 0) score += Math.min(2.4, exact.length * 0.55);
    if (index === 0) score += 0.8;
    if (index === segments.length - 1) score += 0.5;
    return { segment, index, score, exact };
  });

  const selected: typeof scored = [];
  const normalized = new Set<string>();
  let used = 0;
  for (const item of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    const key = item.segment.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || normalized.has(key)) continue;
    const separator = selected.length ? 1 : 0;
    if (used + item.segment.length + separator > limit - 80) continue;
    selected.push(item);
    normalized.add(key);
    used += item.segment.length + separator;
  }
  selected.sort((a, b) => a.index - b.index);

  const selectedExact = new Set(selected.flatMap(item => item.exact));
  const allExact = exactTokens(source);
  const missingExact = allExact.filter(token => !selectedExact.has(token));
  let text = selected.map(item => item.segment).join('\n');
  if (missingExact.length > 0) {
    const exactLine = `Exact values retained: ${missingExact.join(', ')}`;
    if (text.length + exactLine.length + 1 <= limit) text += `${text ? '\n' : ''}${exactLine}`;
  }
  const omittedSegments = Math.max(0, segments.length - selected.length);
  const marker = `[Evidence distilled: ${omittedSegments} lower-utility segments omitted]`;
  if (text.length + marker.length + 1 <= limit) text += `${text ? '\n' : ''}${marker}`;
  if (!text) text = source.slice(0, limit);

  return {
    text,
    originalChars: source.length,
    compactedChars: text.length,
    preservedExactTokens: allExact,
    status: statusFor(source),
    omittedSegments,
  };
}
