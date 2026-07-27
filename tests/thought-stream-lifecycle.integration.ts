import assert from 'node:assert/strict';
import {
  closeThoughtStreamsForBoundary,
  mergeThoughtStreamTrace,
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
