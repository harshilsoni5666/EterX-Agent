import assert from 'node:assert/strict';
import { streamDirectChat } from '../src/lib/chat/direct-chat';

const frame = (text: string, finishReason?: string) => `data: ${JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
})}\n\n`;

async function main() {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let alwaysTruncate = false;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /generativelanguage\.googleapis\.com.*streamGenerateContent/);
    const body = JSON.parse(String(init?.body));
    assert.ok(body.systemInstruction, 'system instruction must survive retry');
    calls++;
    const broken = alwaysTruncate || calls === 1;
    return new Response(broken
      ? frame('discard this partial answer') + 'data: {"candidates":['
      : frame('Recovered answer', 'STOP'), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  const request: any = {
    prompt: 'Say hello.',
    selectedModel: { provider: 'gemini', modelId: 'gemini-3.8-flash' },
    thinkingLevel: 'high',
    runtimeSettings: { apiKeys: { gemini: ['mock-key'] }, apiRetries: 0 },
  };
  try {
    const traces: any[] = [];
    const result = await streamDirectChat(request, trace => traces.push(trace));
    assert.equal(result.text, 'Recovered answer');
    assert.equal(calls, 2, 'one automatic recovery even with API retries disabled');
    assert.equal(traces.filter(trace => trace.type === 'answer_cancel').length, 1);
    const final = traces.find(trace => trace.type === 'answer' && trace.final);
    assert.equal(final?.text, 'Recovered answer');
    assert.ok(!final.text.includes('partial'));

    calls = 0;
    alwaysTruncate = true;
    await assert.rejects(streamDirectChat(request, () => {}), /Incomplete JSON segment at the end/);
    assert.equal(calls, 2, 'a persistently broken provider must not loop forever');
    console.log('Gemini real-SDK truncated-stream recovery tests passed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
