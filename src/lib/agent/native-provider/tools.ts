import { AsyncResource } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectContext } from '../schemas';
import { getCustomAgentAllowedToolNames, isAgentBuilderRuntimeContext, isBuilderOnlyToolName, isCustomAgentRuntimeContext } from '../builder-agent';
import { agentBuilderTools } from '../tools/automation/agent_builder';
import { agentCommTool } from '../tools/core/agent_comm';
import { askUserTool } from '../tools/core/ask_user';
import { spawnSubAgentTool } from '../tools/core/spawn_sub_agent';
import { getToolInputJsonSchema, globalToolRegistry } from '../tools/registry';
import { enforceToolCapability } from '../tools/security/tool_policy';
import { validateRegistryToolArgs } from '../tools/tool-args';
import { workspaceEditFileTool } from '../tools/workspace/consolidated_edit';
import { workspaceRunCommandTool } from '../tools/workspace/execution';
import { requestToolApproval } from '../tool-approval-runtime';

export type NativeAgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  execute(args: unknown): Promise<string>;
};
export type NativeMcp = { url: string; authorization: string; dispose(): void };

export function nativeAgentTools(context: ProjectContext, signal: AbortSignal, includeWorkspace = false): NativeAgentTool[] {
  const runtime = context as ProjectContext & { disableSubAgents?: boolean; _customAgentProfile?: Parameters<typeof getCustomAgentAllowedToolNames>[0] };
  const allowed = isCustomAgentRuntimeContext(runtime) ? getCustomAgentAllowedToolNames(runtime._customAgentProfile) : null;
  const canSpawn = context.allowAgentSpawning && !runtime.disableSubAgents && !context.planMode;
  const toolContext = { ...runtime, abortSignal: signal };
  const definitions = isAgentBuilderRuntimeContext(context) ? agentBuilderTools
    : allowed ? globalToolRegistry.getAllTools().filter(tool => allowed.has(tool.name) && !isBuilderOnlyToolName(tool.name) && (canSpawn || tool.name !== 'spawn_sub_agent'))
    : [askUserTool, ...(canSpawn ? [spawnSubAgentTool, agentCommTool] : []),
      ...(includeWorkspace ? [workspaceRunCommandTool, ...(context.planMode ? [] : [workspaceEditFileTool])] : [])];
  return definitions.filter(tool => !allowed || allowed.has(tool.name)).map(tool => ({
    name: tool.name, description: tool.modelDescription || tool.description, inputSchema: getToolInputJsonSchema(tool),
    execute: AsyncResource.bind(async (input: unknown) => {
      signal.throwIfAborted();
      const result = validateRegistryToolArgs(tool, input);
      if (!result.success) return JSON.stringify({ error: result.error });
      const args = result.args;
      const capability = enforceToolCapability(tool.name, args, toolContext);
      if (!capability.allowed) return JSON.stringify({ error: capability.reason });
      const blocked = await requestToolApproval(tool.name, args, toolContext, { requireScope: true });
      if (blocked) return JSON.stringify(blocked);
      return (JSON.stringify(await tool.execute(args, toolContext)) || '').slice(0, 120_000);
    }),
  }));
}

/** A per-turn MCP endpoint for CLI providers. It is never exposed to the app's
 * public HTTP server and the provider receives only this turn's tool list. */
export async function openNativeMcp(tools: NativeAgentTool[], signal: AbortSignal): Promise<NativeMcp | undefined> {
  if (!tools.length) return undefined;
  signal.throwIfAborted();
  const authorization = 'Bearer ' + randomBytes(32).toString('base64url');
  const index = new Map(tools.map(tool => [tool.name, tool]));
  const server = createServer(async (request, response) => {
    function reply(status: number, body?: unknown) {
      if (response.destroyed) return;
      response.writeHead(status, { 'Cache-Control': 'no-store', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    }
    if (signal.aborted || request.url !== '/mcp' || request.headers.authorization !== authorization || request.headers.origin) {
      reply(403);
      return;
    }
    if (request.method !== 'POST') { reply(405); return; }
    let bytes = 0;
    const parts: Buffer[] = [];
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 512 * 1024) { reply(413); return; }
        parts.push(chunk);
      }
      const rpc = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') { reply(400); return; }
      if (rpc.id === undefined && rpc.method.startsWith('notifications/')) { reply(202); return; }
      if (typeof rpc.id !== 'string' && typeof rpc.id !== 'number') { reply(400); return; }
      const respond = (result: unknown) => reply(200, { jsonrpc: '2.0', id: rpc.id, result });
      if (rpc.method === 'initialize') {
        const version = ['2025-03-26', '2025-06-18', '2025-11-25'].includes(rpc.params?.protocolVersion)
          ? rpc.params.protocolVersion : '2025-11-25';
        respond({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'eterx', version: '1.0.0' } });
      } else if (rpc.method === 'ping') respond({});
      else if (rpc.method === 'tools/list') respond({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      else if (rpc.method === 'tools/call') {
        const tool = index.get(rpc.params?.name);
        if (!tool) { reply(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Unknown EterX tool.' } }); return; }
        try {
          signal.throwIfAborted();
          const text = await tool.execute(rpc.params?.arguments ?? {});
          respond({ content: [{ type: 'text', text }] });
        } catch {
          respond({ isError: true, content: [{ type: 'text', text: 'The EterX tool could not complete.' }] });
        }
      } else reply(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not available.' } });
    } catch { reply(400); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.unref();
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', dispose);
    server.close();
    server.closeAllConnections();
  };
  signal.addEventListener('abort', dispose, { once: true });
  const port = (server.address() as AddressInfo).port;
  if (signal.aborted) { dispose(); signal.throwIfAborted(); }
  return { url: 'http://127.0.0.1:' + port + '/mcp', authorization, dispose };
}

export const acpNativeMcp = (bridge: NativeMcp) =>
  ({ type: 'http', name: 'eterx', url: bridge.url, headers: [{ name: 'Authorization', value: bridge.authorization }] });
