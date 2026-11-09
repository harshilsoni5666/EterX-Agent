type WorkspaceChat = {
  importOrigin?: unknown;
  workspacePath?: string | null;
  workspaceSelectionUpdatedAt?: number;
};

/** Import refreshes may fill an empty workspace, but must not undo an explicit
 * folder selection (including disconnecting) or lose it to a stale save. */
export function importedWorkspaceMetadata(durable: WorkspaceChat, incoming: WorkspaceChat): Pick<WorkspaceChat, 'workspacePath' | 'workspaceSelectionUpdatedAt'> {
  if (!durable.importOrigin && !incoming.importOrigin) return {};
  const durableSelection = Number(durable.workspaceSelectionUpdatedAt || 0);
  const incomingSelection = Number(incoming.workspaceSelectionUpdatedAt || 0);
  if (durableSelection || incomingSelection) {
    const selected = incomingSelection >= durableSelection ? incoming : durable;
    return { workspacePath: selected.workspacePath || null, workspaceSelectionUpdatedAt: selected.workspaceSelectionUpdatedAt };
  }
  return { workspacePath: durable.workspacePath || incoming.workspacePath || null };
}
