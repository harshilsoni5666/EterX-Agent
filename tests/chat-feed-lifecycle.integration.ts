import assert from 'node:assert/strict';
import { isTerminalWorkTrace, isTurnWorkActive } from '../src/lib/chat-feed-lifecycle';

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

console.log('Chat feed lifecycle integration checks passed.');
