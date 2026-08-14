import assert from 'node:assert/strict';
import {
  chatAgentSelectionsEqual,
  findActiveRunAgentSelection,
  GENERAL_AGENT_SELECTION,
  normalizeChatAgentSelection,
  shouldQueueForAgentSwitch,
} from '../src/lib/chat-agent-selection';

assert.deepEqual(normalizeChatAgentSelection(null), GENERAL_AGENT_SELECTION);
assert.equal(
  chatAgentSelectionsEqual({ agentId: null, agentName: 'Anything' }, GENERAL_AGENT_SELECTION),
  true,
  'General identity must be based on routing fields rather than a stale label',
);
assert.equal(
  chatAgentSelectionsEqual(
    { agentId: 'eterx-agent-1', agentName: 'Ernal' },
    GENERAL_AGENT_SELECTION,
  ),
  false,
  'switching from a custom agent to General must be treated as a runtime change',
);

const customRun = findActiveRunAgentSelection([
  {
    type: 'user_action',
    text: 'First task',
    runId: 'run-custom',
    selectedAgentId: 'eterx-agent-1',
    selectedAgentName: 'Ernal',
    chatMode: false,
  },
], 'run-custom');
assert.deepEqual(customRun, {
  agentId: 'eterx-agent-1',
  agentName: 'Ernal',
  chatMode: false,
});
assert.equal(chatAgentSelectionsEqual(customRun, GENERAL_AGENT_SELECTION), false);
assert.equal(
  shouldQueueForAgentSwitch([
    {
      type: 'user_action',
      runId: 'run-custom',
      selectedAgentId: 'eterx-agent-1',
      selectedAgentName: 'Ernal',
    },
  ], 'run-custom', GENERAL_AGENT_SELECTION),
  true,
  'a General message must wait for a running custom agent instead of being steered into it',
);
assert.equal(
  shouldQueueForAgentSwitch([
    {
      type: 'user_action',
      runId: 'run-general',
      selectedAgentId: null,
      selectedAgentName: 'General',
    },
  ], 'run-general', GENERAL_AGENT_SELECTION),
  false,
  'same-agent follow-ups may keep the existing steer/queue behavior',
);
assert.equal(
  shouldQueueForAgentSwitch([
    {
      type: 'user_action',
      runId: 'run-autonomous',
      selectedAgentId: 'autonomous',
      selectedAgentName: 'Autonomous',
    },
  ], 'run-autonomous', GENERAL_AGENT_SELECTION),
  true,
  'switching from Autonomous to General must start a distinct next turn',
);
assert.equal(
  shouldQueueForAgentSwitch([
    {
      type: 'user_action',
      runId: 'run-general',
      selectedAgentId: null,
      selectedAgentName: 'General',
    },
  ], 'run-general', { agentId: 'autonomous', agentName: 'Autonomous' }),
  true,
  'switching from General to Autonomous must not steer the General runtime',
);

assert.deepEqual(
  findActiveRunAgentSelection([
    { type: 'thought', runId: 'legacy-run', customAgentId: 'legacy-agent', agentName: 'Legacy' },
  ], 'legacy-run'),
  { agentId: 'legacy-agent', agentName: 'Legacy', chatMode: false },
  'rehydrated legacy custom-agent traces must retain their runtime identity',
);

console.log('Chat agent selection integration checks passed.');
