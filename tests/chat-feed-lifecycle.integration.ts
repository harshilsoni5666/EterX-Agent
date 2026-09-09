import assert from 'node:assert/strict';
import {
  agentIdentitiesOverlap,
  isInternalProgressNoise,
  isInternalWorkNoteNoise,
  isTerminalWorkTrace,
  isTurnWorkActive,
  orderFeedTimelineLogs,
  shouldRenderContextCompactionEvent,
  shouldRenderProgressTrace,
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
assert.equal(
  isInternalProgressNoise('Processed 3 tool calls (iteration 2/20)'),
  true,
  'tool-loop telemetry must not become a visible feed row',
);
assert.equal(
  isInternalProgressNoise('X poster is thinking...'),
  true,
  'the initial thinking status must not duplicate the live work pill',
);
assert.equal(
  shouldRenderProgressTrace({ type: 'progress', text: 'Processed 3 tool calls (iteration 2/20)' }),
  false,
  'internal progress telemetry must be filtered from the feed',
);
assert.equal(
  shouldRenderProgressTrace({ type: 'work_note', text: 'X poster processed 3 tool calls (iteration 2/20)' }),
  false,
  'builder status notes must use the same telemetry filter',
);
assert.equal(
  shouldRenderProgressTrace({ type: 'progress', text: 'Rotating API key' }),
  true,
  'meaningful progress remains visible',
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
const failedCompaction = { type: 'context_compaction', phase: 'failed', compactionId: 'ctx-b' };
assert.equal(
  shouldRenderContextCompactionEvent(compacting, 0, [compacting], true),
  false,
  'the active compaction start stays in the context meter, not the transcript',
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
assert.equal(
  shouldRenderContextCompactionEvent(failedCompaction, 0, [failedCompaction], false),
  false,
  'a failed compaction stays in the context meter, not the transcript',
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

{
  // A normal Send is first mounted locally and can accumulate live work before
  // a delayed full task snapshot repeats the same canonical trace-zero user
  // event. The snapshot must replace that stale prefix rather than create a
  // second Working group for the first (and only) request.
  const eventId = 'user-turn-normal-run';
  const ordered = orderFeedTimelineLogs([
    {
      type: 'user_action', text: 'Build the report', ownerChatId: 'chat',
      runId: 'normal-run', turnId: 'normal-run', id: eventId, startTime: 1000,
    },
    {
      type: 'work_note', text: 'Stale optimistic note', ownerChatId: 'chat',
      runId: 'normal-run', turnId: 'normal-run', noteId: 'work-1', _traceIdx: 8,
    },
    {
      type: 'user_action', text: 'Build the report', ownerChatId: 'chat',
      runId: 'normal-run', turnId: 'normal-run', id: eventId, startTime: 1000,
      timestamp: 1200, _traceIdx: 0, _originTraceIdx: 0,
    },
    {
      type: 'thought_stream', text: 'Authoritative thought', ownerChatId: 'chat',
      runId: 'normal-run', turnId: 'normal-run', _traceIdx: 3,
    },
    {
      type: 'work_note', text: 'Authoritative note', ownerChatId: 'chat',
      runId: 'normal-run', turnId: 'normal-run', noteId: 'work-1', _traceIdx: 8,
    },
    {
      type: 'command', text: 'Authoritative command', ownerChatId: 'chat',
      runId: 'normal-run', turnId: 'normal-run', toolCallId: 'tool-1', _traceIdx: 12,
    },
  ]);

  assert.deepEqual(
    ordered.map(log => log.text),
    ['Build the report', 'Authoritative thought', 'Authoritative note', 'Authoritative command'],
    'the canonical normal-query snapshot must replace its optimistic partial prefix',
  );
  assert.equal(
    ordered.filter(log => log.type === 'user_action').length,
    1,
    'one normal query must mount exactly one user boundary',
  );
  assert.ok(
    ordered.every(log => log._feedBoundaryId === ordered[0]._feedBoundaryId),
    'all canonical work must remain inside the surviving query group',
  );
}

{
  // Some long-lived providers recycle every local identity on the next Send,
  // including a boundary that an older client already stamped. Trace position
  // must still keep the two work-note/action lifecycles in separate requests.
  const reusedBoundaryId = 'feed-boundary:chat:user:reused-turn';
  const ordered = orderFeedTimelineLogs([
    {
      type: 'user_action', text: 'First request', ownerChatId: 'chat', runId: 'run-proxy',
      turnId: 'reused-turn', id: 'reused-turn', _feedBoundaryId: reusedBoundaryId, _traceIdx: 0,
    },
    {
      type: 'work_note', text: 'Inspecting the workspace', ownerChatId: 'chat', runId: 'run-proxy',
      turnId: 'reused-turn', noteId: 'provider-note-1', _feedBoundaryId: reusedBoundaryId, _traceIdx: 1,
    },
    {
      type: 'command', text: 'First command', ownerChatId: 'chat', runId: 'run-proxy',
      turnId: 'reused-turn', toolCallId: 'provider-tool-1', _feedBoundaryId: reusedBoundaryId, _traceIdx: 2,
    },
    {
      type: 'user_action', text: 'Second request', ownerChatId: 'chat', runId: 'run-proxy',
      turnId: 'reused-turn', id: 'reused-turn', _feedBoundaryId: reusedBoundaryId, _traceIdx: 3,
    },
    {
      type: 'work_note', text: 'Inspecting the workspace', ownerChatId: 'chat', runId: 'run-proxy',
      turnId: 'reused-turn', noteId: 'provider-note-1', _traceIdx: 4,
    },
    {
      type: 'command', text: 'Second command', ownerChatId: 'chat', runId: 'run-proxy',
      turnId: 'reused-turn', toolCallId: 'provider-tool-1', _traceIdx: 5,
    },
  ]);

  assert.deepEqual(
    ordered.map(log => log.text),
    [
      'First request', 'Inspecting the workspace', 'First command',
      'Second request', 'Inspecting the workspace', 'Second command',
    ],
    'recycled boundary and event IDs must not mix successive Proxy queries',
  );
  const firstBoundaryId = ordered[0]._feedBoundaryId;
  const secondBoundaryId = ordered[3]._feedBoundaryId;
  assert.notEqual(firstBoundaryId, secondBoundaryId, 'each surviving query needs a unique feed boundary');
  assert.equal(ordered[1]._feedBoundaryId, firstBoundaryId);
  assert.equal(ordered[2]._feedBoundaryId, firstBoundaryId);
  assert.equal(ordered[4]._feedBoundaryId, secondBoundaryId);
  assert.equal(ordered[5]._feedBoundaryId, secondBoundaryId);
}

console.log('Chat feed lifecycle integration checks passed.');
