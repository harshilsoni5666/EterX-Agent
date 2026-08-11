import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { readStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { normalizeLiveProvider } from '../../../../lib/live/live-provider';

export const dynamic = 'force-dynamic';

/**
 * POST /api/live/key — Return the dedicated selected Live Convo provider key.
 * 
 * The client calls this before connecting to the selected Live transport. Credentials
 * are configured only by Settings and never accepted by this endpoint. Live
 * credentials are intentionally separate from ordinary provider/model pools.
 */
export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await req.json().catch(() => ({}));
    const provider = normalizeLiveProvider(body?.provider);
    const stored = readStoredRuntimeSettings();
    const rawKeys = stored.liveApiKeys?.[provider.keyProvider];
    const keys = (Array.isArray(rawKeys) ? rawKeys : [rawKeys])
      .map(key => String(key || '').trim())
      .filter(Boolean);
    const apiKey = keys[0] || '';
    if (!apiKey) {
      return NextResponse.json(
        { error: `No separate ${provider.label} Live API key is configured.` },
        { status: 503 },
      );
    }
    // Native browser transports receive only short-lived credentials from
    // /api/live/session. Keep long-lived OpenAI, xAI, Deepgram, and
    // ElevenLabs keys on the server; Gemini still uses its documented key in
    // the WebSocket URL and therefore retains the legacy client key path.
    if (provider.browserAuth !== 'api-key') {
      return NextResponse.json({
        apiKey: '',
        available: true,
        provider: provider.value,
        providerKey: provider.keyProvider,
        chatId: body.chatId || `live_${Date.now()}`,
      });
    }
    
    return NextResponse.json({ 
      apiKey,
      available: true,
      provider: provider.value,
      providerKey: provider.keyProvider,
      chatId: body.chatId || `live_${Date.now()}`,
    });
    
  } catch (error: any) {
    console.error('[LiveKey] Error leasing key:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to lease API key' },
      { status: 500 }
    );
  }
}
