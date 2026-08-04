export type LiveVoiceOption = {
  value: string;
  label: string;
  tag?: string;
  description?: string;
};

/**
 * Voice catalogs are provider-scoped. The settings surface and the server
 * route both read these same objects, so changing provider/model immediately
 * changes the available voice IDs without stale Gemini-only state.
 */
export const GEMINI_LIVE_VOICE_OPTIONS: LiveVoiceOption[] = [
  { value: 'auto', label: 'Auto (Media Model Default)', tag: 'AUTO', description: 'Uses the active Live media model’s recommended default voice' },
  { value: 'Kore', label: 'Kore', description: 'Firm, confident female voice' },
  { value: 'Aoede', label: 'Aoede', description: 'Breezy, natural female voice' },
  { value: 'Charon', label: 'Charon', description: 'Informative, clear male voice' },
  { value: 'Puck', label: 'Puck', description: 'Upbeat, energetic male voice' },
  { value: 'Fenrir', label: 'Fenrir', description: 'Excitable, dynamic male voice' },
  { value: 'Zephyr', label: 'Zephyr', description: 'Bright, cheerful female voice' },
  { value: 'Enceladus', label: 'Enceladus', description: 'Breathy, calm male voice' },
  { value: 'Vindemiatrix', label: 'Vindemiatrix', description: 'Gentle, dramatic female voice' },
  { value: 'Leda', label: 'Leda', description: 'Youthful female voice' },
  { value: 'Orus', label: 'Orus', description: 'Firm male voice' },
  { value: 'Callirrhoe', label: 'Callirrhoe', description: 'Easy-going female voice' },
  { value: 'Autonoe', label: 'Autonoe', description: 'Bright female voice' },
  { value: 'Iapetus', label: 'Iapetus', description: 'Clear male voice' },
  { value: 'Umbriel', label: 'Umbriel', description: 'Easy-going male voice' },
  { value: 'Algenib', label: 'Algenib', description: 'Gravelly male voice' },
  { value: 'Despina', label: 'Despina', description: 'Smooth female voice' },
  { value: 'Erinome', label: 'Erinome', description: 'Clear female voice' },
  { value: 'Laomedeia', label: 'Laomedeia', description: 'Upbeat female voice' },
  { value: 'Achernar', label: 'Achernar', description: 'Soft female voice' },
  { value: 'Algieba', label: 'Algieba', description: 'Smooth male voice' },
  { value: 'Schedar', label: 'Schedar', description: 'Even male voice' },
  { value: 'Gacrux', label: 'Gacrux', description: 'Mature female voice' },
  { value: 'Pulcherrima', label: 'Pulcherrima', description: 'Forward female voice' },
  { value: 'Achird', label: 'Achird', description: 'Friendly male voice' },
  { value: 'Zubenelgenubi', label: 'Zubenelgenubi', description: 'Casual male voice' },
  { value: 'Sadachbia', label: 'Sadachbia', description: 'Lively male voice' },
  { value: 'Sadaltager', label: 'Sadaltager', description: 'Knowledgeable male voice' },
  { value: 'Sulafat', label: 'Sulafat', description: 'Warm female voice' },
  { value: 'Alnilam', label: 'Alnilam', description: 'Firm male voice' },
  { value: 'Rasalgethi', label: 'Rasalgethi', description: 'Informative male voice' },
];

const autoVoice = (label: string, description: string): LiveVoiceOption => ({
  value: 'auto',
  label: `Auto (${label})`,
  tag: 'AUTO',
  description,
});

export const LIVE_PROVIDER_VOICE_OPTIONS: Record<string, LiveVoiceOption[]> = {
  'agent-live-convo': GEMINI_LIVE_VOICE_OPTIONS,
  'openai-realtime': [
    autoVoice('Latest OpenAI Voice', 'Uses the selected realtime model default voice'),
    { value: 'alloy', label: 'Alloy', description: 'Balanced and natural' },
    { value: 'ash', label: 'Ash', description: 'Expressive and direct' },
    { value: 'ballad', label: 'Ballad', description: 'Rich and narrative' },
    { value: 'coral', label: 'Coral', description: 'Warm and smooth' },
    { value: 'echo', label: 'Echo', description: 'Soft and clear' },
    { value: 'sage', label: 'Sage', description: 'Warm and measured' },
    { value: 'shimmer', label: 'Shimmer', description: 'Bright and clear' },
  ],
  'grok-voice': [
    autoVoice('Latest Grok Voice', 'Uses the selected xAI voice default'),
    { value: 'ara', label: 'Ara', description: 'Natural conversational voice' },
    { value: 'eve', label: 'Eve', description: 'Warm conversational voice' },
    { value: 'leo', label: 'Leo', description: 'Clear conversational voice' },
    { value: 'sal', label: 'Sal', description: 'Steady conversational voice' },
  ],
  'claude-live': [
    autoVoice('Latest Claude Voice', 'Uses the selected Claude transport default voice'),
    { value: 'calm', label: 'Calm', description: 'Measured and clear' },
    { value: 'natural', label: 'Natural', description: 'Conversational and balanced' },
  ],
  'deepseek-live': [
    autoVoice('Latest DeepSeek Voice', 'Uses the selected DeepSeek transport default voice'),
    { value: 'alloy', label: 'Alloy', description: 'Balanced and natural' },
    { value: 'echo', label: 'Echo', description: 'Soft and clear' },
  ],
  elevenlabs: [
    autoVoice('Account Default', 'Uses the default voice configured in ElevenLabs'),
    { value: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel', description: 'Calm conversational female voice' },
    { value: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi', description: 'Energetic female voice' },
    { value: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella', description: 'Soft narrative female voice' },
    { value: 'ErXwobaYiN019PkySvjV', label: 'Antoni', description: 'Warm male voice' },
    { value: 'TxGEfe70L6mWAfGQfd48', label: 'Josh', description: 'Deep male voice' },
  ],
  deepgram: [
    autoVoice('Latest Deepgram Voice', 'Uses the selected Aura voice default'),
    { value: 'aura-2-thalia-en', label: 'Aura-2 Thalia', description: 'Clear female voice' },
    { value: 'aura-2-asteria-en', label: 'Aura-2 Asteria', description: 'Natural female voice' },
    { value: 'aura-2-orpheus-en', label: 'Aura-2 Orpheus', description: 'Warm male voice' },
    { value: 'aura-2-helios-en', label: 'Aura-2 Helios', description: 'Strong male voice' },
    { value: 'aura-2-zeus-en', label: 'Aura-2 Zeus', description: 'Deep male voice' },
  ],
  'hume-evi': [
    autoVoice('Latest Hume Voice', 'Uses the selected EVI voice default'),
    { value: 'evi-2-empathic-1', label: 'Empathic Neutral', description: 'Emotion-aware neutral voice' },
    { value: 'evi-2-empathic-2', label: 'Empathic Warm', description: 'Emotion-aware warm voice' },
  ],
  'cartesia-sonic': [
    autoVoice('Latest Cartesia Voice', 'Uses the selected Sonic voice default'),
    { value: 'sonic-female-1', label: 'Sonic Female', description: 'Fast conversational female voice' },
    { value: 'sonic-male-1', label: 'Sonic Male', description: 'Fast conversational male voice' },
  ],
  playht: [
    autoVoice('Latest PlayHT Voice', 'Uses the selected PlayHT voice default'),
    { value: 'jennifer', label: 'Jennifer', description: 'Natural conversational voice' },
    { value: 'michael', label: 'Michael', description: 'Clear conversational voice' },
  ],
  'groq-live': [
    autoVoice('Latest Groq Voice', 'Uses the selected realtime voice default'),
    { value: 'alloy', label: 'Alloy', description: 'Balanced and natural' },
    { value: 'echo', label: 'Echo', description: 'Soft and clear' },
  ],
  'cerebras-live': [autoVoice('Latest Cerebras Voice', 'Uses the selected transport default voice')],
  'sambanova-live': [autoVoice('Latest SambaNova Voice', 'Uses the selected transport default voice')],
  'together-voice': [
    autoVoice('Latest Together Voice', 'Uses the selected transport default voice'),
    { value: 'together-female-1', label: 'Together Female', description: 'Conversational female voice' },
    { value: 'together-male-1', label: 'Together Male', description: 'Conversational male voice' },
  ],
  'fireworks-speech': [
    autoVoice('Latest Fireworks Voice', 'Uses the selected transport default voice'),
    { value: 'fireworks-female-1', label: 'Fireworks Female', description: 'Conversational female voice' },
    { value: 'fireworks-male-1', label: 'Fireworks Male', description: 'Conversational male voice' },
  ],
  'perplexity-live': [autoVoice('Latest Perplexity Voice', 'Uses the selected transport default voice')],
  'cohere-live': [autoVoice('Latest Cohere Voice', 'Uses the selected transport default voice')],
  'openrouter-live': [autoVoice('Latest Routed Voice', 'Uses the selected routed model default voice')],
  'ollama-local': [
    autoVoice('Local System Voice', 'Uses the local browser/system voice'),
    { value: 'piper-tts-en', label: 'Piper Local Neural Voice', tag: 'LOCAL' },
    { value: 'coqui-xtts-v2', label: 'Coqui XTTS-v2', tag: 'LOCAL' },
  ],
  'lmstudio-local': [autoVoice('Local System Voice', 'Uses the local browser/system voice')],
  'vllm-local': [autoVoice('Local System Voice', 'Uses the local browser/system voice')],
};

export const getLiveVoiceOptions = (providerValue: unknown): LiveVoiceOption[] => {
  const options = LIVE_PROVIDER_VOICE_OPTIONS[String(providerValue || '').trim()];
  return [...(options || [autoVoice('Provider Default', 'Uses the selected provider default voice')])];
};
