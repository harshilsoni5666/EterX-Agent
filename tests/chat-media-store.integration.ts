import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-chat-media-'));
  process.env.ETERX_DATA_DIR = testRoot;

  const {
    getChatMediaReferencePattern,
    removeChatMedia,
    resolveChatMediaForRequest,
  } = await import('../src/lib/chat-media-store');

  const chatId = 'chat-media-regression';
  const firstSource = path.join(testRoot, 'first.png');
  const secondSource = path.join(testRoot, 'second.png');
  await fs.writeFile(firstSource, Buffer.from('first-image'));
  await fs.writeFile(secondSource, Buffer.from('second-image'));

  try {
    const initial = await resolveChatMediaForRequest(chatId, 'Please inspect this image.', [{
      id: 'image-one',
      name: 'first.png',
      mimeType: 'image/png',
      path: firstSource,
    }]);
    assert.deepEqual(initial.map(item => item.id), ['image-one']);

    const ordinaryFollowUp = await resolveChatMediaForRequest(chatId, 'It is still not working. Please fix it.');
    assert.deepEqual(
      ordinaryFollowUp,
      [],
      'a text-only follow-up must not automatically reattach stored media',
    );

    const explicitRecall = await resolveChatMediaForRequest(chatId, 'Look at the previous image again.');
    assert.deepEqual(
      explicitRecall.map(item => item.id),
      ['image-one'],
      'an explicit prior-media request should still be able to recall the durable upload',
    );

    const nextUpload = await resolveChatMediaForRequest(chatId, 'Inspect this image.', [{
      id: 'image-two',
      name: 'second.png',
      mimeType: 'image/png',
      path: secondSource,
    }]);
    assert.deepEqual(
      nextUpload.map(item => item.id),
      ['image-two'],
      'a new upload must not pull older chat media into the same provider request',
    );
    const comparison = await resolveChatMediaForRequest(chatId, 'Compare this image with the previous image.', [{
      id: 'image-two',
      name: 'second.png',
      mimeType: 'image/png',
      path: secondSource,
    }]);
    assert.deepEqual(comparison.map(item => item.id), ['image-two', 'image-one'],
      'an explicit comparison must include the prior image alongside the new upload');

    const referencePattern = getChatMediaReferencePattern();
    assert.equal(referencePattern.test('Can you fix it now?'), false);
    assert.equal(referencePattern.test('Please inspect the earlier screenshot.'), true);
  } finally {
    await removeChatMedia([chatId]);
    await fs.remove(testRoot);
  }

  console.log('Chat media store integration checks passed.');
}

void main();
