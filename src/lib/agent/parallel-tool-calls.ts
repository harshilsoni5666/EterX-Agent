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
  'workspace_semantic_search',
  'workspace_symbol_lookup',
  'workspace_file_outline',
  'workspace_find_files',
  'workspace_read_file',
  'workspace_read_many_files',
  'workspace_view_file',
  'workspace_search_text',
  'workspace_list_directory',
  'web_search',
  'web_scraper',
  'deep_research',
  'get_skill_guidelines',
  'calculator',
  'json_yaml_transform',
  'regex_text_processor',
  'image_asset_search',
  'youtube_transcript',
  'pdf_parser',
  'parse_pdf',
  'rss_feed_reader',
  'csv_analyzer',
  'csv_data_analyzer',
  'tool_finder',
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
  if (lowerName === 'background_task') {
    return ['check', 'list'].includes(String(args.mode || '').toLowerCase());
  }
  if (lowerName === 'process_manager') {
    return ['status', 'logs', 'list'].includes(String(args.action || '').toLowerCase());
  }
  if (lowerName === 'system_shell' || lowerName === 'workspace_run_command') {
    return args.background === true || isReadOnlyShellCommand(String(args.command || ''));
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
