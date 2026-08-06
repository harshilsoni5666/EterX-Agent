/**
 * Tools that should not be advertised to the normal Main agent.
 *
 * The implementations remain registered for custom/legacy runtimes, but these
 * entries either duplicate a stronger tool, expose internal bookkeeping that
 * the Main agent already handles automatically, or depend on a platform/
 * desktop-control surface that should not be advertised by the portable Main.
 */
const MAIN_AGENT_HIDDEN_TOOL_NAMES = new Set([
  'context_manager',
  'desktop_control',
  'screen_agent',
  'workspace_edit_many_files',
  'workspace_str_replace',
]);

export function shouldExposeMainAgentTool(toolName: string): boolean {
  return !MAIN_AGENT_HIDDEN_TOOL_NAMES.has(String(toolName || '').trim());
}
