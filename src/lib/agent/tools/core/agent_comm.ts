import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { interAgentMailbox, MessageType } from '../../roles/inter_agent_comm';
import { agentMessageBus } from '../../roles/sub_agent';

const formatAgentMessage = (m: any) => ({
  id: m.id,
  from: m.from,
  to: m.to,
  type: m.type,
  subject: m.subject,
  body: m.body,
  read: m.read,
  readAt: m.readAt,
  timestamp: m.timestamp,
  priority: m.metadata?.priority || 'normal',
  filePaths: m.metadata?.filePaths,
  artifactPaths: m.metadata?.artifactPaths,
  tags: m.metadata?.tags,
  replyTo: m.metadata?.replyTo,
  requiresResponse: m.metadata?.requiresResponse === true,
  deliveryMode: m.metadata?.deliveryMode || 'defer',
  deliverAfter: m.metadata?.deliverAfter,
  scheduled: typeof m.metadata?.deliverAfter === 'number' ? m.metadata.deliverAfter > Date.now() : false,
  confidence: m.metadata?.confidence,
  subAgentId: m.metadata?.subAgentId,
  subAgentChatId: m.metadata?.subAgentChatId,
  ageSeconds: Math.round((Date.now() - m.timestamp) / 1000),
});

const buildMessageMetadata = (input: any, defaults?: {
  priority?: 'low' | 'normal' | 'high' | 'critical';
  deliveryMode?: 'interrupt' | 'defer' | 'silent';
  requiresResponse?: boolean;
  replyTo?: string;
  subAgentId?: string;
  subAgentChatId?: string;
}, context?: any) => {
  const deliverAfterMs = typeof input.deliverAfterMs === 'number'
    ? Date.now() + Math.max(0, Math.min(input.deliverAfterMs, 86_400_000))
    : undefined;
  const deliverAt = typeof input.deliverAt === 'number' && Number.isFinite(input.deliverAt)
    ? input.deliverAt
    : undefined;

  return {
    priority: input.priority || defaults?.priority || 'normal',
    filePaths: input.filePaths,
    artifactPaths: input.artifactPaths,
    tags: input.tags,
    requiresResponse: input.requiresResponse ?? defaults?.requiresResponse,
    deliveryMode: input.deliveryMode || defaults?.deliveryMode || 'defer',
    confidence: typeof input.confidence === 'number' ? input.confidence : undefined,
    replyTo: defaults?.replyTo,
    deliverAfter: deliverAt ?? deliverAfterMs,
    subAgentId: context?.subAgentId || defaults?.subAgentId,
    subAgentChatId: context?.subAgentChatId || defaults?.subAgentChatId,
  };
};

/**
 * Agent Communication Tool v1.0
 * 
 * Gives any agent (main or sub) the ability to:
 * - Send messages to other agents
 * - Check their mailbox for messages from other agents
 * - Reply to questions from other agents
 * - Broadcast discoveries to all agents
 * 
 * This enables TRUE multi-agent collaboration — agents can coordinate,
 * share findings, ask each other questions, and hand off work.
 */
export const agentCommTool: ToolDefinition = {
  name: 'agent_communicate',
  description: `Send or receive messages to/from other agents. Use this for multi-agent collaboration.

ACTIONS:
- "send": Send a message to a specific agent or broadcast to all ('*')
- "schedule": Send a message that becomes visible after deliverAfterMs or deliverAt
- "check": Check your mailbox for messages from other agents
- "reply": Reply to a specific message by ID
- "broadcast": Send a discovery/alert to ALL agents at once
- "ask_main": Ask Main for clarification, approval, or a merge decision
- "handoff_main": Send completed partial work, blockers, or evidence to Main
- "status": See the active/planned team roster, each agent's task/progress, and mailbox status
- "history": Read recent visible inter-agent messages without marking them read
- "thread": Read a message thread by ID
- "mark_read": Mark specific messages or the current mailbox as read

MESSAGE TYPES:
- info_share: Share useful information you discovered
- question: Ask another agent for help/input
- answer: Respond to a question
- alert: Urgent finding or blocker
- coordination: "I'm handling X, you do Y"
- discovery: Something unexpected you found
- progress: Status update on your work
- handoff: Pass work/context to another agent

WHEN TO USE:
- You found something another agent needs → send info_share
- You're stuck and another agent might know → send question
- You found a critical bug/issue → broadcast alert
- You finished your part of a parallel task → send handoff
- You need direction from Main/user during work → ask_main
- Before starting work, check if other agents left you messages → check`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['send', 'schedule', 'check', 'reply', 'broadcast', 'ask_main', 'handoff_main', 'status', 'history', 'thread', 'mark_read']).describe('What to do'),
    to: z.string().optional().describe('Recipient agent name (for send/reply). Use "*" for broadcast.'),
    type: z.enum(['info_share', 'question', 'answer', 'alert', 'coordination', 'discovery', 'progress', 'handoff']).optional().describe('Message type'),
    subject: z.string().optional().describe('Short summary of the message (max 100 chars)'),
    body: z.string().optional().describe('Full message content'),
    replyToId: z.string().optional().describe('Message ID to reply to (for reply action)'),
    from: z.string().optional().describe('Filter by sender for history/check'),
    priority: z.enum(['low', 'normal', 'high', 'critical']).optional().describe('Message priority'),
    filePaths: z.array(z.string()).optional().describe('Related file paths to share'),
    artifactPaths: z.array(z.string()).optional().describe('Artifacts or outputs related to this message'),
    tags: z.array(z.string()).optional().describe('Short routing or topic tags'),
    requiresResponse: z.boolean().optional().describe('Whether this message should interrupt the recipient at the next safe boundary'),
    deliveryMode: z.enum(['interrupt', 'defer', 'silent']).optional().describe('interrupt = stop at safe boundary, defer = show/queue without disrupting work, silent = history only'),
    deliverAfterMs: z.number().int().min(0).max(86400000).optional().describe('Delay delivery by this many milliseconds'),
    deliverAt: z.number().optional().describe('Absolute Unix epoch milliseconds when this message should become visible'),
    confidence: z.number().min(0).max(1).optional().describe('Optional sender confidence for findings or answers'),
    messageId: z.string().optional().describe('Message ID for thread lookup'),
    messageIds: z.array(z.string()).optional().describe('Message IDs for mark_read'),
    autoMarkRead: z.boolean().optional().default(true).describe('Whether check marks returned messages as read'),
    unreadOnly: z.boolean().optional().default(true).describe('Only show unread messages (for check)'),
    includeAll: z.boolean().optional().describe('For Main/status/history, include all project-visible messages'),
    limit: z.number().optional().default(10).describe('Max messages to return (for check)')
  }),
  outputSchema: z.any(),
  execute: async (input: any, context?: any) => {
    const projectId = context?.projectId || context?.chatId || 'default';
    const myName = context?.agentName || context?.subAgentName || 'Main';

    try {
      switch (input.action) {
        case 'send':
        case 'schedule': {
          if (!input.to || !input.subject || !input.body) {
            return { success: false, message: 'Required: to, subject, body' };
          }
          if (input.action === 'schedule' && typeof input.deliverAfterMs !== 'number' && typeof input.deliverAt !== 'number') {
            return { success: false, message: 'Required for schedule: deliverAfterMs or deliverAt' };
          }
          const msg = interAgentMailbox.send({
            from: myName,
            to: input.to,
            projectId,
            type: (input.type || 'info_share') as MessageType,
            subject: input.subject.substring(0, 100),
            body: input.body,
            metadata: buildMessageMetadata(input, undefined, context),
          });
          return {
            success: true,
            messageId: msg.id,
            scheduled: input.action === 'schedule',
            deliverAfter: msg.metadata?.deliverAfter,
            message: input.action === 'schedule'
              ? `Message scheduled for ${input.to}: "${input.subject}"`
              : `Message sent to ${input.to}: "${input.subject}"`
          };
        }

        case 'check': {
          const messages = interAgentMailbox.checkMailbox(projectId, myName, {
            unreadOnly: input.unreadOnly !== false,
            type: input.type as MessageType | undefined,
            from: input.from,
            limit: input.limit || 10,
          });
          
          // Auto-mark as read by default, but callers can inspect safely.
          if (messages.length > 0 && input.autoMarkRead !== false) {
            interAgentMailbox.markRead(projectId, myName, messages.map((m: any) => m.id));
          }

          return {
            success: true,
            unreadCount: messages.length,
            messages: messages.map(formatAgentMessage),
            message: messages.length > 0
              ? `📬 ${messages.length} message(s) in your mailbox`
              : '📭 No unread messages'
          };
        }

        case 'reply': {
          if (!input.replyToId || !input.body) {
            return { success: false, message: 'Required: replyToId, body' };
          }
          // Find the original message to get the sender
          const allMsgs = interAgentMailbox.checkMailbox(projectId, myName, { unreadOnly: false });
          const original = allMsgs.find((m: any) => m.id === input.replyToId);
          if (!original) {
            return { success: false, message: `Message ${input.replyToId} not found` };
          }
          const reply = interAgentMailbox.send({
            from: myName,
            to: original.from,
            projectId,
            type: 'answer',
            subject: `Re: ${original.subject}`.substring(0, 100),
            body: input.body,
            metadata: buildMessageMetadata(input, {
              priority: input.priority || original.metadata?.priority || 'normal',
              deliveryMode: input.deliveryMode || original.metadata?.deliveryMode || 'defer',
              replyTo: input.replyToId,
              subAgentId: original.metadata?.subAgentId,
              subAgentChatId: original.metadata?.subAgentChatId,
            }, context),
          });
          return {
            success: true,
            messageId: reply.id,
            message: `📨 Reply sent to ${original.from}: "${reply.subject}"`
          };
        }

        case 'broadcast': {
          if (!input.subject || !input.body) {
            return { success: false, message: 'Required: subject, body' };
          }
          const msg = interAgentMailbox.send({
            from: myName,
            to: '*',
            projectId,
            type: (input.type || 'discovery') as MessageType,
            subject: input.subject.substring(0, 100),
            body: input.body,
            metadata: buildMessageMetadata(input, {
              deliveryMode: input.deliveryMode || ((input.priority === 'critical' || input.type === 'alert') ? 'interrupt' : 'defer'),
            }, context),
          });
          return {
            success: true,
            messageId: msg.id,
            message: `📢 Broadcast sent to all agents: "${input.subject}"`
          };
        }

        case 'ask_main': {
          if (!input.subject || !input.body) {
            return { success: false, message: 'Required: subject, body' };
          }
          const msg = interAgentMailbox.send({
            from: myName,
            to: 'Main',
            projectId,
            type: 'question',
            subject: input.subject.substring(0, 100),
            body: input.body,
            metadata: buildMessageMetadata(input, {
              priority: input.priority || 'high',
              deliveryMode: input.deliveryMode || 'interrupt',
              requiresResponse: input.requiresResponse ?? true,
            }, context),
          });
          return {
            success: true,
            messageId: msg.id,
            message: `Question sent to Main: "${input.subject}"`
          };
        }

        case 'handoff_main': {
          if (!input.subject || !input.body) {
            return { success: false, message: 'Required: subject, body' };
          }
          const msg = interAgentMailbox.send({
            from: myName,
            to: 'Main',
            projectId,
            type: (input.type || 'handoff') as MessageType,
            subject: input.subject.substring(0, 100),
            body: input.body,
            metadata: buildMessageMetadata(input, {
              deliveryMode: input.deliveryMode || 'defer',
              requiresResponse: input.requiresResponse ?? false,
            }, context),
          });
          return {
            success: true,
            messageId: msg.id,
            message: `Handoff sent to Main: "${input.subject}"`
          };
        }

        case 'status': {
          const summaries = interAgentMailbox.getMailboxSummaries(projectId);
          const mailboxByName = new Map(
            summaries.map((summary: any) => [String(summary.agentName).toLowerCase(), summary])
          );
          const teamSnapshot = interAgentMailbox.getTeamSnapshot(projectId);
          const diskStatuses = await agentMessageBus.readAllStatuses(projectId);
          const diskStatusByName = new Map<string, any>();
          for (const [name, status] of Object.entries(diskStatuses) as Array<[string, any]>) {
            diskStatusByName.set(String(status.agentName || name).toLowerCase(), status);
          }

          const rosterNames = new Set<string>([
            ...teamSnapshot.map(agent => agent.agentName),
            ...summaries.map((summary: any) => summary.agentName),
            ...Array.from(diskStatusByName.values()).map((status: any) => status.agentName || ''),
          ].filter(Boolean));

          const agents = Array.from(rosterNames).map((agentName) => {
            const key = agentName.toLowerCase();
            const presence = teamSnapshot.find(agent => agent.agentName.toLowerCase() === key);
            const mailbox = mailboxByName.get(key);
            const disk = diskStatusByName.get(key);
            return {
              agentName,
              role: presence?.role || (key === 'main' ? 'main' : 'sub_agent'),
              status: disk?.status || presence?.status || 'registered',
              task: disk?.task || presence?.task,
              progress: disk?.progress || presence?.progress,
              unreadCount: mailbox?.unreadCount || 0,
              totalMessages: mailbox?.totalCount || 0,
              latestMessage: mailbox?.latestMessage,
              recentActions: disk?.traceLog?.slice(-3) || [],
              updatedAt: presence?.updatedAt || disk?.updatedAt,
            };
          });
          const runningCount = agents.filter((agent: any) => ['running', 'working', 'planned', 'paused'].includes(agent.status)).length;
          return {
            success: true,
            agents,
            mailboxes: summaries,
            team: teamSnapshot,
            message: `${agents.length} agent(s) visible. ${runningCount} active/planned/paused. ${summaries.reduce((sum: number, s: any) => sum + s.unreadCount, 0)} total unread messages.`
          };
        }

        case 'history': {
          const messages = interAgentMailbox.getProjectMessages(projectId, {
            agentName: input.includeAll ? undefined : myName,
            type: input.type as MessageType | undefined,
            from: input.from,
            to: input.to,
            limit: input.limit || 25,
          });

          return {
            success: true,
            count: messages.length,
            messages: messages.map(formatAgentMessage),
            message: `${messages.length} visible inter-agent message(s) returned.`
          };
        }

        case 'thread': {
          const messageId = input.messageId || input.replyToId;
          if (!messageId) {
            return { success: false, message: 'Required: messageId or replyToId' };
          }

          const normalizedName = String(myName).toLowerCase();
          const thread = interAgentMailbox.getThread(projectId, messageId)
            .filter((message: any) => input.includeAll ||
              String(message.from).toLowerCase() === normalizedName ||
              String(message.to).toLowerCase() === normalizedName ||
              message.to === '*');

          return {
            success: true,
            count: thread.length,
            messages: thread.map(formatAgentMessage),
            message: `Thread ${messageId} has ${thread.length} visible message(s).`
          };
        }

        case 'mark_read': {
          const count = interAgentMailbox.markRead(projectId, myName, input.messageIds);
          return {
            success: true,
            markedRead: count,
            message: input.messageIds?.length
              ? `${count} selected message(s) marked read.`
              : `${count} message(s) marked read.`
          };
        }

        default:
          return { success: false, message: `Unknown action: ${input.action}` };
      }
    } catch (err: any) {
      return { success: false, message: `Communication error: ${err.message}` };
    }
  }
};
