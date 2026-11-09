/** Focused coding-agent tool surface — advanced Cursor-class primitives */
export const CODE_AGENT_TOOLS = [
  'workspace_edit_file', 'workspace_run_command', 'scheduled_tasks', 'wait_timer',
  'browser_control', 'computer', 'screen_agent', 'spawn_sub_agent', 'task_decomposer', 'task_checkpoint',
  'get_skill_guidelines', 'context_memory', 'web_search', 'image_asset_search',
] as const;

export type CodeAgentToolName = typeof CODE_AGENT_TOOLS[number];

const STATELESS_TOOLS = new Set<string>(['get_skill_guidelines', 'web_search']);

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
    const terminalRead = name === 'workspace_run_command' && ['list', 'check', 'wait'].includes(String(args.mode || ''));
    if (terminalRead || isStatelessCodingTool(name)) stateless.push(call);
    else stateful.push(call);
  }
  return { stateless, stateful };
}

export const CODE_AGENT_WORKFLOW = `
CODING WORKFLOW
- Use only this run's declared tools. Search and read with workspace_run_command using the current shell; batch independent known targets.
- Author source/text changes with workspace_edit_file, grouping related targets. Use execution tools for builds, generators and binary artifacts.
- Reuse current evidence. When authorized, verify the changed behavior with the narrowest relevant command; respect no-test/no-check instructions.
- Keep a running command's taskId; use mode=wait/check/list/kill instead of inventing process tools or repeatedly launching it.
- Use planning, skills, browser evidence and delegation only when relevant, available and authorized.
`.trim();
