import assert from 'node:assert/strict';
import { applyRuntimeSearchSettings, executeSearchWithFailover, getNativeModelSearchCapability } from '../src/lib/search/search-runtime';

const originalFetch = globalThis.fetch;

async function run() {
try {
  assert.equal(getNativeModelSearchCapability({ selectedModelProvider: 'gemini', selectedModelName: 'gemini-3.5-flash' }).status, 'supported');
  assert.equal(getNativeModelSearchCapability({ selectedModelProvider: 'ollama', selectedModelName: 'llama3.2' }).status, 'unsupported');

  globalThis.fetch = (async () => new Response(JSON.stringify({
    output_text: 'Native model result',
    output: [{ type: 'message', content: [{ type: 'output_text', annotations: [{ type: 'url_citation', url: 'https://example.com/native', title: 'Native source' }] }] }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  applyRuntimeSearchSettings({
    preferModelSearch: true,
    provider: 'brave',
    apiKeys: { brave: ['external-key'] },
    baseURLs: { brave: 'https://api.search.brave.com/res/v1' },
  });
  const native = await executeSearchWithFailover(
    { action: 'search', query: 'native search test', numResults: 1 },
    { selectedModelProvider: 'openai', selectedModelName: 'gpt-5', runtimeSettings: { apiKeys: { openai: ['model-key'] } } },
  );
  assert.equal(native.provider, 'model');
  assert.equal(native.modelProvider, 'openai');
  assert.equal(native.results[0]?.url, 'https://example.com/native');

  let braveCalls = 0;
  const braveHeaders: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    braveCalls += 1;
    braveHeaders.push(new Headers(init?.headers).get('X-Subscription-Token') || '');
    if (braveCalls === 1) {
      return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, statusText: 'Too Many Requests' });
    }
    return new Response(JSON.stringify({ web: { results: [{ title: 'Recovered result', url: 'https://example.com/recovered' }] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  applyRuntimeSearchSettings({
    provider: 'brave',
    fallbackProviders: [],
    apiKeys: { brave: ['first-key', 'second-key'] },
    baseURLs: { brave: 'https://api.search.brave.com/res/v1' },
  });
  const rotated = await executeSearchWithFailover({ action: 'search', query: 'rotation test', numResults: 1 });
  assert.equal(rotated.provider, 'brave');
  assert.equal(rotated.results[0]?.url, 'https://example.com/recovered');
  assert.equal(braveCalls, 2, 'the second key should be tried after the first key fails');
  assert.deepEqual(braveHeaders, ['first-key', 'second-key'], 'the entered provider key pool must be sent to the provider adapter');

  let providerCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    providerCalls += 1;
    if (String(input).includes('brave')) return new Response('primary unavailable', { status: 503, statusText: 'Unavailable' });
    return new Response(JSON.stringify({ results: [{ title: 'Fallback result', url: 'https://example.com/fallback' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  applyRuntimeSearchSettings({
    provider: 'brave',
    fallbackProviders: ['searxng'],
    apiKeys: { brave: ['primary-key'] },
    baseURLs: { brave: 'https://api.search.brave.com/res/v1', searxng: 'https://search.example.com' },
  });
  const failedOver = await executeSearchWithFailover({ action: 'search', query: 'provider failover test', numResults: 1 });
  assert.equal(failedOver.provider, 'searxng');
  assert.equal(failedOver.results[0]?.url, 'https://example.com/fallback');
  assert.ok(providerCalls >= 2, 'the fallback provider should be called after the primary fails');
  assert.equal(failedOver.failedProviders?.some(item => item.provider === 'brave'), true);

  let selfHostedURL = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    selfHostedURL = String(input);
    return new Response(JSON.stringify({ data: { web: [{ title: 'Self-hosted result', url: 'https://example.com/self-hosted' }] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  applyRuntimeSearchSettings({
    provider: 'firecrawl_selfhosted',
    fallbackProviders: [],
    baseURLs: { firecrawl_selfhosted: 'http://localhost:3002' },
  });
  const selfHosted = await executeSearchWithFailover({ action: 'search', query: 'self hosted test', numResults: 1 });
  assert.equal(selfHosted.provider, 'firecrawl_selfhosted');
  assert.equal(selfHosted.results[0]?.url, 'https://example.com/self-hosted');
  assert.equal(selfHostedURL, 'http://localhost:3002/v2/search');
  assert.deepEqual(selfHosted.providerCapabilities, ['search', 'read', 'crawl', 'map']);

  applyRuntimeSearchSettings({
    provider: 'brave',
    fallbackProviders: [],
    apiKeys: { brave: ['primary-key'] },
    baseURLs: { brave: 'https://api.search.brave.com/res/v1' },
    enabledServices: { brave: ['search'] },
  });
  await assert.rejects(
    () => executeSearchWithFailover({ action: 'extract', urls: ['https://example.com'] }),
    /read service is disabled/,
  );

  applyRuntimeSearchSettings({ enabled: false, provider: 'brave', apiKeys: { brave: ['primary-key'] } });
  await assert.rejects(
    () => executeSearchWithFailover({ action: 'search', query: 'disabled search test', numResults: 1 }),
    /disabled in External service settings/,
  );

  console.log('Search runtime failover integration checks passed.');
} finally {
  globalThis.fetch = originalFetch;
}
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
