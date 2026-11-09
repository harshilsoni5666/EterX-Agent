/** A copy is a detached transcript, not a second handle to a running session. */
export function nextChatCopyTitle(title: string, titles: string[]): string {
  const base = (title.trim() || 'New chat').replace(/(?: \(\d+\))+$/, '');
  const used = new Set(titles);
  let index = 1;
  while (used.has(`${base} (${index})`)) index++;
  return `${base} (${index})`;
}

export function buildChatCopy(source: any, id: string, title: string, replacements = new Map<string, string>(), now = Date.now()) {
  const rewrite = (value: any): any => {
    if (typeof value === 'string') {
      if (value === source.id) return id;
      for (const [before, after] of replacements) value = value.split(before).join(after);
      return value;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  return {
    id, title, titleState: 'manual', titleUpdatedAt: now, updatedAt: now,
    workspacePath: source.workspacePath ?? null,
    workspaceSelectionUpdatedAt: now,
    modelSelection: source.modelSelection,
    runLocation: source.runLocation,
    isFavorite: source.isFavorite,
    importFolder: source.importFolder,
    traceLogs: rewrite(source.traceLogs || []).map((log: any) => ({ ...log, ownerChatId: id })),
  };
}
