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
  return message.includes('cancelled') || message.includes('canceled') || message.includes('abort');
};

/** Retry only failures that can plausibly succeed without changing the request. */
export const isRetryableApiError = (error: unknown): boolean => {
  if (isApiRequestCancelled(error)) return false;
  const status = Number((error as any)?.status || (error as any)?.statusCode || 0);
  if ([400, 401, 403, 404, 405, 409, 422].includes(status)) return false;

  const message = String((error as any)?.message || error || '').toLowerCase();
  if (/(invalid api key|api key not valid|authentication|unauthorized|forbidden|invalid argument|bad request|not found|unsupported parameter|model .* not found)/i.test(message)) {
    return false;
  }
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500 ||
    /(timeout|timed out|deadline|econnreset|econnrefused|fetch failed|network|socket|overloaded|temporar|rate limit|quota|unavailable|service error)/i.test(message);
};

export const isProviderFailoverError = (error: unknown): boolean => {
  if (isApiRequestCancelled(error)) return false;
  const message = String((error as any)?.message || error || '').toLowerCase();
  return !/(invalid argument|bad request|unsupported parameter|model .* not found|not found|token limit|context length)/i.test(message);
};

export const waitForApiRetry = async (retryNumber: number, signal?: AbortSignal): Promise<void> => {
  const delayMs = Math.min(4_000, 350 * (2 ** Math.max(0, retryNumber - 1)));
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
      await waitForApiRetry(attempt + 1, signal);
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
        await waitForApiRetry(Math.floor((attempt + 1) / normalizedKeys.length), signal);
      }
      onRetry?.(attempt + 1, totalAttempts, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'API request failed.'));
}
