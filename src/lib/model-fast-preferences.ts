'use client';

import { codexModelFastAccount } from './chatgpt-subscription-client';
import { appStorage } from './client-storage';
import { parseModelEntryKey } from './agent/model-selector-store';
import { codexFastRequest, isNativeOpenAiEndpoint, isOpenAiFastModel, openAiFastRequest } from './agent/model-fast-mode';

export const MODEL_FAST_PREFERENCES_KEY = 'eterx_model_fast_preferences';

function preferenceFor(selection: string): string | null {
  const model = parseModelEntryKey(selection);
  if (!model) return null;
  if (model.provider === 'codex') {
    const account = codexModelFastAccount(model.modelId);
    return account ? codexFastRequest(model.modelId, account) : null;
  }
  if (model.provider !== 'openai' || !isOpenAiFastModel(model.modelId)) return null;
  try {
    const settings = JSON.parse(appStorage.getItem('eterx_provider_base_urls') || '{}');
    const url = typeof settings?.openai === 'string' ? settings.openai.trim() : '';
    return !url || isNativeOpenAiEndpoint(url) ? openAiFastRequest(model.modelId) : null;
  } catch {
    return null;
  }
}

function readPreferences(): Set<string> {
  try {
    const saved = JSON.parse(appStorage.getItem(MODEL_FAST_PREFERENCES_KEY) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

export function getModelFastMode(selection: string): boolean | null {
  const preference = preferenceFor(selection);
  return preference ? readPreferences().has(preference) : null;
}

export function readModelFastRequest(selection: string): string | null {
  const preference = preferenceFor(selection);
  return preference && readPreferences().has(preference) ? preference : null;
}

export function setModelFastMode(selection: string, enabled: boolean): boolean {
  const preference = preferenceFor(selection);
  if (!preference) return false;
  const saved = readPreferences();
  if (enabled) saved.add(preference);
  else saved.delete(preference);
  appStorage.setItem(MODEL_FAST_PREFERENCES_KEY, JSON.stringify([...saved]));
  return true;
}
