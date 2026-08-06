import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

async function main() {
const dataDir = await fsMkdtemp(path.join(os.tmpdir(), 'eterx-connector-test-'));
process.env.ETERX_DATA_DIR = dataDir;
process.env.ETERX_CONNECTOR_SECRET = 'connector-test-secret';

const {
  callConnectorApi,
  callConnectedMcpTool,
  listConnectedMcpTools,
  testConnectorRecord,
} = await import('../src/lib/connectors/runtime');
const {
  getConnectorRecord,
  saveConnectorRecord,
  saveMcpServerRecord,
} = await import('../src/lib/connectors/store');
const { connectorMcpTool } = await import('../src/lib/agent/tools/communication/connector_mcp');
const { agentBuilderAttachConnectorToolsTool } = await import('../src/lib/agent/tools/automation/agent_builder');
const { createCustomToolActionLog } = await import('../src/lib/agent/custom-agent-trace-adapter');
const {
  globalToolRegistry,
} = await import('../src/lib/agent/tools/registry');
const {
  isBuilderLiveConnectorToolName,
  readAgentBuilderProfile,
  shouldExposeToolToRuntime,
} = await import('../src/lib/agent/builder-agent');
const { requireOutboundApproval, isUserInitiatedCommunicationRequest } = await import('../src/lib/agent/tools/communication/outbound_approval');
const { isConnectorTrace, resolveConnectorId } = await import('../src/components/chat/agent-icons');
await import('../src/lib/agent/tools/index');
assert.equal(globalToolRegistry.getTool('connector_mcp')?.name, 'connector_mcp');
assert.equal(globalToolRegistry.getTool('gateway_bridge')?.name, 'gateway_bridge');
assert.equal(isBuilderLiveConnectorToolName('gateway_bridge'), true);
assert.equal(shouldExposeToolToRuntime('gateway_bridge', true), true);
assert.equal(shouldExposeToolToRuntime('workspace_write_file', true), false);
assert.equal(isUserInitiatedCommunicationRequest('Send this reply on Telegram'), true);
assert.equal(isUserInitiatedCommunicationRequest('Check unread Telegram messages'), false);
assert.equal(resolveConnectorId('Test data cleaning pipeline'), null);
assert.equal(isConnectorTrace({ tool: 'workspace_run_command', text: 'Test data cleaning pipeline' }), false);
assert.equal(isConnectorTrace({ tool: 'gateway_bridge', platform: 'telegram' }), true);

function fsMkdtemp(prefix: string): Promise<string> {
  return import('node:fs/promises').then((fs) => fs.mkdtemp(prefix));
}

const server = http.createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  response.setHeader('content-type', 'application/json');
  if (request.url === '/health') {
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (body.method === 'initialize') {
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test' } } }));
    return;
  }
  if (body.method === 'tools/list') {
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'get_echo' }] } }));
    return;
  }
  if (body.method === 'tools/call') {
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(body.params.arguments) }] } }));
    return;
  }
  response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

saveConnectorRecord({ id: 'test-api', kind: 'rest', connected: false, baseUrl, healthPath: '/health', credentials: { token: 'secret' } });
const verification = await testConnectorRecord(getConnectorRecord('test-api')!);
assert.equal(verification.ok, true);
saveConnectorRecord({ ...getConnectorRecord('test-api')!, connected: true });
const apiResult = await callConnectorApi('test-api', { path: '/health' });
assert.equal((apiResult.data as any).ok, true);

saveMcpServerRecord({ id: 'test-mcp', name: 'Test MCP', transport: 'streamable-http', endpoint: `${baseUrl}/mcp`, enabled: true });
const tools = await listConnectedMcpTools('test-mcp');
assert.equal(tools.tools[0].name, 'get_echo');
const toolResult = await callConnectedMcpTool('test-mcp', 'get_echo', { value: 'live' });
assert.equal(toolResult.content[0].text, JSON.stringify({ value: 'live' }));

const agentResult = await connectorMcpTool.execute({ action: 'api_request', connector_id: 'test-api', method: 'GET', path: '/health' }, {});
assert.equal(agentResult.success, true);
assert.equal(agentResult.results.data.ok, true);
const agentMcpResult = await connectorMcpTool.execute({ action: 'list_tools', server_id: 'test-mcp' }, {});
assert.equal(agentMcpResult.success, true);
assert.equal(agentMcpResult.results.tools[0].name, 'get_echo');
const readOnlyMcpResult = await connectorMcpTool.execute({ action: 'call_tool', server_id: 'test-mcp', tool_name: 'get_echo', arguments: { value: 'autonomous' } }, {});
assert.equal(readOnlyMcpResult.success, true);
assert.equal(await requireOutboundApproval('EterX Gateway', 'messages_send', {}, { userInitiatedCommunication: true }), null);
const unrequestedSend = await requireOutboundApproval('EterX Gateway', 'messages_send', {}, {});
assert.equal(unrequestedSend?.approvalRequired, true);

const builderAttachResult = await agentBuilderAttachConnectorToolsTool.execute({}, {
  agentRuntime: 'agent_builder',
  projectId: 'agent_builder_connector-test',
});
assert.equal(builderAttachResult.success, true);
const builderProfile = await readAgentBuilderProfile('connector-test');
assert.deepEqual(
  builderProfile.directMainTools.map((tool: any) => tool.toolName).sort(),
  ['connector_mcp', 'gateway_bridge'],
);

const connectorTrace = createCustomToolActionLog({
  toolName: 'connector_mcp',
  toolArgs: { action: 'call_tool', server_id: 'test-mcp', uiIcon: 'terminal' },
}, 'Connector test', Date.now());
assert.equal(connectorTrace.type, 'communication');
assert.equal(connectorTrace.iconCategory, 'connector');
assert.equal(connectorTrace.connectorId, 'test-mcp');

server.close();
console.log('connector-runtime.integration: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
