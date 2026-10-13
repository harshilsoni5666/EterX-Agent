'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type DesktopUpdateState = {
  revision?: number;
  status: 'idle' | 'development' | 'unsupported' | 'checking' | 'pending' | 'available' | 'downloading' | 'current' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  availableVersion?: string | null;
  percent: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  downloadReady?: boolean;
  message: string;
  supported?: boolean;
  automaticChecks?: boolean;
  manualInstall?: boolean;
  lastCheckedAt?: string | null;
  lastCheckAttemptAt?: string | null;
  nextCheckAt?: string | null;
  checkError?: string | null;
  checking?: boolean;
  openSettingsRequest?: number | null;
  platform?: string;
  architecture?: string;
  packageType?: string;
  updateHost?: string;
  releasePage?: string;
  releaseName?: string | null;
  releaseDate?: string | null;
  updateAvailableUnread?: boolean;
};

type UpdateAction = 'checkForUpdates' | 'downloadUpdate' | 'installUpdate';
const initialState: DesktopUpdateState = {
  revision: 0,
  status: 'development',
  currentVersion: 'development',
  percent: 0,
  automaticChecks: false,
  message: 'Desktop updates are available in the installed application.',
};

export function useDesktopUpdates(enabled = true) {
  const [updateState, setUpdateState] = useState(initialState);
  const [updateActionError, setUpdateActionError] = useState('');
  const [updateActionPending, setUpdateActionPending] = useState<UpdateAction | null>(null);
  const actionInFlight = useRef(false);
  const applyDesktopUpdateState = useCallback((incoming: DesktopUpdateState | null | undefined) => {
    if (!incoming || typeof incoming !== 'object' || typeof incoming.status !== 'string') return;
    setUpdateActionError('');
    setUpdateState(current => {
      if (Number.isFinite(incoming.revision) && Number.isFinite(current.revision) && incoming.revision! < current.revision!) return current;
      return incoming;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const api = (window as any).electronAPI;
    if (typeof api?.getUpdateState !== 'function') return;
    let active = true;
    const apply = (incoming: DesktopUpdateState) => {
      if (active) applyDesktopUpdateState(incoming);
    };
    const unsubscribe = api.onUpdateState?.(apply);
    api.getUpdateState().then(apply).catch(() => {
      if (active) setUpdateActionError('Could not read the desktop update status. Reopen Settings to try again.');
    });
    return () => { active = false; unsubscribe?.(); };
  }, [enabled, applyDesktopUpdateState]);

  const runUpdateAction = useCallback(async (action: UpdateAction) => {
    if (actionInFlight.current) return;
    const api = (window as any).electronAPI;
    setUpdateActionError('');
    if (typeof api?.[action] !== 'function') {
      setUpdateActionError('This action is available in the installed EterX desktop application.');
      return;
    }
    actionInFlight.current = true;
    setUpdateActionPending(action);
    try {
      const result = await api[action]();
      if (result && typeof result === 'object') applyDesktopUpdateState(result);
    } catch {
      setUpdateActionError('Could not complete the update action. Please try again.');
    } finally {
      actionInFlight.current = false;
      setUpdateActionPending(null);
    }
  }, [applyDesktopUpdateState]);

  const markUpdateViewed = useCallback(() => {
    const api = (window as any).electronAPI;
    if (typeof api?.markUpdateViewed !== 'function') return;
    // A failed acknowledgement must not block downloading or erase availability.
    void api.markUpdateViewed().then(applyDesktopUpdateState).catch(() => {});
  }, [applyDesktopUpdateState]);

  return { updateState, updateActionError, updateActionPending, runUpdateAction, markUpdateViewed };
}
