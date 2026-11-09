import { NextRequest, NextResponse } from 'next/server';
import { copyStoredChat, prepareStoredChat, loadChatById, loadChatSnapshot, patchChatSnapshot, saveChatSnapshot } from '../../../lib/chat-store';
import { removeChatMedia } from '../../../lib/chat-media-store';
import { rejectCrossOrigin } from '../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const noStoreHeaders = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json();
    if (!['copy', 'prepare'].includes(body?.action) || typeof body.id !== 'string' || !body.id.trim()) {
      return NextResponse.json({ error: 'A chat ID and supported action are required.' }, { status: 400, headers: noStoreHeaders });
    }
    if (body.chat !== undefined && (!body.chat || body.chat.id !== body.id || !Array.isArray(body.chat.traceLogs))) {
      return NextResponse.json({ error: 'The conversation snapshot does not match the selected chat.' }, { status: 400, headers: noStoreHeaders });
    }
    if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId))) {
      return NextResponse.json({ error: 'Invalid copy request.' }, { status: 400, headers: noStoreHeaders });
    }
    const result = body.action === 'copy'
      ? await copyStoredChat(body.id, body.chat, body.requestId)
      : await prepareStoredChat(body.id, body.chat);
    return NextResponse.json(result, { headers: noStoreHeaders });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to save this conversation.' }, { status: 500, headers: noStoreHeaders });
  }
}

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const chatId = req.nextUrl.searchParams.get('id')?.trim();
    if (chatId) {
      const chat = await loadChatById(chatId);
      return NextResponse.json({ chat }, { headers: noStoreHeaders });
    }
    return NextResponse.json(await loadChatSnapshot(), { headers: noStoreHeaders });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to load chats' }, { status: 500, headers: noStoreHeaders });
  }
}

export async function PUT(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json();
    if (!body || !Array.isArray(body.chats)) {
      return NextResponse.json({ error: 'chats must be an array' }, { status: 400, headers: noStoreHeaders });
    }
    const savedAt = Number(body.savedAt);
    if (!Number.isFinite(savedAt) || savedAt <= 0) {
      return NextResponse.json({ error: 'savedAt must be a positive number' }, { status: 400, headers: noStoreHeaders });
    }
    if (body.partial === true && (
      !Array.isArray(body.chatIds)
      || (body.deletedChatIds !== undefined && !Array.isArray(body.deletedChatIds))
    )) {
      return NextResponse.json({ error: 'Partial updates require chatIds and an optional deletedChatIds array' }, { status: 400, headers: noStoreHeaders });
    }
    const mutationId = typeof body.mutationId === 'string' ? body.mutationId.trim().slice(0, 200) : '';
    const snapshot = body.partial === true && Array.isArray(body.chatIds)
      ? await patchChatSnapshot(body.chats, body.chatIds, savedAt, body.deletedChatIds, mutationId)
      : await saveChatSnapshot(body.chats, savedAt, mutationId);
    if (snapshot.applied && body.partial === true && Array.isArray(body.deletedChatIds)) {
      await removeChatMedia(body.deletedChatIds.filter((id: unknown) => typeof id === 'string'));
    }
    return NextResponse.json({ ok: true, applied: snapshot.applied, savedAt: snapshot.savedAt }, { headers: noStoreHeaders });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to save chats' }, { status: 500, headers: noStoreHeaders });
  }
}
