import assert from 'node:assert/strict';
import { getRuntimeProtectionReason, killTerminalBackgroundTask, runTerminalCommandWithCheckIn } from '../src/lib/agent/tools/core/terminal_background';

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
    context: {
      chatId: 'terminal-live-kill-chat',
      runId: 'terminal-live-kill-run',
      ownerTraceId: 'terminal-live-kill-action',
      _onTrace: (trace: any) => traces.push(trace),
    },
  });

  assert.equal(result.stillRunning, true, 'handoff must return while the process is running');
  assert.equal(result.hardTimeoutMs, undefined, 'handoff must not add a hidden execution deadline');
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

function testRuntimeSelfTerminationProtection(): void {
  const previousPort = process.env.ETERX_PORT;
  process.env.ETERX_PORT = '43127';
  try {
    assert.match(
      String(getRuntimeProtectionReason('Get-NetTCPConnection -LocalPort 43127 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }')),
      /serving EterX/,
    );
    assert.match(String(getRuntimeProtectionReason(`taskkill /PID ${process.pid} /T /F`)), /runtime process/);
    assert.match(String(getRuntimeProtectionReason(`kill -9 ${process.pid}`)), /runtime process/);
    assert.match(String(getRuntimeProtectionReason('lsof -ti :43127 | xargs kill -9')), /serving EterX/);
    assert.match(String(getRuntimeProtectionReason('fuser -k 43127/tcp')), /serving EterX/);
    assert.equal(getRuntimeProtectionReason('lsof -ti :43128 | xargs kill -9'), null, 'project ports must remain controllable');
  } finally {
    if (previousPort === undefined) delete process.env.ETERX_PORT;
    else process.env.ETERX_PORT = previousPort;
  }
}

async function run(): Promise<void> {
  await testCompletedCommandKeepsOwnership();
  await testHandoffAndKillPreserveLiveLifecycle();
  testRuntimeSelfTerminationProtection();
  console.log('Terminal/live trace integration checks passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
