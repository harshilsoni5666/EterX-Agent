'use client';

import { useRef } from 'react';
import { updateWorkspaceTab } from '../../lib/side-workspace-store';

export function WorkspaceTreePane({ owner, tabId, width, full = false, children }: { owner: string; tabId: string; width?: number; full?: boolean; children: React.ReactNode }) {
  const pane = useRef<HTMLElement>(null);
  const drag = useRef<{ start: number; width: number; next: number }>();
  const bounded = (width: number) => Math.max(160, Math.min(width, (pane.current?.parentElement?.clientWidth || 600) - 180));
  const finish = (cancel = false) => {
    const current = drag.current; drag.current = undefined;
    if (!current || !pane.current) return;
    pane.current.style.width = (cancel ? current.width : current.next) + 'px';
    if (!cancel) updateWorkspaceTab(owner, tabId, { treeWidth: current.next });
  };
  return <aside ref={pane} className="eterx-workspace-tree" data-full={full} style={!full && width ? { width, maxWidth: 'calc(100% - 180px)' } : undefined}>
    {!full && <div className="eterx-workspace-tree-resize" role="separator" tabIndex={0} aria-label="Resize file tree" aria-orientation="vertical" aria-valuemin={160} aria-valuenow={width || 260}
      onDoubleClick={() => { if (pane.current) { pane.current.style.width = ''; pane.current.style.maxWidth = ''; } updateWorkspaceTab(owner, tabId, { treeWidth: undefined }); }}
      onKeyDown={event => { if (event.key === 'Escape') finish(true); else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); updateWorkspaceTab(owner, tabId, { treeWidth: bounded((pane.current?.clientWidth || 260) + (event.key === 'ArrowLeft' ? 20 : -20)) }); } }}
      onPointerDown={event => { if (event.button !== 0 || !pane.current) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { start: event.clientX, width: pane.current.clientWidth, next: pane.current.clientWidth }; }}
      onPointerMove={event => { if (!drag.current || !pane.current) return; drag.current.next = bounded(drag.current.width + drag.current.start - event.clientX); pane.current.style.maxWidth = 'calc(100% - 180px)'; pane.current.style.width = drag.current.next + 'px'; }}
      onPointerUp={event => { finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} />}
    {children}
  </aside>;
}
