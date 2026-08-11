import assert from 'node:assert/strict';
import {
  extractProviderText,
  isStreamFinalEvent,
  mergeStreamingText,
  normalizeStreamTimestamp,
} from '../src/lib/streaming-lifecycle';

assert.equal(
  mergeStreamingText('', 'Hel', true),
  'Hel',
  'the first live delta should establish the answer',
);
assert.equal(
  mergeStreamingText('Hel', 'Hello', true),
  'Hello',
  'a cumulative provider snapshot must not duplicate the existing prefix',
);
assert.equal(
  mergeStreamingText('Hello', 'Hel', true),
  'Hello',
  'a late shorter snapshot must not roll the answer backwards',
);
assert.equal(
  mergeStreamingText('Hello', ' world', true),
  'Hello world',
  'a real delta should append even when it starts with a repeated boundary character',
);
assert.equal(
  extractProviderText({ content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }),
  'AB',
  'provider content arrays should flatten into answer text',
);
assert.equal(extractProviderText([{ text: 'A' }, { content: 'B' }]), 'AB');
assert.equal(isStreamFinalEvent({ streamState: 'closed' }), true);
assert.equal(isStreamFinalEvent({ isStreaming: true }), false);

const normalizedSeconds = normalizeStreamTimestamp(1_700_000_000);
assert.ok(normalizedSeconds > 1_000_000_000_000, 'second-based provider timestamps should normalize to milliseconds');
assert.equal(normalizeStreamTimestamp('not-a-time', 1234), 1234);

console.log('Streaming lifecycle integration checks passed.');
