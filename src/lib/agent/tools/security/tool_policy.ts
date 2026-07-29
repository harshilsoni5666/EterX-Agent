import type { ToolDefinition } from '../../schemas';
import { SANDBOX_BLOCKED_TOOLS, SANDBOX_ALLOWED_CAPABILITIES } from '../../../sandbox/sandbox-guard';

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
];

const CAPABILITY_BY_TOOL: Record<string, string> = {
  api_caller: 'network.public',
  smart_api_hub: 'network.public',
  web_scraper: 'network.public',
  rss_feed_reader: 'network.public',
  deep_research: 'network.public',
  web_search: 'network.public',
  image_asset_search: 'network.public',
  image_generator: 'network.public',
  network_tools: 'network.public',
  youtube_transcript: 'network.public',
  http_server: 'network.listen',

  background_task: 'command.raw',
  process_manager: 'command.raw',
  workspace_run_command: 'command.workspace',
  workspace_verify_code: 'command.workspace',
  code_execution_js: 'code.dynamic',
  spawn_sub_agent: 'agent.spawn',
  create_dynamic_tool: 'code.dynamic',
  run_macro: 'tool.utility',

  browser_control: 'browser.control',
  desktop_control: 'host.control',
  screen_agent: 'host.control',
  computer: 'host.control',
  clipboard_manager: 'host.clipboard',
  screenshot_capture: 'host.screenshot',
  system_automation: 'host.system',
  desktop_notification: 'host.notification',
  system_monitor: 'host.system',
  text_to_speech: 'host.audio',

  slack_controller: 'communication.external',
  telegram_user_controller: 'communication.external',
  whatsapp_controller: 'communication.external',
  email_manager: 'communication.external',

  api_key_vault: 'secrets.manage',
  env_manager: 'secrets.manage',
  memory_v2: 'memory.manage',

  file_watcher: 'filesystem.watch',
  file_compression: 'filesystem.write',
  docx_generator: 'filesystem.write',
  office_artifact_builder: 'filesystem.write',
  local_database: 'filesystem.write',
};

const DEFAULT_ALLOWED_CAPABILITIES = new Set([
  'command.workspace',
  'filesystem.read',
  'filesystem.write',
  'memory.manage',
  'tool.utility',
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
