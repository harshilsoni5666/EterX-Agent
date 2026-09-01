import assert from 'node:assert/strict';
import {
  GEMINI_SIGNATURE_VALIDATION_BYPASS,
  sanitizeGeminiHistory,
} from '../src/lib/agent/context-hot-path';
import { toolResultCompactor } from '../src/lib/agent/memory/tool-result-compactor';
import { estimateRequestTokenBudget } from '../src/lib/agent/request-token-budget';

function testGeminiThoughtSignaturesRemainPositionBound(): void {
  const signature = 'provider-issued-signature';
  const contents = sanitizeGeminiHistory([
    { role: 'user', parts: [{ text: 'read two files' }] },
    {
      role: 'model',
      parts: [
        { functionCall: { name: 'workspace_read_file', args: { filename: 'a.ts' }, id: 'a' }, thoughtSignature: signature },
        { functionCall: { name: 'workspace_read_file', args: { filename: 'b.ts' }, id: 'b' } },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { name: 'workspace_read_file', id: 'a', response: { output: 'a' } } },
        { functionResponse: { name: 'workspace_read_file', id: 'b', response: { output: 'b' } } },
      ],
    },
  ]);

  const calls = contents[1].parts;
  assert.equal(calls[0].thoughtSignature, signature, 'an authentic signature must remain byte-for-byte exact');
  assert.equal(calls[1].thoughtSignature, undefined, 'parallel calls after the first must remain unsigned');
  assert.equal(contents[2].parts[0].functionResponse.id, 'a', 'provider call IDs must survive sanitization');
}

function testGeminiUnsignedStepGetsDocumentedValidationBypass(): void {
  const contents = sanitizeGeminiHistory([
    { role: 'user', parts: [{ text: 'run command' }] },
    { role: 'model', parts: [{ functionCall: { name: 'workspace_run_command', args: { command: 'npm test' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'workspace_run_command', response: { output: 'ok' } } }] },
  ]);

  assert.equal(
    contents[1].parts[0].thoughtSignature,
    GEMINI_SIGNATURE_VALIDATION_BYPASS,
    'a streamed/provider call missing its signature must not poison the next request',
  );
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
  const linked = toolResultCompactor.withExactPageRef(compacted[0], 'pages/example.json.gz');
  assert.equal(linked.exactContextPageRef, 'pages/example.json.gz');
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

testGeminiThoughtSignaturesRemainPositionBound();
testGeminiUnsignedStepGetsDocumentedValidationBypass();
testParallelBatchBudget();
testRequestBudgetBreakdown();
console.log('request token budget integration checks passed');
