export const VIDEO_PROVIDER_IDS = [
  'google',
  'openai',
  'runway',
  'luma',
  'minimax',
  'volcengine',
  'fal',
  'replicate',
  'xai',
] as const;

export type VideoProvider = typeof VIDEO_PROVIDER_IDS[number];

export type VideoModelOption = {
  id: string;
  label: string;
  description: string;
};

export type VideoProviderMeta = {
  label: string;
  description: string;
  requiresKey: boolean;
  supportsImageInput: boolean;
  supportsAudioOutput: boolean;
  supportsTextToVideo: boolean;
  authLabel: string;
  keyPlaceholder: string;
  models: VideoModelOption[];
  defaultModel: string;
  defaultBaseURL: string;
  available: boolean;
};

export type VideoProviderKeyMap = Partial<Record<VideoProvider, string[]>>;
export type VideoProviderModelMap = Partial<Record<VideoProvider, string>>;

export type VideoSettings = {
  enabled: boolean;
  provider: VideoProvider;
  fallbackProviders: VideoProvider[];
  modelByProvider: VideoProviderModelMap;
  apiKeys: VideoProviderKeyMap;
};

export const VIDEO_PROVIDER_META: Record<VideoProvider, VideoProviderMeta> = {
  google: {
    label: 'Google Veo',
    description: 'Gemini API video generation with Veo 3.1, polling, and native audio where supported.',
    requiresKey: true,
    supportsImageInput: true,
    supportsAudioOutput: true,
    supportsTextToVideo: true,
    authLabel: 'Google AI key',
    keyPlaceholder: 'Paste Gemini API key',
    models: [
      { id: 'veo-3.1-generate-preview', label: 'Veo 3.1', description: 'Highest quality Veo preview with audio and reference controls.' },
      { id: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast', description: 'Faster Veo generation for iteration.' },
      { id: 'veo-3.1-lite-generate-preview', label: 'Veo 3.1 Lite', description: 'Lower-cost Veo preview route.' },
    ],
    defaultModel: 'veo-3.1-fast-generate-preview',
    defaultBaseURL: 'https://generativelanguage.googleapis.com',
    available: true,
  },
  openai: {
    label: 'OpenAI Sora',
    description: 'OpenAI Videos API with Sora 2, optional image references, and downloadable MP4 output.',
    requiresKey: true,
    supportsImageInput: true,
    supportsAudioOutput: true,
    supportsTextToVideo: true,
    authLabel: 'OpenAI API key',
    keyPlaceholder: 'Paste OpenAI API key',
    models: [
      { id: 'sora-2', label: 'Sora 2', description: 'Current Sora video generation with synced audio.' },
      { id: 'sora-2-pro', label: 'Sora 2 Pro', description: 'Higher-cost Sora quality tier when enabled for the account.' },
    ],
    defaultModel: 'sora-2',
    defaultBaseURL: 'https://api.openai.com/v1',
    available: true,
  },
  runway: {
    label: 'Runway',
    description: 'Runway task API for text-to-video and image-to-video generation with task polling.',
    requiresKey: true,
    supportsImageInput: true,
    supportsAudioOutput: false,
    supportsTextToVideo: true,
    authLabel: 'Runway API secret',
    keyPlaceholder: 'Paste RUNWAYML_API_SECRET',
    models: [
      { id: 'gen4.5', label: 'Gen-4.5', description: 'Runway text-to-video and image-to-video flagship.' },
      { id: 'veo3.1', label: 'Veo 3.1 via Runway', description: 'Veo route exposed through Runway.' },
      { id: 'veo3.1_fast', label: 'Veo 3.1 Fast via Runway', description: 'Faster Veo route exposed through Runway.' },
      { id: 'seedance2', label: 'Seedance 2', description: 'Seedance model exposed through Runway.' },
      { id: 'seedance2_fast', label: 'Seedance 2 Fast', description: 'Faster Seedance route exposed through Runway.' },
      { id: 'seedance2_mini', label: 'Seedance 2 Mini', description: 'Compact Seedance route exposed through Runway.' },
      { id: 'gemini_omni_flash', label: 'Gemini Omni Flash via Runway', description: 'Omni Flash route exposed through Runway.' },
    ],
    defaultModel: 'gen4.5',
    defaultBaseURL: 'https://api.dev.runwayml.com/v1',
    available: true,
  },
  luma: {
    label: 'Luma Dream Machine',
    description: 'Luma Ray generation with asynchronous job polling and image keyframes.',
    requiresKey: true,
    supportsImageInput: true,
    supportsAudioOutput: false,
    supportsTextToVideo: true,
    authLabel: 'Luma API key',
    keyPlaceholder: 'Paste Luma API key',
    models: [
      { id: 'ray-2', label: 'Ray 2', description: 'High-quality Luma video generation.' },
      { id: 'ray-flash-2', label: 'Ray 2 Flash', description: 'Faster Luma video generation.' },
    ],
    defaultModel: 'ray-2',
    defaultBaseURL: 'https://api.lumalabs.ai/dream-machine/v1',
    available: true,
  },
  minimax: {
    label: 'MiniMax Hailuo',
    description: 'Direct MiniMax asynchronous video generation with Hailuo/H3 text and image modes.',
    requiresKey: true,
    supportsImageInput: true,
    supportsAudioOutput: false,
    supportsTextToVideo: true,
    authLabel: 'MiniMax API key',
    keyPlaceholder: 'Paste MINIMAX_API_KEY',
    models: [
      { id: 'MiniMax-H3', label: 'MiniMax H3', description: 'Current multimodal video model with text, image, video, and audio context.' },
      { id: 'MiniMax-Hailuo-2.3', label: 'Hailuo 2.3', description: 'Current MiniMax text-to-video model.' },
    ],
    defaultModel: 'MiniMax-H3',
    defaultBaseURL: 'https://api.minimax.io',
    available: true,
  },
  volcengine: {
    label: 'ByteDance Seedance',
    description: 'Direct Volcengine Ark task API for Seedance video models and image-to-video deployments.',
    requiresKey: true,
    supportsImageInput: true,
    supportsAudioOutput: false,
    supportsTextToVideo: true,
    authLabel: 'Volcengine Ark API key',
    keyPlaceholder: 'Paste Volcengine Ark API key',
    models: [
      { id: 'doubao-seedance-1-0-pro-250528', label: 'Seedance 1.0 Pro', description: 'Direct Ark Seedance Pro deployment model.' },
      { id: 'custom', label: 'Account deployment ID', description: 'Enter the exact Ark model ID or endpoint ID enabled for your account.' },
    ],
    defaultModel: 'doubao-seedance-1-0-pro-250528',
    defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    available: true,
  },
  fal: {
    label: 'FAL.ai',
    description: 'Queue-backed access to current hosted and open-weight video models, including Wan.',
    requiresKey: true,
    supportsImageInput: true,
    supportsAudioOutput: true,
    supportsTextToVideo: true,
    authLabel: 'FAL key',
    keyPlaceholder: 'Paste FAL_KEY',
    models: [
      { id: 'fal-ai/wan-25-preview/text-to-video', label: 'Wan 2.5', description: 'Open-model text-to-video route with queue status.' },
      { id: 'fal-ai/wan-25-preview/image-to-video', label: 'Wan 2.5 image-to-video', description: 'Open-model image animation route when enabled by FAL.' },
      { id: 'bytedance/seedance-2.0/text-to-video', label: 'Seedance 2.0', description: 'ByteDance cinematic video with native audio through FAL.' },
      { id: 'fal-ai/bytedance/seedance/v1/pro/text-to-video', label: 'Seedance 1.0 Pro', description: 'ByteDance Seedance Pro route through FAL.' },
      { id: 'fal-ai/kling-video/v3/standard/text-to-video', label: 'Kling 3 Standard', description: 'Kling 3 cinematic video with native audio through FAL.' },
      { id: 'fal-ai/kling-video/o3/standard/text-to-video', label: 'Kling O3 Standard', description: 'Kling O3 route with optional native audio through FAL.' },
    ],
    defaultModel: 'fal-ai/wan-25-preview/text-to-video',
    defaultBaseURL: 'https://queue.fal.run',
    available: true,
  },
  replicate: {
    label: 'Replicate',
    description: 'Generic Replicate prediction route for open-source and community video models.',
    requiresKey: true,
    supportsImageInput: true,
    supportsAudioOutput: false,
    supportsTextToVideo: true,
    authLabel: 'Replicate API token',
    keyPlaceholder: 'Paste REPLICATE_API_TOKEN',
    models: [
      { id: 'minimax/video-01', label: 'MiniMax Video-01', description: 'Verified Replicate model route; accepts prompt and image inputs.' },
      { id: 'bytedance/seedance-1-pro', label: 'Seedance 1 Pro', description: 'Official Replicate open model route.' },
      { id: 'bytedance/seedance-1-lite', label: 'Seedance 1 Lite', description: 'Faster official Replicate Seedance route.' },
      { id: 'kwaiyeij/kling-v2.1', label: 'Kling 2.1', description: 'Official Replicate Kling route.' },
      { id: 'google/veo-3', label: 'Veo 3 via Replicate', description: 'Official Replicate Veo route when enabled for the account.' },
      { id: 'custom', label: 'Any Replicate model', description: 'Enter any current public owner/model ID in the exact model field below.' },
    ],
    defaultModel: 'minimax/video-01',
    defaultBaseURL: 'https://api.replicate.com/v1',
    available: true,
  },
  xai: {
    label: 'xAI Grok Imagine Video',
    description: 'xAI asynchronous video generation with text or image input and downloadable output.',
    requiresKey: true,
    supportsImageInput: true,
    supportsAudioOutput: false,
    supportsTextToVideo: true,
    authLabel: 'xAI API key',
    keyPlaceholder: 'Paste XAI_API_KEY',
    models: [
      { id: 'grok-imagine-video', label: 'Grok Imagine Video', description: 'Current xAI video generation model.' },
      { id: 'grok-imagine-video-1.5', label: 'Grok Imagine Video 1.5', description: 'Use when the model is enabled for the account.' },
    ],
    defaultModel: 'grok-imagine-video',
    defaultBaseURL: 'https://api.x.ai/v1',
    available: true,
  },
};

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  enabled: true,
  provider: 'google',
  fallbackProviders: VIDEO_PROVIDER_IDS.filter(provider => provider !== 'google'),
  modelByProvider: Object.fromEntries(
    VIDEO_PROVIDER_IDS.map(provider => [provider, VIDEO_PROVIDER_META[provider].defaultModel]),
  ) as VideoProviderModelMap,
  apiKeys: {},
};

const isProvider = (value: unknown): value is VideoProvider =>
  typeof value === 'string' && (VIDEO_PROVIDER_IDS as readonly string[]).includes(value);

const normalizeKeys = (value: unknown): string[] => Array.from(new Set(
  (Array.isArray(value) ? value : [value])
    .flatMap(item => typeof item === 'string' ? item.split(/[\n,]/) : [])
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 3),
));

const normalizeModel = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const model = value.trim();
  return model && model.length <= 240 && !/[\r\n\t]/.test(model) ? model : fallback;
};

export const normalizeVideoSettings = (value: unknown): VideoSettings => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const provider = isProvider(source.provider) ? source.provider : DEFAULT_VIDEO_SETTINGS.provider;
  const fallbackProviders = Array.from(new Set(
    (Array.isArray(source.fallbackProviders) ? source.fallbackProviders : DEFAULT_VIDEO_SETTINGS.fallbackProviders)
      .filter(isProvider)
      .filter(candidate => candidate !== provider),
  )) as VideoProvider[];
  const rawModels = source.modelByProvider && typeof source.modelByProvider === 'object' && !Array.isArray(source.modelByProvider)
    ? source.modelByProvider as Record<string, unknown>
    : {};
  const modelByProvider = Object.fromEntries(VIDEO_PROVIDER_IDS.map(id => [
    id,
    normalizeModel(rawModels[id], VIDEO_PROVIDER_META[id].defaultModel),
  ])) as VideoProviderModelMap;
  const rawKeys = source.apiKeys && typeof source.apiKeys === 'object' && !Array.isArray(source.apiKeys)
    ? source.apiKeys as Record<string, unknown>
    : {};
  const apiKeys = Object.fromEntries(
    VIDEO_PROVIDER_IDS
      .map(id => [id, normalizeKeys(rawKeys[id])] as const)
      .filter(([, keys]) => keys.length > 0),
  ) as VideoProviderKeyMap;
  return { enabled: source.enabled !== false, provider, fallbackProviders, modelByProvider, apiKeys };
};
