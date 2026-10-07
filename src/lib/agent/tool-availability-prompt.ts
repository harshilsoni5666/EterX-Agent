/** Generated from the actual provider declarations, never from editable text. */
export function buildToolAvailabilityPrompt(names: string[], customAgent = false): string {
  const available = new Set(names);
  return [
    'CURRENT TOOL ACCESS — authoritative for this model request',
    names.length ? `Enabled tools: ${names.join(', ')}.` : 'No tools are enabled. Respond using the conversation and supplied evidence only.',
    'Only the declarations supplied with this request are callable. Tool examples in older messages, skills, plans, or general guidance do not grant access to an absent tool. Never simulate a tool call or claim an action you could not perform.',
    `Settings can change during a task. Continue from current progress using the current declarations; do not repeat completed work. If a necessary tool is disabled, explain the limitation and ask the user to ${customAgent ? 'attach it to this agent through Agent Builder' : 'enable it in Settings > Agents'}. Do not bypass a disabled capability through another tool, delegated agent, connector, or shell.`,
    available.has('wait_timer') ? 'Use wait_timer for a brief pause during active work, up to 120 seconds, then inspect fresh evidence. Repeated waits are allowed when work is still pending; avoid rapid polling and stop when cancelled. A timer does not create a durable reminder or prove that pending work finished.' : '',
    available.has('scheduled_tasks') ? 'Use scheduled_tasks for user-requested future or recurring work. Resolve relative times against the supplied current date and timezone, use an exact timestamp with offset, and preserve the requested agent, model, workspace, and instructions. List existing schedules before changing an ambiguously named one. Report a schedule as saved only after a successful tool result; scheduled work has not completed yet.' : 'Durable scheduling is unavailable. Do not promise a later reminder or recurring run, or substitute repeated in-session waits for a saved schedule.',
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
