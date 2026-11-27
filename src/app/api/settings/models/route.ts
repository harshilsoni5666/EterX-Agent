import { NextRequest, NextResponse } from 'next/server';
import { discoverProviderModels } from '../../../../lib/provider-model-discovery';
import {
  getRuntimeApiKeyStatus, getRuntimeApiKeyValues as savedApiKeyValues, type RuntimeApiKeyProvider,
} from '../../../../lib/agent/runtime-api-keys';
import type { MainAgentProvider } from '../../../../lib/agent/model-routing';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import { getRuntimeProviderBaseURLs, normalizeProviderBaseURL } from '../../../../lib/agent/provider-runtime';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { readStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  hydrateServerRuntimeSettings();
  const body = await req.json().catch(() => ({}));
  // The chat catalog uses only the provider pool. A key assigned to one
  // model must not make the provider's entire catalog selectable.
  const saved = body?.providerKeysOnly === true ? readStoredRuntimeSettings() : null;
  const keys: Record<string, string[]> = saved || body?.replaceRuntimeKeys === true ? {} : Object.fromEntries(
    Object.keys(getRuntimeApiKeyStatus()).map(provider => [provider, savedApiKeyValues(provider as RuntimeApiKeyProvider)]),
  );
  const keyInput = saved ? saved.apiKeys : body?.apiKeys;
  for (const [provider, value] of Object.entries(keyInput && typeof keyInput === 'object' ? keyInput : {})) {
    keys[provider] = (Array.isArray(value) ? value : [value]).flatMap(item => String(item || '').split(/[\n,;]+/))
      .map(key => key.trim()).filter(Boolean);
  }
  const baseURLs = saved ? (saved.baseURLs || {}) : body?.baseURLs && typeof body.baseURLs === 'object'
    ? { ...getRuntimeProviderBaseURLs(), ...Object.fromEntries(Object.entries(body.baseURLs).filter(([provider]) => isModelProvider(provider))
      .map(([provider, value]) => [provider, normalizeProviderBaseURL(provider as MainAgentProvider, value)])) }
    : getRuntimeProviderBaseURLs();

  const providers = await discoverProviderModels({
    keys, baseURLs,
    providers: Array.isArray(body?.providers) ? body.providers.map(String) : undefined,
    verifySavedEndpoint: Boolean(saved),
    expectedBaseURL: body?.expectedBaseURL,
  });
  return NextResponse.json({ ok: true, updatedAt: Date.now(), providers });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  return POST(new NextRequest(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ providers: url.searchParams.get('providers')?.split(',').map(value => value.trim()).filter(Boolean) }),
  }));
}
