import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyRuntimeImageSettings,
  executeImageGeneration,
  getImageGenerationRouteBrief,
  testImageProvider,
} from '../src/lib/image/image-generation-runtime';
import { IMAGE_PROVIDER_IDS } from '../src/lib/image/image-generation-config';

const originalFetch = globalThis.fetch;
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-image-runtime-'));
  try {
    assert.equal(IMAGE_PROVIDER_IDS.includes('openai_codex' as never), false);

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer openai-test-key');
      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.model, 'gpt-image-2');
      assert.equal(body.prompt, 'a test image');
      return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    applyRuntimeImageSettings({
      enabled: true,
      provider: 'openai',
      fallbackProviders: [],
      modelByProvider: { openai: 'gpt-image-2' },
      apiKeys: { openai: ['openai-test-key'] },
      baseURLs: { openai: 'https://openai.test/v1' },
    });
    const output = path.join(directory, 'generated.png');
    const generated = await executeImageGeneration({ prompt: 'a test image', width: 1024, height: 1024, filePath: output });
    assert.equal(generated.success, true);
    assert.equal(generated.provider, 'openai');
    assert.equal(generated.model, 'gpt-image-2');
    assert.deepEqual(await fs.readFile(output), Buffer.from(onePixelPng, 'base64'));
    assert.equal(calls[0], 'https://openai.test/v1/images/generations');
    assert.match(getImageGenerationRouteBrief(), /Active provider: OpenAI/);
    assert.match(getImageGenerationRouteBrief(), /gpt-image-2/);

    let fallbackCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fallbackCalls += 1;
      const url = String(input);
      if (url.includes('openai.test')) return new Response('primary failed', { status: 503, statusText: 'Unavailable' });
      assert.equal(url, 'https://xai.test/v1/images/generations');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer xai-test-key');
      return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200 });
    }) as typeof fetch;
    applyRuntimeImageSettings({
      enabled: true,
      provider: 'openai',
      fallbackProviders: ['xai'],
      modelByProvider: { openai: 'gpt-image-2', xai: 'grok-imagine-image-quality' },
      apiKeys: { openai: ['primary-key'], xai: ['xai-test-key'] },
      baseURLs: { openai: 'https://openai.test/v1', xai: 'https://xai.test/v1' },
    });
    const fallbackOutput = path.join(directory, 'fallback.png');
    const failedOver = await executeImageGeneration({ prompt: 'fallback image', filePath: fallbackOutput });
    assert.equal(failedOver.success, true);
    assert.equal(failedOver.provider, 'xai');
    assert.equal(fallbackCalls, 2);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      assert.equal(String(input), 'https://openrouter.test/api/v1/images');
      return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng }] }), { status: 200 });
    }) as typeof fetch;
    applyRuntimeImageSettings({
      provider: 'openrouter',
      fallbackProviders: [],
      modelByProvider: { openrouter: 'google/gemini-3.1-flash-image' },
      apiKeys: { openrouter: ['router-key'] },
      baseURLs: { openrouter: 'https://openrouter.test/api/v1' },
    });
    const openRouterOutput = path.join(directory, 'openrouter.png');
    const openRouter = await executeImageGeneration({ prompt: 'router image', filePath: openRouterOutput });
    assert.equal(openRouter.success, true);
    assert.equal(openRouter.provider, 'openrouter');

    applyRuntimeImageSettings({
      provider: 'openai',
      fallbackProviders: [],
      modelByProvider: { openai: 'gpt-image-2' },
      apiKeys: { openai: ['test-key'] },
      baseURLs: { openai: 'https://openai.test/v1' },
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), 'https://openai.test/v1/models');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }), { status: 200 });
    }) as typeof fetch;
    const probe = await testImageProvider('openai', 'test-key', 'gpt-image-2');
    assert.equal(probe.model, 'gpt-image-2');

    applyRuntimeImageSettings({ enabled: false });
    const disabled = await executeImageGeneration({ prompt: 'disabled', filePath: path.join(directory, 'disabled.png') });
    assert.equal(disabled.success, false);
    assert.match(disabled.message, /disabled in External service settings/);
    console.log('Image generation runtime integration checks passed.');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
