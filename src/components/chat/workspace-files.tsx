'use client';

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Check, ChevronDown, ChevronRight, Copy, File, FolderOpen, Folders, Loader2, Search, TerminalSquare, WrapText, X } from 'lucide-react';
import { buildFilePreviewUrl } from '../../lib/path-utils';
import { safeCopyTextToClipboard } from '../ui/copy-button';
import { addWorkspaceTab, type WorkspaceTab } from '../../lib/side-workspace-store';
import { createTerminal, showTerminal } from '../../lib/chat-terminal-store';
import { watchWorkspaceFolder } from '../../lib/workspace-file-events';
import { WorkspaceFileIcon } from './workspace-file-icon';
import { Tooltip } from '../ui/tooltip';
import { highlightWorkspaceCode, workspaceLanguage, type WorkspaceTokens } from '../../lib/workspace-syntax';
import { isWithinWorkspace, workspaceRootForFile } from '../../lib/workspace-paths';
import { WorkspaceTreePane } from './workspace-tree-pane';
import { PierreChevron } from './workspace-review-tree';
import { FileSearchCorner } from './workspace-icons';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import { WorkspaceImagePreview } from './workspace-image-preview';

type Entry = { name: string; path: string; type: 'file' | 'directory' };
type FlattenedEntry = Entry & {
  terminalPath?: string;
  segments?: { name: string; path: string }[];
};
type Document = { content: string; language?: string; totalLines: number; loadedLines: number; endLine: number; truncated: boolean; size: number; version?: string };
type OpenApp = { id: string; name: string; icon?: string };
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const parentPath = (path: string) => {
  const parent = path.replace(/[\\/][^\\/]+[\\/]?$/, '');
  return /^[A-Za-z]:$/.test(parent) ? parent + '\\' : parent || (path.startsWith('/') ? '/' : path);
};
const api = () => (window as any).electronAPI;
const FileActivity = createContext(true);
const Empty = ({ children }: { children: React.ReactNode }) => <div className="eterx-workspace-empty">{children}</div>;

async function fetchFolderChildren(dirPath: string, showHidden: boolean): Promise<Entry[]> {
  if (api()?.workspaceFolderList) {
    const result = await api().workspaceFolderList(dirPath, 0, showHidden);
    return result?.entries || [];
  }
  const response = await fetch('/api/code/files?path=' + encodeURIComponent(dirPath) + '&depth=1');
  const result = await response.json();
  return result?.tree || [];
}

async function resolveFlattenedChains(
  rawEntries: Entry[],
  showHidden: boolean,
  compact: boolean
): Promise<FlattenedEntry[]> {
  if (!compact) return rawEntries;
  return Promise.all(
    rawEntries.map(async entry => {
      if (entry.type !== 'directory') return entry;
      const segments = [{ name: entry.name, path: entry.path }];
      let currentPath = entry.path;
      for (let depth = 0; depth < 8; depth++) {
        try {
          const children = await fetchFolderChildren(currentPath, showHidden);
          if (children.length === 1 && children[0].type === 'directory') {
            const onlyChild = children[0];
            segments.push({ name: onlyChild.name, path: onlyChild.path });
            currentPath = onlyChild.path;
          } else {
            break;
          }
        } catch {
          break;
        }
      }
      if (segments.length > 1) {
        return {
          ...entry,
          terminalPath: currentPath,
          segments
        };
      }
      return entry;
    })
  );
}

function useFolderRevision(path: string, enabled = true) {
  const visible = useContext(FileActivity) && enabled;
  const active = useRef(visible); active.current = visible;
  const dirty = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => { if (visible && dirty.current) { dirty.current = false; setRevision(value => value + 1); } }, [visible]);
  useEffect(() => {
    if (!path) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      dirty.current = true;
      if (!isAppVisible() || !active.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!active.current || !isAppVisible()) return; dirty.current = false; setRevision(value => value + 1); }, 200);
    };
    const visible = () => { if (isAppVisible() && dirty.current) refresh(); };
    const stop = watchWorkspaceFolder(path, refresh);
    window.addEventListener('focus', refresh);
    const unsubscribeVisibility = subscribeAppVisibility(visible);
    return () => { stop(); clearTimeout(timer); window.removeEventListener('focus', refresh); unsubscribeVisibility(); };
  }, [path]);
  return revision;
}

function FolderEntries({ path, selected, filter, showHidden, compact = true, onSelect, depth = 0 }: { path: string; selected?: string; filter: string; showHidden: boolean; compact?: boolean; onSelect: (path: string) => void; depth?: number }) {
  const [entries, setEntries] = useState<FlattenedEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [pages, setPages] = useState(1);
  const revision = useFolderRevision(path);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    setLoading(true);
    const load = async () => {
      let raw: Entry[] = [];
      let more = false;
      if (api()?.workspaceFolderList) {
        const collected: Entry[] = [];
        for (let page = 0; page < pages; page++) {
          if (disposed) return null;
          const result = await api().workspaceFolderList(path, page * 300, showHidden);
          collected.push(...result.entries); more = result.more;
          if (!more) break;
        }
        raw = collected;
      } else {
        const response = await fetch('/api/code/files?path=' + encodeURIComponent(path) + '&depth=1', { signal: abort.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not open this folder.');
        raw = result.tree || [];
      }
      const flattened = await resolveFlattenedChains(raw, showHidden, compact);
      return { entries: flattened, more };
    };
    void load().then(result => {
      if (!disposed && result) {
        setError('');
        setEntries(previous => JSON.stringify(previous) === JSON.stringify(result.entries) ? previous : result.entries);
        setMore(result.more);
      }
    }).catch(error => { if (!disposed) setError(String(error.message || error)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; abort.abort(); };
  }, [path, pages, revision, showHidden, compact]);
  useEffect(() => {
    if (!selected) return;
    const ancestors = entries.filter(entry => {
      const activePath = entry.terminalPath || entry.path;
      return entry.type === 'directory' && (
        isWithinWorkspace(selected, activePath) ||
        (entry.segments && entry.segments.some(s => isWithinWorkspace(selected, s.path)))
      );
    });
    if (ancestors.length) {
      const pathsToExpand = ancestors.map(a => a.terminalPath || a.path);
      setExpanded(previous => pathsToExpand.every(p => previous.has(p)) ? previous : new Set([...previous, ...pathsToExpand]));
    }
  }, [selected, entries]);
  const visible = entries.filter(entry => {
    if (entry.type === 'directory') return true;
    if (!filter) return true;
    const q = filter.toLowerCase();
    if (entry.segments) return entry.segments.some(s => s.name.toLowerCase().includes(q));
    return entry.name.toLowerCase().includes(q);
  });
  return <div role="group" className="eterx-workspace-folder-entries" data-nested={depth > 0} style={{ '--tree-depth': depth } as React.CSSProperties}>
    {visible.map(entry => {
      const activePath = entry.terminalPath || entry.path;
      const isDir = entry.type === 'directory';
      const isExpanded = isDir && expanded.has(activePath);
      return <div key={entry.path}>
        <button className={'eterx-workspace-file-row ' + (selected === entry.path || selected === activePath ? 'is-selected' : '')} style={{ paddingLeft: 8 + depth * 14 }} aria-label={activePath} aria-expanded={isDir ? isExpanded : undefined} aria-current={selected === entry.path ? 'page' : undefined} onClick={() => {
          if (!isDir) onSelect(entry.path);
          else setExpanded(previous => { const next = new Set(previous); next.has(activePath) ? next.delete(activePath) : next.add(activePath); return next; });
        }}>
          {isDir ? <PierreChevron open={isExpanded} size={12} /> : <span className="eterx-workspace-tree-spacer" />}
          <WorkspaceFileIcon path={activePath} folder={isDir} />
          {entry.segments ? (
            <span className="eterx-workspace-flattened-segments">
              {entry.segments.map((seg, idx) => (
                <span key={seg.path} className="eterx-workspace-flattened-segment">
                  <span>{seg.name}</span>
                  {idx < entry.segments!.length - 1 && <span className="eterx-workspace-flatten-slash"> / </span>}
                </span>
              ))}
            </span>
          ) : (
            <span>{entry.name}</span>
          )}
        </button>
        {isDir && isExpanded && depth < 24 && <FolderEntries {...{ selected, filter, showHidden, compact, onSelect }} path={activePath} depth={depth + 1} />}
      </div>;
    })}
    {error && <p className="eterx-workspace-inline-error" role="alert">{error}</p>}
    {loading && !entries.length && <div className="eterx-workspace-tree-status"><Loader2 size={14} className="animate-spin" /> Loading files…</div>}
    {!loading && !error && !visible.length && <div className="eterx-workspace-tree-status">{filter ? 'No matching files here' : 'This folder is empty'}</div>}
    {more && <button className="eterx-workspace-file-row" disabled={loading} onClick={() => setPages(value => value + 1)}>Show more files</button>}
  </div>;
}

// Tokenization runs in one idle-disposable worker. Theme changes only swap CSS
// colours; typing in Find or resizing does not re-tokenize the document.
export const WorkspaceCode = memo(function WorkspaceCode({ content, path = '', language, query = '', wrap = false, size = 13 }: { content: string; path?: string; language?: string; query?: string; wrap?: boolean; size?: number }) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const [highlighted, setHighlighted] = useState<{ content: string; tokens: WorkspaceTokens | null } | null>(null);
  useEffect(() => {
    let active = true;
    void highlightWorkspaceCode(content, workspaceLanguage(path, language)).then(tokens => { if (active) setHighlighted({ content, tokens }); });
    return () => { active = false; };
  }, [content, path, language]);
  const tokens = highlighted?.content === content ? highlighted.tokens : null;
  return <div className="eterx-workspace-code" data-wrap={wrap} style={{ fontSize: size }}>
    {lines.map((line, index) => <div className={'eterx-workspace-code-line ' + (query && line.toLowerCase().includes(query.toLowerCase()) ? 'is-match' : '')} key={index}><span className="eterx-workspace-line-number" aria-hidden="true">{index + 1}</span><code>{tokens?.[index] ? tokens[index].map((token, i) => <span key={i} className="eterx-workspace-syntax-token" style={{ '--ws-code-light': token.light, '--ws-code-dark': token.dark } as React.CSSProperties}>{token.text}</span>) : line}{line ? '' : '\u00a0'}</code></div>)}
  </div>;
});

export function WorkspaceMenu({ label, trigger, children, onOpen }: { label: string; trigger: React.ReactNode; children: React.ReactNode; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const node = useRef<HTMLDivElement>(null);
  const focusEdge = useRef<'first' | 'last' | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = node.current, menu = anchor?.querySelector<HTMLElement>('[role="menu"]');
    if (!anchor || !menu) return;
    const pane = anchor.closest('.eterx-workspace-content') || anchor.closest('.eterx-side-workspace');
    const position = () => {
      const bounds = anchor.getBoundingClientRect(), frame = pane?.getBoundingClientRect();
      if (!bounds.width || !bounds.height) { setOpen(false); return; }
      const leftEdge = Math.max(8, (frame?.left || 0) + 8), rightEdge = Math.min(window.innerWidth - 8, (frame?.right || window.innerWidth) - 8);
      const bottom = Math.min(window.innerHeight - 8, (frame?.bottom || window.innerHeight) - 8);
      const topEdge = Math.max(8, (frame?.top || 0) + 8);
      menu.style.maxHeight = Math.max(60, bottom - topEdge) + 'px';
      const width = menu.offsetWidth, height = menu.offsetHeight;
      menu.style.left = Math.max(leftEdge, Math.min(bounds.right - width, rightEdge - width)) - bounds.left + 'px';
      menu.style.right = 'auto';
      menu.style.top = Math.max(topEdge, Math.min(bounds.bottom + 5, bottom - height)) - bounds.top + 'px';
    };
    position();
    if (focusEdge.current) {
      const items = menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      items[focusEdge.current === 'first' ? 0 : items.length - 1]?.focus(); focusEdge.current = null;
    } else menu.querySelector<HTMLInputElement>('input')?.focus();
    const observer = new ResizeObserver(position); observer.observe(anchor); observer.observe(menu); if (pane) observer.observe(pane);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!node.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div ref={node} className="eterx-workspace-menu-anchor" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); node.current?.querySelector('button')?.focus(); event.stopPropagation(); }
    if (event.key === 'Tab') setOpen(false);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && (!(event.target instanceof HTMLInputElement) || !['Home', 'End'].includes(event.key))) {
      event.preventDefault();
      if (!open) { focusEdge.current = event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first'; setOpen(true); onOpen?.(); return; }
      const items = Array.from(node.current?.querySelectorAll<HTMLButtonElement>('[role="menu"] button:not(:disabled)') || []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}>
    <button aria-label={label} aria-expanded={open} aria-haspopup="menu" onClick={() => { if (!open) onOpen?.(); setOpen(value => !value); }}>{trigger}</button>
    {open && <div className="eterx-workspace-menu" role="menu" aria-label={label} onClick={event => { if ((event.target as HTMLElement).closest('button')) { setOpen(false); node.current?.querySelector('button')?.focus(); } }}>{children}</div>}
  </div>;
}

function breadcrumbs(root: string, selected: string) {
  const normalized = root.replace(/\\/g, '/').replace(/\/$/, '');
  const target = selected.replace(/\\/g, '/');
  const windows = /^[A-Za-z]:/.test(root);
  const inside = (windows ? target.toLowerCase() : target).startsWith((windows ? normalized.toLowerCase() : normalized) + '/');
  const base = !selected || inside ? root : parentPath(selected);
  const relative = selected && inside ? target.slice(normalized.length + 1).split('/') : selected ? [fileName(selected)] : [];
  const parts = [{ label: fileName(base), path: base }];
  let path = base;
  return parts;
}

function FilesRootFolder({ directory, rootsLength, filter, showHidden, compact = true, selected, onOpenFile }: {
  directory: string;
  rootsLength: number;
  filter: string;
  showHidden: boolean;
  compact?: boolean;
  selected?: string;
  onOpenFile: (path: string, root: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [chain, setChain] = useState<{ terminalPath: string; segments: { name: string; path: string }[] }>({
    terminalPath: directory,
    segments: [{ name: fileName(directory), path: directory }]
  });

  useEffect(() => {
    let active = true;
    if (!compact) {
      setChain({ terminalPath: directory, segments: [{ name: fileName(directory), path: directory }] });
      return;
    }
    void (async () => {
      const segments = [{ name: fileName(directory), path: directory }];
      let currentPath = directory;
      for (let depth = 0; depth < 8; depth++) {
        try {
          const children = await fetchFolderChildren(currentPath, showHidden);
          if (children.length === 1 && children[0].type === 'directory') {
            const onlyChild = children[0];
            segments.push({ name: onlyChild.name, path: onlyChild.path });
            currentPath = onlyChild.path;
          } else {
            break;
          }
        } catch {
          break;
        }
      }
      if (active) {
        setChain({ terminalPath: currentPath, segments });
      }
    })();
    return () => { active = false; };
  }, [directory, showHidden, compact]);

  return (
    <details className="eterx-workspace-root" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
      <summary aria-label={directory}>
        <PierreChevron open={open} size={12} />
        <WorkspaceFileIcon path={chain.terminalPath} folder />
        <span>
          <strong className="eterx-workspace-flattened-segments">
            {chain.segments.map((seg, idx) => (
              <span key={seg.path} className="eterx-workspace-flattened-segment">
                <span>{seg.name}</span>
                {idx < chain.segments.length - 1 && <span className="eterx-workspace-flatten-slash"> / </span>}
              </span>
            ))}
          </strong>
          {rootsLength > 1 && <small>{directory}</small>}
        </span>
      </summary>
      <FolderEntries filter={filter} showHidden={showHidden} compact={compact} selected={selected} path={chain.terminalPath} depth={1} onSelect={path => onOpenFile(path, directory)} />
    </details>
  );
}

export function WorkspaceFiles({ owner, tab, isActive = true, workspacePath, roots, rootsLoading, rootError, onAddFolder, onOpenFile }: { owner: string; tab: WorkspaceTab; isActive?: boolean; workspacePath?: string | null; roots: string[]; rootsLoading: boolean; rootError: string; onAddFolder: (path: string) => void; onOpenFile: (path: string, root: string) => void }) {
  const root = workspacePath || workspaceRootForFile(roots, tab.path);
  const [filter, setFilter] = useState('');
  const [compactFolders, setCompactFolders] = useState(true);
  const [query, setQuery] = useState('');
  const [showTree, setShowTree] = useState(true);
  const [showHidden, setShowHidden] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [binary, setBinary] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [apps, setApps] = useState<OpenApp[]>([]);
  const [openingApps, setOpeningApps] = useState(false);
  const [preferred, setPreferred] = useState('default');
  const [folderMenu, setFolderMenu] = useState('');
  const toolbar = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const selected = tab.path || '';
  const media = /\.(png|jpg|jpeg|webp|gif|svg|avif|ico|mp4|webm|mov|mp3|wav|ogg|pdf)$/i.test(selected);
  const office = /\.(xlsx?|docx?|pptx?|od[stp]|numbers|pages|key|zip|7z|exe|dll)$/i.test(selected);
  const revision = useFolderRevision(selected ? parentPath(selected) : '', isActive);
  const request = useRef<AbortController>();
  const documents = useRef(new Map<string, { doc: Document | null; binary: boolean }>());
  const docRef = useRef(doc); docRef.current = doc;
  const appChoice = apps.find(item => item.id === preferred);
  const preferenceKey = 'eterx.workspace.open-app.' + (selected ? fileName(selected).split('.').slice(1).pop()?.toLowerCase() || 'text' : 'folder');
  useEffect(() => () => { request.current?.abort(); clearTimeout(copyTimer.current); }, []);
  useEffect(() => {
    if (!folderMenu) return;
    const close = (event: PointerEvent) => { if (!toolbar.current?.contains(event.target as Node)) setFolderMenu(''); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [folderMenu]);
  const readFile = async (append = false) => {
    request.current?.abort();
    const abort = new AbortController(); request.current = abort;
    setLoading(true);
    const previous = docRef.current;
    try {
      const response = await fetch('/api/code/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: selected, knownVersion: append ? undefined : previous?.version, offset: append ? (previous?.endLine || 0) + 1 : 1, limit: append ? 1000 : Math.min(10000, Math.max(1000, previous?.loadedLines || 0)) }), signal: abort.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not read this file.');
      if (abort.signal.aborted) return;
      setError('');
      if (result.unchanged && previous) return;
      // An external edit between pages must replace the preview; appending it
      // would splice two different versions of the file together.
      if (append && previous?.version && result.version && previous.version !== result.version) { void readFile(); return; }
      if (typeof result.content !== 'string') throw new Error('The file could not be decoded as text.');
      if (result.content.includes('\u0000')) { setBinary(true); setDoc(null); documents.current.set(selected, { doc: null, binary: true }); return; }
      setBinary(false);
      const next = append && previous ? { ...result, content: previous.content + '\n' + result.content, loadedLines: previous.loadedLines + result.loadedLines, truncated: result.endLine < result.totalLines } : previous?.content === result.content && previous?.totalLines === result.totalLines && previous?.size === result.size && previous?.version === result.version ? previous : result;
      docRef.current = next; setDoc(next);
      documents.current.delete(selected); documents.current.set(selected, { doc: next, binary: false });
      // A small, per-tab cache keeps recently viewed files ready without keeping
      // an unbounded transcript's worth of source text in memory.
      let characters = [...documents.current.values()].reduce((sum, item) => sum + (item.doc?.content.length || 0), 0);
      while (documents.current.size > 1 && (documents.current.size > 12 || characters > 4_000_000)) {
        const key = documents.current.keys().next().value!;
        characters -= documents.current.get(key)?.doc?.content.length || 0; documents.current.delete(key);
      }
    } catch (error) { if (!abort.signal.aborted) setError(String((error as Error).message || error)); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  };
  useLayoutEffect(() => { request.current?.abort(); const saved = documents.current.get(selected); setDoc(saved?.doc || null); docRef.current = saved?.doc || null; setError(''); setBinary(saved?.binary || false); setQuery(''); scroll.current?.scrollTo(0, 0); }, [selected]);
  useEffect(() => { if (selected && !media && !office) void readFile(); else setLoading(false); return () => request.current?.abort(); }, [selected, revision]);
  const chooseFolder = async () => {
    setFolderMenu('');
    try { const next = await api()?.selectFolder(); if (typeof next === 'string' && next) onAddFolder(next); } catch (error) { setActionError(String(error)); }
  };
  const loadApps = () => {
    if (!api()?.workspaceOpenApps || openingApps) return;
    setOpeningApps(true);
    void api().workspaceOpenApps().then((items: OpenApp[]) => {
      const seen = new Set<string>();
      const detected = items.filter(item => { const key = item.name.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
      setApps(detected);
    }).catch(() => {}).finally(() => setOpeningApps(false));
  };
  useEffect(() => { loadApps(); }, []);
  useEffect(() => {
    let saved = ''; try { saved = localStorage.getItem(preferenceKey) || ''; } catch {}
    const editor = selected && !media && !office ? apps.find(item => ['code', 'cursor', 'antigravity', 'sublime'].includes(item.id))?.id : undefined;
    setPreferred(saved === 'default' || apps.some(item => item.id === saved) ? saved : editor || 'default');
  }, [apps, preferenceKey, selected, media, office]);
  const openWith = async (application = appChoice?.id || 'default') => {
    setActionError('');
    try {
      if (application === 'terminal') {
        addWorkspaceTab(owner, 'terminal'); showTerminal(owner, 'right');
        await createTerminal(owner, selected ? parentPath(selected) : root);
      } else if (api()?.workspaceOpenFile) await api().workspaceOpenFile(selected || root, application);
      else if (application === 'default') { const result = await api()?.openPath(selected || root); if (result) throw new Error(result); }
      else throw new Error('Restart EterX to enable this action.');
      if (!['terminal', 'reveal', 'save-as'].includes(application)) { setPreferred(application); try { localStorage.setItem(preferenceKey, application); } catch {} }
    } catch (error) { setActionError(String((error as Error).message || error)); }
  };
  const copy = async () => {
    if (!doc) return;
    setCopied(await safeCopyTextToClipboard(doc.content));
    clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1800);
  };
  return <FileActivity.Provider value={isActive}><div className="eterx-workspace-files">
    <div ref={toolbar} className="eterx-workspace-file-toolbar eterx-workspace-file-navigation" onKeyDown={event => { if (event.key === 'Escape') setFolderMenu(''); }}>
      <nav className="eterx-workspace-breadcrumb" aria-label="File path">
        {!selected && roots.length !== 1 ? <strong>{roots.length ? 'Chat folders' : 'Files'}</strong> : breadcrumbs(root, selected).map((part, index) => <span key={part.path} className="eterx-workspace-path-part">{index > 0 && <ChevronRight size={12} />}<button aria-expanded={folderMenu === part.path} onClick={() => setFolderMenu(value => value === part.path ? '' : part.path)}>{part.label || 'Workspace'}</button></span>)}
        {selected && <><ChevronRight size={12} /><strong>{fileName(selected)}</strong></>}
      </nav>
      <div className="eterx-workspace-open-group">
        <button aria-label={'Open in ' + (appChoice?.name || 'default app')} disabled={!selected && !root} onClick={() => void openWith()}>{appChoice?.icon ? <img className="eterx-workspace-native-icon" src={appChoice.icon} alt="" /> : <AppWindow size={16} />}<span>Open</span></button>
        <WorkspaceMenu label="Open with" trigger={<ChevronDown size={13} />} onOpen={loadApps}>
          {openingApps && !apps.length && <div className="eterx-workspace-tree-status"><Loader2 size={14} className="animate-spin" /> Finding apps…</div>}
          {apps.map(item => <button role="menuitem" key={item.id} onClick={() => void openWith(item.id)}>{item.icon ? <img className="eterx-workspace-native-icon" src={item.icon} alt="" /> : <AppWindow size={16} />}<span>{item.name}</span>{appChoice?.id === item.id && <Check size={13} />}</button>)}
          <button role="menuitem" onClick={() => void openWith('default')}><AppWindow size={16} /><span>Default app</span>{!appChoice && <Check size={13} />}</button>
          <button role="menuitem" onClick={() => void openWith('terminal')}><TerminalSquare size={16} />Terminal</button>
          <hr /><button role="menuitem" onClick={() => void openWith('reveal')}><FolderOpen size={16} />Show in folder</button>
          <button role="menuitem" disabled={!selected} onClick={() => void openWith('save-as')}>Save a copy…</button>
        </WorkspaceMenu>
      </div>
      <Tooltip text={showTree ? 'Hide file tree' : 'Show file tree'}><button aria-label="Toggle file tree" aria-pressed={showTree} onClick={() => setShowTree(value => !value)}><Folders size={17} /></button></Tooltip>
      {folderMenu && <div className="eterx-workspace-folder-menu"><div className="eterx-workspace-folder-menu-heading"><WorkspaceFileIcon path={folderMenu} folder /><span>{fileName(folderMenu)}</span><button aria-label="Close folder menu" onClick={() => setFolderMenu('')}><X size={14} /></button></div><div className="eterx-workspace-folder-menu-scroll eterx-scrollbar"><FolderEntries key={folderMenu} path={folderMenu} selected={selected} filter="" showHidden={showHidden} compact={compactFolders} onSelect={path => { setFolderMenu(''); onOpenFile(path, root); }} /></div>{!workspacePath && <button className="eterx-workspace-file-row" onClick={() => void chooseFolder()}>Add folder to this chat…</button>}</div>}
    </div>
    {actionError && <div className="eterx-workspace-inline-error" role="alert">{actionError}<button aria-label="Dismiss error" onClick={() => setActionError('')}><X size={14} /></button></div>}
    <div className="eterx-workspace-files-body" data-tree={showTree} data-empty={!selected && roots.length > 0 && showTree}>
      <div className="eterx-workspace-document">
        {selected && !media && !office && !binary && <div className="eterx-workspace-document-tools"><div className="eterx-workspace-search"><FileSearchCorner size={14} /><input placeholder="Find in file" aria-label="Find in file" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') scroll.current?.querySelector('.is-match')?.scrollIntoView({ block: 'center' }); }} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={13} /></button>}</div><Tooltip text="Word wrap"><button aria-label="Toggle word wrap" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={16} /></button></Tooltip><Tooltip text={copied ? 'Copied' : 'Copy loaded text'}><button aria-label={copied ? 'Copied' : 'Copy loaded text'} disabled={!doc} onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></Tooltip><WorkspaceMenu label="Text size" trigger={<><span>{fontSize}px</span><ChevronDown size={12} /></>}>{[12,13,14,16,18].map(size => <button role="menuitemradio" aria-checked={fontSize === size} key={size} onClick={() => setFontSize(size)}><span>{size}px</span>{fontSize === size && <Check size={13} />}</button>)}</WorkspaceMenu></div>}
        <div ref={scroll} className="eterx-workspace-document-scroll eterx-scrollbar">
          {!selected ? <Empty><FolderOpen size={32} strokeWidth={1.5} /><h3>Select a file</h3><p>{roots.length ? workspacePath ? 'Browse your selected workspace in the file tree.' : 'Browse the folders used in this chat.' : rootsLoading ? 'Finding this chat’s folders…' : 'Folders appear here when the agent works with files, or you can add one.'}</p>{rootError && <p role="alert">{rootError}</p>}{!workspacePath && <button onClick={() => void chooseFolder()}>Add folder</button>}</Empty>
            : error && !doc ? <Empty><File size={30} /><p role="alert">{error}</p><button onClick={() => void readFile()}>Try again</button><button onClick={() => void openWith()}>Open in app</button></Empty>
            : office || binary ? <Empty><WorkspaceFileIcon path={selected} size={48} /><h3>{fileName(selected)}</h3><p>Open this file in its desktop app to view or edit it.</p><button onClick={() => void openWith()}>Open in {appChoice?.name || 'default app'}</button></Empty>
            : media ? /\.(png|jpe?g|webp|gif|svg|avif|ico)$/i.test(selected) ? <WorkspaceImagePreview key={selected} path={selected} revision={revision} /> : <div className="eterx-workspace-media">{/\.pdf$/i.test(selected) ? <iframe title={fileName(selected)} src={buildFilePreviewUrl(selected)} /> : /\.(mp4|webm|mov)$/i.test(selected) ? <video controls src={buildFilePreviewUrl(selected)} /> : <audio controls src={buildFilePreviewUrl(selected)} />}</div>
            : doc ? <>{error && <div className="eterx-workspace-inline-error" role="alert">{error}</div>}<WorkspaceCode content={doc.content} path={selected} language={doc.language} query={query} wrap={wrap} size={fontSize} />{doc.truncated && <button className="eterx-workspace-load-more" disabled={loading || doc.loadedLines >= 10000} onClick={() => void readFile(true)}>{doc.loadedLines >= 10000 ? '10,000 lines shown · Open in app to read more' : loading ? 'Loading…' : 'Read next 1,000 lines (' + doc.loadedLines + ' of ' + doc.totalLines + ')'}</button>}</>
            : loading ? <Empty><Loader2 size={24} className="animate-spin" /><p>Reading file…</p></Empty> : null}
        </div>
        {doc && <div className="eterx-workspace-file-status"><span>{doc.language || 'Plain text'}</span><span>{doc.totalLines.toLocaleString()} lines · {(doc.size / 1024).toFixed(1)} KB</span><span>{loading ? 'Updating…' : 'Read only'}</span></div>}
      </div>
      {showTree && <WorkspaceTreePane owner={owner} tabId={tab.id} width={tab.treeWidth} full={!selected && roots.length > 0}><div className="eterx-workspace-search"><FileSearchCorner size={14} /><input aria-label="Filter files in expanded folders" placeholder="Filter files…" value={filter} onChange={event => setFilter(event.target.value)} /></div><div className="eterx-workspace-tree-scroll eterx-scrollbar">{roots.map(directory => <FilesRootFolder key={directory} directory={directory} rootsLength={roots.length} filter={filter} showHidden={showHidden} compact={compactFolders} selected={selected} onOpenFile={onOpenFile} />)}{!roots.length && <p className="eterx-workspace-tree-status">{rootError || (rootsLoading ? 'Finding chat folders…' : 'No folders used in this chat yet.')}</p>}</div></WorkspaceTreePane>}
    </div>
  </div></FileActivity.Provider>;
}
