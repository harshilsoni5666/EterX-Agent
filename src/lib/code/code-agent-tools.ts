/** Focused coding-agent tool surface — advanced Cursor-class primitives */
export const CODE_AGENT_TOOLS = [
  'tool_finder',
  'workspace_semantic_search',
  'workspace_file_outline',
  'workspace_find_files',
  'workspace_search_text',
  'workspace_read_file',
  'workspace_read_many_files',
  'workspace_write_file',
  'workspace_edit_file',
  'workspace_run_command',
  'workspace_verify_code',
  'process_manager',
  'background_task',
  'wait_timer',
  'browser_control',
  'spawn_sub_agent',
  'task_decomposer',
  'task_checkpoint',
  'get_skill_guidelines',
  'memory_v2',
  'context_manager',
  'web_search',
  'web_scraper',
  'deep_research',
  'image_asset_search',
  'realtime_verify',
] as const;

export type CodeAgentToolName = typeof CODE_AGENT_TOOLS[number];

const STATELESS_TOOLS = new Set<string>([
  'tool_finder',
  'workspace_semantic_search',
  'workspace_file_outline',
  'workspace_find_files',
  'workspace_search_text',
  'workspace_read_file',
  'workspace_read_many_files',
  'workspace_list_directory',
  'realtime_verify',
  'workspace_analyze',
  'get_skill_guidelines',
  'context_manager',
  'web_search',
  'web_scraper',
  'deep_research',
  'image_asset_search',
]);

const STATEFUL_PREFIXES = [
  'write', 'edit', 'create', 'delete', 'remove', 'update',
  'run', 'execute', 'shell', 'patch', 'apply', 'str_replace', 'refactor',
];

export function isStatelessCodingTool(toolName: string): boolean {
  const name = String(toolName || '').trim();
  if (STATELESS_TOOLS.has(name)) return true;
  const lower = name.toLowerCase();
  if (STATEFUL_PREFIXES.some(prefix => lower.includes(prefix))) return false;
  if (lower.startsWith('read') || lower.startsWith('search') || lower.startsWith('find') || lower.startsWith('list') || lower.startsWith('lookup')) {
    return true;
  }
  return false;
}

export function partitionCodingToolCalls<T extends { name?: string; args?: any }>(calls: T[]): {
  stateless: T[];
  stateful: T[];
} {
  const stateless: T[] = [];
  const stateful: T[] = [];
  for (const call of calls) {
    const name = String(call.name || '');
    const args = call.args || {};
    const explicitBackground =
      (name === 'background_task' && ['launch', 'check', 'list'].includes(String(args.mode || ''))) ||
      (name === 'workspace_run_command' && args.background === true) ||
      (name === 'process_manager' && ['start', 'status', 'logs', 'list'].includes(String(args.action || '')));
    if (explicitBackground || isStatelessCodingTool(name)) stateless.push(call);
    else stateful.push(call);
  }
  return { stateless, stateful };
}

export const CODE_AGENT_WORKFLOW = `
CODING AGENT WORKFLOW:

1. EXPLORE FAST (parallel)
   - workspace_semantic_search for behavior/architecture questions
   - workspace_find_files for path discovery
   - workspace_search_text for exact strings/regex
   - workspace_file_outline before editing unfamiliar files

2. READ SMART (batch)
   - workspace_read_many_files for 2+ known targets
   - workspace_read_file with startLine/endLine for one range

3. EDIT SAFE (simplest first)
   - workspace_write_file creates new files
   - workspace_edit_file performs targeted edits with real UI diffs

4. VERIFY SMALL
   - realtime_verify for quick syntax/json/file checks
   - workspace_verify_code or workspace_run_command for project checks

5. RUNTIME PROOF AND RISK CONTROL
   - process_manager/background_task/wait_timer for servers or long checks
   - browser_control for visible web UI behavior

6. ADVANCED AGENT SUPPORT
   - spawn_sub_agent only for independent exploration or blind review
   - task_decomposer/task_checkpoint for broad or long-running work
   - get_skill_guidelines for domain-specific implementation constraints
   - memory_v2/context_manager for durable facts and stale-context hygiene

`.trim();
