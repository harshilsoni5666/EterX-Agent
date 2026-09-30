import { useLayoutEffect, useRef } from 'react';
import { isAppVisible } from '../../lib/app-visibility';

/** Arrival polish only: never stage, buffer, fade out, or reorder content. */
export function useLiveFeedFlow(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const seenActionIdsRef = useRef(new Set<string>());
  activeRef.current = active;

  useLayoutEffect(() => {
    const root = ref.current;
    if (!active || !root || typeof MutationObserver === 'undefined') return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const seen = new WeakSet<Element>();
    const animations = new Set<Animation>();
    // Notes/thoughts already own their entrance. Animate only action rows so
    // a parent and child never fade together during a phase handoff.
    const rowSelector = '.eterx-terminal-trace-row, .eterx-file-change-row, .eterx-action-chip';
    const actionId = (row: Element) => row.closest('[data-feed-action-id]')?.getAttribute('data-feed-action-id');
    // Restored history is already present. Never replay entrances on opening
    // a conversation, changing its activity flag, or receiving another token.
    root.querySelectorAll(rowSelector).forEach(row => {
      seen.add(row);
      const id = actionId(row);
      if (id) seenActionIdsRef.current.add(id);
    });
    const observer = new MutationObserver(records => {
      if (!activeRef.current || !isAppVisible() || reducedMotion.matches) return;
      const arrivals = new Set<Element>();
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.matches(rowSelector)) arrivals.add(node);
          node.querySelectorAll(rowSelector).forEach(row => arrivals.add(row));
        }
      }
      for (const row of arrivals) {
        if (seen.has(row)) continue;
        seen.add(row);
        const id = actionId(row);
        if (id && seenActionIdsRef.current.has(id)) continue;
        if (id) seenActionIdsRef.current.add(id);
        if (row.closest('.eterx-live-feed-arrival')) continue;
        if (!activeRef.current || !isAppVisible() || reducedMotion.matches || !row.isConnected) continue;
        // Do not compound motion when both a group and its children arrive.
        let parent = row.parentElement;
        let parentArrived = false;
        while (parent && parent !== root) {
          if (arrivals.has(parent)) { parentArrived = true; break; }
          parent = parent.parentElement;
        }
        if (parentArrived || animations.size >= 3 || typeof row.animate !== 'function') continue;
        // Never force synchronous layout during streamed DOM updates. Opacity
        // is compositor-only and does not compete with scroll anchoring.
        const animation = row.animate(
          [{ opacity: 0.8 }, { opacity: 1 }],
          { duration: 120, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        );
        animations.add(animation);
        void animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    const cancelMotion = () => { if (reducedMotion.matches) animations.forEach(animation => animation.cancel()); };
    reducedMotion.addEventListener('change', cancelMotion);
    return () => {
      observer.disconnect();
      reducedMotion.removeEventListener('change', cancelMotion);
      animations.forEach(animation => animation.cancel());
    };
  }, [active]);
  return ref;
}
