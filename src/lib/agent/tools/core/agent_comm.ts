import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { interAgentMailbox, MessageType } from '../../roles/inter_agent_comm';

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
- "check": Check your mailbox for messages from other agents
- "reply": Reply to a specific message by ID
- "broadcast": Send a discovery/alert to ALL agents at once
- "status": See which agents are active and their mailbox status

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
- Before starting work, check if other agents left you messages → check`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['send', 'check', 'reply', 'broadcast', 'status']).describe('What to do'),
    to: z.string().optional().describe('Recipient agent name (for send/reply). Use "*" for broadcast.'),
    type: z.enum(['info_share', 'question', 'answer', 'alert', 'coordination', 'discovery', 'progress', 'handoff']).optional().describe('Message type'),
    subject: z.string().optional().describe('Short summary of the message (max 100 chars)'),
    body: z.string().optional().describe('Full message content'),
    replyToId: z.string().optional().describe('Message ID to reply to (for reply action)'),
    priority: z.enum(['low', 'normal', 'high', 'critical']).optional().describe('Message priority'),
    filePaths: z.array(z.string()).optional().describe('Related file paths to share'),
    unreadOnly: z.boolean().optional().default(true).describe('Only show unread messages (for check)'),
    limit: z.number().optional().default(10).describe('Max messages to return (for check)')
  }),
  outputSchema: z.any(),
  execute: async (input: any, context?: any) => {
    const projectId = context?.projectId || context?.chatId || 'default';
    const myName = context?.agentName || context?.subAgentName || 'Main';

    try {
      switch (input.action) {
        case 'send': {
          if (!input.to || !input.subject || !input.body) {
            return { success: false, message: 'Required: to, subject, body' };
          }
          const msg = interAgentMailbox.send({
            from: myName,
            to: input.to,
            projectId,
            type: (input.type || 'info_share') as MessageType,
            subject: input.subject.substring(0, 100),
            body: input.body,
            metadata: {
              priority: input.priority || 'normal',
              filePaths: input.filePaths,
            },
          });
          return {
            success: true,
            messageId: msg.id,
            message: `📨 Message sent to ${input.to}: "${input.subject}"`
          };
        }

        case 'check': {
          const messages = interAgentMailbox.checkMailbox(projectId, myName, {
            unreadOnly: input.unreadOnly !== false,
            limit: input.limit || 10,
          });
          
          // Auto-mark as read
          if (messages.length > 0) {
            interAgentMailbox.markRead(projectId, myName, messages.map((m: any) => m.id));
          }

          return {
            success: true,
            unreadCount: messages.length,
            messages: messages.map((m: any) => ({
              id: m.id,
              from: m.from,
              type: m.type,
              subject: m.subject,
              body: m.body,
              priority: m.metadata?.priority || 'normal',
              filePaths: m.metadata?.filePaths,
              ageSeconds: Math.round((Date.now() - m.timestamp) / 1000),
            })),
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
            metadata: {
              priority: input.priority || 'normal',
              replyTo: input.replyToId,
            },
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
            metadata: {
              priority: input.priority || 'normal',
              filePaths: input.filePaths,
            },
          });
          return {
            success: true,
            messageId: msg.id,
            message: `📢 Broadcast sent to all agents: "${input.subject}"`
          };
        }

        case 'status': {
          const summaries = interAgentMailbox.getMailboxSummaries(projectId);
          return {
            success: true,
            agents: summaries,
            message: `${summaries.length} agent mailboxes active. ${summaries.reduce((sum: number, s: any) => sum + s.unreadCount, 0)} total unread messages.`
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
