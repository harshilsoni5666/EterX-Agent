import { NextResponse } from 'next/server';
import { apiKeyPool } from '../../../../lib/agent/api-key-pool';

export const dynamic = 'force-dynamic';

/**
 * POST /api/live/key — Lease an API key for a Gemini Live session.
 * 
 * The client calls this before connecting to the Live API WebSocket.
 * Returns a key from the pool, leased under a unique live session ID.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const chatId = body.chatId || `live_${Date.now()}`;
    
    const lease = apiKeyPool.leaseKey(chatId, 'main_agent');
    
    if (!lease) {
      return NextResponse.json(
        { error: 'No API keys available. All ready keys are currently in use.' },
        { status: 503 }
      );
    }
    
    return NextResponse.json({ 
      apiKey: lease.apiKey,
      chatId: chatId 
    });
    
  } catch (error: any) {
    console.error('[LiveKey] Error leasing key:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to lease API key' },
      { status: 500 }
    );
  }
}
