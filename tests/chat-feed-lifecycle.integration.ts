import assert from 'node:assert/strict';
import {
  agentIdentitiesOverlap,
  isInternalWorkNoteNoise,
  isTerminalWorkTrace,
  isTurnWorkActive,
  orderFeedTimelineLogs,
  shouldRenderContextCompactionEvent,
  shouldShowWorkflowSequence,
} from '../src/lib/chat-feed-lifecycle';

assert.equal(
  agentIdentitiesOverlap(
    { id: 'chat-a::sub-agent::worker-7', name: 'Researcher' },
    { subAgentId: 'worker-7', agentName: 'Researcher' },
  ),
  true,
  'full child-chat IDs and short sub-agent IDs must route to the same tab',
);

assert.equal(
  agentIdentitiesOverlap(
    { subAgentId: 'worker-old', agentName: 'Researcher' },
    { subAgentId: 'worker-new', agentName: 'Researcher' },
  ),
  false,
  'reused display names must not merge distinct worker runs',
);

assert.equal(
  agentIdentitiesOverlap(
    { agentName: 'Legacy Worker', subAgent: 'Legacy Worker' },
    'legacy worker',
  ),
  true,
  'legacy name-only traces must remain selectable',
);

assert.equal(
  agentIdentitiesOverlap(
    { id: 'comm-event-42', type: 'inter_agent_message', agentName: 'Legacy Worker' },
    { id: 'legacy-worker-tab', name: 'Legacy Worker' },
  ),
  true,
  'event IDs must not be mistaken for exact worker-run IDs',
);

assert.equal(
  isInternalWorkNoteNoise('I will inspect the relevant files.'),
  false,
  'natural first-person intent must remain visible as a work note',
);
assert.equal(
  isInternalWorkNoteNoise('I am following the work note communication style for this workspace.'),
  true,
  'protocol commentary must remain hidden',
);

const action = { type: 'command', text: 'Running tests' };

assert.equal(shouldShowWorkflowSequence(0), false, 'a simple send must not show an empty work sequence');
assert.equal(shouldShowWorkflowSequence(1), true, 'the first real action should reveal the work sequence');
assert.equal(shouldShowWorkflowSequence(2), true, 'later actions should keep the work sequence visible');

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

assert.equal(
  isTerminalWorkTrace({ type: 'thought', subAgent: 'Researcher', text: 'Agent stopped: provider failed' }),
  false,
  'terminal-looking worker text must not stop the main turn counter',
);

assert.equal(
  isTerminalWorkTrace({ type: 'thought', agentName: 'Worker', text: 'Generation stopped by user.' }),
  false,
  'terminal-looking delegated text must remain scoped to its worker',
);

assert.equal(
  isTerminalWorkTrace({ type: 'work_note', subAgent: 'Researcher', text: 'Agent stopped: provider failed' }),
  false,
  'terminal-looking delegated work-note text must not stop the main turn counter',
);

assert.equal(
  isTerminalWorkTrace({ type: 'agent_status', status: 'failed', agentName: 'Main' }),
  true,
  'explicit Main terminal status should remain terminal even when agentName is present',
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

{
  // Polling may deliver a previous run's action after the newer run has
  // already painted. It must be restored to its owning user turn.
  const ordered = orderFeedTimelineLogs([
    { type: 'user_action', text: 'First request', runId: 'run-a', turnId: 'run-a', _traceIdx: 0, timestamp: 1000 },
    { type: 'command', text: 'First answer-building action', runId: 'run-a', turnId: 'run-a', _traceIdx: 1 },
    { type: 'user_action', text: 'Second request', runId: 'run-b', turnId: 'run-b', _traceIdx: 0, timestamp: 2000 },
    { type: 'answer', text: 'Second answer', runId: 'run-b', turnId: 'run-b', _traceIdx: 1 },
    { type: 'command', text: 'Late first action', runId: 'run-a', _traceIdx: 2, timestamp: 1500 },
  ]);

  assert.deepEqual(
    ordered.map(log => log.text),
    ['First request', 'First answer-building action', 'Late first action', 'Second request', 'Second answer'],
    'late traces must not be interleaved into a newer answer turn',
  );

  const withLateBoundary = orderFeedTimelineLogs([
    { type: 'user_action', text: 'Newer request', runId: 'run-new', turnId: 'run-new', timestamp: 2000 },
    { type: 'answer', text: 'Newer answer', runId: 'run-new', turnId: 'run-new', timestamp: 2100 },
    { type: 'user_action', text: 'Delayed older request', runId: 'run-old', turnId: 'run-old', timestamp: 1000 },
    { type: 'command', text: 'Older action', runId: 'run-old', turnId: 'run-old', timestamp: 1100 },
  ]);

  assert.deepEqual(
    withLateBoundary.map(log => log.text),
    ['Delayed older request', 'Older action', 'Newer request', 'Newer answer'],
    'a delayed user boundary must not create a new turn after the current answer',
  );
}

{
  const ordered = orderFeedTimelineLogs([
    { type: 'user_action', text: 'Proxy request one', runId: 'run-proxy', turnId: 'run-proxy', _traceIdx: 0 },
    { type: 'user_action', text: 'Proxy request two', runId: 'run-proxy', turnId: 'run-proxy', _traceIdx: 3 },
    { type: 'command', text: 'Second request action', runId: 'run-proxy', turnId: 'run-proxy', _traceIdx: 4 },
    { type: 'command', text: 'Late first request action', runId: 'run-proxy', turnId: 'run-proxy', _traceIdx: 1 },
  ]);

  assert.deepEqual(
    ordered.map(log => log.text),
    ['Proxy request one', 'Late first request action', 'Proxy request two', 'Second request action'],
    'reused Proxy turn IDs must still route late events by their trace position',
  );
}

{
  // A single run can contain multiple Proxy user boundaries. When no explicit
  // turn ID is present, the monotonic trace index selects the correct boundary.
  const ordered = orderFeedTimelineLogs([
    { type: 'user_action', text: 'Proxy request one', runId: 'run-proxy', _traceIdx: 0 },
    { type: 'user_action', text: 'Proxy request two', runId: 'run-proxy', _traceIdx: 3 },
    { type: 'command', text: 'Second request action', runId: 'run-proxy', _traceIdx: 4 },
    { type: 'command', text: 'First request action', runId: 'run-proxy', _traceIdx: 1 },
  ]);

  assert.deepEqual(
    ordered.map(log => log.text),
    ['Proxy request one', 'First request action', 'Proxy request two', 'Second request action'],
    'same-run Proxy boundaries must keep their own action sequences',
  );
}

console.log('Chat feed lifecycle integration checks passed.');
