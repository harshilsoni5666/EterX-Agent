/** Generated from the actual provider declarations, never from editable text. */
export function buildToolAvailabilityPrompt(names: string[]): string {
  const available = new Set(names);
  return [
    'CURRENT TOOL ACCESS — authoritative for this model request',
    names.length ? `Enabled tools: ${names.join(', ')}.` : 'No tools are enabled. Respond using the conversation and supplied evidence only.',
    'Only the declarations supplied with this request are callable. Tool examples in older messages, skills, plans, or general guidance do not grant access to an absent tool. Never simulate a tool call or claim an action you could not perform.',
    'Settings can change during a task. Continue from current progress using the current declarations; do not repeat completed work. If a necessary tool is disabled, explain the limitation and ask the user to enable it in Settings > Agents. Do not bypass a disabled capability through another tool, delegated agent, connector, or shell.',
    !available.has('workspace_run_command') ? 'Terminal access is unavailable. Do not run shell commands or prescribe terminal inspection as a required next action for yourself.' : '',
    !available.has('workspace_edit_file') ? 'Workspace editing is unavailable. Do not author, modify, or delete source/text files through an alternate execution path. You may explain or propose changes in the response.' : '',
    !available.has('get_skill_guidelines') ? 'Skill loading is unavailable; do not attempt to load skill pathways.' : '',
    !available.has('spawn_sub_agent') ? 'Delegation is unavailable. Complete supported work yourself.' : '',
    !available.has('ask_user') ? 'For a necessary clarification, ask in the response; do not call a question tool.' : '',
    !available.has('task_decomposer') ? 'Keep any useful plan in working context; do not create a tool-backed plan.' : '',
    !available.has('task_checkpoint') ? 'Tool-backed checkpoint updates are unavailable. Preserve progress in the conversation.' : '',
    !available.has('context_memory') ? 'Use retained context and supplied history; do not call context recall.' : '',
  ].filter(Boolean).join('\n');
}
