import assert from 'node:assert/strict';
import { resolveChatSendTarget } from '../src/lib/chat-send-lifecycle';

let nextId = 0;
const createId = () => `fresh-chat-${++nextId}`;

const firstFreshSend = resolveChatSendTarget(undefined, null, createId);
const secondFreshSend = resolveChatSendTarget(undefined, null, createId);

assert.equal(firstFreshSend.fromFreshComposer, true);
assert.equal(secondFreshSend.fromFreshComposer, true);
assert.notEqual(
  firstFreshSend.chatId,
  secondFreshSend.chatId,
  'independent New chat sends must never share an in-flight admission identity',
);

assert.deepEqual(
  resolveChatSendTarget(undefined, 'active-chat', createId),
  { chatId: 'active-chat', hasExplicitTarget: false, fromFreshComposer: false },
  'an existing visible chat must keep its stable identity',
);

assert.deepEqual(
  resolveChatSendTarget('background-chat', 'active-chat', createId),
  { chatId: 'background-chat', hasExplicitTarget: true, fromFreshComposer: false },
  'an explicit background target must take precedence over the visible chat',
);

assert.equal(
  resolveChatSendTarget('   ', null, createId).fromFreshComposer,
  true,
  'a blank override must not turn a fresh visible send into a missing background target',
);

console.log('Chat send lifecycle integration checks passed.');
