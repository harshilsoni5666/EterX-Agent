import assert from 'node:assert/strict';
import {
  isTerminalWorkTrace,
  isTurnWorkActive,
  shouldRenderContextCompactionEvent,
} from '../src/lib/chat-feed-lifecycle';

const action = { type: 'command', text: 'Running tests' };

assert.equal(isTurnWorkActive(true, false, [action]), true, 'an active turn should keep timing');
assert.equal(isTurnWorkActive(false, false, [action]), false, 'a cleared running flag should stop timing');
assert.equal(isTurnWorkActive(true, true, [action]), false, 'a final answer should beat a stale running flag');

assert.equal(
  isTurnWorkActive(true, false, [
    action,
    { type: 'thought', text: 'Generation stopped by user.' },
    { type: 'work_note', text: 'Cleaning up resources' },
  ]),
  false,
  'a late cleanup trace must not restart timing after a stop',
);

assert.equal(
  isTurnWorkActive(true, false, [
    action,
    { type: 'thought', status: 'failed', text: 'Agent stopped: provider failed' },
    { type: 'console_output', text: 'process closed' },
  ]),
  false,
  'a failure should remain terminal when traces arrive out of order',
);

assert.equal(
  isTerminalWorkTrace({ type: 'thought', text: 'Could not stop the agent: network error' }),
  false,
  'a rejected stop request must not pretend the still-running agent stopped',
);

assert.equal(
  isTerminalWorkTrace({ type: 'error', subAgent: 'Researcher', text: 'Recoverable worker error' }),
  false,
  'a sub-agent error must not stop the main turn counter',
);

assert.equal(
  isTerminalWorkTrace({ type: 'tool_error', status: 'error', text: 'Command failed; agent will recover' }),
  false,
  'a recoverable tool error must not stop the main turn counter',
);

assert.equal(
  isTerminalWorkTrace({ type: 'agent_status', status: 'failed', text: 'No API key is available' }),
  true,
  'a structured main-run failure should stop the counter',
);

assert.equal(
  isTerminalWorkTrace({ type: 'done' }),
  true,
  'a main-agent done trace should be terminal',
);

const compacting = { type: 'context_compaction', phase: 'compacting', compactionId: 'ctx-a' };
const compacted = { type: 'context_compaction', phase: 'compacted', compactionId: 'ctx-a' };
assert.equal(
  shouldRenderContextCompactionEvent(compacting, 0, [compacting], true),
  true,
  'the active compaction start should be visible',
);
assert.equal(
  shouldRenderContextCompactionEvent(compacting, 0, [compacting, action], true),
  false,
  'an orphaned start must disappear after later real work',
);
assert.equal(
  shouldRenderContextCompactionEvent(compacting, 0, [compacting], false),
  false,
  'an unfinished historical start must not remain visible',
);
assert.equal(
  shouldRenderContextCompactionEvent(compacting, 0, [compacting, compacted], true),
  false,
  'the start phase must be replaced by its terminal phase',
);
assert.equal(
  shouldRenderContextCompactionEvent(compacted, 1, [compacting, compacted], false),
  true,
  'a completed compaction remains as the single settled lifecycle row',
);

console.log('Chat feed lifecycle integration checks passed.');
