import assert from 'node:assert/strict';
import { killTerminalBackgroundTask, runTerminalCommandWithCheckIn } from '../src/lib/agent/tools/core/terminal_background';

const shell = process.platform === 'win32' ? 'powershell' : 'bash';
const cwd = process.cwd();

async function testCompletedCommandKeepsOwnership(): Promise<void> {
  const token = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const traces: any[] = [];
  const result = await runTerminalCommandWithCheckIn({
    command: process.platform === 'win32' ? `Write-Output "${token}"` : `printf '%s' '${token}'`,
    cwd,
    source: 'terminal-live-test',
    shell,
    checkInMs: 5_000,
    context: {
      chatId: 'terminal-live-test-chat',
      runId: 'terminal-live-test-run',
      ownerTraceId: 'terminal-live-test-action',
      _onTrace: (trace: any) => traces.push(trace),
    },
  });

  const finalTrace = traces.find(trace => trace.type === 'console_output' && trace.isStreaming === false);
  assert.ok(finalTrace, 'a completed command must emit one settled console trace');
  assert.equal(finalTrace.ownerTraceId, 'terminal-live-test-action');
  assert.equal(finalTrace.runId, 'terminal-live-test-run');
  assert.equal(finalTrace.toolName, 'terminal-live-test');
  assert.match(String(finalTrace.output), new RegExp(token));
  assert.equal(result.stillRunning, false);
}

async function testHandoffAndKillPreserveLiveLifecycle(): Promise<void> {
  const traces: any[] = [];
  const result = await runTerminalCommandWithCheckIn({
    command: process.platform === 'win32'
      ? `& '${process.execPath.replace(/'/g, "''")}' -e "console.log('handoff-start'); setTimeout(function () {}, 30000)"`
      : `${process.execPath} -e "console.log('handoff-start'); setTimeout(function () {}, 30000)"`,
    cwd,
    source: 'terminal-live-kill-test',
    shell,
    immediateHandoff: true,
    surviveRunSettlement: true,
    hardTimeoutMs: 60_000,
    context: {
      chatId: 'terminal-live-kill-chat',
      runId: 'terminal-live-kill-run',
      ownerTraceId: 'terminal-live-kill-action',
      _onTrace: (trace: any) => traces.push(trace),
    },
  });

  assert.equal(result.stillRunning, true, 'handoff must return while the process is running');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const handoffTrace = traces.find(trace => trace.type === 'console_output');
  assert.ok(handoffTrace, 'handoff must emit a console snapshot');
  assert.equal(handoffTrace.isStreaming, true, 'handoff console output must remain streaming');
  assert.equal(handoffTrace.exitCode, undefined, 'handoff must not report a successful exit code');

  const killed = await killTerminalBackgroundTask(result.taskId, 'terminal-live-kill-chat');
  assert.equal(killed?.status, 'killed');
  const settledTrace = traces.find(trace => trace.type === 'console_output' && trace.isStreaming === false);
  assert.ok(settledTrace, 'killing a background task must settle its console trace');
  assert.equal(settledTrace.exitCode, 143);
  assert.equal(settledTrace.ownerTraceId, 'terminal-live-kill-action');
  assert.equal(settledTrace.runId, 'terminal-live-kill-run');
}

async function run(): Promise<void> {
  await testCompletedCommandKeepsOwnership();
  await testHandoffAndKillPreserveLiveLifecycle();
  console.log('Terminal/live trace integration checks passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
