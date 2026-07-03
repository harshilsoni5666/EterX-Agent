import { NextRequest, NextResponse } from 'next/server';
import { interAgentMailbox, type MessageType } from '@/lib/agent/roles/inter_agent_comm';
import { cleanString, jsonError, parseInteger, readJsonObject, rejectCrossOrigin } from '../../agent/_shared';

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
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = cleanString(searchParams.get('projectId') || 'default', 120) || 'default';
    const agentName = cleanString(searchParams.get('agentName') || '', 120);
    const action = searchParams.get('action') || 'status';

    if (action === 'status') {
      const summaries = interAgentMailbox.getMailboxSummaries(projectId);
      const team = interAgentMailbox.getTeamSnapshot(projectId);
      const mailboxByName = new Map(summaries.map(summary => [summary.agentName.toLowerCase(), summary]));
      const rosterNames = new Set<string>([
        ...team.map(agent => agent.agentName),
        ...summaries.map(summary => summary.agentName),
      ]);
      const agents = Array.from(rosterNames).map(agentName => {
        const presence = team.find(agent => agent.agentName.toLowerCase() === agentName.toLowerCase());
        const mailbox = mailboxByName.get(agentName.toLowerCase());
        return {
          agentName,
          role: presence?.role || (agentName.toLowerCase() === 'main' ? 'main' : 'sub_agent'),
          status: presence?.status || 'registered',
          task: presence?.task,
          progress: presence?.progress,
          registeredAt: presence?.registeredAt,
          updatedAt: presence?.updatedAt,
          unreadCount: mailbox?.unreadCount || 0,
          totalMessages: mailbox?.totalCount || 0,
          latestMessage: mailbox?.latestMessage,
        };
      });
      return NextResponse.json({
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
        limit,
      });
      return NextResponse.json({
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
        limit,
      });
      return NextResponse.json({
        success: true,
        agentName: agentName || undefined,
        messages: messages.map(formatMessage),
        count: messages.length,
      });
    }

    if (action === 'thread') {
      const messageId = cleanString(searchParams.get('messageId') || '', 120);
      if (!messageId) {
        return NextResponse.json({ success: false, error: 'Required: messageId' }, { status: 400 });
      }
      const normalizedAgent = agentName.toLowerCase();
      const messages = interAgentMailbox.getThread(projectId, messageId)
        .filter(message => !normalizedAgent ||
          message.to === '*' ||
          message.from.toLowerCase() === normalizedAgent ||
          message.to.toLowerCase() === normalizedAgent);
      return NextResponse.json({
        success: true,
        messageId,
        messages: messages.map(formatMessage),
        count: messages.length,
      });
    }

    if (action === 'context' && agentName) {
      const context = interAgentMailbox.buildMailboxContext(projectId, agentName);
      return NextResponse.json({
        success: true,
        agentName,
        context,
        hasMessages: context.length > 0,
      });
    }

    return NextResponse.json({ success: false, error: 'Invalid action. Use: status, check, context, history, thread' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const originError = rejectCrossOrigin(request);
    if (originError) return originError;

    const body = await readJsonObject(request);
    const action = cleanString(body.action, 40);
    const projectId = cleanString(body.projectId || 'default', 120) || 'default';
    const from = cleanString(body.from, 120);
    const to = cleanString(body.to, 120);
    const type = cleanString(body.type, 60);
    const subject = cleanString(body.subject, 200);
    const messageBody = cleanString(body.body, 20_000);

    if (action === 'send' || action === 'schedule') {
      if (!from || !to || !subject || !messageBody) {
        return NextResponse.json({ success: false, error: 'Required: from, to, subject, body' }, { status: 400 });
      }
      if (action === 'schedule' && typeof body.deliverAfterMs !== 'number' && typeof body.deliverAt !== 'number') {
        return NextResponse.json({ success: false, error: 'Required for schedule: deliverAfterMs or deliverAt' }, { status: 400 });
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
      return NextResponse.json({
        success: true,
        messageId: msg.id,
        scheduled: action === 'schedule',
        deliverAfter: msg.metadata?.deliverAfter,
        message: formatMessage(msg),
      });
    }

    if (action === 'broadcast') {
      if (!from || !subject || !messageBody) {
        return NextResponse.json({ success: false, error: 'Required: from, subject, body' }, { status: 400 });
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
      return NextResponse.json({ success: true, messageId: msg.id, broadcast: true, message: formatMessage(msg) });
    }

    if (action === 'reply') {
      const replyToId = cleanString(body.replyToId || body.messageId, 120);
      if (!from || !replyToId || !messageBody) {
        return NextResponse.json({ success: false, error: 'Required: from, replyToId, body' }, { status: 400 });
      }
      const original = interAgentMailbox.getProjectMessages(projectId, {
        agentName: from,
        limit: 1000,
      }).find(message => message.id === replyToId);
      if (!original) {
        return NextResponse.json({ success: false, error: `Message ${replyToId} not found` }, { status: 404 });
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
      return NextResponse.json({ success: true, messageId: msg.id, to: original.from, message: formatMessage(msg) });
    }

    if (action === 'ask_main') {
      if (!from || !subject || !messageBody) {
        return NextResponse.json({ success: false, error: 'Required: from, subject, body' }, { status: 400 });
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
      return NextResponse.json({ success: true, messageId: msg.id, to: 'Main', message: formatMessage(msg) });
    }

    if (action === 'handoff_main') {
      if (!from || !subject || !messageBody) {
        return NextResponse.json({ success: false, error: 'Required: from, subject, body' }, { status: 400 });
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
      return NextResponse.json({ success: true, messageId: msg.id, to: 'Main', message: formatMessage(msg) });
    }

    if (action === 'markRead' || action === 'mark_read') {
      const agentName = cleanString(body.agentName, 120);
      const messageIds = Array.isArray(body.messageIds) ? body.messageIds.slice(0, 100).map((item: any) => cleanString(item, 120)).filter(Boolean) : undefined;
      if (!agentName) {
        return NextResponse.json({ success: false, error: 'Required: agentName' }, { status: 400 });
      }
      const count = interAgentMailbox.markRead(projectId, agentName, messageIds);
      return NextResponse.json({ success: true, markedRead: count });
    }

    if (action === 'register') {
      const agentName = cleanString(body.agentName, 120);
      if (!agentName) {
        return NextResponse.json({ success: false, error: 'Required: agentName' }, { status: 400 });
      }
      interAgentMailbox.registerAgent(projectId, agentName, {
        role: body.role === 'main' || body.role === 'sub_agent' ? body.role : undefined,
        task: cleanString(body.task, 1000) || undefined,
        status: cleanString(body.status, 80) || undefined,
        progress: cleanString(body.progress, 1000) || undefined,
      });
      return NextResponse.json({ success: true, registered: agentName });
    }

    return jsonError('Invalid action. Use: send, schedule, reply, broadcast, ask_main, handoff_main, markRead, mark_read, register', 400);
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
