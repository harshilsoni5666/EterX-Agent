import { NextRequest, NextResponse } from 'next/server';
import { webSearchTool } from '../../../lib/agent/tools/core/search';
import { rejectCrossOrigin } from '../agent/_shared';
import { formatUnknownError } from '../../../lib/agent/error-format';
import { hydrateServerRuntimeSettings } from '../../../lib/agent/server-runtime-hydration';
import { buildScopedRuntimeSettings } from '../../../lib/agent/runtime-api-keys';
import { isModelProvider } from '../../../lib/agent/model-selector-store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    hydrateServerRuntimeSettings();

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Expected a JSON object.' }, { status: 400 });
    const { selectedModel, ...input } = body;
    const parsed = webSearchTool.inputSchema.safeParse(input);

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid web-search arguments.' }, { status: 400 });
    }
    const action = parsed.data.action || 'search';
    if (['search', 'research'].includes(action) ? !parsed.data.query : !parsed.data.urls?.length) {
      return NextResponse.json({ error: ['search', 'research'].includes(action) ? 'A query is required.' : 'At least one URL is required.' }, { status: 400 });
    }

    const provider = String(selectedModel?.provider || '').trim();
    const model = String(selectedModel?.modelId || selectedModel?.modelName || '').trim();
    const results = await webSearchTool.execute(parsed.data, {
      source: 'api_search', allowNetwork: true, networkPolicy: 'allow',
      runtimeSettings: buildScopedRuntimeSettings(), abortSignal: req.signal,
      ...(isModelProvider(provider) && model ? { selectedModelProvider: provider, selectedModelName: model } : {}),
    });

    return NextResponse.json({ results }, { status: results?.error ? 502 : 200 });
  } catch (error: any) {
    console.error('[API/Search] Error performing web search:', error);
    return NextResponse.json(
      { error: formatUnknownError(error, 'Failed to search web') },
      { status: 500 }
    );
  }
}
