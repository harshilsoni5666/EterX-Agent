'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, ScanLine, Check, Globe, Loader2, RotateCw, Search, X } from 'lucide-react';
import { updateWorkspaceTab, type WorkspaceTab } from '../../lib/side-workspace-store';
import { Tooltip } from '../ui/tooltip';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import { BROWSER_HISTORY_KEY, clearBrowserHistory, loadBrowserHistory, readBrowserHistory, type BrowserHistoryItem } from '../../lib/browser-history';
import { FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';

type BrowserState = { url: string; title: string; favicon?: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error: string };
export type BrowserCapture = { filePath: string; filename: string; dataUrl: string; url: string };
const initial: BrowserState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: '' };
function address(value: string) {
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) return input;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(input)) return `http://${input}`;
  if (/^[^\s/:]+\.[^\s/]+(?::\d+)?(?:\/.*)?$/.test(input)) return `https://${input}`;
  if (/^[a-z][\w+.-]*:/i.test(input)) throw new Error('Use an HTTP or HTTPS address.');
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}
export function BrowserFavicon({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return url && /^https?:\/\//i.test(url) && !failed ? <img className="eterx-workspace-favicon" src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Globe size={16} />;
}
export function WorkspaceBrowser({ owner, tab, occluded, onCapture }: { owner: string; tab: WorkspaceTab; occluded: boolean; onCapture: (capture: BrowserCapture, tabId: string) => Promise<void> }) {
  const api = typeof window !== 'undefined' ? (window as any).electronAPI : undefined;
  const [state, setState] = useState<BrowserState>(initial);
  const [value, setValue] = useState(tab.url || '');
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lastURL = useRef('');
  const viewport = useRef<HTMLDivElement>(null);
  const viewportFlags = useRef({ url: '', error: '', overlay: false });
  const scheduleViewport = useRef<() => void>(undefined);
  const frameReady = useRef<(revision: number) => void>(undefined);
  const [pageFrame, setPageFrame] = useState<{ source: string; revision: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<BrowserHistoryItem[]>([]);
  const [suggestions, setSuggestions] = useState(false);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  const [capturing, setCapturing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { if (!disposed) setHistory(readBrowserHistory()); };
    const changed = (event: Event) => { if ((event as CustomEvent).detail?.key === BROWSER_HISTORY_KEY) refresh(); };
    void loadBrowserHistory().then(refresh);
    window.addEventListener('eterx-folder-storage-updated', changed);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, refresh);
    return () => { disposed = true; window.removeEventListener('eterx-folder-storage-updated', changed); window.removeEventListener(FOLDER_STORAGE_READY_EVENT, refresh); };
  }, []);
  useEffect(() => {
    setReady(false);
    if (!api?.workspaceBrowserCreate) { setState({ ...initial, error: 'Restart EterX to enable the desktop browser.' }); return; }
    let disposed = false;
    const receive = (event: BrowserState & { id: string; openUrl?: string; focusAddress?: boolean }) => {
      if (event.id !== tab.id || disposed) return;
      if (event.openUrl) return; // The workspace store routes new tabs, including background pages.
      if (event.focusAddress) { input.current?.focus(); input.current?.select(); return; }
      setState(previous => Object.keys(event).every(key => key === 'id' || event[key as keyof BrowserState] === previous[key as keyof BrowserState]) ? previous : event);
      if (event.url && event.url !== 'about:blank') {
        if (lastURL.current !== event.url) { lastURL.current = event.url; if (document.activeElement !== input.current) setValue(event.url); }
        updateWorkspaceTab(owner, tab.id, { url: event.url, title: event.title || new URL(event.url).hostname, favicon: event.favicon });
      }
    };
    const unsubscribe = api.onWorkspaceBrowserEvent(receive);
    api.workspaceBrowserCreate(tab.id, document.documentElement.dataset.theme).then(async (current: BrowserState) => {
      if (disposed) return;
      receive({ ...current, id: tab.id }); setReady(true);
      if (tab.url && !current.url) await api.workspaceBrowserCommand(tab.id, 'navigate', address(tab.url));
    }).catch((error: Error) => { if (!disposed) setState({ ...initial, error: String(error.message || error) }); });
    return () => { disposed = true; unsubscribe(); api.workspaceBrowserBounds(tab.id, null); clearTimeout(copiedTimer.current); };
  }, [tab.id, owner, attempt]);
  useEffect(() => {
    if (!ready || !suggestions || !value.trim() || value === state.url) { setKeywords([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api.workspaceBrowserSuggest?.(tab.id, value).then((items: string[]) => { if (!cancelled) setKeywords(items || []); }).catch(() => {});
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [value, suggestions, ready, tab.id]);
  const hasSuggestions = suggestions && (keywords.length > 0 || history.some(item => !value || value === state.url || (item.title + ' ' + item.url).toLowerCase().includes(value.toLowerCase())));
  viewportFlags.current = { url: state.url, error: state.error, overlay: occluded || hasSuggestions };
  useLayoutEffect(() => {
    if (!ready || !viewport.current || !api) return;
    let frame = 0, captureRevision = 0;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let previousBounds = '';
    let disposed = false, overlayVisible = false, previewLoaded = false;
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(sync); };
    const sync = () => {
      frame = 0;
      const flags = viewportFlags.current;
      const overlay = flags.overlay || Boolean(document.querySelector('[aria-modal="true"], [role="dialog"]'));
      if (overlay && !overlayVisible && flags.url && !flags.error) {
        overlayVisible = true; previewLoaded = false;
        const revision = ++captureRevision;
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
          if (!disposed && revision === captureRevision) { previewLoaded = true; schedule(); }
        }, 750);
        // A single captured frame keeps DOM suggestions/dialogs over the page.
        // Native "+" menus need no capture and leave the live renderer attached.
        const capture = api.workspaceBrowserPreview?.(tab.id) || Promise.resolve(null);
        void capture.then((source: string | null) => {
          if (disposed || revision !== captureRevision) return;
          if (source) setPageFrame({ source, revision });
          else { previewLoaded = true; schedule(); }
        }).catch(() => { if (!disposed && revision === captureRevision) { previewLoaded = true; schedule(); } });
      } else if (!overlay && overlayVisible) {
        overlayVisible = false; previewLoaded = false; captureRevision++;
        clearTimeout(previewTimer); setPageFrame(null);
      }
      const blocked = !isAppVisible() || (overlay && previewLoaded);
      const rect = viewport.current?.getBoundingClientRect();
      const bounds = !blocked && flags.url && !flags.error && rect ? { x: rect.x + 1, y: rect.y, width: Math.max(0, rect.width - 2), height: rect.height } : null;
      const signature = JSON.stringify(bounds);
      if (signature !== previousBounds) { previousBounds = signature; api.workspaceBrowserBounds(tab.id, bounds); }
    };
    frameReady.current = revision => { if (revision === captureRevision) { clearTimeout(previewTimer); previewLoaded = true; schedule(); } };
    scheduleViewport.current = schedule;
    const resize = new ResizeObserver(schedule); resize.observe(viewport.current);
    const mutations = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLElement && (node.matches('[role="dialog"], [aria-modal="true"]') || node.querySelector('[role="dialog"], [aria-modal="true"]'))))) schedule();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true); const unsubscribeVisibility = subscribeAppVisibility(schedule);
    schedule();
    return () => {
      disposed = true; captureRevision++; cancelAnimationFrame(frame);
      clearTimeout(previewTimer);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); unsubscribeVisibility();
      scheduleViewport.current = undefined; frameReady.current = undefined;
      api.workspaceBrowserBounds(tab.id, null);
    };
  }, [ready, tab.id]);
  useLayoutEffect(() => { scheduleViewport.current?.(); }, [state.url, state.error, occluded, hasSuggestions]);
  const command = async (action: string, payload?: string) => {
    try { const result = await api.workspaceBrowserCommand(tab.id, action, payload); setState(result); } catch (error) { setState(previous => ({ ...previous, error: String(error) })); }
  };
  const navigate = (entry = value) => {
    if (!entry.trim() || !ready) return;
    setSuggestions(false); input.current?.blur();
    try { const url = address(entry); setValue(url); void command('navigate', url); } catch (error) { setState(previous => ({ ...previous, error: String(error) })); }
  };
  const historyMatches = history.filter(item => !value || value === state.url || `${item.title} ${item.url}`.toLowerCase().includes(value.toLowerCase())).slice(0, 5);
  const suggestionLabels = new Set<string>();
  const entries = [...historyMatches.map(item => ({ text: item.url, label: item.title || item.url, favicon: item.favicon, history: true })), ...keywords.map(keyword => ({ text: keyword, label: keyword, favicon: undefined, history: false }))].filter(entry => {
    const key = entry.label.toLowerCase().replace(/\s*[-–—]\s*google search$/i, '').trim();
    if (suggestionLabels.has(key)) return false;
    suggestionLabels.add(key); return true;
  }).slice(0, 8);
  const capture = async () => {
    if (capturing || !ready || !state.url) return;
    setCapturing(true); setCaptureError('');
    try {
      const result = await api.workspaceBrowserCapture(tab.id);
      await onCapture(result, tab.id);
      setCopied(true); clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => setCopied(false), 2200);
    } catch (error) { setCaptureError(String((error as Error).message || error)); }
    finally { setCapturing(false); }
  };
  return <div className="eterx-workspace-browser">
    <form className="eterx-workspace-address" onSubmit={event => { event.preventDefault(); navigate(selectedSuggestion >= 0 ? entries[selectedSuggestion]?.text || value : value); }}>
      <button type="button" aria-label="Back" disabled={!state.canGoBack} onClick={() => void command('back')}><ArrowLeft size={16} /></button>
      <button type="button" aria-label="Forward" disabled={!state.canGoForward} onClick={() => void command('forward')}><ArrowRight size={16} /></button>
      <Tooltip side="top" text={state.loading ? 'Stop loading' : 'Reload'}><button type="button" aria-label={state.loading ? 'Stop loading' : 'Reload'} disabled={!ready} onClick={() => void command(state.loading ? 'stop' : 'reload')}>{state.loading ? <X size={16} /> : <RotateCw size={16} />}</button></Tooltip>
      <div className="eterx-workspace-url"><BrowserFavicon url={state.favicon} /><input ref={input} role="combobox" aria-expanded={suggestions && entries.length > 0} aria-controls={`browser-suggestions-${tab.id}`} aria-autocomplete="list" aria-activedescendant={selectedSuggestion >= 0 ? `browser-suggestion-${tab.id}-${selectedSuggestion}` : undefined} aria-label="Search or enter a URL" placeholder="Search or enter a URL" value={value} onChange={event => { setValue(event.target.value); setSuggestions(true); setSelectedSuggestion(-1); }} onFocus={event => { event.currentTarget.select(); setSuggestions(true); }} onBlur={() => setSuggestions(false)} onKeyDown={event => { if (event.key === 'Escape') { setSuggestions(false); setSelectedSuggestion(-1); } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSuggestions(true); setSelectedSuggestion(index => Math.max(-1, Math.min(entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); } }} /><button disabled={!ready} aria-label="Go"><ArrowUpRight size={16} /></button>
        {suggestions && entries.length > 0 && <div className="eterx-workspace-suggestions" id={`browser-suggestions-${tab.id}`} role="listbox">{entries.map((entry, index) => <button id={`browser-suggestion-${tab.id}-${index}`} role="option" aria-selected={selectedSuggestion === index} type="button" key={entry.text} onMouseDown={event => event.preventDefault()} onClick={() => navigate(entry.text)}>{entry.history ? <BrowserFavicon url={entry.favicon} /> : <Search size={14} />}<span>{entry.label}</span></button>)}<button type="button" className="eterx-workspace-clear-history" onMouseDown={event => event.preventDefault()} onClick={() => { clearBrowserHistory(); setHistory([]); }}>Clear browsing history</button></div>}
      </div>
      <Tooltip side="top" text={copied ? 'Copied and attached to chat' : 'Capture page'}><button type="button" disabled={!ready || !state.url || capturing} aria-label={copied ? 'Copied and attached to chat' : 'Capture page and attach to chat'} onClick={() => void capture()}>{capturing ? <Loader2 size={17} className="animate-spin" /> : copied ? <Check size={17} /> : <ScanLine size={18} strokeWidth={1.7} />}</button></Tooltip>
      {state.loading && <div className="eterx-workspace-loading-line" />}
    </form>
    {captureError && <div className="eterx-workspace-inline-error" role="alert">{captureError}<button aria-label="Dismiss error" onClick={() => setCaptureError('')}><X size={13} /></button></div>}
    <div ref={viewport} className="eterx-workspace-browser-viewport">
      {pageFrame && state.url && !state.error && <img key={pageFrame.revision} className="eterx-workspace-browser-frame" src={pageFrame.source} alt="" onLoad={() => frameReady.current?.(pageFrame.revision)} onError={() => frameReady.current?.(pageFrame.revision)} />}
      {state.error ? <div className="eterx-workspace-empty" role="alert"><Globe size={30} /><h3>Unable to open this page</h3><p>{state.error}</p><button onClick={() => ready ? navigate() : setAttempt(value => value + 1)}>Try again</button></div> : !state.url && <div className="eterx-workspace-empty"><Globe size={36} strokeWidth={1.5} /><h3>{ready ? 'Search the web' : 'Starting browser…'}</h3><p>Enter a search or website address above.</p></div>}
    </div>
  </div>;
}
