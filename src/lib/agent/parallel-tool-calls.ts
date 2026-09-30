/**
 * Shared safety rules for deciding which tool calls may start together.
 *
 * Parallel execution is deliberately conservative: read-only calls may share
 * a batch, while writes, process control, browser actions, and user prompts
 * remain ordered so one action cannot observe another action halfway through.
 */

import { isLiteralReadCommand, literalTerminalCommands } from './shell-command-shape';

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
    if (mode === 'check' || mode === 'wait' || mode === 'list') return true;
    if (mode !== 'run') return false;
    // A background launch mutates the runtime process registry. Keep it as an
    // ordering barrier so a same-turn check/list cannot race registration.
    if (args.background === true) return false;
    const commands = Array.isArray(args.commands) ? args.commands : [];
    if (commands.some((entry: any) => entry?.background === true)) return false;
    const parsed = literalTerminalCommands(args);
    return Boolean(parsed?.length && parsed.every(isLiteralReadCommand));
  }

  if (STATEFUL_NAME_PARTS.some(part => lowerName.includes(part))) return false;

  return false;
}

/** Polling one terminal task shares an output cursor, even though it reads. */
function parallelReadResource(call: ParallelToolCallLike): string | undefined {
  if (getParallelToolCallName(call).toLowerCase() !== 'workspace_run_command') return;
  const args = getParallelToolCallArgs(call);
  if (!/^(?:check|wait)$/.test(String(args.mode || '').toLowerCase())) return;
  return `terminal-task:${String(args.taskId || '').trim()}`;
}

export interface ParallelToolExecutionOptions<TCall, TResult> {
  maxParallel?: number;
  /** Evaluated at admission, including after every asynchronous completion. */
  shouldStop?: () => boolean;
  /** Streaming/terminal adapters can preserve one result for every queued call. */
  onSkipped?: (call: TCall, index: number) => TResult;
}

/**
 * Refill available read slots immediately. A mutation/unknown call drains the
 * preceding reads and runs exclusively; subsequent reads see its final state.
 * Results retain provider order. Unexpected failures stop admission and drain
 * all active siblings before escaping, so retry cannot overlap the old turn.
 */
export async function executeParallelToolCalls<TCall extends ParallelToolCallLike, TResult>(
  calls: readonly TCall[],
  execute: (call: TCall, index: number) => Promise<TResult>,
  options: ParallelToolExecutionOptions<TCall, TResult> = {},
): Promise<TResult[]> {
  const limit = Number.isFinite(options.maxParallel)
    ? Math.max(1, Math.floor(Number(options.maxParallel))) : 6;
  const results: TResult[] = new Array(calls.length);
  let cursor = 0;

  while (cursor < calls.length) {
    let end = cursor + 1;
    if (isParallelSafeToolCall(calls[cursor])) {
      while (end < calls.length && isParallelSafeToolCall(calls[end])) end++;
    }
    const queue = Array.from({ length: end - cursor }, (_, index) => cursor + index);
    const active = new Set<Promise<void>>();
    const resources = new Set<string>();
    const failures: Array<{ index: number; reason: unknown }> = [];
    let stopped = false;
    try {
      while (queue.length > 0 || active.size > 0) {
        stopped ||= options.shouldStop?.() === true;
        while (!stopped && failures.length === 0 && active.size < limit && queue.length > 0) {
          // A second wait/check of one process stays behind its first poll;
          // unrelated reads can still occupy the other available slots.
          const ready = queue.findIndex(index => {
            const resource = parallelReadResource(calls[index]);
            return !resource || !resources.has(resource);
          });
          if (ready < 0) break;
          const [index] = queue.splice(ready, 1);
          const resource = parallelReadResource(calls[index]);
          if (resource) resources.add(resource);
          const pending: Promise<void> = Promise.resolve().then(async () => {
            // Cancellation can arrive between reservation and execution.
            if (options.shouldStop?.()) {
              stopped = true;
              if (options.onSkipped) results[index] = options.onSkipped(calls[index], index);
              return;
            }
            results[index] = await execute(calls[index], index);
          }).catch(reason => {
            failures.push({ index, reason });
          }).finally(() => {
            active.delete(pending);
            if (resource) resources.delete(resource);
          });
          active.add(pending);
        }
        if (active.size > 0) await Promise.race(active);
        else break;
      }
    } finally {
      // Also drain if an adapter's admission callback unexpectedly throws.
      await Promise.allSettled(active);
    }
    if (failures.length > 0) {
      failures.sort((a, b) => a.index - b.index);
      throw failures[0].reason;
    }
    if (stopped) {
      if (!options.onSkipped) throw new Error('CANCELLED_BY_USER');
      for (const index of queue) results[index] = options.onSkipped(calls[index], index);
      for (let index = end; index < calls.length; index++) {
        results[index] = options.onSkipped(calls[index], index);
      }
      return results;
    }
    cursor = end;
  }
  return results;
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
  const resources = new Set<string>();
  let orderedStarted = false;

  for (const call of calls) {
    const resource = parallelReadResource(call);
    if (!orderedStarted && isParallelSafeToolCall(call) && (!resource || !resources.has(resource))) {
      parallel.push(call);
      if (resource) resources.add(resource);
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
  const resources = new Set<string>();
  const flush = () => {
    if (reads.length) groups.push(reads);
    reads = [];
    resources.clear();
  };
  for (const call of calls) {
    if (isParallelSafeToolCall(call)) {
      const resource = parallelReadResource(call);
      if (resource && resources.has(resource)) flush();
      if (resource) resources.add(resource);
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
