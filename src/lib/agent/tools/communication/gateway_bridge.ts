import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { callGateway } from '../../gateway-client';
import { enforceToolCapability } from '../security/tool_policy';
import { requireOutboundApproval } from './outbound_approval';

const APPROVAL_ACTIONS = new Set(['permissions_respond']);
export { callGateway } from '../../gateway-client';

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
- files_send: deliver file_path or file_paths (1–10 absolute paths) to Telegram. as_photo displays image previews; file_paths groups related previews/documents as an album. Albums of documents/audio must contain only that type; at most 50 MB per file and 100 MB per album. Use a short caption (under 1000 characters). Telegram bot runs automatically use their paired recipient. A successful upload confirms delivery; do not resend it in a final answer.
- channels_list: list configured platform connection states.
- agent_profile_get: load a configured Channel Agent profile on demand.
- permissions_list_open: list pending DM pairing requests.
- permissions_respond: approve or deny a pairing identity.`,
  category: 'communication',
  inputSchema: z.object({
    action: z.enum(['conversations_list', 'conversation_get', 'messages_read', 'attachments_fetch', 'events_poll', 'events_wait', 'messages_send', 'files_send', 'channels_list', 'agent_profile_get', 'permissions_list_open', 'permissions_respond']),
    platform: z.string().optional(),
    profile_id: z.string().optional(),
    search: z.string().optional(),
    conversation_id: z.string().optional(),
    message_id: z.string().optional(),
    after_cursor: z.number().optional(),
    timeout_ms: z.number().optional(),
    limit: z.number().optional(),
    target: z.record(z.string(), z.string()).optional(),
    text: z.string().optional(),
    file_path: z.string().optional(),
    file_paths: z.array(z.string()).min(1).max(10).optional().describe('An album of related files or previews. Use instead of file_path; preserve the intended order.'),
    caption: z.string().optional(),
    as_photo: z.boolean().optional(),
    media_type: z.enum(['document', 'video', 'audio']).optional().describe('Use video for an MP4 preview, audio for MP3/M4A playback, or document for the original file.'),
    identity_id: z.string().optional(),
    approved: z.boolean().optional(),
    confirm: z.boolean().optional().describe('Used only after approval for pairing/security changes. Gateway message sends do not request confirmation.'),
  }),
  outputSchema: z.object({ success: z.boolean(), status: z.string(), results: z.any().optional() }),
  execute: async (input: any, context?: any) => {
    const decision = enforceToolCapability('gateway_bridge', input, context);
    if (!decision.allowed) return { success: false, status: decision.reason || 'Gateway access is not allowed.' };
    if (APPROVAL_ACTIONS.has(input.action)) {
      const approval = await requireOutboundApproval('EterX Gateway', input.action, input, context, input.platform || input.identity_id, input.text || String(input.approved));
      if (approval) return approval;
    }
    try {
      const { action, confirm: _confirm, ...args } = input;
      if (action === 'files_send' && Boolean(args.file_path) === Boolean(args.file_paths?.length)) return { success: false, status: 'Provide either file_path or file_paths.' };
      if (context?.telegramBot && ['files_send', 'messages_send'].includes(action)) {
        args.target = context.telegramBot.target;
        args.platform = 'telegram';
      }
      const results = await callGateway(action, args);
      if (action === 'files_send' && context?.telegramBot) {
        for (const result of Array.isArray(results) ? results : [results]) {
          const file = result?.eterx_file;
          if (file?.path) context._onTrace?.({ type: 'telegram_file_sent', ...file });
        }
      }
      return { success: true, status: results?.retrying ? 'Delivery is pending and will be retried. Do not claim it was received yet.' : `Gateway action ${action} completed.`, results };
    } catch (error: any) {
      return { success: false, status: error?.message || String(error) };
    }
  },
};
