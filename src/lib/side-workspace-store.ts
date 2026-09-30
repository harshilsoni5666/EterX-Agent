'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { compactWorkspaceRoots } from './workspace-paths';

export type WorkspaceKind = 'review' | 'terminal' | 'browser' | 'files' | 'chat';
export type WorkspaceReviewState = { scope: 'chat' | 'working' | 'branch'; selected: string; filter: string; expanded: boolean; split: boolean; showTree: boolean; root: string; wrap?: boolean; loadFull?: boolean; richPreview?: boolean; ignoreWhitespace?: boolean; wordDiffs?: boolean; viewed?: string[]; hideViewed?: boolean; compactFolders?: boolean; baseRefs?: Record<string, string> };
export type WorkspaceTab = { id: string; kind: WorkspaceKind; title: string; url?: string; favicon?: string; path?: string; root?: string; chatId?: string; chatHistory?: string[]; chatPosition?: number; review?: WorkspaceReviewState; reviewPathRequest?: number; treeWidth?: number };
type WorkspaceState = { open: boolean; width: number | null; expanded: boolean; tabs: WorkspaceTab[]; activeId: string | null; folders?: string[] };
const empty: WorkspaceState = { open: false, width: null, expanded: false, tabs: [], activeId: null };
const states = new Map<string, WorkspaceState>();
const transferredOwners = new Map<string, string>();
const disposedOwners = new Set<string>();
export function resolveWorkspaceOwner(owner: string): string {
  return transferredOwners.has(owner) ? resolveWorkspaceOwner(transferredOwners.get(owner)!) : owner;
}
const listeners = new Map<string, Set<() => void>>();
let browserEventsStop: (() => void) | undefined;
function observeBrowserTabs() {
  const api = typeof window === 'undefined' ? undefined : (window as any).electronAPI;
  if (browserEventsStop || !api?.onWorkspaceBrowserEvent) return;
  browserEventsStop = api.onWorkspaceBrowserEvent((event: { id: string; url?: string; title?: string; favicon?: string; openUrl?: string }) => {
    const owner = workspaceTabOwner(event.id);
    if (!owner) return;
    if (event.openUrl) { addWorkspaceTab(owner, 'browser', { url: event.openUrl }); return; }
    if (!event.url || event.url === 'about:blank') return;
    let hostname = event.url; try { hostname = new URL(event.url).hostname; } catch {}
    updateWorkspaceTab(owner, event.id, { url: event.url, title: event.title || hostname, favicon: event.favicon });
  });
}
function releaseBrowserEvents() {
  if ([...states.values()].some(state => state.tabs.some(tab => tab.kind === 'browser'))) return;
  browserEventsStop?.(); browserEventsStop = undefined;
}
const read = (owner: string) => states.get(resolveWorkspaceOwner(owner)) || empty;
const titles: Record<WorkspaceKind, string> = { review: 'Review', terminal: 'Terminal', browser: 'New browser', files: 'Files', chat: 'Side chat' };
function subscribe(owner: string, fn: () => void) {
  const set = listeners.get(owner) || new Set();
  listeners.set(owner, set); set.add(fn);
  return () => { set.delete(fn); if (!set.size) listeners.delete(owner); };
}
function withoutDuplicateChats(next: WorkspaceState): WorkspaceState {
  const chatTabs = new Map<string, string>();
  for (const tab of next.tabs) if (tab.kind === 'chat' && tab.chatId && (!chatTabs.has(tab.chatId) || tab.id === next.activeId)) chatTabs.set(tab.chatId, tab.id);
  const unique = next.tabs.filter(tab => tab.kind !== 'chat' || !tab.chatId || chatTabs.get(tab.chatId) === tab.id);
  return unique.length === next.tabs.length ? next : { ...next, tabs: unique };
}
export function updateWorkspace(owner: string, patch: Partial<WorkspaceState>) {
  owner = resolveWorkspaceOwner(owner);
  if (disposedOwners.has(owner)) return;
  const previous = read(owner);
  const next = withoutDuplicateChats({ ...previous, ...patch });
  if (next.tabs === previous.tabs && Object.entries(patch).every(([key, value]) => previous[key as keyof WorkspaceState] === value)) return;
  states.set(owner, next);
  listeners.get(owner)?.forEach(fn => fn());
}
export function addWorkspaceFolder(owner: string, path: string) {
  updateWorkspace(owner, { folders: compactWorkspaceRoots([...(read(owner).folders || []), path]) });
}
export function useSideWorkspace(owner: string) {
  return useSyncExternalStore(useCallback(fn => subscribe(owner, fn), [owner]), () => read(owner), () => empty);
}
const emptyControls = { open: false, sideChatId: null as string | null };
const controls = new Map<string, typeof emptyControls>();
export function useSideWorkspaceControls(owner: string) {
  return useSyncExternalStore(useCallback(fn => subscribe(owner, fn), [owner]), () => {
    const state = read(owner);
    const active = state.tabs.find(tab => tab.id === state.activeId);
    const sideChatId = state.open && active?.kind === 'chat' ? active.chatId || null : null;
    const previous = controls.get(owner) || emptyControls;
    if (previous.open === state.open && previous.sideChatId === sideChatId) return previous;
    const next = { open: state.open, sideChatId }; controls.set(owner, next); return next;
  }, () => emptyControls);
}
export function toggleWorkspace(owner: string) { updateWorkspace(owner, { open: !read(owner).open }); }
export function addWorkspaceTab(owner: string, kind: WorkspaceKind, details: Partial<WorkspaceTab> = {}) {
  if (kind === 'browser') observeBrowserTabs();
  const state = read(owner);
  const openChat = kind === 'chat' && details.chatId ? state.tabs.find(tab => tab.kind === 'chat' && tab.chatId === details.chatId) : undefined;
  if (openChat) { updateWorkspace(owner, { open: true, activeId: openChat.id }); return openChat.id; }
  // Files is a reusable explorer. Selecting a different file updates its preview
  // instead of accumulating a tab for every click in the tree.
  const existing = (kind === 'files' ? state.tabs.find(tab => tab.id === state.activeId && tab.kind === 'files') : undefined)
    || state.tabs.find(tab => tab.kind === kind && (kind === 'terminal' || kind === 'review' || kind === 'files'));
  if (existing) {
    const requestedReview = kind === 'review' && details.path ? { reviewPathRequest: (existing.reviewPathRequest || 0) + 1, ...(existing.review ? { review: { ...existing.review, selected: details.path, scope: 'chat' as const } } : {}) } : {};
    updateWorkspace(owner, { open: true, activeId: existing.id, tabs: state.tabs.map(tab => tab.id === existing.id ? { ...tab, ...details, ...requestedReview, id: tab.id, kind, title: details.title || tab.title } : tab) });
    return existing.id;
  }
  const placeholder = state.tabs.find(tab => tab.kind === kind && ((kind === 'files' && !tab.path) || (kind === 'browser' && !tab.url && !details.url) || (kind === 'chat' && !tab.chatId)));
  if (placeholder) {
    updateWorkspace(owner, { open: true, activeId: placeholder.id, tabs: state.tabs.map(tab => tab.id === placeholder.id ? { ...tab, ...details, title: details.title || tab.title } : tab) });
    return placeholder.id;
  }
  const tab = { ...details, id: crypto.randomUUID(), kind, title: details.title || titles[kind] };
  updateWorkspace(owner, { open: true, tabs: [...state.tabs, tab], activeId: tab.id });
  return tab.id;
}
export function updateWorkspaceTab(owner: string, id: string, patch: Partial<WorkspaceTab>) {
  const state = read(owner);
  const previous = state.tabs.find(tab => tab.id === id);
  const openChat = previous?.kind === 'chat' && patch.chatId ? state.tabs.find(tab => tab.id !== id && tab.kind === 'chat' && tab.chatId === patch.chatId) : undefined;
  // Selecting a conversation already open elsewhere focuses that tab and
  // preserves the current tab's conversation/history (including Back/Forward).
  if (openChat) { updateWorkspace(owner, { open: true, activeId: openChat.id }); return; }
  if (!previous || Object.entries(patch).every(([key, value]) => previous[key as keyof WorkspaceTab] === value)) return;
  updateWorkspace(owner, { tabs: state.tabs.map(tab => tab.id === id ? { ...tab, ...patch } : tab) });
}
export function closeWorkspaceTab(owner: string, id: string) {
  const state = read(owner);
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (state.tabs[index]?.kind === 'browser') void (window as any).electronAPI?.workspaceBrowserClose(id).catch(() => {});
  const tabs = state.tabs.filter(tab => tab.id !== id);
  updateWorkspace(owner, { tabs, activeId: state.activeId === id ? tabs[Math.min(index, tabs.length - 1)]?.id || null : state.activeId });
  releaseBrowserEvents();
}
export function transferWorkspace(from: string, to: string) {
  from = resolveWorkspaceOwner(from); to = resolveWorkspaceOwner(to);
  if (from === to) return;
  const state = states.get(from);
  transferredOwners.set(from, to);
  if (!state) return;
  const target = states.get(to);
  states.delete(from); controls.delete(from);
  states.set(to, withoutDuplicateChats(target ? { ...state, ...target, open: state.open || target.open, tabs: [...state.tabs, ...target.tabs.filter(tab => !state.tabs.some(item => item.id === tab.id))], activeId: target.activeId || state.activeId, folders: compactWorkspaceRoots([...(state.folders || []), ...(target.folders || [])]) } : state));
  listeners.get(from)?.forEach(fn => fn()); listeners.get(to)?.forEach(fn => fn());
}
export function disposeWorkspace(owner: string) {
  owner = resolveWorkspaceOwner(owner);
  disposedOwners.add(owner);
  read(owner).tabs.forEach(tab => { if (tab.kind === 'browser') void (window as any).electronAPI?.workspaceBrowserClose(tab.id).catch(() => {}); });
  states.delete(owner); controls.delete(owner); listeners.get(owner)?.forEach(fn => fn());
  releaseBrowserEvents();
}
export function workspaceTabOwner(id: string) {
  for (const [owner, state] of states) if (state.tabs.some(tab => tab.id === id)) return owner;
  return null;
}
