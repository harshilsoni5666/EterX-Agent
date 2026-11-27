'use client';

import { appStorage } from './client-storage';
import { parseModelEntryKey } from './agent/model-selector-store';

const key = (agentId: string) => 'eterx-agent-model:' + agentId;

export function readAgentModelPreference(agentId: string) {
  const value = appStorage.getItem(key(agentId));
  return value && parseModelEntryKey(value) ? value : undefined;
}

export function saveAgentModelPreference(agentId: string, value: string) {
  if (parseModelEntryKey(value)) appStorage.setItem(key(agentId), value);
  else appStorage.removeItem(key(agentId));
}
