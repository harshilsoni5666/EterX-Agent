export type SubAgentRuntimeSettings = {
  enabled: boolean;
  maxSubAgents: number;
  maxRetries: number;
};

// Keep the user-facing control and every server-side entry point on the same
// bounded contract. Without a hard ceiling, stale or hand-edited local
// settings could ask one turn to fan out an unbounded number of providers.
export const MAX_SUB_AGENTS = 20;

export const DEFAULT_SUB_AGENT_RUNTIME_SETTINGS: SubAgentRuntimeSettings = {
  // Delegation is opt-in. A missing or stale settings object must never make a
  // normal Main-agent turn acquire background-worker authority by accident.
  enabled: false,
  maxSubAgents: 5,
  maxRetries: 2,
};

/** Normalize the persisted Settings-panel values at the execution boundary. */
export function normalizeSubAgentRuntimeSettings(value: unknown): SubAgentRuntimeSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawLimit = Number(input.maxSubAgents);
  const rawRetries = Number(input.maxRetries);
  const enabled = typeof input.autoSubAgents === 'boolean'
    ? input.autoSubAgents
    : typeof input.enabled === 'boolean'
      ? input.enabled
      : DEFAULT_SUB_AGENT_RUNTIME_SETTINGS.enabled;
  return {
    enabled,
    maxSubAgents: Number.isFinite(rawLimit)
      ? Math.min(MAX_SUB_AGENTS, Math.max(1, Math.floor(rawLimit)))
      : DEFAULT_SUB_AGENT_RUNTIME_SETTINGS.maxSubAgents,
    maxRetries: Number.isFinite(rawRetries)
      ? Math.max(0, Math.min(5, Math.floor(rawRetries)))
      : DEFAULT_SUB_AGENT_RUNTIME_SETTINGS.maxRetries,
  };
}

/** Build the pinned execution fields sent to the server for a new run. */
export function buildSubAgentPinnedContext(settings: SubAgentRuntimeSettings): Record<string, unknown> {
  return {
    disableSubAgents: !settings.enabled,
    allowAgentSpawning: settings.enabled,
    maxSubAgents: settings.maxSubAgents,
    maxRetries: settings.maxRetries,
  };
}
