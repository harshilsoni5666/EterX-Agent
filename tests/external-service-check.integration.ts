import assert from 'node:assert/strict';
import {
  applyRuntimeSearchSettings,
  getRuntimeSearchSettings,
  getSearchRouteBrief,
} from '../src/lib/search/search-runtime';
import {
  applyRuntimeImageSettings,
  getImageGenerationRouteBrief,
  getRuntimeImageSettings,
} from '../src/lib/image/image-generation-runtime';
import {
  applyRuntimeVideoSettings,
  getRuntimeVideoSettings,
  getVideoGenerationRouteBrief,
} from '../src/lib/video/video-generation-runtime';

function assertNoSecret(value: unknown, secret: string): void {
  assert.equal(JSON.stringify(value).includes(secret), false, 'route descriptions must never expose credentials');
}

function run(): void {
  const searchSecret = 'brave-secret-that-must-not-be-returned';
  const imageSecret = 'image-secret-that-must-not-be-returned';
  const videoSecret = 'video-secret-that-must-not-be-returned';

  const searchSettings = applyRuntimeSearchSettings({
    enabled: true,
    provider: 'brave',
    fallbackProviders: ['duckduckgo'],
    apiKeys: { brave: [searchSecret] },
    baseURLs: { brave: 'https://api.search.brave.com/res/v1' },
  });
  assert.equal(searchSettings.provider, 'brave');
  assert.equal(getRuntimeSearchSettings().apiKeys.brave?.[0], searchSecret);
  assert.match(getSearchRouteBrief(), /Active provider: Brave/);
  assertNoSecret(getSearchRouteBrief(), searchSecret);

  const imageSettings = applyRuntimeImageSettings({
    enabled: true,
    provider: 'openai',
    modelByProvider: { openai: 'gpt-image-2' },
    apiKeys: { openai: [imageSecret] },
  });
  assert.equal(imageSettings.provider, 'openai');
  assert.equal(getRuntimeImageSettings().modelByProvider.openai, 'gpt-image-2');
  assert.match(getImageGenerationRouteBrief(), /gpt-image-2/);
  assertNoSecret(getImageGenerationRouteBrief(), imageSecret);

  const videoSettings = applyRuntimeVideoSettings({
    enabled: true,
    provider: 'openai',
    modelByProvider: { openai: 'sora-2' },
    apiKeys: { openai: [videoSecret] },
  });
  assert.equal(videoSettings.provider, 'openai');
  assert.equal(getRuntimeVideoSettings().modelByProvider.openai, 'sora-2');
  assert.match(getVideoGenerationRouteBrief(), /sora-2/);
  assertNoSecret(getVideoGenerationRouteBrief(), videoSecret);

  console.log('External service runtime integration checks passed.');
}

run();
