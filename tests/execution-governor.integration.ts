import assert from 'node:assert/strict';
import { ExecutionGovernor } from '../src/lib/agent/execution-governor';

function main() {
  const governor = new ExecutionGovernor();
  const failedCommand = { command: 'npm run test' };

  governor.recordTool('workspace_run_command', failedCommand, {
    exitCode: 1,
    stderr: 'test failure',
  });
  governor.recordTool('workspace_run_command', failedCommand, {
    exitCode: 1,
    stderr: 'test failure',
  });

  const blocked = governor.beforeTool('workspace_run_command', failedCommand);
  assert.equal(blocked.allowed, false, 'an unchanged command should be blocked after two identical failures');
  assert.match(String(blocked.recovery), /change the inputs or strategy/i);

  governor.recordTool('workspace_apply_patch', { patch: '*** Begin Patch\n*** End Patch' }, {
    success: true,
    filesModified: ['src/example.ts'],
  });
  const allowedAfterChange = governor.beforeTool('workspace_run_command', failedCommand);
  assert.equal(allowedAfterChange.allowed, true, 'a workspace mutation should permit a focused re-check');

  const beforeVerify = governor.buildGuidance();
  assert.match(beforeVerify, /without recorded verification/i);

  governor.recordTool('workspace_verify_code', { checkType: 'typecheck' }, { success: true, passed: true });
  const snapshot = governor.snapshot();
  assert.equal(snapshot.hasMutation, true);
  assert.equal(snapshot.hasVerification, true);
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.doesNotMatch(governor.buildGuidance(), /without recorded verification/i);

  console.log('execution governor integration ok');
}

main();
