import assert from 'node:assert/strict';
import { getAgentConversationScope, stableScopeSegment } from '../src/lib/agent/context-scope';

const sanitizedCollisionA = stableScopeSegment('chat:a');
const sanitizedCollisionB = stableScopeSegment('chat_a');
assert.notEqual(sanitizedCollisionA, sanitizedCollisionB, 'logical chat IDs must not collide on disk');

const parentContext = { projectId: 'parent-chat' };
assert.equal(getAgentConversationScope(parentContext), 'parent-chat');

const childContext = {
  projectId: 'parent-chat',
  memoryScopeId: 'parent-chat::sub-agent::agent-1',
};
assert.equal(getAgentConversationScope(childContext), childContext.memoryScopeId);
assert.notEqual(
  getAgentConversationScope(childContext),
  getAgentConversationScope(parentContext),
  'a sub-agent must never reuse the parent conversation state namespace',
);

console.log('context scope isolation checks passed');
