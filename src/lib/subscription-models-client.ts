'use client';

import { desktopAntigravity, readAntigravityState } from './antigravity-client';
import { isAccountModelProvider, isConcreteModelId, modelEntryKey, type ModelSelectorEntry } from './agent/model-selector-store';
import { desktopNativeProvider, readNativeProviders } from './native-provider-client';
import { isNativeProvider, NATIVE_PROVIDERS, type NativeProvider } from './native-provider-contract';
import {
  codexCatalogPending, codexModelIsAvailable, codexModelLabel, codexModelThinking, codexModelWireCapabilities,
  codexThinkingCatalog, withCodexSubscriptionModels,
} from './chatgpt-subscription-client';

const antigravityModels = () => {
  const state = readAntigravityState();
  return state?.supported && state.connected ? state.models : [];
};
const nativeModels = (provider: NativeProvider) => readNativeProviders()?.providers[provider]?.models ?? [];

export function withSubscriptionModels(entries: ModelSelectorEntry[]): ModelSelectorEntry[] {
  return [
    ...withCodexSubscriptionModels(entries.filter(entry => !isAccountModelProvider(entry.provider) || entry.provider === 'codex')),
    ...antigravityModels().filter(model => isConcreteModelId(model.id)).map(model => ({ provider: 'antigravity' as const, modelId: model.id })),
    ...NATIVE_PROVIDERS.flatMap(provider => nativeModels(provider).map(model => ({ provider, modelId: model.id }))),
  ];
}

export function subscriptionCatalogPending(provider: string | undefined): boolean {
  if (provider === 'codex') return codexCatalogPending();
  if (isNativeProvider(provider)) {
    if (!desktopNativeProvider()) return false;
    const state = readNativeProviders()?.providers[provider];
    return !state || (!state.models.length && (state.activity === 'sign-in' || state.activity === 'refresh'));
  }
  if (provider !== 'antigravity' || !desktopAntigravity()) return false;
  const state = readAntigravityState();
  return !state || (!state.models.length && (state.activity === 'signing-in' || state.activity === 'refreshing' || state.activity === 'switching'));
}

export function subscriptionModelAvailable(provider: string, model: string): boolean {
  if (isNativeProvider(provider)) return nativeModels(provider).some(entry => entry.id === model);
  return provider === 'codex' ? codexModelIsAvailable(model)
    : provider === 'antigravity' && antigravityModels().some(entry => entry.id === model);
}

export function subscriptionModelLabel(provider: string, model: string) {
  if (provider === 'codex') return codexModelLabel(model);
  if (provider === 'antigravity') return antigravityModels().find(entry => entry.id === model)?.label;
  if (isNativeProvider(provider)) return nativeModels(provider).find(entry => entry.id === model)?.label;
}

export function subscriptionModelThinking(provider: string, model: string) {
  if (provider === 'codex') return codexModelThinking(model);
  if (provider === 'antigravity') return antigravityModels().find(entry => entry.id === model)?.thinking ?? null;
  if (isNativeProvider(provider)) return nativeModels(provider).find(entry => entry.id === model)?.thinking ?? null;
  return null;
}

export function subscriptionThinkingCatalog() {
  const catalog = codexThinkingCatalog();
  for (const model of antigravityModels()) {
    if (model.thinking) catalog[modelEntryKey('antigravity', model.id)] = model.thinking;
  }
  for (const provider of NATIVE_PROVIDERS) for (const model of nativeModels(provider)) {
    if (model.thinking) catalog[modelEntryKey(provider, model.id)] = model.thinking;
  }
  return catalog;
}

export function subscriptionModelWireCapabilities(provider: string, model: string): string[] {
  if (provider === 'codex') return codexModelWireCapabilities(model);
  if (isNativeProvider(provider)) return nativeModels(provider).find(entry => entry.id === model)?.capabilities ?? [];
  if (provider !== 'antigravity') return [];
  const capabilities = antigravityModels().find(entry => entry.id === model)?.capabilities ?? readAntigravityState()?.capabilities;
  return [`image-input:${capabilities?.image === true}`, `audio-input:${capabilities?.audio === true}`,
    `embedded-context:${capabilities?.embeddedContext === true}`];
}
