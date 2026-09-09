import type { ToolDefinition } from '../../schemas';
import { SANDBOX_BLOCKED_TOOLS, SANDBOX_ALLOWED_CAPABILITIES } from '../../../sandbox/sandbox-guard';
import { getCodingMode } from '../../../code/coding-modes';

export type ToolCapabilityDecision = {
  allowed: boolean;
  reason?: string;
  capability?: string;
};

const QUARANTINED_TOOLS = new Set<string>([
]);

export const DEFAULT_MAIN_AGENT_ALLOWED_CAPABILITIES = [
  'command.workspace',
  'filesystem.read',
  'filesystem.write',
  'memory.manage',
  'tool.utility',
  'network.public',
  'browser.control',
  'agent.spawn',
  'code.dynamic',
  'communication.connected',
];

const CAPABILITY_BY_TOOL: Record<string, string> = {
  context_memory: 'memory.manage',
  web_search: 'network.public',
  image_asset_search: 'network.public',
  image_generator: 'network.public',
  video_generator: 'network.public',

  workspace_run_command: 'command.workspace',
  spawn_sub_agent: 'agent.spawn',

  browser_control: 'browser.control',
  screen_agent: 'host.control',
  computer: 'host.control',
  screenshot_capture: 'host.screenshot',
  desktop_notification: 'host.notification',

  channel_agent: 'communication.connected',
  gateway_bridge: 'communication.connected',
  connector_mcp: 'communication.connected',
};

const DEFAULT_ALLOWED_CAPABILITIES = new Set([
  'command.workspace',
  'filesystem.read',
  'filesystem.write',
  'memory.manage',
  'tool.utility',
  'communication.connected',
]);

export function validateToolInput(
  tool: ToolDefinition,
  args: any,
): { success: true; args: any } | { success: false; error: string } {
  const schema: any = tool.inputSchema;
  if (!schema || typeof schema.safeParse !== 'function') {
    return { success: true, args };
  }

  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) {
    return { success: true, args: parsed.data };
  }

  const details = parsed.error?.issues
    ?.slice(0, 5)
    .map((issue: any) => `${issue.path?.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  return {
    success: false,
    error: `Invalid arguments for ${tool.name}: ${details || parsed.error?.message || 'schema validation failed'}`,
  };
}

export function enforceToolCapability(
  toolName: string,
  _args: any,
  context?: any,
): ToolCapabilityDecision {
  const codingMode = !context?.isUserProxy && getCodingMode(context?.agentProfile);
  if (codingMode && !(codingMode.tools as readonly string[]).includes(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is not available in ${codingMode.label}. Use this run's declared tools; a different agent selection takes effect on a later turn.`,
    };
  }
  // ── Sandbox enforcement (ONLY when sandbox mode is active) ──
  if (context?.runLocation === 'sandbox') {
    if (SANDBOX_BLOCKED_TOOLS.has(toolName)) {
      return {
        allowed: false,
        capability: 'sandbox.blocked',
        reason: `🔒 Sandbox: Tool "${toolName}" is disabled in sandbox mode. Use workspace_run_command for shell operations.`,
      };
    }

    const capability = CAPABILITY_BY_TOOL[toolName] || inferCapability(toolName);
    if (!SANDBOX_ALLOWED_CAPABILITIES.has(capability)) {
      return {
        allowed: false,
        capability,
          reason: `🔒 Sandbox: Capability "${capability}" required by "${toolName}" is not available in sandbox mode.`,
      };
    }
  }

  const capability = CAPABILITY_BY_TOOL[toolName] || inferCapability(toolName);

  if (QUARANTINED_TOOLS.has(toolName) && !isQuarantineOverrideEnabled(context)) {
    return {
      allowed: false,
      capability,
      reason: `Tool ${toolName} is quarantined pending security review`,
    };
  }

  if (isCapabilityAllowed(capability, context)) {
    return { allowed: true, capability };
  }

  return {
    allowed: false,
    capability,
    reason: `Tool ${toolName} requires capability "${capability}"`,
  };
}

function inferCapability(toolName: string): string {
  if (toolName.startsWith('workspace_')) return 'filesystem.write';
  if (toolName.includes('network')) return 'network.public';
  if (toolName.includes('search') || toolName.includes('scraper') || toolName.includes('rss')) return 'network.public';
  return 'tool.utility';
}

function isCapabilityAllowed(capability: string, context?: any): boolean {
  if (context?.allowUnsafeTools === true || process.env.ETERX_ALLOW_UNSAFE_TOOLS === '1') return true;

  if (capability.startsWith('network.') && context?.networkPolicy === 'deny' && context?.allowNetwork !== true) {
    return false;
  }

  const configured = new Set<string>([
    ...DEFAULT_ALLOWED_CAPABILITIES,
    ...readStringList(context?.allowedCapabilities),
    ...readStringList(context?.toolPolicy?.allowedCapabilities),
  ]);

  if (configured.has(capability)) return true;

  if (capability.startsWith('network.') && (context?.allowNetwork === true || context?.networkPolicy === 'allow')) {
    return true;
  }

  if (capability.startsWith('host.') && context?.allowHostControl === true) return true;
  if (capability.startsWith('communication.') && context?.allowExternalCommunication === true) return true;
  if (capability.startsWith('automation.') && context?.allowAutomation === true) return true;
  if (capability.startsWith('agent.') && context?.allowAgentSpawning === true) return true;
  if (capability === 'command.raw' && context?.allowRawCommand === true) return true;
  if (capability === 'code.dynamic' && context?.allowDynamicCode === true) return true;
  if (capability === 'browser.control' && context?.allowBrowserControl === true) return true;
  if (capability === 'secrets.manage' && context?.allowSecretManagement === true) return true;
  if (capability === 'vcs.local' && context?.allowVcs === true) return true;

  return false;
}

function isQuarantineOverrideEnabled(context?: any): boolean {
  return context?.allowQuarantinedTools === true || process.env.ETERX_ALLOW_QUARANTINED_TOOLS === '1';
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(/[,\n]/).map(v => v.trim()).filter(Boolean);
}
