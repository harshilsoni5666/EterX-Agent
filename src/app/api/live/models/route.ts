import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { createLiveCatalogRequest, isAvailableCatalogItem } from '../../../../lib/live/catalog-request';
import { readModelThinkingCapabilities } from '../../../../lib/agent/model-thinking-catalog';
import type { ModelThinkingCapabilities } from '../../../../lib/agent/model-routing';
import {
  getLiveModelOptions, isDeepgramLiveModel, isGeminiLiveModel,
  isOpenAIRealtimeModel, normalizeLiveProvider,
} from '../../../../lib/live/live-provider';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CatalogModel = { id: string; name: string; description?: string; created?: number; tag?: string; thinking?: ModelThinkingCapabilities };

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const body = await req.json().catch(() => ({}));
  const provider = normalizeLiveProvider(body?.provider);
  const client = createLiveCatalogRequest(provider.value, body?.key);
  const reply = (models: CatalogModel[], source: string, error?: string, status = 200) => NextResponse.json({
    ok: !error, provider: provider.value, connected: !error && client.hasKey,
    source, models, updatedAt: Date.now(), ...(error ? { error } : {}),
    connectionStatus: error ? 'unavailable' : 'catalog-loaded',
  }, { status });
  if (!client.hasKey) return reply([], 'unavailable', `Add a dedicated ${provider.label} Live API key.`, 400);

  try {
    let models: CatalogModel[] = [];
    let source = 'live';
    if (provider.provider === 'gemini') {
      const tokens = new Set<string>();
      let token = '';
      for (let page = 0; page < 100; page++) {
        const payload = await client.request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
          + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
        if (!Array.isArray(payload?.models)) throw new Error('Gemini returned an invalid model catalog.');
        models.push(...payload.models.filter((model: any) => isAvailableCatalogItem(model)
          && Array.isArray(model.supportedGenerationMethods)
          && model.supportedGenerationMethods.includes('bidiGenerateContent'))
          .map((model: any) => ({
            id: String(model.name || model.baseModelId || '').replace(/^models\//, ''),
            name: String(model.displayName || model.name || '').replace(/^models\//, ''),
            description: model.description,
            thinking: readModelThinkingCapabilities(model, 'gemini'),
          })));
        token = String(payload.nextPageToken || '');
        if (!token) break;
        if (tokens.has(token) || page === 99) throw new Error('Gemini returned an incomplete model catalog. Please retry.');
        tokens.add(token);
      }
      models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    } else if (provider.provider === 'openai' || provider.provider === 'grok') {
      const payload = await client.request(provider.provider === 'openai'
        ? 'https://api.openai.com/v1/models' : 'https://api.x.ai/v1/models');
      if (!Array.isArray(payload?.data)) throw new Error(`${provider.label} returned an invalid model catalog.`);
      models = payload.data.filter((model: any) => isAvailableCatalogItem(model)
        && (provider.provider === 'openai' ? isOpenAIRealtimeModel(model.id) : /^grok-voice(?:-|$)/i.test(String(model.id))))
        .map((model: any) => ({ id: String(model.id).trim(), name: String(model.display_name || model.name || model.id), created: Number(model.created) || 0,
          thinking: readModelThinkingCapabilities(model, provider.provider === 'openai' ? 'openai' : 'grok') }));
      models.sort((a, b) => (b.created || 0) - (a.created || 0) || b.id.localeCompare(a.id, undefined, { numeric: true }));
      // xAI's general model directory can omit its separately served voice API.
      // Label the documented transport catalog honestly instead of claiming discovery.
      if (provider.provider === 'grok' && !models.length) {
        await client.request('https://api.x.ai/v1/tts/voices');
        source = 'documented-catalog';
        models = getLiveModelOptions(provider.value).filter(model => model.value !== 'auto')
          .map(model => ({ id: model.value, name: model.label, description: model.description }));
      }
    } else if (provider.provider === 'deepgram') {
      const payload = await client.request('https://api.deepgram.com/v1/models');
      if (!Array.isArray(payload?.stt)) throw new Error('Deepgram returned an invalid listening model catalog.');
      models = payload.stt.filter((model: any) => isAvailableCatalogItem(model) && model.streaming !== false)
        .map((model: any) => ({ id: String(model.canonical_name || model.name || ''), name: String(model.name || model.canonical_name || '') }))
        .filter((model: CatalogModel) => isDeepgramLiveModel(model.id));
    } else if (provider.provider === 'elevenlabs') {
      const agentId = String(body?.agentId || '').trim();
      if (!agentId) {
        // A restricted key need only have agent access, not account-profile access.
        await client.request('https://api.elevenlabs.io/v1/convai/agents?page_size=1');
        if (body?.testOnly === true) return reply([], 'credential-check');
        return reply([], 'agent-configuration', 'Enter an ElevenLabs Agent ID to load its configuration.', 400);
      }
      const agent = await client.request('https://api.elevenlabs.io/v1/convai/agents/' + encodeURIComponent(agentId));
      source = 'agent-configuration';
      models = [{ id: 'agent-default', name: String(agent.name || 'Agent configuration'),
        description: String(agent.conversation_config?.agent?.prompt?.llm || 'Uses the model configured on this agent') }];
    }
    models = Array.from(new Map(models.filter(model => model.id && model.id !== 'auto').map(model => [model.id, model])).values());
    if (!models.length) return reply([], source, `No compatible realtime models were returned by ${provider.label}.`);
    return reply([{ id: 'auto', name: 'Auto (Available provider model)', tag: 'AUTO' }, ...models], source);
  } catch (error) {
    return reply([], 'unavailable', error instanceof Error ? error.message : 'Live model discovery failed.', 502);
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  return POST(new NextRequest(req.url, {
    method: 'POST', headers: req.headers,
    body: JSON.stringify({ provider: url.searchParams.get('provider'), agentId: url.searchParams.get('agentId') }),
  }));
}
