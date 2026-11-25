'use client';

import { useSyncExternalStore } from 'react';
import { isConcreteModelId, modelEntryKey, type ModelSelectorEntry } from './agent/model-selector-store';
import type { MainAgentThinkingLevel, ModelThinkingCapabilities } from './agent/model-routing';

type ChatGptModel = {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  imageInput: boolean | null;
  fast: boolean;
};

type ConnectionStatus = 'disconnected' | 'consent-required' | 'connected';

export type ChatGptAccount = {
  id: string;
  label: string;
  email: string | null;
  status: ConnectionStatus | 'pending';
};

export type ChatGptObservedUsage = {
  status: 'completed' | 'plan-limit' | 'rate-limited' | 'unavailable' | 'ineligible';
  observedAt: number;
};
export type ChatGptSwitchMode = 'idle' | 'stop' | 'resume';

type ChatGptSubscriptionState = {
  available: boolean;
  status: ConnectionStatus;
  accounts: ChatGptAccount[];
  activeAccountId: string | null;
  authorizing: boolean;
  authorizingAccountId: string | null;
  canCancel: boolean;
  accountAction: 'switching' | 'disconnecting' | 'removing' | null;
  models: ChatGptModel[];
  catalogReady: boolean;
  catalogRevision: number;
  refreshing: boolean;
  catalogError: string | null;
  usage: ChatGptObservedUsage | null;
  planWelcomePending: boolean;
  error: string | null;
};

type DesktopSubscription = {
  getState: () => Promise<ChatGptSubscriptionState | null>;
  signIn: (profileId?: string) => Promise<ChatGptSubscriptionState | null>;
  cancel: () => Promise<ChatGptSubscriptionState | null>;
  refreshModels: () => Promise<ChatGptSubscriptionState | null>;
  switchAccount: (profileId: string, mode?: ChatGptSwitchMode) => Promise<{ state: ChatGptSubscriptionState; activeWork: number } | null>;
  removeAccount: (profileId: string) => Promise<ChatGptSubscriptionState | null>;
  disconnect: (profileId: string) => Promise<ChatGptSubscriptionState | null>;
  disconnectAll: () => Promise<ChatGptSubscriptionState | null>;
  dismissPlanWelcome: () => Promise<ChatGptSubscriptionState | null>;
  onChange: (listener: (value: ChatGptSubscriptionState) => void) => () => void;
};

const listeners = new Set<() => void>();
let snapshot: ChatGptSubscriptionState | null = null;
const unavailable: ChatGptSubscriptionState = {
  available: false, status: 'disconnected', accounts: [], activeAccountId: null, authorizing: false,
  authorizingAccountId: null, canCancel: false, accountAction: null, models: [], catalogReady: false,
  catalogRevision: 0, refreshing: false, catalogError: null, usage: null, planWelcomePending: false, error: null,
};

export function getDesktopSubscription(): DesktopSubscription | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: { chatGptSubscription?: DesktopSubscription } }).electronAPI?.chatGptSubscription;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useChatGptSubscription() {
  return useSyncExternalStore(subscribe, () => snapshot, () => null);
}

export function watchChatGptSubscription() {
  const api = getDesktopSubscription();
  if (!api) return;
  let active = true;
  let heardUpdate = false;
  const update = (state: ChatGptSubscriptionState | null) => {
    if (!active) return;
    const previous = snapshot;
    snapshot = state || unavailable;
    for (const listener of listeners) listener();
    if (!previous || previous.available !== snapshot.available || previous.status !== snapshot.status
      || previous.activeAccountId !== snapshot.activeAccountId || previous.catalogRevision !== snapshot.catalogRevision
      || previous.authorizing !== snapshot.authorizing || previous.refreshing !== snapshot.refreshing
      || previous.catalogError !== snapshot.catalogError) {
      window.dispatchEvent(new CustomEvent('eterx-settings-updated', { detail: { type: 'chatgpt-subscription-updated' } }));
    }
  };
  const unsubscribe = api.onChange(state => {
    heardUpdate = true;
    update(state);
  });
  void api.getState().then(
    state => { if (!heardUpdate) update(state); },
    () => { if (!heardUpdate) update(unavailable); },
  );
  return () => { active = false; unsubscribe(); };
}

const currentModels = () => snapshot?.available && snapshot.status === 'connected' ? snapshot.models : [];

export function withCodexSubscriptionModels(entries: ModelSelectorEntry[]): ModelSelectorEntry[] {
  return [
    ...entries.filter(entry => entry.provider !== 'codex'),
    ...currentModels().filter(model => isConcreteModelId(model.id)).map(model => ({ provider: 'codex' as const, modelId: model.id })),
  ];
}

export function codexModelIsAvailable(modelId: string): boolean {
  return currentModels().some(model => model.id === modelId);
}

export function codexCatalogPending(): boolean {
  if (!getDesktopSubscription()) return false;
  if (!snapshot) return true;
  if (!snapshot.available) return false;
  if (snapshot.status !== 'connected') return snapshot.authorizing;
  return !snapshot.models.length && (!snapshot.catalogReady || snapshot.refreshing || Boolean(snapshot.catalogError));
}

export function codexModelLabel(modelId: string): string | undefined {
  return currentModels().find(model => model.id === modelId)?.label;
}

export function codexModelFastAccount(modelId: string): string | null {
  return currentModels().some(model => model.id === modelId && model.fast) ? snapshot?.activeAccountId ?? null : null;
}

const EFFORTS: Partial<Record<string, MainAgentThinkingLevel>> = {
  none: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
};

export function codexModelThinking(modelId: string): ModelThinkingCapabilities | null {
  const model = currentModels().find(candidate => candidate.id === modelId);
  if (!model) return null;
  const wireValues: ModelThinkingCapabilities['wireValues'] = {};
  for (const effort of model.efforts) {
    const level = Object.hasOwn(EFFORTS, effort) ? EFFORTS[effort] : undefined;
    if (level) wireValues[level] = effort;
  }
  const defaultEffort = model.defaultEffort;
  return {
    provider: 'codex', modelId, source: 'provider', kind: 'effort',
    parameter: 'reasoning_effort', wireValues,
    levels: Object.keys(wireValues) as MainAgentThinkingLevel[],
    defaultLevel: defaultEffort && Object.hasOwn(EFFORTS, defaultEffort) ? EFFORTS[defaultEffort] : undefined,
  };
}

export function codexThinkingCatalog(): Record<string, ModelThinkingCapabilities> {
  const capabilities: Record<string, ModelThinkingCapabilities> = {};
  for (const model of currentModels()) {
    const thinking = codexModelThinking(model.id);
    if (thinking) capabilities[modelEntryKey('codex', model.id)] = thinking;
  }
  return capabilities;
}

export function codexModelWireCapabilities(modelId: string): string[] {
  const imageInput = currentModels().find(model => model.id === modelId)?.imageInput;
  return typeof imageInput === 'boolean' ? ['api:responses', `image-input:${imageInput}`] : ['api:responses'];
}
