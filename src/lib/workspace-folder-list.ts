export type WorkspaceFolderEntry = { name: string; path: string; type: 'file' | 'directory' };

export async function listWorkspaceFolderChildren(
  directory: string,
  showHidden: boolean,
  signal?: AbortSignal,
): Promise<WorkspaceFolderEntry[]> {
  const desktop = typeof window === 'undefined' ? undefined : (window as any).electronAPI;
  if (desktop?.workspaceFolderList) {
    const result = await desktop.workspaceFolderList(directory, 0, showHidden);
    return Array.isArray(result?.entries) ? result.entries : [];
  }
  const response = await fetch('/api/code/files?path=' + encodeURIComponent(directory) + '&depth=0', { signal });
  if (!response.ok) return [];
  const result = await response.json();
  return Array.isArray(result?.tree) ? result.tree : [];
}
