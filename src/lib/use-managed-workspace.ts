'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from './client-storage';
import { normalizeScratchRetention, requestWorkspace, type ManagedWorkspace, type RunLocation } from './managed-workspaces';

export function useManagedWorkspace(ownerId: string, path: string | null, commit: (location: RunLocation, path: string | null, sourcePath: string | null) => boolean) {
  const chatId = ownerId.replace(/^terminal-draft-/, '');
  const [workspace, setWorkspace] = useState<ManagedWorkspace | null>(null);
  const [retentionDays, setRetentionDays] = useState(7);
  const [busyOwners, setBusyOwners] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const current = useRef({ ownerId, path, commit });
  current.current = { ownerId, path, commit };
  const pending = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
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
    if (pending.current.has(ownerId)) return false;
    const { commit: commitSelection } = current.current;
    pending.current.add(ownerId);
    setBusyOwners(new Set(pending.current));
    setError('');
    const isCurrent = () => mounted.current && current.current.ownerId === ownerId && current.current.path === path;
    try {
      const previous = path ? await requestWorkspace({ action: 'inspect', chatId: ownerId, path }) : null;
      if (!isCurrent()) return false;
      let sourcePath = previous ? previous.sourcePath : path;
      if (location === 'worktree' && !sourcePath) {
        const selectFolder = (window as any).electronAPI?.selectFolder;
        if (selectFolder) {
          sourcePath = await selectFolder();
          if (!sourcePath || !isCurrent()) return false;
        }
      }
      const next = location === 'local' ? null : await requestWorkspace({ action: 'create', chatId: ownerId, kind: location, sourcePath, days: retentionDays });
      if (location !== 'local' && !next) throw new Error('Could not prepare this workspace.');
      if (!isCurrent() || !commitSelection(location, next?.path || sourcePath || null, next ? next.sourcePath : sourcePath)) return false;
      setWorkspace(next);
      return true;
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Could not prepare this workspace.');
      return false;
    } finally {
      pending.current.delete(ownerId);
      if (mounted.current) setBusyOwners(new Set(pending.current));
    }
  }, [ownerId, path, retentionDays]);

  const update = useCallback(async (action: 'keep' | 'extend' | 'remove') => {
    if (!workspace || workspace.path !== path || workspace.chatId !== chatId || pending.current.has(ownerId)) return;
    const { commit: commitSelection } = current.current;
    pending.current.add(ownerId);
    setBusyOwners(new Set(pending.current));
    setError('');
    try {
      const next = await requestWorkspace({ action, chatId: ownerId, id: workspace.id, days: retentionDays });
      if (mounted.current && current.current.ownerId === ownerId && current.current.path === path) {
        if (action === 'remove') {
          commitSelection('local', workspace.sourcePath, workspace.sourcePath);
          setWorkspace(null);
        } else setWorkspace(next);
      }
    } catch (reason) {
      if (mounted.current && current.current.ownerId === ownerId && current.current.path === path) setError(reason instanceof Error ? reason.message : 'Could not update the expiry.');
    } finally {
      pending.current.delete(ownerId);
      if (mounted.current) setBusyOwners(new Set(pending.current));
    }
  }, [workspace, ownerId, chatId, path, retentionDays]);

  return {
    workspace: workspace && workspace.path === path && workspace.chatId === chatId ? workspace : null,
    retentionDays, busy: busyOwners.has(ownerId), error, choose, update,
  };
}
