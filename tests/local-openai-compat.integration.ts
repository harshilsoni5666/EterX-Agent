import assert from 'node:assert/strict';
import http from 'node:http';
import { applyRuntimeProviderBaseURLs } from '../src/lib/agent/provider-runtime';
import { runDirectChat } from '../src/lib/chat/direct-chat';

const readBody = async (request: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

async function main(): Promise<void> {
  let sawAuthorization = '';
  let sawPath = '';
  const server = http.createServer(async (request, response) => {
    sawAuthorization = String(request.headers.authorization || '');
    sawPath = String(request.url || '');
    await readBody(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: 'chatcmpl-local-test',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'local connector ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    }));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a port');

  try {
    applyRuntimeProviderBaseURLs({ vllm: `http://127.0.0.1:${address.port}` });
    const result = await runDirectChat({
      prompt: 'test local connector',
      selectedModel: { provider: 'vllm', modelId: 'local-test-model' },
      runtimeSettings: {
        apiKeys: { vllm: ['local-token'] },
      } as any,
    });

    assert.equal(result.text, 'local connector ok');
    assert.equal(sawPath, '/v1/chat/completions');
    assert.equal(sawAuthorization, 'Bearer local-token');
  } finally {
    applyRuntimeProviderBaseURLs({});
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  console.log('local OpenAI-compatible connector integration tests passed');
}

void main();
