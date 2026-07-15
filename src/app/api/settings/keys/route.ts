import { NextRequest, NextResponse } from 'next/server';
import { apiKeyPool } from '../../../../lib/agent/api-key-pool';
import {
  applyRuntimeApiKeys,
  applyRuntimeModelOverrides,
  getRuntimeApiKeyValues,
  getRuntimeApiKeyStatus,
  getRuntimeModelOverrides,
} from '../../../../lib/agent/runtime-api-keys';
import { rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

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
    const providerStatus = getRuntimeApiKeyStatus();
    const providers = Object.entries(providerStatus).map(([provider, accepted]) => ({
      provider,
      accepted,
      count: getRuntimeApiKeyValues(provider as keyof typeof providerStatus).length,
      ...(accepted ? {} : { reason: 'No key supplied' }),
    }));
    const acceptedCount = providers.reduce((total, provider) => total + provider.count, 0);

    return NextResponse.json({
      ok: true,
      acceptedCount,
      pool: {
        totalKeys: pool.totalKeys,
        availableKeys: pool.availableKeys,
        activeLeases: pool.activeLeases,
        retiredKeys: pool.retiredKeys,
        healthySummary: pool.healthySummary,
      },
      providers,
      modelOverrides: getRuntimeModelOverrides(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'Failed to read API key status' },
      { status: 500 },
    );
  }
}
