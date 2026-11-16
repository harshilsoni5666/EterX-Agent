'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import { Shimmer } from '../ui/shimmer';

type PendingMode = 'startup' | 'waiting' | 'group';
type PendingLabel = 'Starting your task' | 'Thinking' | 'Working' | null;

const randomDelay = (min: number, max: number) => min + Math.random() * (max - min);
const initialLabel = (mode: PendingMode): PendingLabel =>
  mode === 'startup' ? 'Starting your task' : mode === 'waiting' ? null : 'Working';

/** Presentation-only timers; real activity always owns whether this is active. */
export function useLiveFallbackLabel(active: boolean, mode: PendingMode, activityVersion = '') {
  const [label, setLabel] = useState<PendingLabel>(() => initialLabel(mode));
  const startupHasReachedThinking = useRef(false);

  useLayoutEffect(() => {
    if (!active) {
      setLabel(null);
      return;
    }

    let current = mode === 'startup' && startupHasReachedThinking.current
      ? 'Thinking' as PendingLabel
      : mode === 'group'
      ? (Math.random() < 0.5 ? 'Thinking' : 'Working') as PendingLabel
      : initialLabel(mode);
    setLabel(current);
    let remaining = mode === 'group'
      ? randomDelay(6000, 12000)
      : mode === 'startup'
        ? randomDelay(2000, 3000)
        : randomDelay(1000, 3000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline = 0;
    let finished = false;

    const schedule = () => {
      if (finished || !isAppVisible() || timer !== undefined) return;
      deadline = performance.now() + remaining;
      timer = setTimeout(() => {
        timer = undefined;
        if (mode === 'startup') {
          startupHasReachedThinking.current = true;
          current = 'Thinking';
          setLabel(current);
          finished = true;
          return;
        }
        current = current === 'Thinking' ? 'Working' : 'Thinking';
        setLabel(current);
        // Longer gaps elsewhere alternate at a calm, variable cadence rather
        // than on every poll.
        remaining = randomDelay(6000, 12000);
        schedule();
      }, remaining);
    };
    const syncVisibility = () => {
      if (timer !== undefined) {
        remaining = Math.max(0, deadline - performance.now());
        clearTimeout(timer);
        timer = undefined;
      }
      schedule();
    };
    const unsubscribe = subscribeAppVisibility(syncVisibility);
    schedule();
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [active, mode, activityVersion]);

  return active ? label : null;
}

export function LivePendingIndicator({ mode, activityVersion, className = '' }: {
  mode: 'startup' | 'waiting';
  activityVersion?: string;
  className?: string;
}) {
  const label = useLiveFallbackLabel(true, mode, activityVersion);
  if (!label) return null;

  return (
    <div
      className={`eterx-live-working-indicator eterx-live-feed-arrival flex h-6 w-fit max-w-full items-center ${className}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="eterx-thought-state-label">
        <Shimmer
          durationMs={2400}
          className="eterx-thinking-shimmer min-w-0 truncate text-[15px] font-medium leading-[1.45] tracking-[-0.01em] text-[var(--eterx-ui-working-text)]"
        >
          {label}
        </Shimmer>
      </span>
    </div>
  );
}
