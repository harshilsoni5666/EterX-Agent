const state = globalThis as typeof globalThis & { __eterxPlanModes?: Map<string, boolean> };
const modes = state.__eterxPlanModes ||= new Map();
export const setRuntimePlanMode = (chatId: string, enabled: boolean) => {
  modes.delete(chatId);
  modes.set(chatId, enabled);
  if (modes.size > 4096) modes.delete(modes.keys().next().value!);
};
export const isRuntimePlanMode = (chatId: string, fallback = false) => modes.get(chatId) ?? fallback;
export const AUTO_MODE_INSTRUCTION = 'Auto mode is active. Choose a direct answer, action, focused investigation, or clarification from the current request. A lightweight step tracker can start whenever dependencies become clear. For a design decision or a request for a full implementation plan, publish a proposal with a title and a Markdown document covering the approach, decisions, constraints and acceptance criteria. Start an existing proposal with task_checkpoint action="start" when the user requests implementation.';

export const PLAN_MODE_INSTRUCTION = `Plan mode is active. The deliverable is a decision or an implementation proposal. Answer questions directly. Use existing context and inspect relevant evidence when it will change the proposal. Ask a focused question only for a consequential choice that the evidence cannot resolve.
When the approach is clear, use task_decomposer with your own concrete steps, the task constraints, and the intended outcome of each step. Revise the existing proposal with task_checkpoint when appropriate. If the planning tool is unavailable, present the proposal in the answer. Respect requests to skip a tracker. Keep simple advice brief.
Choose a compact step list for a straightforward sequence. For a design or substantial implementation, supply title and document: write a short summary followed by task-specific Markdown sections covering the decisions, affected interfaces, tradeoffs, constraints and acceptance criteria that matter. The document and steps appear in the chat and side panel. Keep the closing answer brief after publishing.
Leave implementation for a subsequent request in Auto mode. You can inspect workspace files with workspace_run_command mode="inspect", research, and discuss tradeoffs. Execution, delegation and delivery instructions refer to future implementation while this mode is active.`;

const planningTools = new Set([
  'workspace_run_command', 'context_memory', 'web_search', 'get_skill_guidelines', 'ask_user',
  'task_decomposer', 'task_checkpoint',
]);

export function planModeForContext(context: any): boolean {
  return isRuntimePlanMode(context?.ownerChatId || context?.projectId || context?.chatId, context?.planMode === true);
}

export function allowsPlanningTool(name: string, args?: Record<string, unknown>): boolean {
  if (!planningTools.has(name)) return false;
  if (!args) return true;
  if (name === 'workspace_run_command') return args.mode === 'inspect';
  if (name === 'task_checkpoint') return args.action === 'view' || args.action === 'revise';
  return true;
}

/** Retain provider-specific schema casing and expose only usable arguments. */
export function planningDeclarations<T extends { name: string; description?: string; parameters?: any }>(declarations: T[]): T[] {
  return declarations.filter(tool => allowsPlanningTool(tool.name)).map(tool => {
    const schema = tool.parameters;
    if (tool.name === 'task_checkpoint' && schema?.properties?.action) {
      const properties = Object.fromEntries(['reason', 'revisedGoal', 'title', 'document', 'revisedSteps']
        .filter(key => schema.properties[key]).map(key => [key, schema.properties[key]]));
      return { ...tool, description: 'View the complete plan or revise it. For a revision, supply a reason and the changed fields. Preserve resolved steps when replacing the step list.',
        parameters: { type: schema.type, properties: { ...properties, action: { type: schema.properties.action.type, enum: ['view', 'revise'] } }, required: ['action'] } };
    }
    if (tool.name !== 'workspace_run_command' || !schema?.properties?.inspection) return tool;
    return { ...tool, description: 'Inspect workspace files without a shell. List a directory, read a line range, or find literal text in a file. Pass nextStart as inspection.start for the next page.',
      parameters: { type: schema.type, properties: {
        mode: { type: schema.properties.mode.type, enum: ['inspect'] },
        inspection: schema.properties.inspection,
      }, required: ['mode', 'inspection'] },
    };
  });
}
