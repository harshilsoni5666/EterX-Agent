import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import { ToolDefinition } from '../../schemas';
import { getEterxDataDir } from '../../storage-paths';
import { enforceToolCapability } from '../security/tool_policy';
import { requireOutboundApproval } from './outbound_approval';

const GATEWAY_CONTROL_FILE = path.join(getEterxDataDir(), 'gateways', 'control.json');
const WRITE_ACTIONS = new Set(['messages_send', 'permissions_respond']);

async function callGateway(name: string, args: Record<string, unknown>) {
  if (!await fs.pathExists(GATEWAY_CONTROL_FILE)) throw new Error('The EterX gateway is not configured or running. Open Channels → Go to gateway.');
  const connection = await fs.readJson(GATEWAY_CONTROL_FILE);
  const response = await fetch(String(connection.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(name === 'events_wait' ? 35000 : 15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error || `Gateway request failed (${response.status}).`));
  return payload;
}

export const gatewayBridgeTool: ToolDefinition = {
  name: 'gateway_bridge',
  description: `Read and operate EterX messaging gateway conversations across connected platforms.

Actions:
- conversations_list: list persistent conversations, optionally filtered by platform/search.
- conversation_get: get one conversation and recent messages.
- messages_read: read messages for conversation_id.
- attachments_fetch: list attachments for message_id.
- events_poll / events_wait: receive normalized new-message events using after_cursor.
- messages_send: send text using platform and the adapter-specific target object.
- channels_list: list configured platform connection states.
- permissions_list_open: list pending DM pairing requests.
- permissions_respond: approve or deny a pairing identity.`,
  category: 'communication',
  inputSchema: z.object({
    action: z.enum(['conversations_list', 'conversation_get', 'messages_read', 'attachments_fetch', 'events_poll', 'events_wait', 'messages_send', 'channels_list', 'permissions_list_open', 'permissions_respond']),
    platform: z.string().optional(),
    search: z.string().optional(),
    conversation_id: z.string().optional(),
    message_id: z.string().optional(),
    after_cursor: z.number().optional(),
    timeout_ms: z.number().optional(),
    limit: z.number().optional(),
    target: z.record(z.string(), z.string()).optional(),
    text: z.string().optional(),
    identity_id: z.string().optional(),
    approved: z.boolean().optional(),
    confirm: z.boolean().optional().describe('Required true for sending messages or resolving pairing approvals.'),
  }),
  outputSchema: z.object({ success: z.boolean(), status: z.string(), results: z.any().optional() }),
  execute: async (input: any, context?: any) => {
    const decision = enforceToolCapability('gateway_bridge', input, context);
    if (!decision.allowed) return { success: false, status: decision.reason || 'Gateway access is not allowed.' };
    if (WRITE_ACTIONS.has(input.action)) {
      const approval = await requireOutboundApproval('EterX Gateway', input.action, input, context, input.platform || input.identity_id, input.text || String(input.approved));
      if (approval) return approval;
    }
    try {
      const { action, confirm: _confirm, ...args } = input;
      const results = await callGateway(action, args);
      return { success: true, status: `Gateway action ${action} completed.`, results };
    } catch (error: any) {
      return { success: false, status: error?.message || String(error) };
    }
  },
};
