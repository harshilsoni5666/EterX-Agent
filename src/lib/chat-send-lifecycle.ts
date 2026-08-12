export interface ChatSendTarget {
  /** Stable identity reserved before async admission checks begin. */
  chatId: string;
  /** Whether a caller deliberately targeted a particular chat. */
  hasExplicitTarget: boolean;
  /** True when the send originated from the blank New chat surface. */
  fromFreshComposer: boolean;
}

/**
 * Resolve a send to a concrete chat before applying any in-flight lock.
 *
 * Blank New chat surfaces do not yet have an active chat ID. Reusing a shared
 * placeholder for them couples otherwise independent streams: a slow send in
 * one fresh chat can reject a later send after the user opens New chat again.
 */
export const resolveChatSendTarget = (
  targetChatIdOverride: string | undefined,
  activeChatId: string | null,
  createId: () => string,
): ChatSendTarget => {
  const explicitTarget = String(targetChatIdOverride || '').trim();
  if (explicitTarget) return { chatId: explicitTarget, hasExplicitTarget: true, fromFreshComposer: false };
  if (activeChatId) return { chatId: activeChatId, hasExplicitTarget: false, fromFreshComposer: false };
  return { chatId: createId(), hasExplicitTarget: false, fromFreshComposer: true };
};
