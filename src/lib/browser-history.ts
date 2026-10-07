'use client';

import { appStorage, appStorageReady, flushAppStorage, isAppStorageLoaded, refreshAppStorage } from './client-storage';

export type BrowserHistoryItem = { url: string; title: string; favicon?: string; visitedAt: number };
export const BROWSER_HISTORY_KEY = 'eterx.workspace.browser.history.v2';
let historyRevision = 0;

function parseHistory(raw: string | null): BrowserHistoryItem[] {
  try {
    const entries: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(entries)) return [];
    return entries.filter((item): item is BrowserHistoryItem => item && typeof item.url === 'string' && /^https?:\/\//i.test(item.url))
      .slice(0, 100).map(item => ({ url: item.url, title: typeof item.title === 'string' ? item.title : item.url, favicon: typeof item.favicon === 'string' ? item.favicon : undefined, visitedAt: Number(item.visitedAt) || 0 }));
  } catch { return []; }
}

export function readBrowserHistory(): BrowserHistoryItem[] {
  return parseHistory(appStorage.getItem(BROWSER_HISTORY_KEY));
}

export async function loadBrowserHistory(): Promise<BrowserHistoryItem[]> {
  await appStorageReady;
  if (!isAppStorageLoaded()) await refreshAppStorage();
  if (isAppStorageLoaded() && appStorage.getItem(BROWSER_HISTORY_KEY) === null) {
    try {
      const legacy = localStorage.getItem(BROWSER_HISTORY_KEY);
      if (legacy !== null) {
        appStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(parseHistory(legacy)));
        if (await flushAppStorage()) localStorage.removeItem(BROWSER_HISTORY_KEY);
      }
    } catch { /* Native preferences work even if browser storage is disabled. */ }
  }
  return readBrowserHistory();
}

export async function recordBrowserHistory(item: BrowserHistoryItem): Promise<void> {
  const revision = historyRevision;
  await loadBrowserHistory();
  // Never overwrite durable history with a partial list after a failed read.
  if (revision !== historyRevision || !isAppStorageLoaded()) return;
  appStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify([item, ...readBrowserHistory().filter(entry => entry.url !== item.url)].slice(0, 100)));
}

export function clearBrowserHistory(): void {
  historyRevision++;
  // Persist an empty list so a later migration cannot resurrect cleared history.
  appStorage.setItem(BROWSER_HISTORY_KEY, '[]');
  try { localStorage.removeItem(BROWSER_HISTORY_KEY); } catch {}
}
