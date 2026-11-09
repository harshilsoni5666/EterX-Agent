'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { updateWorkspaceTab } from '../../lib/side-workspace-store';
import { revealInWorkspaceScroller } from './workspace-scroll';

export function WorkspaceTreePane({ owner, tabId, width, full = false, hidden = false, children }: { owner: string; tabId: string; width?: number; full?: boolean; hidden?: boolean; children: React.ReactNode }) {
  const pane = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState(600);
  const drag = useRef<{ start: number; width: number; next: number; frame: number }>(undefined);
  const minimum = 140;
  const maximum = Math.max(minimum, available - 240);
  const stacked = available <= 350;
  const bounded = (value: number) => Math.max(minimum, Math.min(value, maximum));
  const actualWidth = bounded(width ?? Math.min(320, available * .32));
  useLayoutEffect(() => {
    const parent = pane.current?.parentElement;
    if (!parent) return;
    const measure = () => { if (parent.clientWidth) setAvailable(parent.clientWidth); };
    const observer = new ResizeObserver(measure); observer.observe(parent); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => { if (drag.current) cancelAnimationFrame(drag.current.frame); }, []);
  const finish = (cancel = false) => {
    const current = drag.current; drag.current = undefined;
    if (!current || !pane.current) return;
    cancelAnimationFrame(current.frame);
    delete pane.current.dataset.resizing;
    pane.current.style.width = (cancel ? current.width : current.next) + 'px';
    if (!cancel) updateWorkspaceTab(owner, tabId, { treeWidth: current.next });
  };
  return <aside ref={pane} id={`workspace-tree-${tabId}`} hidden={hidden} className="eterx-workspace-tree" aria-label="File navigation" data-full={full} style={!full && !stacked ? { width: actualWidth, minWidth: minimum, maxWidth: maximum } : undefined}
    onKeyDown={event => {
      if (event.ctrlKey || event.metaKey || event.altKey || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-file-tree-item]');
      if (!target || !pane.current) return;
      const scroller = target.closest<HTMLElement>('.eterx-workspace-tree-scroll');
      if (!scroller) return;
      const items = Array.from(scroller.querySelectorAll<HTMLElement>('[data-file-tree-item]')).filter(item => item.getClientRects().length > 0);
      const index = items.indexOf(target);
      const focus = (item?: HTMLElement) => { if (item) { item.focus({ preventScroll: true }); revealInWorkspaceScroller(scroller, item); } };
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Home') focus(items[0]);
      else if (event.key === 'End') focus(items[items.length - 1]);
      else if (event.key === 'ArrowDown') focus(items[Math.min(items.length - 1, index + 1)]);
      else if (event.key === 'ArrowUp') focus(items[Math.max(0, index - 1)]);
      else {
        const details = target.tagName === 'SUMMARY' ? target.parentElement as HTMLDetailsElement : null;
        const directory = !!details || target.hasAttribute('aria-expanded');
        const expanded = details ? details.open : target.getAttribute('aria-expanded') === 'true';
        if (event.key === 'ArrowRight') { if (directory && !expanded) target.click(); else if (directory) focus(items[index + 1]); }
        else if (directory && expanded) target.click();
        else {
          const parent = target.closest('[role="group"]')?.parentElement;
          focus(parent?.querySelector<HTMLElement>(':scope > button[data-file-tree-item],:scope > summary[data-file-tree-item]') || undefined);
        }
      }
    }}>
    {!full && !stacked && <div className="eterx-workspace-tree-resize" role="separator" tabIndex={0} aria-label="Resize file tree" aria-orientation="vertical" aria-controls={`workspace-tree-${tabId}`} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(actualWidth)} aria-valuetext={`${Math.round(actualWidth)} pixels`}
      onDoubleClick={() => { if (pane.current) { pane.current.style.width = ''; pane.current.style.maxWidth = ''; } updateWorkspaceTab(owner, tabId, { treeWidth: undefined }); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true); }
        else if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const next = event.key === 'Home' ? minimum : event.key === 'End' ? maximum : bounded((pane.current?.clientWidth || actualWidth) + (event.key === 'ArrowLeft' ? 20 : -20));
          updateWorkspaceTab(owner, tabId, { treeWidth: next });
        }
      }}
      onPointerDown={event => { if (event.button !== 0 || !pane.current) return; event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); pane.current.dataset.resizing = 'true'; drag.current = { start: event.clientX, width: pane.current.clientWidth, next: pane.current.clientWidth, frame: 0 }; }}
      onPointerMove={event => {
        const movement = drag.current; if (!movement || !pane.current) return;
        movement.next = bounded(movement.width + movement.start - event.clientX);
        if (!movement.frame) movement.frame = requestAnimationFrame(() => { movement.frame = 0; if (pane.current) pane.current.style.width = movement.next + 'px'; });
      }}
      onPointerUp={event => { finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} />}
    {children}
  </aside>;
}
