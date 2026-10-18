'use client';

import { useMemo, useRef } from 'react';

/** Unrelated stream rows must not invalidate a workspace's derived data. */
export function useTraceSelection<T>(logs: T[], include: (log: T) => boolean): T[] {
  const previous = useRef<T[]>([]);
  return useMemo(() => {
    const next = logs.filter(include);
    if (next.length === previous.current.length && next.every((log, index) => log === previous.current[index])) {
      return previous.current;
    }
    previous.current = next;
    return next;
  }, [logs, include]);
}
