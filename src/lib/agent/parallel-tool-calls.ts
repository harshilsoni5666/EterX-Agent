/**
 * Shared safety rules for deciding which tool calls may start together.
 *
 * Parallel execution is deliberately conservative: read-only calls may share
 * a batch, while writes, process control, browser actions, and user prompts
 * remain ordered so one action cannot observe another action halfway through.
 */

import { isReadOnlyShellCommand } from './shell-command-shape';

export type ParallelToolCallLike = {
  name?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  function?: {
    name?: string;
    arguments?: string;
  };
};

const READ_ONLY_TOOLS = new Set([
  'web_search',
  'get_skill_guidelines',
  'image_asset_search',
  'context_memory',
  'agent_flow_blackboard_get',
  'agent_flow_blackboard_list',
]);

const READ_ONLY_ACTIONS: Record<string, Set<string>> = {
  connector_mcp: new Set(['guide', 'list_connectors', 'list_mcp_servers', 'list_tools']),
  channel_agent: new Set(['guide', 'status', 'inbox', 'read', 'prepare_reply']),
  gateway_bridge: new Set([
    'conversations_list',
    'conversation_get',
    'messages_read',
    'attachments_fetch',
    'events_poll',
    'channels_list',
    'agent_profile_get',
    'permissions_list_open',
  ]),
};

const CONNECTOR_MUTATION_PATTERN = /(?:^|[_-])(send|create|update|delete|remove|destroy|write|upload|invite|react|comment|publish|trigger|execute|run|add|move|archive|cancel|post|put|patch|sync)(?:$|[_-])/i;
const CONNECTOR_READ_PATTERN = /^(?:get|list|read|fetch|search|find|lookup|retrieve|describe|inspect|check|verify|health|status|whoami|view|show|count|query|load)(?:$|[_-])/i;

const STATEFUL_NAME_PARTS = [
  'write',
  'edit',
  'create',
  'delete',
  'remove',
  'update',
  'run',
  'execute',
  'shell',
  'terminal',
  'save',
  'modify',
  'patch',
  'post',
  'send',
  'trigger',
  'schedule',
  'start',
  'stop',
];

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getParallelToolCallName(call: ParallelToolCallLike): string {
  return String(
    call?.name ||
    call?.functionCall?.name ||
    call?.function?.name ||
    '',
  ).trim();
}

export function getParallelToolCallArgs(call: ParallelToolCallLike): Record<string, unknown> {
  return parseArguments(
    call?.args ||
    call?.input ||
    call?.functionCall?.args ||
    call?.function?.arguments,
  );
}

/** Return true only when a call is safe to start with other independent reads. */
export function isParallelSafeToolCall(call: ParallelToolCallLike): boolean {
  const name = getParallelToolCallName(call);
  const lowerName = name.toLowerCase();
  const args = getParallelToolCallArgs(call);

  if (READ_ONLY_TOOLS.has(name)) return true;
  const action = String(args.action || '').toLowerCase();
  if (READ_ONLY_ACTIONS[name]?.has(action)) return true;
  if (name === 'connector_mcp' && action === 'api_request') {
    return String(args.method || 'GET').toUpperCase() === 'GET';
  }
  if (name === 'connector_mcp' && action === 'call_tool') {
    const remoteToolName = String(args.tool_name || '').trim();
    return Boolean(remoteToolName)
      && !CONNECTOR_MUTATION_PATTERN.test(remoteToolName)
      && CONNECTOR_READ_PATTERN.test(remoteToolName);
  }
  if (lowerName === 'workspace_run_command') {
    const mode = String(args.mode || 'run').toLowerCase();
    if (mode === 'check' || mode === 'list') return true;
    // A background launch mutates the runtime process registry. Keep it as an
    // ordering barrier so a same-turn check/list cannot race registration.
    if (args.background === true) return false;
    const commands = Array.isArray(args.commands) ? args.commands : [];
    if (commands.length > 0) {
      return commands.every((entry: any) => entry?.background !== true && isReadOnlyShellCommand(String(entry?.command || entry?.cmd || '')));
    }
    return isReadOnlyShellCommand(String(args.command || args.cmd || ''));
  }

  if (STATEFUL_NAME_PARTS.some(part => lowerName.includes(part))) return false;

  return false;
}

/**
 * Split a provider's tool-call turn into the leading parallel-safe batch and
 * the ordered tail. Once a state-changing call appears, later calls stay in
 * provider order because they may depend on that mutation.
 */
export function splitLeadingParallelToolCalls<T extends ParallelToolCallLike>(
  calls: T[],
): { parallel: T[]; ordered: T[] } {
  const parallel: T[] = [];
  const ordered: T[] = [];
  let orderedStarted = false;

  for (const call of calls) {
    if (!orderedStarted && isParallelSafeToolCall(call)) {
      parallel.push(call);
    } else {
      orderedStarted = true;
      ordered.push(call);
    }
  }

  return { parallel, ordered };
}

/** Adjacent independent reads share a batch; mutations remain order barriers. */
export function groupParallelToolCalls<T extends ParallelToolCallLike>(calls: T[], maxParallel = 6): T[][] {
  const limit = Number.isFinite(maxParallel) ? Math.max(1, Math.floor(maxParallel)) : 6;
  const groups: T[][] = [];
  let reads: T[] = [];
  const flush = () => {
    if (reads.length) groups.push(reads);
    reads = [];
  };
  for (const call of calls) {
    if (isParallelSafeToolCall(call)) {
      reads.push(call);
      if (reads.length === limit) flush();
    } else {
      flush();
      groups.push([call]);
    }
  }
  flush();
  return groups;
}
