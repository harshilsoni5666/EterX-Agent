import { NextRequest, NextResponse } from 'next/server';
import { loadChatById, loadChatSnapshot, patchChatSnapshot, saveChatSnapshot } from '../../../lib/chat-store';
import { rejectCrossOrigin } from '../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const noStoreHeaders = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

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
    const snapshot = body.partial === true && Array.isArray(body.chatIds)
      ? await patchChatSnapshot(body.chats, body.chatIds, savedAt, body.deletedChatIds)
      : await saveChatSnapshot(body.chats, savedAt);
    return NextResponse.json({ ok: true, savedAt: snapshot.savedAt }, { headers: noStoreHeaders });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to save chats' }, { status: 500, headers: noStoreHeaders });
  }
}
