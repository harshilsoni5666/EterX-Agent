import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-model-catalog-'));
  const originalDataDir = process.env.ETERX_DATA_DIR;
  process.env.ETERX_DATA_DIR = root;
  const originalFetch = globalThis.fetch;
  try {
    const { NextRequest } = await import('next/server');
    const { POST } = await import('../src/app/api/settings/models/route');
    for (const repeatToken of [false, true]) {
      const requestedTokens: Array<string | null> = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, 'generativelanguage.googleapis.com');
        assert.equal(new Headers(init?.headers).get('x-goog-api-key'), `pagination-test-${repeatToken}`);
        requestedTokens.push(url.searchParams.get('pageToken'));
        return Response.json({
          models: [{
            name: `models/gemini-pagination-${requestedTokens.length}`,
            displayName: `Pagination model ${requestedTokens.length}`,
            supportedGenerationMethods: ['generateContent'],
          }],
          ...(requestedTokens.length === 1 || repeatToken ? { nextPageToken: 'next-page' } : {}),
        });
      };
      const response = await POST(new NextRequest('http://localhost/api/settings/models', {
        method: 'POST',
        body: JSON.stringify({
          providers: ['gemini'],
          replaceRuntimeKeys: true,
          apiKeys: { gemini: [`pagination-test-${repeatToken}`] },
        }),
      }));
      assert.equal(response.status, 200);
      const payload = await response.json();
      const catalog = payload.providers.gemini;
      assert.deepEqual(requestedTokens, [null, 'next-page']);
      if (repeatToken) {
        assert.equal(catalog.connected, false);
        assert.match(catalog.error, /incomplete model catalog/i);
        assert.deepEqual(catalog.models, []);
      } else {
        assert.equal(catalog.connected, true, catalog.error);
        assert.deepEqual(catalog.models.map((model: { id: string }) => model.id),
          ['gemini-pagination-1', 'gemini-pagination-2']);
      }
    }
    console.log('Model catalog pagination integration checks passed');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDataDir === undefined) delete process.env.ETERX_DATA_DIR;
    else process.env.ETERX_DATA_DIR = originalDataDir;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
