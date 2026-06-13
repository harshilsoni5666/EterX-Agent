import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceWriteTool } from '../src/lib/agent/tools/workspace/fileops';
import { workspaceStrReplaceTool } from '../src/lib/agent/tools/workspace/str_replace';
import { workspaceApplyPatchTool } from '../src/lib/agent/tools/workspace/apply_patch';
import { RuntimeEvidenceLedger } from '../src/lib/agent/runtime-evidence';

type ToolLike = {
  name: string;
  execute: (input: any, context?: any) => Promise<any>;
};

async function runTool(ledger: RuntimeEvidenceLedger, tool: ToolLike, input: any, context: any) {
  const result = await tool.execute(input, context);
  ledger.recordTool(tool.name, input, result);
  return result;
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'eterx-workspace-tools-'));
  const context = {
    workspaceRoot: root,
    allowedPaths: [root],
    disableSessionPersistence: true,
  };
  const ledger = new RuntimeEvidenceLedger('workspace-edit-contract');

  try {
    const target = 'src/example.txt';
    const targetPath = path.join(root, target);

    const created = await runTool(ledger, workspaceWriteTool, {
      filename: target,
      content: 'alpha\nbeta\nomega\n',
    }, context);
    assert.equal(created.success, true, 'workspace_write_file should create a new file');
    assert.equal(await readFile(targetPath, 'utf8'), 'alpha\nbeta\nomega\n');

    const refusedOverwrite = await runTool(ledger, workspaceWriteTool, {
      filename: target,
      content: 'full replacement\n',
    }, context);
    assert.equal(refusedOverwrite.success, false, 'workspace_write_file should refuse overwriting an existing file by default');
    assert.match(String(refusedOverwrite.error), /Refusing to overwrite existing file/i);
    assert.equal(await readFile(targetPath, 'utf8'), 'alpha\nbeta\nomega\n', 'refused overwrite must leave content unchanged');

    const replaced = await runTool(ledger, workspaceStrReplaceTool, {
      filename: target,
      old_string: 'beta',
      new_string: 'BETA',
    }, context);
    assert.equal(replaced.success, true, 'workspace_str_replace should apply exact replacement');
    assert.equal(replaced.replacements, 1);
    assert.match(String(replaced.diff || ''), /BETA/);
    assert.match(String(replaced.readback || ''), /BETA/);
    assert.equal(await readFile(targetPath, 'utf8'), 'alpha\nBETA\nomega\n');

    await writeFile(targetPath, 'same\nsame\n', 'utf8');
    const ambiguous = await runTool(ledger, workspaceStrReplaceTool, {
      filename: target,
      old_string: 'same',
      new_string: 'different',
    }, context);
    assert.equal(ambiguous.success, false, 'workspace_str_replace should reject ambiguous matches unless replace_all is set');
    assert.match(String(ambiguous.error), /matched 2 times/i);
    assert.equal(await readFile(targetPath, 'utf8'), 'same\nsame\n');

    await writeFile(targetPath, 'one\ntwo\nthree\n', 'utf8');
    const patched = await runTool(ledger, workspaceApplyPatchTool, {
      patch: [
        '*** Begin Patch',
        `*** Update File: ${target}`,
        ' one',
        '-two',
        '+TWO',
        ' three',
        '*** End Patch',
      ].join('\n'),
    }, context);
    assert.equal(patched.success, true, 'workspace_apply_patch should apply context-matched updates');
    assert.equal(await readFile(targetPath, 'utf8'), 'one\nTWO\nthree\n');

    const added = await runTool(ledger, workspaceApplyPatchTool, {
      patch: [
        '*** Begin Patch',
        '*** Add File: src/new-file.txt',
        '+created by patch',
        '*** End Patch',
      ].join('\n'),
    }, context);
    assert.equal(added.success, true, 'workspace_apply_patch should create new files with Add File');
    assert.equal(await readFile(path.join(root, 'src/new-file.txt'), 'utf8'), 'created by patch');

    const gateBeforeVerification = ledger.buildCompletionGate({
      finalText: 'Implemented and verified the edit.',
      toolsUsed: ['workspace_write_file', 'workspace_str_replace', 'workspace_apply_patch'],
    });
    assert.equal(gateBeforeVerification.shouldAppendCaveat, true, 'work without verification evidence should trigger a caveat');
    assert.match(gateBeforeVerification.caveat, /Verification/);

    ledger.recordTool('realtime_verify', { mode: 'file_content', target }, { success: true, passed: true, evidence: 'content checked' });
    const gateAfterVerification = ledger.buildCompletionGate({
      finalText: 'Implemented and verified the edit.',
      toolsUsed: ['workspace_write_file', 'workspace_str_replace', 'workspace_apply_patch', 'realtime_verify'],
    });
    assert.equal(gateAfterVerification.hasVerificationEvidence, true, 'verification evidence should be recognized');
    assert.equal(gateAfterVerification.shouldAppendCaveat, false, 'verification evidence should satisfy the completion gate');

    console.log('workspace edit contract ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
