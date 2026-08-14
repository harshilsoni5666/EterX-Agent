import { tavily } from '@tavily/core';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import {
  getRuntimeApiKey,
  getScopedRuntimeApiKeyValues,
  type RuntimeApiKeyProvider,
} from '../agent/runtime-api-keys';
import { withApiKeyRounds } from '../agent/api-retry';
import { getProviderBaseURL } from '../agent/provider-runtime';
import { safeAxiosRequest } from '../agent/tools/shared/url_safety';
import {
  DEFAULT_SEARCH_SETTINGS,
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
    firecrawl_selfhosted: [],
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
  preferModelSearch: process.env.ETERX_PREFER_MODEL_SEARCH !== '0',
  provider: process.env.ETERX_SEARCH_PROVIDER,
  xaiModel: process.env.ETERX_SEARCH_XAI_MODEL,
  fallbackProviders: String(process.env.ETERX_SEARCH_FALLBACK_PROVIDERS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  apiKeys: Object.fromEntries(SEARCH_PROVIDER_IDS.map(provider => [provider, envKeys(provider)])),
  baseURLs: Object.fromEntries(SEARCH_PROVIDER_IDS.map(provider => [provider, envBaseURL(provider)])),
});

const initialSettings = runtimeGlobal.__eterxSearchSettings || (runtimeGlobal.__eterxSearchSettings = readEnvironmentSettings());

export function getRuntimeSearchSettings(): SearchSettings {
  return normalizeSearchSettings(runtimeGlobal.__eterxSearchSettings || initialSettings);
}

export function getSearchRouteBrief(context?: any): string {
  const settings = getRuntimeSearchSettings();
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
    `Native model search: ${native.status === 'supported' ? `available via ${native.provider}/${native.model}` : native.status === 'unknown' ? 'unknown; use external route if native call is unavailable' : 'not available'}.`,
    `Fallback order: ${fallbacks}.`,
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
  return items.map((item: any) => {
    const metadata = item?.metadata || {};
    const highlights = Array.isArray(item?.highlights) ? item.highlights.filter((value: unknown) => typeof value === 'string').join('\n\n') : '';
    const excerpts = Array.isArray(item?.excerpts) ? item.excerpts.filter((value: unknown) => typeof value === 'string').join('\n\n') : '';
    return {
      title: asText(item?.title || item?.name || metadata?.title) || 'Untitled result',
      url: asText(item?.url || item?.sourceURL || item?.source_url || metadata?.url || metadata?.sourceURL || metadata?.source_url),
      content: asText(item?.content || item?.description || item?.snippet || item?.text || item?.summary || highlights || excerpts),
      rawContent: asText(item?.rawContent || item?.raw_content || item?.markdown || item?.text || highlights || excerpts),
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : undefined,
      favicon: asText(item?.favicon || metadata?.favicon),
      publishedDate: asText(item?.publishedDate || item?.published_date || item?.published || metadata?.publishedDate || metadata?.published_date),
      images: normalizeImages(item?.images || item?.image ? [item.image] : []),
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

/**
 * Native search is deliberately conservative. Known provider/model families
 * are attempted, while unknown or local models go straight to the configured
 * External service route. If a provider rejects the native tool, the caller
 * still falls through to the normal provider and key failover chain.
 */
export function getNativeModelSearchCapability(context?: any): NativeModelSearchCapability {
  const provider = String(context?.selectedModelProvider || '').trim().toLowerCase();
  const model = String(context?.selectedModelName || '').trim();
  if (!provider || !model) {
    return { provider, model, status: 'unknown', reason: 'The active model is not available to the search runtime.' };
  }
  if (provider === 'gemini' && /^gemini-(?:2|3|4)/i.test(model) && !/gemma|embedding|image|tts|robotics/i.test(model)) {
    return { provider, model, status: 'supported', reason: 'Gemini Google Search grounding is available for this model family.' };
  }
  if (provider === 'openai' && /^(?:gpt-5|gpt-4\.1|o[134])(?:[-.:]|$)/i.test(model)) {
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
  if (['gemini', 'openai', 'grok', 'anthropic', 'perplexity'].includes(provider)) {
    return { provider, model, status: 'unknown', reason: 'This model name is not in the native-search capability map.' };
  }
  return { provider, model, status: 'unsupported', reason: 'This provider does not advertise a native web-search tool.' };
}

const nativeModelKey = (provider: string, context?: any): string => {
  const scoped = context?.runtimeSettings && typeof context.runtimeSettings === 'object'
    ? getScopedRuntimeApiKeyValues(context.runtimeSettings, provider as RuntimeApiKeyProvider)
    : [];
  return scoped[0] || getRuntimeApiKey(provider as RuntimeApiKeyProvider) || '';
};

const responseURLCitations = (payload: any): Array<{ title: string; url: string; content?: string }> => {
  const citations: Array<{ title: string; url: string; content?: string }> = [];
  const seen = new Set<string>();
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const url = asText(value.url || value.uri || value.source_url);
    const type = asText(value.type).toLowerCase();
    if (/^https?:\/\//i.test(url) && (type.includes('citation') || type.includes('source') || value.title || value.snippet)) {
      if (!seen.has(url)) {
        seen.add(url);
        citations.push({ title: asText(value.title || value.name) || url, url, content: asText(value.snippet || value.text || value.description) || undefined });
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(payload);
  return citations;
};

const executeNativeGeminiSearch = async (input: SearchExecutionInput, context: any, capability: NativeModelSearchCapability, apiKey?: string): Promise<NormalizedSearchResult> => {
  const key = apiKey || nativeModelKey('gemini', context);
  if (!key) throw new Error('No Gemini API key is available for native model search.');
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const ai = new GoogleGenAI({ apiKey: key });
  const response: any = await withTimeout(ai.models.generateContent({
    model: capability.model,
    contents: input.query,
    config: { tools: [{ googleSearch: {} }] },
  }), 30_000);
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
  const payload = await requestJson(`${baseURL}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: capability.model,
      input: [{ role: 'user', content: input.query }],
      tools: [{ type: 'web_search' }],
    }),
  });
  const citations = responseURLCitations(payload);
  return {
    provider: 'model',
    source: 'model',
    nativeSearch: true,
    modelProvider: capability.provider,
    model: capability.model,
    ai_summary: asText(payload?.output_text) || asText(payload?.text) || null,
    results: normalizeItems(citations),
  };
};

const executeNativeAnthropicSearch = async (input: SearchExecutionInput, context: any, capability: NativeModelSearchCapability, apiKey?: string): Promise<NormalizedSearchResult> => {
  const key = apiKey || nativeModelKey('anthropic', context);
  if (!key) throw new Error('No Anthropic API key is available for native model search.');
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const client = new Anthropic({ apiKey: key, baseURL: getProviderBaseURL('anthropic'), maxRetries: 0 });
  const messages: any[] = [{ role: 'user', content: input.query }];
  let response: any;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await withTimeout(client.messages.create({
      model: capability.model,
      max_tokens: 1600,
      messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    } as any), 30_000);
    if (response?.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  const text = Array.isArray(response?.content)
    ? response.content.filter((block: any) => block?.type === 'text').map((block: any) => block.text || '').join('\n\n')
    : '';
  return {
    provider: 'model',
    source: 'model',
    nativeSearch: true,
    modelProvider: capability.provider,
    model: capability.model,
    ai_summary: asText(text) || null,
    results: normalizeItems(responseURLCitations(response?.content)),
  };
};

const executeNativePerplexitySearch = async (input: SearchExecutionInput, context: any, capability: NativeModelSearchCapability, apiKey?: string): Promise<NormalizedSearchResult> => {
  const key = apiKey || nativeModelKey('perplexity', context);
  if (!key) throw new Error('No Perplexity API key is available for native model search.');
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const client = new OpenAI({ apiKey: key, baseURL: getProviderBaseURL('perplexity'), maxRetries: 0 });
  const response: any = await withTimeout(client.chat.completions.create({
    model: capability.model,
    messages: [{ role: 'user', content: input.query }],
    max_tokens: 1600,
  }), 30_000);
  const citations = Array.isArray(response?.citations)
    ? response.citations.map((url: string) => ({ title: url, url }))
    : responseURLCitations(response);
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

async function executeNativeModelSearch(input: SearchExecutionInput, context: any, capability: NativeModelSearchCapability): Promise<NormalizedSearchResult> {
  const keyProvider = capability.provider === 'grok' ? 'grok' : capability.provider;
  const configuredKeys = context?.runtimeSettings && typeof context.runtimeSettings === 'object'
    ? getScopedRuntimeApiKeyValues(context.runtimeSettings, keyProvider as RuntimeApiKeyProvider)
    : [];
  const keys = configuredKeys.length > 0 ? configuredKeys : [nativeModelKey(keyProvider, context)];
  if (!keys[0]) throw new Error(`No ${capability.provider} API key is available for native model search.`);

  return withApiKeyRounds(keys, context?.runtimeSettings, apiKey => {
    switch (capability.provider) {
      case 'gemini': return executeNativeGeminiSearch(input, context, capability, apiKey);
      case 'openai':
      case 'grok': return executeNativeResponsesSearch(input, context, capability, apiKey);
      case 'anthropic': return executeNativeAnthropicSearch(input, context, capability, apiKey);
      case 'perplexity': return executeNativePerplexitySearch(input, context, capability, apiKey);
      default: throw new Error('Native model search is not available for this provider.');
    }
  });
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

const requestJson = async (url: string, init: RequestInit, timeout = 30_000): Promise<any> => {
  const response = await withTimeout(fetch(url, init), timeout);
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : payload?.error?.message || payload?.error || payload?.message;
    throw new Error(`${response.status} ${response.statusText}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
  }
  return payload;
};

const executeTavily = async (input: SearchExecutionInput, key: string, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if (!key) throw new Error('No Tavily API key configured.');
  const client = tavily({ apiKey: key, apiBaseURL: providerBaseURL('tavily', settings) || undefined } as any);
  const action = input.action || 'search';
  if (action === 'extract') {
    if (!input.urls?.length) throw new Error("Extract action requires the 'urls' array parameter.");
    const response: any = await client.extract(input.urls, { extractDepth: input.searchDepth || 'basic', includeImages: input.includeImages || false });
    return { provider: 'tavily', results: normalizeItems(response?.results), failed: response?.failedResults };
  }
  if (action === 'crawl') {
    if (!input.urls?.length) throw new Error("Crawl action requires the 'urls' array parameter.");
    const response: any = await client.crawl(input.urls[0], { extractDepth: input.searchDepth || 'basic', includeImages: input.includeImages || false, maxDepth: 2, limit: input.numResults || 10 });
    return { provider: 'tavily', results: normalizeItems(response?.results), ...response };
  }
  if (action === 'map') {
    if (!input.urls?.length) throw new Error("Map action requires the 'urls' array parameter.");
    const response: any = await client.map(input.urls[0], { limit: input.numResults || 20 });
    const mapped = Array.isArray(response?.results) ? response.results.map((url: string) => ({ title: url, url, content: '' })) : [];
    return { provider: 'tavily', results: normalizeItems(mapped), ...response };
  }
  if (action === 'research') {
    if (!input.query) throw new Error("Research action requires the 'query' parameter.");
    const task: any = await client.research(input.query);
    const requestId = task?.requestId;
    if (!requestId) throw new Error('Tavily did not return a research request id.');
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const response: any = await client.getResearch(requestId);
      if (response?.status !== 'processing' && response?.status !== 'pending') {
        return { provider: 'tavily', results: normalizeItems(response?.results || response?.sources), ai_summary: asText(response?.report || response?.answer) || null, ...response };
      }
    }
    throw new Error('Tavily research task timed out.');
  }
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const response: any = await client.search(input.query, {
    searchDepth: input.searchDepth || 'basic',
    topic: input.topic || 'general',
    includeAnswer: input.includeAnswer !== false,
    includeImages: input.includeImages || false,
    includeImageDescriptions: input.includeImages ? input.includeImageDescriptions !== false : false,
    includeRawContent: input.includeRawContent ? 'markdown' : false,
    maxResults: input.numResults || 5,
  });
  return result('tavily', response, response?.results, response?.answer);
};

const executeBrave = async (input: SearchExecutionInput, key: string, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if (!key) throw new Error('No Brave Search API key configured.');
  if ((input.action || 'search') !== 'search') return executeGenericWebAction(input, 'brave', settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const url = new URL(`${requireURL('brave', settings)}/web/search`);
  url.searchParams.set('q', input.query);
  url.searchParams.set('count', String(Math.min(20, Math.max(1, input.numResults || 5))));
  if (input.topic === 'news') url.searchParams.set('freshness', 'pw');
  const payload = await requestJson(url.toString(), { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  return result('brave', payload, payload?.web?.results, payload?.summarizer?.text);
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
      await new Promise(resolve => setTimeout(resolve, 1000));
      const status = await requestJson(`${apiURL}/crawl/${encodeURIComponent(crawlId)}`, { headers });
      const state = asText(status?.status).toLowerCase();
      if (state === 'failed' || state === 'cancelled') throw new Error(`${SEARCH_PROVIDER_META[provider].label} crawl ${state}.`);
      if (state === 'completed' || Array.isArray(status?.data)) return result(provider, status, status?.data, null);
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
      scrapeOptions: input.includeRawContent ? { formats: ['markdown'] } : undefined,
    }),
  });
  const items = payload?.data?.web || payload?.data || payload?.web || [];
  return result(provider, payload, items, null);
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
  url.searchParams.set('categories', input.topic === 'news' ? 'news' : 'general');
  const payload = await requestJson(url.toString(), { headers: { Accept: 'application/json' } });
  return result('searxng', payload, payload?.results, null);
};

const executeDuckDuckGo = async (input: SearchExecutionInput, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if ((input.action || 'search') !== 'search') return executeGenericWebAction(input, 'duckduckgo', settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const url = new URL(requireURL('duckduckgo', settings));
  url.searchParams.set('q', input.query);
  const response = await withTimeout(fetch(url.toString(), { headers: { Accept: 'text/html', 'User-Agent': 'EterX-Agent/1.0' } }));
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const html = await response.text();
  const items: NormalizedSearchItem[] = [];
  const pattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && items.length < (input.numResults || 5)) {
    const rawURL = decodeHtml(match[1]);
    let resultURL = rawURL;
    try {
      if (rawURL.includes('uddg=')) resultURL = decodeURIComponent(new URL(rawURL, 'https://duckduckgo.com').searchParams.get('uddg') || rawURL);
    } catch { }
    const title = stripHtml(match[2]);
    if (/^https?:\/\//i.test(resultURL)) items.push({ title, url: resultURL });
  }
  return result('duckduckgo', {}, items, null);
};

const executeXai = async (input: SearchExecutionInput, key: string, settings: SearchSettings): Promise<NormalizedSearchResult> => {
  if (!key) throw new Error('No xAI API key configured.');
  if ((input.action || 'search') !== 'search') return executeGenericWebAction(input, 'xai', settings);
  if (!input.query) throw new Error("Search action requires the 'query' parameter.");
  const payload = await requestJson(`${requireURL('xai', settings)}/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: settings.xaiModel, input: [{ role: 'user', content: input.query }], tools: [{ type: 'web_search' }] }),
  });
  const textParts: string[] = [];
  const output = Array.isArray(payload?.output) ? payload.output : [];
  output.forEach((item: any) => {
    if (typeof item?.content === 'string') textParts.push(item.content);
    if (Array.isArray(item?.content)) item.content.forEach((part: any) => { if (typeof part?.text === 'string') textParts.push(part.text); });
  });
  const citations = Array.isArray(payload?.citations) ? payload.citations : [];
  const items = citations.map((citation: any) => {
    const url = typeof citation === 'string' ? citation : citation?.url;
    return { title: typeof citation === 'string' ? citation : citation?.title || url, url, content: citation?.snippet || '' };
  });
  return result('xai', payload, items, textParts.join('\n\n') || payload?.output_text);
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
    const searches = await Promise.all(angles.map(query => executeSearchProvider({
      ...input,
      action: 'search',
      query,
      searchDepth: 'advanced',
      includeAnswer: true,
      includeRawContent: true,
      numResults: Math.max(3, Math.min(8, input.numResults || 5)),
    }, provider, settings)));
    const seen = new Set<string>();
    const results = searches.flatMap(search => search.results || []).filter(item => {
      const key = String(item.url || item.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const summaries = searches.map(search => asText(search.ai_summary)).filter(Boolean);
    return {
      provider,
      results,
      ai_summary: summaries.join('\n\n') || null,
      research: true,
      researchAngles: angles,
    };
  }
  if (!input.urls?.length) throw new Error(`${action} action requires the 'urls' array parameter.`);
  const readPublicPage = async (url: string, accept: string) => {
    const response = await safeAxiosRequest<string>({
      url,
      method: 'GET',
      responseType: 'text',
      timeout: 30_000,
      maxContentLength: 2 * 1024 * 1024,
      headers: { Accept: accept, 'User-Agent': 'EterX-Agent/1.0' },
    });
    return { raw: String(response.data || ''), contentType: String(response.headers['content-type'] || '') };
  };
  if (action === 'map') {
    const links = await Promise.all(input.urls.slice(0, 1).map(async url => {
      const { raw: html } = await readPublicPage(url, 'text/html');
      const found = Array.from(html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)).map(match => match[1]);
      return Array.from(new Set([url, ...found])).slice(0, input.numResults || 20).map(link => ({ title: link, url: link }));
    }));
    return { provider, results: normalizeItems(links.flat()), ai_summary: null };
  }
  if (action === 'crawl') {
    const extracted = await executeGenericWebAction({ ...input, action: 'extract' }, provider, settings);
    return { ...extracted, crawl: true };
  }
  const results = await Promise.all(input.urls.slice(0, 20).map(async url => {
    const { raw, contentType } = await readPublicPage(url, 'text/html, text/plain');
    const content = contentType.includes('html') ? stripHtml(raw) : raw.trim();
    return { title: url, url, content: content.slice(0, 12_000), rawContent: content.slice(0, 12_000) };
  }));
  return { provider, results: normalizeItems(results), ai_summary: null };
};

async function executeSearchProvider(input: SearchExecutionInput, provider: SearchProvider, settings: SearchSettings): Promise<NormalizedSearchResult> {
  switch (provider) {
    case 'tavily': return executeTavily(input, settings.apiKeys.tavily?.[0] || '', settings);
    case 'brave': return executeBrave(input, settings.apiKeys.brave?.[0] || '', settings);
    case 'exa': return executeExa(input, settings.apiKeys.exa?.[0] || '', settings);
    case 'firecrawl': return executeFirecrawl(input, settings.apiKeys.firecrawl?.[0] || '', settings);
    case 'firecrawl_selfhosted': return executeFirecrawl(input, '', settings, 'firecrawl_selfhosted');
    case 'parallel': return executeParallel(input, settings.apiKeys.parallel?.[0] || '', settings);
    case 'searxng': return executeSearxng(input, settings);
    case 'duckduckgo': return executeDuckDuckGo(input, settings);
    case 'xai': return executeXai(input, settings.apiKeys.xai?.[0] || '', settings);
  }
}

const providerKeys = (provider: SearchProvider, settings: SearchSettings): string[] => {
  const configured = settings.apiKeys[provider] || [];
  if (configured.length > 0) return configured;
  return envKeys(provider);
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
  const settings = getRuntimeSearchSettings();
  if (!settings.enabled) throw new Error('External web search is disabled in External service settings.');
  const action = input.action || 'search';
  const attemptedProviders: SearchProvider[] = [];
  const failedProviders: Array<{ provider: SearchProvider; error: string }> = [];

  if (settings.preferModelSearch && (action === 'search' || action === 'research')) {
    const capability = getNativeModelSearchCapability(context);
    if (capability.status === 'supported') {
      try {
        const nativeResult = await executeNativeModelSearch({ ...input, action: 'search' }, context, capability);
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
          };
        }
        console.info(`[Search] Native search returned no usable content for ${capability.provider}/${capability.model}; using External service fallback.`);
      } catch (error: any) {
        console.warn(`[Search] Native search unavailable for ${capability.provider}/${capability.model}; using External service fallback:`, error?.message || error);
      }
    }
  }

  for (const provider of providerOrder(settings)) {
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
    const keys = meta.requiresKey ? providerKeys(provider, settings) : ['__external_service_no_key__'];
    const start = runtimeKeyCursor[provider] || 0;
    try {
      const response = await withApiKeyRounds(
        keys,
        context?.runtimeSettings,
        async (roundKey, attempt) => {
          const keyIndex = (start + attempt) % keys.length;
          const key = meta.requiresKey ? roundKey : '';
          const scopedSettings: SearchSettings = {
            ...settings,
            apiKeys: { ...settings.apiKeys, [provider]: key ? [key] : [] },
          };
          const response = await executeSearchProvider({ ...input, action }, provider, scopedSettings);
          runtimeKeyCursor[provider] = (keyIndex + 1) % keys.length;
          if (response.results.length === 0 && !response.ai_summary) {
            throw new Error('Provider returned no usable results.');
          }
          return { ...annotateProviderResponse(response, provider, action), attemptedProviders, failedProviders };
        },
        undefined,
        (_attempt, _totalAttempts, error) => {
          failedProviders.push({ provider, error: error instanceof Error ? error.message : String(error) });
        },
      );
      return response;
    } catch (error: any) {
      failedProviders.push({ provider, error: error?.message || String(error) });
    }
  }

  const details = failedProviders.map(item => `${SEARCH_PROVIDER_META[item.provider].label}: ${item.error}`).join(' | ');
  throw new Error(`No configured external search provider completed the request${details ? ` (${details})` : ''}`);
}

export async function testSearchProvider(provider: SearchProvider, key = '', baseURL = ''): Promise<{ provider: SearchProvider; result: NormalizedSearchResult }> {
  const current = getRuntimeSearchSettings();
  const next: SearchSettings = {
    ...current,
    enabled: true,
    provider,
    fallbackProviders: [],
    apiKeys: { ...current.apiKeys, [provider]: key ? [key] : [] },
    baseURLs: { ...current.baseURLs, ...(baseURL ? { [provider]: baseURL } : {}) },
    enabledServices: { ...current.enabledServices, [provider]: ['search', 'read', 'crawl', 'map', 'research'] },
  };
  const previous = runtimeGlobal.__eterxSearchSettings;
  runtimeGlobal.__eterxSearchSettings = next;
  try {
    const result = await executeSearchWithFailover({ action: 'search', query: 'EterX Agent connectivity test', numResults: 1, includeAnswer: false });
    return { provider, result };
  } finally {
    runtimeGlobal.__eterxSearchSettings = previous || DEFAULT_SEARCH_SETTINGS;
  }
}
