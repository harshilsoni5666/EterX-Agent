import { NextRequest, NextResponse } from 'next/server';
import { managedWorkspaces } from '@/lib/agent/workspace/managed';
import { rejectCrossOrigin, isSafeChatId, getOrCreateAgentApiSession, requireChatOwner, attachAgentApiSessionCookie } from '../agent/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  const session = getOrCreateAgentApiSession(request);
  const reply = (body: unknown, status = 200) => attachAgentApiSessionCookie(NextResponse.json(body, { status }), session);
  try {
    const body = await request.json();
    const chatId = String(body.chatId || '').replace(/^terminal-draft-/, '');
    if (!isSafeChatId(chatId)) return reply({ error: 'A valid chat is required.' }, 400);
    const denied = requireChatOwner(chatId, session.sessionId);
    if (denied) return attachAgentApiSessionCookie(denied, session);
    managedWorkspaces.startWorkspaceCleanup();
    if (body.action === 'inspect') {
      const workspace = body.path ? managedWorkspaces.findByPath(body.path) : null;
      return reply({ workspace });
    }
    if (body.action === 'create') {
      const workspace = await managedWorkspaces.create({ chatId, kind: body.kind, sourcePath: body.sourcePath, days: body.days });
      return reply({ workspace });
    }
    const workspace = managedWorkspaces.list(chatId).find(item => item.id === body.id);
    if (!workspace) return reply({ error: 'This chat does not own that workspace.' }, 404);
    return reply({ workspace: await managedWorkspaces.update(workspace.id, body.action, body.days) });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : 'Could not prepare this workspace.' }, 400);
  }
}
