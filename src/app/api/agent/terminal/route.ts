import { NextRequest, NextResponse } from 'next/server';
import { getTerminalBackgroundTaskStatus, killTerminalBackgroundTask, listTerminalBackgroundTasks } from '@/lib/agent/tools/core/terminal_background';
import { attachAgentApiSessionCookie, getOrCreateAgentApiSession, isSafeChatId, jsonError, readJsonObject, rejectCrossOrigin, requireChatOwner } from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: NextRequest, stop: boolean) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const session = getOrCreateAgentApiSession(req);
  const respond = (response: NextResponse) => attachAgentApiSessionCookie(response, session);
  try {
    const input = stop ? await readJsonObject(req) : Object.fromEntries(req.nextUrl.searchParams);
    const { chatId, taskId } = input;
    if (!isSafeChatId(chatId)) return respond(jsonError('A valid chat ID is required.'));
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return respond(ownerError);
    if (taskId !== undefined && (typeof taskId !== 'string' || !/^term_[a-zA-Z0-9_]+$/.test(taskId))) return respond(jsonError('Invalid terminal task ID.'));
    if (stop && !taskId) return respond(jsonError('A terminal task ID is required.'));
    if (!taskId) {
      const tasks = await listTerminalBackgroundTasks(chatId, true);
      tasks.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt);
      return respond(NextResponse.json({ tasks }, { headers: { 'Cache-Control': 'no-store' } }));
    }
    const offset = input.sinceOffset === undefined ? undefined : Number(input.sinceOffset);
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) return respond(jsonError('Invalid output offset.'));
    const outputLimit = input.maxOutputChars === undefined ? 64_000 : Number(input.maxOutputChars);
    if (!Number.isSafeInteger(outputLimit) || outputLimit < 1000 || outputLimit > 64_000) return respond(jsonError('Output limit must be between 1000 and 64000 characters.'));
    const task = stop
      ? await killTerminalBackgroundTask(taskId, chatId)
      : await getTerminalBackgroundTaskStatus(taskId, chatId, offset, outputLimit);
    if (!task) return respond(jsonError('Terminal task not found in this chat.', 404));
    return respond(NextResponse.json({ task }, { headers: { 'Cache-Control': 'no-store' } }));
  } catch (error) {
    return respond(jsonError(error instanceof Error ? error.message : 'Terminal request failed.', 500));
  }
}

export const GET = (req: NextRequest) => handle(req, false);
export const POST = (req: NextRequest) => handle(req, true);
