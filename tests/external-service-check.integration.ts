import assert from 'node:assert/strict';
import { externalServiceCheckTool } from '../src/lib/agent/tools/core/external_service_check';
import { applyRuntimeSearchSettings } from '../src/lib/search/search-runtime';
import { applyRuntimeImageSettings } from '../src/lib/image/image-generation-runtime';
import { applyRuntimeVideoSettings } from '../src/lib/video/video-generation-runtime';

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
  applyRuntimeSearchSettings({
    enabled: true,
    provider: 'brave',
    fallbackProviders: ['duckduckgo'],
    apiKeys: { brave: ['brave-secret-that-must-not-be-returned'] },
    baseURLs: { brave: 'https://api.search.brave.com/res/v1' },
  });
  applyRuntimeImageSettings({
    enabled: true,
    provider: 'openai',
    modelByProvider: { openai: 'gpt-image-2' },
    apiKeys: { openai: ['image-secret-that-must-not-be-returned'] },
  });
  applyRuntimeVideoSettings({
    enabled: true,
    provider: 'openai',
    modelByProvider: { openai: 'sora-2' },
    apiKeys: { openai: ['video-secret-that-must-not-be-returned'] },
  });

  const result = await (externalServiceCheckTool.execute as any)(
    { service: 'all', mode: 'status' },
    { allowedCapabilities: ['network.public'] },
  );
  assert.equal(result.mode, 'status');
  assert.equal(result.routes.length, 3);
  assert.ok(result.providers.some((provider: any) => provider.provider === 'brave' && provider.status === 'ready'));
  assert.ok(result.providers.some((provider: any) => provider.provider === 'openai' && provider.service === 'image' && provider.model === 'gpt-image-2'));
  assert.ok(result.providers.some((provider: any) => provider.provider === 'openai' && provider.service === 'video' && provider.model === 'sora-2'));
  assert.equal(JSON.stringify(result).includes('secret-that-must-not-be-returned'), false);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('api.search.brave.com')) {
      return new Response(JSON.stringify({ web: { results: [{ title: 'probe', url: 'https://example.com/probe' }] } }), { status: 200 });
    }
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'sora-2' }] }), { status: 200 });
    }
    throw new Error(`Unexpected probe request: ${url}`);
  }) as typeof fetch;
  const searchProbe = await (externalServiceCheckTool.execute as any)(
    { service: 'search', mode: 'probe', provider: 'brave' },
    { allowedCapabilities: ['network.public'] },
  );
  assert.equal(searchProbe.providers[0]?.status, 'passed');
  const mediaProbe = await (externalServiceCheckTool.execute as any)(
    { service: 'all', mode: 'probe', provider: 'openai' },
    { allowedCapabilities: ['network.public'] },
  );
  assert.equal(mediaProbe.providers.filter((provider: any) => provider.status === 'passed').length, 2);
  console.log('External service check integration checks passed.');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
