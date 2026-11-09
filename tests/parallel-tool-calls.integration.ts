import assert from 'node:assert/strict';
import {
  isParallelSafeToolCall,
  splitLeadingParallelToolCalls,
} from '../src/lib/agent/parallel-tool-calls';

const calls = [
  { name: 'workspace_run_command', args: { command: 'Get-Content src/app/page.tsx' } },
  { name: 'workspace_run_command', args: { command: 'rg --files src' } },
  { name: 'workspace_edit_file', args: { filename: 'out.txt', edits: [] } },
  { name: 'workspace_run_command', args: { command: 'Get-Content out.txt' } },
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
