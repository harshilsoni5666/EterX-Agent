'use client';

import { useEffect, type RefObject } from 'react';

const ACTIVITY_SURFACES = '.eterx-activity-panel, .eterx-thought-block, .eterx-terminal-trace, .eterx-file-change-trace, .eterx-action-group';

function scrollRange(element: HTMLElement) {
  const max = element.scrollHeight - element.clientHeight;
  if (max <= 1 || !/^(auto|scroll|overlay)$/.test(getComputedStyle(element).overflowY)) return null;
  return { top: Math.max(0, Math.min(max, element.scrollTop)), max };
}

/** Leave scrolling inside a child entirely native. Only a further wheel event
 * at its top or bottom hands control to the nearest parent that can move. */
export function useActivityScrollHandoff(feedRef: RefObject<HTMLDivElement | null>, onHandoff: () => void) {
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;

    const onWheel = (event: WheelEvent) => {
      // Preserve zoom, horizontal code/table navigation and other controls.
      if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey ||
          !Number.isFinite(event.deltaY) || event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('.eterx-chat-feed-scroll') !== feed || !target.closest(ACTIVITY_SURFACES)) return;

      let child: HTMLElement | null = null;
      let childRange: ReturnType<typeof scrollRange> = null;
      for (let node: Element | null = target; node && node !== feed; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue;
        const range = scrollRange(node);
        if (range) { child = node; childRange = range; break; }
      }
      if (!child || !childRange) return;

      const direction = Math.sign(event.deltaY);
      const available = direction > 0 ? childRange.max - childRange.top : childRange.top;
      // Do not split a gesture merely because it could cross the boundary.
      // Let the child reach its end first, including fractional scroll offsets.
      if (available > 1) return;

      let parent: HTMLElement | null = null;
      for (let node = child.parentElement; node; node = node.parentElement) {
        const range = scrollRange(node);
        if (range) {
          const room = direction > 0 ? range.max - range.top : range.top;
          if (room > 1) { parent = node; break; }
        }
        // Never transfer movement into another workspace or the window.
        if (node === feed) break;
      }
      if (!parent) return;

      const lineHeight = Number.parseFloat(getComputedStyle(parent).lineHeight) || 16;
      const unit = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? parent.clientHeight : 1;
      event.preventDefault();
      onHandoff();
      // Move one parent only, preserving wheel/trackpad deltas without adding
      // easing, jumping to an end, or queuing smooth-scroll animations.
      parent.scrollBy({ top: event.deltaY * unit, behavior: 'instant' });
      // Keep bubbling: the activity and chat still observe the reader's intent.
    };

    feed.addEventListener('wheel', onWheel, { passive: false });
    return () => feed.removeEventListener('wheel', onWheel);
  }, [feedRef, onHandoff]);
}
