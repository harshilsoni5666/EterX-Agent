import { describeTimeout } from './timeout-error';

export const DEFAULT_API_RETRIES = 0;
export const MAX_API_RETRIES = 3;

export const normalizeApiRetries = (value: unknown): number => {
  const retries = Number(value);
  return Number.isFinite(retries)
    ? Math.max(0, Math.min(MAX_API_RETRIES, Math.floor(retries)))
    : DEFAULT_API_RETRIES;
};

export const getApiRetries = (settings?: { apiRetries?: unknown } | null): number =>
  normalizeApiRetries(settings?.apiRetries);

export const isApiRequestCancelled = (error: unknown): boolean => {
  const message = String((error as any)?.message || error || '').toLowerCase();
  if (/cancelled_by_user|canceled_by_user/.test(message)) return true;
  // Transport errors can say "aborted" after their own deadline expires.
  // Those are failures, not a user pressing Stop.
  if (describeTimeout(error)) return false;
  return message.includes('cancelled') || message.includes('canceled') || message.includes('abort');
};

/** Retry only failures that can plausibly succeed without changing the request. */
export const isRetryableApiError = (error: unknown): boolean => {
  if (isApiRequestCancelled(error)) return false;
  const status = Number((error as any)?.status || (error as any)?.statusCode || 0);
  if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) return false;
  if (isProviderContextLimitError(error)) return false;

  const message = String((error as any)?.message || error || '').toLowerCase();
  if (/(invalid api key|api key not valid|authentication|unauthorized|forbidden|invalid argument|bad request|not found|unsupported parameter|model .* not found)/i.test(message)) {
    return false;
  }
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500 ||
    /(timeout|timed out|deadline|econnreset|econnrefused|fetch failed|network|socket|overloaded|temporar|rate limit|quota|unavailable|service error)/i.test(message);
};

export const isProviderFailoverError = (error: unknown): boolean => {
  if (isApiRequestCancelled(error)) return false;
  // An oversized payload is request-specific. Rotating credentials or replaying
  // an API round cannot help and only delays the compaction recovery path.
  if (isProviderContextLimitError(error)) return false;
  const message = String((error as any)?.message || error || '').toLowerCase();
  return !/(invalid argument|bad request|unsupported parameter|model .* not found|not found|token limit|context length)/i.test(message);
};

/**
 * Detect a provider-authored input/context capacity rejection. This is kept
 * separate from ordinary retryability because replaying the same oversized
 * payload against another key cannot help; callers must first run the exact
 * transcript through the transactional context compactor.
 */
export const isProviderContextLimitError = (error: unknown): boolean => {
  const record = error as any;
  const message = [
    record?.message,
    record?.error?.message,
    record?.response?.data?.error?.message,
    record?.response?.data?.message,
    record?.cause?.message,
    typeof error === 'string' ? error : '',
  ].map(value => String(value || '').toLowerCase()).filter(Boolean).join(' ');
  if (!message) return false;
  return message.includes('context_length_exceeded')
    || message.includes('maximum context length')
    || message.includes('context window exceeded')
    || message.includes('context window limit')
    || message.includes('prompt is too long')
    || message.includes('input is too long')
    || message.includes('request too large for model')
    || (
      /(?:input|prompt|context).{0,80}(?:token count|tokens?)/.test(message)
      && /(?:exceed|limit|maximum|max|too many|too long|reduce)/.test(message)
    )
    || (
      /(?:prompt|input|context)\s+(?:has\s+)?(?:too many\s+)?tokens?/.test(message)
      && /(?:exceed|limit|maximum|max|too many|too long|reduce)/.test(message)
    )
    || (
      message.includes('context window')
      && /(?:exceed|limit|maximum|max|too (?:large|long)|reduce)/.test(message)
    );
};

const retryHeaderValue = (error: any, name: string): unknown => {
  const candidates = [error?.headers, error?.response?.headers];
  for (const headers of candidates) {
    if (!headers) continue;
    if (typeof headers.get === 'function') {
      const value = headers.get(name);
      if (value !== null && value !== undefined && value !== '') return value;
    }
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entry && entry[1] !== null && entry[1] !== undefined && entry[1] !== '') return entry[1];
  }
  return undefined;
};

const durationMs = (value: unknown, unit: 'seconds' | 'milliseconds'): number => {
  const numeric = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return unit === 'seconds' ? numeric * 1000 : numeric;
};

const providerRetryDelayMs = (error: unknown): number => {
  const record = error as any;
  const explicitMilliseconds = [
    retryHeaderValue(record, 'retry-after-ms'),
    record?.retryAfterMs,
    record?.retry_after_ms,
  ].map(value => durationMs(value, 'milliseconds')).find(value => value > 0);
  if (explicitMilliseconds) return explicitMilliseconds;

  const retryAfter = retryHeaderValue(record, 'retry-after') ?? record?.retryAfter ?? record?.retry_after;
  if (retryAfter !== undefined && retryAfter !== null && retryAfter !== '') {
    const seconds = durationMs(retryAfter, 'seconds');
    if (seconds > 0) return seconds;
    const date = Date.parse(String(retryAfter));
    if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  }

  const message = String(record?.message || error || '');
  const match = message.match(/(?:retry|try again)\s+(?:in|after)\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|seconds?)/i)
    || message.match(/retryDelay[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*(ms|s)/i);
  if (!match) return 0;
  return Number(match[1]) * (/^ms|millisecond/i.test(match[2]) ? 1 : 1000);
};

/**
 * Exponential retry delay with positive jitter and bounded provider guidance.
 * Positive-only jitter never retries before a Retry-After/RetryInfo deadline.
 */
export const resolveApiRetryDelayMs = (
  retryNumber: number,
  error?: unknown,
  jitterSample = Math.random(),
): number => {
  const retryIndex = Math.max(0, Math.floor(Number(retryNumber) || 1) - 1);
  const exponential = Math.min(8_000, 750 * (2 ** retryIndex));
  const providerDelay = Math.min(30_000, Math.max(0, providerRetryDelayMs(error)));
  const floor = Math.max(exponential, providerDelay);
  const jitter = Math.floor(Math.max(0, Math.min(1, jitterSample)) * Math.min(1_000, floor * 0.25));
  return Math.min(30_000, Math.ceil(floor + jitter));
};

export const waitForApiRetry = async (
  retryNumber: number,
  signal?: AbortSignal,
  error?: unknown,
): Promise<void> => {
  const delayMs = resolveApiRetryDelayMs(retryNumber, error);
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
    if (signal?.aborted) throw new DOMException('The API request was aborted.', 'AbortError');
    await new Promise(resolve => setTimeout(resolve, Math.min(100, end - Date.now())));
  }
};

export async function withApiRetries<T>(
  operation: () => Promise<T>,
  settings?: { apiRetries?: unknown } | null,
  signal?: AbortSignal,
): Promise<T> {
  const retries = getApiRetries(settings);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new DOMException('The API request was aborted.', 'AbortError');
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableApiError(error)) throw error;
      await waitForApiRetry(attempt + 1, signal, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'API request failed.'));
}

/**
 * Run a provider request through complete API-key rounds.
 *
 * A retry count is a number of additional passes over the key pool. With
 * three keys and one retry, the sequence is key1, key2, key3, key1, key2,
 * key3. Failed keys are intentionally not retired from this request: a later
 * round must be allowed to recover them.
 */
export async function withApiKeyRounds<T>(
  keys: readonly string[],
  settings: { apiRetries?: unknown } | null | undefined,
  operation: (apiKey: string, attempt: number) => Promise<T>,
  signal?: AbortSignal,
  onRetry?: (attempt: number, totalAttempts: number, error: unknown) => void,
): Promise<T> {
  const normalizedKeys = Array.from(new Set(keys.map(key => String(key || '').trim()).filter(Boolean)));
  if (normalizedKeys.length === 0) throw new Error('No provider API keys are configured.');

  const totalAttempts = normalizedKeys.length * (getApiRetries(settings) + 1);
  let lastError: unknown;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    if (signal?.aborted) throw new DOMException('The API request was aborted.', 'AbortError');
    try {
      return await operation(normalizedKeys[attempt % normalizedKeys.length], attempt);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= totalAttempts || !isProviderFailoverError(error)) throw error;

      // Switching to the next configured key is immediate. Backoff is only
      // used between complete pool rounds, avoiding hidden per-key nuisance.
      if ((attempt + 1) % normalizedKeys.length === 0) {
        await waitForApiRetry(Math.floor((attempt + 1) / normalizedKeys.length), signal, error);
      }
      onRetry?.(attempt + 1, totalAttempts, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'API request failed.'));
}
