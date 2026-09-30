'use client';

type Listener = () => void;
const listeners = new Map<string, Listener>();
let unsubscribe: (() => void) | undefined;

export function watchWorkspaceFolder(path: string, callback: Listener) {
  const api = (window as any).electronAPI;
  if (!api?.workspaceFilesWatch) return () => {};
  if (!unsubscribe) unsubscribe = api.onWorkspaceFilesEvent((event: { id: string }) => listeners.get(event.id)?.());
  const id = crypto.randomUUID();
  let disposed = false;
  listeners.set(id, callback);
  void api.workspaceFilesWatch(id, path).then(() => { if (disposed) api.workspaceFilesUnwatch(id); }).catch(() => {});
  return () => {
    disposed = true; listeners.delete(id); api.workspaceFilesUnwatch(id);
    if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined; }
  };
}
