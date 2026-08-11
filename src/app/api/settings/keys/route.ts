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
import { applyRuntimeProviderBaseURLs, getRuntimeProviderBaseURLs } from '../../../../lib/agent/provider-runtime';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { updateStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    hydrateServerRuntimeSettings();
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await req.json().catch(() => ({}));
    const hasExplicitApiKeys = Boolean(body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'apiKeys'));
    const hasModelOverrides = Boolean(body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'modelOverrides'));
    const hasBaseURLs = Boolean(body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'baseURLs'));
    const currentProviderStatus = getRuntimeApiKeyStatus();
    const result = hasExplicitApiKeys
      ? applyRuntimeApiKeys(body.apiKeys)
      : {
          acceptedCount: Object.keys(currentProviderStatus)
            .reduce((total, provider) => total + getRuntimeApiKeyValues(provider as keyof typeof currentProviderStatus).length, 0),
          rejectedCount: 0,
          providers: Object.entries(currentProviderStatus).map(([provider, accepted]) => ({
            provider: provider as keyof typeof currentProviderStatus,
            accepted,
            count: getRuntimeApiKeyValues(provider as keyof typeof currentProviderStatus).length,
            ...(accepted ? {} : { reason: 'No key configured in Settings' }),
          })),
        };
    const modelOverrides = hasModelOverrides
      ? applyRuntimeModelOverrides(body.modelOverrides)
      : Object.entries(getRuntimeModelOverrides())
        .filter(([, model]) => Boolean(model))
        .map(([provider, model]) => ({ provider: provider as any, accepted: true, model }));
    const pool = apiKeyPool.getPoolStatus();
    const baseURLs = hasBaseURLs
      ? applyRuntimeProviderBaseURLs(body.baseURLs)
      : getRuntimeProviderBaseURLs();

    // The settings route is the authoritative server-side sync point. Persist
    // every explicit runtime mutation here as well as applying it in memory,
    // so closing the Settings panel cannot strand the only durable write in a
    // renderer promise.
    const persistedPatch: Record<string, unknown> = {};
    if (hasExplicitApiKeys) persistedPatch.apiKeys = body.apiKeys;
    if (hasModelOverrides) persistedPatch.modelOverrides = body.modelOverrides;
    if (hasBaseURLs) persistedPatch.baseURLs = body.baseURLs;
    if (body?.persist !== false && Object.keys(persistedPatch).length > 0) {
      await updateStoredRuntimeSettings(persistedPatch as any);
    }

    return NextResponse.json({
      ok: true,
      acceptedCount: result.acceptedCount,
      rejectedCount: result.rejectedCount,
      providers: result.providers,
      modelOverrides,
      baseURLs,
      pool: {
        totalKeys: pool.totalKeys,
        availableKeys: pool.availableKeys,
        activeLeases: pool.activeLeases,
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
    hydrateServerRuntimeSettings();
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
        healthySummary: pool.healthySummary,
      },
      providers,
      modelOverrides: getRuntimeModelOverrides(),
      baseURLs: getRuntimeProviderBaseURLs(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'Failed to read API key status' },
      { status: 500 },
    );
  }
}
