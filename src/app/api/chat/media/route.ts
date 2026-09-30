import { NextRequest, NextResponse } from 'next/server';
import { chatMediaHref, getChatMediaAttachment, listChatMedia, retainChatImageOutput } from '../../../../lib/chat-media-store';
import path from 'path';
import { attachAgentApiSessionCookie, getOrCreateAgentApiSession, isSafeChatId, rejectCrossOrigin, requireChatOwner } from '../../agent/_shared';
import { GET as getPreview } from '../../preview/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const body = await req.json().catch(() => null);
  const chatId = String(body?.chatId || '');
  const filePath = String(body?.path || '');
  if (!isSafeChatId(chatId) || !path.isAbsolute(filePath)
    || !/\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|svg|ico|heic|heif)$/i.test(filePath)) {
    return NextResponse.json({ error: 'Invalid image' }, { status: 400 });
  }
  const session = getOrCreateAgentApiSession(req);
  const ownerError = requireChatOwner(chatId, session.sessionId);
  if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
  try {
    const previewUrl = await retainChatImageOutput(chatId, filePath);
    return attachAgentApiSessionCookie(NextResponse.json(
      previewUrl ? { previewUrl } : { error: 'Image unavailable' },
      { status: previewUrl ? 200 : 404 },
    ), session);
  } catch {
    return attachAgentApiSessionCookie(NextResponse.json({ error: 'Could not save image' }, { status: 500 }), session);
  }
}

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const chatId = req.nextUrl.searchParams.get('chatId') || '';
  if (!isSafeChatId(chatId)) return NextResponse.json({ error: 'Invalid chat' }, { status: 400 });
  const session = getOrCreateAgentApiSession(req);
  const ownerError = requireChatOwner(chatId, session.sessionId);
  if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (id) {
      const entry = await getChatMediaAttachment(chatId, id);
      if (!entry) return attachAgentApiSessionCookie(NextResponse.json({ error: 'Attachment unavailable' }, { status: 404 }), session);
      const url = new URL('/api/preview', req.url);
      url.searchParams.set('path', entry.path);
      const response = await getPreview(new NextRequest(url, { headers: req.headers }));
      return attachAgentApiSessionCookie(response, session);
    }
    const entries = await listChatMedia(chatId);
    return attachAgentApiSessionCookie(NextResponse.json({ chatId, attachments: entries.map(entry => ({ ...entry, previewUrl: chatMediaHref(chatId, entry.id) })) }, { headers: { 'Cache-Control': 'no-store' } }), session);
  } catch {
    return attachAgentApiSessionCookie(NextResponse.json({ error: 'Unable to load chat attachments' }, { status: 500 }), session);
  }
}
