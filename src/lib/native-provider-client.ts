'use client';

import { useSyncExternalStore } from 'react';
import { NATIVE_PROVIDERS, type NativeProvider, type NativeProviderRequest, type NativeProviderSnapshot } from './native-provider-contract';

type Bridge = (request: NativeProviderRequest) => Promise<NativeProviderSnapshot | null>;
const subscribers = new Set<() => void>();
let snapshot: NativeProviderSnapshot | null = null;
let catalog = '';
let issued = 0;
let applied = 0;

export function desktopNativeProvider(): Bridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: { nativeProvider?: Bridge } }).electronAPI?.nativeProvider;
}

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
};
const onServer = () => null;
export const readNativeProviders = () => snapshot;
export const useNativeProviders = () => useSyncExternalStore(subscribe, readNativeProviders, onServer);

export async function requestNativeProvider(request: NativeProviderRequest) {
  const requestDesktop = desktopNativeProvider();
  if (!requestDesktop) return null;
  const order = ++issued;
  const result = await requestDesktop(request);
  if (!result?.revision || result.revision === snapshot?.revision) return result;
  const [epoch, version] = result.revision.split(':');
  const [currentEpoch, currentVersion] = snapshot?.revision.split(':') ?? [];
  if (epoch === currentEpoch ? Number(version) < Number(currentVersion) : order < applied) return result;
  applied = Math.max(applied, order);
  snapshot = result;
  for (const notify of subscribers) notify();
  const nextCatalog = JSON.stringify(NATIVE_PROVIDERS.map(provider => {
    const item = result.providers[provider];
    return [item.activeAccountId, item.models, !item.models.length && ['refresh', 'sign-in'].includes(item.activity || '')];
  }));
  if (nextCatalog !== catalog) {
    catalog = nextCatalog;
    window.dispatchEvent(new CustomEvent('eterx-settings-updated', { detail: { type: 'native-provider-updated' } }));
  }
  return result;
}

export function watchNativeProviders() {
  if (!desktopNativeProvider()) return;
  let watching = true;
  let timer: number | undefined;
  const next = async () => {
    let delay = 50;
    try {
      if (!await requestNativeProvider({ action: 'watch', revision: snapshot?.revision })) delay = 2000;
    } catch { delay = 2000; }
    if (watching) timer = window.setTimeout(next, delay);
  };
  void next();
  return () => { watching = false; window.clearTimeout(timer); };
}

export async function clearNativeProviderAccounts() {
  if (!desktopNativeProvider()) return;
  await Promise.all(NATIVE_PROVIDERS.map(async (provider: NativeProvider) => {
    let result = await requestNativeProvider({ action: 'clear', provider });
    while (result?.providers[provider]?.activity === 'clear') {
      result = await requestNativeProvider({ action: 'watch', revision: result.revision });
    }
    const error = result?.providers[provider]?.error;
    if (error) throw new Error(error);
  }));
}
