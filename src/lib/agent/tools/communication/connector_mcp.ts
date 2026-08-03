import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { enforceToolCapability } from '../security/tool_policy';
import { requireOutboundApproval } from './outbound_approval';
import {
  callConnectedMcpTool,
  callConnectorApi,
  listConnectedMcpTools,
  listConnectorRuntimeStatus,
  testConnectorRecord,
  WRITE_METHODS,
} from '../../../connectors/runtime';
import {
  listConnectorRecords,
  removeConnectorRecord,
  removeMcpServerRecord,
  saveConnectorRecord,
  saveMcpServerRecord,
  type ConnectorRecord,
  type McpServerRecord,
} from '../../../connectors/store';

// MCP does not require every server to publish a side-effect classification.
// Treat clearly read-oriented names as autonomous, while keeping mutation and
// ambiguous names behind the existing outbound approval boundary.
const MCP_MUTATION_PATTERN = /(?:^|[_-])(send|create|update|delete|remove|destroy|write|upload|download|invite|react|comment|publish|trigger|execute|run|add|move|archive|cancel|post|put|patch|sync)(?:$|[_-])/i;
const MCP_READ_PATTERN = /^(?:get|list|read|fetch|search|find|lookup|retrieve|describe|inspect|check|verify|health|status|whoami|view|show|count|query|load)(?:$|[_-])/i;

function isLikelyReadOnlyMcpTool(toolName: unknown): boolean {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized || MCP_MUTATION_PATTERN.test(normalized)) return false;
  return MCP_READ_PATTERN.test(normalized);
}

export const connectorMcpTool: ToolDefinition = {
  name: 'connector_mcp',
  description: `Use a connector the user has actually connected.

The tool is registered for every saved connector and MCP server. It exposes:
- list_connectors: see connected connector IDs and their verified status.
- configure_connector: save and verify a connector after the user supplies its API credential.
- disconnect_connector: remove one saved connector credential.
- list_mcp_servers: see configured MCP servers.
- register_mcp_server: save and verify a live MCP HTTP or stdio server.
- disconnect_mcp_server: remove one MCP server.
- list_tools: discover the live tools from one MCP server.
- call_tool: call a live tool on the selected MCP server with its configured permissions.
- api_request: make an authenticated REST request against a connected connector's configured API origin.

The agent never receives raw credentials. Authentication is added by the local runtime. A connector's access is exactly the account/token scopes the user configured.`,
  category: 'communication',
  inputSchema: z.object({
    action: z.enum(['list_connectors', 'configure_connector', 'disconnect_connector', 'list_mcp_servers', 'register_mcp_server', 'disconnect_mcp_server', 'list_tools', 'call_tool', 'api_request']),
    server_id: z.string().optional(),
    connector_id: z.string().optional(),
    base_url: z.string().optional(),
    health_path: z.string().optional(),
    auth_header: z.string().optional(),
    token_prefix: z.string().optional(),
    credentials: z.record(z.string(), z.string()).optional(),
    token: z.string().optional(),
    name: z.string().optional(),
    transport: z.enum(['stdio', 'streamable-http']).optional(),
    endpoint: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    tool_name: z.string().optional(),
    arguments: z.record(z.string(), z.any()).optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    path: z.string().optional(),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.any().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    confirm: z.boolean().optional().describe('Required true for connector writes or unknown MCP actions.'),
  }),
  outputSchema: z.object({ success: z.boolean(), status: z.string(), results: z.any().optional() }),
  execute: async (input: any, context?: any) => {
    const decision = enforceToolCapability('connector_mcp', input, context);
    if (!decision.allowed) return { success: false, status: decision.reason || 'Connector access is not allowed.' };
    try {
      if (input.action === 'list_connectors') {
        return { success: true, status: 'Connected connectors loaded.', results: listConnectorRecords().map((record) => ({
          id: record.id,
          kind: record.kind,
          connected: record.connected,
          baseUrl: record.baseUrl,
          lastCheckedAt: record.lastCheckedAt,
          lastError: record.lastError,
        })) };
      }
      if (input.action === 'configure_connector') {
        if (!input.connector_id) return { success: false, status: 'connector_id is required.' };
        const credentials = { ...(input.credentials || {}) };
        if (input.token && !credentials.token) credentials.token = input.token;
        const record: ConnectorRecord = {
          id: input.connector_id,
          kind: 'rest',
          connected: false,
          baseUrl: input.base_url,
          healthPath: input.health_path,
          authHeader: input.auth_header,
          tokenPrefix: input.token_prefix,
          credentials,
        };
        saveConnectorRecord(record);
        const verification = await testConnectorRecord(record);
        const saved = saveConnectorRecord({ ...record, connected: verification.ok, connectedAt: verification.ok ? Date.now() : undefined, lastCheckedAt: Date.now(), lastError: verification.ok ? undefined : verification.message });
        if (!verification.ok) return { success: false, status: `Connector ${input.connector_id} was not connected: ${verification.message}`, results: { connector_id: saved.id, connected: false } };
        return { success: true, status: `Connector ${input.connector_id} verified and registered.`, results: { connector_id: saved.id, connected: true } };
      }
      if (input.action === 'disconnect_connector') {
        if (!input.connector_id) return { success: false, status: 'connector_id is required.' };
        return { success: true, status: `Connector ${input.connector_id} disconnected.`, results: { removed: removeConnectorRecord(input.connector_id) } };
      }
      if (input.action === 'register_mcp_server') {
        const serverId = String(input.server_id || input.name || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
        if (!serverId || !input.name) return { success: false, status: 'name and server_id (or a name) are required.' };
        const server: McpServerRecord = { id: serverId, name: input.name, transport: input.transport || 'streamable-http', endpoint: input.endpoint, command: input.command, args: input.args, headers: input.headers, env: input.env, enabled: true, connectedAt: Date.now() };
        saveMcpServerRecord(server);
        try {
          const tools = await listConnectedMcpTools(serverId);
          saveMcpServerRecord({ ...server, lastCheckedAt: Date.now(), lastError: undefined });
          return { success: true, status: `MCP server ${server.name} verified and registered.`, results: { server_id: serverId, tools } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          saveMcpServerRecord({ ...server, enabled: false, lastCheckedAt: Date.now(), lastError: message });
          return { success: false, status: `MCP server ${server.name} was not connected: ${message}`, results: { server_id: serverId, connected: false } };
        }
      }
      if (input.action === 'disconnect_mcp_server') {
        if (!input.server_id) return { success: false, status: 'server_id is required.' };
        return { success: true, status: `MCP server ${input.server_id} disconnected.`, results: { removed: removeMcpServerRecord(input.server_id) } };
      }
      if (input.action === 'list_mcp_servers') {
        return { success: true, status: 'MCP servers loaded.', results: listConnectorRuntimeStatus() };
      }
      if (input.action === 'list_tools') {
        if (!input.server_id) return { success: false, status: 'server_id is required.' };
        const results = await listConnectedMcpTools(input.server_id);
        return { success: true, status: `Live tools loaded from ${input.server_id}.`, results };
      }
      if (input.action === 'call_tool') {
        if (!input.server_id || !input.tool_name) return { success: false, status: 'server_id and tool_name are required.' };
        if (!isLikelyReadOnlyMcpTool(input.tool_name)) {
          const approval = await requireOutboundApproval('MCP connector', input.tool_name, input, context, input.server_id, JSON.stringify(input.arguments || {}));
          if (approval) return approval;
        }
        const results = await callConnectedMcpTool(input.server_id, input.tool_name, input.arguments || {});
        return { success: true, status: `MCP tool ${input.tool_name} completed.`, results };
      }
      if (!input.connector_id || !input.path) return { success: false, status: 'connector_id and path are required.' };
      const method = input.method || 'GET';
      if (WRITE_METHODS.has(method)) {
        const approval = await requireOutboundApproval('Connected connector', method, input, context, input.connector_id, `${method} ${input.path}`);
        if (approval) return approval;
      }
      const results = await callConnectorApi(input.connector_id, {
        method,
        path: input.path,
        query: input.query,
        body: input.body,
        headers: input.headers,
      });
      return { success: true, status: `${method} ${input.path} completed.`, results };
    } catch (error) {
      return { success: false, status: error instanceof Error ? error.message : String(error) };
    }
  },
};
