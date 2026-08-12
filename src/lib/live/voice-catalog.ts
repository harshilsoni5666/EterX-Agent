export type LiveVoiceOption = {
  value: string;
  label: string;
  tag?: string;
  description?: string;
};

/** Gemini's documented prebuilt voice names for the native Live transport. */
export const GEMINI_LIVE_VOICE_OPTIONS: LiveVoiceOption[] = [
  { value: 'auto', label: 'Auto (Media Model Default)', tag: 'AUTO', description: 'Uses the active Gemini Live model default voice' },
  { value: 'Kore', label: 'Kore' },
  { value: 'Aoede', label: 'Aoede' },
  { value: 'Charon', label: 'Charon' },
  { value: 'Puck', label: 'Puck' },
  { value: 'Fenrir', label: 'Fenrir' },
  { value: 'Zephyr', label: 'Zephyr' },
  { value: 'Enceladus', label: 'Enceladus' },
  { value: 'Vindemiatrix', label: 'Vindemiatrix' },
  { value: 'Leda', label: 'Leda' },
  { value: 'Orus', label: 'Orus' },
  { value: 'Callirrhoe', label: 'Callirrhoe' },
  { value: 'Autonoe', label: 'Autonoe' },
  { value: 'Iapetus', label: 'Iapetus' },
  { value: 'Umbriel', label: 'Umbriel' },
  { value: 'Algenib', label: 'Algenib' },
  { value: 'Despina', label: 'Despina' },
  { value: 'Erinome', label: 'Erinome' },
  { value: 'Laomedeia', label: 'Laomedeia' },
  { value: 'Achernar', label: 'Achernar' },
  { value: 'Algieba', label: 'Algieba' },
  { value: 'Schedar', label: 'Schedar' },
  { value: 'Gacrux', label: 'Gacrux' },
  { value: 'Pulcherrima', label: 'Pulcherrima' },
  { value: 'Achird', label: 'Achird' },
  { value: 'Zubenelgenubi', label: 'Zubenelgenubi' },
  { value: 'Sadachbia', label: 'Sadachbia' },
  { value: 'Sadaltager', label: 'Sadaltager' },
  { value: 'Sulafat', label: 'Sulafat' },
  { value: 'Alnilam', label: 'Alnilam' },
  { value: 'Rasalgethi', label: 'Rasalgethi' },
];

export const OPENAI_REALTIME_VOICE_OPTIONS: LiveVoiceOption[] = [
  { value: 'auto', label: 'Auto (OpenAI Default)', tag: 'AUTO' },
  { value: 'alloy', label: 'Alloy' },
  { value: 'ash', label: 'Ash' },
  { value: 'ballad', label: 'Ballad' },
  { value: 'cedar', label: 'Cedar' },
  { value: 'coral', label: 'Coral' },
  { value: 'echo', label: 'Echo' },
  { value: 'marin', label: 'Marin' },
  { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse', label: 'Verse' },
];

export const XAI_REALTIME_VOICE_OPTIONS: LiveVoiceOption[] = [
  { value: 'auto', label: 'Auto (Eve)', tag: 'AUTO' },
  { value: 'ara', label: 'Ara' },
  { value: 'eve', label: 'Eve' },
  { value: 'leo', label: 'Leo' },
  { value: 'rex', label: 'Rex' },
  { value: 'sal', label: 'Sal' },
];

export const DEEPGRAM_VOICE_AGENT_VOICE_OPTIONS: LiveVoiceOption[] = [
  { value: 'auto', label: 'Auto (Thalia Aura-2)', tag: 'AUTO', description: 'Uses aura-2-thalia-en' },
  { value: 'aura-2-asteria-en', label: 'Asteria (Aura-2)' },
  { value: 'aura-2-athena-en', label: 'Athena (Aura-2)' },
  { value: 'aura-2-luna-en', label: 'Luna (Aura-2)' },
  { value: 'aura-2-orion-en', label: 'Orion (Aura-2)' },
  { value: 'aura-2-stella-en', label: 'Stella (Aura-2)' },
  { value: 'aura-2-thalia-en', label: 'Thalia (Aura-2)' },
];

export const ELEVENLABS_CONVAI_VOICE_OPTIONS: LiveVoiceOption[] = [
  { value: 'auto', label: 'Auto (Agent Configuration)', tag: 'AUTO', description: 'The voice configured on the selected ElevenLabs agent' },
  { value: 'agent-default', label: 'Agent Default', tag: 'AGENT', description: 'The voice configured on the selected ElevenLabs agent' },
];

export const LIVE_PROVIDER_VOICE_OPTIONS: Record<string, LiveVoiceOption[]> = {
  'agent-live-convo': GEMINI_LIVE_VOICE_OPTIONS,
  'openai-realtime': OPENAI_REALTIME_VOICE_OPTIONS,
  'grok-realtime': XAI_REALTIME_VOICE_OPTIONS,
  'deepgram-voice-agent': DEEPGRAM_VOICE_AGENT_VOICE_OPTIONS,
  'elevenlabs-convai': ELEVENLABS_CONVAI_VOICE_OPTIONS,
};

export const getLiveVoiceOptions = (providerValue: unknown): LiveVoiceOption[] => {
  const normalizedProvider = String(providerValue || '').trim().toLowerCase();
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
  const providerKey = aliases[normalizedProvider] || normalizedProvider;
  const options = LIVE_PROVIDER_VOICE_OPTIONS[providerKey];
  return [...(options || GEMINI_LIVE_VOICE_OPTIONS)];
};
