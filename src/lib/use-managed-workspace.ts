'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from './client-storage';
import { normalizeScratchRetention, requestWorkspace, type ManagedWorkspace, type RunLocation } from './managed-workspaces';

export function useManagedWorkspace(ownerId: string, path: string | null, commit: (location: RunLocation, path: string | null) => void) {
  const [workspace, setWorkspace] = useState<ManagedWorkspace | null>(null);
  const [retentionDays, setRetentionDays] = useState(7);
  const [busyOwner, setBusyOwner] = useState<string | null>(null);
  const [error, setError] = useState('');
  const current = useRef({ ownerId, path, commit });
  current.current = { ownerId, path, commit };
  const pending = useRef(new Set<string>());
  useEffect(() => {
    const read = () => { try { setRetentionDays(normalizeScratchRetention(JSON.parse(appStorage.getItem('eterx_settings') || '{}').scratchRetentionDays)); } catch {} };
    void appStorageReady.then(read);
    window.addEventListener('eterx-settings-updated', read);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, read);
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('eterx-settings') : null;
    if (channel) channel.onmessage = read;
    return () => { window.removeEventListener('eterx-settings-updated', read); window.removeEventListener(FOLDER_STORAGE_READY_EVENT, read); channel?.close(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    setWorkspace(null);
    setError('');
    const refresh = async () => {
      if (!path || !ownerId || ownerId === 'terminal-draft-initial') return;
      try {
        const value = await requestWorkspace({ action: 'inspect', chatId: ownerId, path });
        if (!disposed) setWorkspace(value);
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : 'Workspace details are unavailable.'); }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(() => void refresh(), 60000);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [ownerId, path]);

  const choose = useCallback(async (location: RunLocation) => {
    if (pending.current.has(ownerId)) return;
    pending.current.add(ownerId);
    setBusyOwner(ownerId);
    setError('');
    try {
      const previous = path ? await requestWorkspace({ action: 'inspect', chatId: ownerId, path }) : null;
      let sourcePath = previous ? previous.sourcePath : path;
      if (location === 'worktree' && !sourcePath) {
        const selectFolder = (window as any).electronAPI?.selectFolder;
        if (selectFolder) {
          sourcePath = await selectFolder();
          if (!sourcePath) return;
        }
      }
      const next = location === 'local' ? null : await requestWorkspace({ action: 'create', chatId: ownerId, kind: location, sourcePath, days: retentionDays });
      // Navigation during preparation must never switch the new chat's folder.
      if (current.current.ownerId !== ownerId || current.current.path !== path) return;
      current.current.commit(location, next?.path || sourcePath || null);
      setWorkspace(next);
    } catch (reason) {
      if (current.current.ownerId === ownerId) setError(reason instanceof Error ? reason.message : 'Could not prepare this workspace.');
    } finally { pending.current.delete(ownerId); setBusyOwner(value => value === ownerId ? null : value); }
  }, [ownerId, path, retentionDays]);

  const update = useCallback(async (action: 'keep' | 'extend' | 'remove') => {
    if (!workspace || pending.current.has(ownerId)) return;
    pending.current.add(ownerId);
    setBusyOwner(ownerId);
    setError('');
    try {
      const next = await requestWorkspace({ action, chatId: ownerId, id: workspace.id, days: retentionDays });
      if (current.current.ownerId === ownerId && current.current.path === path) {
        if (action === 'remove') {
          current.current.commit('local', workspace.sourcePath);
          setWorkspace(null);
        } else setWorkspace(next);
      }
    } catch (reason) {
      if (current.current.ownerId === ownerId) setError(reason instanceof Error ? reason.message : 'Could not update the expiry.');
    } finally { pending.current.delete(ownerId); setBusyOwner(value => value === ownerId ? null : value); }
  }, [workspace, ownerId, path, retentionDays]);

  return { workspace: workspace?.path === path ? workspace : null, retentionDays, busy: busyOwner === ownerId, error, choose, update };
}
