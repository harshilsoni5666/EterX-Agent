import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronUp } from 'lucide-react';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';

/** One scroll boundary for an activity phase. Never clips or removes its history. */
export function ActivityViewport({ children, active, label, onInspect }: {
  children: React.ReactNode;
  active: boolean;
  label: string;
  onInspect?: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(active);
  const activeRef = useRef(active);
  const inspectRef = useRef(onInspect);
  const lastScrollTopRef = useRef(0);
  const disclosureFrameRef = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [edges, setEdges] = useState({ top: false, bottom: false, overflow: false });
  const viewportId = React.useId();
  activeRef.current = active;
  inspectRef.current = onInspect;

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const remaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    const next = {
      top: viewport.scrollTop > 2,
      bottom: remaining > 2,
      overflow: viewport.scrollHeight - viewport.clientHeight > 2,
    };
    setEdges(previous => previous.top === next.top && previous.bottom === next.bottom && previous.overflow === next.overflow ? previous : next);
  }, []);

  const pauseFollowing = useCallback(() => {
    followingRef.current = false;
    inspectRef.current?.();
  }, []);

  useLayoutEffect(() => () => {
    if (disclosureFrameRef.current !== null) window.cancelAnimationFrame(disclosureFrameRef.current);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let frame: number | null = null;
    const sync = () => {
      frame = null;
      if (!isAppVisible() || !viewport.isConnected) return;
      const selection = window.getSelection();
      const selecting = selection && !selection.isCollapsed && (
        content.contains(selection.anchorNode) || content.contains(selection.focusNode)
      );
      if (selecting) pauseFollowing();
      // A reader inspecting output keeps their position as later tools arrive.
      if (!expanded && activeRef.current && followingRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
        lastScrollTopRef.current = viewport.scrollTop;
      }
      measure();
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(sync);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(viewport);
    observer?.observe(content);
    const unsubscribe = subscribeAppVisibility(schedule);
    window.addEventListener('resize', schedule);
    sync();
    return () => {
      observer?.disconnect();
      unsubscribe();
      window.removeEventListener('resize', schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [expanded, measure, pauseFollowing]);

  const jumpToLatest = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followingRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
    lastScrollTopRef.current = viewport.scrollTop;
    // The button disappears at the end, so leave focus on the scroll region.
    viewport.focus({ preventScroll: true });
    measure();
  };

  const toggleExpanded = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    pauseFollowing();
    // Keep the clicked control in view when a long full history is shortened.
    const feed = viewport.closest<HTMLElement>('.eterx-chat-feed-scroll');
    const footerTop = footerRef.current?.getBoundingClientRect().top;
    setExpanded(value => !value);
    if (disclosureFrameRef.current !== null) window.cancelAnimationFrame(disclosureFrameRef.current);
    disclosureFrameRef.current = window.requestAnimationFrame(() => {
      disclosureFrameRef.current = null;
      if (!viewport.isConnected) return;
      if (expanded && feed?.isConnected && footerRef.current && footerTop !== undefined) {
        const shift = footerRef.current.getBoundingClientRect().top - footerTop;
        feed.scrollTop += shift;
      } else if (!expanded) {
        // Expanding moves the footer down. Keyboard navigation should continue
        // through the revealed history, not jump straight to its distant end.
        viewport.focus({ preventScroll: true });
      }
    });
  };

  return (
    <div className="eterx-activity-body" data-expanded={expanded ? 'true' : 'false'}>
      <div className="eterx-activity-scroll-frame">
        <div
          id={viewportId}
          ref={viewportRef}
          className="eterx-activity-viewport eterx-scrollbar"
          role="region"
          aria-label={label}
          tabIndex={edges.overflow && !expanded ? 0 : -1}
          onScroll={event => {
            const viewport = event.currentTarget;
            if (viewport.scrollTop < lastScrollTopRef.current - 1) pauseFollowing();
            const atEnd = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
            const selection = window.getSelection();
            if (atEnd && !contentRef.current?.contains(document.activeElement) && (!selection || selection.isCollapsed)) {
              followingRef.current = true;
            }
            lastScrollTopRef.current = viewport.scrollTop;
            measure();
          }}
          onWheelCapture={event => { if (event.deltaY < 0) pauseFollowing(); }}
          onTouchStart={pauseFollowing}
          onPointerDownCapture={pauseFollowing}
          onKeyDownCapture={event => {
            if (['ArrowUp', 'PageUp', 'Home', 'Enter', ' '].includes(event.key)) pauseFollowing();
          }}
          onFocusCapture={event => {
            if (event.target !== event.currentTarget) pauseFollowing();
          }}
        >
          <div ref={contentRef} className="eterx-activity-contents">{children}</div>
        </div>
        {!expanded && edges.top && <div className="eterx-activity-edge eterx-activity-edge-top" aria-hidden="true" />}
        {!expanded && edges.bottom && <div className="eterx-activity-edge eterx-activity-edge-bottom" aria-hidden="true" />}
      </div>
      {(edges.overflow || expanded) && (
        <div ref={footerRef} className="eterx-activity-footer">
          <button type="button" onClick={toggleExpanded} aria-expanded={expanded} aria-controls={viewportId}>
            {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            {expanded ? 'Compact view' : 'Show full activity'}
          </button>
          {!expanded && edges.bottom && (
            <button type="button" onClick={jumpToLatest}>
              <ArrowDown aria-hidden="true" />
              {active ? 'Latest activity' : 'Jump to end'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
