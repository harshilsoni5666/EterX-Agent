'use client';

import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Loader2, Plus, TerminalSquare, X } from 'lucide-react';
import { clearTerminalError, closeTerminal, createTerminal, resizeTerminalDock, resizeTerminalWidth, selectTerminal, setTerminalOpen, streamManagedTerminal, useChatTerminals } from '../../lib/chat-terminal-store';
import { chatTerminalTheme, terminalTitle } from '../../lib/chat-terminal-theme';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import { fitTerminalSurface } from '../../lib/chat-terminal-runtime';

function ChatTerminalDockView({ chatId, cwd, embedded = false }: { chatId: string; cwd?: string | null; embedded?: boolean }) {
  const state = useChatTerminals(chatId);
  const isSide = state.placement === 'right';
  const dock = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const newTerminalRef = useRef<HTMLButtonElement>(null);
  const keepTabFocus = useRef(false);
  const panelId = useId();
  const tab = state.tabs.find(item => item.id === state.activeId);
  const [containerSize, setContainerSize] = useState(0);
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  useEffect(() => { setDesktopAvailable(Boolean((window as any).electronAPI?.terminalCreate)); }, []);
  useLayoutEffect(() => {
    const parent = dock.current?.parentElement;
    if (!state.open || embedded || !parent) return;
    const measure = () => setContainerSize(isSide ? parent.clientWidth : parent.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    measure();
    return () => observer.disconnect();
  }, [chatId, embedded, isSide, state.open]);
  const maxSize = containerSize > 0
    ? Math.floor(isSide ? Math.min(1200, containerSize - Math.min(320, containerSize * .55)) : Math.min(650, containerSize * .6))
    : isSide ? 1200 : 650;
  const minSize = Math.min(isSide ? 240 : 140, maxSize);
  const clampSize = (size: number) => Math.max(minSize, Math.min(maxSize, size));
  const dockSize = clampSize(isSide ? state.width : state.height);
  const closeThreshold = Math.min(isSide ? 80 : 60, minSize / 2);
  const resizeDock = (size: number) => isSide ? resizeTerminalWidth(chatId, clampSize(size)) : resizeTerminalDock(chatId, clampSize(size));
  const focusActiveTab = () => tabsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
  const closeTab = async (id: string, fromKeyboard: boolean) => {
    const focused = document.activeElement;
    const restoreFocus = Boolean(tabsRef.current?.contains(focused));
    if (fromKeyboard && id === state.activeId) keepTabFocus.current = true;
    await closeTerminal(chatId, id);
    // Only restore focus if closing the tab removed the focused control.
    if (restoreFocus && focused && !focused.isConnected && document.activeElement === document.body && dock.current?.isConnected) {
      const next = tabsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      (next || newTerminalRef.current)?.focus({ preventScroll: true });
    }
  };
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
  const drag = useRef<{ startY: number; startHeight: number; height: number; max: number; frame: number } | null>(null);
  useEffect(() => {
    const element = dock.current;
    return () => {
      const current = drag.current;
      if (!current) return;
      cancelAnimationFrame(current.frame);
      drag.current = null;
      if (element) {
        element.style[isSide ? 'width' : 'height'] = `${current.startHeight}px`;
        delete element.dataset.resizing;
        delete element.dataset.closeReady;
      }
    };
  }, [chatId, embedded, isSide, state.open]);
  const finishResize = (cancelled = false) => {
    const current = drag.current;
    if (!current) return;
    cancelAnimationFrame(current.frame);
    drag.current = null;
    const shouldClose = !cancelled && current.height < closeThreshold;
    const size = cancelled || shouldClose ? dockSize : clampSize(current.height);
    if (dock.current) {
      dock.current.style[isSide ? 'width' : 'height'] = `${size}px`;
      delete dock.current.dataset.resizing;
      delete dock.current.dataset.closeReady;
    }
    if (shouldClose) { setTerminalOpen(chatId, false); return; }
    if (!cancelled) resizeDock(size);
    if (tab && host.current?.clientWidth && host.current?.clientHeight) fitTerminalSurface(tab);
  };
  useEffect(() => {
    if (state.open && tab?.managedTaskId) return streamManagedTerminal(chatId, tab);
  }, [chatId, tab, state.open]);
  useEffect(() => {
    if (!state.open || !tab) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncCursor = () => {
      const visible = isAppVisible();
      tab.terminal.options.disableStdin = Boolean(tab.managedTaskId) || tab.exitCode !== undefined;
      tab.terminal.options.cursorBlink = !tab.managedTaskId && visible && tab.exitCode === undefined && !reducedMotion.matches;
      tab.element.dataset.documentVisible = String(visible);
      if (!tab.managedTaskId) (window as any).electronAPI?.terminalVisible?.(tab.id, visible);
    };
    syncCursor();
    const unsubscribeVisibility = subscribeAppVisibility(syncCursor);
    reducedMotion.addEventListener('change', syncCursor);
    return () => {
      unsubscribeVisibility();
      reducedMotion.removeEventListener('change', syncCursor);
      if (!tab.managedTaskId) (window as any).electronAPI?.terminalVisible?.(tab.id, false);
      tab.terminal.options.cursorBlink = false;
    };
  }, [tab, tab?.exitCode, state.open]);
  useEffect(() => {
    if (!state.open || !tab || !host.current) { keepTabFocus.current = false; return; }
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
    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0 || tab.terminal.hasSelection()) return;
      // Touch scrolling must not summon the keyboard or clear a selection.
      // xterm handles direct touches on its input surface itself.
      if (event.pointerType !== 'touch') activateTerminal();
    };
    container.addEventListener('pointerup', onPointerUp);
    // Keep the chosen typing caret when a shell resets its default cursor style.
    const cursorStyleHandler = tab.terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, () => {
      tab.terminal.options.cursorStyle = 'bar';
      tab.terminal.options.cursorBlink = !tab.managedTaskId && isAppVisible() && tab.exitCode === undefined && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      return true;
    });
    let appliedTheme = '';
    const syncTheme = () => {
      const theme = document.documentElement.dataset.theme || 'dark';
      if (appliedTheme === theme) return;
      appliedTheme = theme;
      tab.terminal.options.theme = chatTerminalTheme();
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
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
    window.visualViewport?.addEventListener('resize', refit);
    const unsubscribeVisibility = subscribeAppVisibility(() => { if (isAppVisible()) refit(); });
    document.fonts.addEventListener('loadingdone', refit);
    void document.fonts.ready.then(refit);
    fit();
    if (keepTabFocus.current) {
      if (document.activeElement === document.body || tabsRef.current?.contains(document.activeElement)) focusActiveTab();
    }
    else if (!tab.managedTaskId && window.matchMedia('(hover: hover) and (pointer: fine)').matches) activateTerminal();
    keepTabFocus.current = false;
    return () => { disposed = true; observer.disconnect(); window.removeEventListener('resize', refit); window.visualViewport?.removeEventListener('resize', refit); document.fonts.removeEventListener('loadingdone', refit); themeObserver.disconnect(); cursorStyleHandler.dispose(); typingListener.dispose(); container.removeEventListener('pointerup', onPointerUp); if (typingTimer) clearTimeout(typingTimer); delete tab.element.dataset.typing; unsubscribeVisibility(); cancelAnimationFrame(frame); if (fitTimer) clearTimeout(fitTimer); tab.element.remove(); };
  }, [tab, state.open]);
  if (!state.open) return null;
  return (
    <section ref={dock} className="eterx-terminal-dock" data-embedded={embedded} data-placement={state.placement} style={embedded ? undefined : isSide ? { width: dockSize } : { height: dockSize }} aria-label="Chat terminal">
      {!embedded && <div className="eterx-terminal-resize" role="separator" tabIndex={0} aria-label="Resize terminal" aria-controls={panelId} aria-orientation={isSide ? 'vertical' : 'horizontal'} aria-valuenow={dockSize} aria-valuemin={minSize} aria-valuemax={maxSize} aria-valuetext={`${dockSize} pixels`}
        onKeyDown={event => {
          if (event.key === 'Escape' && drag.current) { event.preventDefault(); finishResize(true); return; }
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const grow = isSide ? 'ArrowLeft' : 'ArrowUp';
          const shrink = isSide ? 'ArrowRight' : 'ArrowDown';
          if (![grow, shrink, 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          resizeDock(event.key === 'Home' ? minSize : event.key === 'End' ? maxSize : dockSize + (event.key === grow ? 1 : -1) * (event.shiftKey ? 50 : 20));
        }}
        title={isSide ? 'Drag to resize. Drag to the right edge to hide. Double-click to reset.' : 'Drag to resize. Drag to the bottom edge to hide. Double-click to reset.'}
        onDoubleClick={() => resizeDock(isSide ? 480 : 280)}
        onPointerDown={event => {
          if (event.button !== 0 || !dock.current) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          const bounds = dock.current.getBoundingClientRect();
          const height = isSide ? bounds.width : bounds.height;
          drag.current = { startY: isSide ? event.clientX : event.clientY, startHeight: height, height, max: maxSize, frame: 0 };
          dock.current.dataset.resizing = 'true';
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          current.height = Math.max(0, Math.min(current.max, maxSize, current.startHeight + current.startY - (isSide ? event.clientX : event.clientY)));
          if (!current.frame) current.frame = requestAnimationFrame(() => {
            current.frame = 0;
            if (dock.current) {
              dock.current.style[isSide ? 'width' : 'height'] = `${current.height}px`;
              dock.current.dataset.closeReady = String(current.height < closeThreshold);
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
              <button type="button" role="tab" id={`${panelId}-tab-${index}`} aria-controls={panelId} tabIndex={item.id === state.activeId ? 0 : -1} aria-selected={item.id === state.activeId} aria-label={`${item.label}${item.managedTaskId ? '' : ` ${item.number || index + 1}`} — ${item.cwd}${item.exitCode !== undefined ? ` — exited with code ${item.exitCode}` : ''}`} title={`${item.label} — ${item.cwd}`} onClick={event => { keepTabFocus.current = event.detail === 0 && item.id !== state.activeId; selectTerminal(chatId, item.id); }} onKeyDown={event => {
                if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + state.tabs.length) % state.tabs.length;
                keepTabFocus.current = state.tabs[next].id !== state.activeId;
                selectTerminal(chatId, state.tabs[next].id);
                tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
              }}><TerminalSquare size={15} aria-hidden="true" /><span>{item.managedTaskId ? item.label : `${terminalTitle(item.label, 'Terminal')} ${item.number || index + 1}`}{item.managedTaskId ? (item.managedSettled ? ` (${item.managedStatus})` : '') : item.exitCode !== undefined ? ' (exited)' : ''}</span></button>
              <button type="button" tabIndex={item.id === state.activeId ? 0 : -1} aria-label={`Close ${item.label}${item.managedTaskId ? '' : ` ${item.number || index + 1}`}`} title="Close terminal session" onClick={event => void closeTab(item.id, event.detail === 0)}><X size={14} aria-hidden="true" /></button>
            </div>
          ))}
        </div>
        <button ref={newTerminalRef} type="button" className="eterx-terminal-action" disabled={state.creating || !desktopAvailable} aria-label={state.creating ? 'Opening terminal' : 'New terminal'} title={desktopAvailable ? 'New terminal' : 'Local terminals require the EterX desktop app'} onClick={() => void createTerminal(chatId, cwd || tab?.cwd)}>{state.creating ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}</button>
        <button type="button" className="eterx-terminal-action" aria-label="Hide terminal" title="Hide terminal (keep sessions running)" onClick={() => setTerminalOpen(chatId, false)}><X size={17} aria-hidden="true" /></button>
      </div>
      {(tab?.managedError || state.error) && <div className="eterx-terminal-notices">
        {tab?.managedError && <div className="eterx-terminal-error" role="status"><span>{tab.managedError} Reconnecting…</span></div>}
        {state.error && <div className="eterx-terminal-error"><span role="alert">{state.error}</span><button type="button" className="eterx-terminal-action" aria-label="Dismiss terminal error" onClick={() => clearTerminalError(chatId)}><X size={14} aria-hidden="true" /></button></div>}
      </div>}
      <div className="eterx-terminal-body">
        <div ref={host} id={panelId} className="eterx-terminal-host" role={tab ? 'tabpanel' : undefined} aria-labelledby={tab ? `${panelId}-tab-${state.tabs.indexOf(tab)}` : undefined} aria-busy={tab?.managedLoading || undefined} />
        {tab?.managedLoading && <div className="eterx-terminal-connecting" role="status"><Loader2 size={15} className="animate-spin" aria-hidden="true" /><span>Connecting…</span></div>}
        {!tab && <div className="eterx-terminal-empty">
          {state.creating ? <span className="eterx-terminal-opening" role="status"><Loader2 size={18} className="animate-spin" aria-hidden="true" />Opening terminal…</span>
            : desktopAvailable ? <button type="button" onClick={() => void createTerminal(chatId, cwd)}>Open terminal</button>
              : <p>Open EterX on your desktop to use a local terminal.</p>}
        </div>}
      </div>
    </section>
  );
}

export const ChatTerminalDock = memo(ChatTerminalDockView);
