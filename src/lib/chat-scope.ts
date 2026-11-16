import { workspacePathKey } from './workspace-paths';

export type ChatScope =
  | { kind: 'recents' }
  | { kind: 'project'; path: string }
  | { kind: 'folder'; name: string };

export const RECENTS_CHAT_SCOPE: ChatScope = { kind: 'recents' };

interface ScopedChat {
  workspacePath?: string | null;
  importFolder?: string;
}

export function chatWorkspaceKey(path: string | null | undefined): string {
  const value = path?.trim();
  return value ? workspacePathKey(value) : '';
}

export function chatMatchesScope(chat: ScopedChat, scope: ChatScope): boolean {
  if (scope.kind === 'folder') return chat.importFolder === scope.name;
  if (scope.kind === 'project') return chatWorkspaceKey(chat.workspacePath) === chatWorkspaceKey(scope.path);
  // Recents is the combined history, including chats organized in folders.
  return true;
}

export function chatScopeForChat(chat: ScopedChat): ChatScope {
  if (chat.importFolder) return { kind: 'folder', name: chat.importFolder };
  if (chat.workspacePath?.trim()) return { kind: 'project', path: chat.workspacePath.trim() };
  return RECENTS_CHAT_SCOPE;
}
