'use client';

import { memo, useEffect, useRef } from 'react';
import { Plus, TerminalSquare, X } from 'lucide-react';
import { closeTerminal, createTerminal, resizeTerminalDock, resizeTerminalWidth, selectTerminal, setTerminalOpen, useChatTerminals } from '../../lib/chat-terminal-store';
import { chatTerminalTheme, terminalTitle } from '../../lib/chat-terminal-theme';

function ChatTerminalDockView({ chatId, cwd }: { chatId: string; cwd?: string | null }) {
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
    if (host.current?.clientWidth && host.current?.clientHeight) tab?.fit.fit();
  };
  const tab = state.tabs.find(item => item.id === state.activeId);
  useEffect(() => {
    if (!state.open || !tab || !host.current) return;
    const container = host.current;
    container.appendChild(tab.element);
    tab.terminal.options.cursorStyle = 'bar';
    tab.terminal.options.cursorWidth = 2;
    tab.terminal.options.cursorInactiveStyle = 'outline';
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    const revealCaret = () => {
      if (tab.exitCode !== undefined || tab.terminal.buffer.active.type !== 'normal') return;
      if (!tab.element.dataset.typing) tab.element.dataset.typing = 'true';
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { delete tab.element.dataset.typing; }, 500);
    };
    const typingListener = tab.terminal.onData(revealCaret);
    const activateTerminal = () => {
      tab.terminal.focus();
      if (tab.exitCode === undefined && tab.terminal.buffer.active.type === 'normal') tab.terminal.write('\x1b[?25h');
      revealCaret();
    };
    container.addEventListener('pointerup', activateTerminal);
    // Keep the chosen typing caret when a shell resets its default cursor style.
    const cursorStyleHandler = tab.terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, () => {
      tab.terminal.options.cursorStyle = 'bar';
      tab.terminal.options.cursorBlink = !document.hidden && tab.exitCode === undefined;
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
      tab.terminal.options.cursorBlink = !document.hidden && tab.exitCode === undefined;
      tab.element.dataset.documentVisible = String(!document.hidden);
      (window as any).electronAPI?.terminalVisible?.(tab.id, !document.hidden);
    };
    syncTheme();
    syncCursor();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    document.addEventListener('visibilitychange', syncCursor);
    let frame = 0;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    let fittedWidth = -1;
    let fittedHeight = -1;
    const fit = () => {
      cancelAnimationFrame(frame);
      if (fitTimer) clearTimeout(fitTimer);
      // Let the dock follow the pointer immediately. Reflow terminal rows only
      // after movement settles, instead of repeatedly resizing the shell.
      const schedule = () => { frame = requestAnimationFrame(() => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width > 0 && height > 0 && (width !== fittedWidth || height !== fittedHeight)) {
          fittedWidth = width;
          fittedHeight = height;
          tab.fit.fit();
        }
      }); };
      if (drag.current) fitTimer = setTimeout(schedule, 90);
      else schedule();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    fit();
    activateTerminal();
    return () => { observer.disconnect(); themeObserver.disconnect(); cursorStyleHandler.dispose(); typingListener.dispose(); container.removeEventListener('pointerup', activateTerminal); if (typingTimer) clearTimeout(typingTimer); delete tab.element.dataset.typing; document.removeEventListener('visibilitychange', syncCursor); cancelAnimationFrame(frame); if (fitTimer) clearTimeout(fitTimer); (window as any).electronAPI?.terminalVisible?.(tab.id, false); tab.terminal.options.cursorBlink = false; tab.element.remove(); };
  }, [tab, tab?.exitCode, state.open]);
  if (!state.open) return null;
  return (
    <section ref={dock} className="eterx-terminal-dock" data-placement={state.placement} style={isSide ? { width: state.width } : { height: state.height }} aria-label="Chat terminal">
      <div className="eterx-terminal-resize" role="separator" tabIndex={0} aria-label="Resize terminal" aria-orientation={isSide ? 'vertical' : 'horizontal'} aria-valuenow={isSide ? state.width : state.height} aria-valuemin={isSide ? 240 : 140} aria-valuemax={isSide ? 1200 : 650}
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
        onLostPointerCapture={() => finishResize(true)} />
      <div className="eterx-terminal-toolbar">
        <div ref={tabsRef} className="eterx-terminal-tabs" role="tablist" aria-label="Terminal sessions" aria-orientation="horizontal">
          {state.tabs.map((item, index) => (
            <div key={item.id} className={`eterx-terminal-tab ${item.id === state.activeId ? 'is-active' : ''}`}>
              <button type="button" role="tab" aria-selected={item.id === state.activeId} title={`${item.label} — ${item.cwd}`} onClick={() => selectTerminal(chatId, item.id)}><TerminalSquare size={15} /><span>{terminalTitle(item.label, 'Terminal')} {item.number || index + 1}{item.exitCode !== undefined ? ' (exited)' : ''}</span></button>
              <button aria-label={`Close ${item.label}`} title="Close terminal session" onClick={() => void closeTerminal(chatId, item.id)}><X size={14} /></button>
            </div>
          ))}
        </div>
        <button className="eterx-terminal-action" disabled={state.creating} title="New terminal in project folder" aria-label="New terminal" onClick={() => void createTerminal(chatId, cwd)}><Plus size={18} /></button>
        <button className="eterx-terminal-action" title="Hide terminal (sessions keep running)" aria-label="Hide terminal" onClick={() => setTerminalOpen(chatId, false)}><X size={17} /></button>
      </div>
      {state.error && <div className="eterx-terminal-error" role="alert">{state.error}</div>}
      <div ref={host} className="eterx-terminal-host" />
      {!tab && <div className="eterx-terminal-empty"><button disabled={state.creating} onClick={() => void createTerminal(chatId, cwd)}>{state.creating ? 'Starting shell…' : 'Open terminal'}</button></div>}
    </section>
  );
}

export const ChatTerminalDock = memo(ChatTerminalDockView);
