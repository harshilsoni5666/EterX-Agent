/** For finite settings/storage endpoints only; never use for generation or edits. */
export async function requestJson(
  input: string,
  init: RequestInit = {},
  timeoutMs = 120_000,
): Promise<Pick<Response, 'ok' | 'status' | 'json'>> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(
    new Error(`EterX request deadline reached after ${timeoutMs} ms.`),
    { name: 'TimeoutError', code: 'ETERX_REQUEST_TIMEOUT' },
  )), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, json: async () => JSON.parse(body) };
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}
