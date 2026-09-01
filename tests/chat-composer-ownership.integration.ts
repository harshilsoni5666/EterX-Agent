import assert from 'node:assert/strict';
import {
  chatComposerStateKey,
  hasOwnedComposerState,
  publishOwnedComposerState,
} from '../src/lib/chat-composer-ownership';

type Controls = {
  model: string;
  thinking: string;
  agent: string | null;
  autonomous: boolean;
};

const alpha: Controls = {
  model: 'openai::gpt-alpha',
  thinking: 'high',
  agent: 'researcher',
  autonomous: true,
};
const beta: Controls = {
  model: 'anthropic::claude-beta',
  thinking: 'low',
  agent: null,
  autonomous: false,
};

let states: Record<string, Controls> = {};
states = publishOwnedComposerState(states, 'chat-alpha', alpha);
states = publishOwnedComposerState(states, 'chat-beta', beta);

assert.deepEqual(states['chat-alpha'], alpha);
assert.deepEqual(states['chat-beta'], beta);
assert.notStrictEqual(states['chat-alpha'], states['chat-beta']);
assert.equal(hasOwnedComposerState(states, 'chat-alpha'), true);
assert.equal(hasOwnedComposerState(states, 'missing-chat'), false);

const betaChanged = { ...beta, model: 'gemini::gemini-beta', thinking: 'medium' };
const next = publishOwnedComposerState(states, 'chat-beta', betaChanged);
assert.deepEqual(next['chat-alpha'], alpha, 'changing chat B must not mutate chat A controls');
assert.deepEqual(next['chat-beta'], betaChanged);

const workerKey = chatComposerStateKey('chat-alpha', 'worker/1');
assert.equal(workerKey, 'chat-alpha::agent-composer::worker%2F1');
assert.equal(hasOwnedComposerState(next, 'chat-alpha', 'worker/1'), false);

console.log('Chat composer ownership integration checks passed.');
