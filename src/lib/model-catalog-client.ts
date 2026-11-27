'use client';

import { appStorage, appStorageReady } from './client-storage';
import { requestJson } from './request-json';
import { isLocalModelProvider, normalizeProviderBaseURL } from './agent/provider-runtime';
import { normalizeModelThinkingCapabilities, type MainAgentProvider } from './agent/model-routing';
import {
  API_KEY_PRESENCE_STORAGE_KEY,
  MODEL_API_KEY_PRESENCE_STORAGE_KEY,
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_CATALOG_STORAGE_KEY,
  MODEL_THINKING_CAPABILITIES_STORAGE_KEY,
  MODEL_WIRE_CAPABILITIES_STORAGE_KEY,
  MODEL_CONTEXT_WINDOWS_STORAGE_KEY,
  MODEL_PROVIDER_ORDER,
  isAccountModelProvider,
  isModelProvider,
  modelEntryKey,
  normalizeModelSelectorEntries,
  parseModelEntryKey,
  type ModelSelectorEntry,
} from './agent/model-selector-store';

export const PROVIDER_BASE_URLS_STORAGE_KEY = 'eterx_provider_base_urls';
const DISCOVERED_MODELS_PREFIX = 'eterx_discovered_models:';
const MODEL_CATALOG_REFRESH_MS = 30_000;
const pending = new Map<MainAgentProvider, Promise<void>>();
const nextRefresh = new Map<MainAgentProvider, number>();

const catalogKey = (provider: MainAgentProvider) => DISCOVERED_MODELS_PREFIX + provider;
const modelSources = [
  API_KEY_PRESENCE_STORAGE_KEY, MODEL_API_KEY_PRESENCE_STORAGE_KEY, PROVIDER_BASE_URLS_STORAGE_KEY,
  MODEL_SELECTOR_STORAGE_KEY, MODEL_CATALOG_STORAGE_KEY, ...MODEL_PROVIDER_ORDER.map(catalogKey),
];
let previousSources: Array<string | null> | undefined;
let availableModels: ModelSelectorEntry[] = [];

function readJson(key: string): unknown {
  try { return JSON.parse(appStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function readRecord(key: string): Record<string, unknown> {
  const value = readJson(key);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readSavedModelEntries(): ModelSelectorEntry[] {
  return normalizeModelSelectorEntries(readJson(MODEL_SELECTOR_STORAGE_KEY), readJson(MODEL_CATALOG_STORAGE_KEY));
}

export function isModelCatalogStorageKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(DISCOVERED_MODELS_PREFIX);
}

const configuredBaseURL = (provider: MainAgentProvider) =>
  normalizeProviderBaseURL(provider, readRecord(PROVIDER_BASE_URLS_STORAGE_KEY)[provider]);

function readDiscoveredModelIds(provider: MainAgentProvider, baseURL = configuredBaseURL(provider)): string[] | null {
  const catalog = readRecord(catalogKey(provider));
  if (catalog.baseURL !== baseURL || !Array.isArray(catalog.models)) return null;
  return catalog.models.filter((id): id is string => typeof id === 'string');
}

export function hasDiscoveredModelCatalog(provider: MainAgentProvider): boolean {
  return readDiscoveredModelIds(provider) !== null;
}

export function readAvailableModelEntries(): ModelSelectorEntry[] {
  const sources = modelSources.map(key => appStorage.getItem(key));
  if (previousSources && sources.every((value, index) => value === previousSources?.[index])) return availableModels;
  const providerKeys = readRecord(API_KEY_PRESENCE_STORAGE_KEY);
  const modelKeys = readRecord(MODEL_API_KEY_PRESENCE_STORAGE_KEY);
  const baseURLs = readRecord(PROVIDER_BASE_URLS_STORAGE_KEY);
  const discoveredProviders = new Set<MainAgentProvider>();
  const discovered = MODEL_PROVIDER_ORDER.flatMap(provider => {
    if (!providerKeys[provider] && !isLocalModelProvider(provider)) return [];
    const ids = readDiscoveredModelIds(provider, normalizeProviderBaseURL(provider, baseURLs[provider]));
    if (!ids) return [];
    discoveredProviders.add(provider);
    return ids.map(modelId => ({ provider, modelId }));
  });
  const seen = new Set(discovered.map(entry => modelEntryKey(entry.provider, entry.modelId)));
  const scopedEntries = Object.keys(modelKeys).flatMap(key => {
    const entry = modelKeys[key] ? parseModelEntryKey(key) : null;
    return entry ? [entry] : [];
  });
  const fallback = [...readSavedModelEntries(), ...scopedEntries].filter(entry => {
    const key = modelEntryKey(entry.provider, entry.modelId);
    if (seen.has(key)) return false;
    if (!isAccountModelProvider(entry.provider) && !modelKeys[key]
      && (discoveredProviders.has(entry.provider) || (!providerKeys[entry.provider] && !isLocalModelProvider(entry.provider)))) return false;
    seen.add(key);
    return true;
  });
  previousSources = sources;
  availableModels = [...discovered, ...fallback];
  return availableModels;
}

export function invalidateProviderModelCatalog(provider: string): void {
  if (!isModelProvider(provider) || isAccountModelProvider(provider)) return;
  pending.delete(provider);
  nextRefresh.delete(provider);
  if (appStorage.getItem(catalogKey(provider)) !== null) appStorage.removeItem(catalogKey(provider));
}

function replaceProviderMetadata(key: string, provider: MainAgentProvider) {
  return Object.fromEntries(Object.entries(readRecord(key)).filter(([id]) => !id.startsWith(provider + ':')));
}

/** Refresh provider-wide catalogs. A failed request keeps the last usable catalog. */
export async function refreshSavedModelCatalog(providers: readonly MainAgentProvider[] = MODEL_PROVIDER_ORDER): Promise<void> {
  await appStorageReady;
  const providerKeys = readRecord(API_KEY_PRESENCE_STORAGE_KEY);
  await Promise.all(providers.map(provider => {
    if (isAccountModelProvider(provider) || (!providerKeys[provider] && !isLocalModelProvider(provider))) return;
    const active = pending.get(provider);
    if (active) return active;
    if ((nextRefresh.get(provider) || 0) > Date.now()) return;

    const baseURL = configuredBaseURL(provider);
    const operation: Promise<void> = requestJson('/api/settings/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: [provider], providerKeysOnly: true, expectedBaseURL: baseURL }),
    }, 45_000).then(async response => {
      if (!response.ok) return;
      const result = (await response.json())?.providers?.[provider];
      if (pending.get(provider) !== operation || configuredBaseURL(provider) !== baseURL) return;
      if (!isLocalModelProvider(provider) && !readRecord(API_KEY_PRESENCE_STORAGE_KEY)[provider]) return;
      if (result?.connected !== true || result?.source !== 'live' || !Array.isArray(result.models)) return;

      const entries = normalizeModelSelectorEntries(result.models.map((model: { id?: unknown }) => ({ provider, modelId: model?.id })));
      const available = new Set(entries.map(entry => entry.modelId));
      const thinking = replaceProviderMetadata(MODEL_THINKING_CAPABILITIES_STORAGE_KEY, provider);
      const wire = replaceProviderMetadata(MODEL_WIRE_CAPABILITIES_STORAGE_KEY, provider);
      const windows = replaceProviderMetadata(MODEL_CONTEXT_WINDOWS_STORAGE_KEY, provider);
      for (const model of result.models) {
        if (!available.has(model?.id)) continue;
        const key = modelEntryKey(provider, model.id);
        const capability = normalizeModelThinkingCapabilities(model.thinking);
        if (capability) thinking[key] = capability;
        if (Array.isArray(model.capabilities)) wire[key] = model.capabilities.map(String);
        const limit = Number(model.inputTokenLimit || model.contextLength || 0);
        if (Number.isFinite(limit) && limit > 0) windows[key] = Math.floor(limit);
      }
      appStorage.setItems({
        [catalogKey(provider)]: JSON.stringify({ baseURL, models: entries.map(entry => entry.modelId) }),
        [MODEL_THINKING_CAPABILITIES_STORAGE_KEY]: JSON.stringify(thinking),
        [MODEL_WIRE_CAPABILITIES_STORAGE_KEY]: JSON.stringify(wire),
        [MODEL_CONTEXT_WINDOWS_STORAGE_KEY]: JSON.stringify(windows),
      });
    }).catch(() => undefined).finally(() => {
      if (pending.get(provider) !== operation) return;
      pending.delete(provider);
      if (configuredBaseURL(provider) === baseURL) nextRefresh.set(provider, Date.now() + MODEL_CATALOG_REFRESH_MS);
    });
    pending.set(provider, operation);
    return operation;
  }));
}
