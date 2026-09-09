/** Client-safe catalog shared by the composer, prompt and runtime allowlist. */
export const CODING_LITE_TOOLS = ['workspace_run_command', 'workspace_edit_file'] as const;
export const CODING_HEAVY_TOOLS = [
  ...CODING_LITE_TOOLS,
  'browser_control', 'web_search', 'ask_user', 'task_decomposer',
  'task_checkpoint', 'context_memory', 'wait_timer', 'get_skill_guidelines',
] as const;

export type CodingAgentId = 'coding-lite' | 'coding-heavy';

export const CODING_MODES = [
  {
    id: 'coding-lite', profile: 'eterx-code-lite', label: 'Coding Lite',
    description: 'Focused coding with terminal and file editing.', tools: CODING_LITE_TOOLS,
  },
  {
    id: 'coding-heavy', profile: 'eterx-code-heavy', label: 'Coding Heavy',
    description: 'Coding with browser work, research and long-task support.', tools: CODING_HEAVY_TOOLS,
  },
] as const;

export function getCodingMode(value: unknown): typeof CODING_MODES[number] | undefined {
  const id = String(value || '').trim().toLowerCase();
  // Existing chats retain the full coding profile instead of becoming custom agents.
  if (id === 'coding' || id === 'eterx-code') return CODING_MODES[1];
  return CODING_MODES.find(mode => mode.id === id || mode.profile === id);
}

export const CODING_TOOL_DETAILS: Record<string, { label: string; description: string }> = {
  workspace_run_command: { label: 'Terminal', description: 'Read, search, run commands and manage processes; batch independent reads.' },
  workspace_edit_file: { label: 'File editing', description: 'Create, edit and delete files with exact selectors and related multi-file changes.' },
  browser_control: { label: 'Browser', description: 'Inspect and exercise web interfaces when browser access is enabled.' },
  web_search: { label: 'Web research', description: 'Find current documentation and technical references.' },
  ask_user: { label: 'Clarification', description: 'Ask focused questions when a missing decision blocks safe progress.' },
  task_decomposer: { label: 'Task planning', description: 'Create a tracker when dependencies or scope justify one.' },
  task_checkpoint: { label: 'Plan updates', description: 'Advance, revise or save an existing plan with actual evidence.' },
  context_memory: { label: 'Context recall', description: 'Retrieve exact earlier observations and decisions from this chat.' },
  wait_timer: { label: 'Waiting', description: 'Wait for ongoing work without busy polling.' },
  get_skill_guidelines: { label: 'Skill guidance', description: 'Load relevant implementation instructions when needed.' },
};
