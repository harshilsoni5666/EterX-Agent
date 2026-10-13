'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

type Position = { top: number; left: number };

export function useWorkspaceReadingPosition(scroll: RefObject<HTMLElement>, path: string, mode: string, ready: boolean, active: boolean) {
  const key = `${path}\0${mode}`;
  const positions = useRef(new Map<string, Position>());
  const current = useRef({ key, active });
  const pending = useRef<string | null>(key);
  const save = useCallback(() => {
    const node = scroll.current, view = current.current;
    if (!node || !view.active || pending.current) return;
    positions.current.delete(view.key);
    positions.current.set(view.key, { top: node.scrollTop, left: node.scrollLeft });
    while (positions.current.size > 48) positions.current.delete(positions.current.keys().next().value!);
  }, [scroll]);

  useLayoutEffect(() => {
    if (current.current.key !== key || (active && !current.current.active)) pending.current = key;
    current.current = { key, active };
    if (!active || !ready || pending.current !== key) return;
    // A cached file is installed in a layout effect. Restore only after that
    // render, never against the previous file or a temporary loading surface.
    const frame = requestAnimationFrame(() => {
      if (current.current.key !== key || !current.current.active) return;
      scroll.current?.scrollTo({ ...(positions.current.get(key) || { top: 0, left: 0 }), behavior: 'auto' });
      pending.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [key, active, ready, scroll]);

  useEffect(() => {
    const node = scroll.current;
    node?.addEventListener('scroll', save, { passive: true });
    return () => node?.removeEventListener('scroll', save);
  }, [save, scroll]);
  return save;
}
