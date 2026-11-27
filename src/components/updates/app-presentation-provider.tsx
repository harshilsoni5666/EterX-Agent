'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  decodePresentation, isRecord, modelIdentity, type Announcement, type BadgeRow, type ModelBadge,
} from '../../lib/app-presentation/contract';
import { AnnouncementDialog } from './announcement-dialog';
import { ModelBadgesContext, PausedProvidersContext } from './model-badges';

const ENDPOINT = '/api/app-presentation';
const SEEN_PREFIX = 'eterx:announcement:';
const EMPTY_BADGES: BadgeRow[] = [];

async function claim(id: string) {
  const desktop = (window as Window & { electronAPI?: { getRendererPreferences?: unknown } }).electronAPI;
  if (typeof desktop?.getRendererPreferences === 'function') {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Could not save announcement receipt.');
    const result: unknown = await response.json();
    return isRecord(result) && result.claimed === true;
  }
  const mark = () => {
    const key = SEEN_PREFIX + id;
    if (localStorage.getItem(key) !== null) return false;
    localStorage.setItem(key, 'seen');
    return true;
  };
  return typeof navigator.locks?.request === 'function'
    ? navigator.locks.request(SEEN_PREFIX + id, mark)
    : mark();
}

export function AppPresentationProvider({ children }: { children: ReactNode }) {
  const [badges, setBadges] = useState(EMPTY_BADGES);
  const [paused, setPaused] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const map = useMemo(() => {
    const value = new Map<string, readonly ModelBadge[]>();
    for (const row of badges) {
      const model = modelIdentity(row.provider, row.modelId);
      if (model) value.set(model.key, row.badges);
    }
    return value;
  }, [badges]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let nextAt = 0;
    let request: AbortController | undefined;
    let current: Announcement | null = null;
    let pendingReceipt = false;
    let badgeSignature = '[]';
    let providerSignature = '';
    const claimed = new Set<string>();
    const visible = () => document.visibilityState === 'visible';

    async function offerAnnouncement() {
      const next = current;
      if (!active || !next || !visible() || !document.hasFocus() || pendingReceipt || claimed.has(next.id) || Date.now() >= nextAt) return;
      pendingReceipt = true;
      try {
        const first = await claim(next.id);
        claimed.add(next.id);
        if (first && active && current?.id === next.id) setAnnouncement(current);
      } catch {
        // Leave an unclaimed announcement eligible after a temporary storage or network failure.
      } finally {
        pendingReceipt = false;
        if (current && current.id !== next.id) void offerAnnouncement();
      }
    }

    function schedule(delay: number) {
      window.clearTimeout(timer);
      if (active && visible()) timer = window.setTimeout(() => { void refresh(); }, delay);
    }

    async function refresh() {
      if (!active || !visible() || request) return;
      if (Date.now() < nextAt) {
        schedule(nextAt - Date.now());
        void offerAnnouncement();
        return;
      }
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch(ENDPOINT, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
        });
        if (!response.ok) throw new Error('App updates could not load.');
        const envelope: unknown = await response.json();
        if (!isRecord(envelope) || typeof envelope.refreshAfterMs !== 'number' || !Number.isFinite(envelope.refreshAfterMs)) {
          throw new Error('Invalid app update response.');
        }
        const data = decodePresentation(envelope.data);
        if (!data) throw new Error('Invalid app presentation.');
        if (!active) return;
        nextAt = Date.now() + Math.max(1_000, Math.min(3_650_000, envelope.refreshAfterMs));
        const signature = JSON.stringify(data.badges);
        if (signature !== badgeSignature) {
          badgeSignature = signature;
          setBadges(data.badges);
        }
        const nextProviders = data.disabledProviders.join(',');
        if (nextProviders !== providerSignature) {
          providerSignature = nextProviders;
          setPaused(new Set(data.disabledProviders));
        }
        const available = envelope.announcementsCurrent === true ? data.announcement : null;
        current = available;
        setAnnouncement(shown => shown?.id === available?.id ? available : null);
        void offerAnnouncement();
      } catch {
        if (!active) return;
        current = null;
        setAnnouncement(null);
        nextAt = Date.now() + 30_000 + Math.floor(Math.random() * 10_000);
      } finally {
        request = undefined;
        schedule(Math.max(1_000, nextAt - Date.now()));
      }
    }

    function resume() {
      if (visible()) void refresh();
      else window.clearTimeout(timer);
    }
    function reconnect() {
      nextAt = 0;
      resume();
    }
    schedule(200 + Math.floor(Math.random() * 1_200));
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', reconnect);
    return () => {
      active = false;
      request?.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', reconnect);
    };
  }, []);

  return (
    <PausedProvidersContext.Provider value={paused}>
      <ModelBadgesContext.Provider value={map}>
        {children}
        {announcement && <AnnouncementDialog key={announcement.id} announcement={announcement} dismiss={() => setAnnouncement(null)} />}
      </ModelBadgesContext.Provider>
    </PausedProvidersContext.Provider>
  );
}
