import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { readStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { normalizeLiveProvider } from '../../../../lib/live/live-provider';

export const dynamic = 'force-dynamic';

/**
 * POST /api/live/key — Return the dedicated Agent Live Convo API key.
 * 
 * The client calls this before connecting to the Live API WebSocket. Credentials
 * are configured only by Settings and never accepted by this endpoint. Live
 * credentials are intentionally separate from ordinary provider/model pools.
 */
export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await req.json().catch(() => ({}));
    const provider = normalizeLiveProvider(body?.provider);
    if (provider.provider !== 'gemini') {
      return NextResponse.json(
        { error: 'This Agent Live transport is not configured.' },
        { status: 400 },
      );
    }

    const stored = readStoredRuntimeSettings();
    const rawKeys = stored.liveApiKeys?.gemini;
    const keys = (Array.isArray(rawKeys) ? rawKeys : [rawKeys])
      .map(key => String(key || '').trim())
      .filter(Boolean);
    const apiKey = keys[0] || '';
    if (!apiKey) {
      return NextResponse.json(
        { error: 'No separate Agent Live API key is configured.' },
        { status: 503 },
      );
    }
    
    return NextResponse.json({ 
      apiKey,
      provider: provider.provider,
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
