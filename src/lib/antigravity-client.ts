'use client';

import { useSyncExternalStore } from 'react';
import type { AntigravityAction, AntigravityRequest, AntigravityState } from './antigravity-contract';

type DesktopAntigravity = (request: AntigravityRequest) => Promise<AntigravityState | null>;
const listeners = new Set<() => void>();
let snapshot: AntigravityState | null = null;
let catalog = '';
let nextRequest = 0;
let appliedRequest = 0;

export function desktopAntigravity(): DesktopAntigravity | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: { antigravityProvider?: DesktopAntigravity } }).electronAPI?.antigravityProvider;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const readAntigravityState = () => snapshot;

export function useAntigravity() {
  return useSyncExternalStore(subscribe, readAntigravityState, () => null);
}

export async function requestAntigravity(action: AntigravityAction, options?: Omit<AntigravityRequest, 'action'>) {
  const desktop = desktopAntigravity();
  if (!desktop) return null;
  const request = ++nextRequest;
  const result = await desktop({ ...options, action });
  if (!result?.revision) return null;
  if (result.revision === snapshot?.revision) return result;
  const [epoch, revision] = result.revision.split(':');
  const [currentEpoch, currentRevision] = snapshot?.revision.split(':') ?? [];
  if (epoch === currentEpoch ? Number(revision) < Number(currentRevision) : request < appliedRequest) return result;
  appliedRequest = Math.max(appliedRequest, request);
  snapshot = result;
  for (const listener of listeners) listener();
  const pending = (result.activity === 'signing-in' || result.activity === 'switching' || result.activity === 'refreshing') && !result.models.length;
  const nextCatalog = JSON.stringify([result.activeAccountId, result.models, result.capabilities, pending]);
  if (nextCatalog !== catalog) {
    catalog = nextCatalog;
    window.dispatchEvent(new CustomEvent('eterx-settings-updated', { detail: { type: 'antigravity-subscription-updated' } }));
  }
  return result;
}

export async function disconnectAntigravityAccounts() {
  let state = await requestAntigravity('disconnect-all');
  if (state?.activity !== 'signing-out' || state.activityAccountId !== null) return;
  while (state?.activity === 'signing-out' && state.activityAccountId === null) {
    state = await requestAntigravity('watch', { revision: state.revision });
  }
  if (state?.error) throw new Error(state.error);
}

export function watchAntigravity() {
  if (!desktopAntigravity()) return;
  let active = true;
  let timer: number | undefined;
  const follow = async () => {
    if (!active) return;
    let delay = 50;
    try {
      const state = await requestAntigravity('watch', { revision: snapshot?.revision });
      if (!state) delay = 2_000;
    } catch { delay = 2_000; }
    if (active) timer = window.setTimeout(follow, delay);
  };
  void follow();
  return () => {
    active = false;
    window.clearTimeout(timer);
  };
}
