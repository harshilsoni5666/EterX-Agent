import assert from 'node:assert/strict';
import {
  isParallelSafeToolCall,
  splitLeadingParallelToolCalls,
} from '../src/lib/agent/parallel-tool-calls';

const calls = [
  { name: 'workspace_read_file', args: { filename: 'a.ts' } },
  { name: 'workspace_search_text', args: { pattern: 'parallel' } },
  { name: 'workspace_write_file', args: { filename: 'out.txt' } },
  { name: 'workspace_read_file', args: { filename: 'out.txt' } },
];

assert.equal(isParallelSafeToolCall(calls[0]), true);
assert.equal(isParallelSafeToolCall(calls[1]), true);
assert.equal(isParallelSafeToolCall(calls[2]), false);
assert.equal(isParallelSafeToolCall(calls[3]), true);
assert.equal(isParallelSafeToolCall({
  name: 'workspace_run_command',
  args: { command: 'Get-ChildItem src' },
}), true);
assert.equal(isParallelSafeToolCall({
  name: 'workspace_run_command',
  args: { command: 'npm run build' },
}), false);

const batches = splitLeadingParallelToolCalls(calls);
assert.deepEqual(batches.parallel, calls.slice(0, 2));
assert.deepEqual(batches.ordered, calls.slice(2));

console.log('Parallel tool-call scheduling checks passed.');
