import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceEditFileTool, workspaceWriteTool } from '../src/lib/agent/tools/workspace/fileops';
import { workspaceEditManyFilesTool } from '../src/lib/agent/tools/workspace/fast_ops';
import { workspaceStrReplaceTool } from '../src/lib/agent/tools/workspace/str_replace';
import { workspaceApplyPatchTool } from '../src/lib/agent/tools/workspace/apply_patch';
import { normalizeRegistryToolArgs } from '../src/lib/agent/tools/tool-args';
import { RuntimeEvidenceLedger } from '../src/lib/agent/runtime-evidence';
import { createCustomToolActionLog } from '../src/lib/agent/custom-agent-trace-adapter';
import { buildLineDiffPreview, buildToolTraceFields } from '../src/lib/agent/tool-trace';

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

    await writeFile(targetPath, 'red\ngreen\nblue\n', 'utf8');
    const lineEdited = await runTool(ledger, workspaceEditFileTool, {
      filename: target,
      edits: [{ startLine: 2, endLine: 2, replace: 'GREEN' }],
    }, context);
    assert.equal(lineEdited.success, true, 'workspace_edit_file should apply line-based replacement');
    assert.equal(lineEdited.path, targetPath, 'workspace_edit_file should return the resolved path');
    assert.equal(lineEdited.filename, target, 'workspace_edit_file should return the requested filename');
    assert.equal(lineEdited.editsApplied, 1, 'workspace_edit_file should return edit count metadata');
    assert.equal(await readFile(targetPath, 'utf8'), 'red\nGREEN\nblue\n');

    await writeFile(targetPath, 'dup\ndup\n', 'utf8');
    const unsafeSingleEdit = await runTool(ledger, workspaceEditFileTool, {
      filename: target,
      edits: [{ search: 'dup', replace: 'safe' }],
    }, context);
    assert.equal(unsafeSingleEdit.success, false, 'workspace_edit_file should reject ambiguous search edits by default');
    assert.match(String(unsafeSingleEdit.error), /matched 2 times/i);
    assert.equal(unsafeSingleEdit.editsApplied, 0, 'ambiguous workspace_edit_file call must not report applied edits');
    assert.equal(await readFile(targetPath, 'utf8'), 'dup\ndup\n');

    const explicitBulkEdit = await runTool(ledger, workspaceEditFileTool, {
      filename: target,
      edits: [{ search: 'dup', replace: 'safe', replaceAll: true }],
    }, context);
    assert.equal(explicitBulkEdit.success, true, 'workspace_edit_file should allow explicit bulk replacement');
    assert.equal(await readFile(targetPath, 'utf8'), 'safe\nsafe\n');

    await writeFile(targetPath, 'multi\nmulti\n', 'utf8');
    const unsafeManyEdit = await runTool(ledger, workspaceEditManyFilesTool, {
      edits: [{ filename: target, search: 'multi', replace: 'changed' }],
    }, context);
    assert.equal(unsafeManyEdit.success, false, 'workspace_edit_many_files should reject ambiguous search edits by default');
    assert.match(String(unsafeManyEdit.error), /matched 2 times/i);
    assert.equal(await readFile(targetPath, 'utf8'), 'multi\nmulti\n', 'ambiguous batch edit must rollback');

    const batchReadTrace = buildToolTraceFields('workspace_read_many_files', {
      files: [{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }],
    }, { argKey: 'files' } as any);
    assert.equal(batchReadTrace.secondary, 'a.ts, b.ts');
    assert.deepEqual(batchReadTrace.files, ['src/a.ts', 'src/b.ts']);
    assert.doesNotMatch(batchReadTrace.secondary, /\[object Object\]/);

    const normalizedStringPaths = normalizeRegistryToolArgs('workspace_read_many_files', {
      paths: 'src/a.ts, src/b.ts',
    });
    assert.deepEqual(normalizedStringPaths.files, [{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }]);

    const normalizedWriteAlias = normalizeRegistryToolArgs('workspace_write_file', {
      file_path: 'src/generated.ts',
      content: 'export const ok = true;\n',
    });
    assert.equal(normalizedWriteAlias.filename, 'src/generated.ts');

    const normalizedEditAlias = normalizeRegistryToolArgs('workspace_edit_file', {
      path: target,
      edits: [{ search: 'x', replace: 'y' }],
    });
    assert.equal(normalizedEditAlias.filename, target);

    const normalizedManyEditAlias = normalizeRegistryToolArgs('workspace_edit_many_files', {
      files: [{ path: 'src/a.ts', search: 'a', replace: 'b' }],
    });
    assert.deepEqual(normalizedManyEditAlias.edits, [{ path: 'src/a.ts', search: 'a', replace: 'b', filename: 'src/a.ts' }]);

    const patchTrace = buildToolTraceFields('workspace_apply_patch', {
      patch: [
        '*** Begin Patch',
        '*** Update File: src/example.txt',
        '-before',
        '+after',
        '*** End Patch',
      ].join('\n'),
    }, { argKey: 'patch' } as any);
    assert.equal(patchTrace.secondary, 'example.txt');
    assert.equal(patchTrace.filename, 'src/example.txt');

    const multiEditTrace = buildToolTraceFields('workspace_edit_many_files', {
      edits: [{ filename: 'src/a.ts', search: 'a', replace: 'b' }, { filename: 'src/b.ts', search: 'c', replace: 'd' }],
    }, { argKey: 'files' } as any);
    assert.equal(multiEditTrace.secondary, 'a.ts, b.ts');
    assert.deepEqual(multiEditTrace.files, ['src/a.ts', 'src/b.ts']);
    assert.doesNotMatch(multiEditTrace.secondary, /\[object Object\]/);

    const customAction = createCustomToolActionLog({
      toolName: 'workspace_write_file',
      toolArgs: { filename: 'src/generated.ts', content: 'one\ntwo\nthree' },
    }, 'Tester', Date.now());
    assert.equal(customAction.add, undefined, 'tool action rows must not show synthetic pre-execution line counts');
    assert.equal(customAction.remove, undefined, 'tool action rows must not show synthetic pre-execution removals');

    const diffPreview = buildLineDiffPreview('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    assert.equal(diffPreview.added, 1);
    assert.equal(diffPreview.removed, 1);
    assert.equal(diffPreview.diffLines.some(line => line.type === 'added' && line.content === 'TWO'), true);

    const gateBeforeVerification = ledger.buildCompletionGate({
      finalText: 'Implemented and verified the edit.',
      toolsUsed: ['workspace_write_file', 'workspace_str_replace', 'workspace_apply_patch', 'workspace_edit_file'],
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
