'use client';

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ChevronsUpDown, ChevronsDownUp, Files, ExternalLink, X } from 'lucide-react';
import { useFilePanelOwner } from '../../contexts/FilePanelContext';
import { addWorkspaceTab, type WorkspaceTab } from '../../lib/side-workspace-store';
import { collectTurnChanges, type TurnFileChange } from '../../lib/turn-changes';
import { workspaceChatDiffLines } from '../../lib/workspace-review-data';
import { HighlightedDiffCode, useDiffSyntax } from './diff-syntax';
import { FileCodeCorner, SquareSplitHorizontal } from './workspace-icons';
import { WorkspaceFileIcon } from './workspace-file-icon';
import type { FilePanelProps } from './file-panel';
import { LocalFileWorkspaceContext } from './local-file-link';

function ChangeFileIcon({ path }: { path: string }) {
  return <span className="eterx-change-file-icon" aria-hidden="true"><WorkspaceFileIcon path={path} size={17} /></span>;
}

function ChangeCounts({ files }: { files: FilePanelProps[] }) {
  const known = files.some(file => file.linesAdded != null || file.linesRemoved != null);
  if (!known) return <span className="eterx-turn-change-muted">File changed</span>;
  return <span className="eterx-turn-change-counts" aria-label="Lines added and removed">
    <span>+{files.reduce((sum, file) => sum + (file.linesAdded || 0), 0)}</span>
    <span>−{files.reduce((sum, file) => sum + (file.linesRemoved || 0), 0)}</span>
    {files.some(file => file.linesAdded == null && file.linesRemoved == null) && <small title="Some files have no recorded line counts">+ other files</small>}
  </span>;
}

function RecordedDiff({ file, compact }: { file: FilePanelProps; compact?: boolean }) {
  const [limit, setLimit] = useState(compact ? 300 : 1200);
  const lines = useMemo(() => workspaceChatDiffLines(file, false), [file]);
  const visible = useMemo(() => lines.slice(0, limit), [lines, limit]);
  const syntax = useDiffSyntax(visible, file.filepath, file.language);
  return <>
    {lines.length ? <div className="eterx-turn-diff-lines">
      {visible.map((line, index) => line.isGap ? <div key={index} className="eterx-turn-diff-gap">{line.skipped || 'Some'} unchanged lines omitted</div> :
        <div key={index} className="eterx-turn-diff-line" data-kind={line.type}>
          {!compact && <span className="eterx-turn-diff-number">{line.oldLine ?? ''}</span>}
          <span className="eterx-turn-diff-number">{compact && line.type === 'removed' ? line.oldLine ?? '' : line.newLine ?? ''}</span>
          <span className="eterx-turn-diff-sign">{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</span>
          <code><HighlightedDiffCode line={line} tokens={syntax?.get(line)} /></code>
        </div>)}
    </div> : <p className="eterx-turn-diff-notice">This file changed, but no text diff was recorded. Documents and binary files may not have a text preview.</p>}
    {lines.length > limit && <button className="eterx-turn-change-more" onClick={() => setLimit(value => value + 1200)}>Show more diff lines ({lines.length - limit} remaining)</button>}
    {file.truncated && <p className="eterx-turn-diff-notice">This recorded preview is incomplete.</p>}
  </>;
}

function FileChanges({ file, compact }: { file: TurnFileChange; compact?: boolean }) {
  const [revisionLimit, setRevisionLimit] = useState(5);
  const revisions = file.revisions.length ? file.revisions : [file];
  return <>{revisions.slice(0, revisionLimit).map((revision, index) => <React.Fragment key={index}>
    {revisions.length > 1 && <div className="eterx-turn-diff-revision">Edit {index + 1} of {revisions.length}<ChangeCounts files={[revision]} /></div>}
    <RecordedDiff file={revision} compact={compact} />
  </React.Fragment>)}{revisions.length > revisionLimit && <button className="eterx-turn-change-more" onClick={() => setRevisionLimit(value => value + 5)}>Show more edits ({revisions.length - revisionLimit} remaining)</button>}</>;
}

function FileLabel({ file, inline = false }: { file: FilePanelProps; inline?: boolean }) {
  const parts = file.filepath.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts.pop() || file.filename;
  return <span className={`eterx-turn-file-label${inline ? ' is-inline' : ''}`} aria-label={file.filepath} title={file.filepath}><strong>{name}</strong>{parts.length > 0 && <small>{inline ? file.filepath.replace(/\\/g, '/').slice(0, -name.length) : parts.slice(-2).join('/') + '/'}</small>}</span>;
}

export function TurnChangesCard({ logs, turnId }: { logs: any[]; turnId: string }) {
  const owner = useFilePanelOwner();
  const workspacePath = React.useContext(LocalFileWorkspaceContext);
  const files = useMemo(() => collectTurnChanges(logs, workspacePath), [logs, workspacePath]);
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState<{ file: TurnFileChange; anchor: HTMLElement } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const candidate = useRef<{ file: TurnFileChange; anchor: HTMLElement; x: number; y: number } | null>(null);
  const blockedAnchor = useRef<HTMLElement | null>(null);
  const focusPreview = useRef(false);
  const popupId = useId();
  const listId = useId();
  const cancelOpen = () => clearTimeout(openTimer.current);
  const keep = () => clearTimeout(closeTimer.current);
  const dismiss = () => {
    cancelOpen(); keep();
    focusPreview.current = false;
    blockedAnchor.current = candidate.current?.anchor || hover?.anchor || null;
    if (hover && popup.current?.contains(document.activeElement)) hover.anchor.focus({ preventScroll: true });
    candidate.current = null;
    setHover(null);
  };
  const schedule = (file: TurnFileChange, anchor: HTMLElement, delay = 650) => {
    cancelOpen(); keep();
    if (blockedAnchor.current === anchor) return;
    openTimer.current = setTimeout(() => {
      if (!anchor.isConnected || !document.hasFocus() || document.visibilityState === 'hidden' || document.getSelection()?.toString()) return;
      setPosition(null);
      setHover({ file, anchor });
    }, delay);
  };
  const leave = () => {
    cancelOpen(); keep(); candidate.current = null;
    focusPreview.current = false;
    closeTimer.current = setTimeout(() => {
      if (popup.current?.contains(document.activeElement)) return;
      setHover(null);
    }, 350);
  };
  useEffect(() => {
    const onScroll = (event: Event) => {
      if (popup.current?.contains(event.target as Node)) return;
      cancelOpen(); keep();
      blockedAnchor.current = candidate.current?.anchor || null;
      candidate.current = null; setHover(null);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => { cancelOpen(); keep(); window.removeEventListener('scroll', onScroll, true); };
  }, []);
  useLayoutEffect(() => {
    if (!hover) return;
    const feed = hover.anchor.closest<HTMLElement>('.eterx-chat-feed-scroll');
    const card = hover.anchor.closest<HTMLElement>('.eterx-turn-changes-card');
    const topbar = document.querySelector<HTMLElement>('.eterx-global-topbar');
    const place = () => {
      if (!hover.anchor.isConnected || !popup.current) { setHover(null); return; }
      const rect = hover.anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const vw = viewport?.width || window.innerWidth, vh = viewport?.height || window.innerHeight;
      const ox = viewport?.offsetLeft || 0, oy = viewport?.offsetTop || 0;
      const feedRect = feed?.getBoundingClientRect();
      const cardRect = card?.getBoundingClientRect();
      // Native caption controls draw above DOM portals. Keep their entire
      // strip outside our bounds, even when the window is resized or zoomed.
      const captionHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--eterx-shell-topbar-height')) || 36;
      const safeTop = Math.max(oy, topbar?.getBoundingClientRect().bottom ?? captionHeight, feedRect?.top ?? 0) + 10;
      const safeBottom = Math.min(oy + vh, feedRect?.bottom ?? oy + vh) - 10;
      const safeLeft = Math.max(ox, feedRect?.left ?? ox) + 10;
      const safeRight = Math.min(ox + vw, feedRect?.right ?? ox + vw) - 10;
      const availableWidth = safeRight - safeLeft;
      const above = Math.max(0, rect.top - safeTop - 8);
      const below = Math.max(0, safeBottom - rect.bottom - 8);
      // In a very small window the full Changes panel is still available.
      // Do not cover the trigger or window controls to force a hover open.
      if (availableWidth < 220 || Math.max(above, below) < 140 || rect.bottom <= safeTop || rect.top >= safeBottom) {
        blockedAnchor.current = hover.anchor; setHover(null); return;
      }
      const width = Math.min(600, availableWidth, Math.max(320, cardRect?.width || rect.width));
      const scroller = popup.current.querySelector<HTMLElement>('.eterx-turn-diff-scroll');
      const heading = popup.current.querySelector<HTMLElement>('.eterx-turn-diff-heading');
      const footer = popup.current.lastElementChild as HTMLElement | null;
      const naturalHeight = (scroller?.scrollHeight || 100) + (heading?.offsetHeight || 52) + (footer?.offsetHeight || 34) + 2;
      const desiredHeight = Math.min(320, naturalHeight);
      const useAbove = above >= desiredHeight || above >= below;
      const maxHeight = Math.min(320, useAbove ? above : below);
      const height = Math.min(naturalHeight, maxHeight);
      const next = { width, maxHeight, left: Math.max(safeLeft, Math.min(cardRect?.left ?? rect.left, safeRight - width)), top: useAbove ? rect.top - height - 8 : rect.bottom + 8 };
      setPosition(previous => previous && Object.entries(next).every(([key, value]) => Math.abs(previous[key as keyof typeof next] - value) < .5) ? previous : next);
    };
    place();
    if (focusPreview.current) { focusPreview.current = false; popup.current?.focus({ preventScroll: true }); }
    const resize = new ResizeObserver(place);
    for (const element of [hover.anchor, feed, card, topbar, popup.current, popup.current?.querySelector('.eterx-turn-diff-scroll')]) if (element) resize.observe(element);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    const outside = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node) && !hover.anchor.contains(event.target as Node)) dismiss(); };
    const blur = () => dismiss();
    window.addEventListener('resize', place); window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place); window.addEventListener('blur', blur);
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { resize.disconnect(); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); window.removeEventListener('blur', blur); document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, [hover]);
  if (!files.length) return null;
  const open = (selected?: string) => {
    if (!owner) return;
    dismiss();
    addWorkspaceTab(owner, 'changes', { changes: { id: turnId, files, selected }, title: 'Changes' });
  };
  const previewEvents = (file: TurnFileChange) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType !== 'mouse' || event.buttons) return;
      candidate.current = { file, anchor: event.currentTarget, x: event.clientX, y: event.clientY };
      schedule(file, event.currentTarget);
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      const pending = candidate.current;
      if (!pending || hover?.anchor === event.currentTarget || event.buttons) return;
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 6) {
        pending.x = event.clientX; pending.y = event.clientY;
        schedule(file, event.currentTarget);
      }
    },
    onPointerLeave: (event: React.PointerEvent<HTMLButtonElement>) => { if (blockedAnchor.current === event.currentTarget) blockedAnchor.current = null; leave(); },
    onPointerDown: cancelOpen,
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); blockedAnchor.current = null; focusPreview.current = true; schedule(file, event.currentTarget, 0); }
      else if (event.key === 'Escape') dismiss();
    },
    onBlur: (event: React.FocusEvent<HTMLButtonElement>) => { if (!popup.current?.contains(event.relatedTarget as Node)) leave(); },
    'aria-controls': hover?.file.filepath === file.filepath ? popupId : undefined,
    'aria-expanded': hover?.file.filepath === file.filepath,
    'aria-keyshortcuts': 'ArrowDown',
  });
  return <section className="eterx-turn-changes-card" aria-label="Changes from this query" data-copy-exclude="true">
    <div className="eterx-turn-changes-summary">
      <button className="eterx-turn-changes-title" aria-expanded={expanded} aria-controls={listId} onClick={() => { dismiss(); setExpanded(value => !value); }}>
        <strong>{files.length} {files.length === 1 ? 'file' : 'files'} changed</strong>
        <ChangeCounts files={files} />
        <ChevronRight size={14} aria-hidden="true" style={{ transform: expanded ? 'rotate(90deg)' : undefined }} />
      </button>
      <button className="eterx-turn-changes-open" disabled={!owner} onClick={() => open()} aria-label="Review changes"><Files size={15} strokeWidth={1.65} /><span>Review</span></button>
    </div>
    <div id={listId} hidden={!expanded} className="eterx-turn-changes-files eterx-scrollbar">
      {expanded && files.map(file => <button key={file.filepath} className="eterx-turn-changes-file" onClick={() => open(file.filepath)} {...previewEvents(file)}>
        <ChangeFileIcon path={file.filepath} /><FileLabel file={file} inline />
      </button>)}
    </div>
    {hover && typeof document !== 'undefined' && createPortal(<div ref={popup} id={popupId} role="region" aria-label={'Recorded changes to ' + hover.file.filename} tabIndex={0} className="eterx-turn-changes-popup" style={{ left: position?.left ?? 0, top: position?.top ?? 0, width: position?.width ?? 360, maxHeight: position?.maxHeight ?? 320, visibility: position ? 'visible' : 'hidden' }} onPointerEnter={() => { cancelOpen(); keep(); }} onPointerLeave={leave} onFocus={keep} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) leave(); }}>
      <div className="eterx-turn-diff-heading"><ChangeFileIcon path={hover.file.filepath} /><FileLabel file={hover.file} /><ChangeCounts files={[hover.file]} /><button aria-label="Close changes preview" onClick={dismiss}><X size={15} /></button></div>
      <div className="eterx-turn-diff-scroll eterx-scrollbar"><FileChanges key={hover.file.filepath} file={hover.file} compact /></div>
      <button className="eterx-turn-change-more" onClick={() => open(hover.file.filepath)}>Open changes<SquareSplitHorizontal size={14} strokeWidth={1.65} /></button>
    </div>, document.body)}
  </section>;
}

export function WorkspaceTurnChanges({ owner, tab, isActive }: { owner: string; tab: WorkspaceTab; isActive: boolean }) {
  const changes = tab.changes;
  const [fileLimit, setFileLimit] = useState(10);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const scroll = useRef<HTMLDivElement>(null);
  const previousSelection = useRef<typeof changes>();
  const selectedIndex = changes?.files.findIndex(file => file.filepath === changes.selected) ?? -1;
  const visibleLimit = Math.max(fileLimit, selectedIndex + 1);
  useLayoutEffect(() => {
    if (!isActive || !changes || previousSelection.current === changes) return;
    previousSelection.current = changes;
    if (changes.selected) setCollapsed(current => { const next = new Set(current); next.delete(changes.selected!); return next; });
    const frame = requestAnimationFrame(() => {
      if (!scroll.current) return;
      const target = Array.from(scroll.current.querySelectorAll<HTMLElement>('[data-change-path]')).find(element => element.dataset.changePath === changes.selected);
      if (target) scroll.current.scrollTop += target.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top;
      else scroll.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [changes, isActive]);
  return <div className="eterx-turn-changes-panel">
    <div className="eterx-workspace-file-toolbar">
      <span className="eterx-turn-panel-scope">This reply</span>{changes && <><span className="eterx-turn-change-muted">{changes.files.length} {changes.files.length === 1 ? 'file' : 'files'}</span><ChangeCounts files={changes.files} />
        <span className="eterx-turn-panel-spacer" />
        <button title="Expand all files" aria-label="Expand all files" onClick={() => setCollapsed(new Set())}><ChevronsUpDown size={15} /></button>
        <button title="Collapse all files" aria-label="Collapse all files" onClick={() => setCollapsed(new Set(changes.files.map(file => file.filepath)))}><ChevronsDownUp size={15} /></button>
      </>}
    </div>
    <div ref={scroll} className="eterx-turn-changes-panel-scroll eterx-scrollbar">
      {!changes?.files.length ? <div className="eterx-workspace-empty"><FileCodeCorner size={30} strokeWidth={1.5} /><h3>No query selected</h3><p>Choose “Review” below a completed reply to see that query’s edits.</p></div> : changes.files.slice(0, visibleLimit).map(file => {
        const folded = collapsed.has(file.filepath);
        return <section key={file.filepath} data-change-path={file.filepath} className="eterx-turn-change-section">
          <div className="eterx-turn-diff-heading">
            <button className="eterx-turn-file-toggle" aria-expanded={!folded} aria-label={(folded ? 'Expand ' : 'Collapse ') + file.filename} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(file.filepath)) next.delete(file.filepath); else next.add(file.filepath); return next; })}>
              <ChevronRight size={14} style={{ transform: folded ? undefined : 'rotate(90deg)' }} /><ChangeFileIcon path={file.filepath} /><FileLabel file={file} />
            </button>
            <ChangeCounts files={[file]} /><button title="Open current file" aria-label={'Open current file: ' + file.filename} disabled={file.status === 'D'} onClick={() => addWorkspaceTab(owner, 'files', { path: file.filepath, title: file.filename })}><ExternalLink size={14} /></button>
          </div>
          {!folded && <div className="eterx-turn-diff-file-scroll eterx-scrollbar"><FileChanges file={file} /></div>}
        </section>;
      })}
      {changes && changes.files.length > visibleLimit && <button className="eterx-turn-change-more" onClick={() => setFileLimit(visibleLimit + 10)}>Show more files ({changes.files.length - visibleLimit} remaining)</button>}
    </div>
  </div>;
}
