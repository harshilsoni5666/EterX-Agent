const state = globalThis as typeof globalThis & { __eterxPlanModes?: Map<string, boolean> };
const modes = state.__eterxPlanModes ||= new Map();
export const setRuntimePlanMode = (chatId: string, enabled: boolean) => {
  modes.delete(chatId);
  modes.set(chatId, enabled);
  if (modes.size > 4096) modes.delete(modes.keys().next().value!);
};
export const isRuntimePlanMode = (chatId: string, fallback = false) => modes.get(chatId) ?? fallback;
export const PLAN_MODE_INSTRUCTION = 'The user enabled Plan mode. A visible task plan is mandatory for every request, including small tasks. Use task_decomposer to create it or task_checkpoint to update the existing plan before carrying out the request. Keep it concise, execute the requested work, and update the plan as work progresses. This explicit planning request overrides default advice to skip planning for simple tasks.';
