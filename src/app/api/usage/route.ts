import { type NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../agent/_shared';
import { loadChatSnapshot } from '../../../lib/chat-store';
import { usageBuckets } from '../../../lib/usage/ledger';
import { currentRates, refreshRates } from '../../../lib/usage/pricing-store';
import type { UsageReport } from '../../../lib/usage/summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest) {
  const origin = rejectCrossOrigin(req);
  if (origin) return origin;
  const end = Date.now();
  const earliest = end - 92 * 86_400_000;
  const requested = Number(req.nextUrl.searchParams.get('start'));
  const start = requested > 0 ? Math.min(end, Math.max(earliest, requested)) : earliest;
  const zone = req.nextUrl.searchParams.get('tz') || 'UTC';
  let timeZone: string;
  try { timeZone = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
  catch { return NextResponse.json({ error: 'Invalid time zone.' }, { status: 400, headers }); }
  try {
    void refreshRates();
    const saved = await loadChatSnapshot().catch(() => null);
    const report: UsageReport = {
      ...usageBuckets(start, end, timeZone, saved?.chats ?? []),
      asOf: currentRates().asOf,
      updatedAt: end,
      timeZone,
      savedUsageAvailable: Boolean(saved),
    };
    return NextResponse.json(report, { headers });
  } catch {
    return NextResponse.json({ error: 'Usage records could not be read.' }, { status: 503, headers });
  }
}
