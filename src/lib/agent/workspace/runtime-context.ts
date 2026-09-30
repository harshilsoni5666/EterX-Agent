import fs from 'fs-extra';
import path from 'path';
import { getChatWorkspacePaths } from '../storage-paths';
import { getRuntimeWorkspaceRoot } from './path_resolver';

/** Rebuild chat routing from this admission. Selection is not an exclusive
 * folder lease: any number of chats may select the same workspacePath. */
export function resolveChatWorkspaceContext(chatId: string, userId: string, selection?: any) {
  const owned = getChatWorkspacePaths(chatId, userId);
  const explicit = typeof selection?.workspacePath === 'string' ? selection.workspacePath.trim() : '';
  const pins: string[] = Array.isArray(selection?.paths)
    ? selection.paths.filter((p: unknown): p is string => typeof p === 'string' && Boolean(p.trim())) : [];
  // An explicit null means the user chose Chat workspace; pinned reference
  // files must not accidentally become the command's working directory.
  const hasSelection = Object.prototype.hasOwnProperty.call(selection || {}, 'workspacePath');
  const selected = explicit || (!hasSelection ? pins[0] : undefined);
  let workspacePath = selected ? getRuntimeWorkspaceRoot({ workspacePath: selected, chatId, userId }) : owned.workspace;
  if (!explicit && selected) {
    try { if (fs.statSync(workspacePath).isFile()) workspacePath = path.dirname(workspacePath); } catch {}
  }
  return {
    workspacePath,
    workspaceRoot: workspacePath,
    scratchRoot: owned.scratch,
    paths: pins.length ? pins : [workspacePath],
    allowedPaths: Array.from(new Set([workspacePath, owned.scratch, ...pins])),
    isFocusedWorkspace: Boolean(selected),
    // Kept for saved-chat compatibility; scratch is not a different host.
    runLocation: selection?.runLocation === 'sandbox' ? 'sandbox' as const : 'local' as const,
  };
}

export async function initializeChatWorkspace(chatId: string, userId: string, selection?: any) {
  const context = resolveChatWorkspaceContext(chatId, userId, selection);
  const owned = getChatWorkspacePaths(chatId, userId);
  await Promise.all([fs.ensureDir(owned.workspace), fs.ensureDir(owned.scratch)]);
  // Do not recreate a missing selected project. Preserve its exact path so
  // tools explain the missing mount/folder instead of working elsewhere.
  return context;
}
