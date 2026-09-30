import { CODING_MODES } from '../code/coding-modes';

export const BUILTIN_AGENT_MODES = [
  ...CODING_MODES.map(mode => ({ id: mode.id, label: mode.label, description: mode.description })),
  { id: 'general', label: 'General', description: 'Everyday tasks with the shared agent tool library.' },
  { id: 'chat', label: 'Chat', description: 'Direct conversation with optional web search.' },
] as const;

export type BuiltinAgentId = 'coding-lite' | 'coding-heavy' | 'general' | 'chat';
export type AgentToolSettings = Partial<Record<BuiltinAgentId, Record<string, boolean>>>;
export type AgentToolCatalogEntry = { name: string; label: string; description: string; category: string };
export type AgentToolSettingsResponse = {
  settings: AgentToolSettings;
  tools: AgentToolCatalogEntry[];
  defaults: Record<BuiltinAgentId, string[]>;
};

export function isBuiltinAgentId(value: unknown): value is BuiltinAgentId {
  return BUILTIN_AGENT_MODES.some(mode => mode.id === value);
}

export function normalizeAgentToolSettings(value: unknown): AgentToolSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: AgentToolSettings = {};
  for (const { id } of BUILTIN_AGENT_MODES) {
    const entry = (value as Record<string, unknown>)[id];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    result[id] = Object.fromEntries(Object.entries(entry).filter(([name, enabled]) =>
      /^[a-zA-Z0-9_-]{1,128}$/.test(name) && typeof enabled === 'boolean',
    )) as Record<string, boolean>;
  }
  return result;
}
