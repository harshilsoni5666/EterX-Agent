export type LiveModelOption = {
  value: string;
  label: string;
  tag?: string;
  description?: string;
};

export type LiveProviderTransport =
  | 'gemini-native'
  | 'openai-webrtc'
  | 'xai-native'
  | 'deepgram-native'
  | 'elevenlabs-native';

export type LiveProviderOption = {
  value: string;
  /** Provider id used by the selected native live transport. */
  provider: string;
  /** Key slot used in Settings > Live Convo. */
  keyProvider: string;
  label: string;
  description: string;
  transport: LiveProviderTransport;
  /** Whether the server must mint a short-lived browser credential. */
  browserAuth: 'api-key' | 'ephemeral' | 'signed-url';
  /** True only for transports that can send visual frames to the model. */
  supportsVision: boolean;
  /** A provider-specific setup value, such as an ElevenLabs agent id. */
  requiresAgentId?: boolean;
};

export const LIVE_PROVIDER_OPTIONS: LiveProviderOption[] = [
  {
    value: 'agent-live-convo',
    provider: 'gemini',
    keyProvider: 'gemini',
    label: 'Google Gemini Live',
    description: 'Native bidirectional audio, video, transcription, and tool-calling session',
    transport: 'gemini-native',
    browserAuth: 'api-key',
    supportsVision: true,
  },
  {
    value: 'openai-realtime',
    provider: 'openai',
    keyProvider: 'openai',
    label: 'OpenAI Realtime',
    description: 'Native browser voice session over WebRTC with server-minted ephemeral credentials',
    transport: 'openai-webrtc',
    browserAuth: 'ephemeral',
    supportsVision: false,
  },
  {
    value: 'grok-realtime',
    provider: 'grok',
    keyProvider: 'grok',
    label: 'xAI Grok Voice',
    description: 'Native bidirectional Grok speech-to-speech WebSocket session',
    transport: 'xai-native',
    browserAuth: 'ephemeral',
    supportsVision: false,
  },
  {
    value: 'deepgram-voice-agent',
    provider: 'deepgram',
    keyProvider: 'deepgram',
    label: 'Deepgram Voice Agent',
    description: 'Deepgram Voice Agent WebSocket with streaming STT, reasoning, and TTS',
    transport: 'deepgram-native',
    browserAuth: 'ephemeral',
    supportsVision: false,
  },
  {
    value: 'elevenlabs-convai',
    provider: 'elevenlabs',
    keyProvider: 'elevenlabs',
    label: 'ElevenLabs Conversational Agent',
    description: 'ElevenLabs Conversational AI agent with signed WebSocket authentication',
    transport: 'elevenlabs-native',
    browserAuth: 'signed-url',
    supportsVision: false,
    requiresAgentId: true,
  },
];

export const LIVE_PROVIDER_MODELS: Record<string, LiveModelOption[]> = {
  'agent-live-convo': [
    { value: 'auto', label: 'Auto (Latest Gemini Live Model)', tag: 'AUTO', description: 'Uses the newest compatible Live model returned by Gemini' },
    { value: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live Preview', tag: 'LIVE', description: 'Native realtime audio and multimodal model' },
  ],
  'openai-realtime': [
    { value: 'auto', label: 'Auto (GPT Realtime 2.1)', tag: 'AUTO', description: 'Uses the current OpenAI realtime model' },
    { value: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', tag: 'REALTIME', description: 'OpenAI reasoning realtime audio model over WebRTC' },
    { value: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 Mini', tag: 'REALTIME', description: 'OpenAI lower-cost reasoning realtime audio model over WebRTC' },
    { value: 'gpt-realtime-2', label: 'GPT Realtime 2', tag: 'REALTIME', description: 'OpenAI reasoning realtime audio model over WebRTC' },
    { value: 'gpt-realtime-translate', label: 'GPT Realtime Translate', tag: 'TRANSLATE', description: 'OpenAI realtime speech-to-speech translation model over WebRTC' },
    { value: 'gpt-realtime', label: 'GPT Realtime', tag: 'REALTIME', description: 'OpenAI realtime audio model over WebRTC' },
    { value: 'gpt-realtime-mini', label: 'GPT Realtime Mini', tag: 'REALTIME', description: 'OpenAI cost-efficient realtime audio model over WebRTC' },
    { value: 'gpt-realtime-1.5', label: 'GPT Realtime 1.5', tag: 'REALTIME', description: 'OpenAI realtime audio model over WebRTC' },
  ],
  'grok-realtime': [
    { value: 'auto', label: 'Auto (Grok Voice Latest)', tag: 'AUTO', description: 'Uses xAI’s recommended realtime voice model' },
    { value: 'grok-voice-latest', label: 'Grok Voice Latest', tag: 'VOICE', description: 'xAI’s best direct WebSocket voice experience' },
    { value: 'grok-voice-think-fast-2.0', label: 'Grok Voice Think Fast 2.0', tag: 'VOICE', description: 'Lower-latency xAI voice model' },
    { value: 'grok-voice-think-fast-1.0', label: 'Grok Voice Think Fast 1.0', tag: 'VOICE', description: 'Fast xAI voice model' },
  ],
  'deepgram-voice-agent': [
    { value: 'auto', label: 'Auto (Flux General English)', tag: 'AUTO', description: 'Uses Deepgram Flux for conversational listening' },
    { value: 'flux-general-en', label: 'Flux General English', tag: 'LISTEN', description: 'Deepgram Flux conversational turn detection and transcription' },
    { value: 'flux-general-multi', label: 'Flux General Multilingual', tag: 'LISTEN', description: 'Deepgram Flux multilingual conversational turn detection and transcription' },
    { value: 'nova-3', label: 'Nova-3', tag: 'LISTEN', description: 'Deepgram Nova-3 speech recognition' },
    { value: 'nova-2', label: 'Nova-2', tag: 'LISTEN', description: 'Deepgram Nova-2 speech recognition' },
  ],
  'elevenlabs-convai': [
    { value: 'auto', label: 'Auto (Agent Configuration)', tag: 'AUTO', description: 'Uses the selected ElevenLabs agent configuration' },
    { value: 'agent-default', label: 'Agent Default', tag: 'AGENT', description: 'The LLM, voice, and turn settings configured on the agent' },
  ],
};

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export const DEFAULT_OPENAI_LIVE_MODEL = 'gpt-realtime-2.1';
export const DEFAULT_XAI_LIVE_MODEL = 'grok-voice-latest';
export const DEFAULT_DEEPGRAM_LISTEN_MODEL = 'flux-general-en';
export const DEFAULT_DEEPGRAM_SPEAK_MODEL = 'aura-2-thalia-en';
export const DEFAULT_DEEPGRAM_THINK_MODEL = 'gpt-5-mini';
export const DEEPGRAM_MAX_RECONNECT_ATTEMPTS = 3;

export const isDeepgramLiveModel = (value: unknown): value is string =>
  /^(?:flux-general-(?:en|multi)|nova-(?:3|2)(?:-[a-z0-9-]+)?)$/.test(String(value ?? '').trim());

export const isDeepgramLiveVoice = (value: unknown): value is string =>
  /^(?:aura(?:-2)?|flux)-[a-z0-9]+-[a-z]{2,3}$/.test(String(value ?? '').trim());

export const getDeepgramReconnectDelay = (attempt: number): number =>
  Math.min(8000, 500 * 2 ** Math.max(0, Math.floor(attempt) - 1));

export const readDeepgramGrantCredential = (payload: unknown): { token: string; expiresIn: number } => {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const token = String(record.access_token ?? '').trim();
  const expiresIn = Number(record.expires_in);
  if (!token) throw new Error('Deepgram grant response did not include access_token.');
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 3600) {
    throw new Error('Deepgram grant response included an invalid expires_in.');
  }
  return { token, expiresIn };
};

export const getDefaultLiveVoice = (providerValue: unknown): string => {
  const provider = getLiveProvider(providerValue).provider;
  if (provider === 'gemini') return 'Kore';
  if (provider === 'openai') return 'marin';
  if (provider === 'grok') return 'eve';
  if (provider === 'deepgram') return 'aura-2-thalia-en';
  return 'agent-default';
};

export type LiveRealtimeCredential = {
  token: string;
  expiresAt?: number;
};

export const readLiveRealtimeCredential = (payload: any): LiveRealtimeCredential => {
  // OpenAI returns { client_secret: { value, expires_at } }; xAI returns the
  // same short-lived credential as a top-level value. Keep this normalization
  // at the provider boundary so browser transports consume one stable shape.
  const clientSecret = payload?.client_secret || payload?.clientSecret || payload || {};
  return {
    token: String(clientSecret?.value || clientSecret?.token || '').trim(),
    expiresAt: Number(clientSecret?.expires_at || clientSecret?.expiresAt || payload?.expires_at) || undefined,
  };
};

export const getLiveProvider = (value: unknown): LiveProviderOption => {
  const normalized = String(value || '').trim().toLowerCase();
  const aliases: Record<string, string> = {
    gemini: 'agent-live-convo',
    'gemini-live': 'agent-live-convo',
    'agent-live': 'agent-live-convo',
    openai: 'openai-realtime',
    'openai-live': 'openai-realtime',
    grok: 'grok-realtime',
    xai: 'grok-realtime',
    deepgram: 'deepgram-voice-agent',
    elevenlabs: 'elevenlabs-convai',
  };
  const resolved = aliases[normalized] || normalized;
  return LIVE_PROVIDER_OPTIONS.find(option => option.value === resolved) || LIVE_PROVIDER_OPTIONS[0];
};

export const normalizeLiveProvider = (value: unknown): LiveProviderOption => getLiveProvider(value);

export const getLiveModelOptions = (providerValue: unknown): LiveModelOption[] => {
  const provider = getLiveProvider(providerValue);
  return [...(LIVE_PROVIDER_MODELS[provider.value] || LIVE_PROVIDER_MODELS['agent-live-convo'])];
};

export const isLiveModelForProvider = (providerValue: unknown, modelValue: unknown): boolean => {
  const model = String(modelValue || '').trim();
  if (model === 'auto') return true;
  const provider = getLiveProvider(providerValue);
  if (provider.provider === 'deepgram') return isDeepgramLiveModel(model);
  if (provider.provider === 'gemini') return isGeminiLiveModel(model);
  if (provider.provider === 'openai') return isOpenAIRealtimeModel(model);
  if (provider.provider === 'grok') return /^grok-voice(?:-[a-z0-9.-]+)?$/i.test(model);
  return getLiveModelOptions(provider.value).some(option => option.value === model);
};

export const normalizeGeminiLiveModelName = (value: unknown): string => {
  const model = String(value || DEFAULT_GEMINI_LIVE_MODEL).trim();
  if (!model) return `models/${DEFAULT_GEMINI_LIVE_MODEL}`;
  return model.startsWith('models/') ? model : `models/${model}`;
};

export const isGeminiLiveModel = (value: unknown): boolean => {
  const model = String(value || '').trim().toLowerCase();
  if (!model || model.includes('translate') || model.includes('robotics')) return false;
  return model.includes('native-audio') || model.includes('flash-live') || model.includes('live-preview');
};

/** OpenAI exposes realtime snapshots through /v1/models in addition to the
 * stable aliases. Keep the selector/provider boundary open for those exact
 * provider IDs instead of silently resetting a discovered selection to auto. */
export const isOpenAIRealtimeModel = (value: unknown): boolean => {
  const model = String(value || '').trim().toLowerCase();
  if (/(?:^|-)(?:whisper|transcribe|translate)(?:-|$)/.test(model)) return false;
  return /^gpt-(?:realtime(?:[-.][a-z0-9.-]+)?|4o-realtime(?:[-.][a-z0-9.-]+)?)$/.test(model);
};
