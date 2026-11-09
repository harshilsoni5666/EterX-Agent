export const SEARCH_PROVIDER_IDS = [
  'tavily',
  'brave',
  'exa',
  'firecrawl',
  'firecrawl_selfhosted',
  'parallel',
  'searxng',
  'duckduckgo',
  'xai',
] as const;

export type SearchProvider = typeof SEARCH_PROVIDER_IDS[number];
export const SEARCH_SERVICE_IDS = ['search', 'read', 'crawl', 'map', 'research'] as const;
export type SearchService = typeof SEARCH_SERVICE_IDS[number];

export type SearchProviderKeyMap = Partial<Record<SearchProvider, string[]>>;
export type SearchProviderBaseURLMap = Partial<Record<SearchProvider, string>>;

export type SearchSettings = {
  enabled: boolean;
  preferModelSearch: boolean;
  provider: SearchProvider;
  xaiModel: string;
  fallbackProviders: SearchProvider[];
  apiKeys: SearchProviderKeyMap;
  baseURLs: SearchProviderBaseURLMap;
  enabledServices: Partial<Record<SearchProvider, SearchService[]>>;
};

export type SearchProviderMeta = {
  label: string;
  description: string;
  requiresKey: boolean;
  supportsExtraction: boolean;
  capabilities: Array<'search' | 'read' | 'crawl' | 'map'>;
  deepResearch: 'native' | 'orchestrated';
  credentialLabel?: string;
  credentialDescription?: string;
  requiresEndpoint?: boolean;
  defaultBaseURL?: string;
  baseURLPlaceholder?: string;
};

export const SEARCH_PROVIDER_META: Record<SearchProvider, SearchProviderMeta> = {
  tavily: {
    label: 'Tavily',
    description: 'Agent-focused search, extraction, crawling, mapping, and research.',
    requiresKey: true,
    supportsExtraction: true,
    capabilities: ['search', 'read', 'crawl', 'map'],
    deepResearch: 'native',
    defaultBaseURL: 'https://api.tavily.com',
  },
  brave: {
    label: 'Brave Search',
    description: 'Independent web index with fast, structured search results.',
    requiresKey: true,
    supportsExtraction: false,
    capabilities: ['search'],
    deepResearch: 'orchestrated',
    defaultBaseURL: 'https://api.search.brave.com/res/v1',
  },
  exa: {
    label: 'Exa',
    description: 'Semantic web search with optional text and highlight extraction.',
    requiresKey: true,
    supportsExtraction: true,
    capabilities: ['search', 'read'],
    deepResearch: 'orchestrated',
    defaultBaseURL: 'https://api.exa.ai',
  },
  firecrawl: {
    label: 'Firecrawl',
    description: 'Search with page scraping and markdown-ready source content.',
    requiresKey: true,
    supportsExtraction: true,
    capabilities: ['search', 'read', 'crawl', 'map'],
    deepResearch: 'orchestrated',
    defaultBaseURL: 'https://api.firecrawl.dev/v2',
  },
  firecrawl_selfhosted: {
    label: 'Firecrawl self-hosted',
    description: 'Your own Firecrawl instance for search, source reading, and crawling.',
    requiresKey: false,
    credentialLabel: 'Optional Firecrawl API key',
    credentialDescription: 'Leave empty for an instance without authentication, or add up to three keys if your instance requires Bearer authentication.',
    supportsExtraction: true,
    capabilities: ['search', 'read', 'crawl', 'map'],
    deepResearch: 'orchestrated',
    requiresEndpoint: true,
    baseURLPlaceholder: 'http://localhost:3002',
  },
  parallel: {
    label: 'Parallel',
    description: 'Natural-language search with ranked pages and LLM-ready excerpts.',
    requiresKey: true,
    supportsExtraction: true,
    capabilities: ['search', 'read'],
    deepResearch: 'orchestrated',
    defaultBaseURL: 'https://api.parallel.ai/v1',
  },
  searxng: {
    label: 'SearXNG',
    description: 'Self-hosted metasearch through your configured instance.',
    requiresKey: false,
    supportsExtraction: false,
    capabilities: ['search'],
    deepResearch: 'orchestrated',
    requiresEndpoint: true,
    baseURLPlaceholder: 'https://search.example.com',
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    description: 'Privacy-respecting HTML search with no credential required.',
    requiresKey: false,
    supportsExtraction: false,
    capabilities: ['search'],
    deepResearch: 'orchestrated',
    defaultBaseURL: 'https://html.duckduckgo.com/html',
  },
  xai: {
    label: 'xAI Web Search',
    description: 'Real-time web search through xAI’s Responses API.',
    requiresKey: true,
    supportsExtraction: false,
    capabilities: ['search'],
    deepResearch: 'orchestrated',
    defaultBaseURL: 'https://api.x.ai/v1',
  },
};

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  enabled: true,
  preferModelSearch: true,
  provider: 'tavily',
  xaiModel: 'grok-4.6',
  fallbackProviders: SEARCH_PROVIDER_IDS.filter(provider => provider !== 'tavily'),
  apiKeys: {},
  baseURLs: {},
  enabledServices: Object.fromEntries(
    SEARCH_PROVIDER_IDS.map(provider => [provider, [...SEARCH_SERVICE_IDS]]),
  ) as Partial<Record<SearchProvider, SearchService[]>>,
};

const isProvider = (value: unknown): value is SearchProvider =>
  typeof value === 'string' && (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);

const normalizeKeys = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : [value];
  return Array.from(new Set(values
    .flatMap(item => typeof item === 'string' ? item.split(/[\n,]/) : [])
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 3)));
};

const normalizeBaseURL = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const clean = value.trim().replace(/\/+$/, '');
  if (!clean || clean.length > 2048 || /[\r\n\t]/.test(clean)) return '';
  try {
    const url = new URL(clean);
    return url.protocol === 'http:' || url.protocol === 'https:' ? clean : '';
  } catch {
    return '';
  }
};

export const normalizeSearchSettings = (
  value: unknown,
  legacyTavilyKeys: unknown = undefined,
): SearchSettings => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const enabled = source.enabled !== false;
  const preferModelSearch = source.preferModelSearch !== false;
  const provider = isProvider(source.provider) ? source.provider : DEFAULT_SEARCH_SETTINGS.provider;
  const xaiModel = typeof source.xaiModel === 'string' && source.xaiModel.trim()
    ? source.xaiModel.trim().slice(0, 160)
    : DEFAULT_SEARCH_SETTINGS.xaiModel;
  const rawFallbacks = Array.isArray(source.fallbackProviders)
    ? source.fallbackProviders
    : SEARCH_PROVIDER_IDS.filter(id => id !== provider);
  const fallbackProviders = Array.from(new Set(rawFallbacks
    .filter(isProvider)
    .filter(candidate => candidate !== provider))) as SearchProvider[];

  const rawKeys = source.apiKeys && typeof source.apiKeys === 'object' && !Array.isArray(source.apiKeys)
    ? source.apiKeys as Record<string, unknown>
    : {};
  const apiKeys = Object.fromEntries(
    SEARCH_PROVIDER_IDS
      .map(id => [id, normalizeKeys(Object.prototype.hasOwnProperty.call(rawKeys, id) ? rawKeys[id] : id === 'tavily' ? legacyTavilyKeys : undefined)] as const)
      .filter(([, keys]) => keys.length > 0),
  ) as SearchProviderKeyMap;

  const rawBaseURLs = source.baseURLs && typeof source.baseURLs === 'object' && !Array.isArray(source.baseURLs)
    ? source.baseURLs as Record<string, unknown>
    : {};
  const baseURLs = Object.fromEntries(
    SEARCH_PROVIDER_IDS
      .map(id => [id, normalizeBaseURL(rawBaseURLs[id])] as const)
      .filter(([, baseURL]) => Boolean(baseURL)),
  ) as SearchProviderBaseURLMap;

  const rawEnabledServices = source.enabledServices && typeof source.enabledServices === 'object' && !Array.isArray(source.enabledServices)
    ? source.enabledServices as Record<string, unknown>
    : {};
  const enabledServices = Object.fromEntries(
    SEARCH_PROVIDER_IDS.map(provider => {
      const configured = rawEnabledServices[provider];
      const services = Array.isArray(configured)
        ? configured.filter((service): service is SearchService => (SEARCH_SERVICE_IDS as readonly string[]).includes(String(service)))
        : DEFAULT_SEARCH_SETTINGS.enabledServices[provider] || [...SEARCH_SERVICE_IDS];
      return [provider, Array.from(new Set(services))] as const;
    }),
  ) as Partial<Record<SearchProvider, SearchService[]>>;

  return { enabled, preferModelSearch, provider, xaiModel, fallbackProviders, apiKeys, baseURLs, enabledServices };
};
