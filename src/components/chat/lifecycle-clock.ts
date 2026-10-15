'use client';

import { useRef, useSyncExternalStore } from 'react';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';

const MIN_LIFECYCLE_EPOCH_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_SKEW_MS = 60_000;
const CLOCK_TICK_MS = 1_000;

let clockSnapshot = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let stopAppVisibility: (() => void) | null = null;
const clockSubscribers = new Set<() => void>();

const publishClockTick = () => {
  clockSnapshot = Date.now();
  clockSubscribers.forEach(listener => listener());
};

const syncClockVisibility = () => {
  if (!isAppVisible()) {
    if (clockTimer !== null) clearInterval(clockTimer);
    clockTimer = null;
  } else if (clockSubscribers.size > 0 && clockTimer === null) {
    publishClockTick();
    clockTimer = setInterval(publishClockTick, CLOCK_TICK_MS);
  }
};

const subscribeClock = (listener: () => void) => {
  clockSubscribers.add(listener);
  if (clockSubscribers.size === 1) {
    // Refresh immediately when the first live lifecycle becomes visible. The
    // module can remain mounted for hours with no active rows, so its cached
    // snapshot must not make the first painted elapsed value stale.
    clockSnapshot = Date.now();
    stopAppVisibility = subscribeAppVisibility(syncClockVisibility);
    syncClockVisibility();
  }
  return () => {
    clockSubscribers.delete(listener);
    if (clockSubscribers.size === 0) {
      if (clockTimer !== null) clearInterval(clockTimer);
      clockTimer = null;
      stopAppVisibility?.();
      stopAppVisibility = null;
    }
  };
};

const subscribeStatic = () => () => undefined;
const getClockSnapshot = () => clockSnapshot;
const getServerClockSnapshot = () => 0;

export const normalizeLifecycleTimestamp = (value: unknown): number | null => {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  let timestamp = raw < 10_000_000_000 ? raw * 1_000 : raw;
  while (timestamp > 10_000_000_000_000) timestamp /= 1_000;

  const now = Date.now();
  if (timestamp < MIN_LIFECYCLE_EPOCH_MS || timestamp > now + MAX_FUTURE_SKEW_MS) return null;
  return Math.round(timestamp);
};

const normalizeDuration = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return null;
  return duration;
};

export const resolveLifecycleDurationMs = ({
  active,
  startedAt,
  endedAt,
  durationMs,
  now = Date.now(),
}: {
  active: boolean;
  startedAt?: unknown;
  endedAt?: unknown;
  durationMs?: unknown;
  now?: number;
}): number | null => {
  const start = normalizeLifecycleTimestamp(startedAt);
  const end = normalizeLifecycleTimestamp(endedAt);
  const explicit = normalizeDuration(durationMs);

  // A running lifecycle is measured from its immutable start. Intermediate
  // snapshots occasionally carry a check-in duration; treating that as final
  // freezes the row until the next network update instead of showing reality.
  if (active && start !== null) {
    return Math.max(0, now - start);
  }

  // An executor's final measurement excludes transport/polling latency. Use
  // it before presentation timestamps, which may describe receipt of output.
  if (!active && explicit !== null) return explicit;

  // Otherwise use the immutable start/close boundary.
  if (!active && start !== null && end !== null && end >= start) {
    const measured = Math.max(0, end - start);
    return measured;
  }

  // Legacy traces without both boundaries can still use their duration.
  return explicit;
};

/**
 * One shared second clock for every visible live lifecycle. Ten concurrent
 * chats or many terminal/sub-agent rows still create only one browser timer;
 * settled rows unsubscribe and retain their immutable recorded duration.
 */
export const useLifecycleElapsedMs = ({
  active,
  startedAt,
  endedAt,
  durationMs,
  allowLiveFallback = true,
  lifecycleKey,
}: {
  active: boolean;
  startedAt?: unknown;
  endedAt?: unknown;
  durationMs?: unknown;
  allowLiveFallback?: boolean;
  lifecycleKey?: string;
}): number | null => {
  const normalizedStart = normalizeLifecycleTimestamp(startedAt);
  // A few adapters publish the live action before its timestamp metadata.
  // Falling back to their checkpoint duration freezes the visible timer until
  // another poll. Anchor that lifecycle once, locally, and retain the anchor
  // through its settlement frame; when the real immutable start arrives it
  // immediately becomes authoritative.
  const firstVisibleActiveAtRef = useRef<number | null>(null);
  const wasActiveRef = useRef(false);
  const observedSettlementRef = useRef<number | null>(null);
  const lifecycleKeyRef = useRef(lifecycleKey);
  if (lifecycleKeyRef.current !== lifecycleKey) {
    // A grouped disclosure keeps its component while its active segment
    // changes. Missing metadata must not reuse the preceding segment's clock.
    lifecycleKeyRef.current = lifecycleKey;
    firstVisibleActiveAtRef.current = null;
    wasActiveRef.current = false;
    observedSettlementRef.current = null;
  }
  if (allowLiveFallback && active && normalizedStart === null && firstVisibleActiveAtRef.current === null) {
    firstVisibleActiveAtRef.current = Date.now();
  } else if (normalizedStart !== null) {
    firstVisibleActiveAtRef.current = normalizedStart;
  }
  if (active) observedSettlementRef.current = null;
  else if (wasActiveRef.current) observedSettlementRef.current = Date.now();
  wasActiveRef.current = active;
  const now = useSyncExternalStore(
    active ? subscribeClock : subscribeStatic,
    getClockSnapshot,
    getServerClockSnapshot,
  );

  return resolveLifecycleDurationMs({
    active,
    startedAt: normalizedStart ?? firstVisibleActiveAtRef.current ?? startedAt,
    // Missing close metadata must not erase a timer that was already visible.
    // This fallback is only for a locally observed close, never restored rows.
    endedAt: normalizeLifecycleTimestamp(endedAt) ?? observedSettlementRef.current,
    durationMs,
    now: active ? now || Date.now() : Date.now(),
  });
};
