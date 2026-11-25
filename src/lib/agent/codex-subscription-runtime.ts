import http from 'node:http';
import { Readable } from 'node:stream';
import { OpenAI } from './model-clients';
import { MODEL_REQUEST_TIMEOUT_MS } from './model-request-policy';

type Bridge = { address: string; key: string } | null;
const runtime = globalThis as typeof globalThis & { __eterxCodexBridge?: Bridge };

/** Capture the private connection before any workspace subprocess inherits env. */
export function initializeCodexBridge(): Bridge {
  if (runtime.__eterxCodexBridge === undefined) {
    const address = process.env.ETERX_CODEX_BRIDGE_ADDRESS;
    const key = process.env.ETERX_CODEX_BRIDGE_KEY;
    delete process.env.ETERX_CODEX_BRIDGE_ADDRESS;
    delete process.env.ETERX_CODEX_BRIDGE_KEY;
    runtime.__eterxCodexBridge = address && key ? { address, key } : null;
  }
  return runtime.__eterxCodexBridge;
}

function bridgeFetch(bridge: NonNullable<Bridge>): typeof fetch {
  // Pin a client to the first account it uses, including across tool rounds.
  let connection: string | undefined;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== 'https://api.openai.com/v1/responses' || request.method !== 'POST') {
      throw new Error('ChatGPT plan usage supports the Responses endpoint.');
    }
    const body = Buffer.from(await request.arrayBuffer());
    const fastProfile = request.headers.get('x-eterx-codex-fast-profile');
    return new Promise<Response>((resolve, reject) => {
      const local = http.request({
        socketPath: bridge.address,
        path: '/v1/responses',
        method: 'POST',
        signal: request.signal,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'x-eterx-codex-bridge': bridge.key,
          ...(connection ? { 'x-eterx-codex-connection': connection } : {}),
          ...(fastProfile ? { 'x-eterx-codex-fast-profile': fastProfile } : {}),
        },
      }, response => {
        const status = response.statusCode || 503;
        const current = response.headers['x-eterx-codex-connection'];
        // The private bridge only returns a new ID after an approved handoff.
        if (typeof current === 'string') connection = current;
        const headers = new Headers();
        for (const name of ['content-type', 'retry-after', 'retry-after-ms', 'x-request-id']) {
          const value = response.headers[name];
          if (typeof value === 'string') headers.set(name, value);
        }
        if (status === 204 || status === 304) {
          response.resume();
          resolve(new Response(null, { status, headers }));
          return;
        }
        const stream = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        resolve(new Response(stream, { status, headers }));
      });
      local.once('error', reject);
      local.end(body);
    });
  };
}

export function createCodexSubscriptionClient(timeout = MODEL_REQUEST_TIMEOUT_MS): OpenAI {
  const bridge = initializeCodexBridge();
  if (!bridge) {
    throw new Error('ChatGPT plan usage is available in the EterX desktop app. Open Settings → Subscription to connect.');
  }
  return new OpenAI({
    apiKey: 'desktop-subscription',
    baseURL: 'https://api.openai.com/v1',
    timeout,
    maxRetries: 0,
    fetch: bridgeFetch(bridge),
  });
}
