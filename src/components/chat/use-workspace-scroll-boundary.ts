'use client';

import { useEffect, type RefObject } from 'react';

/** Keep the browser's native wheel/trackpad scrolling and momentum. CSS owns
 * scroll containment; bubbling gestures must not reach chat wheel handlers. */
export function useWorkspaceScrollBoundary(panel: RefObject<HTMLElement>) {
  useEffect(() => {
    const host = panel.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.defaultPrevented || !(event.target instanceof Element)) return;
      const boundary = event.target.closest<HTMLElement>('.eterx-workspace-retained-panel');
      if (!boundary || boundary.hidden || !host.contains(boundary)) return;
      event.stopPropagation();
    };
    host.addEventListener('wheel', onWheel, { passive: true });
    return () => host.removeEventListener('wheel', onWheel);
  }, [panel]);
}
