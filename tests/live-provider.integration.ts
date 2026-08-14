import assert from 'node:assert/strict';
import {
  DEFAULT_OPENAI_LIVE_MODEL,
  DEFAULT_DEEPGRAM_THINK_MODEL,
  getLiveModelOptions,
  isLiveModelForProvider,
  isOpenAIRealtimeModel,
  readDeepgramGrantCredential,
  readLiveRealtimeCredential,
} from '../src/lib/live/live-provider';
import { getLiveVoiceOptions } from '../src/lib/live/voice-catalog';
import {
  buildXaiRealtimeUrl,
  buildXaiSessionUpdate,
  buildXaiTruncateEvent,
  createElevenLabsInitiationMessage,
  parseElevenLabsAudioFormat,
} from '../src/lib/live/provider-live';

const openAiModels = getLiveModelOptions('openai-realtime').map(model => model.value);
assert.equal(DEFAULT_OPENAI_LIVE_MODEL, 'gpt-realtime-2.1');
assert.ok(openAiModels.includes('gpt-realtime'));
assert.ok(openAiModels.includes('gpt-realtime-mini'));
assert.ok(openAiModels.includes('gpt-realtime-2.1'));
assert.ok(openAiModels.includes('gpt-realtime-2.1-mini'));
assert.equal(isLiveModelForProvider('openai-realtime', 'gpt-realtime'), true);
assert.equal(isLiveModelForProvider('openai-realtime', 'gpt-realtime-2025-08-28'), true);
assert.equal(isLiveModelForProvider('openai-realtime', 'gpt-realtime-2.1'), true);
assert.equal(isLiveModelForProvider('openai-realtime', 'gpt-5'), false);
assert.equal(isOpenAIRealtimeModel('gpt-4o-realtime-preview-2025-06-03'), true);
assert.equal(isOpenAIRealtimeModel('gpt-realtime-whisper'), false);
assert.ok(getLiveVoiceOptions('openai-realtime').some(voice => voice.value === 'marin'));
assert.ok(getLiveVoiceOptions('openai-realtime').some(voice => voice.value === 'cedar'));

assert.deepEqual(
  readLiveRealtimeCredential({ client_secret: { value: 'ek_openai', expires_at: 123 } }),
  { token: 'ek_openai', expiresAt: 123 },
);
assert.deepEqual(
  readLiveRealtimeCredential({ value: 'xai_ephemeral', expires_at: 456 }),
  { token: 'xai_ephemeral', expiresAt: 456 },
);
assert.deepEqual(
  readDeepgramGrantCredential({ access_token: 'dg_temp', expires_in: 60 }),
  { token: 'dg_temp', expiresIn: 60 },
);
assert.equal(DEFAULT_DEEPGRAM_THINK_MODEL, 'gpt-5-mini');

assert.equal(
  buildXaiRealtimeUrl('grok-voice-latest', 'conversation-1'),
  'wss://api.x.ai/v1/realtime?model=grok-voice-latest&conversation_id=conversation-1',
);
const xaiSession = buildXaiSessionUpdate({ instructions: 'Speak briefly.', voice: 'eve' });
assert.equal(xaiSession.session.turn_detection.type, 'server_vad');
assert.equal('tool_choice' in xaiSession.session, false);
assert.deepEqual(buildXaiTruncateEvent('item-1', 42), {
  type: 'conversation.item.truncate', item_id: 'item-1', content_index: 0, audio_end_ms: 42,
});

assert.deepEqual(parseElevenLabsAudioFormat('pcm_16000'), { encoding: 'pcm16', sampleRate: 16_000 });
assert.throws(() => parseElevenLabsAudioFormat('ulaw_8000'), /Unsupported ElevenLabs audio format/);
assert.equal(
  (createElevenLabsInitiationMessage('Use the task context.') as any).conversation_config_override.agent.prompt.prompt,
  'Use the task context.',
);

console.log('live provider integration tests passed');
