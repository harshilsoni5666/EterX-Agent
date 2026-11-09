import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import { ToolDefinition } from '../../schemas';
import { getEterxDataDir } from '../../storage-paths';
import { enforceToolCapability } from '../security/tool_policy';

const GATEWAY_CONTROL_FILE = path.join(getEterxDataDir(), 'gateways', 'control.json');

async function callGateway(name: string, args: Record<string, unknown> = {}) {
  if (!await fs.pathExists(GATEWAY_CONTROL_FILE)) {
    throw new Error('The EterX background companion is not running. Open Channels → Communication, enable Background companion, configure the required service, and Save. Use Channels → Channel Agents to select its operating profile.');
  }
  const connection = await fs.readJson(GATEWAY_CONTROL_FILE);
  const response = await fetch(String(connection.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error || `Gateway request failed (${response.status}).`));
  return payload;
}

const compactMessage = (message: any) => ({
  id: message?.id,
  platform: message?.platform,
  receivedAt: message?.receivedAt,
  actor: message?.actor,
  text: message?.text,
  attachments: message?.attachments || [],
  direction: message?.direction || 'inbound',
});

function operatingGuide(profile: any) {
  return {
    identity: `${profile?.name || 'Channel agent'} (${profile?.role || 'custom'})`,
    objective: profile?.objective || 'Help with connected conversations when asked.',
    instructions: profile?.instructions || undefined,
    responseStyle: profile?.responseStyle,
    escalationRules: profile?.escalationRules,
    policy: {
      operatingMode: profile?.operatingMode || 'manual',
      readPolicy: profile?.readPolicy || 'on-demand',
      sendPolicy: profile?.sendPolicy || 'direct',
      channels: profile?.channels?.length ? profile.channels : 'all enabled channels',
    },
    workflow: [
      'Inspect status or inbox before making channel claims.',
      'Read the selected conversation before drafting or sending.',
      'Keep facts from connector results separate from assumptions.',
      'Follow sendPolicy exactly; never claim delivery unless send_reply succeeds.',
      'Escalate when the configured boundary applies.',
    ],
  };
}

async function loadProfile(profileId?: string) {
  const result = await callGateway('agent_profile_get', profileId ? { profile_id: profileId } : {});
  if (!result?.enabled) throw new Error('Channel Agent is disabled. Open Channels → Channel Agents, enable Tool available, review the profile, and Save.');
  if (!result?.profile) throw new Error(`Channel Agent profile${profileId ? ` "${profileId}"` : ''} was not found.`);
  return result;
}

function channelAllowed(profile: any, platform: string) {
  return !Array.isArray(profile?.channels) || profile.channels.length === 0 || profile.channels.includes(platform);
}

export const channelAgentTool: ToolDefinition = {
  name: 'channel_agent',
  description: 'On-demand playbook and high-level inbox tool for connected-channel work. Call first for sales, support, inbox, drafting, or replying across connected channels. Draft-only profiles never send. Direct-send profiles require an explicit user request, represented by confirm=true; autonomous profiles follow their configured send policy.',
  category: 'communication',
  inputSchema: z.object({
    action: z.enum(['guide', 'status', 'inbox', 'read', 'prepare_reply', 'send_reply']),
    profile_id: z.string().optional().describe('Configured Channel Agent profile. Omit to use the default profile.'),
    conversation_id: z.string().optional(),
    platform: z.string().optional(),
    search: z.string().optional(),
    unread_only: z.boolean().optional(),
    limit: z.number().optional(),
    text: z.string().optional().describe('Final reply text for send_reply.'),
    confirm: z.boolean().optional().describe('Set true only after the user requested this outbound reply.'),
  }),
  outputSchema: z.object({ success: z.boolean(), status: z.string(), results: z.any().optional() }),
  execute: async (input: any, context?: any) => {
    const decision = enforceToolCapability('channel_agent', input, context);
    if (!decision.allowed) return { success: false, status: decision.reason || 'Channel-agent access is not allowed.' };
    try {
      const profileState = await loadProfile(input.profile_id);
      const profile = profileState.profile;
      const guide = operatingGuide(profile);

      if (input.action === 'guide') {
        return { success: true, status: `Loaded ${profile.name}.`, results: { guide, availableProfiles: profileState.availableProfiles } };
      }

      if (input.action === 'status') {
        const channels = await callGateway('channels_list');
        const bound = channels.filter((item: any) => channelAllowed(profile, String(item.id || '')));
        return {
          success: true,
          status: `${profile.name} is configured for ${bound.filter((item: any) => item.enabled).length} enabled channel(s).`,
          results: { guide, channels: bound, readiness: bound.map((item: any) => ({ id: item.id, ready: item.enabled && ['connected', 'listening'].includes(item.state), state: item.state, error: item.lastError })) },
        };
      }

      if (input.action === 'inbox') {
        const conversations = await callGateway('conversations_list', { platform: input.platform, search: input.search });
        const unreadOnly = input.unread_only ?? profile.readPolicy === 'unread';
        const limit = Math.max(1, Math.min(100, Number(input.limit) || 25));
        const filtered = conversations
          .filter((item: any) => channelAllowed(profile, String(item.platform || '')))
          .filter((item: any) => !unreadOnly || Number(item.unreadCount || 0) > 0)
          .slice(0, limit);
        return { success: true, status: `Found ${filtered.length} matching conversation(s).`, results: { profile: { id: profile.id, name: profile.name, role: profile.role }, conversations: filtered, next: filtered.length ? 'Use read with a conversation_id before drafting or sending.' : 'No matching conversations are currently stored.' } };
      }

      if (!input.conversation_id) return { success: false, status: `conversation_id is required for ${input.action}.` };
      const conversation = await callGateway('conversation_get', { conversation_id: input.conversation_id });
      if (!conversation) return { success: false, status: `Conversation "${input.conversation_id}" was not found.` };
      if (!channelAllowed(profile, String(conversation.platform || ''))) return { success: false, status: `${conversation.platform} is outside the channels bound to ${profile.name}.` };
      const messages = (Array.isArray(conversation.messages) ? conversation.messages : []).map(compactMessage);

      if (input.action === 'read') {
        return { success: true, status: `Read ${messages.length} message(s) from ${conversation.title}.`, results: { conversation: { ...conversation, messages }, guide } };
      }

      if (input.action === 'prepare_reply') {
        return { success: true, status: `Prepared reply context for ${conversation.title}.`, results: { conversation: { ...conversation, messages }, guide, outputContract: 'Draft only the channel-ready reply. Do not send until requested. Respect escalationRules and do not invent customer, product, price, or policy facts.' } };
      }

      if (profile.sendPolicy === 'draft-only') return { success: false, status: `${profile.name} is configured as draft-only. Return the draft to the user instead of sending.` };
      const autonomousDelivery = profile.operatingMode === 'autonomous' && profile.sendPolicy === 'autonomous';
      if (!autonomousDelivery && input.confirm !== true) return { success: false, status: 'This profile sends only when requested. Return the draft, or set confirm=true after the user explicitly asks to send it.' };
      if (!String(input.text || '').trim()) return { success: false, status: 'text is required for send_reply.' };
      const sourceMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const source = [...sourceMessages].reverse().find((message: any) => message?.replyTarget && message?.platform === conversation.platform)
        || [...sourceMessages].reverse().find((message: any) => message?.replyTarget);
      if (!source?.replyTarget) return { success: false, status: 'No verified reply target is stored for this conversation. Read a newer inbound message or use gateway_bridge with an explicit target.' };
      const delivery = await callGateway('messages_send', { platform: conversation.platform, target: source.replyTarget, text: String(input.text).trim() });
      return { success: delivery?.ok === true, status: delivery?.ok === true ? `Reply delivered through ${conversation.platform} for ${conversation.title}.` : delivery?.retrying ? 'Delivery is pending and will be retried. Do not claim the reply was received.' : delivery?.error || 'The reply could not be delivered.', results: { delivery, conversationId: conversation.id, profileId: profile.id, autonomousDelivery } };
    } catch (error: any) {
      return { success: false, status: error?.message || String(error) };
    }
  },
};
