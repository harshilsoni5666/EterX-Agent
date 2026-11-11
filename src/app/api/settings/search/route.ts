import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { updateStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { applyRuntimeSearchSettings, testSearchProvider } from '../../../../lib/search/search-runtime';
import { SEARCH_PROVIDER_IDS, normalizeSearchSettings, type SearchProvider } from '../../../../lib/search/search-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isSearchProvider = (value: unknown): value is SearchProvider =>
  typeof value === 'string' && (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);

export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;

  try {
    const body = await req.json().catch(() => ({}));
    const provider = String(body?.provider || '').trim();
    if (!isSearchProvider(provider)) {
      return NextResponse.json({ ok: false, error: 'Unknown external search provider.' }, { status: 400 });
    }

    const result = await testSearchProvider(provider, String(body?.key || ''), String(body?.baseURL || ''));
    return NextResponse.json({
      ok: true,
      provider,
      result: {
        provider: result.result.provider,
        resultCount: result.result.results.length,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'External service test failed.' }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  hydrateServerRuntimeSettings();
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json().catch(() => null);
    const settings = body && Object.prototype.hasOwnProperty.call(body, 'search') ? body.search : body;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return NextResponse.json({ ok: false, error: 'A search settings object is required.' }, { status: 400 });
    }
    const normalized = normalizeSearchSettings(settings, body?.legacyTavilyKeys);
    await updateStoredRuntimeSettings({ search: normalized });
    const applied = applyRuntimeSearchSettings(normalized);
    return NextResponse.json({ ok: true, provider: applied.provider, fallbackProviders: applied.fallbackProviders });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Could not apply external service settings.' }, { status: 500 });
  }
}
