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

function normalizeMessageType(value: string, fallback: MessageType): MessageType {
  return MESSAGE_TYPES.includes(value as MessageType) ? value as MessageType : fallback;
}

function normalizePriority(value: string): MessagePriority {
  return MESSAGE_PRIORITIES.includes(value as MessagePriority) ? value as MessagePriority : 'normal';
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = cleanString(searchParams.get('projectId') || 'default', 120) || 'default';
    const agentName = cleanString(searchParams.get('agentName') || '', 120);
    const action = searchParams.get('action') || 'status';

    if (action === 'status') {
      const summaries = interAgentMailbox.getMailboxSummaries(projectId);
      return NextResponse.json({
        success: true,
        agents: summaries,
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
        messages,
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

    return NextResponse.json({ success: false, error: 'Invalid action. Use: status, check, context' }, { status: 400 });
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
    const priority = normalizePriority(cleanString(body.priority, 40));
    const filePaths = Array.isArray(body.filePaths) ? body.filePaths.slice(0, 20).map((item: any) => cleanString(item, 500)).filter(Boolean) : undefined;

    if (action === 'send') {
      if (!from || !to || !subject || !messageBody) {
        return NextResponse.json({ success: false, error: 'Required: from, to, subject, body' }, { status: 400 });
      }
      const msg = interAgentMailbox.send({
        from,
        to,
        projectId,
        type: normalizeMessageType(type, 'info_share'),
        subject: subject.substring(0, 100),
        body: messageBody,
        metadata: { priority, filePaths },
      });
      return NextResponse.json({ success: true, messageId: msg.id });
    }

    if (action === 'broadcast') {
      if (!from || !subject || !messageBody) {
        return NextResponse.json({ success: false, error: 'Required: from, subject, body' }, { status: 400 });
      }
      const msg = interAgentMailbox.send({
        from,
        to: '*',
        projectId,
        type: normalizeMessageType(type, 'discovery'),
        subject: subject.substring(0, 100),
        body: messageBody,
        metadata: { priority, filePaths },
      });
      return NextResponse.json({ success: true, messageId: msg.id, broadcast: true });
    }

    if (action === 'markRead') {
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
      interAgentMailbox.registerAgent(projectId, agentName);
      return NextResponse.json({ success: true, registered: agentName });
    }

    return jsonError('Invalid action. Use: send, broadcast, markRead, register', 400);
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
