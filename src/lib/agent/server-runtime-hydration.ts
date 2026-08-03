import { readStoredRuntimeSettings } from './runtime-settings-store';
import {
  applyRuntimeApiKeys,
  applyRuntimeModelOverrides,
} from './runtime-api-keys';
import { applyRuntimeProviderBaseURLs } from './provider-runtime';

const runtimeHydrationGlobal = globalThis as typeof globalThis & {
  __eterxServerRuntimeSettingsHydrated?: boolean;
};

/**
 * Rehydrate AppData-backed credentials, model overrides, and endpoints only
 * from server entry points. This module must never be imported by client UI
 * code because runtime-settings-store uses node:crypto and filesystem APIs.
 */
export function hydrateServerRuntimeSettings(): void {
  if (runtimeHydrationGlobal.__eterxServerRuntimeSettingsHydrated) return;
  runtimeHydrationGlobal.__eterxServerRuntimeSettingsHydrated = true;
  try {
    const stored = readStoredRuntimeSettings();
    if (stored.apiKeys && Object.keys(stored.apiKeys).length > 0) {
      applyRuntimeApiKeys(stored.apiKeys);
    }
    if (stored.modelOverrides && Object.keys(stored.modelOverrides).length > 0) {
      applyRuntimeModelOverrides(stored.modelOverrides);
    }
    if (stored.baseURLs && Object.keys(stored.baseURLs).length > 0) {
      applyRuntimeProviderBaseURLs(stored.baseURLs);
    }
  } catch (error) {
    console.warn('[EterX] Could not hydrate persisted runtime settings:', error instanceof Error ? error.message : error);
  }
}
