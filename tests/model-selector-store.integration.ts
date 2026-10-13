import assert from 'node:assert/strict';
import { formatModelName, groupModelsByProvider } from '../src/lib/agent/model-presentation';
import {
  AUTO_MODEL_SELECTION,
  composeApiKeysForSelection,
  ensureModelSelectorEntry,
  isConcreteModelId,
  modelEntryKey,
  normalizeModelSelectorEntries,
  removeModelSelectorEntry,
} from '../src/lib/agent/model-selector-store';
import {
  getGeminiThinkingConfig,
  getModelThinkingOptions,
  inferModelThinkingCapabilities,
  normalizeThinkingLevelForModel,
  type ModelThinkingCapabilities,
} from '../src/lib/agent/model-routing';
import { applyCompatibleThinkingParameters } from '../src/lib/agent/provider-capabilities';

assert.equal(formatModelName('google/gemma-4-31b-it:free'), 'Gemma 4 31B IT');
assert.equal(formatModelName('z-ai/glm-5.2:free'), 'GLM 5.2');
assert.equal(formatModelName('minimax/minimax-m2.7:free'), 'MiniMax M2.7');
assert.equal(formatModelName('gemini-3.5-flash-lite'), 'Gemini 3.5 Flash Lite');
assert.equal(formatModelName('openai/o3-mini'), 'o3 Mini');
assert.equal(formatModelName('future-vendor/brand-new-model-9.2-preview'), 'Brand New Model 9.2 Preview');
assert.equal(formatModelName('accounts/vendor/models/NewModel-8b:q4_K_M'), 'NewModel 8B:q4_K_M');
assert.equal(formatModelName(''), '');
const crossProviderModels = [
  { provider: 'future-gateway', modelId: 'vendor/new-model:free' },
  { provider: 'direct-vendor', modelId: 'new-model' },
  { provider: 'future-gateway', modelId: 'vendor/another-model' },
];
assert.deepEqual(groupModelsByProvider(crossProviderModels), [
  { provider: 'future-gateway', models: [crossProviderModels[0], crossProviderModels[2]] },
  { provider: 'direct-vendor', models: [crossProviderModels[1]] },
]);
assert.equal(crossProviderModels[0].modelId, 'vendor/new-model:free');
assert.notEqual(modelEntryKey('openrouter', 'vendor/new-model'), modelEntryKey('groq', 'vendor/new-model'));
assert.deepEqual(groupModelsByProvider([]), []);

const first = ensureModelSelectorEntry([], 'openrouter', 'openai/gpt-test-a');
const multiple = ensureModelSelectorEntry(first, 'openrouter', 'anthropic/claude-test-b');
assert.deepEqual(multiple, [
  { provider: 'openrouter', modelId: 'openai/gpt-test-a' },
  { provider: 'openrouter', modelId: 'anthropic/claude-test-b' },
]);

assert.deepEqual(
  removeModelSelectorEntry(multiple, 'openrouter', 'openai/gpt-test-a'),
  [{ provider: 'openrouter', modelId: 'anthropic/claude-test-b' }],
);

assert.equal(isConcreteModelId('auto'), false);
assert.equal(isConcreteModelId('openrouter/auto'), false);
assert.equal(isConcreteModelId('default-model'), false);
assert.equal(isConcreteModelId('openai/gpt-test-a'), true);

assert.deepEqual(
  normalizeModelSelectorEntries([
    ...multiple,
    { provider: 'openrouter', modelId: 'openai/gpt-test-a' },
    { provider: 'gemini', modelId: AUTO_MODEL_SELECTION },
  ]),
  multiple,
);

const selectedKey = modelEntryKey('openrouter', 'anthropic/claude-test-b');
assert.deepEqual(
  composeApiKeysForSelection(
    { openrouter: 'provider-key' },
    { [selectedKey]: 'model-specific-key' },
    multiple,
    selectedKey,
  ),
  { openrouter: 'model-specific-key' },
);

assert.deepEqual(
  getModelThinkingOptions('gemini', 'gemini-3.6-flash').map(option => option.id),
  ['minimal', 'low', 'medium', 'high'],
);
assert.deepEqual(
  getModelThinkingOptions('gemini', 'gemini-3.8-flash').map(option => option.id),
  ['low', 'medium', 'high'],
);
assert.deepEqual(
  getModelThinkingOptions('gemini', 'gemini-3-pro-preview').map(option => option.id),
  ['low', 'high'],
);
assert.deepEqual(
  getModelThinkingOptions('gemini', 'gemini-3.1-flash-lite-image-preview').map(option => option.id),
  ['minimal', 'high'],
);
assert.deepEqual(
  getModelThinkingOptions('gemini', 'gemini-2.5-flash-lite').map(option => option.id),
  ['off', 'low', 'medium', 'high'],
);
assert.deepEqual(
  getGeminiThinkingConfig('high', 'gemini-3.8-flash', true),
  { thinkingLevel: 'high', includeThoughts: true },
);
assert.deepEqual(
  getGeminiThinkingConfig('medium', 'gemini-2.5-pro', true),
  { thinkingBudget: 8192, includeThoughts: true },
);
assert.deepEqual(
  getModelThinkingOptions('deepseek', 'deepseek-v4-flash').map(option => option.id),
  ['off', 'low', 'high', 'max'],
);
assert.deepEqual(
  getModelThinkingOptions('deepseek', 'deepseek-reasoner').map(option => option.id),
  [],
);
assert.equal(
  inferModelThinkingCapabilities('deepseek', 'deepseek-v4-pro')?.parameter,
  'reasoning_effort',
);

const advertisedThinking: ModelThinkingCapabilities = {
  levels: ['minimal', 'high'],
  defaultLevel: 'high',
  parameter: 'reasoning_effort',
  source: 'provider',
};
assert.deepEqual(
  getModelThinkingOptions('mimo', 'mimo-v2.5-pro', advertisedThinking).map(option => option.id),
  ['minimal', 'high'],
);
assert.equal(
  normalizeThinkingLevelForModel('medium', 'mimo', 'mimo-v2.5-pro', advertisedThinking),
  'high',
);

const deepSeekOff: Record<string, unknown> = {};
applyCompatibleThinkingParameters(deepSeekOff, 'deepseek', 'deepseek-v4-flash', {
  level: 'off',
  capabilities: inferModelThinkingCapabilities('deepseek', 'deepseek-v4-flash'),
});
assert.deepEqual(deepSeekOff, { reasoning_effort: 'none' });

const deepSeekMax: Record<string, unknown> = {};
applyCompatibleThinkingParameters(deepSeekMax, 'deepseek', 'deepseek-v4-pro', {
  level: 'max',
  capabilities: inferModelThinkingCapabilities('deepseek', 'deepseek-v4-pro'),
});
assert.deepEqual(deepSeekMax, {
  reasoning_effort: 'max',
});

console.log('model selector store integration tests passed');
