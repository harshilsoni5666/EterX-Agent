import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { workspaceEditFileTool } from '../src/lib/agent/tools/workspace/consolidated_edit';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-workspace-contract-'));
  const file = path.join(root, 'sample.txt');
  const context = { workspaceRoot: root, workspacePath: root, allowedPaths: [root], projectId: 'contract-test' };
  try {
    const created: any = await workspaceEditFileTool.execute({
      filename: file,
      edits: [{ replace: 'alpha\nalpha\nomega' }],
    }, context);
    assert.equal(created.success, true);

    const refused: any = await workspaceEditFileTool.execute({
      filename: file,
      edits: [{ replace: 'destructive overwrite' }],
    }, context);
    assert.equal(refused.success, false);
    assert.match(String(refused.error), /search|line range/i);

    const ambiguous: any = await workspaceEditFileTool.execute({
      filename: file,
      edits: [{ search: 'alpha', replace: 'beta' }],
    }, context);
    assert.equal(ambiguous.success, false);
    assert.match(String(ambiguous.error), /search matched more than once/i);

    const replaced: any = await workspaceEditFileTool.execute({
      filename: file,
      edits: [{ search: 'alpha', replace: 'beta', replaceAll: true }],
    }, context);
    assert.equal(replaced.success, true);

    const readback = await fs.readFile(file, 'utf8');
    assert.match(readback, /beta\s+beta\s+omega/);
    console.log('Workspace edit contract checks passed.');
  } finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
    await fs.remove(resolved);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
