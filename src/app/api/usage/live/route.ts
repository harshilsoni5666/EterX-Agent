import { type NextRequest, NextResponse } from 'next/server';
import { readJsonObject, rejectCrossOrigin } from '../../agent/_shared';
import { saveLiveReceipt } from '../../../../lib/usage/ledger';

export const runtime = 'nodejs';
const providers = new Set(['openai', 'grok', 'gemini', 'deepgram', 'elevenlabs']);

export async function POST(req: NextRequest) {
  const origin = rejectCrossOrigin(req);
  if (origin) return origin;
  const { provider, model, id, at, usage } = await readJsonObject(req);
  if (!providers.has(provider) || typeof model !== 'string' || !model.trim() || model.length > 240
      || typeof id !== 'string' || !/^[\w.:-]{1,220}$/.test(id) || !Number.isSafeInteger(at) || at <= 0
      || !usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return NextResponse.json({ error: 'Invalid live usage receipt.' }, { status: 400 });
  }
  try {
    saveLiveReceipt(provider, model, id, Math.min(at, Date.now()), usage);
    return new Response(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: 'Usage storage temporarily unavailable.' }, { status: 503 });
  }
}
