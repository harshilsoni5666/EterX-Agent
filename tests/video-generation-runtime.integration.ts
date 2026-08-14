import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertVideo,
  applyRuntimeVideoSettings,
  executeVideoGeneration,
  getVideoGenerationRouteBrief,
  testVideoProvider,
} from '../src/lib/video/video-generation-runtime';
import { VIDEO_PROVIDER_IDS, VIDEO_PROVIDER_META, normalizeVideoSettings } from '../src/lib/video/video-generation-config';

const originalFetch = globalThis.fetch;
const mp4 = Buffer.from('0000ftypisom-real-video-bytes');

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const media = () => new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } });

async function run() {
  assert.deepEqual(VIDEO_PROVIDER_IDS, ['google', 'openai', 'runway', 'luma', 'minimax', 'volcengine', 'fal', 'replicate', 'xai']);
  assert.equal(VIDEO_PROVIDER_META.xai.defaultModel, 'grok-imagine-video');
  assert.equal(VIDEO_PROVIDER_META.minimax.defaultModel, 'MiniMax-H3');
  assert.equal(VIDEO_PROVIDER_META.volcengine.defaultModel, 'doubao-seedance-1-0-pro-250528');
  const custom = normalizeVideoSettings({ provider: 'replicate', modelByProvider: { replicate: 'wan-video/custom-current-model' } });
  assert.equal(custom.modelByProvider.replicate, 'wan-video/custom-current-model');
  assertVideo(mp4);
  assert.throws(() => assertVideo(Buffer.from('not-video')));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-video-test-'));
  try {
    applyRuntimeVideoSettings({ enabled: true, provider: 'openai', fallbackProviders: [], modelByProvider: { openai: 'sora-2' }, apiKeys: { openai: ['openai-test-key'] } });
    const calls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || 'GET'} ${url}`);
      if (url.endsWith('/videos') && init?.method === 'POST') return json({ id: 'video_test_1', status: 'queued' });
      if (url.endsWith('/videos/video_test_1')) return json({ id: 'video_test_1', status: 'completed' });
      if (url.endsWith('/videos/video_test_1/content')) return media();
      throw new Error(`Unexpected mocked request: ${url}`);
    };
    const generatedPath = path.join(tempDir, 'sora.mp4');
    const result = await executeVideoGeneration({ prompt: 'A calm paper boat crossing a sunlit stream', filePath: generatedPath, width: 1280, height: 720, duration: 5 });
    assert.equal(result.success, true);
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'sora-2');
    assert.deepEqual(await fs.readFile(generatedPath), mp4);
    assert.ok(calls.some(call => call.includes('POST https://api.openai.com/v1/videos')));
    assert.ok(calls.some(call => call.includes('/content')));

    applyRuntimeVideoSettings({ enabled: true, provider: 'openai', fallbackProviders: ['xai'], modelByProvider: { openai: 'sora-2', xai: 'grok-imagine-video' }, apiKeys: { xai: ['xai-test-key'] } });
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.openai.com')) return json({ error: { message: 'no OpenAI key' } }, 401);
      if (url.endsWith('/videos/generations')) return json({ request_id: 'xai_test_1' });
      if (url.endsWith('/videos/xai_test_1')) return json({ status: 'done', video: { url: 'https://media.example/video.mp4' } });
      if (url === 'https://media.example/video.mp4') return media();
      throw new Error(`Unexpected fallback request: ${url} ${init?.method || 'GET'}`);
    };
    const fallback = await executeVideoGeneration({ prompt: 'A red kite above a quiet field', filePath: path.join(tempDir, 'grok.mp4') });
    assert.equal(fallback.success, true);
    assert.equal(fallback.provider, 'xai');

    applyRuntimeVideoSettings({ enabled: true, provider: 'minimax', fallbackProviders: [], modelByProvider: { minimax: 'MiniMax-H3' }, apiKeys: { minimax: ['minimax-test-key'] } });
    const minimaxCalls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      minimaxCalls.push(`${init?.method || 'GET'} ${url}`);
      if (url.endsWith('/v2/video_generation')) return json({ task_id: 'mini_test_1' });
      if (url.endsWith('/v2/query/video_generation/mini_test_1')) return json({ task: { status: 'Success', content: { url: 'https://media.example/mini.mp4' } } });
      if (url === 'https://media.example/mini.mp4') return media();
      throw new Error(`Unexpected MiniMax request: ${url}`);
    };
    const mini = await executeVideoGeneration({ prompt: 'A silver train entering a mountain station', filePath: path.join(tempDir, 'mini.mp4') });
    assert.equal(mini.success, true);
    assert.equal(mini.provider, 'minimax');
    assert.ok(minimaxCalls.some(call => call.includes('/v2/video_generation')));

    applyRuntimeVideoSettings({ enabled: true, provider: 'minimax', fallbackProviders: [], modelByProvider: { minimax: 'MiniMax-Hailuo-2.3' }, apiKeys: { minimax: ['minimax-test-key'] } });
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/video_generation') && init?.method === 'POST') return json({ task_id: 'hailuo_test_1' });
      if (url.includes('/v1/query/video_generation?task_id=hailuo_test_1')) return json({ task_id: 'hailuo_test_1', status: 'Success', file_id: 'hailuo_file_1' });
      if (url.includes('/v1/files/retrieve?file_id=hailuo_file_1')) return json({ file: { download_url: 'https://media.example/hailuo.mp4' } });
      if (url === 'https://media.example/hailuo.mp4') return media();
      throw new Error(`Unexpected Hailuo request: ${url}`);
    };
    const hailuo = await executeVideoGeneration({ prompt: 'A blue train crossing a bridge', filePath: path.join(tempDir, 'hailuo.mp4') });
    assert.equal(hailuo.success, true);
    assert.equal(hailuo.model, 'MiniMax-Hailuo-2.3');

    applyRuntimeVideoSettings({ enabled: true, provider: 'luma', fallbackProviders: [], modelByProvider: { luma: 'ray-2' }, apiKeys: { luma: ['luma-test-key'] } });
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/generations/video') && init?.method === 'POST') return json({ id: 'luma_test_1' });
      if (url.endsWith('/generations/luma_test_1')) return json({ id: 'luma_test_1', state: 'completed', assets: { video: { url: 'https://media.example/luma.mp4' } } });
      if (url === 'https://media.example/luma.mp4') return media();
      throw new Error(`Unexpected Luma request: ${url}`);
    };
    const luma = await executeVideoGeneration({ prompt: 'A red kite over a lake', filePath: path.join(tempDir, 'luma.mp4') });
    assert.equal(luma.success, true);
    assert.equal(luma.provider, 'luma');

    applyRuntimeVideoSettings({ enabled: true, provider: 'fal', fallbackProviders: [], modelByProvider: { fal: 'fal-ai/wan-25-preview/text-to-video' }, apiKeys: { fal: ['fal-test-key'] } });
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/fal-ai/wan-25-preview/image-to-video') && init?.method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        assert.equal(body.image_url, 'https://images.example/start.png');
        assert.equal(body.duration, '5');
        assert.equal(body.resolution, '1080p');
        return json({ video: { url: 'https://media.example/fal.mp4' } });
      }
      if (url === 'https://media.example/fal.mp4') return media();
      throw new Error(`Unexpected FAL request: ${url}`);
    };
    const fal = await executeVideoGeneration({ prompt: 'Animate the first frame', imageUrl: 'https://images.example/start.png', filePath: path.join(tempDir, 'fal.mp4'), width: 1280, height: 720, duration: 5 });
    assert.equal(fal.success, true);
    assert.equal(fal.provider, 'fal');

    applyRuntimeVideoSettings({ enabled: true, provider: 'volcengine', fallbackProviders: [], modelByProvider: { volcengine: 'doubao-seedance-1-0-pro-250528' }, apiKeys: { volcengine: ['ark-test-key'] } });
    const arkCalls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      arkCalls.push(`${init?.method || 'GET'} ${url}`);
      if (url.endsWith('/contents/generations/tasks') && init?.method === 'POST') return json({ id: 'ark_test_1' });
      if (url.endsWith('/contents/generations/tasks/ark_test_1')) return json({ status: 'succeeded', content: { url: 'https://media.example/ark.mp4' } });
      if (url === 'https://media.example/ark.mp4') return media();
      throw new Error(`Unexpected Volcengine request: ${url}`);
    };
    const ark = await executeVideoGeneration({ prompt: 'A warm sunset over a futuristic city', filePath: path.join(tempDir, 'seedance.mp4') });
    assert.equal(ark.success, true);
    assert.equal(ark.provider, 'volcengine');
    assert.equal(ark.model, 'doubao-seedance-1-0-pro-250528');
    assert.ok(arkCalls.some(call => call.includes('/contents/generations/tasks')));

    const brief = getVideoGenerationRouteBrief();
    assert.match(brief, /ByteDance Seedance/);
    assert.equal(VIDEO_PROVIDER_META.minimax.label, 'MiniMax Hailuo');
    assert.match(brief, /video_generator/);

    globalThis.fetch = async () => json({ models: [{ id: 'grok-imagine-video' }] });
    const probe = await testVideoProvider('xai', 'xai-test-key', 'grok-imagine-video');
    assert.equal(probe.model, 'grok-imagine-video');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  }
}

void run().then(() => console.log('Video generation runtime integration checks passed.')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
