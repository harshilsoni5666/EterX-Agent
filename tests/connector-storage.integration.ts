import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-connector-storage-'));
const dataDir = path.join(root, 'data');
const workspaceDir = path.join(dataDir, '.workspaces');
process.env.ETERX_DATA_DIR = dataDir;
process.env.ETERX_WORKSPACE_ROOT = workspaceDir;
process.env.ETERX_CONNECTOR_SECRET = 'integration-test-connector-secret';

const run = async () => {
try {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const legacyFile = path.join(workspaceDir, '.connectors.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    legacy: { connected: true, baseUrl: 'https://legacy.example', apiToken: 'legacy-secret-token' },
  }));

  const store = await import('../src/lib/connectors/store');
  const migrated = store.getConnectorRecord('legacy');
  assert.equal(migrated?.credentials?.apiToken, 'legacy-secret-token');
  assert.equal(fs.existsSync(legacyFile), false, 'plaintext legacy connector storage must be removed after migration');

  store.saveConnectorRecord({
    id: 'slack',
    kind: 'rest',
    connected: true,
    baseUrl: 'https://slack.com/api',
    credentials: { botToken: 'xoxb-private-token', signingSecret: 'private-signing-secret' },
  });
  store.saveMcpServerRecord({
    id: 'private-mcp',
    name: 'Private MCP',
    transport: 'streamable-http',
    endpoint: 'https://mcp.example',
    headers: { Authorization: 'Bearer private-mcp-token' },
    enabled: true,
  });

  const vault = path.join(dataDir, 'settings', '.connectors.enc.json');
  assert.equal(fs.existsSync(vault), true, 'connector vault must live in durable AppData settings');
  const encryptedBytes = fs.readFileSync(vault, 'utf8');
  assert.equal(encryptedBytes.includes('xoxb-private-token'), false);
  assert.equal(encryptedBytes.includes('private-mcp-token'), false);
  assert.equal(store.getConnectorRecord('slack')?.credentials?.botToken, 'xoxb-private-token');
  assert.equal('credentials' in store.redactConnector(store.getConnectorRecord('slack')!), false);
  assert.equal('headers' in store.redactConnector(store.getMcpServerRecord('private-mcp')!), false);

  console.log('connector storage integration tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
};

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
