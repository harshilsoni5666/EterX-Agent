import { MODEL_REQUEST_TIMEOUT_MS } from '../agent/model-request-policy';
import { load } from 'cheerio';
import { Anthropic, OpenAI } from '../agent/model-clients';
import { GoogleGenAI } from '@google/genai';
import {
  getRuntimeApiKeyValues,
  getScopedRuntimeApiKeyValues,
  type RuntimeApiKeyProvider,
} from '../agent/runtime-api-keys';
import { withApiKeyRounds } from '../agent/api-retry';
import { getProviderBaseURL } from '../agent/provider-runtime';
import { safeAxiosRequest } from '../agent/tools/shared/url_safety';
import {
  externalServiceJson,
  externalServiceRequest,
  externalServiceSignal,
  externalServiceKeys,
  throwIfExternalServiceCancelled,
  waitForExternalService,
  withExternalServiceContext,
} from '../external-service-runtime';
import {
  normalizeSearchSettings,
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDER_META,
  type SearchService,
  type SearchProvider,
  type SearchSettings,
} from './search-config';

export type SearchAction = 'search' | 'extract' | 'crawl' | 'map' | 'research';

export type SearchExecutionInput = {
  action?: SearchAction;
  route?: 'auto' | 'model' | 'external';
  provider?: SearchProvider;
  query?: string;
  urls?: string[];
  topic?: 'general' | 'news' | 'finance';
  searchDepth?: 'basic' | 'advanced';
  includeAnswer?: boolean;
  includeImages?: boolean;
  includeImageDescriptions?: boolean;
  includeRawContent?: boolean;
  numResults?: number;
};

export type NormalizedSearchItem = {
  title: string;
  url: string;
  content?: string;
  rawContent?: string;
  score?: number;
  favicon?: string;
  publishedDate?: string;
  images?: Array<{ url: string; description?: string }>;
};

export type NormalizedSearchResult = {
  provider: SearchProvider | 'model';
  ai_summary?: string | null;
  images?: Array<{ url: string; description?: string }>;
  results: NormalizedSearchItem[];
  attemptedProviders?: SearchProvider[];
  failedProviders?: Array<{ provider: SearchProvider; error: string }>;
  modelSearch?: NativeModelSearchCapability & { enabled: boolean; attempted: boolean; error?: string };
  [key: string]: unknown;
};

type RuntimeSearchGlobal = typeof globalThis & {
  __eterxSearchSettings?: SearchSettings;
  __eterxSearchKeyCursor?: Partial<Record<SearchProvider, number>>;
};

const runtimeGlobal = globalThis as RuntimeSearchGlobal;
const runtimeKeyCursor = runtimeGlobal.__eterxSearchKeyCursor || (runtimeGlobal.__eterxSearchKeyCursor = {});

const envKeys = (provider: SearchProvider): string[] => {
  const names: Record<SearchProvider, string[]> = {
    tavily: ['TAVILY_API_KEY', 'VITE_TAVILY_API_KEY'],
    brave: ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY'],
    exa: ['EXA_API_KEY'],
    firecrawl: ['FIRECRAWL_API_KEY'],
    firecrawl_selfhosted: ['FIRECRAWL_SELF_HOSTED_API_KEY'],
    parallel: ['PARALLEL_API_KEY'],
    searxng: [],
    duckduckgo: [],
    xai: ['XAI_API_KEY'],
  };
  const values = names[provider].flatMap(name => {
    const direct = String(process.env[name] || '').trim();
    const numbered = Array.from({ length: 3 }, (_, index) => String(process.env[`${name}_${index + 1}`] || '').trim());
    return [direct, ...numbered].filter(Boolean);
  });
  return Array.from(new Set(values)).slice(0, 3);
};

const envBaseURL = (provider: SearchProvider): string => {
  const names: Record<SearchProvider, string[]> = {
    tavily: ['TAVILY_BASE_URL'],
    brave: ['BRAVE_SEARCH_BASE_URL'],
    exa: ['EXA_BASE_URL'],
    firecrawl: ['FIRECRAWL_BASE_URL'],
    firecrawl_selfhosted: ['FIRECRAWL_API_URL', 'FIRECRAWL_SELF_HOSTED_URL'],
    parallel: ['PARALLEL_BASE_URL'],
    searxng: ['SEARXNG_URL'],
    duckduckgo: ['DUCKDUCKGO_BASE_URL'],
    xai: ['XAI_BASE_URL'],
  };
  return names[provider]
    .map(name => String(process.env[name] || '').trim().replace(/\/+$/, ''))
    .find(Boolean) || '';
};

const readEnvironmentSettings = (): SearchSettings => normalizeSearchSettings({
  enabled: process.env.ETERX_SEARCH_ENABLED !== '0',
  preferModelSearch: process.env.ETERX_PREFER_MODEL_SEARCH !== '0',
  provider: process.env.ETERX_SEARCH_PROVIDER,
  xaiModel: process.env.ETERX_SEARCH_XAI_MODEL,
  fallbackProviders: process.env.ETERX_SEARCH_FALLBACK_PROVIDERS === undefined ? undefined
    : process.env.ETERX_SEARCH_FALLBACK_PROVIDERS.split(',').map(value => value.trim()).filter(Boolean),
  apiKeys: Object.fromEntries(SEARCH_PROVIDER_IDS.map(provider => [provider, envKeys(provider)])),
  baseURLs: Object.fromEntries(SEARCH_PROVIDER_IDS.map(provider => [provider, envBaseURL(provider)])),
});

const initialSettings = runtimeGlobal.__eterxSearchSettings || (runtimeGlobal.__eterxSearchSettings = readEnvironmentSettings());

export function getRuntimeSearchSettings(): SearchSettings {
  return normalizeSearchSettings(runtimeGlobal.__eterxSearchSettings || initialSettings);
}

export function getSearchRouteBrief(context?: any): string {
  const settings = getRuntimeSearchSettings();
  if (!settings.enabled) return '[Live web route]\nDisabled in External service settings. Do not call web_search.';
  const provider = settings.provider;
  const meta = SEARCH_PROVIDER_META[provider];
  const enabled = settings.enabledServices[provider] || [];
  const native = settings.preferModelSearch ? getNativeModelSearchCapability(context) : { status: 'unsupported', provider: '', model: '', reason: 'Disabled in External service settings.' };
  const fallbacks = settings.fallbackProviders
    .map(item => SEARCH_PROVIDER_META[item].label)
    .join(' → ') || 'None';
  return [
    '[Live web route]',
    `Active provider: ${meta.label}. Enabled services: ${enabled.join(', ') || 'none'}.`,
    ...(provider === 'xai' ? [`xAI web-search model: ${settings.xaiModel}.`] : []),
    `Provider capabilities: ${meta.capabilities.join(', ')}. Deep research mode: ${meta.deepResearch}.`,
    `Native model search: ${!settings.preferModelSearch ? 'disabled by the built-in search preference' : native.status === 'supported' ? `attempt first via ${native.provider}/${native.model}` : native.status === 'unknown' ? 'support unconfirmed; try the provider adapter when available, then fall back' : 'not available'}. ${native.reason}`,
    `Fallback order: ${fallbacks}.`,
    ...providerOrder(settings).map(id => {
      const candidate = SEARCH_PROVIDER_META[id];
      const ready = (!candidate.requiresKey || providerKeys(id, settings, context).length > 0)
        && (!candidate.requiresEndpoint || Boolean(providerBaseURL(id, settings)));
      return `External option ${id}: ${ready ? 'configured' : 'missing credentials or endpoint'}; enabled services: ${(settings.enabledServices[id] || []).join(', ') || 'none'}; native capabilities: ${candidate.capabilities.join(', ')}; research: ${candidate.deepResearch}.`;
    }),
    'Use route="auto" by default: enabled model search first, then the primary external provider and enabled fallbacks in order. route="external" uses the external chain directly; provider selects an enabled external option for this call. route="model" retries model search first without bypassing settings or losing external fallbacks.',
    'The runtime reads these settings again for every web_search call, so provider, model, service switches, keys, and fallback order take effect without restarting the agent.',
  ].join('\n');
}

export function isSearchServiceEnabled(service: SearchService): boolean {
  const settings = getRuntimeSearchSettings();
  if (!settings.enabled) return false;
  return providerOrder(settings).some(provider => (settings.enabledServices[provider] || []).includes(service));
}

export function applyRuntimeSearchSettings(raw: unknown, legacyTavilyKeys: unknown = undefined): SearchSettings {
  const next = normalizeSearchSettings(raw, legacyTavilyKeys);
  initialSettings.provider = next.provider;
  initialSettings.enabled = next.enabled;
  initialSettings.preferModelSearch = next.preferModelSearch;
  initialSettings.xaiModel = next.xaiModel;
  initialSettings.fallbackProviders = next.fallbackProviders;
  initialSettings.apiKeys = next.apiKeys;
  initialSettings.baseURLs = next.baseURLs;
  initialSettings.enabledServices = next.enabledServices;
  runtimeGlobal.__eterxSearchSettings = initialSettings;
  return getRuntimeSearchSettings();
}

const withTimeout = async <T,>(promise: Promise<T>, milliseconds = 30_000): Promise<T> => {
  if (milliseconds <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Search request timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const asText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const decodeHtml = (value: string): string => value
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));

const stripHtml = (html: string): string => decodeHtml(html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<!--([\s\S]*?)-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim());

const normalizeImages = (images: unknown): Array<{ url: string; description?: string }> => {
  if (!Array.isArray(images)) return [];
  return images.map(image => {
    if (typeof image === 'string') return { url: image.trim() };
    return {
      url: asText((image as any)?.url),
      description: asText((image as any)?.description) || undefined,
    };
  }).filter(image => /^https?:\/\//i.test(image.url));
};

const normalizeItems = (items: unknown): NormalizedSearchItem[] => {
  if (!Array.isArray(items)) return [];
  return items.map((entry: any) => {
    const item = typeof entry === 'string' ? { title: entry, url: entry } : entry;
    const metadata = item?.metadata || {};
    const highlights = Array.isArray(item?.highlights) ? item.highlights.filter((value: unknown) => typeof value === 'string').join('\n\n') : '';
    const excerpts = Array.isArray(item?.excerpts) ? item.excerpts.filter((value: unknown) => typeof value === 'string').join('\n\n') : '';
    return {
      title: asText(item?.title || item?.name || metadata?.title) || 'Untitled result',
      url: asText(item?.url || item?.sourceURL || item?.source_url || metadata?.url || metadata?.sourceURL || metadata?.source_url),
      content: asText(item?.content || item?.description || item?.snippet || item?.text || item?.summary || highlights || excerpts),
      rawContent: asText(item?.rawContent || item?.raw_content || item?.markdown || item?.text),
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : undefined,
      favicon: asText(item?.favicon || metadata?.favicon),
      publishedDate: asText(item?.publishedDate || item?.published_date || item?.published || metadata?.publishedDate || metadata?.published_date),
      images: normalizeImages(item?.images || (item?.image ? [item.image] : item?.img_src || item?.imageUrl ? [{ url: item.img_src || item.imageUrl, description: item.title }] : [])),
    };
  }).filter(item => /^https?:\/\//i.test(item.url));
};

const result = (provider: SearchProvider | 'model', payload: any, items: unknown, summary?: unknown): NormalizedSearchResult => ({
  provider,
  ...(provider !== 'model' ? {
    providerCapabilities: SEARCH_PROVIDER_META[provider].capabilities,
    deepResearchMode: SEARCH_PROVIDER_META[provider].deepResearch,
  } : {}),
  ai_summary: asText(summary) || null,
  images: normalizeImages(payload?.images),
  results: normalizeItems(items),
});

export type NativeModelSearchCapability = {
  provider: string;
  model: string;
  status: 'supported' | 'unsupported' | 'unknown';
  reason: string;
};

const NATIVE_SEARCH_PROVIDERS = ['gemini', 'openai', 'grok', 'anthropic', 'perplexity', 'openrouter', 'mistral', 'qwen', 'zai'];

/**
 * A known provider adapter may attempt an unfamiliar model ID. Providers, not
 * a frozen list of model versions, determine whether the selected model can
 * search. Rejections still fall through to the configured external chain.
 */
export function getNativeModelSearchCapability(context?: any): NativeModelSearchCapability {
  const provider = String(context?.selectedModelProvider || '').trim().toLowerCase();
  const model = String(context?.selectedModelName || '').trim();
  if (!provider || !model) {
    return { provider, model, status: 'unknown', reason: 'The active model is not available to the search runtime.' };
  }
  if (/embedding|(?:^|[-/])(?:tts|realtime|audio|moderation|whisper|dall-e|veo)(?:[-/]|$)/i.test(model)) {
    return { provider, model, status: 'unsupported', reason: 'This is not a text web-search model.' };
  }
  if (provider === 'gemini' && /^(?:models\/)?gemini-(?:[2-9]|\d{2})/i.test(model) && !/image|robotics/i.test(model)) {
    return { provider, model, status: 'supported', reason: 'Gemini Google Search grounding is available for this model family.' };
  }
  if (provider === 'openai' && /^(?:gpt-(?:[5-9]|\d{2})(?:\.\d+)?|gpt-4\.1|o[34])(?:[-.:]|$)/i.test(model)) {
    return { provider, model, status: 'supported', reason: 'OpenAI Responses web search is available for this model family.' };
  }
  if (provider === 'grok' && /^grok-/i.test(model)) {
    return { provider, model, status: 'supported', reason: 'xAI server-side web search is available for Grok.' };
  }
  if (provider === 'anthropic' && /^claude-/i.test(model)) {
    return { provider, model, status: 'supported', reason: 'Anthropic server-side web search is available for Claude.' };
  }
  if (provider === 'perplexity' && /sonar|perplexity/i.test(model)) {
    return { provider, model, status: 'supported', reason: 'Perplexity search-grounded models are available for this model family.' };
  }
  if (provider === 'openrouter') {
    return { provider, model, status: 'unknown', reason: 'Try OpenRouter native web search on the selected endpoint; external fallbacks remain available if unsupported.' };
  }
  if (NATIVE_SEARCH_PROVIDERS.includes(provider)) {
    return { provider, model, status: 'unknown', reason: 'Try the native search adapter for this model ID, then fall back if the provider rejects it.' };
  }
  return { provider, model, status: 'unsupported', reason: 'This provider does not advertise a native web-search tool.' };
}

const nativeModelKey = (provider: string, context?: any): string => {
  const scoped = context?.runtimeSettings && typeof context.runtimeSettings === 'object'
    ? getScopedRuntimeApiKeyValues(context.runtimeSettings, provider as RuntimeApiKeyProvider)
    : [];
  return scoped[0] || getRuntimeApiKeyValues(provider as RuntimeApiKeyProvider)[0] || '';
};

const responseURLCitations = (payload: any): Array<{ title: string; url: string; content?: string }> => {
  const citations: Array<{ title: string; url: string; content?: string }> = [];
  const seen = new Set<string>();
  const visit = (value: any, sourceField = false) => {
    if (typeof value === 'string' && sourceField && /^https?:\/\//i.test(value)) {
      if (!seen.has(value)) {
        seen.add(value);
        citations.push({ title: value, url: value });
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, sourceField));
      return;
    }
    const url = asText(value.url || value.uri || value.source_url || value.link);
    const type = asText(value.type).toLowerCase();
    if (/^https?:\/\//i.test(url) && (sourceField || type.includes('citation') || type.includes('source') || value.title || value.snippet)) {
      if (!seen.has(url)) {
        seen.add(url);
        citations.push({ title: asText(value.title || value.name) || url, url, content: asText(value.snippet || value.text || value.content || value.description) || undefined });
      }
    }
    Object.entries(value).forEach(([key, child]) => visit(child, sourceField || /^(citations|sources|search_results|search_result|url_citation|annotations)$/.test(key)));
  };
  visit(payload);
  return citations;
};

const responseText = (payload: any): string => {
  const direct = asText(payload?.output_text) || asText(payload?.text) || asText(payload?.choices?.[0]?.message?.content) || asText(payload?.output?.choices?.[0]?.message?.content);
  if (direct) return direct;
  return (Array.isArray(payload?.output) ? payload.output : Array.isArray(payload?.outputs) ? payload.outputs : [])
    .flatMap((item: any) => typeof item?.content === 'string' ? [item.content]
      : Array.isArray(item?.content) ? item.content.map((part: any) => asText(part?.text)).filter(Boolean) : [])
    .join('\n\n');
};

const nativeSearchPrompt = (input: SearchExecutionInput): string =>
  `Search the live web for this request and cite the source URLs. Use current source evidence, not memory alone.${input.action === 'research' ? ' Research multiple angles, compare independent sources, and identify gaps or conflicting evidence.' : ''}\n${input.query}`;

const executeNativeGeminiSearch = async (input: SearchExecutionInput, context: any, capability: NativeModelSearchCapability, apiKey?: string): Promise<NormalizedSearchResult> => {
  const key = apiKey || nativeModelKey('gemini', context);
  if (!key) throw new Error('No Gemini API key is available for native model search.');
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const baseURL = getProviderBaseURL('gemini');
  const ai = new GoogleGenAI({ httpOptions: { timeout: MODEL_REQUEST_TIMEOUT_MS, ...(baseURL ? { baseUrl: baseURL } : {}) }, apiKey: key });
  const response: any = await withTimeout(ai.models.generateContent({
    model: capability.model,
    contents: nativeSearchPrompt(input),
    config: { tools: [{ googleSearch: {} }], abortSignal: externalServiceSignal() },
  }), MODEL_REQUEST_TIMEOUT_MS);
  const metadata = response?.candidates?.[0]?.groundingMetadata || response?.groundingMetadata || {};
  const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
  const items = chunks.map((chunk: any) => {
    const web = chunk?.web || chunk?.retrievedContext || {};
    return { title: web.title, url: web.uri || web.url, content: web.snippet || '' };
  });
  return {
    provider: 'model',
    source: 'model',
    nativeSearch: true,
    modelProvider: capability.provider,
    model: capability.model,
    ai_summary: asText(response?.text) || null,
    results: normalizeItems(items),
    searchQueries: metadata?.webSearchQueries || [],
  };
};

const executeNativeResponsesSearch = async (input: SearchExecutionInput, context: any, capability: NativeModelSearchCapability, apiKey?: string): Promise<NormalizedSearchResult> => {
  const key = apiKey || nativeModelKey(capability.provider === 'grok' ? 'grok' : 'openai', context);
  if (!key) throw new Error(`No ${capability.provider} API key is available for native model search.`);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const provider = capability.provider as 'openai' | 'grok';
  const baseURL = getProviderBaseURL(provider);
  if (!baseURL) throw new Error(`${provider} requires a configured API base URL.`);
  const chatSearch = provider === 'openai' && /-search-(?:api|preview)(?:-|$)/i.test(capability.model);
  const payload = await requestJson(`${baseURL}/${chatSearch ? 'chat/completions' : 'responses'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: capability.model,
      ...(chatSearch ? {
        messages: [{ role: 'user', content: nativeSearchPrompt(input) }],
        web_search_options: {},
      } : {
        input: [{ role: 'user', content: nativeSearchPrompt(input) }],
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        ...(provider === 'openai' ? { include: ['web_search_call.action.sources'] } : {}),
      }),
    }),
  }, MODEL_REQUEST_TIMEOUT_MS);
  const citations = responseURLCitations(payload);
  return {
    provider: 'model',
    source: 'model',
    nativeSearch: true,
    modelProvider: capability.provider,
    model: capability.model,
    ai_summary: responseText(payload) || null,
    results: normalizeItems(citations),
  };
};

const executeNativeAnthropicSearch = async (input: SearchExecutionInput, context: any, capability: NativeModelSearchCapability, apiKey?: string): Promise<NormalizedSearchResult> => {
  const key = apiKey || nativeModelKey('anthropic', context);
  if (!key) throw new Error('No Anthropic API key is available for native model search.');
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const client = new Anthropic({ timeout: MODEL_REQUEST_TIMEOUT_MS, apiKey: key, baseURL: getProviderBaseURL('anthropic'), maxRetries: 0 });
  const messages: any[] = [{ role: 'user', content: nativeSearchPrompt(input) }];
  const blocks: any[] = [];
  let response: any;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await withTimeout(client.messages.create({
      model: capability.model,
      max_tokens: 1600,
      messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    } as any, { signal: externalServiceSignal() }), MODEL_REQUEST_TIMEOUT_MS);
    if (Array.isArray(response?.content)) blocks.push(...response.content);
    if (response?.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  const text = blocks.filter((block: any) => block?.type === 'text').map((block: any) => block.text || '').join('\n\n');
  const searchError = blocks.find(block => block?.content?.type === 'web_search_tool_result_error');
  if (searchError) throw new Error(`Anthropic web search failed: ${searchError.content.error_code || 'unknown error'}`);
  return {
    provider: 'model',
    source: 'model',
    nativeSearch: true,
    modelProvider: capability.provider,
    model: capability.model,
    ai_summary: asText(text) || null,
    results: normalizeItems(responseURLCitations(blocks)),
  };
};

const executeNativePerplexitySearch = async (input: SearchExecutionInput, context: any, capability: NativeModelSearchCapability, apiKey?: string): Promise<NormalizedSearchResult> => {
  const key = apiKey || nativeModelKey('perplexity', context);
  if (!key) throw new Error('No Perplexity API key is available for native model search.');
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const client = new OpenAI({ timeout: MODEL_REQUEST_TIMEOUT_MS, apiKey: key, baseURL: getProviderBaseURL('perplexity'), maxRetries: 0 });
  const response: any = await withTimeout(client.chat.completions.create({
    model: capability.model,
    messages: [{ role: 'user', content: nativeSearchPrompt(input) }],
    max_tokens: 1600,
  }, { signal: externalServiceSignal() }), MODEL_REQUEST_TIMEOUT_MS);
  const citations = responseURLCitations(response);
  return {
    provider: 'model',
    source: 'model',
    nativeSearch: true,
    modelProvider: capability.provider,
    model: capability.model,
    ai_summary: asText(response?.choices?.[0]?.message?.content) || null,
    results: normalizeItems(citations),
  };
};

const executeNativeOpenRouterSearch = async (input: SearchExecutionInput, capability: NativeModelSearchCapability, apiKey: string): Promise<NormalizedSearchResult> => {
  const payload = await requestJson(`${getProviderBaseURL('openrouter')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: capability.model,
      messages: [{ role: 'user', content: nativeSearchPrompt(input) }],
      tools: [{ type: 'openrouter:web_search', parameters: { engine: 'native' } }],
    }),
  }, MODEL_REQUEST_TIMEOUT_MS);
  return { provider: 'model', source: 'model', nativeSearch: true, modelProvider: capability.provider, model: capability.model, ai_summary: responseText(payload) || null, results: normalizeItems(responseURLCitations(payload)) };
};

const executeNativeProviderSearch = async (input: SearchExecutionInput, capability: NativeModelSearchCapability, apiKey: string): Promise<NormalizedSearchResult> => {
  const provider = capability.provider as 'mistral' | 'qwen' | 'zai';
  const baseURL = getProviderBaseURL(provider);
  let endpoint = `${baseURL}/chat/completions`;
  let body: Record<string, unknown> = { model: capability.model, messages: [{ role: 'user', content: nativeSearchPrompt(input) }] };
  if (provider === 'mistral') {
    endpoint = `${baseURL}/conversations`;
    body = { model: capability.model, inputs: nativeSearchPrompt(input), tools: [{ type: 'web_search' }], store: false, stream: false };
  } else if (provider === 'qwen') {
    // Older Chat Completions search omits source URLs. Use the same host's
    // DashScope endpoint for those models; newer models expose citations in Responses.
    const legacy = /^qwen-(?:plus|turbo|max)(?:-|$)|^qwen[23](?:-|$)|^qwen2\.5/i.test(capability.model);
    if (legacy) {
      if (!/\/compatible-mode\/v1\/?$/i.test(baseURL)) throw new Error('This Qwen endpoint does not expose the DashScope source-returning search API.');
      endpoint = `${baseURL.replace(/\/compatible-mode\/v1\/?$/i, '')}/api/v1/services/aigc/text-generation/generation`;
      body = { model: capability.model, input: { messages: [{ role: 'user', content: nativeSearchPrompt(input) }] }, parameters: { enable_search: true, search_options: { enable_source: true, search_strategy: 'agent' }, result_format: 'message' } };
    } else {
      endpoint = `${baseURL}/responses`;
      body = { model: capability.model, input: nativeSearchPrompt(input), tools: [{ type: 'web_search' }], enable_thinking: true };
    }
  } else {
    body.tools = [{ type: 'web_search', web_search: { enable: true, search_engine: 'search-prime', search_result: true, search_query: input.query, count: Math.min(50, input.numResults || 5) } }];
  }
  const payload = await requestJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) }, MODEL_REQUEST_TIMEOUT_MS);
  return { provider: 'model', source: 'model', nativeSearch: true, modelProvider: provider, model: capability.model, ai_summary: responseText(payload) || null, results: normalizeItems(responseURLCitations(payload)) };
};

async function executeNativeModelSearch(input: SearchExecutionInput, context: any, capability: NativeModelSearchCapability): Promise<NormalizedSearchResult> {
  const keyProvider = capability.provider === 'grok' ? 'grok' : capability.provider;
  const keys = getScopedRuntimeApiKeyValues(context?.runtimeSettings, keyProvider as RuntimeApiKeyProvider);
  if (!keys[0]) throw new Error(`No ${capability.provider} API key is available for native model search.`);

  return withApiKeyRounds(keys, context?.runtimeSettings, async apiKey => {
    let response: NormalizedSearchResult;
    switch (capability.provider) {
      case 'gemini': response = await executeNativeGeminiSearch(input, context, capability, apiKey); break;
      case 'openai':
      case 'grok': response = await executeNativeResponsesSearch(input, context, capability, apiKey); break;
      case 'anthropic': response = await executeNativeAnthropicSearch(input, context, capability, apiKey); break;
      case 'perplexity': response = await executeNativePerplexitySearch(input, context, capability, apiKey); break;
      case 'openrouter': response = await executeNativeOpenRouterSearch(input, capability, apiKey); break;
      case 'mistral':
      case 'qwen':
      case 'zai': response = await executeNativeProviderSearch(input, capability, apiKey); break;
      default: throw new Error('Native model search is not available for this provider.');
    }
    if (response.results.length === 0) throw new Error('Native search returned no source URLs.');
    return response;
  }, externalServiceSignal());
}

const providerBaseURL = (provider: SearchProvider, settings: SearchSettings): string => {
  const meta = SEARCH_PROVIDER_META[provider];
  return settings.baseURLs[provider] || envBaseURL(provider) || meta.defaultBaseURL || '';
};

const requireURL = (provider: SearchProvider, settings: SearchSettings): string => {
  const baseURL = providerBaseURL(provider, settings);
  if (!baseURL) throw new Error(`${SEARCH_PROVIDER_META[provider].label} needs an endpoint URL in External service settings.`);
  return baseURL;
};

const requestJson = (url: string, init: RequestInit, timeout = 30_000): Promise<any> => externalServiceJson(url, init, timeout);

const executeTavily = async (input: SearchExecutionInput, key: string, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if (!key) throw new Error('No Tavily API key configured.');
  const baseURL = requireURL('tavily', settings);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const post = (endpoint: string, body: Record<string, unknown>, timeout = 60_000) => requestJson(`${baseURL}/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) }, timeout);
  const action = input.action || 'search';
  if (action === 'extract') {
    if (!input.urls?.length) throw new Error("Extract action requires the 'urls' array parameter.");
    const response = await post('extract', { urls: input.urls.slice(0, 20), extract_depth: input.searchDepth || 'basic', include_images: input.includeImages || false });
    return { provider: 'tavily', results: normalizeItems(response?.results), failed: response?.failed_results };
  }
  if (action === 'crawl') {
    if (!input.urls?.length) throw new Error("Crawl action requires the 'urls' array parameter.");
    const response = await post('crawl', { url: input.urls[0], extract_depth: input.searchDepth || 'basic', include_images: input.includeImages || false, max_depth: 2, limit: input.numResults || 10 }, 120_000);
    return { ...response, provider: 'tavily', results: normalizeItems(response?.results) };
  }
  if (action === 'map') {
    if (!input.urls?.length) throw new Error("Map action requires the 'urls' array parameter.");
    const response = await post('map', { url: input.urls[0], limit: input.numResults || 20 });
    const mapped = Array.isArray(response?.results) ? response.results.map((url: string) => ({ title: url, url, content: '' })) : [];
    return { ...response, provider: 'tavily', results: normalizeItems(mapped) };
  }
  if (action === 'research') {
    if (!input.query) throw new Error("Research action requires the 'query' parameter.");
    const task = await post('research', { input: input.query, model: 'auto', stream: false });
    const requestId = task?.request_id;
    if (!requestId) throw new Error('Tavily did not return a research request id.');
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await waitForExternalService(2000);
      const response = await requestJson(`${baseURL}/research/${encodeURIComponent(requestId)}`, { headers });
      if (response?.status !== 'processing' && response?.status !== 'pending') {
        if (['failed', 'error', 'cancelled', 'canceled'].includes(response?.status)) throw new Error('Tavily research failed.');
        return { ...response, provider: 'tavily', results: normalizeItems(response?.results || response?.sources), ai_summary: asText(response?.content || response?.report || response?.answer) || null };
      }
    }
    throw new Error('Tavily research task timed out.');
  }
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const response = await post('search', {
    query: input.query,
    search_depth: input.searchDepth || 'basic',
    topic: input.topic || 'general',
    include_answer: input.includeAnswer !== false,
    include_images: input.includeImages || false,
    include_image_descriptions: input.includeImages ? input.includeImageDescriptions !== false : false,
    include_raw_content: input.includeRawContent ? 'markdown' : false,
    max_results: Math.min(20, input.numResults || 5),
  });
  return result('tavily', response, response?.results, response?.answer);
};

const executeBrave = async (input: SearchExecutionInput, key: string, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if (!key) throw new Error('No Brave Search API key configured.');
  if ((input.action || 'search') !== 'search') return executeGenericWebAction(input, 'brave', settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const url = new URL(`${requireURL('brave', settings)}/${input.includeImages ? 'images' : input.topic === 'news' ? 'news' : 'web'}/search`);
  url.searchParams.set('q', input.query);
  url.searchParams.set('count', String(Math.min(20, Math.max(1, input.numResults || 5))));
  if (input.topic === 'news' && !input.includeImages) url.searchParams.set('freshness', 'pw');
  const payload = await requestJson(url.toString(), { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  if (input.includeImages) {
    const items = (payload?.results || []).map((item: any) => ({ ...item, images: [{ url: item?.properties?.url || item?.thumbnail?.src, description: item?.title }] }));
    return result('brave', { images: items.flatMap((item: any) => item.images) }, items, null);
  }
  return result('brave', payload, payload?.web?.results || payload?.results, payload?.summarizer?.text);
};

const executeExa = async (input: SearchExecutionInput, key: string, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if (!key) throw new Error('No Exa API key configured.');
  const action = input.action || 'search';
  if (action === 'extract') {
    if (!input.urls?.length) throw new Error("Extract action requires the 'urls' array parameter.");
    const payload = await requestJson(`${requireURL('exa', settings)}/contents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ ids: input.urls, text: true, highlights: true }),
    });
    return result('exa', payload, payload?.results, null);
  }
  if (action !== 'search') return executeGenericWebAction(input, 'exa', settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const payload = await requestJson(`${requireURL('exa', settings)}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query: input.query,
      numResults: Math.min(20, Math.max(1, input.numResults || 5)),
      contents: { highlights: true, ...(input.includeRawContent ? { text: true } : {}) },
    }),
  });
  return result('exa', payload, payload?.results, null);
};

const executeFirecrawl = async (input: SearchExecutionInput, key: string, settings: SearchSettings, provider: SearchProvider = 'firecrawl'): Promise<NormalizedSearchResult> => {
  if (!key && SEARCH_PROVIDER_META[provider].requiresKey) throw new Error(`No ${SEARCH_PROVIDER_META[provider].label} API key configured.`);
  const action = input.action || 'search';
  const baseURL = requireURL(provider, settings);
  const apiURL = provider === 'firecrawl_selfhosted' && !/\/v\d+$/i.test(baseURL) ? `${baseURL}/v2` : baseURL;
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  if (action === 'extract') {
    if (!input.urls?.length) throw new Error("Extract action requires the 'urls' array parameter.");
    const results = await Promise.all(input.urls.map(async url => {
      const payload = await requestJson(`${apiURL}/scrape`, {
        method: 'POST', headers,
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });
      return { title: payload?.data?.metadata?.title || url, url, content: payload?.data?.markdown || payload?.data?.text || '', rawContent: payload?.data?.markdown || '' };
    }));
    return result(provider, {}, results, null);
  }
  if (action === 'map') {
    if (!input.urls?.length) throw new Error("Map action requires the 'urls' array parameter.");
    const payload = await requestJson(`${apiURL}/map`, {
      method: 'POST', headers,
      body: JSON.stringify({ url: input.urls[0], limit: Math.min(1000, Math.max(1, input.numResults || 50)) }),
    });
    return result(provider, payload, payload?.links || payload?.data, null);
  }
  if (action === 'crawl') {
    if (!input.urls?.length) throw new Error("Crawl action requires the 'urls' array parameter.");
    const started = await requestJson(`${apiURL}/crawl`, {
      method: 'POST', headers,
      body: JSON.stringify({ url: input.urls[0], limit: Math.min(100, Math.max(1, input.numResults || 20)), scrapeOptions: { formats: ['markdown'] } }),
    });
    const immediateData = started?.data || started?.results;
    if (Array.isArray(immediateData)) return result(provider, started, immediateData, null);
    const crawlId = asText(started?.id || started?.crawlId || started?.crawl_id);
    if (!crawlId) throw new Error(`${SEARCH_PROVIDER_META[provider].label} did not return a crawl job id.`);
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await waitForExternalService(1000);
      const status = await requestJson(`${apiURL}/crawl/${encodeURIComponent(crawlId)}`, { headers });
      const state = asText(status?.status).toLowerCase();
      if (state === 'failed' || state === 'cancelled') throw new Error(`${SEARCH_PROVIDER_META[provider].label} crawl ${state}.`);
      if (state === 'completed') return result(provider, status, status?.data, null);
    }
    throw new Error(`${SEARCH_PROVIDER_META[provider].label} crawl timed out.`);
  }
  if (action !== 'search') return executeGenericWebAction(input, provider, settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const payload = await requestJson(`${apiURL}/search`, {
    method: 'POST', headers,
    body: JSON.stringify({
      query: input.query,
      limit: Math.min(20, Math.max(1, input.numResults || 5)),
      sources: input.includeImages ? ['web', 'images'] : input.topic === 'news' ? ['news'] : ['web'],
      scrapeOptions: input.includeRawContent ? { formats: ['markdown'] } : undefined,
    }),
  });
  const data = payload?.data || payload;
  const imageItems = Array.isArray(data?.images) ? data.images.map((item: any) => ({ ...item, images: [{ url: item.imageUrl, description: item.title }] })) : [];
  const items = [...(Array.isArray(data) ? data : data?.web || data?.news || []), ...imageItems];
  return result(provider, { images: imageItems.flatMap((item: any) => item.images) }, items, null);
};

const executeParallel = async (input: SearchExecutionInput, key: string, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if (!key) throw new Error('No Parallel API key configured.');
  const action = input.action || 'search';
  if (action === 'extract') {
    if (!input.urls?.length) throw new Error("Extract action requires the 'urls' array parameter.");
  const payload = await requestJson(`${requireURL('parallel', settings)}/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        urls: input.urls.slice(0, 20),
        objective: input.query || 'Extract the relevant page content for the current research task.',
        max_chars_total: input.includeRawContent ? 40_000 : 12_000,
        advanced_settings: {
          excerpt_settings: { max_chars_per_result: input.includeRawContent ? 3_000 : 1_200 },
          ...(input.includeRawContent ? { full_content: { max_chars_per_result: 50_000 } } : {}),
        },
      }),
    });
    const items = (payload?.results || []).map((item: any) => ({
      title: item?.title || item?.url,
      url: item?.url,
      content: Array.isArray(item?.excerpts) ? item.excerpts.join('\n\n') : item?.full_content || item?.content,
      rawContent: item?.full_content || item?.content,
    }));
    return result('parallel', payload, items, null);
  }
  if (action !== 'search') return executeGenericWebAction(input, 'parallel', settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const payload = await requestJson(`${requireURL('parallel', settings)}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      objective: input.query,
      search_queries: [input.query],
      max_chars_total: input.includeRawContent ? 40_000 : 12_000,
      advanced_settings: {
        excerpt_settings: { max_chars_per_result: input.includeRawContent ? 3_000 : 1_200 },
      },
    }),
  });
  return result('parallel', payload, payload?.results, null);
};

const executeSearxng = async (input: SearchExecutionInput, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if ((input.action || 'search') !== 'search') return executeGenericWebAction(input, 'searxng', settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const base = requireURL('searxng', settings);
  const endpoint = /\/search$/i.test(base) ? base : `${base}/search`;
  const url = new URL(endpoint);
  url.searchParams.set('q', input.query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', input.includeImages ? 'images' : input.topic === 'news' ? 'news' : 'general');
  const payload = await requestJson(url.toString(), { headers: { Accept: 'application/json' } });
  return result('searxng', payload, payload?.results, null);
};

const executeDuckDuckGo = async (input: SearchExecutionInput, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if ((input.action || 'search') !== 'search') return executeGenericWebAction(input, 'duckduckgo', settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const url = new URL(requireURL('duckduckgo', settings));
  url.searchParams.set('q', input.query);
  const response = await externalServiceRequest(url.toString(), { headers: { Accept: 'text/html', 'User-Agent': 'EterX-Agent/1.0' } }, 30_000);
  const html = await response.text();
  const items: NormalizedSearchItem[] = [];
  const $ = load(html);
  for (const anchor of $('.result__a').toArray().slice(0, input.numResults || 5)) {
    const rawURL = $(anchor).attr('href') || '';
    let resultURL = rawURL;
    try {
      const parsedURL = new URL(rawURL, 'https://duckduckgo.com');
      resultURL = parsedURL.searchParams.get('uddg') || parsedURL.toString();
    } catch { }
    const title = $(anchor).text().trim();
    const content = $(anchor).closest('.result').find('.result__snippet').text().trim();
    if (/^https?:\/\//i.test(resultURL)) items.push({ title, url: resultURL, content });
  }
  return result('duckduckgo', {}, items, null);
};

const executeXai = async (input: SearchExecutionInput, key: string, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if (!key) throw new Error('No xAI API key configured.');
  if ((input.action || 'search') !== 'search') return executeGenericWebAction(input, 'xai', settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const payload = await requestJson(`${requireURL('xai', settings)}/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: settings.xaiModel, input: [{ role: 'user', content: nativeSearchPrompt(input) }], tools: [{ type: 'web_search' }], tool_choice: 'required' }),
  });
  return result('xai', payload, responseURLCitations(payload), responseText(payload));
};

const executeGenericWebAction = async (input: SearchExecutionInput, provider: SearchProvider, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  const action = input.action || 'search';
  if (action === 'search') throw new Error('Provider search adapter is unavailable.');
  if (action === 'research') {
    if (!input.query) throw new Error("Research action requires the 'query' parameter.");
    const angles = Array.from(new Set([
      input.query,
      `${input.query} key facts evidence sources`,
      `${input.query} analysis perspectives limitations`,
    ]));
    const settled = await Promise.allSettled(angles.map(query => executeSearchProvider({
      ...input,
      action: 'search',
      query,
      searchDepth: 'advanced',
      includeAnswer: true,
      includeRawContent: true,
      numResults: Math.max(3, Math.min(8, input.numResults || 5)),
    }, provider, settings)));
    throwIfExternalServiceCancelled();
    const searches = settled.flatMap(entry => entry.status === 'fulfilled' ? [entry.value] : []);
    if (!searches.length) throw new Error('All research searches failed.');
    const seen = new Set<string>();
    const results = searches.flatMap(search => search.results || []).filter(item => {
      const key = String(item.url || item.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const summaries = searches.map(search => asText(search.ai_summary)).filter(Boolean);
    if (results.length && (settings.enabledServices[provider] || []).includes('read')) {
      const pages = await executeGenericWebAction({ action: 'extract', urls: results.slice(0, 5).map(item => item.url) }, provider, settings);
      const byURL = new Map(pages.results.map(item => [item.url, item]));
      results.forEach(item => {
        const page = byURL.get(item.url);
        if (page?.rawContent) { item.rawContent = page.rawContent; item.content = page.content || item.content; }
      });
    }
    return {
      provider,
      results,
      ai_summary: summaries.join('\n\n') || null,
      research: true,
      researchAngles: angles,
      failedAngles: settled.flatMap((entry, index) => entry.status === 'rejected' ? [{ query: angles[index], error: String(entry.reason?.message || entry.reason) }] : []),
    };
  }
  if (!input.urls?.length) throw new Error(`${action} action requires the 'urls' array parameter.`);
  const readPublicPage = async (url: string, accept: string) => {
    const response = await safeAxiosRequest<string>({
      url,
      method: 'GET',
      responseType: 'text',
      timeout: 30_000,
      signal: externalServiceSignal(),
      maxContentLength: 2 * 1024 * 1024,
      headers: { Accept: accept, 'User-Agent': 'EterX-Agent/1.0' },
    });
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (contentType && !/text\/|json|xml|javascript/.test(contentType)) throw new Error(`Direct page reading does not support ${contentType}.`);
    return { raw: String(response.data || ''), contentType };
  };
  if (action === 'map' || action === 'crawl') {
    const root = new URL(input.urls[0]);
    const { raw: html } = await readPublicPage(root.toString(), 'text/html');
    const $ = load(html);
    const links = new Map<string, string>([[root.toString(), $('title').text().trim() || root.toString()]]);
    for (const anchor of $('a[href]').toArray()) {
      try {
        const target = new URL($(anchor).attr('href') || '', root);
        target.hash = '';
        if (target.origin === root.origin && /^https?:$/.test(target.protocol)) links.set(target.toString(), $(anchor).text().trim() || target.toString());
      } catch { /* Ignore non-web links. */ }
      if (links.size >= (input.numResults || 20)) break;
    }
    if (action === 'map') return { provider, results: Array.from(links, ([url, title]) => ({ url, title })), ai_summary: null };
    const extracted = await executeGenericWebAction({ ...input, action: 'extract', urls: [...links.keys()] }, provider, settings);
    return { ...extracted, crawl: true };
  }
  const pages = await Promise.allSettled(input.urls.slice(0, 20).map(async url => {
    const { raw, contentType } = await readPublicPage(url, 'text/html, text/plain');
    const content = contentType.includes('html') ? stripHtml(raw) : raw.trim();
    return { title: url, url, content: content.slice(0, 12_000), rawContent: content.slice(0, 12_000) };
  }));
  throwIfExternalServiceCancelled();
  return {
    provider,
    results: normalizeItems(pages.flatMap(page => page.status === 'fulfilled' ? [page.value] : [])),
    failedResults: pages.flatMap((page, index) => page.status === 'rejected' ? [{ url: input.urls![index], error: String(page.reason?.message || page.reason) }] : []),
    ai_summary: null,
  };
};

async function executeSearchProvider(input: SearchExecutionInput, provider: SearchProvider, settings: SearchSettings): Promise<NormalizedSearchResult> {
  switch (provider) {
    case 'tavily': return executeTavily(input, settings.apiKeys.tavily?.[0] || '', settings);
    case 'brave': return executeBrave(input, settings.apiKeys.brave?.[0] || '', settings);
    case 'exa': return executeExa(input, settings.apiKeys.exa?.[0] || '', settings);
    case 'firecrawl': return executeFirecrawl(input, settings.apiKeys.firecrawl?.[0] || '', settings);
    case 'firecrawl_selfhosted': return executeFirecrawl(input, settings.apiKeys.firecrawl_selfhosted?.[0] || '', settings, 'firecrawl_selfhosted');
    case 'parallel': return executeParallel(input, settings.apiKeys.parallel?.[0] || '', settings);
    case 'searxng': return executeSearxng(input, settings);
    case 'duckduckgo': return executeDuckDuckGo(input, settings);
    case 'xai': return executeXai(input, settings.apiKeys.xai?.[0] || '', settings);
  }
}

const providerKeys = (provider: SearchProvider, settings: SearchSettings, context?: any): string[] => {
  return externalServiceKeys(settings.apiKeys[provider], envKeys(provider), provider === 'xai' ? 'grok' : provider === 'tavily' ? 'tavily' : undefined, context?.runtimeSettings);
};

const providerOrder = (settings: SearchSettings): SearchProvider[] => Array.from(new Set([
  settings.provider,
  ...settings.fallbackProviders,
]));

const actionCapability = (action: SearchAction): 'search' | 'read' | 'crawl' | 'map' | null => {
  if (action === 'search') return 'search';
  if (action === 'extract') return 'read';
  if (action === 'crawl') return 'crawl';
  if (action === 'map') return 'map';
  return null;
};

const actionService = (action: SearchAction): 'search' | 'read' | 'crawl' | 'map' | 'research' => {
  if (action === 'extract') return 'read';
  return action;
};

const annotateProviderResponse = (response: NormalizedSearchResult, provider: SearchProvider, action: SearchAction): NormalizedSearchResult => {
  const meta = SEARCH_PROVIDER_META[provider];
  const requiredCapability = actionCapability(action);
  return {
    ...response,
    providerCapabilities: meta.capabilities,
    deepResearchMode: meta.deepResearch,
    providerAction: action,
    providerActionMode: action === 'research'
      ? meta.deepResearch
      : requiredCapability && meta.capabilities.includes(requiredCapability) ? 'provider-native' : 'agent-direct-read',
  };
};

export async function executeSearchWithFailover(input: SearchExecutionInput, context?: any): Promise<NormalizedSearchResult> {
  return withExternalServiceContext(context, () => executeSearchRoute(input, getRuntimeSearchSettings(), context));
}

async function executeSearchRoute(input: SearchExecutionInput, settings: SearchSettings, context?: any): Promise<NormalizedSearchResult> {
  throwIfExternalServiceCancelled();
  if (!settings.enabled) throw new Error('External web search is disabled in External service settings.');
  const action = input.action || 'search';
  if (!['search', 'extract', 'crawl', 'map', 'research'].includes(action)) throw new Error('Unknown web-search action.');
  if (action === 'search' || action === 'research') {
    if (!input.query?.trim()) throw new Error(`${action} requires a non-empty query.`);
  } else if (!input.urls?.length) {
    throw new Error(`${action} requires at least one URL.`);
  }
  const order = providerOrder(settings);
  if (input.provider && !order.includes(input.provider)) throw new Error('The requested search provider is not enabled in the primary or fallback order.');
  const externalOrder = input.provider ? [input.provider, ...order.filter(provider => provider !== input.provider)] : order;
  const attemptedProviders: SearchProvider[] = [];
  const failedProviders: Array<{ provider: SearchProvider; error: string }> = [];
  const modelSearch: NonNullable<NormalizedSearchResult['modelSearch']> = { ...getNativeModelSearchCapability(context), enabled: settings.preferModelSearch, attempted: false };

  // Native search cannot supply image assets or full readable page content.
  if (settings.preferModelSearch && input.route !== 'external' && !input.includeImages && !input.includeRawContent && (action === 'search' || action === 'research')) {
    const capability = modelSearch;
    if (capability.status !== 'unsupported' && NATIVE_SEARCH_PROVIDERS.includes(capability.provider) && capability.model) {
      modelSearch.attempted = true;
      try {
        const nativeResult = await executeNativeModelSearch({ ...input, action }, context, capability);
        // A native response without citations is not sufficient evidence for a
        // live-search tool call. Let the configured External service provide a
        // source-backed answer instead.
        if (nativeResult.results.length > 0) {
          return {
            ...nativeResult,
            providerCapabilities: ['search'],
            deepResearchMode: 'native',
            providerAction: action,
            providerActionMode: 'model-native',
            attemptedProviders,
            failedProviders,
            modelSearch,
          };
        }
        console.info(`[Search] Native search returned no usable content for ${capability.provider}/${capability.model}; using External service fallback.`);
      } catch (error: any) {
        throwIfExternalServiceCancelled();
        modelSearch.error = error?.message || String(error);
        console.warn(`[Search] Native search unavailable for ${capability.provider}/${capability.model}; using External service fallback:`, error?.message || error);
      }
    }
  }

  for (const provider of externalOrder) {
    throwIfExternalServiceCancelled();
    const meta = SEARCH_PROVIDER_META[provider];
    const service = actionService(action);
    if (!(settings.enabledServices[provider] || []).includes(service)) {
      failedProviders.push({ provider, error: `${meta.label} ${service} service is disabled in External service settings.` });
      continue;
    }
    if (meta.requiresKey && providerKeys(provider, settings).length === 0) {
      failedProviders.push({ provider, error: 'No API key configured.' });
      continue;
    }
    if (meta.requiresEndpoint && !providerBaseURL(provider, settings)) {
      failedProviders.push({ provider, error: `${meta.label} needs an endpoint URL.` });
      continue;
    }
    attemptedProviders.push(provider);
    const configuredKeys = providerKeys(provider, settings);
    const keys = configuredKeys.length ? configuredKeys : ['__external_service_no_key__'];
    const start = runtimeKeyCursor[provider] || 0;
    const orderedKeys = keys.map((_, offset) => keys[(start + offset) % keys.length]);
    try {
      const response = await withApiKeyRounds(
        orderedKeys,
        context?.runtimeSettings,
        async (roundKey, attempt) => {
          const keyIndex = (start + attempt) % keys.length;
          const key = roundKey === '__external_service_no_key__' ? '' : roundKey;
          const scopedSettings: SearchSettings = {
            ...settings,
            apiKeys: { ...settings.apiKeys, [provider]: key ? [key] : [] },
          };
          const response = await executeSearchProvider({ ...input, action }, provider, scopedSettings);
          if (response.results.length === 0 && !(input.includeImages && response.images?.length)) {
            throw new Error('Provider returned no source-backed results.');
          }
          if (input.includeImages && !response.images?.length && !response.results.some(item => item.images?.length)) {
            throw new Error('Provider returned no requested image assets.');
          }
          if (action === 'search' && input.includeRawContent && response.results.some(item => !item.rawContent)) {
            if (!(settings.enabledServices[provider] || []).includes('read')) throw new Error('Requested page content requires the read service to be enabled.');
            const missing = response.results.filter(item => !item.rawContent).slice(0, 20);
            const pages = await executeGenericWebAction({ action: 'extract', urls: missing.map(item => item.url) }, provider, scopedSettings);
            const byURL = new Map(pages.results.map(item => [item.url, item.rawContent]));
            response.results.forEach(item => { item.rawContent ||= byURL.get(item.url); });
            response.failedResults = pages.failedResults;
            if (!response.results.some(item => item.rawContent)) throw new Error('No requested page content could be retrieved.');
          }
          runtimeKeyCursor[provider] = (keyIndex + 1) % keys.length;
          return { ...annotateProviderResponse(response, provider, action), attemptedProviders: [...attemptedProviders], failedProviders: [...failedProviders], modelSearch };
        },
        externalServiceSignal(),
        (_attempt, _totalAttempts, error) => {
          failedProviders.push({ provider, error: error instanceof Error ? error.message : String(error) });
        },
      );
      return response;
    } catch (error: any) {
      throwIfExternalServiceCancelled();
      failedProviders.push({ provider, error: error?.message || String(error) });
    }
  }

  const details = [
    ...(modelSearch.error ? [`Model search (${modelSearch.provider}/${modelSearch.model}): ${modelSearch.error}`] : []),
    ...failedProviders.map(item => `${SEARCH_PROVIDER_META[item.provider].label}: ${item.error}`),
  ].join(' | ');
  throw Object.assign(new Error(`No configured search route completed the request${details ? ` (${details})` : ''}`), { attemptedProviders, failedProviders, modelSearch });
}

export async function testSearchProvider(provider: SearchProvider, key = '', baseURL = ''): Promise<{ provider: SearchProvider; result: NormalizedSearchResult }> {
  const current = getRuntimeSearchSettings();
  const next: SearchSettings = {
    ...current,
    enabled: true,
    preferModelSearch: false,
    provider,
    fallbackProviders: [],
    apiKeys: { ...current.apiKeys, [provider]: key ? [key] : current.apiKeys[provider] || [] },
    baseURLs: { ...current.baseURLs, ...(baseURL ? { [provider]: baseURL } : {}) },
    enabledServices: { ...current.enabledServices, [provider]: ['search', 'read', 'crawl', 'map', 'research'] },
  };
  const result = await withExternalServiceContext(undefined, () => executeSearchRoute(
    { action: 'search', route: 'external', query: 'EterX Agent connectivity test', numResults: 1, includeAnswer: false }, next,
  ));
  return { provider, result };
}
