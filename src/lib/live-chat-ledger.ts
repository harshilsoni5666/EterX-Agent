'use client';

import { useCallback, useSyncExternalStore } from 'react';

export interface LiveChatSnapshot {
  id: string;
  title: string;
  updatedAt: number;
  traceLogs: any[];
  workspacePath?: string | null;
  modelSelection?: string;
  isFavorite?: boolean;
}

const emptyChats: LiveChatSnapshot[] = [];
const emptyLogs: any[] = [];
const noSubscription = () => () => undefined;

/**
 * A renderer-local view of the authoritative immutable chat ledger. Ingestion
 * installs snapshots synchronously; only mounted consumers of a changed chat
 * are notified, at the next paint. Background agents never invalidate the
 * app shell merely because their transcripts changed.
 */
export class LiveChatLedger {
  private snapshot: LiveChatSnapshot[] = emptyChats;
  private byId = new Map<string, LiveChatSnapshot>();
  private listeners = new Map<string, Set<() => void>>();
  private allListeners = new Set<() => void>();
  private pending = new Set<string>();
  private frame: number | null = null;

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => emptyChats;
  getChat = (id: string) => this.byId.get(id);

  subscribe = (listener: () => void) => {
    this.allListeners.add(listener);
    return () => { this.allListeners.delete(listener); };
  };

  subscribeChat(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) || new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }

  replace(chats: LiveChatSnapshot[]) {
    if (chats === this.snapshot) return;
    const next = new Map(chats.map(chat => [chat.id, chat]));
    for (const id of this.listeners.keys()) {
      if (this.byId.get(id) !== next.get(id)) this.pending.add(id);
    }
    this.snapshot = chats;
    this.byId = next;
    if (this.frame !== null || (!this.pending.size && !this.allListeners.size)) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      const pending = this.pending;
      this.pending = new Set();
      const notify = new Set(this.allListeners);
      for (const id of pending) this.listeners.get(id)?.forEach(listener => notify.add(listener));
      notify.forEach(listener => listener());
    });
  }

  cancelPendingPaint() {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pending.clear();
  }
}

export function useLiveChat(ledger: LiveChatLedger | undefined, id: string) {
  const subscribe = useCallback((listener: () => void) =>
    ledger ? ledger.subscribeChat(id, listener) : noSubscription(), [ledger, id]);
  const read = useCallback(() => ledger?.getChat(id), [ledger, id]);
  return useSyncExternalStore(subscribe, read, () => undefined);
}

export function useLiveChats(ledger: LiveChatLedger | undefined, enabled: boolean) {
  return useSyncExternalStore(
    enabled && ledger ? ledger.subscribe : noSubscription,
    enabled && ledger ? ledger.getSnapshot : () => emptyChats,
    ledger?.getServerSnapshot || (() => emptyChats),
  );
}

/** Keep every metadata field, but never make transcript bytes a shell prop. */
export function projectChatMetadata<T extends LiveChatSnapshot>(previous: T[], next: T[]): T[] {
  const previousById = new Map(previous.map(chat => [chat.id, chat]));
  let changed = previous.length !== next.length;
  const projected = next.map((chat, index) => {
    const prior = previousById.get(chat.id);
    const keys = Object.keys(chat).filter(key => key !== 'traceLogs') as Array<keyof T>;
    const same = prior && keys.length === Object.keys(prior).filter(key => key !== 'traceLogs').length &&
      keys.every(key => Object.is(prior[key], chat[key]));
    const metadata = same ? prior : { ...chat, traceLogs: emptyLogs };
    if (metadata !== previous[index]) changed = true;
    return metadata;
  });
  return changed ? projected : previous;
}
