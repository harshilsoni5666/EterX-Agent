'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { addWorkspaceTab } from './side-workspace-store';
import { chatTerminalTheme, terminalTitle } from './chat-terminal-theme';
import { readManagedTerminal, type ManagedTerminalTask } from './managed-terminal-client';
import { appStorage } from './client-storage';
import { formatTerminalProgram } from './agent/terminal-invocation';
import { isAppVisible, subscribeAppVisibility } from './app-visibility';
import { createTerminalSurface, loadTerminalRuntime } from './chat-terminal-runtime';

export type TerminalTab = { id: string; number: number; label: string; cwd: string; terminal: Terminal; fit: FitAddon; element: HTMLDivElement; exitCode?: number; managedTaskId?: string; managedOwnerChatId?: string; managedLoading?: boolean; managedError?: string; initialSnapshot?: Promise<any>; outputOffset?: number; managedStatus?: string; managedSettled?: boolean; managedInitialized?: boolean };
type ChatTerminals = { open: boolean; placement: 'bottom' | 'right'; width: number; tabs: TerminalTab[]; activeId: string | null; height: number; error: string; creating: boolean };
const empty: ChatTerminals = { open: false, placement: 'bottom', width: 480, tabs: [], activeId: null, height: 280, error: '', creating: false };
const chats = new Map<string, ChatTerminals>();
const tabsById = new Map<string, TerminalTab>();
const terminalNumbers = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
type TerminalControls = Pick<ChatTerminals, 'open' | 'placement'> & { tabCount: number };
const emptyControls: TerminalControls = { open: false, placement: 'bottom', tabCount: 0 };
const controls = new Map<string, TerminalControls>();
const titleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingTitles = new Map<string, string>();
const pendingCreations = new Set<{ owner: string; disposed: boolean }>();
const isCreating = (owner: string) => [...pendingCreations].some(creation => creation.owner === owner && !creation.disposed);
const tabOwner = (tab: TerminalTab) => [...chats].find(([, state]) => state.tabs.includes(tab))?.[0];
function subscribe(chatId: string, listener: () => void) {
  const group = listeners.get(chatId) || new Set<() => void>();
  listeners.set(chatId, group);
  group.add(listener);
  return () => { group.delete(listener); if (!group.size) listeners.delete(chatId); };
}
function notifyChat(chatId: string) { listeners.get(chatId)?.forEach(fn => fn()); }
function clearTitle(id: string) {
  clearTimeout(titleTimers.get(id));
  titleTimers.delete(id);
  pendingTitles.delete(id);
}
const api = () => (window as any).electronAPI;
let subscribed = false;
const read = (chatId: string) => chats.get(chatId) || empty;
function update(chatId: string, patch: Partial<ChatTerminals>) {
  const previous = read(chatId);
  if (Object.entries(patch).every(([key, value]) => previous[key as keyof ChatTerminals] === value)) return;
  chats.set(chatId, { ...previous, ...patch });
  notifyChat(chatId);
}
export function useChatTerminals(chatId: string) {
  return useSyncExternalStore(useCallback((fn: () => void) => subscribe(chatId, fn), [chatId]), () => read(chatId), () => empty);
}
// The page header needs only visibility and tab count. Titles, exit messages
// and dock dimensions must not cause the entire chat page to render again.
export function useChatTerminalControls(chatId: string) {
  return useSyncExternalStore(useCallback((fn: () => void) => subscribe(chatId, fn), [chatId]), () => {
    const state = read(chatId);
    const previous = controls.get(chatId) || emptyControls;
    if (previous.open === state.open && previous.placement === state.placement && previous.tabCount === state.tabs.length) return previous;
    const next = { open: state.open, placement: state.placement, tabCount: state.tabs.length };
    controls.set(chatId, next);
    return next;
  }, () => emptyControls);
}
export function setTerminalOpen(chatId: string, open: boolean) { update(chatId, { open }); }
export function clearTerminalError(chatId: string) { update(chatId, { error: '' }); }
export function showTerminal(chatId: string, placement: 'bottom' | 'right') { update(chatId, { open: true, placement }); }
export function toggleTerminalPlacement(chatId: string, placement: 'bottom' | 'right') {
  const state = read(chatId);
  update(chatId, { placement, open: !(state.open && state.placement === placement) });
}
export function resizeTerminalWidth(chatId: string, width: number) { update(chatId, { width: Math.max(240, Math.min(1200, width)) }); }
export function selectTerminal(chatId: string, activeId: string) {
  if (read(chatId).tabs.some(tab => tab.id === activeId)) update(chatId, { activeId });
}
export function resizeTerminalDock(chatId: string, height: number) { update(chatId, { height: Math.max(140, Math.min(650, height)) }); }
export function transferChatTerminals(from: string, to: string) {
  if (from === to) return;
  for (const creation of pendingCreations) if (creation.owner === from) creation.owner = to;
  void api()?.terminalTransfer?.(from, to).catch(() => {});
  const state = chats.get(from);
  if (!state) return;
  chats.delete(from);
  const existing = chats.get(to);
  chats.set(to, { ...(existing?.tabs.length ? { ...state, tabs: [...existing.tabs, ...state.tabs], activeId: state.activeId || existing.activeId } : state), creating: isCreating(to) });
  terminalNumbers.set(to, Math.max(terminalNumbers.get(from) || 0, terminalNumbers.get(to) || 0));
  terminalNumbers.delete(from);
  controls.delete(from);
  notifyChat(from);
  notifyChat(to);
}
export function disposeChatTerminals(chatId: string) {
  for (const creation of pendingCreations) if (creation.owner === chatId) creation.disposed = true;
  terminalNumbers.delete(chatId);
  const state = chats.get(chatId);
  chats.delete(chatId);
  state?.tabs.forEach(tab => { clearTitle(tab.id); tabsById.delete(tab.id); tab.terminal.dispose(); if (!tab.managedTaskId) void api()?.terminalClose(tab.id).catch(() => {}); });
  controls.delete(chatId);
  notifyChat(chatId);
}
export async function closeTerminal(chatId: string, id: string) {
  const state = read(chatId);
  const tab = state.tabs.find(item => item.id === id);
  if (!tab) return;
  try { if (!tab.managedTaskId) await api().terminalClose(id); } catch { /* The process may already be gone. */ }
  if (tabsById.get(id) !== tab) return;
  chatId = [...chats].find(([, state]) => state.tabs.some(tab => tab.id === id))?.[0] || chatId;
  tabsById.delete(id);
  clearTitle(id);
  tab.terminal.dispose();
  const current = read(chatId);
  if (!chats.has(chatId)) return;
  const tabs = current.tabs.filter(item => item.id !== id);
  const next = tabs[Math.min(current.tabs.indexOf(tab), tabs.length - 1)];
  update(chatId, { tabs, activeId: current.activeId === id ? next?.id || null : current.activeId });
}
export async function createTerminal(chatId: string, cwd?: string | null) {
  if (read(chatId).creating) return;
  update(chatId, { creating: true, error: '' });
  const creation = { owner: chatId, disposed: false };
  pendingCreations.add(creation);
  let createdId: string | undefined;
  let createdTerminal: Terminal | undefined;
  try {
    if (!api()?.terminalCreate) throw new Error('Open this project in the EterX desktop app to use the terminal. Restart the app after updating.');
    const runtime = await loadTerminalRuntime();
    if (!subscribed) {
      api().onTerminalEvent((event: { id: string; data?: string; exitCode?: number }) => {
        const target = tabsById.get(event.id);
        if (!target) return;
        if (event.data) target.terminal.write(event.data, () => api().terminalAck(event.id, event.data!.length));
        // Output takes the direct path to xterm; React is notified only for
        // metadata changes such as a session exiting, never for streamed text.
        if (event.exitCode === undefined) return;
        for (const [owner, state] of chats) {
          const tab = state.tabs.find(item => item.id === event.id);
          if (!tab) continue;
          if (event.exitCode !== undefined) {
            tab.exitCode = event.exitCode;
            tab.terminal.write(`\r\n[Process exited with code ${event.exitCode}]\r\n`);
            update(owner, { tabs: [...state.tabs] });
          }
          break;
        }
      });
      subscribed = true;
    }
    chatId = creation.owner;
    if (creation.disposed) return;
    // Construct the display before spawning a shell so renderer failures never
    // leave an interactive process behind.
    const { terminal, fit, element } = createTerminalSurface(runtime, { cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, cursorInactiveStyle: 'outline', fontSize: 13, lineHeight: 1.18, fontFamily: '"GeistMono", Consolas, "Liberation Mono", Menlo, monospace', scrollback: 2000, allowProposedApi: false, theme: chatTerminalTheme() });
    createdTerminal = terminal;
    let terminalShell = 'auto';
    try { terminalShell = JSON.parse(appStorage.getItem('eterx_settings') || '{}').terminalShell || 'auto'; } catch {}
    const requestedOwner = chatId;
    const result = await api().terminalCreate({ chatId, cwd, terminalShell });
    chatId = creation.owner;
    createdId = result.id;
    if (creation.disposed || !chats.has(chatId)) throw new Error('Terminal opening was cancelled.');
    if (requestedOwner !== chatId) await api().terminalTransfer(requestedOwner, chatId);
    chatId = creation.owner;
    if (creation.disposed || !chats.has(chatId)) throw new Error('Terminal opening was cancelled.');
    terminal.onData(data => api().terminalInput(result.id, data));
    terminal.onResize(({ cols, rows }) => api().terminalResize(result.id, cols, rows));
    terminal.onTitleChange(label => {
      const target = tabsById.get(result.id);
      if (!target) return;
      const nextLabel = terminalTitle(label, result.label);
      pendingTitles.set(result.id, nextLabel);
      if (titleTimers.has(result.id)) return;
      if (target.label === nextLabel) { pendingTitles.delete(result.id); return; }
      titleTimers.set(result.id, setTimeout(() => {
        titleTimers.delete(result.id);
        const next = pendingTitles.get(result.id);
        pendingTitles.delete(result.id);
        const current = tabsById.get(result.id);
        if (!current || next === undefined || current.label === next) return;
        current.label = next;
        for (const [owner, state] of chats) {
          if (state.tabs.includes(current)) { update(owner, { tabs: [...state.tabs] }); break; }
        }
      }, 120));
    });
    const number = Math.max(0, ...read(chatId).tabs.map(item => item.number || 0), terminalNumbers.get(chatId) || 0) + 1;
    terminalNumbers.set(chatId, number);
    const tab: TerminalTab = { ...result, number, terminal, fit, element };
    tabsById.set(tab.id, tab);
    update(chatId, { tabs: [...read(chatId).tabs, tab], activeId: result.id });
    await api().terminalAttach(result.id);
  } catch (error) {
    chatId = creation.owner;
    if (createdId) {
      clearTitle(createdId);
      tabsById.delete(createdId);
      void api()?.terminalClose(createdId).catch(() => {});
      for (const [owner, state] of chats) {
        if (!state.tabs.some(tab => tab.id === createdId)) continue;
        const tabs = state.tabs.filter(tab => tab.id !== createdId);
        update(owner, { tabs, activeId: state.activeId === createdId ? tabs.at(-1)?.id || null : state.activeId });
        break;
      }
    }
    createdTerminal?.dispose();
    if (!creation.disposed && chats.has(chatId)) update(chatId, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    pendingCreations.delete(creation);
    chatId = creation.owner;
    if (chats.has(chatId)) update(chatId, { creating: isCreating(chatId) });
  }
}

const openingManaged = new Map<string, { promise: Promise<void>; creation: { owner: string; disposed: boolean } }>();

function placeManagedTerminal(chatId: string, tab: TerminalTab) {
  const previousOwner = tabOwner(tab);
  if (previousOwner && previousOwner !== chatId) {
    const state = read(previousOwner);
    const tabs = state.tabs.filter(item => item !== tab);
    update(previousOwner, { tabs, activeId: state.activeId === tab.id ? tabs.at(-1)?.id || null : state.activeId });
  }
  const state = read(chatId);
  update(chatId, { open: true, placement: 'right', tabs: state.tabs.includes(tab) ? state.tabs : [...state.tabs, tab], activeId: tab.id, error: '' });
}

/** panelChatId routes the UI tab, not ownership or exclusive access to a folder. */
export async function openManagedTerminal(taskChatId: string, task: ManagedTerminalTask, panelChatId = taskChatId): Promise<void> {
  let chatId = panelChatId;
  addWorkspaceTab(chatId, 'terminal');
  update(chatId, { open: true, placement: 'right', error: '' });
  const id = `managed:${taskChatId}:${task.id}`;
  const existing = tabsById.get(id);
  if (existing) { placeManagedTerminal(chatId, existing); return; }
  const pending = openingManaged.get(id);
  if (pending && !pending.creation.disposed) {
    const previousOwner = pending.creation.owner;
    pending.creation.owner = chatId;
    if (chats.has(previousOwner)) update(previousOwner, { creating: isCreating(previousOwner) });
    update(chatId, { creating: true });
    return pending.promise;
  }
  const creation = { owner: chatId, disposed: false };
  pendingCreations.add(creation);
  update(chatId, { creating: true });
  // Fetch in parallel with loading xterm, before React mounts the dock.
  const initialSnapshot = readManagedTerminal(taskChatId, task.id, 0);
  void initialSnapshot.catch(() => {});
  let createdTerminal: Terminal | undefined;
  let createdTab: TerminalTab | undefined;
  const promise = (async () => {
    const runtime = await loadTerminalRuntime();
    if (creation.disposed) return;
    chatId = creation.owner;
    const { terminal, fit, element } = createTerminalSurface(runtime, {
      disableStdin: true, cursorBlink: false, convertEol: true, fontSize: 13,
      lineHeight: 1.18, fontFamily: '"GeistMono", Consolas, "Liberation Mono", Menlo, monospace',
      scrollback: 10000, theme: chatTerminalTheme(),
    });
    createdTerminal = terminal;
    const tab: TerminalTab = {
      id, number: 0, label: task.program ? formatTerminalProgram(task.program, task.args, true) : task.command.replace(/\s+/g, ' ').trim() || 'Terminal command',
      cwd: task.cwd, terminal, fit, element, managedTaskId: task.id, managedOwnerChatId: taskChatId, managedLoading: !task.initialOutput, initialSnapshot, outputOffset: 0,
      managedStatus: task.status,
    };
    createdTab = tab;
    terminal.writeln(`$ ${task.command}\r\n[${task.cwd}]\r\n`);
    if (task.initialOutput) terminal.write(task.initialOutput);
    tabsById.set(id, tab);
    placeManagedTerminal(chatId, tab);
  })();
  openingManaged.set(id, { promise, creation });
  try { await promise; }
  catch (error) {
    if (createdTab && tabsById.get(id) === createdTab) {
      tabsById.delete(id);
      const owner = tabOwner(createdTab);
      if (owner) {
        const state = read(owner);
        const tabs = state.tabs.filter(tab => tab !== createdTab);
        update(owner, { tabs, activeId: state.activeId === id ? tabs.at(-1)?.id || null : state.activeId });
      }
    }
    createdTerminal?.dispose();
    if (!creation.disposed && chats.has(creation.owner)) update(creation.owner, { error: error instanceof Error ? error.message : 'Could not open terminal.' });
    throw error;
  } finally {
    if (openingManaged.get(id)?.creation === creation) openingManaged.delete(id);
    pendingCreations.delete(creation);
    if (chats.has(creation.owner)) update(creation.owner, { creating: isCreating(creation.owner) });
  }
}

/** Fetch output independently of the agent's response stream; offsets prevent duplicates. */
export function streamManagedTerminal(chatId: string, tab: TerminalTab): () => void {
  if (!tab.managedTaskId || tab.managedSettled) return () => {};
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let first = !tab.managedInitialized;
  let previousError = '';
  let refreshing = false;
  const refresh = async () => {
    if (refreshing || controller.signal.aborted || !isAppVisible() || tab.managedSettled) return;
    clearTimeout(timer);
    refreshing = true;
    let moreOutput = false;
    try {
      const prefetched = tab.initialSnapshot;
      tab.initialSnapshot = undefined;
      const snapshot = await (prefetched || readManagedTerminal(tab.managedOwnerChatId || chatId, tab.managedTaskId!, tab.outputOffset || 0, controller.signal));
      if (controller.signal.aborted || tabsById.get(tab.id) !== tab) return;
      if (snapshot.outputReadError) throw new Error(snapshot.outputReadError);
      const owner = tabOwner(tab);
      if (!owner) return;
      chatId = owner;
      const persistenceError = snapshot.outputPersistenceError
        ? `Some terminal output could not be saved: ${snapshot.outputPersistenceError}`
        : snapshot.statusPersistenceError ? `Terminal status could not be saved: ${snapshot.statusPersistenceError}` : undefined;
      if (tab.managedLoading || tab.managedError !== persistenceError) {
        tab.managedLoading = false; tab.managedError = persistenceError;
        update(chatId, { tabs: [...read(chatId).tabs] });
      }
      if (first) { tab.terminal.reset(); tab.terminal.writeln(`$ ${snapshot.command}\r\n[${snapshot.cwd}]\r\n`); first = false; tab.managedInitialized = true; }
      if (previousError) previousError = '';
      if (snapshot.output) {
        // Queue the output and advance its cursor together so tab switches cannot replay it.
        tab.terminal.write(snapshot.output);
      }
      tab.outputOffset = snapshot.outputEnd;
      tab.managedStatus = snapshot.status;
      moreOutput = snapshot.hasMoreOutput === true;
      if (!snapshot.running && !moreOutput) {
        tab.managedSettled = true;
        tab.exitCode = snapshot.exitCode ?? undefined;
        const status = snapshot.status === 'completed' ? 'Completed' : snapshot.status === 'killed' ? 'Stopped' : snapshot.status === 'unknown' ? 'Outcome unavailable' : 'Failed';
        tab.terminal.writeln(`\r\n[${status}${snapshot.exitCode === null ? '' : ` · exit ${snapshot.exitCode}`}${snapshot.outputEnd === 0 ? ' · no output produced' : ''}]`);
        update(chatId, { tabs: [...read(chatId).tabs] });
        window.dispatchEvent(new CustomEvent('eterx-terminal-task-changed', { detail: { chatId: tab.managedOwnerChatId || chatId, taskId: tab.managedTaskId } }));
        return;
      }
      if (snapshot.running && snapshot.outputEnd === 0 && !tab.element.dataset.waitingOutput) {
        tab.element.dataset.waitingOutput = 'true';
        tab.terminal.writeln('[Process running; no output yet]');
      }
    } catch (error) {
      if (controller.signal.aborted || tabsById.get(tab.id) !== tab) return;
      const owner = tabOwner(tab);
      if (!owner) return;
      chatId = owner;
      const message = error instanceof Error ? error.message : 'Could not read process output.';
      if (previousError !== message) { previousError = message; tab.managedLoading = false; tab.managedError = message; update(chatId, { tabs: [...read(chatId).tabs] }); }
    } finally {
      refreshing = false;
    }
    if (!controller.signal.aborted && isAppVisible()) timer = setTimeout(refresh, previousError ? 8000 : moreOutput ? 50 : 1000);
  };
  const visibility = () => { clearTimeout(timer); if (isAppVisible()) void refresh(); };
  const changed = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail?.chatId === (tab.managedOwnerChatId || chatId) && detail?.taskId === tab.managedTaskId) void refresh();
  };
  window.addEventListener('eterx-terminal-task-changed', changed);
  const unsubscribeVisibility = subscribeAppVisibility(visibility);
  void refresh();
  return () => { controller.abort(); clearTimeout(timer); unsubscribeVisibility(); window.removeEventListener('eterx-terminal-task-changed', changed); };
}
