export const IMAGE_PROVIDER_IDS = [
  'deepinfra',
  'fal',
  'krea',
  'openai',
  'openrouter',
  'xai',
  'freepik',
] as const;

export type ImageProvider = typeof IMAGE_PROVIDER_IDS[number];

export type ImageModelOption = {
  id: string;
  label: string;
  description: string;
};

export type ImageProviderMeta = {
  label: string;
  description: string;
  requiresKey: boolean;
  supportsEditing: boolean;
  supportsAspectRatio: boolean;
  authLabel: string;
  keyPlaceholder: string;
  models: ImageModelOption[];
  defaultModel: string;
  defaultBaseURL: string;
  available: boolean;
  unavailableReason?: string;
};

export type ImageProviderKeyMap = Partial<Record<ImageProvider, string[]>>;
export type ImageProviderModelMap = Partial<Record<ImageProvider, string>>;
export type ImageProviderBaseURLMap = Partial<Record<ImageProvider, string>>;

export type ImageSettings = {
  enabled: boolean;
  provider: ImageProvider;
  fallbackProviders: ImageProvider[];
  modelByProvider: ImageProviderModelMap;
  apiKeys: ImageProviderKeyMap;
  baseURLs: ImageProviderBaseURLMap;
};

export const IMAGE_PROVIDER_META: Record<ImageProvider, ImageProviderMeta> = {
  deepinfra: {
    label: 'DeepInfra',
    description: 'Direct text-to-image inference across DeepInfra’s live model catalog.',
    requiresKey: true,
    supportsEditing: false,
    supportsAspectRatio: false,
    authLabel: 'DeepInfra token',
    keyPlaceholder: 'Paste DeepInfra API token',
    models: [
      { id: 'stabilityai/stable-diffusion-2-1', label: 'Stable Diffusion 2.1', description: 'Documented DeepInfra text-to-image route.' },
      { id: 'black-forest-labs/FLUX-1-schnell', label: 'FLUX.1 Schnell', description: 'Fast FLUX model when enabled in your DeepInfra account.' },
      { id: 'black-forest-labs/FLUX-1.1-pro', label: 'FLUX 1.1 Pro', description: 'Higher-quality FLUX model when enabled in your account.' },
      { id: 'Qwen/Qwen-Image', label: 'Qwen Image', description: 'Qwen image model when available in the live catalog.' },
    ],
    defaultModel: 'stabilityai/stable-diffusion-2-1',
    defaultBaseURL: 'https://api.deepinfra.com',
    available: true,
  },
  fal: {
    label: 'FAL.ai',
    description: 'Queue-backed image generation with real-time status polling and downloadable results.',
    requiresKey: true,
    supportsEditing: false,
    supportsAspectRatio: true,
    authLabel: 'FAL key',
    keyPlaceholder: 'Paste FAL_KEY',
    models: [
      { id: 'fal-ai/flux/schnell', label: 'FLUX Schnell', description: 'Fast queue-backed FLUX generation.' },
      { id: 'fal-ai/flux/dev', label: 'FLUX Dev', description: 'Higher-quality FLUX generation.' },
      { id: 'fal-ai/nano-banana-2', label: 'Nano Banana 2', description: 'Multimodal image generation endpoint.' },
    ],
    defaultModel: 'fal-ai/flux/schnell',
    defaultBaseURL: 'https://queue.fal.run',
    available: true,
  },
  krea: {
    label: 'Krea',
    description: 'Krea 2 generation with creativity controls and job-result polling.',
    requiresKey: true,
    supportsEditing: false,
    supportsAspectRatio: true,
    authLabel: 'Krea API token',
    keyPlaceholder: 'Paste Krea API token',
    models: [
      { id: 'krea/krea-2/medium', label: 'Krea 2 Medium', description: 'Balanced quality and price.' },
      { id: 'krea/krea-2/large', label: 'Krea 2 Large', description: 'Highest Krea 2 quality tier.' },
    ],
    defaultModel: 'krea/krea-2/medium',
    defaultBaseURL: 'https://api.krea.ai',
    available: true,
  },
  openai: {
    label: 'OpenAI',
    description: 'Direct OpenAI Images API with GPT Image quality tiers and local raster downloads.',
    requiresKey: true,
    supportsEditing: false,
    supportsAspectRatio: false,
    authLabel: 'OpenAI API key',
    keyPlaceholder: 'Paste OpenAI API key',
    models: [
      { id: 'gpt-image-2', label: 'GPT Image 2', description: 'Current OpenAI image generation model.' },
      { id: 'gpt-image-1.5', label: 'GPT Image 1.5', description: 'Previous OpenAI image generation model.' },
      { id: 'gpt-image-1', label: 'GPT Image 1', description: 'Earlier OpenAI image generation model.' },
    ],
    defaultModel: 'gpt-image-2',
    defaultBaseURL: 'https://api.openai.com/v1',
    available: true,
  },
  openrouter: {
    label: 'OpenRouter image',
    description: 'Unified image API with live model discovery and provider routing.',
    requiresKey: true,
    supportsEditing: false,
    supportsAspectRatio: true,
    authLabel: 'OpenRouter API key',
    keyPlaceholder: 'Paste OpenRouter API key',
    models: [
      { id: 'openai/gpt-image-1', label: 'OpenAI GPT Image 1', description: 'OpenAI image model through OpenRouter.' },
      { id: 'google/gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', description: 'Google image model through OpenRouter.' },
      { id: 'bytedance-seed/seedream-4.5', label: 'Seedream 4.5', description: 'High-resolution image generation.' },
      { id: 'x-ai/grok-imagine-image', label: 'Grok Imagine Image', description: 'xAI image model through OpenRouter.' },
    ],
    defaultModel: 'openai/gpt-image-1',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    available: true,
  },
  xai: {
    label: 'xAI Grok Imagine',
    description: 'Direct Grok Imagine generation with temporary URL or base64 output.',
    requiresKey: true,
    supportsEditing: false,
    supportsAspectRatio: true,
    authLabel: 'xAI API key',
    keyPlaceholder: 'Paste XAI_API_KEY',
    models: [
      { id: 'grok-imagine-image-quality', label: 'Grok Imagine Image Quality', description: 'Quality-focused Grok Imagine route.' },
      { id: 'grok-imagine-image', label: 'Grok Imagine Image', description: 'Current Grok Imagine image model.' },
    ],
    defaultModel: 'grok-imagine-image-quality',
    defaultBaseURL: 'https://api.x.ai/v1',
    available: true,
  },
  freepik: {
    label: 'Freepik',
    description: 'Existing EterX raster route using Freepik’s asynchronous FLUX endpoint.',
    requiresKey: true,
    supportsEditing: false,
    supportsAspectRatio: true,
    authLabel: 'Freepik API key',
    keyPlaceholder: 'Paste Freepik API key',
    models: [
      { id: 'flux-dev', label: 'FLUX Dev', description: 'Freepik asynchronous text-to-image endpoint.' },
    ],
    defaultModel: 'flux-dev',
    defaultBaseURL: 'https://api.freepik.com',
    available: true,
  },
};

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  enabled: true,
  provider: 'freepik',
  fallbackProviders: IMAGE_PROVIDER_IDS.filter(provider => provider !== 'freepik'),
  modelByProvider: Object.fromEntries(
    IMAGE_PROVIDER_IDS.map(provider => [provider, IMAGE_PROVIDER_META[provider].defaultModel]),
  ) as ImageProviderModelMap,
  apiKeys: {},
  baseURLs: {},
};

const isProvider = (value: unknown): value is ImageProvider =>
  typeof value === 'string' && (IMAGE_PROVIDER_IDS as readonly string[]).includes(value);

const normalizeKeys = (value: unknown): string[] => Array.from(new Set(
  (Array.isArray(value) ? value : [value])
    .flatMap(item => typeof item === 'string' ? item.split(/[\n,]/) : [])
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 3),
));

const normalizeURL = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const clean = value.trim().replace(/\/+$/, '');
  if (!clean || clean.length > 2048 || /[\r\n\t]/.test(clean)) return '';
  try {
    const parsed = new URL(clean);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? clean : '';
  } catch {
    return '';
  }
};

export const normalizeImageSettings = (value: unknown): ImageSettings => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const provider = isProvider(source.provider) ? source.provider : DEFAULT_IMAGE_SETTINGS.provider;
  const fallbackProviders = Array.from(new Set(
    (Array.isArray(source.fallbackProviders) ? source.fallbackProviders : DEFAULT_IMAGE_SETTINGS.fallbackProviders)
      .filter(isProvider)
      .filter(candidate => candidate !== provider),
  )) as ImageProvider[];
  const rawModels = source.modelByProvider && typeof source.modelByProvider === 'object' && !Array.isArray(source.modelByProvider)
    ? source.modelByProvider as Record<string, unknown>
    : {};
  const modelByProvider = Object.fromEntries(IMAGE_PROVIDER_IDS.map(id => {
    const configured = typeof rawModels[id] === 'string' ? rawModels[id].trim() : '';
    return [id, configured || IMAGE_PROVIDER_META[id].defaultModel];
  })) as ImageProviderModelMap;
  const rawKeys = source.apiKeys && typeof source.apiKeys === 'object' && !Array.isArray(source.apiKeys)
    ? source.apiKeys as Record<string, unknown>
    : {};
  const apiKeys = Object.fromEntries(
    IMAGE_PROVIDER_IDS
      .map(id => [id, normalizeKeys(rawKeys[id])] as const)
      .filter(([, keys]) => keys.length > 0),
  ) as ImageProviderKeyMap;
  const rawBaseURLs = source.baseURLs && typeof source.baseURLs === 'object' && !Array.isArray(source.baseURLs)
    ? source.baseURLs as Record<string, unknown>
    : {};
  const baseURLs = Object.fromEntries(
    IMAGE_PROVIDER_IDS
      .map(id => [id, normalizeURL(rawBaseURLs[id])] as const)
      .filter(([, baseURL]) => Boolean(baseURL)),
  ) as ImageProviderBaseURLMap;
  return {
    enabled: source.enabled !== false,
    provider,
    fallbackProviders,
    modelByProvider,
    apiKeys,
    baseURLs,
  };
};
