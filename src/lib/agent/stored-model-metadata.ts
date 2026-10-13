import fs from 'node:fs';
import path from 'node:path';
import { getEterxDataDir } from './storage-paths';
import { normalizeModelThinkingCapabilities, type MainAgentProvider, type ModelThinkingCapabilities } from './model-routing';
import { MODEL_THINKING_CAPABILITIES_STORAGE_KEY, MODEL_WIRE_CAPABILITIES_STORAGE_KEY, modelEntryKey } from './model-selector-store';

let revision = '';
let preferences: Record<string, string> = {};

/** Background runs read the same durable metadata as the model selectors. */
export function readStoredModelMetadata(provider: MainAgentProvider, modelId: string): { thinking: ModelThinkingCapabilities | null; wire: string[] } {
  try {
    const file = path.join(getEterxDataDir(), 'settings', 'preferences.json');
    const stat = fs.statSync(file);
    const nextRevision = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (nextRevision !== revision) {
      preferences = JSON.parse(fs.readFileSync(file, 'utf8'));
      revision = nextRevision;
    }
    const key = modelEntryKey(provider, provider === 'gemini' ? modelId.replace(/^models\//, '') : modelId);
    const thinking = normalizeModelThinkingCapabilities(JSON.parse(preferences[MODEL_THINKING_CAPABILITIES_STORAGE_KEY] || '{}')?.[key]);
    const wire = JSON.parse(preferences[MODEL_WIRE_CAPABILITIES_STORAGE_KEY] || '{}')?.[key];
    return { thinking, wire: Array.isArray(wire) ? wire.filter(value => typeof value === 'string') : [] };
  } catch { return { thinking: null, wire: [] }; }
}

export function latestModelThinkingCapability(provider: MainAgentProvider, modelId: string, supplied?: unknown): ModelThinkingCapabilities | null {
  const canonicalId = (value: string) => provider === 'gemini' ? value.replace(/^models\//, '') : value;
  const candidate = normalizeModelThinkingCapabilities(supplied);
  const current = candidate && (!candidate.provider || candidate.provider === provider)
    && (!candidate.modelId || canonicalId(candidate.modelId) === canonicalId(modelId)) ? candidate : null;
  const stored = readStoredModelMetadata(provider, modelId).thinking;
  if (!stored) return current;
  if (!current || (stored.updatedAt || 0) > (current.updatedAt || 0)) return stored;
  return current;
}
