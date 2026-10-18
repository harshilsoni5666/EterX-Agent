'use client';
import { useEffect, useMemo, useState } from 'react';
import { collectWorkspaceTouches, compactWorkspaceRoots, isWorkspaceTouchTrace, type WorkspaceTouch } from './workspace-paths';
import { useTraceSelection } from './use-trace-selection';

const empty: any[] = [];

export function useWorkspaceRoots(owner: string, workspacePath: string | null | undefined, logs: any[], openedPaths: string[], folders: string[]) {
  const workspaceLogs = useTraceSelection(workspacePath ? empty : logs, isWorkspaceTouchTrace);
  const touches = useMemo(() => workspacePath ? [] : collectWorkspaceTouches(workspaceLogs, owner), [workspaceLogs, owner, workspacePath]);
  const explicitRoots = useMemo(() => workspacePath ? [workspacePath] : [], [workspacePath]);
  const touched = workspacePath ? [] : [...touches, ...openedPaths.map(path => ({ path, kind: 'file' as const })), ...folders.map(path => ({ path, kind: 'directory' as const }))];
  const signature = JSON.stringify({ chatId: owner, workspacePath: workspacePath || null, touched });
  const basis = owner + ':' + (workspacePath || '');
  const key = owner + ':' + signature;
  const [resolved, setResolved] = useState<{ key: string; basis: string; roots: string[]; error: string } | null>(null);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    const options = JSON.parse(signature) as { chatId: string; workspacePath: string | null; touched: WorkspaceTouch[] };
    const resolve = async (): Promise<string[]> => {
      if (options.chatId === 'terminal-draft-initial') return [];
      if (!options.chatId && !options.workspacePath && !options.touched.length) return [];
      const api = (window as any).electronAPI;
      if (api?.workspaceFolderRoots) return api.workspaceFolderRoots(options);
      const response = await fetch('/api/code/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: signature, signal: abort.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result.roots;
    };
    void resolve().then(roots => { if (!disposed) setResolved({ key, basis, roots: compactWorkspaceRoots(roots), error: '' }); }).catch(error => { if (!disposed) setResolved({ key, basis, roots: [], error: error.message || String(error) }); });
    return () => { disposed = true; abort.abort(); };
  }, [key, signature, basis]);
  // Never expose another owner's (or a previous selected workspace's) results
  // during an asynchronous resolution. Explicit folders can display immediately.
  // Keep still-supported folders mounted while this same chat gains a new file.
  const retained = resolved?.basis === basis ? resolved.roots : empty;
  return resolved?.key === key ? { roots: resolved.roots, error: resolved.error, loading: false } : { roots: workspacePath ? explicitRoots : retained, error: '', loading: !!(owner || workspacePath || touched.length) };
}
