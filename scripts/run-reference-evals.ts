import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

type ReferenceEval = {
  id: string;
  mode: string;
  prompt: string;
  expectedTools: string[];
  mustVerify: string[];
  forbidden: string[];
  successCriteria: string[];
};

const repoRoot = process.cwd();
const referenceRoot = path.join(repoRoot, 'coding-agent', 'eterx-agent-reference');
const evalPath = path.join(referenceRoot, 'evals', 'sample-evals.json');

function walkFiles(root: string, extensions: Set<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (['node_modules', '.git', '.next', '.workspaces'].includes(entry)) continue;
      out.push(...walkFiles(full, extensions));
    } else if (extensions.has(path.extname(entry).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function readTextFiles(files: string[]): string {
  return files.map(file => readFileSync(file, 'utf8')).join('\n');
}

function collectToolNames(): Set<string> {
  const toolFiles = walkFiles(path.join(repoRoot, 'src', 'lib', 'agent', 'tools'), new Set(['.ts']));
  const names = new Set<string>();
  for (const file of toolFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bname:\s*['"]([a-zA-Z0-9_:-]+)['"]/g)) {
      names.add(match[1]);
    }
  }
  const codeToolText = readFileSync(path.join(repoRoot, 'src', 'lib', 'code', 'code-agent-tools.ts'), 'utf8');
  for (const match of codeToolText.matchAll(/['"]([a-zA-Z0-9_:-]+)['"]/g)) {
    if (match[1].includes('_') || match[1].includes('-')) names.add(match[1]);
  }
  return names;
}

function assertArray(value: unknown, name: string, evalId: string) {
  assert.ok(Array.isArray(value), `${evalId}: ${name} must be an array`);
  assert.ok(value.length > 0, `${evalId}: ${name} must not be empty`);
  for (const item of value) assert.equal(typeof item, 'string', `${evalId}: ${name} entries must be strings`);
}

function main() {
  const evals = JSON.parse(readFileSync(evalPath, 'utf8')) as ReferenceEval[];
  assert.ok(Array.isArray(evals), 'sample-evals.json must contain an array');
  assert.ok(evals.length >= 3, 'reference eval suite should contain multiple scenarios');

  const toolNames = collectToolNames();
  const ids = new Set<string>();

  for (const item of evals) {
    assert.match(item.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${item.id}: id must be stable kebab-case`);
    assert.equal(typeof item.mode, 'string', `${item.id}: mode is required`);
    assert.ok(item.mode.length > 0, `${item.id}: mode must not be empty`);
    assert.equal(typeof item.prompt, 'string', `${item.id}: prompt is required`);
    assert.ok(item.prompt.length > 20, `${item.id}: prompt should describe a real task`);
    assert.ok(!ids.has(item.id), `${item.id}: duplicate eval id`);
    ids.add(item.id);

    assertArray(item.expectedTools, 'expectedTools', item.id);
    assertArray(item.mustVerify, 'mustVerify', item.id);
    assertArray(item.forbidden, 'forbidden', item.id);
    assertArray(item.successCriteria, 'successCriteria', item.id);

    for (const tool of item.expectedTools) {
      assert.ok(toolNames.has(tool), `${item.id}: expected tool is not registered or exposed: ${tool}`);
    }
  }

  const referenceText = readTextFiles(walkFiles(referenceRoot, new Set(['.md', '.json'])));
  const livePromptText = readTextFiles([
    path.join(repoRoot, 'src', 'lib', 'agent', 'Agent.ts'),
    path.join(repoRoot, 'src', 'lib', 'agent', 'coding-agent-profile.ts'),
    path.join(repoRoot, 'src', 'lib', 'code', 'code-agent-tools.ts'),
    path.join(repoRoot, 'src', 'lib', 'code', 'code-prompts.ts'),
  ]);
  const combinedText = `${referenceText}\n${livePromptText}`;

  for (const required of [
    'workspace_apply_patch',
    'browser_control',
  ]) {
    assert.ok(combinedText.includes(required), `reference/live prompts must mention ${required}`);
  }

  for (const forbidden of [
    'Write ALL files first',
    'Do NOT re-read',
    'workspace_edit_file fails',
    'ui_live_preview',
    'work-note-kernel',
  ]) {
    assert.ok(!combinedText.includes(forbidden), `stale prompt/reference phrase found: ${forbidden}`);
  }

  assert.match(
    combinedText,
    /workspace_write_file[^.\n]*(?:brand-new|new files only|new file)/i,
    'workspace_write_file policy must say it is for new files'
  );

  console.log(`reference eval suite ok (${evals.length} scenarios)`);
}

main();
