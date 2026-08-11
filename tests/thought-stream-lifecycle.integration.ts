import assert from 'node:assert/strict';
import {
  canonicalizeThoughtStreamLogs,
  closeThoughtStreamsForBoundary,
  mergeThoughtStreamTrace,
  shouldRenderThoughtStream,
} from '../src/lib/thought-stream-lifecycle';

const thought = (
  text: string,
  at: number,
  overrides: Record<string, unknown> = {},
) => ({
  type: 'thought_stream',
  text,
  thoughtId: 'thought-1',
  startTime: at,
  endTime: at,
  timestamp: at,
  isStreaming: true,
  ...overrides,
});

{
  assert.equal(
    shouldRenderThoughtStream({
      type: 'thought_stream',
      text: '',
      uiOnly: true,
      isStreaming: false,
      streamState: 'closed',
    }),
    false,
    'closed empty UI-only shells must not render as historical thought cards',
  );
  assert.equal(
    shouldRenderThoughtStream({
      type: 'thought_stream',
      text: '',
      uiOnly: true,
      isStreaming: true,
      streamState: 'open',
    }),
    true,
    'an open UI-only shell should remain available while a direct turn is live',
  );
  assert.equal(
    shouldRenderThoughtStream({ type: 'thought_stream', text: 'Reasoning', isStreaming: false }),
    true,
    'closed thoughts with real text remain visible',
  );
}

{
  const logs: any[] = [];
  mergeThoughtStreamTrace(logs, thought('First', 1_000));
  mergeThoughtStreamTrace(logs, thought('First update', 2_000, { startTime: 1_000 }));

  assert.equal(logs.length, 1, 'chunks from one open stream should update in place');
  assert.equal(logs[0].text, 'First update');
  assert.equal(logs[0].startTime, 1_000, 'the original stream start must remain stable');
  assert.equal(logs[0].endTime, 2_000, 'the stream end should track the latest chunk');
  assert.equal(logs[0].isStreaming, true);
}

{
  const logs: any[] = [];
  mergeThoughtStreamTrace(logs, thought('Before tool', 1_000));
  const tool = { type: 'command', text: 'Run tests', startTime: 3_000, timestamp: 3_000 };
  closeThoughtStreamsForBoundary(logs, tool);
  logs.push(tool);
  mergeThoughtStreamTrace(logs, thought('After tool', 5_000));

  assert.equal(
    logs.filter(log => log.type === 'thought_stream').length,
    2,
    'a tool boundary must split thought streams',
  );
  assert.equal(logs[0].isStreaming, false, 'the pre-tool thought must be closed');
  assert.equal(logs[0].endTime, 3_000, 'the pre-tool timer must freeze at the boundary');
  assert.equal(logs[2].startTime, 5_000, 'the next thought needs its own timer');
}

{
  const logs: any[] = [];
  mergeThoughtStreamTrace(logs, thought('Reasoning', 1_000));
  mergeThoughtStreamTrace(logs, thought('Reasoning complete', 4_000, { isStreaming: false }));
  mergeThoughtStreamTrace(logs, thought('New reasoning with reused id', 8_000));

  assert.equal(logs.length, 2, 'a closed stream must not reopen when a provider reuses its ID');
  assert.equal(logs[0].endTime, 4_000);
  assert.equal(logs[1].startTime, 8_000);
}

{
  // Recovery can hydrate the settled snapshot first, then deliver older live
  // snapshots from the in-memory stream buffer. Those snapshots belong to the
  // same stream and must not reopen duplicate thought cards.
  const logs: any[] = [];
  mergeThoughtStreamTrace(logs, thought('Reasoning complete', 4_000, {
    isStreaming: false,
    streamState: 'closed',
    final: true,
    _traceIdx: 12,
  }));
  mergeThoughtStreamTrace(logs, thought('Reasoning', 2_000, {
    isStreaming: true,
    _traceIdx: 4,
  }));

  assert.equal(logs.length, 1, 'an older replay must update the settled stream in place');
  assert.equal(logs[0].text, 'Reasoning complete');
  assert.equal(logs[0].isStreaming, false, 'an older replay must not reopen the stream');
}

{
  // Canonicalize lists that were persisted by an older client before the
  // replay guard existed. The stream anchor is authoritative; transport
  // indices are delivery records and may differ for every snapshot.
  const logs: any[] = [
    thought('Reasoning complete', 4_000, {
      isStreaming: false,
      streamState: 'closed',
      final: true,
      _traceIdx: 12,
    }),
    thought('Reasoning complete', 4_000, {
      isStreaming: false,
      streamState: 'closed',
      _traceIdx: 7,
    }),
    thought('Reasoning complete', 4_000, {
      isStreaming: false,
      streamState: 'closed',
      _traceIdx: 4,
    }),
  ];
  const originalLogs = logs.slice();
  const canonical = canonicalizeThoughtStreamLogs(logs);

  assert.equal(canonical.length, 1, 'persisted duplicate snapshots should canonicalize to one row');
  assert.equal(canonical[0].text, 'Reasoning complete');
  assert.equal(canonical[0].isStreaming, false);
  assert.deepEqual(logs, originalLogs, 'canonicalization must not mutate a caller-owned trace array');
}

{
  const logs: any[] = [
    { type: 'thought_stream', text: '', uiOnly: true, thoughtId: 'same', runId: 'run-a', startTime: 1_000, isStreaming: false, streamState: 'closed' },
    { type: 'thought_stream', text: '', uiOnly: true, thoughtId: 'same', runId: 'run-b', startTime: 1_000, isStreaming: false, streamState: 'closed' },
  ];
  assert.equal(canonicalizeThoughtStreamLogs(logs).length, 0, 'closed empty UI-only shells should be pruned from canonical history');
}

{
  const logs: any[] = [];
  mergeThoughtStreamTrace(logs, thought('Main reasoning', 1_000));
  mergeThoughtStreamTrace(logs, thought('Worker reasoning', 1_500, {
    thoughtId: 'worker-thought',
    subAgent: 'Researcher',
  }));

  closeThoughtStreamsForBoundary(logs, {
    type: 'command',
    subAgent: 'Researcher',
    text: 'Search',
    startTime: 2_000,
    timestamp: 2_000,
  });

  assert.equal(logs[0].isStreaming, true, 'a worker boundary must not close the main thought');
  assert.equal(logs[1].isStreaming, false, 'a worker boundary must close that worker thought');
}

{
  const logs: any[] = [];
  mergeThoughtStreamTrace(logs, thought('Run A reasoning', 1_000, {
    chatId: 'chat-1',
    runId: 'run-a',
  }));
  mergeThoughtStreamTrace(logs, thought('Run B reasoning', 1_000, {
    chatId: 'chat-1',
    runId: 'run-b',
  }));

  assert.equal(logs.length, 2, 'same thought IDs from different runs must not merge');
  assert.equal(logs[0].text, 'Run A reasoning');
  assert.equal(logs[1].text, 'Run B reasoning');
  assert.equal(logs[0].isStreaming, true, 'a new run must not close the previous run implicitly');
}

{
  const logs: any[] = [
    thought('Run A reasoning', 1_000, { chatId: 'chat-1', runId: 'run-a' }),
    thought('Run B reasoning', 2_000, { chatId: 'chat-1', runId: 'run-b' }),
  ];
  closeThoughtStreamsForBoundary(logs, {
    type: 'run_status',
    status: 'failed',
    chatId: 'chat-1',
    runId: 'run-b',
    timestamp: 3_000,
  });

  assert.equal(logs[0].isStreaming, true, 'a terminal event must not close a thought from another run');
  assert.equal(logs[1].isStreaming, false, 'the matching run thought must close at its terminal event');
}

{
  const logs: any[] = [];
  mergeThoughtStreamTrace(logs, thought('Main reasoning', 1_000));
  mergeThoughtStreamTrace(logs, thought('Worker reasoning', 1_500, {
    thoughtId: 'worker-thought',
    subAgent: 'Researcher',
  }));
  closeThoughtStreamsForBoundary(logs, {
    type: 'run_status',
    status: 'failed',
    timestamp: 6_000,
  });

  assert.ok(logs.every(log => log.isStreaming === false), 'a terminal run event must close every thought');
  assert.ok(logs.every(log => log.endTime === 6_000), 'all timers must freeze at the terminal boundary');
}

{
  const logs: any[] = [];
  mergeThoughtStreamTrace(logs, thought('Reasoning', 1_000));
  closeThoughtStreamsForBoundary(logs, {
    type: 'answer',
    text: 'Final answer',
    startTime: 2_500,
    timestamp: 2_500,
  });

  assert.equal(logs[0].isStreaming, false, 'visible answer text must close reasoning immediately');
  assert.equal(logs[0].endTime, 2_500);
}

{
  const logs: any[] = [];
  mergeThoughtStreamTrace(logs, thought('Reasoning', 1_000));
  const answer = {
    type: 'answer',
    text: 'Visible answer',
    startTime: 2_500,
    timestamp: 2_500,
  };
  closeThoughtStreamsForBoundary(logs, answer);
  logs.push(answer);
  mergeThoughtStreamTrace(logs, thought('Reasoning complete', 4_000, { isStreaming: false }));

  assert.equal(
    logs.filter(log => log.type === 'thought_stream').length,
    1,
    'a late provider close must not create a duplicate thought after the answer starts',
  );
  assert.equal(logs[0].endTime, 2_500, 'a late close must not count answer time as reasoning');
  assert.equal(logs[0].text, 'Reasoning complete', 'the final reasoning payload should still be retained');
}

console.log('Thought stream lifecycle integration checks passed.');
