'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GatewayDaemon } = require('../src/lib/agent/gateways/daemon.cjs');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-telegram-gateway-'));
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).includes('/getMe')) return { ok: true, json: async () => ({ ok: true, result: { id: 1 } }) };
    if (String(url).includes('/deleteWebhook')) return { ok: true, json: async () => ({ ok: true, result: true }) };
    return { ok: true, json: async () => ({ ok: false, description: 'Conflict: terminated by other getUpdates request' }) };
  };

  const daemon = new GatewayDaemon({
    dataDir,
    config: { enabled: true, platforms: { telegram: { enabled: true, mode: 'polling', token: 'test-token' } } },
    onEvent: () => {},
    onStatus: () => {},
  });
  await daemon.startTelegramPolling();
  assert.equal(daemon.status().platforms.telegram.state, 'conflict');
  assert.equal(requests.some((url) => url.includes('/getMe')), true);
  assert.equal(requests.some((url) => url.includes('/deleteWebhook')), true);
  assert.equal(requests.some((url) => url.includes('/getUpdates')), true);

  global.fetch = originalFetch;
  daemon.releaseTelegramLock();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('gateway-telegram.integration: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
