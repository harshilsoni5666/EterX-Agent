'use client';

import { useSyncExternalStore } from 'react';

type WindowVisibilityBridge = {
  getWindowVisibility?: () => Promise<boolean>;
  onWindowVisibilityChanged?: (listener: (visible: boolean) => void) => () => void;
};

const listeners = new Set<() => void>();
let nativeVisible: boolean | undefined;
let stopNativeListener: (() => void) | undefined;
let generation = 0;
let nativeRevision = 0;
let lastPublished = true;

/** Presentation visibility only. Agent execution must never depend on this. */
export function isAppVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return nativeVisible !== false && document.visibilityState !== 'hidden';
}

function publishVisibility() {
  const visible = isAppVisible();
  if (visible === lastPublished) return;
  lastPublished = visible;
  // A component may unsubscribe while handling the transition. Notify a
  // stable snapshot, and keep one failing surface from blocking the others.
  for (const listener of Array.from(listeners)) {
    if (!listeners.has(listener)) continue;
    try { listener(); } catch (error) {
      console.warn('[EterX] Visibility listener failed:', error);
    }
  }
}

function startObserving() {
  const observedGeneration = ++generation;
  lastPublished = isAppVisible();
  document.addEventListener('visibilitychange', publishVisibility);

  // Electron deliberately keeps execution timers unthrottled. In that mode
  // Chromium reports "visible" even for a minimized window, so use the native
  // window signal as well. Browser-only sessions retain Page Visibility.
  const bridge = (window as typeof window & { electronAPI?: WindowVisibilityBridge }).electronAPI;
  if (!bridge) return;
  stopNativeListener = bridge.onWindowVisibilityChanged?.(visible => {
    if (observedGeneration !== generation || typeof visible !== 'boolean') return;
    nativeRevision += 1;
    nativeVisible = visible;
    publishVisibility();
  });
  const requestedRevision = nativeRevision;
  void bridge.getWindowVisibility?.().then(visible => {
    // A minimize/restore event received after this read was requested owns
    // the state. A late initial reply must not undo that newer event.
    if (observedGeneration !== generation || requestedRevision !== nativeRevision || typeof visible !== 'boolean') return;
    nativeVisible = visible;
    publishVisibility();
  }).catch(() => { /* Older desktop hosts fall back to Page Visibility. */ });
}

/** All visual consumers share one IPC subscription and one initial read. */
export function subscribeAppVisibility(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  listeners.add(listener);
  if (listeners.size === 1) startObserving();
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    generation += 1;
    document.removeEventListener('visibilitychange', publishVisibility);
    stopNativeListener?.();
    stopNativeListener = undefined;
    nativeVisible = undefined;
  };
}

const getServerSnapshot = () => true;

export function useAppVisibility(): boolean {
  return useSyncExternalStore(subscribeAppVisibility, isAppVisible, getServerSnapshot);
}
