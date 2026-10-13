'use client';

import { memo, useEffect, useRef } from 'react';
import { Loader2, Plus, TerminalSquare, X } from 'lucide-react';
import { closeTerminal, createTerminal, resizeTerminalDock, resizeTerminalWidth, selectTerminal, setTerminalOpen, streamManagedTerminal, useChatTerminals } from '../../lib/chat-terminal-store';
import { chatTerminalTheme, terminalTitle } from '../../lib/chat-terminal-theme';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import { fitTerminalSurface } from '../../lib/chat-terminal-runtime';

function ChatTerminalDockView({ chatId, cwd, embedded = false }: { chatId: string; cwd?: string | null; embedded?: boolean }) {
  const state = useChatTerminals(chatId);
  const isSide = state.placement === 'right';
  const resizeDock = (size: number) => isSide ? resizeTerminalWidth(chatId, size) : resizeTerminalDock(chatId, size);
  const host = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    const updateEdges = () => {
      const left = String(strip.scrollLeft > 1);
      const right = String(strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1);
      if (strip.dataset.fadeLeft !== left) strip.dataset.fadeLeft = left;
      if (strip.dataset.fadeRight !== right) strip.dataset.fadeRight = right;
      for (const label of strip.querySelectorAll<HTMLElement>('[role="tab"] > span')) label.dataset.overflow = String(label.scrollWidth > label.clientWidth + 1);
    };
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(strip);
    for (const child of Array.from(strip.children)) observer.observe(child);
    strip.addEventListener('scroll', updateEdges, { passive: true });
    return () => { observer.disconnect(); strip.removeEventListener('scroll', updateEdges); };
  }, [state.tabs, state.open, state.placement]);
  useEffect(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement;
    if (active) {
      const left = active.offsetLeft;
      if (left < strip.scrollLeft) strip.scrollLeft = left;
      else if (left + active.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + active.offsetWidth - strip.clientWidth;
    }
  }, [state.activeId, state.tabs.length, state.open]);
  useEffect(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || strip.scrollWidth <= strip.clientWidth) return;
      event.preventDefault();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      strip.scrollLeft += delta * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? strip.clientWidth : 1);
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, [state.open]);
  const dock = useRef<HTMLElement>(null);
  const drag = useRef<{ startY: number; startHeight: number; height: number; max: number; frame: number } | null>(null);
  useEffect(() => () => { if (drag.current) cancelAnimationFrame(drag.current.frame); drag.current = null; }, [chatId]);
  const finishResize = (cancelled = false) => {
    const current = drag.current;
    if (!current) return;
    cancelAnimationFrame(current.frame);
    drag.current = null;
    const shouldClose = !cancelled && current.height < (isSide ? 80 : 60);
    const size = cancelled || shouldClose ? (isSide ? state.width : state.height) : Math.max(isSide ? 240 : 140, current.height);
    if (dock.current) {
      dock.current.style[isSide ? 'width' : 'height'] = `${size}px`;
      delete dock.current.dataset.resizing;
      delete dock.current.dataset.closeReady;
    }
    if (shouldClose) { setTerminalOpen(chatId, false); return; }
    if (!cancelled) resizeDock(size);
    if (tab && host.current?.clientWidth && host.current?.clientHeight) fitTerminalSurface(tab);
  };
  const tab = state.tabs.find(item => item.id === state.activeId);
  useEffect(() => {
    if (state.open && tab?.managedTaskId) return streamManagedTerminal(chatId, tab);
  }, [chatId, tab, state.open]);
  useEffect(() => {
    if (!state.open || !tab || !host.current) return;
    const container = host.current;
    container.appendChild(tab.element);
    tab.terminal.options.cursorStyle = 'bar';
    tab.terminal.options.cursorWidth = 2;
    tab.terminal.options.cursorInactiveStyle = 'outline';
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    const revealCaret = () => {
      if (tab.managedTaskId || tab.exitCode !== undefined || tab.terminal.buffer.active.type !== 'normal') return;
      if (!tab.element.dataset.typing) tab.element.dataset.typing = 'true';
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { delete tab.element.dataset.typing; }, 500);
    };
    const typingListener = tab.terminal.onData(revealCaret);
    const activateTerminal = () => {
      tab.terminal.focus();
      if (!tab.managedTaskId && tab.exitCode === undefined && tab.terminal.buffer.active.type === 'normal') tab.terminal.write('\x1b[?25h');
      revealCaret();
    };
    container.addEventListener('pointerup', activateTerminal);
    // Keep the chosen typing caret when a shell resets its default cursor style.
    const cursorStyleHandler = tab.terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, () => {
      tab.terminal.options.cursorStyle = 'bar';
      tab.terminal.options.cursorBlink = !tab.managedTaskId && isAppVisible() && tab.exitCode === undefined;
      return true;
    });
    let appliedTheme = '';
    const syncTheme = () => {
      const theme = document.documentElement.dataset.theme || 'dark';
      if (appliedTheme === theme) return;
      appliedTheme = theme;
      tab.terminal.options.theme = chatTerminalTheme();
    };
    const syncCursor = () => {
      const visible = isAppVisible();
      tab.terminal.options.cursorBlink = !tab.managedTaskId && visible && tab.exitCode === undefined;
      tab.element.dataset.documentVisible = String(visible);
      if (!tab.managedTaskId) (window as any).electronAPI?.terminalVisible?.(tab.id, visible);
    };
    syncTheme();
    syncCursor();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const unsubscribeVisibility = subscribeAppVisibility(syncCursor);
    let frame = 0;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    let fittedWidth = -1;
    let fittedHeight = -1;
    let fittedPixelRatio = -1;
    let disposed = false;
    const fit = () => {
      cancelAnimationFrame(frame);
      if (fitTimer) clearTimeout(fitTimer);
      // Let the dock follow the pointer immediately. Reflow terminal rows only
      // after movement settles, instead of repeatedly resizing the shell.
      const schedule = () => { frame = requestAnimationFrame(() => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        const pixelRatio = window.devicePixelRatio;
        if (!disposed && width > 0 && height > 0 && (width !== fittedWidth || height !== fittedHeight || pixelRatio !== fittedPixelRatio) && fitTerminalSurface(tab)) {
          fittedWidth = width;
          fittedHeight = height;
          fittedPixelRatio = pixelRatio;
        }
      }); };
      if (drag.current || container.closest('[data-workspace-resizing="true"]')) fitTimer = setTimeout(schedule, 90);
      else schedule();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    // Font loading and moving between displays can change cell dimensions
    // without changing the dock's CSS size.
    const refit = () => {
      if (disposed) return;
      fittedWidth = -1;
      fit();
    };
    window.addEventListener('resize', refit);
    document.fonts.addEventListener('loadingdone', refit);
    void document.fonts.ready.then(refit);
    fit();
    activateTerminal();
    return () => { disposed = true; observer.disconnect(); window.removeEventListener('resize', refit); document.fonts.removeEventListener('loadingdone', refit); themeObserver.disconnect(); cursorStyleHandler.dispose(); typingListener.dispose(); container.removeEventListener('pointerup', activateTerminal); if (typingTimer) clearTimeout(typingTimer); delete tab.element.dataset.typing; unsubscribeVisibility(); cancelAnimationFrame(frame); if (fitTimer) clearTimeout(fitTimer); if (!tab.managedTaskId) (window as any).electronAPI?.terminalVisible?.(tab.id, false); tab.terminal.options.cursorBlink = false; tab.element.remove(); };
  }, [tab, tab?.exitCode, state.open]);
  if (!state.open) return null;
  return (
    <section ref={dock} className="eterx-terminal-dock" data-embedded={embedded} data-placement={state.placement} style={embedded ? undefined : isSide ? { width: state.width } : { height: state.height }} aria-label="Chat terminal">
      {!embedded && <div className="eterx-terminal-resize" role="separator" tabIndex={0} aria-label="Resize terminal" aria-orientation={isSide ? 'vertical' : 'horizontal'} aria-valuenow={isSide ? state.width : state.height} aria-valuemin={isSide ? 240 : 140} aria-valuemax={isSide ? 1200 : 650}
        onKeyDown={event => { if (event.key === (isSide ? 'ArrowLeft' : 'ArrowUp') || event.key === (isSide ? 'ArrowRight' : 'ArrowDown')) { event.preventDefault(); resizeDock((isSide ? state.width : state.height) + (event.key === (isSide ? 'ArrowLeft' : 'ArrowUp') ? 20 : -20)); } }}
        title={isSide ? 'Drag to resize. Drag to the right edge to hide. Double-click to reset.' : 'Drag to resize. Drag to the bottom edge to hide. Double-click to reset.'}
        onDoubleClick={() => resizeDock(isSide ? 480 : 280)}
        onPointerDown={event => {
          if (event.button !== 0 || !dock.current) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const bounds = dock.current.getBoundingClientRect();
          const height = isSide ? bounds.width : bounds.height;
          const parentHeight = (isSide ? dock.current.parentElement?.clientWidth : dock.current.parentElement?.clientHeight) || 1000;
          drag.current = { startY: isSide ? event.clientX : event.clientY, startHeight: height, height, max: isSide ? Math.min(1200, parentHeight - Math.min(320, parentHeight * .55)) : Math.max(140, Math.min(650, parentHeight * .6)), frame: 0 };
          dock.current.dataset.resizing = 'true';
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          current.height = Math.max(0, Math.min(current.max, current.startHeight + current.startY - (isSide ? event.clientX : event.clientY)));
          if (!current.frame) current.frame = requestAnimationFrame(() => {
            current.frame = 0;
            if (dock.current) {
              dock.current.style[isSide ? 'width' : 'height'] = `${current.height}px`;
              dock.current.dataset.closeReady = String(current.height < (isSide ? 80 : 60));
            }
          });
        }}
        onPointerUp={event => { finishResize(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => finishResize(true)}
        onLostPointerCapture={() => finishResize(true)} />}
      <div className="eterx-terminal-toolbar">
        <div ref={tabsRef} className="eterx-terminal-tabs" role="tablist" aria-label="Terminal sessions" aria-orientation="horizontal">
          {state.tabs.map((item, index) => (
            <div key={item.id} className={`eterx-terminal-tab ${item.id === state.activeId ? 'is-active' : ''}`}>
              <button type="button" role="tab" aria-selected={item.id === state.activeId} aria-label={`${item.label} — ${item.cwd}`} onClick={() => selectTerminal(chatId, item.id)}><TerminalSquare size={15} /><span>{item.managedTaskId ? item.label : `${terminalTitle(item.label, 'Terminal')} ${item.number || index + 1}`}{item.managedTaskId ? (item.managedSettled ? ` (${item.managedStatus})` : '') : item.exitCode !== undefined ? ' (exited)' : ''}</span></button>
              <button aria-label={`Close ${item.label}`} onClick={() => void closeTerminal(chatId, item.id)}><X size={14} /></button>
            </div>
          ))}
        </div>
        <button className="eterx-terminal-action" disabled={state.creating} aria-label="New terminal" onClick={() => void createTerminal(chatId, cwd || tab?.cwd)}><Plus size={18} /></button>
        <button className="eterx-terminal-action" aria-label="Hide terminal" onClick={() => setTerminalOpen(chatId, false)}><X size={17} /></button>
      </div>
      {tab?.managedError && <div className="eterx-terminal-error" role="status">{tab.managedError} Reconnecting…</div>}
      {tab?.managedLoading && <div className="eterx-terminal-connecting" role="status" aria-label="Connecting terminal output"><Loader2 size={15} className="animate-spin" /></div>}
      {state.error && <div className="eterx-terminal-error" role="alert">{state.error}</div>}
      <div ref={host} className="eterx-terminal-host" />
      {!tab && <div className="eterx-terminal-empty"><button disabled={state.creating} onClick={() => void createTerminal(chatId, cwd)}>{state.creating ? <Loader2 size={18} className="animate-spin" aria-label="Opening terminal" /> : 'Open terminal'}</button></div>}
    </section>
  );
}

export const ChatTerminalDock = memo(ChatTerminalDockView);
