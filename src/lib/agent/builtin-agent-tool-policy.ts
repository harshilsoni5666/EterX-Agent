import { getCodingMode } from '../code/coding-modes';
import { getStoredRuntimeSettingsRevision, readStoredRuntimeSettings } from './runtime-settings-store';
import type { AgentToolSettings, BuiltinAgentId } from './builtin-agent-settings';

let cachedRevision = '';
let cachedSettings: AgentToolSettings = {};
let cachedComputerUse: boolean | undefined;

export function readAgentToolSettings(): AgentToolSettings {
  const revision = getStoredRuntimeSettingsRevision();
  if (revision !== cachedRevision) {
    const stored = readStoredRuntimeSettings();
    cachedSettings = stored.agentTools || {};
    cachedComputerUse = stored.computerUse;
    cachedRevision = revision;
  }
  return cachedSettings;
}

export function isComputerUseDisabled(): boolean {
  readAgentToolSettings();
  return cachedComputerUse === false;
}

export function isBuiltinToolEnabled(agent: BuiltinAgentId, name: string): boolean {
  if (agent === 'chat' && name !== 'web_search') return false;
  const override = readAgentToolSettings()[agent]?.[name];
  if (typeof override === 'boolean') return override;
  const coding = getCodingMode(agent);
  return coding ? (coding.tools as readonly string[]).includes(name) : true;
}

/** Keep custom agents, builders, supervisors and specialist runtimes isolated. */
export function builtinAgentForContext(context: any): BuiltinAgentId | null {
  if (!context || context.isUserProxy || context.customAgentId
    || context.agentRuntime === 'agent_builder'
    || String(context.projectId || '').startsWith('agent_builder_')
    || context.subAgentId || context.isSubAgent) return null;
  return getCodingMode(context.agentProfile)?.id || 'general';
}

export function isConfiguredToolAllowed(name: string, context: any): boolean {
  const agent = builtinAgentForContext(context);
  return !agent || isBuiltinToolEnabled(agent, name);
}
