'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { chatTerminalTheme, terminalTitle } from './chat-terminal-theme';

export type TerminalTab = { id: string; number: number; label: string; cwd: string; terminal: Terminal; fit: FitAddon; element: HTMLDivElement; exitCode?: number };
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
export function toggleTerminalPlacement(chatId: string, placement: 'bottom' | 'right') {
  const state = read(chatId);
  update(chatId, { placement, open: !(state.open && state.placement === placement) });
}
export function resizeTerminalWidth(chatId: string, width: number) { update(chatId, { width: Math.max(240, Math.min(1200, width)) }); }
export function selectTerminal(chatId: string, activeId: string) { update(chatId, { activeId }); }
export function resizeTerminalDock(chatId: string, height: number) { update(chatId, { height: Math.max(140, Math.min(650, height)) }); }
export function transferChatTerminals(from: string, to: string) {
  const state = chats.get(from);
  if (!state) return;
  chats.delete(from);
  chats.set(to, state);
  terminalNumbers.set(to, Math.max(terminalNumbers.get(from) || 0, terminalNumbers.get(to) || 0));
  terminalNumbers.delete(from);
  controls.delete(from);
  notifyChat(from);
  notifyChat(to);
}
export function disposeChatTerminals(chatId: string) {
  terminalNumbers.delete(chatId);
  const state = chats.get(chatId);
  chats.delete(chatId);
  state?.tabs.forEach(tab => { clearTitle(tab.id); tabsById.delete(tab.id); tab.terminal.dispose(); void api()?.terminalClose(tab.id).catch(() => {}); });
  controls.delete(chatId);
  notifyChat(chatId);
}
export async function closeTerminal(chatId: string, id: string) {
  const state = read(chatId);
  const tab = state.tabs.find(item => item.id === id);
  if (!tab) return;
  try { await api().terminalClose(id); } catch { /* The process may already be gone. */ }
  tabsById.delete(id);
  clearTitle(id);
  tab.terminal.dispose();
  const current = read(chatId);
  if (!chats.has(chatId)) return;
  const tabs = current.tabs.filter(item => item.id !== id);
  update(chatId, { tabs, activeId: current.activeId === id ? tabs.at(-1)?.id || null : current.activeId });
}
export async function createTerminal(chatId: string, cwd?: string | null) {
  if (read(chatId).creating) return;
  update(chatId, { creating: true, error: '' });
  let createdId: string | undefined;
  let createdTerminal: Terminal | undefined;
  try {
    if (!api()?.terminalCreate) throw new Error('Open this project in the EterX desktop app to use the terminal. Restart the app after updating.');
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
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
    const result = await api().terminalCreate({ chatId, cwd });
    createdId = result.id;
    if (!chats.has(chatId)) { await api().terminalClose(result.id); return; }
    const terminal = new Terminal({ cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, cursorInactiveStyle: 'outline', fontSize: 13, lineHeight: 1.18, fontFamily: 'Consolas, "Liberation Mono", Menlo, monospace', scrollback: 2000, allowProposedApi: false, theme: chatTerminalTheme() });
    createdTerminal = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const element = document.createElement('div');
    element.className = 'eterx-terminal-surface';
    terminal.open(element);
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
    if (chats.has(chatId)) update(chatId, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (chats.has(chatId)) update(chatId, { creating: false });
  }
}
