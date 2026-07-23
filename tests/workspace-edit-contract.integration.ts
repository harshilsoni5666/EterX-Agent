import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { workspaceWriteTool, workspaceReadTool } from '../src/lib/agent/tools/workspace/fileops';
import { workspaceStrReplaceTool } from '../src/lib/agent/tools/workspace/str_replace';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-workspace-contract-'));
  const file = path.join(root, 'sample.txt');
  const context = { workspaceRoot: root, workspacePath: root, allowedPaths: [root], projectId: 'contract-test' };
  try {
    const created: any = await workspaceWriteTool.execute({ filename: file, content: 'alpha\nalpha\nomega' }, context);
    assert.equal(created.success, true);

    const refused: any = await workspaceWriteTool.execute({ filename: file, content: 'destructive overwrite' }, context);
    assert.equal(refused.success, false);
    assert.match(String(refused.error), /Refusing to overwrite/);

    const ambiguous: any = await workspaceStrReplaceTool.execute({ filename: file, old_string: 'alpha', new_string: 'beta' }, context);
    assert.equal(ambiguous.success, false);
    assert.equal(ambiguous.occurrences, 2);

    const replaced: any = await workspaceStrReplaceTool.execute({ filename: file, old_string: 'alpha', new_string: 'beta', replace_all: true }, context);
    assert.equal(replaced.success, true);
    assert.equal(replaced.replacements, 2);

    const readback: any = await workspaceReadTool.execute({ filename: file }, context);
    assert.match(String(readback.content), /1\| beta\s+2\| beta\s+3\| omega/);
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
