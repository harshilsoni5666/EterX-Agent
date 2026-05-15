import { z } from 'zod';
import { ToolDefinition } from '../../schemas';

/**
 * Full-Power Slack Connector Tool
 * Deep agent integration — send, read, search, react, upload, manage channels/users.
 */

let WebClient: any = null;
let slackAvailable = false;

try {
  const dynamicRequire = eval('require');
  const { WebClient: SlackWebClient } = dynamicRequire('@slack/web-api');
  WebClient = SlackWebClient;
  slackAvailable = true;
} catch {
  console.warn('[Slack] @slack/web-api not yet available.');
}

// ─── Token resolution: OAuth file > env var ──────────────
async function getSlackToken(): Promise<string | null> {
  try {
    const fsExtra = eval('require')('fs-extra');
    const pathMod = eval('require')('path');
    const connectorsFile = pathMod.resolve(process.cwd(), '.workspaces', '.connectors.json');
    if (await fsExtra.pathExists(connectorsFile)) {
      const connectors = await fsExtra.readJson(connectorsFile);
      if (connectors?.slack?.accessToken) return connectors.slack.accessToken;
    }
  } catch { }
  return process.env.SLACK_ACCESS_TOKEN || null;
}

// ─── Resolve channel name → ID ───────────────────────────
async function resolveChannel(client: any, channel: string): Promise<string> {
  if (!channel.startsWith('#')) return channel;
  const name = channel.substring(1);
  const list = await client.conversations.list({ types: 'public_channel,private_channel', limit: 200 });
  const match = list.channels?.find((c: any) => c.name === name);
  return match?.id || channel;
}

export const slackControllerTool: ToolDefinition = {
  name: 'slack_controller',
  description: `Full-power Slack Integration — the agent can read, write, search, and manage Slack workspaces.

Available actions:
- status: Check if Slack is connected, get workspace/user info.
- list_channels: List all channels (public + private). Returns id, name, member count.
- read: Read recent messages from a channel. Use 'channel' and optional 'limit'.
- send: Send a message to a channel. Use 'channel' (#name or ID) and 'message'.
- send_rich: Send a message with Block Kit formatting. Use 'channel', 'message', and 'blocks' (JSON array).
- reply: Reply in a thread. Use 'channel', 'thread_ts', and 'message'.
- react: Add emoji reaction to a message. Use 'channel', 'thread_ts' (message ts), and 'emoji' (e.g. "thumbsup").
- search: Search messages across the workspace. Use 'query'.
- upload: Upload a file or text snippet. Use 'channel', 'content' (text), and 'filename'.
- list_users: List all workspace members.
- user_info: Get user profile by 'userId'.
- create_channel: Create a new channel. Use 'channel_name' and optional 'is_private'.
- invite_user: Invite user to channel. Use 'channel' and 'userId'.
- pin: Pin a message to a channel. Use 'channel' and 'thread_ts'.
- delete_message: Delete a message. Use 'channel' and 'thread_ts'.
- set_topic: Set channel topic. Use 'channel' and 'topic'.
- get_thread: Get all replies in a thread. Use 'channel' and 'thread_ts'.`,

  category: 'communication',

  inputSchema: z.object({
    action: z.enum([
      'status', 'list_channels', 'read', 'send', 'send_rich', 'reply',
      'react', 'search', 'upload', 'list_users', 'user_info',
      'create_channel', 'invite_user', 'pin', 'delete_message',
      'set_topic', 'get_thread'
    ]),
    channel: z.string().optional().describe('Channel name (#general) or ID (C12345)'),
    channel_name: z.string().optional().describe('Name for new channel (no # prefix)'),
    message: z.string().optional().describe('Text message to send'),
    blocks: z.string().optional().describe('Block Kit JSON array string for rich messages'),
    thread_ts: z.string().optional().describe('Timestamp of the message to reply to / react to'),
    emoji: z.string().optional().describe('Emoji name without colons, e.g. "thumbsup"'),
    query: z.string().optional().describe('Search query string'),
    content: z.string().optional().describe('File content to upload as a snippet'),
    file_path: z.string().optional().describe('Local absolute path to a file to upload'),
    filename: z.string().optional().describe('Filename for upload, e.g. "report.txt"'),
    userId: z.string().optional().describe('Slack User ID'),
    is_private: z.boolean().optional().describe('Whether to create a private channel'),
    topic: z.string().optional().describe('Channel topic text'),
    limit: z.number().optional().default(20).describe('Max items to return'),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    status: z.string(),
    results: z.any().optional()
  }),

  execute: async (input: any) => {
    try {
      if (!slackAvailable) {
        return { success: false, status: 'Slack SDK not installed. Run: npm install @slack/web-api' };
      }

      const token = await getSlackToken();
      if (!token) {
        return { success: false, status: 'Slack not connected. Use the Slack button in the input bar to connect.' };
      }

      const client = new WebClient(token);
      const limit = input.limit || 20;

      // ── STATUS ──────────────────────────────────────────
      if (input.action === 'status') {
        const auth = await client.auth.test();
        return {
          success: true,
          status: `Connected to Slack workspace: ${auth.team}`,
          results: { team: auth.team, teamId: auth.team_id, user: auth.user, userId: auth.user_id, url: auth.url }
        };
      }

      // ── LIST CHANNELS ────────────────────────────────────
      if (input.action === 'list_channels') {
        const result = await client.conversations.list({ types: 'public_channel,private_channel', limit: 200 });
        const channels = result.channels?.map((c: any) => ({
          id: c.id, name: c.name, is_private: c.is_private,
          num_members: c.num_members, topic: c.topic?.value, purpose: c.purpose?.value
        })) || [];
        return { success: true, status: `Found ${channels.length} channels.`, results: channels };
      }

      // ── READ MESSAGES ────────────────────────────────────
      if (input.action === 'read') {
        if (!input.channel) return { success: false, status: 'Missing channel.' };
        const ch = await resolveChannel(client, input.channel);
        const result = await client.conversations.history({ channel: ch, limit });
        const messages = result.messages?.map((m: any) => ({
          user: m.user, text: m.text, ts: m.ts,
          date: new Date(parseFloat(m.ts) * 1000).toISOString(),
          reply_count: m.reply_count || 0,
          reactions: m.reactions?.map((r: any) => `${r.name}(${r.count})`) || []
        })) || [];
        return { success: true, status: `Read ${messages.length} messages from ${input.channel}.`, results: messages };
      }

      // ── SEND MESSAGE ─────────────────────────────────────
      if (input.action === 'send') {
        if (!input.channel || !input.message) return { success: false, status: 'Missing channel or message.' };
        const ch = await resolveChannel(client, input.channel);
        let finalMessage = input.message;
        if (!finalMessage.endsWith('\u200B')) finalMessage += '\u200B';
        const result = await client.chat.postMessage({ channel: ch, text: finalMessage });
        return { success: true, status: `Message sent to ${input.channel}.`, results: { ts: result.ts, channel: result.channel } };
      }

      // ── SEND RICH (Block Kit) ─────────────────────────────
      if (input.action === 'send_rich') {
        if (!input.channel) return { success: false, status: 'Missing channel.' };
        const ch = await resolveChannel(client, input.channel);
        const blocks = input.blocks ? JSON.parse(input.blocks) : undefined;
        let finalMessage = input.message || ' ';
        if (!finalMessage.endsWith('\u200B')) finalMessage += '\u200B';
        const result = await client.chat.postMessage({
          channel: ch, text: finalMessage, blocks
        });
        return { success: true, status: `Rich message sent to ${input.channel}.`, results: { ts: result.ts } };
      }

      // ── THREAD REPLY ─────────────────────────────────────
      if (input.action === 'reply') {
        if (!input.channel || !input.message || !input.thread_ts) {
          return { success: false, status: 'Missing channel, message, or thread_ts.' };
        }
        const ch = await resolveChannel(client, input.channel);
        let finalMessage = input.message;
        if (!finalMessage.endsWith('\u200B')) finalMessage += '\u200B';
        const result = await client.chat.postMessage({
          channel: ch, text: finalMessage, thread_ts: input.thread_ts
        });
        return { success: true, status: 'Thread reply sent.', results: { ts: result.ts } };
      }

      // ── REACT ────────────────────────────────────────────
      if (input.action === 'react') {
        if (!input.channel || !input.thread_ts || !input.emoji) {
          return { success: false, status: 'Missing channel, thread_ts, or emoji.' };
        }
        const ch = await resolveChannel(client, input.channel);
        await client.reactions.add({ channel: ch, timestamp: input.thread_ts, name: input.emoji });
        return { success: true, status: `Reacted with :${input.emoji}: on message.` };
      }

      // ── SEARCH ───────────────────────────────────────────
      if (input.action === 'search') {
        if (!input.query) return { success: false, status: 'Missing query.' };
        const result = await client.search.messages({ query: input.query, count: limit });
        const matches = result.messages?.matches?.map((m: any) => ({
          text: m.text, channel: m.channel?.name,
          user: m.username, ts: m.ts,
          date: new Date(parseFloat(m.ts) * 1000).toISOString(),
          permalink: m.permalink
        })) || [];
        return { success: true, status: `Found ${matches.length} results for "${input.query}".`, results: matches };
      }

      // ── UPLOAD FILE / SNIPPET ────────────────────────────
      if (input.action === 'upload') {
        if (!input.channel) return { success: false, status: 'Missing channel.' };
        if (!input.content && !input.file_path) return { success: false, status: 'Missing content or file_path.' };
        
        const ch = await resolveChannel(client, input.channel);
        const fsExtra = eval('require')('fs-extra');
        const pathMod = eval('require')('path');
        
        let fileContent = input.content;
        let finalFilename = input.filename || 'agent_output.txt';

        if (input.file_path) {
          const absolutePath = pathMod.isAbsolute(input.file_path) ? input.file_path : pathMod.resolve(process.cwd(), input.file_path);
          if (await fsExtra.pathExists(absolutePath)) {
            fileContent = await fsExtra.readFile(absolutePath);
            finalFilename = input.filename || pathMod.basename(absolutePath);
          } else {
            return { success: false, status: `File not found: ${input.file_path}` };
          }
        }

        const result = await client.files.uploadV2({
          channel_id: ch,
          initial_comment: `Autonomous update: ${finalFilename}\u200B`,
          thread_ts: input.thread_ts,
          file: fileContent,
          filename: finalFilename,
          title: finalFilename
        });
        
        return { success: true, status: `File "${finalFilename}" uploaded to ${input.channel}${input.thread_ts ? ' thread' : ''}.`, results: result.file };
      }

      // ── LIST USERS ───────────────────────────────────────
      if (input.action === 'list_users') {
        const result = await client.users.list({ limit: 200 });
        const users = result.members?.filter((u: any) => !u.is_bot && !u.deleted).map((u: any) => ({
          id: u.id, name: u.name, real_name: u.real_name,
          display_name: u.profile?.display_name, email: u.profile?.email,
          is_admin: u.is_admin
        })) || [];
        return { success: true, status: `Found ${users.length} active users.`, results: users };
      }

      // ── USER INFO ────────────────────────────────────────
      if (input.action === 'user_info') {
        if (!input.userId) return { success: false, status: 'Missing userId.' };
        const result = await client.users.info({ user: input.userId });
        return { success: true, status: 'User info retrieved.', results: result.user };
      }

      // ── CREATE CHANNEL ───────────────────────────────────
      if (input.action === 'create_channel') {
        if (!input.channel_name) return { success: false, status: 'Missing channel_name.' };
        const result = await client.conversations.create({
          name: input.channel_name, is_private: input.is_private || false
        });
        return { success: true, status: `Channel #${input.channel_name} created.`, results: { id: result.channel?.id, name: result.channel?.name } };
      }

      // ── INVITE USER ──────────────────────────────────────
      if (input.action === 'invite_user') {
        if (!input.channel || !input.userId) return { success: false, status: 'Missing channel or userId.' };
        const ch = await resolveChannel(client, input.channel);
        await client.conversations.invite({ channel: ch, users: input.userId });
        return { success: true, status: `User ${input.userId} invited to ${input.channel}.` };
      }

      // ── PIN MESSAGE ──────────────────────────────────────
      if (input.action === 'pin') {
        if (!input.channel || !input.thread_ts) return { success: false, status: 'Missing channel or thread_ts.' };
        const ch = await resolveChannel(client, input.channel);
        await client.pins.add({ channel: ch, timestamp: input.thread_ts });
        return { success: true, status: 'Message pinned.' };
      }

      // ── DELETE MESSAGE ───────────────────────────────────
      if (input.action === 'delete_message') {
        if (!input.channel || !input.thread_ts) return { success: false, status: 'Missing channel or thread_ts.' };
        const ch = await resolveChannel(client, input.channel);
        await client.chat.delete({ channel: ch, ts: input.thread_ts });
        return { success: true, status: 'Message deleted.' };
      }

      // ── SET TOPIC ────────────────────────────────────────
      if (input.action === 'set_topic') {
        if (!input.channel || !input.topic) return { success: false, status: 'Missing channel or topic.' };
        const ch = await resolveChannel(client, input.channel);
        await client.conversations.setTopic({ channel: ch, topic: input.topic });
        return { success: true, status: `Topic updated in ${input.channel}.` };
      }

      // ── GET THREAD ───────────────────────────────────────
      if (input.action === 'get_thread') {
        if (!input.channel || !input.thread_ts) return { success: false, status: 'Missing channel or thread_ts.' };
        const ch = await resolveChannel(client, input.channel);
        const result = await client.conversations.replies({ channel: ch, ts: input.thread_ts, limit });
        const replies = result.messages?.map((m: any) => ({
          user: m.user, text: m.text, ts: m.ts,
          date: new Date(parseFloat(m.ts) * 1000).toISOString()
        })) || [];
        return { success: true, status: `Got ${replies.length} messages in thread.`, results: replies };
      }

      return { success: false, status: `Unknown action: ${input.action}` };

    } catch (err: any) {
      return { success: false, status: `Slack Error: ${err.message}` };
    }
  }
};
