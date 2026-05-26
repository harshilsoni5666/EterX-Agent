import { NextRequest, NextResponse } from 'next/server';
import { interAgentMailbox } from '@/lib/agent/roles/inter_agent_comm';

/**
 * Inter-Agent Communication API
 * 
 * GET  /api/agents/comm?projectId=...&agentName=...  → Check mailbox / get status
 * POST /api/agents/comm                               → Send message / broadcast
 */

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId') || 'default';
    const agentName = searchParams.get('agentName');
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
      const limit = parseInt(searchParams.get('limit') || '20');
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
    const body = await request.json();
    const { action, projectId = 'default', from, to, type, subject, body: messageBody, priority, filePaths, replyToId } = body;

    if (action === 'send') {
      if (!from || !to || !subject || !messageBody) {
        return NextResponse.json({ success: false, error: 'Required: from, to, subject, body' }, { status: 400 });
      }
      const msg = interAgentMailbox.send({
        from,
        to,
        projectId,
        type: type || 'info_share',
        subject: subject.substring(0, 100),
        body: messageBody,
        metadata: { priority: priority || 'normal', filePaths },
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
        type: type || 'discovery',
        subject: subject.substring(0, 100),
        body: messageBody,
        metadata: { priority: priority || 'normal', filePaths },
      });
      return NextResponse.json({ success: true, messageId: msg.id, broadcast: true });
    }

    if (action === 'markRead') {
      const { agentName, messageIds } = body;
      if (!agentName) {
        return NextResponse.json({ success: false, error: 'Required: agentName' }, { status: 400 });
      }
      const count = interAgentMailbox.markRead(projectId, agentName, messageIds);
      return NextResponse.json({ success: true, markedRead: count });
    }

    if (action === 'register') {
      const { agentName } = body;
      if (!agentName) {
        return NextResponse.json({ success: false, error: 'Required: agentName' }, { status: 400 });
      }
      interAgentMailbox.registerAgent(projectId, agentName);
      return NextResponse.json({ success: true, registered: agentName });
    }

    return NextResponse.json({ success: false, error: 'Invalid action. Use: send, broadcast, markRead, register' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
