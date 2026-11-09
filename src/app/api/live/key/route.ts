import { createLiveCatalogRequest } from '../../../../lib/live/catalog-request';
import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin, getOrCreateAgentApiSession, ensureChatOwner, isSafeChatId, attachAgentApiSessionCookie } from '../../agent/_shared';
import { normalizeLiveProvider } from '../../../../lib/live/live-provider';
import { formatUnknownError } from '../../../../lib/agent/error-format';

export const dynamic = 'force-dynamic';

/**
 * Establish the Live owner and report credential presence. Long-lived provider
 * keys never leave this route; /api/live/session mints browser credentials.
 */
export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await req.json().catch(() => ({}));
    const provider = normalizeLiveProvider(body?.provider);
    const chatId = String(body.chatId || '').trim();
    if (!isSafeChatId(chatId)) return NextResponse.json({ error: 'A valid Live chat ID is required.' }, { status: 400 });
    const session = getOrCreateAgentApiSession(req);
    if (!ensureChatOwner(chatId, session.sessionId)) return NextResponse.json({ error: 'This Live chat belongs to another session.' }, { status: 403 });
    const client = createLiveCatalogRequest(provider.value, undefined, req.signal, body?.model);
    if (provider.transport !== 'model-voice' && !client.hasKey) {
      return NextResponse.json(
        { error: `Connect ${provider.label} in Models or add a key in Live settings.` },
        { status: 503 },
      );
    }
    return attachAgentApiSessionCookie(NextResponse.json({
      apiKey: '',
      available: true,
      provider: provider.value,
      providerKey: provider.keyProvider,
      chatId,
    }, { headers: { 'Cache-Control': 'no-store' } }), session);
    
  } catch (error: any) {
    console.error('[LiveKey] Error leasing key:', error);
    return NextResponse.json(
      { error: formatUnknownError(error, 'Failed to lease API key') },
      { status: 500 }
    );
  }
}
