/**
 * Composer controls are aggregate state owned by one chat surface. Keeping the
 * key and publication rules outside React makes ownership explicit and keeps
 * navigation, background sends, and storage hydration on the same contract.
 */
export const chatComposerStateKey = (chatId?: string | null, surface = 'main'): string => {
  const owner = String(chatId || '').trim() || 'new_chat';
  return surface === 'main'
    ? owner
    : `${owner}::agent-composer::${encodeURIComponent(surface)}`;
};

export const hasOwnedComposerState = <T>(
  states: Readonly<Record<string, T>>,
  chatId?: string | null,
  surface = 'main',
): boolean => Object.prototype.hasOwnProperty.call(states, chatComposerStateKey(chatId, surface));

export const publishOwnedComposerState = <T>(
  states: Readonly<Record<string, T>>,
  chatId: string | null | undefined,
  state: T,
  surface = 'main',
): Record<string, T> => ({
  ...states,
  [chatComposerStateKey(chatId, surface)]: state,
});

