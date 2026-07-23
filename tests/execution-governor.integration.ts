import assert from 'node:assert/strict';
import { ExecutionGovernor } from '../src/lib/agent/execution-governor';

async function main(): Promise<void> {
  const governor = new ExecutionGovernor({ maxToolCalls: 3, softTimeoutMs: 2, hardTimeoutMs: 20 });
  const args = { command: 'failing-command' };
  governor.recordTool('system_shell', args, { success: false, error: 'failed' });
  governor.recordTool('system_shell', args, { success: false, error: 'failed again' });
  const duplicate = governor.beforeTool('system_shell', args);
  assert.equal(duplicate.allowed, false);
  assert.match(String(duplicate.recovery), /different tool|change/i);

  assert.match(governor.buildGuidance(), /failed 2 times in a row/i);
  governor.recordTool('workspace_write_file', { filename: 'new.txt' }, { success: true, path: 'new.txt' });
  assert.equal(governor.isBudgetExhausted(), true);
  assert.equal(governor.beforeTool('workspace_read_file', { filename: 'new.txt' }).allowed, false);

  const timeoutGovernor = new ExecutionGovernor({ maxToolCalls: 10, softTimeoutMs: 1, hardTimeoutMs: 2 });
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.equal(timeoutGovernor.isTimedOut(), true);
  assert.equal(timeoutGovernor.beforeTool('workspace_read_file', { filename: 'x' }).allowed, false);
  console.log('Execution governor integration checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
