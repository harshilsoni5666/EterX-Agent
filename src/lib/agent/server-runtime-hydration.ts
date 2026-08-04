import {
  getStoredRuntimeSettingsRevision,
  readStoredRuntimeSettings,
} from './runtime-settings-store';
import {
  applyRuntimeApiKeys,
  applyRuntimeModelOverrides,
} from './runtime-api-keys';
import { applyRuntimeProviderBaseURLs } from './provider-runtime';
import { applyRuntimeSearchSettings } from '../search/search-runtime';
import { applyRuntimeImageSettings } from '../image/image-generation-runtime';
import { applyRuntimeVideoSettings } from '../video/video-generation-runtime';

const runtimeHydrationGlobal = globalThis as typeof globalThis & {
  __eterxServerRuntimeSettingsRevision?: string;
};

/**
 * Rehydrate AppData-backed credentials, model overrides, and endpoints only
 * from server entry points. This module must never be imported by client UI
 * code because runtime-settings-store uses node:crypto and filesystem APIs.
 */
export function hydrateServerRuntimeSettings(): void {
  const revision = getStoredRuntimeSettingsRevision();
  if (runtimeHydrationGlobal.__eterxServerRuntimeSettingsRevision === revision) return;
  try {
    const stored = readStoredRuntimeSettings();
    const hydratedApiKeys: Record<string, string | string[]> = { ...(stored.apiKeys || {}) };
    // A model-specific key is stored separately so the renderer can keep its
    // provider/model mapping, but the server runtime still needs the provider
    // pool before the Settings panel has mounted after an app restart.
    for (const [modelKey, value] of Object.entries(stored.modelApiKeys || {})) {
      if (typeof value !== 'string') continue;
      const separator = modelKey.indexOf(':');
      if (separator <= 0) continue;
      const provider = modelKey.slice(0, separator);
      const current = hydratedApiKeys[provider];
      const values = Array.isArray(current) ? current : current ? [current] : [];
      hydratedApiKeys[provider] = [...values, value];
    }
    if (Object.keys(hydratedApiKeys).length > 0) {
      applyRuntimeApiKeys(hydratedApiKeys);
    }
    if (stored.modelOverrides && Object.keys(stored.modelOverrides).length > 0) {
      applyRuntimeModelOverrides(stored.modelOverrides);
    }
    if (stored.baseURLs && Object.keys(stored.baseURLs).length > 0) {
      applyRuntimeProviderBaseURLs(stored.baseURLs);
    }
    if (stored.search) {
      applyRuntimeSearchSettings(stored.search, stored.apiKeys?.tavily);
    }
    if (stored.image) {
      applyRuntimeImageSettings(stored.image);
    }
    if (stored.video) {
      applyRuntimeVideoSettings(stored.video);
    }
    runtimeHydrationGlobal.__eterxServerRuntimeSettingsRevision = revision;
  } catch (error) {
    console.warn('[EterX] Could not hydrate persisted runtime settings:', error instanceof Error ? error.message : error);
  }
}
