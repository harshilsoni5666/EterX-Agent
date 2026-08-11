import assert from 'node:assert/strict';
import {
  AUTO_MODEL_SELECTION,
  composeApiKeysForSelection,
  ensureModelSelectorEntry,
  isConcreteModelId,
  modelEntryKey,
  normalizeModelSelectorEntries,
  removeModelSelectorEntry,
} from '../src/lib/agent/model-selector-store';

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

console.log('model selector store integration tests passed');
