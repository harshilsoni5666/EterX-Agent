import type { AntigravityModel } from '../../antigravity-contract';
import { normalizeModelThinkingCapabilities, type MainAgentThinkingLevel } from '../model-routing';
import { isConcreteModelId } from '../model-selector-store';
import type { AntigravityAcpClient } from './acp';

export function configOptions(result: any): any[] {
  return Array.isArray(result?.configOptions) ? result.configOptions : [];
}

const selectOptions = (option: any): Array<{ value: string; name?: string }> =>
  (Array.isArray(option?.options) ? option.options : [])
    .flatMap((entry: any) => Array.isArray(entry?.options) ? entry.options : [entry])
    .filter((entry: any) => typeof entry?.value === 'string');

export const modelOption = (result: any) => configOptions(result).find(option => option?.category === 'model' || option?.id === 'model');
export const thinkingOption = (result: any) => configOptions(result).find(option => option?.category === 'thought_level' || option?.id === 'thought_level');

export function sessionModels(result: any): AntigravityModel[] {
  const config = modelOption(result);
  const offered = config ? selectOptions(config).map(option => ({ id: option.value, label: option.name }))
    : (Array.isArray(result?.models?.availableModels) ? result.models.availableModels : []).map((model: any) => ({ id: model?.modelId, label: model?.name }));
  const models = new Map<string, AntigravityModel>();
  for (const model of offered) {
    if (typeof model.id !== 'string' || !isConcreteModelId(model.id) || model.id.length > 220) continue;
    models.set(model.id, { id: model.id, label: typeof model.label === 'string' ? model.label.slice(0, 200) : model.id, thinking: null });
  }
  return [...models.values()];
}

function thinkingLevel(value: string): MainAgentThinkingLevel | undefined {
  switch (value.trim().toLowerCase().replace(/_/g, '-')) {
    case 'off': case 'none': return 'off';
    case 'minimal': case 'extra-low': return 'minimal';
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'extra-high': case 'xhigh': return 'xhigh';
    case 'max': return 'max';
  }
}

export function modelThinking(result: any, modelId: string) {
  const config = thinkingOption(result);
  if (!config) return null;
  const wireValues: Partial<Record<MainAgentThinkingLevel, string>> = {};
  for (const { value } of selectOptions(config)) {
    const level = thinkingLevel(value);
    if (level) wireValues[level] = value;
  }
  return normalizeModelThinkingCapabilities({
    provider: 'antigravity', modelId, source: 'provider', kind: 'effort', parameter: 'thought_level',
    levels: Object.keys(wireValues), wireValues, defaultLevel: thinkingLevel(String(config.currentValue || '')),
  });
}

export async function selectSessionModel(client: AntigravityAcpClient, session: any, model: string, skipIfCurrent = true) {
  if (!sessionModels(session).some(option => option.id === model)) {
    throw new Error('This model is unavailable for the connected Google account. Refresh Antigravity models in Subscription settings and select an available model.');
  }
  const config = modelOption(session);
  const current = config?.currentValue ?? session?.models?.currentModelId;
  if (skipIfCurrent && model === current) return session;
  if (config) return client.request('session/set_config_option', { sessionId: client.sessionId, configId: config.id, value: model });
  await client.request('session/set_model', { sessionId: client.sessionId, modelId: model });
  return session;
}

export async function setSessionMode(client: AntigravityAcpClient, session: any, mode: 'default' | 'plan') {
  const config = configOptions(session).find(option => option?.category === 'mode' || option?.id === 'mode');
  if (selectOptions(config).some(option => option.value === mode)) {
    if (config.currentValue !== mode) await client.request('session/set_config_option', { sessionId: client.sessionId, configId: config.id, value: mode });
  } else if (session?.modes?.availableModes?.some((option: any) => option.id === mode) && session.modes.currentModeId !== mode) {
    await client.request('session/set_mode', { sessionId: client.sessionId, modeId: mode });
  }
}
