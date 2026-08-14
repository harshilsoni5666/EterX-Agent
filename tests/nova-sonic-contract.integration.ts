import assert from 'node:assert/strict';
import {
  NOVA_SONIC_INPUT_AUDIO_CONFIGURATION,
  NOVA_SONIC_INPUT_SAMPLE_RATE_HZ,
  NOVA_SONIC_MODEL_ID,
  NOVA_SONIC_OUTPUT_AUDIO_CONFIGURATION,
  NOVA_SONIC_OUTPUT_SAMPLE_RATE_HZ,
  NOVA_SONIC_SUPPORTED_REGIONS,
  NOVA_SONIC_VOICE_IDS,
  buildNovaSonicAudioContentStart,
  buildNovaSonicAudioInput,
  buildNovaSonicPromptStart,
  buildNovaSonicSessionStart,
  buildNovaSonicToolResult,
  getNovaSonicRuntimeEndpoint,
  isNovaSonicRegion,
  isNovaSonicVoice,
} from '../src/lib/live/nova-sonic-catalog';

assert.equal(NOVA_SONIC_MODEL_ID, 'amazon.nova-2-sonic-v1:0');
assert.deepEqual(NOVA_SONIC_SUPPORTED_REGIONS, [
  'us-east-1',
  'us-west-2',
  'eu-north-1',
  'ap-northeast-1',
]);
assert.equal(getNovaSonicRuntimeEndpoint('us-east-1'), 'https://bedrock-runtime.us-east-1.amazonaws.com');
assert.equal(isNovaSonicRegion('eu-north-1'), true);
assert.equal(isNovaSonicRegion('us-east-2'), false);
assert.equal(isNovaSonicVoice('tiffany'), true);
assert.equal(isNovaSonicVoice('not-a-nova-voice'), false);

assert.equal(NOVA_SONIC_INPUT_SAMPLE_RATE_HZ, 16_000);
assert.equal(NOVA_SONIC_OUTPUT_SAMPLE_RATE_HZ, 24_000);
assert.deepEqual(NOVA_SONIC_INPUT_AUDIO_CONFIGURATION, {
  mediaType: 'audio/lpcm',
  sampleRateHertz: 16_000,
  sampleSizeBits: 16,
  channelCount: 1,
  audioType: 'SPEECH',
  encoding: 'base64',
});
assert.equal(NOVA_SONIC_OUTPUT_AUDIO_CONFIGURATION.sampleRateHertz, 24_000);

const sessionStart = buildNovaSonicSessionStart({ endpointingSensitivity: 'HIGH' });
assert.equal(sessionStart.event.sessionStart.turnDetectionConfiguration.endpointingSensitivity, 'HIGH');

const promptStart = buildNovaSonicPromptStart({ promptName: 'prompt-1', voiceId: 'matthew' });
const promptStartEvent = promptStart.event as any;
assert.equal(promptStartEvent.promptStart.promptName, 'prompt-1');
assert.equal(promptStartEvent.promptStart.audioOutputConfiguration.voiceId, 'matthew');

const audioStart = buildNovaSonicAudioContentStart({ promptName: 'prompt-1', contentName: 'audio-1' });
assert.equal(audioStart.event.contentStart.audioInputConfiguration.sampleRateHertz, 16_000);
assert.equal(audioStart.event.contentStart.audioInputConfiguration.channelCount, 1);

const audioInput = buildNovaSonicAudioInput({ promptName: 'prompt-1', contentName: 'audio-1', content: 'AAE=' });
assert.equal(audioInput.event.audioInput.content, 'AAE=');

const toolResult = buildNovaSonicToolResult({
  promptName: 'prompt-1',
  contentName: 'tool-1',
  toolUseId: 'tool-use-1',
  result: { ok: true },
});
assert.equal(toolResult.contentStart.toolResultInputConfiguration.toolUseId, 'tool-use-1');
assert.equal(toolResult.toolResult.content, '{"ok":true}');

console.log('Nova Sonic contract checks passed');
