const state = globalThis as typeof globalThis & { __eterxSwarmModes?: Map<string, boolean> };
const modes = state.__eterxSwarmModes ||= new Map();
export const setRuntimeSwarmMode = (chatId: string, enabled: boolean) => {
  modes.delete(chatId); modes.set(chatId, enabled);
  if (modes.size > 4096) modes.delete(modes.keys().next().value!);
};
export const isRuntimeSwarmMode = (chatId: string, fallback = false) => modes.get(chatId) ?? fallback;
