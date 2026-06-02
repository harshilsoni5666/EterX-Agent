import { NextRequest, NextResponse } from 'next/server';
import { apiKeyPool } from '../../../../lib/agent/api-key-pool';
import {
  applyRuntimeApiKeys,
  applyRuntimeModelOverrides,
  getRuntimeApiKeyStatus,
  getRuntimeModelOverrides,
} from '../../../../lib/agent/runtime-api-keys';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = applyRuntimeApiKeys(body?.apiKeys || body);
    const modelOverrides = applyRuntimeModelOverrides(body?.modelOverrides);
    const pool = apiKeyPool.getPoolStatus();

    return NextResponse.json({
      ok: true,
      acceptedCount: result.acceptedCount,
      rejectedCount: result.rejectedCount,
      providers: result.providers,
      modelOverrides,
      pool: {
        totalKeys: pool.totalKeys,
        availableKeys: pool.availableKeys,
        activeLeases: pool.activeLeases,
        retiredKeys: pool.retiredKeys,
        healthySummary: pool.healthySummary,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'Failed to sync API keys' },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const pool = apiKeyPool.getPoolStatus();
    return NextResponse.json({
      ok: true,
      pool: {
        totalKeys: pool.totalKeys,
        availableKeys: pool.availableKeys,
        activeLeases: pool.activeLeases,
        retiredKeys: pool.retiredKeys,
        healthySummary: pool.healthySummary,
      },
      providers: getRuntimeApiKeyStatus(),
      modelOverrides: getRuntimeModelOverrides(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'Failed to read API key status' },
      { status: 500 },
    );
  }
}
