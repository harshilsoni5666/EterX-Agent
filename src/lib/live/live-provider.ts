export type LiveModelOption = {
  value: string;
  label: string;
  tag?: string;
  description?: string;
};

export type LiveProviderOption = {
  value: string;
  /** Provider id used by the selected live transport. */
  provider: string;
  /** Key slot used in Settings > Live Convo. */
  keyProvider: string;
  label: string;
  description: string;
};

/**
 * Live Convo is provider-scoped.  Every option has its own key slot and
 * catalogs; callers must use the selected option instead of silently routing
 * to Gemini (the old implementation did exactly that).
 */
export const LIVE_PROVIDER_OPTIONS: LiveProviderOption[] = [
  { value: 'agent-live-convo', provider: 'gemini', keyProvider: 'gemini', label: 'Google Gemini Live', description: 'Native bidirectional audio, video, and tool-calling session' },
  { value: 'openai-realtime', provider: 'openai', keyProvider: 'openai', label: 'OpenAI Realtime', description: 'Realtime audio session with GPT voice models' },
  { value: 'grok-voice', provider: 'grok', keyProvider: 'grok', label: 'xAI Grok Voice', description: 'xAI realtime voice and multimodal session' },
  { value: 'claude-live', provider: 'anthropic', keyProvider: 'anthropic', label: 'Anthropic Claude Live', description: 'Claude live conversation model' },
  { value: 'deepseek-live', provider: 'deepseek', keyProvider: 'deepseek', label: 'DeepSeek Live', description: 'DeepSeek live conversation model' },
  { value: 'elevenlabs', provider: 'elevenlabs', keyProvider: 'elevenlabs', label: 'ElevenLabs Voice Agent', description: 'Low-latency voice agent and speech synthesis' },
  { value: 'deepgram', provider: 'deepgram', keyProvider: 'deepgram', label: 'Deepgram Voice', description: 'Realtime transcription and voice pipeline' },
  { value: 'hume-evi', provider: 'hume', keyProvider: 'hume', label: 'Hume EVI', description: 'Emotion-aware conversational voice' },
  { value: 'cartesia-sonic', provider: 'cartesia', keyProvider: 'cartesia', label: 'Cartesia Sonic', description: 'Low-latency multilingual speech' },
  { value: 'playht', provider: 'playht', keyProvider: 'playht', label: 'PlayHT', description: 'Realtime conversational speech' },
  { value: 'groq-live', provider: 'groq', keyProvider: 'groq', label: 'Groq Realtime', description: 'Fast open-model voice pipeline' },
  { value: 'cerebras-live', provider: 'cerebras', keyProvider: 'cerebras', label: 'Cerebras Realtime', description: 'Fast conversational model pipeline' },
  { value: 'sambanova-live', provider: 'sambanova', keyProvider: 'sambanova', label: 'SambaNova Realtime', description: 'Realtime open-model conversation' },
  { value: 'together-voice', provider: 'together', keyProvider: 'together', label: 'Together Voice', description: 'Together AI voice pipeline' },
  { value: 'fireworks-speech', provider: 'fireworks', keyProvider: 'fireworks', label: 'Fireworks Speech', description: 'Fireworks AI speech pipeline' },
  { value: 'perplexity-live', provider: 'perplexity', keyProvider: 'perplexity', label: 'Perplexity Live', description: 'Search-aware live conversation' },
  { value: 'cohere-live', provider: 'cohere', keyProvider: 'cohere', label: 'Cohere Live', description: 'Cohere conversational pipeline' },
  { value: 'openrouter-live', provider: 'openrouter', keyProvider: 'openrouter', label: 'OpenRouter Live', description: 'Provider-routed live conversation' },
  { value: 'ollama-local', provider: 'ollama', keyProvider: 'ollama', label: 'Ollama Local', description: 'Local Ollama conversation' },
  { value: 'lmstudio-local', provider: 'lmstudio', keyProvider: 'lmstudio', label: 'LM Studio Local', description: 'Local LM Studio conversation' },
  { value: 'vllm-local', provider: 'vllm', keyProvider: 'vllm', label: 'vLLM Local', description: 'Local vLLM conversation' },
];

const models = (options: LiveModelOption[]) => options;

export const LIVE_PROVIDER_MODELS: Record<string, LiveModelOption[]> = {
  'agent-live-convo': models([
    { value: 'auto', label: 'Auto (Latest Gemini Live Model)', tag: 'AUTO', description: 'Uses the newest live model returned by Gemini' },
    { value: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live Preview', tag: 'LIVE', description: 'Native realtime audio and multimodal model' },
    { value: 'gemini-2.0-flash-exp-live', label: 'Gemini 2.0 Flash Live', tag: 'LIVE', description: 'Low-latency multimodal stream' },
    { value: 'gemini-2.0-flash-thinking-exp-live', label: 'Gemini 2.0 Flash Thinking Live', tag: 'LIVE', description: 'Realtime reasoning stream' },
  ]),
  'openai-realtime': models([
    { value: 'auto', label: 'Auto (Latest OpenAI Realtime Model)', tag: 'AUTO', description: 'Uses the newest OpenAI realtime model' },
    { value: 'gpt-4o-realtime-preview', label: 'GPT-4o Realtime Preview', tag: 'REALTIME', description: 'Full-duplex realtime audio' },
    { value: 'gpt-4o-mini-realtime-preview', label: 'GPT-4o Mini Realtime Preview', description: 'Lower-cost realtime audio' },
    { value: 'gpt-4o-audio-preview', label: 'GPT-4o Audio Preview', description: 'Audio input and output' },
  ]),
  'grok-voice': models([
    { value: 'auto', label: 'Auto (Latest Grok Voice)', tag: 'AUTO', description: 'Uses the newest xAI voice model' },
    { value: 'grok-2-voice', label: 'Grok 2 Voice', tag: 'VOICE' },
    { value: 'grok-3-realtime', label: 'Grok 3 Realtime', tag: 'REALTIME' },
  ]),
  'claude-live': models([
    { value: 'auto', label: 'Auto (Latest Claude Live Model)', tag: 'AUTO' },
    { value: 'claude-3-5-sonnet-live', label: 'Claude Sonnet Live', tag: 'LIVE' },
    { value: 'claude-3-5-haiku-live', label: 'Claude Haiku Live', tag: 'LIVE' },
  ]),
  'deepseek-live': models([
    { value: 'auto', label: 'Auto (Latest DeepSeek Model)', tag: 'AUTO' },
    { value: 'deepseek-v3-live', label: 'DeepSeek V3 Live', tag: 'LIVE' },
    { value: 'deepseek-r1-live', label: 'DeepSeek R1 Live', tag: 'LIVE' },
  ]),
  elevenlabs: models([
    { value: 'auto', label: 'Auto (Latest ElevenLabs Agent)', tag: 'AUTO' },
    { value: 'eleven_flash_v2_5', label: 'ElevenLabs Flash v2.5', tag: 'LOW LATENCY' },
    { value: 'eleven_turbo_v2_5', label: 'ElevenLabs Turbo v2.5' },
    { value: 'eleven_multilingual_v2', label: 'ElevenLabs Multilingual v2' },
  ]),
  deepgram: models([
    { value: 'auto', label: 'Auto (Latest Deepgram Pipeline)', tag: 'AUTO' },
    { value: 'aura-2-thalia-en', label: 'Aura-2 Thalia', tag: 'VOICE' },
    { value: 'aura-2-asteria-en', label: 'Aura-2 Asteria', tag: 'VOICE' },
    { value: 'aura-2-orpheus-en', label: 'Aura-2 Orpheus', tag: 'VOICE' },
    { value: 'aura-2-helios-en', label: 'Aura-2 Helios', tag: 'VOICE' },
    { value: 'aura-2-zeus-en', label: 'Aura-2 Zeus', tag: 'VOICE' },
  ]),
  'hume-evi': models([
    { value: 'auto', label: 'Auto (Latest Hume EVI Model)', tag: 'AUTO' },
    { value: 'evi-2-empathic', label: 'Hume EVI-2 Empathic', tag: 'VOICE' },
  ]),
  'cartesia-sonic': models([
    { value: 'auto', label: 'Auto (Latest Cartesia Sonic)', tag: 'AUTO' },
    { value: 'sonic-multilingual', label: 'Cartesia Sonic Multilingual', tag: 'LOW LATENCY' },
  ]),
  playht: models([
    { value: 'auto', label: 'Auto (Latest PlayHT Model)', tag: 'AUTO' },
    { value: 'playht-2.0-turbo', label: 'PlayHT 2.0 Turbo', tag: 'LOW LATENCY' },
  ]),
  'groq-live': models([
    { value: 'auto', label: 'Auto (Latest Groq Model)', tag: 'AUTO' },
    { value: 'groq-llama-3.3-70b-realtime', label: 'Groq Llama 3.3 70B Realtime', tag: 'REALTIME' },
    { value: 'groq-whisper-v3-fast', label: 'Groq Whisper v3 Fast', tag: 'VOICE' },
  ]),
  'cerebras-live': models([
    { value: 'auto', label: 'Auto (Latest Cerebras Model)', tag: 'AUTO' },
    { value: 'cerebras-llama3.3-70b-realtime', label: 'Cerebras Llama 3.3 70B Realtime', tag: 'REALTIME' },
  ]),
  'sambanova-live': models([
    { value: 'auto', label: 'Auto (Latest SambaNova Model)', tag: 'AUTO' },
    { value: 'sambanova-deepseek-r1-voice', label: 'SambaNova DeepSeek R1 Voice', tag: 'VOICE' },
  ]),
  'together-voice': models([
    { value: 'auto', label: 'Auto (Latest Together Model)', tag: 'AUTO' },
    { value: 'together-whisper-llama3-tts', label: 'Together Whisper + Llama 3', tag: 'VOICE' },
  ]),
  'fireworks-speech': models([
    { value: 'auto', label: 'Auto (Latest Fireworks Model)', tag: 'AUTO' },
    { value: 'fireworks-whisper-v3-fast', label: 'Fireworks Whisper v3 Fast', tag: 'VOICE' },
  ]),
  'perplexity-live': models([
    { value: 'auto', label: 'Auto (Latest Perplexity Model)', tag: 'AUTO' },
    { value: 'sonar-reasoning-pro-live', label: 'Perplexity Sonar Reasoning Pro', tag: 'LIVE' },
  ]),
  'cohere-live': models([
    { value: 'auto', label: 'Auto (Latest Cohere Model)', tag: 'AUTO' },
    { value: 'command-r-plus-live', label: 'Cohere Command R+ Live', tag: 'LIVE' },
  ]),
  'openrouter-live': models([
    { value: 'auto', label: 'Auto (Latest OpenRouter Model)', tag: 'AUTO' },
    { value: 'openrouter-auto-realtime', label: 'OpenRouter Auto Realtime', tag: 'ROUTED' },
  ]),
  'ollama-local': models([
    { value: 'auto', label: 'Auto (Latest Ollama Model)', tag: 'AUTO' },
    { value: 'ollama-local-whisper-llama3', label: 'Ollama Whisper + Llama 3', tag: 'LOCAL' },
  ]),
  'lmstudio-local': models([
    { value: 'auto', label: 'Auto (Latest LM Studio Model)', tag: 'AUTO' },
    { value: 'lmstudio-local-server', label: 'LM Studio Local Server', tag: 'LOCAL' },
  ]),
  'vllm-local': models([
    { value: 'auto', label: 'Auto (Latest vLLM Model)', tag: 'AUTO' },
    { value: 'vllm-openai-compatible-live', label: 'vLLM OpenAI-Compatible Live', tag: 'LOCAL' },
  ]),
};

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

export const getLiveProvider = (value: unknown): LiveProviderOption => {
  const normalized = String(value || '').trim().toLowerCase();
  const aliases: Record<string, string> = {
    gemini: 'agent-live-convo',
    'gemini-live': 'agent-live-convo',
    'agent-live': 'agent-live-convo',
  };
  const resolved = aliases[normalized] || normalized;
  return LIVE_PROVIDER_OPTIONS.find(option => option.value === resolved) || LIVE_PROVIDER_OPTIONS[0];
};

export const normalizeLiveProvider = (value: unknown): LiveProviderOption => getLiveProvider(value);

export const getLiveModelOptions = (providerValue: unknown): LiveModelOption[] => {
  const provider = getLiveProvider(providerValue);
  return [...(LIVE_PROVIDER_MODELS[provider.value] || [{ value: 'auto', label: 'Auto', tag: 'AUTO' }])];
};

export const isLiveModelForProvider = (providerValue: unknown, modelValue: unknown): boolean => {
  const model = String(modelValue || '').trim();
  // A provider may return a model id that is newer than the bundled catalog.
  // Keep exact ids selected from the live response across reloads; the
  // provider itself remains authoritative and no other provider is consulted.
  return model === 'auto' || getLiveModelOptions(providerValue).some(option => option.value === model) || Boolean(model);
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
