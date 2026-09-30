import OpenAISDK from 'openai';
import AnthropicSDK from '@anthropic-ai/sdk';

/** Fetch without an SDK deadline, retaining caller and stream cancellation. */
function fetchWithoutDeadline(
  fetcher: typeof fetch,
  url: RequestInfo,
  init: RequestInit | undefined,
  controller: AbortController,
): Promise<Response> {
  const { signal, method, ...options } = init || {};
  const body = options.body;
  const streamingBody = (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
    || (typeof body === 'object' && body !== null && Symbol.asyncIterator in body);
  return fetcher.call(undefined, url, {
    ...options,
    ...(streamingBody ? { duplex: 'half' } : {}),
    method: method?.toUpperCase() || 'GET',
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
  });
}

// The SDKs unconditionally schedule setTimeout, even for timeout: 0. Override
// only that case; finite deadlines explicitly requested by callers still work.
export class OpenAI extends OpenAISDK {
  override fetchWithTimeout(url: RequestInfo, init: RequestInit | undefined, ms: number, controller: AbortController): Promise<Response> {
    return ms === 0
      ? fetchWithoutDeadline(this._options.fetch || globalThis.fetch, url, init, controller)
      : super.fetchWithTimeout(url, init, ms, controller);
  }
}

export class Anthropic extends AnthropicSDK {
  override fetchWithTimeout(url: RequestInfo, init: RequestInit | undefined, ms: number, controller: AbortController): Promise<Response> {
    return ms === 0
      ? fetchWithoutDeadline(this._options.fetch || globalThis.fetch, url, init, controller)
      : super.fetchWithTimeout(url, init, ms, controller);
  }
}
