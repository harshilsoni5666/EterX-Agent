import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
  isSourceReadCommand,
  keepHeadAndTailOutput,
  normalizeModelOutputChars,
  resolveModelOutputChars,
  workspaceRunCommandTool,
} from '../src/lib/agent/tools/workspace/execution';
import { terminalBackgroundHandoffNote, terminalTimeoutNote } from '../src/lib/agent/tools/core/terminal_timeout';

assert.equal(resolveModelOutputChars('npm test', undefined), 24_000);
assert.equal(resolveModelOutputChars('Get-Content src/app.ts', undefined), Infinity);
assert.equal(resolveModelOutputChars('cat src/app.ts', undefined), Infinity);
assert.equal(resolveModelOutputChars('git diff -- src/app.ts', undefined), 24_000);
assert.equal(resolveModelOutputChars('powershell -Command "Get-Content src/app.ts"', undefined), 24_000);
assert.equal(resolveModelOutputChars('nl -ba src/app.ts', undefined), Infinity);

assert.equal(isSourceReadCommand('rg -n "thing" src'), true);
assert.equal(isSourceReadCommand('npm run build'), false);
assert.equal(isSourceReadCommand('Write-Output type'), false);
assert.equal(isSourceReadCommand('Get-Content app.ts | Select-Object -Skip 100 -First 50'), true);

// Source reads stay complete even when a caller supplies a log-size limit.
assert.equal(resolveModelOutputChars('Get-Content huge.ts', 8_000), Infinity);
assert.equal(normalizeModelOutputChars(1), 4_000);
assert.equal(normalizeModelOutputChars(999_999), 256_000);

const handoffNote = terminalBackgroundHandoffNote('npm test', 'task-1', 15_000);
assert.match(handoffNote, /foreground check-in/i);
assert.match(handoffNote, /mode="wait" with taskId to await output\/completion/i);
assert.match(handoffNote, /mode="check" to inspect now/i);
assert.match(handoffNote, /does not make it a background task/i);
assert.match(handoffNote, /Never execute the task ID as a shell command/i);

const serverTimeoutNote = terminalTimeoutNote('npm run dev', 30_000);
assert.match(serverTimeoutNote, /hard execution deadline/i);
assert.doesNotMatch(serverTimeoutNote, /workspace_run_command|retry|always time out|will time out again/i);

const commandSchemaShape = (workspaceRunCommandTool.inputSchema as any).shape;
assert.match(String(workspaceRunCommandTool.description), /mode=run executes command/i);
assert.match(String(commandSchemaShape.timeoutSeconds.description), /does not kill the command/i);
assert.match(String(commandSchemaShape.background.description), /process continues until/i);
assert.doesNotMatch(String(workspaceRunCommandTool.description), /\b(?:prefer|follow|do not|instead)\b/i);

async function main(): Promise<void> {
  const source = `BEGIN:${'a'.repeat(20_000)}:MIDDLE:${'z'.repeat(20_000)}:END`;
  const compacted = keepHeadAndTailOutput(source, 4_000);
  assert.equal(compacted.text.length, 4_000);
  assert.ok(compacted.text.startsWith('BEGIN:'), 'source compaction must preserve the beginning');
  assert.ok(compacted.text.endsWith(':END'), 'source compaction must preserve the end');
  assert.ok(compacted.text.includes('middle output omitted'));
  assert.equal(compacted.dropped, source.length - (4_000 - compacted.text.match(/\n\.\.\.\[.*\]\.\.\.\n/)![0].length));

  // Exercise the real terminal path with content that exceeded the former
  // 24,000-character default. A regression would silently lose BEGIN again.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-terminal-output-'));
  const filename = path.join(root, 'large-source.txt');
  try {
    const emptyCommand = process.platform === 'win32'
      ? 'Get-ChildItem -LiteralPath . -Force'
      : 'find . -mindepth 1 -maxdepth 1 -print';
    const emptyResult: any = await workspaceRunCommandTool.execute({ command: emptyCommand, cwd: root }, {
      workspaceRoot: root,
      workspacePath: root,
      allowedPaths: [root],
      projectId: 'terminal-output-policy-test',
    });
    assert.equal(emptyResult.success, true, emptyResult.stderr);
    assert.equal(emptyResult.stdout, '');
    assert.equal(emptyResult.message, 'Command completed successfully with no output.');

    await fs.writeFile(filename, source, 'utf8');
    const quoted = filename.replace(/'/g, "''");
    const command = process.platform === 'win32'
      ? `Get-Content -Raw -LiteralPath '${quoted}'`
      : `cat -- '${quoted}'`;
    const result: any = await workspaceRunCommandTool.execute({ command, cwd: root }, {
      workspaceRoot: root,
      workspacePath: root,
      allowedPaths: [root],
      projectId: 'terminal-output-policy-test',
    });
    assert.equal(result.success, true, result.stderr);
    assert.ok(result.stdout.startsWith('BEGIN:'), 'real source read must retain the file beginning');
    assert.ok(result.stdout.trimEnd().endsWith(':END'), 'real source read must retain the file end');
    assert.equal(result.droppedOutputChars, 0);
  } finally {
    await fs.remove(root);
  }

  console.log('terminal output policy integration tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
