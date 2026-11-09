import assert from 'node:assert/strict';
import { isRequestUnavailable, isRequestTimeout, requestJson } from '../src/lib/request-json';

async function main() {
  const originalFetch = globalThis.fetch;
  try {
    const networkError = new TypeError('Failed to fetch');
    globalThis.fetch = async () => { throw networkError; };
    await assert.rejects(requestJson('/api/chats'), error => isRequestUnavailable(error));
    assert.equal(isRequestUnavailable(new SyntaxError('Invalid JSON')), false);
    assert.equal(isRequestUnavailable(new TypeError('Unexpected application bug')), false);
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    await assert.rejects(requestJson('/api/chats', {}, 5), error => isRequestTimeout(error));
    globalThis.fetch = async () => new Response(JSON.stringify({ chats: [] }), { status: 200 });
    assert.deepEqual(await (await requestJson('/api/chats')).json(), { chats: [] });
    console.log('Chat request checks passed: network failure classification, bounded timeout, and successful retry.');
  } finally { globalThis.fetch = originalFetch; }
}
void main();
