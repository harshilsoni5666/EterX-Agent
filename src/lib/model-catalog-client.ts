'use client';

import { appStorage, appStorageReady } from './client-storage';
import { requestJson } from './request-json';
import { normalizeModelThinkingCapabilities, type MainAgentProvider } from './agent/model-routing';
import {
  MODEL_SELECTOR_STORAGE_KEY, MODEL_CATALOG_STORAGE_KEY, MODEL_OVERRIDE_STORAGE_KEY,
  MODEL_THINKING_CAPABILITIES_STORAGE_KEY, MODEL_WIRE_CAPABILITIES_STORAGE_KEY,
  MODEL_CONTEXT_WINDOWS_STORAGE_KEY, CHAT_MODEL_SELECTION_STORAGE_KEY,
  normalizeModelSelectorEntries, entriesToModelCatalog, parseModelEntryKey, modelEntryKey,
} from './agent/model-selector-store';

const pending = new Map<MainAgentProvider, Promise<void>>();
const generations = new Map<MainAgentProvider, number>();
let configurationRevision = 0;
let listening = false;

/** Settings and composer requests share an ordering, even while credentials change. */
export function beginModelCatalogRequest(provider: MainAgentProvider): () => boolean {
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('eterx-settings-updated', event => {
      const type = (event as CustomEvent).detail?.type;
      if (type === 'api-keys-updated' || type === 'model-api-keys-updated') configurationRevision += 1;
    });
    window.addEventListener('eterx-folder-storage-updated', event => {
      const key = (event as CustomEvent).detail?.key;
      if (['eterx_provider_base_urls', 'eterx_api_keys', 'eterx_model_api_keys', 'eterx_api_key_presence', 'eterx_model_api_key_presence'].includes(key)) configurationRevision += 1;
    });
  }
  const generation = (generations.get(provider) || 0) + 1;
  generations.set(provider, generation);
  const revision = configurationRevision;
  return () => generations.get(provider) === generation && configurationRevision === revision;
}
const readRecord = (key: string): Record<string, any> => {
  try { const value = JSON.parse(appStorage.getItem(key) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
};
const readEntries = () => {
  let value: unknown = null;
  try { value = JSON.parse(appStorage.getItem(MODEL_SELECTOR_STORAGE_KEY) || 'null'); } catch { }
  return normalizeModelSelectorEntries(value, readRecord(MODEL_CATALOG_STORAGE_KEY));
};

/** A single refresh path for every selector; failures never erase saved data. */
export async function refreshSavedModelCatalog(providers?: MainAgentProvider[]): Promise<void> {
  await appStorageReady;
  const entries = readEntries();
  await Promise.all([...new Set(providers || entries.map(entry => entry.provider))].map(provider => {
    const active = pending.get(provider);
    if (active) return active;
    const isCurrent = beginModelCatalogRequest(provider);
    const operation = (async () => {
      const response = await requestJson('/api/settings/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: [provider] }) }, 45_000);
      if (!response.ok) return;
      const payload = await response.json();
      const result = payload?.providers?.[provider];
      if (!isCurrent()) return;
      if (result?.connected !== true || result?.source !== 'live' || !Array.isArray(result.models)) return;
      const available = new Set<string>(result.models.map((model: any) => String(model.id)));
      const replaceProviderRecord = (key: string) => Object.fromEntries(Object.entries(readRecord(key)).filter(([id]) => parseModelEntryKey(id)?.provider !== provider));
      const thinking = replaceProviderRecord(MODEL_THINKING_CAPABILITIES_STORAGE_KEY);
      const wire = replaceProviderRecord(MODEL_WIRE_CAPABILITIES_STORAGE_KEY);
      const windows = replaceProviderRecord(MODEL_CONTEXT_WINDOWS_STORAGE_KEY);
      for (const model of result.models) {
        const key = modelEntryKey(provider, String(model.id));
        const capability = normalizeModelThinkingCapabilities(model.thinking);
        if (capability) thinking[key] = capability;
        if (Array.isArray(model.capabilities)) wire[key] = model.capabilities.map(String);
        const limit = Number(model.inputTokenLimit || model.contextLength || 0);
        if (Number.isFinite(limit) && limit > 0) windows[key] = Math.floor(limit);
      }
      // Read after the network request so a concurrent user selection wins.
      const currentEntries = readEntries();
      const modelEntries = currentEntries.filter(entry => entry.provider !== provider || available.has(entry.modelId));
      const modelCatalog = entriesToModelCatalog(modelEntries);
      const modelOverrides = readRecord(MODEL_OVERRIDE_STORAGE_KEY);
      if (modelOverrides[provider] && !available.has(modelOverrides[provider])) delete modelOverrides[provider];
      const selected = appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || '';
      const entry = parseModelEntryKey(selected);
      const chatModelSelection = entry?.provider === provider && !available.has(entry.modelId) ? '' : selected;
      appStorage.setItems({
        [MODEL_THINKING_CAPABILITIES_STORAGE_KEY]: JSON.stringify(thinking),
        [MODEL_WIRE_CAPABILITIES_STORAGE_KEY]: JSON.stringify(wire),
        [MODEL_CONTEXT_WINDOWS_STORAGE_KEY]: JSON.stringify(windows),
        [MODEL_SELECTOR_STORAGE_KEY]: JSON.stringify(modelEntries),
        [MODEL_CATALOG_STORAGE_KEY]: JSON.stringify(modelCatalog),
        [MODEL_OVERRIDE_STORAGE_KEY]: JSON.stringify(modelOverrides),
        [CHAT_MODEL_SELECTION_STORAGE_KEY]: chatModelSelection,
      });
      const detail = { type: 'model-selector-updated', modelEntries, modelCatalog, modelOverrides, chatModelSelection, thinkingCapabilities: thinking, contextWindows: windows };
      window.dispatchEvent(new CustomEvent('eterx-settings-updated', { detail }));
      // Other windows re-read the durable preferences after the storage flush.
      // Sending a snapshot before that flush creates stale cross-window reads.
    })().catch(() => undefined).finally(() => pending.delete(provider));
    pending.set(provider, operation);
    return operation;
  }));
}
