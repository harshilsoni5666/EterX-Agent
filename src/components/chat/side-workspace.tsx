'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { FolderOpen, GitBranch, GitFork, Globe, Loader2, Maximize2, Minimize2, Plus, TerminalSquare, X } from 'lucide-react';
import { addWorkspaceFolder, addWorkspaceTab, closeWorkspaceTab, resolveWorkspaceOwner, updateWorkspace, useSideWorkspace, type WorkspaceKind } from '../../lib/side-workspace-store';
import { createTerminal, showTerminal, useChatTerminalControls } from '../../lib/chat-terminal-store';
import { ChatTerminalDock } from './chat-terminal-dock';
import type { SideChatActions, SideChatSession } from './workspace-side-chat';
import type { LiveChatLedger } from '../../lib/live-chat-ledger';
import type { BrowserCapture } from './workspace-browser';
import { WorkspaceFileIcon, WorkspaceSiteIcon } from './workspace-file-icon';
import { FileCodeCorner, MessagesCircle } from './workspace-icons';
import { WorkspaceFiles } from './workspace-files';
import { WorkspaceBrowser } from './workspace-browser';
import { WorkspaceSideChat as SideChat } from './workspace-side-chat';
import { WorkspaceSubAgents, type WorkspaceSubAgentsProps } from './workspace-sub-agents';
import { WorkspaceReview } from './workspace-review';
import { useGitPreferences } from '../../lib/git/client';
import { WorkspaceTurnChanges } from './turn-changes';
import { collectWorkspaceReviewFiles, isWorkspaceReviewTrace } from '../../lib/workspace-review-data';
import { useTraceSelection } from '../../lib/use-trace-selection';
import { useWorkspaceRoots } from '../../lib/use-workspace-roots';
import { useWorkspaceScrollBoundary } from './use-workspace-scroll-boundary';
import { revealInWorkspaceScroller } from './workspace-scroll';

const workspaceChoices = [
  { kind: 'chat', title: 'Side chat', detail: 'Keep two conversations in view', icon: MessagesCircle, key: 'S' },
  { kind: 'subagents', title: 'Sub-Agents', detail: 'Follow agents and switch between their chats', icon: GitFork, key: 'A' },
  { kind: 'files', title: 'Files', detail: 'Explore your project and read files', icon: FolderOpen, key: 'F' },
  { kind: 'review', title: 'Review', detail: 'See the changes made in this chat', icon: FileCodeCorner, key: 'R' },
  { kind: 'git', title: 'Git', detail: 'Stage, commit, and manage your branches', icon: GitBranch, key: 'G' },
  { kind: 'terminal', title: 'Terminal', detail: 'Use your local shell', icon: TerminalSquare, key: 'T' },
  { kind: 'browser', title: 'Browser', detail: 'Open websites and preview your work', icon: Globe, key: 'B' },
] as const;
const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const Files = memo(WorkspaceFiles);
const Browser = memo(WorkspaceBrowser);
const Review = memo(WorkspaceReview);
const Git = dynamic(() => import('./workspace-git').then(module => module.WorkspaceGit), {
  ssr: false,
  loading: () => <div className="eterx-workspace-empty"><Loader2 size={22} className="animate-spin" /><p>Opening Git…</p></div>,
});
const emptyFolders: string[] = [];

export function SideWorkspace({ owner, mainChatId, workspacePath, traceLogs, chats, liveChatLedger, runningChats, actions, agentNavigation, onCapture }: { owner: string; mainChatId: string | null; workspacePath?: string | null; traceLogs: any[]; chats: SideChatSession[]; liveChatLedger?: LiveChatLedger; runningChats: Set<string>; actions: SideChatActions; agentNavigation: WorkspaceSubAgentsProps; onCapture: (capture: BrowserCapture, tabId: string) => Promise<void> }) {
  const state = useSideWorkspace(owner);
  const gitPreferences = useGitPreferences();
  const gitEnabled = gitPreferences.ready && gitPreferences.gitIntegration && gitPreferences.gitWorkspaceEnabled;
  const choices = useMemo(() => workspaceChoices.filter(choice => choice.kind !== 'git' || gitEnabled), [gitEnabled]);
  const reviewLogs = useTraceSelection(traceLogs, isWorkspaceReviewTrace);
  const reviewFiles = useMemo(() => collectWorkspaceReviewFiles(reviewLogs, owner), [reviewLogs, owner]);
  const openedPaths = useMemo(() => state.tabs.filter(tab => tab.kind === 'files' && tab.path).map(tab => tab.path!), [state.tabs]);
  const folderState = useWorkspaceRoots(owner, workspacePath, traceLogs, openedPaths, state.folders || emptyFolders);
  const addFolder = useCallback((path: string) => addWorkspaceFolder(owner, path), [owner]);
  const captureRef = useRef(onCapture);
  captureRef.current = onCapture;
  const capture = useCallback((value: BrowserCapture, tabId: string) => captureRef.current(value, tabId), []);
  const terminal = useChatTerminalControls(owner);
  const [menu, setMenu] = useState(false);
  const [nativeMenu, setNativeMenu] = useState(false);
  const [terminalRoot, setTerminalRoot] = useState(workspacePath);
  const panel = useRef<HTMLElement>(null);
  const [containerWidth, setContainerWidth] = useState(1000);
  const maxWorkspaceWidth = containerWidth - Math.min(320, containerWidth * .45);
  const minWorkspaceWidth = Math.min(260, maxWorkspaceWidth);
  useLayoutEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const measure = () => { if (parent.clientWidth) setContainerWidth(parent.clientWidth); };
    const observer = new ResizeObserver(measure); observer.observe(parent); measure();
    return () => observer.disconnect();
  }, []);
  useWorkspaceScrollBoundary(panel);
  const strip = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; width: number; next: number; max: number; frame: number }>(undefined);
  const active = state.tabs.find(tab => tab.id === state.activeId);
  useLayoutEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    parent.style.setProperty('--eterx-side-workspace-width', state.expanded ? '100%' : state.width === null ? '50%' : `${state.width}px`);
    parent.dataset.workspaceExpanded = String(state.expanded);
    return () => { parent.style.removeProperty('--eterx-side-workspace-width'); delete parent.dataset.workspaceExpanded; };
  }, [state.width, state.expanded]);
  const candidates = useMemo(() => {
    return folderState.roots;
  }, [folderState.roots]);
  const openTerminal = async () => {
    showTerminal(owner, 'right');
    let cwd = workspacePath;
    try { cwd = await (window as any).electronAPI?.workspaceFolderRoot({ workspacePath, candidates }) || cwd; } catch {}
    setTerminalRoot(cwd);
    if (!terminal.tabCount) {
      await createTerminal(resolveWorkspaceOwner(owner), cwd);
    }
  };
  const choose = (kind: WorkspaceKind) => { setMenu(false); addWorkspaceTab(owner, kind); if (kind === 'terminal') void openTerminal(); };
  const toggleMenu = async () => {
    if (menu) { setMenu(false); return; }
    const api = (window as any).electronAPI;
    if (active?.kind === 'browser' && api?.workspaceBrowserMenu) {
      const rect = menuRef.current?.getBoundingClientRect();
      if (!rect) return;
      setNativeMenu(true); setMenu(true);
      try {
        const kind = await api.workspaceBrowserMenu(active.id, { x: rect.left, y: rect.bottom + 5, gitEnabled });
        if (choices.some(choice => choice.kind === kind)) choose(kind as WorkspaceKind);
      } catch { /* A closed or restarting browser can dismiss its menu. */ }
      finally { setMenu(false); setNativeMenu(false); }
    } else { setNativeMenu(false); setMenu(true); }
  };
  useEffect(() => {
    if (!menu || nativeMenu) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu, nativeMenu]);
  useEffect(() => {
    const rail = strip.current;
    if (!rail) return;
    const sync = () => {
      rail.dataset.fadeLeft = String(rail.scrollLeft > 2);
      rail.dataset.fadeRight = String(rail.scrollWidth - rail.clientWidth - rail.scrollLeft > 2);
      for (const title of rail.querySelectorAll<HTMLElement>('[role="tab"] > span:not(.eterx-workspace-file-badge)')) title.dataset.overflow = String(title.scrollWidth > title.clientWidth + 1);
    };
    const observer = new ResizeObserver(sync); observer.observe(rail);
    for (const child of rail.children) observer.observe(child);
    rail.addEventListener('scroll', sync, { passive: true }); sync();
    const selected = rail.querySelector<HTMLElement>('[aria-selected="true"]');
    if (selected) revealInWorkspaceScroller(rail, selected);
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || rail.scrollWidth <= rail.clientWidth) return;
      event.stopPropagation();
      // Horizontal trackpad/Shift-wheel gestures are already native. Mapping
      // them a second time makes tabs move twice as far as the gesture.
      if (event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      rail.scrollBy({ left: event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rail.clientWidth : 1), behavior: 'auto' });
    };
    rail.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); rail.removeEventListener('scroll', sync); rail.removeEventListener('wheel', wheel); };
  }, [state.tabs, state.activeId]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.repeat) return;
      const choice = choices.find(choice => choice.key.toLowerCase() === event.key.toLowerCase());
      if (choice) { event.preventDefault(); choose(choice.kind); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [owner, workspacePath, terminal.tabCount, candidates, choices]);
  useEffect(() => () => { if (drag.current) cancelAnimationFrame(drag.current.frame); }, []);
  const finish = (cancel = false) => {
    const movement = drag.current;
    if (!movement || !panel.current) return;
    cancelAnimationFrame(movement.frame); drag.current = undefined;
    delete panel.current.dataset.workspaceResizing;
    delete panel.current.dataset.closeReady;
    panel.current.style.width = state.width === null ? '50%' : `${state.width}px`;
    panel.current.parentElement?.style.setProperty('--eterx-side-workspace-width', state.width === null ? '50%' : `${state.width}px`);
    if (!cancel) updateWorkspace(owner, movement.next < 100 ? { open: false } : { width: Math.max(260, movement.next) });
  };
  const openFile = useCallback((path: string, root?: string) => {
    if (!workspacePath && !path && root) addWorkspaceFolder(owner, root);
    return addWorkspaceTab(owner, 'files', { path, root, title: path ? name(path) : 'Files' });
  }, [owner, workspacePath]);
  useLayoutEffect(() => {
    if (!menu || !panel.current || !menuRef.current) return;
    const bounds = panel.current.getBoundingClientRect();
    const anchor = menuRef.current.getBoundingClientRect();
    panel.current.style.setProperty('--workspace-menu-left', `${Math.max(8, Math.min(bounds.width - 240, anchor.left - bounds.left))}px`);
  }, [menu]);
  return <aside ref={panel} className="eterx-side-workspace" data-expanded={state.expanded} style={{ width: state.expanded ? '100%' : state.width ?? '50%' }} aria-label="Side workspace">
    <div className="eterx-workspace-resize" role="separator" aria-label="Resize side workspace" aria-orientation="vertical" aria-valuemin={Math.round(minWorkspaceWidth)} aria-valuemax={Math.round(maxWorkspaceWidth)} aria-valuenow={Math.round(Math.max(minWorkspaceWidth, Math.min(maxWorkspaceWidth, state.width ?? containerWidth / 2)))} tabIndex={0}
      onDoubleClick={() => updateWorkspace(owner, { width: null, expanded: false })}
      onKeyDown={event => {
        if (!['Escape','Home','End','ArrowLeft','ArrowRight'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { finish(true); return; }
        const parent = panel.current?.parentElement?.clientWidth || 1000;
        const max = parent - Math.min(320, parent * .45), min = Math.min(260, max);
        const size = event.key === 'Home' ? min : event.key === 'End' ? max : Math.max(min, Math.min(max, (panel.current?.clientWidth || 480) + (event.key === 'ArrowLeft' ? 32 : -32)));
        updateWorkspace(owner, { width: size });
      }}
      onPointerDown={event => { if (event.button !== 0 || !panel.current) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); const width = panel.current.clientWidth; const parent = panel.current.parentElement?.clientWidth || 1000; drag.current = { start: event.clientX, width, next: width, max: parent - Math.min(320, parent * .45), frame: 0 }; panel.current.dataset.workspaceResizing = 'true'; }}
      onPointerMove={event => { const movement = drag.current; if (!movement) return; movement.next = Math.max(0, Math.min(movement.max, movement.width + movement.start - event.clientX)); if (!movement.frame) movement.frame = requestAnimationFrame(() => { movement.frame = 0; if (panel.current) { panel.current.style.width = `${movement.next}px`; panel.current.parentElement?.style.setProperty('--eterx-side-workspace-width', `${movement.next}px`); panel.current.dataset.closeReady = String(movement.next < 100); } }); }}
      onPointerUp={event => { finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} />
    <div className="eterx-workspace-toolbar" data-empty={!state.tabs.length}>
      
      <div ref={strip} className="eterx-workspace-tabs" role="tablist" aria-label="Workspace tabs">
        {state.tabs.map(tab => { const Icon = (tab.kind === 'changes' ? FileCodeCorner : workspaceChoices.find(choice => choice.kind === tab.kind)?.icon || FileCodeCorner); return <div key={tab.id} className={`eterx-workspace-tab ${state.activeId === tab.id ? 'is-active' : ''}`}><button role="tab" tabIndex={state.activeId === tab.id ? 0 : -1} aria-selected={state.activeId === tab.id} onClick={() => updateWorkspace(owner, { activeId: tab.id })} onKeyDown={event => { const index = state.tabs.indexOf(tab); if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + state.tabs.length) % state.tabs.length; updateWorkspace(owner, { activeId: state.tabs[next].id }); strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(); } }}><>{tab.kind === 'browser' ? <WorkspaceSiteIcon url={tab.favicon} /> : tab.kind === 'files' ? <WorkspaceFileIcon path={tab.path} /> : <Icon size={15} />}</><span>{tab.kind === 'chat' && tab.chatId ? chats.find(chat => chat.id === tab.chatId)?.title || tab.title : tab.title}</span>{tab.kind === 'chat' && tab.chatId && runningChats.has(tab.chatId) && <Loader2 size={13} className="animate-spin" />}</button><button aria-label={`Close ${tab.title}`} onClick={() => closeWorkspaceTab(owner, tab.id)}><X size={13} /></button></div>; })}
      </div>
      {state.tabs.length > 0 && <div ref={menuRef} className="eterx-workspace-add"><button aria-label="Add workspace tab" aria-haspopup="menu" aria-expanded={menu} onClick={() => void toggleMenu()}><Plus size={18} /></button>{menu && !nativeMenu && <div className="eterx-workspace-add-menu" role="menu" onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); menuRef.current?.querySelector('button')?.focus(); } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')); const index = items.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length; items[next]?.focus(); } }}>{choices.map(choice => <button role="menuitem" key={choice.kind} onClick={() => choose(choice.kind)}><choice.icon size={17} /><span>{choice.title}</span></button>)}</div>}</div>}
      <button aria-label={state.expanded ? 'Restore split view' : 'Expand workspace'} onClick={() => updateWorkspace(owner, { expanded: !state.expanded })}>{state.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      {state.expanded && <button aria-label="Hide workspace" onClick={() => updateWorkspace(owner, { open: false })}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M16 4v16" /></svg></button>}
    </div>
    <div className="eterx-workspace-content" role="tabpanel">
      {!active ? <div className="eterx-workspace-launcher eterx-scrollbar"><div className="eterx-workspace-launcher-grid">{choices.map(choice => <button key={choice.kind} onClick={() => choose(choice.kind)}><span className="eterx-workspace-launcher-icon"><choice.icon size={20} /></span><span><strong>{choice.title}</strong></span></button>)}</div></div>
        : active.kind === 'terminal' ? terminal.open && terminal.placement === 'right' ? <ChatTerminalDock chatId={owner} cwd={terminalRoot} embedded /> : <div className="eterx-workspace-empty"><TerminalSquare size={32} /><h3>Your terminal sessions</h3><p>{terminal.open ? 'The terminal is currently docked below the chat.' : 'Open your local shell in this workspace.'}</p><button onClick={() => void openTerminal()}>Open terminal here</button></div>
        : active.kind === 'browser' ? <Browser key={active.id} owner={owner} tab={active} occluded={menu && !nativeMenu} onCapture={capture} />
        : active.kind === 'subagents' ? <WorkspaceSubAgents key={active.id} {...agentNavigation} onSelect={agentId => { agentNavigation.onSelect(agentId); if (state.expanded) updateWorkspace(owner, { expanded: false }); }} />
        : active.kind === 'chat' ? <SideChat key={active.id} owner={owner} tab={active} chats={chats} liveChatLedger={liveChatLedger} mainChatId={mainChatId} runningChats={runningChats} actions={actions} /> : null}
      {state.tabs.filter(tab => tab.kind === 'files' || tab.kind === 'review' || tab.kind === 'changes' || tab.kind === 'git').map(tab => <div key={tab.id} className="eterx-workspace-retained-panel" hidden={tab.id !== state.activeId}>
        {tab.kind === 'git' ? <Git owner={owner} tab={tab} isActive={tab.id === state.activeId} workspacePath={workspacePath} roots={folderState.roots} rootsLoading={folderState.loading} rootError={folderState.error} onAddFolder={addFolder} onOpenFile={openFile} /> : tab.kind === 'changes' ? <WorkspaceTurnChanges key={tab.changes?.id || tab.id} owner={owner} tab={tab} isActive={tab.id === state.activeId} /> : tab.kind === 'files' ? <Files owner={owner} tab={tab} isActive={tab.id === state.activeId} workspacePath={workspacePath} roots={folderState.roots} rootsLoading={folderState.loading} rootError={folderState.error} onAddFolder={addFolder} onOpenFile={openFile} />
          : <Review owner={owner} tab={tab} isActive={tab.id === state.activeId} files={reviewFiles} workspacePath={workspacePath} roots={folderState.roots} rootsLoading={folderState.loading} rootError={folderState.error} onAddFolder={addFolder} onOpenFile={openFile} />}
      </div>)}
    </div>
  </aside>;
}
