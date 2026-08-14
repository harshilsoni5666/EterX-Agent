/**
 * Shared safety rules for deciding which tool calls may start together.
 *
 * Parallel execution is deliberately conservative: read-only calls may share
 * a batch, while writes, process control, browser actions, and user prompts
 * remain ordered so one action cannot observe another action halfway through.
 */

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
]);

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

function isReadOnlyShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  if (/[>]{1,2}/.test(normalized)) return false;
  if (/(?:^|[\s;&|])(?:rm|rmdir|del|erase|mv|move|cp|copy|ren|rename|remove-item|set-content|out-file|tee|npm\s+(?:install|ci|run\s+build)|pnpm\s+(?:install|run\s+build)|yarn\s+(?:install|build)|git\s+(?:checkout|switch|reset|clean|commit|merge|rebase|pull|push))\b/i.test(normalized)) {
    return false;
  }
  return /^(?:cat|type|get-content|get-childitem|dir|ls|pwd|where|where\.exe|which|head|tail|rg|grep|find|findstr|select-string|test-path|git\s+(?:status|diff|log|show|branch|rev-parse)|node\s+--version|npm\s+--version|pnpm\s+--version|yarn\s+--version|python(?:3)?\s+--version|py\s+--version)\b/i.test(normalized);
}

/** Return true only when a call is safe to start with other independent reads. */
export function isParallelSafeToolCall(call: ParallelToolCallLike): boolean {
  const name = getParallelToolCallName(call);
  const lowerName = name.toLowerCase();
  const args = getParallelToolCallArgs(call);

  if (READ_ONLY_TOOLS.has(name)) return true;
  if (lowerName === 'workspace_run_command') {
    const mode = String(args.mode || 'run').toLowerCase();
    if (mode === 'check' || mode === 'list') return true;
    if (args.background === true) return true;
    const commands = Array.isArray(args.commands) ? args.commands : [];
    if (commands.length > 0) {
      return commands.every((entry: any) => entry?.background === true || isReadOnlyShellCommand(String(entry?.command || '')));
    }
    return isReadOnlyShellCommand(String(args.command || ''));
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
