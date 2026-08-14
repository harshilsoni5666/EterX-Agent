import assert from 'node:assert/strict';
import { compactStaleProviderHistory, rollProviderHistory } from '../src/lib/agent/context-hot-path';
import { toolResultCompactor } from '../src/lib/agent/memory/tool-result-compactor';
import { estimateRequestTokenBudget } from '../src/lib/agent/request-token-budget';

function testLatestParallelBatchStaysExact(): void {
  const oldA = 'old-a '.repeat(2_000);
  const oldB = 'old-b '.repeat(2_000);
  const latestA = 'latest-a '.repeat(2_000);
  const latestB = 'latest-b '.repeat(2_000);
  const messages: any[] = [
    { role: 'system', content: 'stable' },
    { role: 'user', content: 'do work' },
    { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', tool_call_id: 'a', content: oldA },
    { role: 'tool', tool_call_id: 'b', content: oldB },
    { role: 'assistant', tool_calls: [{ id: 'c' }, { id: 'd' }] },
    { role: 'tool', tool_call_id: 'c', content: latestA },
    { role: 'tool', tool_call_id: 'd', content: latestB },
  ];
  const compacted = compactStaleProviderHistory(messages, 'do work');
  assert.match(compacted[3].content, /__eterxContextDigest/);
  assert.match(compacted[4].content, /__eterxContextDigest/);
  assert.equal(compacted[6].content, latestA);
  assert.equal(compacted[7].content, latestB);
}

function testHistoryRollUsesDurableLedger(): void {
  const messages: any[] = [{ role: 'system', content: 'stable' }];
  for (let index = 0; index < 11; index++) {
    messages.push({ role: 'assistant', content: `action-${index}` });
    messages.push({ role: 'tool', tool_call_id: `t-${index}`, content: `result-${index}` });
  }
  const rolled = rollProviderHistory(messages, 'verified ledger state', 'openai');
  assert.ok(rolled.length < messages.length);
  assert.equal(rolled[0].role, 'system');
  assert.ok(rolled.some(message => String(message.content).includes('verified ledger state')));
  const firstTool = rolled.findIndex(message => message.role === 'tool');
  assert.ok(firstTool <= 0 || rolled[firstTool - 1]?.role === 'assistant');
}

function testParallelBatchBudget(): void {
  const outputs = [
    { content: 'a '.repeat(12_000), path: 'a.ts' },
    { content: 'b '.repeat(12_000), path: 'b.ts' },
    { success: true, path: 'small.ts' },
  ];
  const compacted = toolResultCompactor.compactBatch(
    ['workspace_read_file', 'workspace_read_file', 'workspace_read_file'],
    [{ filename: 'a.ts' }, { filename: 'b.ts' }, { filename: 'small.ts' }],
    outputs,
  );
  assert.equal(compacted[2], outputs[2], 'small result should remain exact');
  assert.ok(JSON.stringify(compacted).length < JSON.stringify(outputs).length / 2);
  assert.equal(compacted[0].__eterxContextDigest, true);
}

function testRequestBudgetBreakdown(): void {
  const budget = estimateRequestTokenBudget({
    system: 's'.repeat(400),
    tools: [{ name: 'tool', parameters: { type: 'object' } }],
    messages: [{ role: 'tool', content: 'r'.repeat(400) }],
  });
  assert.ok(budget.estimatedInputTokens >= 200);
  assert.equal(budget.toolResultTokens, 100);
  assert.equal(budget.toolCount, 1);
}

testLatestParallelBatchStaysExact();
testHistoryRollUsesDurableLedger();
testParallelBatchBudget();
testRequestBudgetBreakdown();
console.log('request token budget integration checks passed');
