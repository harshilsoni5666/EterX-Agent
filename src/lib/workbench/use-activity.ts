'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { workbenchChangedEvent, workbenchJson, workbenchUrl, type WorkbenchActivity } from './client';

const empty: WorkbenchActivity = { desktop: false, tasks: [], targets: [] };
const initial = { snapshot: empty, error: '', loading: true };
const inactive = { ...initial, loading: false };
type ActivityState = typeof initial;
type Entry = {
  state: ActivityState;
  signature?: string;
  updatedAt?: number;
  listeners: Set<() => void>;
  stop?: () => void;
};
const entries = new Map<string, Entry>();

function subscribe(chatId: string, listener: () => void) {
  let entry = entries.get(chatId);
  if (!entry) {
    entry = { state: initial, listeners: new Set() };
    entries.set(chatId, entry);
    if (entries.size > 60) {
      const idle = [...entries].find(([key, value]) => key !== chatId && value.listeners.size === 0);
      if (idle) entries.delete(idle[0]);
    }
  }
  const current = entry;
  entry.listeners.add(listener);
  if (!entry.stop) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let pending = false;
    let refreshAgain = false;
    const commit = (state: ActivityState) => {
      current.state = state;
      current.listeners.forEach(notify => notify());
    };
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (pending) { refreshAgain = true; return; }
      clearTimeout(timer);
      pending = true;
      try {
        const snapshot = await workbenchJson<WorkbenchActivity>(workbenchUrl(chatId, 'activity'), { signal: controller.signal });
        if (controller.signal.aborted) return;
        current.updatedAt = Date.now();
        const signature = JSON.stringify(snapshot);
        if (current.signature !== signature || current.state.error || current.state.loading) {
          current.signature = signature;
          commit({ snapshot, error: '', loading: false });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        if (current.state.error !== message || current.state.loading) commit({ ...current.state, error: message, loading: false });
      } finally {
        pending = false;
        if (!controller.signal.aborted) {
          if (refreshAgain) { refreshAgain = false; void refresh(); }
          else timer = setTimeout(refresh, 6000);
        }
      }
    };
    const onChange = (event: Event) => {
      if ((event as CustomEvent).detail?.chatId === chatId) void refresh();
    };
    window.addEventListener(workbenchChangedEvent, onChange);
    window.addEventListener('eterx-terminal-task-changed', onChange);
    entry.stop = () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener(workbenchChangedEvent, onChange);
      window.removeEventListener('eterx-terminal-task-changed', onChange);
      current.stop = undefined;
    };
    if (!entry.state.loading && Date.now() - (entry.updatedAt || 0) > 10_000) {
      commit({ ...entry.state, loading: true });
    }
    void refresh();
  }
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0) current.stop?.();
  };
}

export function useWorkbenchActivity(chatId: string | null, visible: boolean) {
  const listen = useCallback((listener: () => void) => chatId && visible ? subscribe(chatId, listener) : () => {}, [chatId, visible]);
  const snapshot = useCallback(() => chatId ? entries.get(chatId)?.state || initial : inactive, [chatId]);
  return useSyncExternalStore(listen, snapshot, () => chatId ? initial : inactive);
}
