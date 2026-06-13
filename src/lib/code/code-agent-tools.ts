/** Focused coding-agent tool surface — advanced Cursor-class primitives */
export const CODE_AGENT_TOOLS = [
  'tool_finder',
  'workspace_semantic_search',
  'workspace_symbol_lookup',
  'workspace_file_outline',
  'workspace_find_files',
  'workspace_search_text',
  'workspace_read_file',
  'workspace_read_many_files',
  'workspace_str_replace',
  'workspace_apply_patch',
  'workspace_edit_file',
  'workspace_edit_many_files',
  'workspace_write_file',
  'workspace_execute_script',
  'workspace_run_command',
  'workspace_verify_code',
  'workspace_edit_session',
  'process_manager',
  'background_task',
  'wait_timer',
  'browser_control',
  'screenshot_capture',
  'spawn_sub_agent',
  'task_decomposer',
  'task_checkpoint',
  'get_skill_guidelines',
  'memory_v2',
  'context_manager',
  'safety_guard',
  'web_search',
  'web_scraper',
  'deep_research',
  'image_asset_search',
  'code_intelligence',
  'git_intelligence',
  'realtime_verify',
  'smart_refactor',
] as const;

export type CodeAgentToolName = typeof CODE_AGENT_TOOLS[number];

const STATELESS_TOOLS = new Set<string>([
  'tool_finder',
  'workspace_semantic_search',
  'workspace_symbol_lookup',
  'workspace_file_outline',
  'workspace_find_files',
  'workspace_search_text',
  'workspace_read_file',
  'workspace_read_many_files',
  'workspace_list_directory',
  'workspace_edit_session',
  'code_intelligence',
  'git_intelligence',
  'realtime_verify',
  'workspace_analyze',
  'smart_file_analyzer',
  'get_skill_guidelines',
  'context_manager',
  'safety_guard',
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

export function partitionCodingToolCalls<T extends { name?: string }>(calls: T[]): {
  stateless: T[];
  stateful: T[];
} {
  const stateless: T[] = [];
  const stateful: T[] = [];
  for (const call of calls) {
    if (isStatelessCodingTool(String(call.name || ''))) stateless.push(call);
    else stateful.push(call);
  }
  return { stateless, stateful };
}

export const CODE_AGENT_WORKFLOW = `
CODING AGENT WORKFLOW:

1. EXPLORE FAST (parallel)
   - workspace_semantic_search for behavior/architecture questions
   - workspace_symbol_lookup for exact symbol definitions/usages
   - workspace_find_files for path discovery
   - workspace_search_text for exact strings/regex
   - workspace_file_outline before editing unfamiliar files

2. READ SMART (batch)
   - workspace_read_many_files for 2+ known targets
   - workspace_read_file with startLine/endLine for one range
   - code_intelligence when dependencies/structure matter

3. EDIT SAFE (simplest first)
   - workspace_str_replace for normal edits (returns diff + readback automatically)
   - workspace_apply_patch for multi-hunk/multi-file edits
   - workspace_edit_file / workspace_edit_many_files for line-range edits
   - smart_refactor for symbol-aware refactors
   - workspace_write_file only for new files

4. VERIFY SMALL
   - realtime_verify for quick syntax/json/file checks
   - workspace_verify_code or workspace_run_command for project checks
   - git_intelligence only when the user asks about repo changes

5. RUNTIME PROOF AND RISK CONTROL
   - process_manager/background_task/wait_timer for servers or long checks
   - browser_control plus screenshot_capture for visible UI behavior
   - safety_guard before destructive, credential, external upload, or production-impacting work

6. ADVANCED AGENT SUPPORT
   - spawn_sub_agent only for independent exploration or blind review
   - task_decomposer/task_checkpoint for broad or long-running work
   - get_skill_guidelines for domain-specific implementation constraints
   - memory_v2/context_manager for durable facts and stale-context hygiene

7. SESSION MANAGEMENT (long tasks)
   - workspace_edit_session action=summary to review all changes
   - workspace_edit_session action=checkpoint to save progress
   - workspace_edit_session action=undo to revert a mistake
   - workspace_edit_session action=diff for full session report
`.trim();
