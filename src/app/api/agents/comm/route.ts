import { NextRequest, NextResponse } from 'next/server';
import { interAgentMailbox, type MessageType } from '@/lib/agent/roles/inter_agent_comm';
import { agentMessageBus } from '@/lib/agent/roles/sub_agent';
import {
  attachAgentApiSessionCookie,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  parseInteger,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../../agent/_shared';

/**
 * Inter-Agent Communication API
 * 
 * GET  /api/agents/comm?projectId=...&agentName=...  → Check mailbox / get status
 * POST /api/agents/comm                               → Send message / broadcast
 */

type MessagePriority = 'low' | 'normal' | 'high' | 'critical';
type DeliveryMode = 'interrupt' | 'defer' | 'silent';

const MESSAGE_TYPES: readonly MessageType[] = [
  'info_share',
  'question',
  'answer',
  'alert',
  'coordination',
  'discovery',
  'progress',
  'handoff',
];

const MESSAGE_PRIORITIES: readonly MessagePriority[] = ['low', 'normal', 'high', 'critical'];
const DELIVERY_MODES: readonly DeliveryMode[] = ['interrupt', 'defer', 'silent'];

function normalizeMessageType(value: string, fallback: MessageType): MessageType {
  return MESSAGE_TYPES.includes(value as MessageType) ? value as MessageType : fallback;
}

function normalizePriority(value: string): MessagePriority {
  return MESSAGE_PRIORITIES.includes(value as MessagePriority) ? value as MessagePriority : 'normal';
}

function normalizeDeliveryMode(value: string, fallback: DeliveryMode): DeliveryMode {
  return DELIVERY_MODES.includes(value as DeliveryMode) ? value as DeliveryMode : fallback;
}

function readStringList(value: any, maxItems = 20): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, maxItems).map((item: any) => cleanString(item, 500)).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function buildMetadata(body: Record<string, any>, fallback?: {
  priority?: MessagePriority;
  deliveryMode?: DeliveryMode;
  requiresResponse?: boolean;
  replyTo?: string;
}) {
  const rawPriority = cleanString(body.priority, 40);
  const priority = rawPriority ? normalizePriority(rawPriority) : fallback?.priority || 'normal';
  const deliveryMode = normalizeDeliveryMode(cleanString(body.deliveryMode, 40), fallback?.deliveryMode || 'defer');
  const deliverAfterMs = typeof body.deliverAfterMs === 'number'
    ? Date.now() + Math.max(0, Math.min(body.deliverAfterMs, 86_400_000))
    : undefined;
  const deliverAt = typeof body.deliverAt === 'number' && Number.isFinite(body.deliverAt)
    ? body.deliverAt
    : undefined;
  const confidence = typeof body.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1
    ? body.confidence
    : undefined;

  return {
    priority,
    filePaths: readStringList(body.filePaths),
    artifactPaths: readStringList(body.artifactPaths),
    tags: readStringList(body.tags, 12),
    deliveryMode,
    requiresResponse: typeof body.requiresResponse === 'boolean' ? body.requiresResponse : fallback?.requiresResponse,
    confidence,
    replyTo: fallback?.replyTo,
    deliverAfter: deliverAt ?? deliverAfterMs,
    subAgentId: cleanString(body.subAgentId, 240) || undefined,
    subAgentChatId: cleanString(body.subAgentChatId, 360) || undefined,
    recipientAgentId: cleanString(body.recipientAgentId, 240) || undefined,
    recipientSubAgentChatId: cleanString(body.recipientSubAgentChatId, 360) || undefined,
    requestedModelSelection: cleanString(body.requestedModelSelection, 360) || undefined,
    requestedModelProvider: cleanString(body.requestedModelProvider, 80) || undefined,
    requestedModelName: cleanString(body.requestedModelName, 240) || undefined,
  };
}

function formatMessage(message: any) {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    projectId: message.projectId,
    type: message.type,
    subject: message.subject,
    body: message.body,
    read: message.read,
    readAt: message.readAt,
    timestamp: message.timestamp,
    priority: message.metadata?.priority || 'normal',
    deliveryMode: message.metadata?.deliveryMode || 'defer',
    requiresResponse: message.metadata?.requiresResponse === true,
    filePaths: message.metadata?.filePaths,
    artifactPaths: message.metadata?.artifactPaths,
    tags: message.metadata?.tags,
    replyTo: message.metadata?.replyTo,
    deliverAfter: message.metadata?.deliverAfter,
    scheduled: typeof message.metadata?.deliverAfter === 'number' ? message.metadata.deliverAfter > Date.now() : false,
    confidence: message.metadata?.confidence,
    subAgentId: message.metadata?.subAgentId,
    subAgentChatId: message.metadata?.subAgentChatId,
    recipientAgentId: message.metadata?.recipientAgentId,
    recipientSubAgentChatId: message.metadata?.recipientSubAgentChatId,
    requestedModelSelection: message.metadata?.requestedModelSelection,
    requestedModelProvider: message.metadata?.requestedModelProvider,
    requestedModelName: message.metadata?.requestedModelName,
    broadcastRecipientRuns: message.metadata?.broadcastRecipientRuns,
    broadcast: message.metadata?.broadcast === true || message.to === '*',
  };
}

function messageMatchesAgentRun(message: any, agentName: string, subAgentIdentity: string): boolean {
  if (!subAgentIdentity) return true;
  const normalizedAgentName = agentName.toLowerCase();
  const requestedIds = new Set([
    subAgentIdentity,
    subAgentIdentity.includes('::sub-agent::') ? subAgentIdentity.split('::sub-agent::').pop() : '',
  ].filter(Boolean));
  const senderIds = [message.metadata?.subAgentId, message.metadata?.subAgentChatId].filter(Boolean);
  const recipientIds = [message.metadata?.recipientAgentId, message.metadata?.recipientSubAgentChatId].filter(Boolean);
  const matches = (values: string[]) => values.some(value => requestedIds.has(String(value)));

  if (message.to === '*' || message.metadata?.broadcast === true) {
    const recipients = Array.isArray(message.metadata?.broadcastRecipientRuns)
      ? message.metadata.broadcastRecipientRuns
      : [];
    if (recipients.length === 0) return true;
    return recipients.some((recipient: any) =>
      String(recipient?.agentName || '').toLowerCase() === normalizedAgentName &&
      matches([recipient?.agentId, recipient?.subAgentChatId].filter(Boolean))
    );
  }

  if (String(message.from || '').toLowerCase() === normalizedAgentName) {
    return senderIds.length === 0 || matches(senderIds);
  }
  if (String(message.to || '').toLowerCase() === normalizedAgentName) {
    return recipientIds.length === 0 || matches(recipientIds);
  }
  return matches(senderIds) || matches(recipientIds);
}

export async function GET(request: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(request);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(request);
    const { searchParams } = new URL(request.url);
    const projectId = cleanString(searchParams.get('projectId') || '', 180);
    const agentName = cleanString(searchParams.get('agentName') || '', 120);
    const subAgentChatId = cleanString(searchParams.get('subAgentChatId') || '', 360);
    const action = searchParams.get('action') || 'status';
    const respond = (value: any, init?: ResponseInit) =>
      attachAgentApiSessionCookie(NextResponse.json(value, init), session!);

    if (!isSafeChatId(projectId)) return respond({ success: false, error: 'Valid projectId is required' }, { status: 400 });
    const ownerError = requireChatOwner(projectId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);

    if (action === 'status') {
      const summaries = interAgentMailbox.getMailboxSummaries(projectId);
      const team = interAgentMailbox.getTeamSnapshot(projectId);
      const diskStatuses = await agentMessageBus.readAllStatuses(projectId);
      const diskStatusByName = new Map<string, any>();
      for (const [name, status] of Object.entries(diskStatuses) as Array<[string, any]>) {
        diskStatusByName.set(String(status?.agentName || name).toLowerCase(), status);
      }
      const mailboxByName = new Map(summaries.map(summary => [summary.agentName.toLowerCase(), summary]));
      const rosterNames = new Set<string>([
        ...team.map(agent => agent.agentName),
        ...summaries.map(summary => summary.agentName),
        ...Array.from(diskStatusByName.values()).map(status => status?.agentName).filter(Boolean),
      ]);
      const agents = Array.from(rosterNames).map(agentName => {
        const presence = team.find(agent => agent.agentName.toLowerCase() === agentName.toLowerCase());
        const mailbox = mailboxByName.get(agentName.toLowerCase());
        const diskStatus = diskStatusByName.get(agentName.toLowerCase());
        return {
          agentName,
          agentId: presence?.agentId || diskStatus?.agentId,
          subAgentChatId: presence?.subAgentChatId || diskStatus?.subAgentChatId,
          role: presence?.role || (agentName.toLowerCase() === 'main' ? 'main' : 'sub_agent'),
          status: presence?.status || diskStatus?.status || 'registered',
          task: presence?.task || diskStatus?.task,
          progress: presence?.progress || diskStatus?.progress,
          registeredAt: presence?.registeredAt || diskStatus?.startedAt,
          updatedAt: presence?.updatedAt || diskStatus?.updatedAt || diskStatus?.completedAt,
          unreadCount: mailbox?.unreadCount || 0,
          totalMessages: mailbox?.totalCount || 0,
          latestMessage: mailbox?.latestMessage,
        };
      });
      return respond({
        success: true,
        agents,
        mailboxes: summaries,
        team,
        totalUnread: summaries.reduce((sum, s) => sum + s.unreadCount, 0),
      });
    }

    if (action === 'check' && agentName) {
      const unreadOnly = searchParams.get('unreadOnly') !== 'false';
      const limit = Math.max(1, Math.min(100, parseInteger(searchParams.get('limit'), 20)));
      const messages = interAgentMailbox.checkMailbox(projectId, agentName, {
        unreadOnly,
        // Filter by child thread after reading the bounded mailbox window so
        // another worker's recent traffic cannot hide this worker's messages.
        limit: subAgentChatId ? 200 : limit,
      // Older Main messages and broadcasts do not carry child-thread
      // metadata. The mailbox query is already scoped to this agent, so keep
      // those visible instead of making the selected worker's history appear
      // one-sided after a reconnect.
      }).filter(message => messageMatchesAgentRun(message, agentName, subAgentChatId)).slice(-limit);
      return respond({
        success: true,
        agentName,
        messages: messages.map(formatMessage),
        count: messages.length,
      });
    }

    if (action === 'history') {
      const limit = Math.max(1, Math.min(200, parseInteger(searchParams.get('limit'), 50)));
      const typeParam = cleanString(searchParams.get('type') || '', 60);
      const type = MESSAGE_TYPES.includes(typeParam as MessageType) ? typeParam as MessageType : undefined;
      const from = cleanString(searchParams.get('from') || '', 120);
      const to = cleanString(searchParams.get('to') || '', 120);
      const messages = interAgentMailbox.getProjectMessages(projectId, {
        agentName: agentName || undefined,
        type,
        from: from || undefined,
        to: to || undefined,
        // Apply the child-thread filter before the public page limit.
        limit: subAgentChatId ? 1000 : limit,
      }).filter(message => messageMatchesAgentRun(message, agentName, subAgentChatId)).slice(-limit);
      return respond({
        success: true,
        agentName: agentName || undefined,
        messages: messages.map(formatMessage),
        count: messages.length,
      });
    }

    if (action === 'thread') {
      const messageId = cleanString(searchParams.get('messageId') || '', 120);
      if (!messageId) {
        return respond({ success: false, error: 'Required: messageId' }, { status: 400 });
      }
      const normalizedAgent = agentName.toLowerCase();
      const messages = interAgentMailbox.getThread(projectId, messageId)
        .filter(message => !normalizedAgent ||
          message.to === '*' ||
          message.from.toLowerCase() === normalizedAgent ||
          message.to.toLowerCase() === normalizedAgent)
        .filter(message => messageMatchesAgentRun(message, agentName, subAgentChatId));
      return respond({
        success: true,
        messageId,
        messages: messages.map(formatMessage),
        count: messages.length,
      });
    }

    if (action === 'context' && agentName) {
      const context = interAgentMailbox.buildMailboxContext(projectId, agentName);
      return respond({
        success: true,
        agentName,
        context,
        hasMessages: context.length > 0,
      });
    }

    return respond({ success: false, error: 'Invalid action. Use: status, check, context, history, thread' }, { status: 400 });
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}

export async function POST(request: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(request);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(request);

    const body = await readJsonObject(request);
    const action = cleanString(body.action, 40);
    const projectId = cleanString(body.projectId || '', 180);
    const from = cleanString(body.from, 120);
    const to = cleanString(body.to, 120);
    const type = cleanString(body.type, 60);
    const subject = cleanString(body.subject, 200);
    const messageBody = cleanString(body.body, 20_000);
    const respond = (value: any, init?: ResponseInit) =>
      attachAgentApiSessionCookie(NextResponse.json(value, init), session!);

    if (!isSafeChatId(projectId)) return respond({ success: false, error: 'Valid projectId is required' }, { status: 400 });
    const ownerError = requireChatOwner(projectId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);

    if (action === 'send' || action === 'schedule') {
      if (!from || !to || !subject || !messageBody) {
        return respond({ success: false, error: 'Required: from, to, subject, body' }, { status: 400 });
      }
      if (action === 'schedule' && typeof body.deliverAfterMs !== 'number' && typeof body.deliverAt !== 'number') {
        return respond({ success: false, error: 'Required for schedule: deliverAfterMs or deliverAt' }, { status: 400 });
      }
      const msg = interAgentMailbox.send({
        from,
        to,
        projectId,
        type: normalizeMessageType(type, 'info_share'),
        subject: subject.substring(0, 100),
        body: messageBody,
        metadata: buildMetadata(body),
      });
      return respond({
        success: true,
        messageId: msg.id,
        scheduled: action === 'schedule',
        deliverAfter: msg.metadata?.deliverAfter,
        message: formatMessage(msg),
      });
    }

    if (action === 'broadcast') {
      if (!from || !subject || !messageBody) {
        return respond({ success: false, error: 'Required: from, subject, body' }, { status: 400 });
      }
      const broadcastDeliveryMode = cleanString(body.deliveryMode, 40)
        ? normalizeDeliveryMode(cleanString(body.deliveryMode, 40), 'defer')
        : (body.priority === 'critical' || type === 'alert' ? 'interrupt' : 'defer');
      const msg = interAgentMailbox.send({
        from,
        to: '*',
        projectId,
        type: normalizeMessageType(type, 'discovery'),
        subject: subject.substring(0, 100),
        body: messageBody,
        metadata: buildMetadata(body, {
          deliveryMode: broadcastDeliveryMode,
        }),
      });
      return respond({ success: true, messageId: msg.id, broadcast: true, message: formatMessage(msg) });
    }

    if (action === 'reply') {
      const replyToId = cleanString(body.replyToId || body.messageId, 120);
      if (!from || !replyToId || !messageBody) {
        return respond({ success: false, error: 'Required: from, replyToId, body' }, { status: 400 });
      }
      const original = interAgentMailbox.getProjectMessages(projectId, {
        agentName: from,
        limit: 1000,
      }).find(message => message.id === replyToId);
      if (!original) {
        return respond({ success: false, error: `Message ${replyToId} not found` }, { status: 404 });
      }
      const msg = interAgentMailbox.send({
        from,
        to: original.from,
        projectId,
        type: normalizeMessageType(type, 'answer'),
        subject: (subject || `Re: ${original.subject}`).substring(0, 100),
        body: messageBody,
        metadata: buildMetadata(body, {
          priority: original.metadata?.priority || 'normal',
          deliveryMode: original.metadata?.deliveryMode || 'defer',
          replyTo: replyToId,
        }),
      });
      return respond({ success: true, messageId: msg.id, to: original.from, message: formatMessage(msg) });
    }

    if (action === 'ask_main') {
      if (!from || !subject || !messageBody) {
        return respond({ success: false, error: 'Required: from, subject, body' }, { status: 400 });
      }
      const msg = interAgentMailbox.send({
        from,
        to: 'Main',
        projectId,
        type: 'question',
        subject: subject.substring(0, 100),
        body: messageBody,
        metadata: buildMetadata(body, {
          priority: 'high',
          deliveryMode: 'interrupt',
          requiresResponse: true,
        }),
      });
      return respond({ success: true, messageId: msg.id, to: 'Main', message: formatMessage(msg) });
    }

    if (action === 'handoff_main') {
      if (!from || !subject || !messageBody) {
        return respond({ success: false, error: 'Required: from, subject, body' }, { status: 400 });
      }
      const msg = interAgentMailbox.send({
        from,
        to: 'Main',
        projectId,
        type: normalizeMessageType(type, 'handoff'),
        subject: subject.substring(0, 100),
        body: messageBody,
        metadata: buildMetadata(body, {
          deliveryMode: 'defer',
          requiresResponse: false,
        }),
      });
      return respond({ success: true, messageId: msg.id, to: 'Main', message: formatMessage(msg) });
    }

    if (action === 'markRead' || action === 'mark_read') {
      const agentName = cleanString(body.agentName, 120);
      const messageIds = Array.isArray(body.messageIds) ? body.messageIds.slice(0, 100).map((item: any) => cleanString(item, 120)).filter(Boolean) : undefined;
      if (!agentName) {
        return respond({ success: false, error: 'Required: agentName' }, { status: 400 });
      }
      const count = interAgentMailbox.markRead(projectId, agentName, messageIds);
      return respond({ success: true, markedRead: count });
    }

    if (action === 'register') {
      const agentName = cleanString(body.agentName, 120);
      if (!agentName) {
        return respond({ success: false, error: 'Required: agentName' }, { status: 400 });
      }
      interAgentMailbox.registerAgent(projectId, agentName, {
        role: body.role === 'main' || body.role === 'sub_agent' ? body.role : undefined,
        task: cleanString(body.task, 1000) || undefined,
        status: cleanString(body.status, 80) || undefined,
        progress: cleanString(body.progress, 1000) || undefined,
      });
      return respond({ success: true, registered: agentName });
    }

    return respond({ success: false, error: 'Invalid action. Use: send, schedule, reply, broadcast, ask_main, handoff_main, markRead, mark_read, register' }, { status: 400 });
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
