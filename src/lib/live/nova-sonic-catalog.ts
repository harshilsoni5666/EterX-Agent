/**
 * Client-safe constants and protocol builders for Amazon Nova 2 Sonic.
 *
 * This module intentionally contains no AWS SDK imports, credentials, or
 * transport code. A future server relay can consume these definitions without
 * making any AWS authentication material available to the browser bundle.
 */

export const NOVA_SONIC_PROVIDER_ID = 'amazon-nova-sonic';
export const NOVA_SONIC_MODEL_ID = 'amazon.nova-2-sonic-v1:0';

/** Regions currently listed by AWS for Nova 2 Sonic. */
export const NOVA_SONIC_SUPPORTED_REGIONS = [
  'us-east-1',
  'us-west-2',
  'eu-north-1',
  'ap-northeast-1',
] as const;

export type NovaSonicRegion = (typeof NOVA_SONIC_SUPPORTED_REGIONS)[number];

export const NOVA_SONIC_DEFAULT_REGION: NovaSonicRegion = 'us-east-1';
export const NOVA_SONIC_INPUT_SAMPLE_RATE_HZ = 16_000;
export const NOVA_SONIC_OUTPUT_SAMPLE_RATE_HZ = 24_000;

export const NOVA_SONIC_INPUT_AUDIO_CONFIGURATION = {
  mediaType: 'audio/lpcm',
  sampleRateHertz: NOVA_SONIC_INPUT_SAMPLE_RATE_HZ,
  sampleSizeBits: 16,
  channelCount: 1,
  audioType: 'SPEECH',
  encoding: 'base64',
} as const;

export const NOVA_SONIC_OUTPUT_AUDIO_CONFIGURATION = {
  mediaType: 'audio/lpcm',
  sampleRateHertz: NOVA_SONIC_OUTPUT_SAMPLE_RATE_HZ,
  sampleSizeBits: 16,
  channelCount: 1,
  voiceId: 'tiffany',
} as const;

/** Voice IDs documented by AWS for Nova 2 Sonic. */
export const NOVA_SONIC_VOICE_IDS = [
  'tiffany',
  'matthew',
  'amy',
  'olivia',
  'kiara',
  'arjun',
  'ambre',
  'florian',
  'beatrice',
  'lorenzo',
  'tina',
  'carolina',
  'leo',
  'lupe',
  'carlos',
] as const;

export type NovaSonicVoiceId = (typeof NOVA_SONIC_VOICE_IDS)[number];

export type NovaSonicToolSpec = {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
};

export const isNovaSonicRegion = (value: unknown): value is NovaSonicRegion =>
  typeof value === 'string' && (NOVA_SONIC_SUPPORTED_REGIONS as readonly string[]).includes(value);

export const isNovaSonicVoice = (value: unknown): value is NovaSonicVoiceId =>
  typeof value === 'string' && (NOVA_SONIC_VOICE_IDS as readonly string[]).includes(value);

export const getNovaSonicRuntimeEndpoint = (region: NovaSonicRegion): string =>
  `https://bedrock-runtime.${region}.amazonaws.com`;

export const buildNovaSonicSessionStart = (options: {
  maxTokens?: number;
  topP?: number;
  temperature?: number;
  endpointingSensitivity?: 'HIGH' | 'MEDIUM' | 'LOW';
} = {}) => ({
  event: {
    sessionStart: {
      inferenceConfiguration: {
        maxTokens: options.maxTokens ?? 1024,
        topP: options.topP ?? 0.9,
        temperature: options.temperature ?? 0.7,
      },
      turnDetectionConfiguration: {
        endpointingSensitivity: options.endpointingSensitivity ?? 'MEDIUM',
      },
    },
  },
});

export const buildNovaSonicPromptStart = (options: {
  promptName: string;
  voiceId?: NovaSonicVoiceId;
  tools?: NovaSonicToolSpec[];
}): Record<string, unknown> => ({
  event: {
    promptStart: {
      promptName: options.promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: {
        ...NOVA_SONIC_OUTPUT_AUDIO_CONFIGURATION,
        voiceId: options.voiceId ?? NOVA_SONIC_OUTPUT_AUDIO_CONFIGURATION.voiceId,
      },
      ...(options.tools?.length ? { toolConfiguration: { tools: options.tools } } : {}),
    },
  },
});

export const buildNovaSonicAudioContentStart = (options: {
  promptName: string;
  contentName: string;
}) => ({
  event: {
    contentStart: {
      promptName: options.promptName,
      contentName: options.contentName,
      type: 'AUDIO',
      interactive: true,
      role: 'USER',
      audioInputConfiguration: NOVA_SONIC_INPUT_AUDIO_CONFIGURATION,
    },
  },
});

export const buildNovaSonicAudioInput = (options: {
  promptName: string;
  contentName: string;
  content: string;
}) => ({
  event: {
    audioInput: {
      promptName: options.promptName,
      contentName: options.contentName,
      content: options.content,
    },
  },
});

export const buildNovaSonicToolResult = (options: {
  promptName: string;
  contentName: string;
  toolUseId: string;
  result: unknown;
}) => ({
  contentStart: {
    promptName: options.promptName,
    contentName: options.contentName,
    type: 'TOOL',
    role: 'TOOL',
    interactive: false,
    toolResultInputConfiguration: {
      toolUseId: options.toolUseId,
      type: 'TEXT',
    },
  },
  toolResult: {
    promptName: options.promptName,
    contentName: options.contentName,
    content: JSON.stringify(options.result),
  },
});

