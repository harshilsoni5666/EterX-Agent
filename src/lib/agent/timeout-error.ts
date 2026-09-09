export type TimeoutSource = 'application' | 'sdk' | 'transport' | 'upstream' | 'unknown';

/** Attribute only evidence actually carried by an error; elapsed time is not proof. */
export function describeTimeout(error: unknown): { source: TimeoutSource; label: string } | null {
  const messages: string[] = [];
  const names: string[] = [];
  const codes: string[] = [];
  const statuses: number[] = [];
  const seen = new Set<object>();
  const visit = (value: any, depth: number) => {
    if (!value || depth > 5) return;
    if (typeof value === 'string') { messages.push(value); return; }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (typeof value.message === 'string') messages.push(value.message);
    if (typeof value.name === 'string') names.push(value.name);
    if (typeof value.code === 'string') codes.push(value.code);
    if (value.status || value.statusCode) statuses.push(Number(value.status || value.statusCode));
    for (const key of ['cause', 'error', 'response', 'data']) visit(value[key], depth + 1);
  };
  visit(error, 0);
  const text = messages.join(' ').toLowerCase();
  if (codes.includes('ETERX_REQUEST_TIMEOUT')) {
    return { source: 'application', label: 'EterX request deadline reached' };
  }
  if (/upstream.*(?:idle.*timeout|timed out)|idle timeout exceeded/.test(text)) {
    return { source: 'upstream', label: 'Provider or gateway reported an idle timeout' };
  }
  if (statuses.includes(504) || statuses.includes(408) || /gateway timeout|deadline_exceeded/.test(text)) {
    return { source: 'upstream', label: 'Provider or gateway reported a request timeout' };
  }
  if (codes.some(code => /^(?:UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT)$/.test(code))) {
    return { source: 'transport', label: 'Network transport timed out' };
  }
  if (names.some(name => /^(?:APIConnectionTimeoutError|APITimeoutError)$/.test(name))) {
    return { source: 'sdk', label: 'Provider SDK request deadline reached' };
  }
  if (/timeout|timed out|deadline/.test(text) || names.includes('TimeoutError')) {
    return { source: 'unknown', label: 'Request timed out; source not identified' };
  }
  return null;
}
