'use client';

import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Check, ChevronDown, ChevronRight, ChevronUp, Copy, File, FolderOpen, Folders, Loader2, Search, TerminalSquare, WrapText, X } from 'lucide-react';
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
import { WorkspaceDocumentPreview } from './workspace-document-preview';
import { isMarkdownDocument, WorkspaceMarkdownPreview } from './workspace-markdown-preview';
import { useWorkspaceReadingPosition } from './use-workspace-reading-position';
import { revealInWorkspaceScroller } from './workspace-scroll';

type Entry = { name: string; path: string; type: 'file' | 'directory' };
type FlattenedEntry = Entry & {
  terminalPath?: string;
  segments?: { name: string; path: string }[];
};
type Document = { content: string; language?: string; totalLines: number; loadedLines: number; endLine: number; truncated: boolean; size: number; version?: string };
type OpenApp = { id: string; name: string; icon?: string; folders?: boolean };
function OpenAppIcon({ icon }: { icon?: string }) {
  const [failedSource, setFailedSource] = useState<string>();
  return icon && failedSource !== icon
    ? <img className="eterx-workspace-native-icon" src={icon} alt="" draggable={false} onError={() => setFailedSource(icon)} />
    : <AppWindow size={16} aria-hidden="true" />;
}
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const parentPath = (path: string) => {
  const parent = path.replace(/[\\/][^\\/]+[\\/]?$/, '');
  return /^[A-Za-z]:$/.test(parent) ? parent + '\\' : parent || (path.startsWith('/') ? '/' : path);
};
const api = () => typeof window === 'undefined' ? undefined : (window as any).electronAPI;
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
        <button data-file-tree-item className={'eterx-workspace-file-row ' + (selected === entry.path || selected === activePath ? 'is-selected' : '')} style={{ paddingLeft: 8 + depth * 14 }} aria-label={activePath} aria-expanded={isDir ? isExpanded : undefined} aria-current={selected === entry.path ? 'page' : undefined} onClick={() => {
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
type SourceMatch = { line: number; start: number; end: number; index: number };
const noMatches: SourceMatch[] = [];
function findSourceMatches(content: string, query: string): SourceMatch[] {
  if (!query) return noMatches;
  const found: SourceMatch[] = [], needle = query.toLowerCase();
  content.split('\n').forEach((line, lineIndex) => {
    const value = line.toLowerCase();
    let offset = value.indexOf(needle);
    while (offset !== -1) {
      found.push({ line: lineIndex, start: offset, end: offset + query.length, index: found.length });
      offset = value.indexOf(needle, offset + query.length);
    }
  });
  return found;
}

export const WorkspaceCode = memo(function WorkspaceCode({ content, path = '', language, matches = noMatches, activeMatch = 0, wrap = false, size = 13 }: { content: string; path?: string; language?: string; matches?: SourceMatch[]; activeMatch?: number; wrap?: boolean; size?: number }) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const matchesByLine = useMemo(() => {
    const result = new Map<number, SourceMatch[]>();
    for (const match of matches) { const row = result.get(match.line) || []; row.push(match); result.set(match.line, row); }
    return result;
  }, [matches]);
  const [highlighted, setHighlighted] = useState<{ content: string; tokens: WorkspaceTokens | null } | null>(null);
  useEffect(() => {
    let active = true;
    void highlightWorkspaceCode(content, workspaceLanguage(path, language)).then(tokens => { if (active) setHighlighted({ content, tokens }); });
    return () => { active = false; };
  }, [content, path, language]);
  const tokens = highlighted?.content === content ? highlighted.tokens : null;
  const markText = (text: string, offset: number, rowMatches: SourceMatch[]) => {
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    for (const match of rowMatches) {
      const start = Math.max(0, match.start - offset), end = Math.min(text.length, match.end - offset);
      if (end <= start) continue;
      if (start > cursor) parts.push(text.slice(cursor, start));
      parts.push(<mark key={`${match.index}:${offset}`} data-workspace-match={match.index} data-active={match.index === activeMatch}>{text.slice(start, end)}</mark>);
      cursor = end;
    }
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  };
  return <div className="eterx-workspace-code" data-wrap={wrap} style={{ fontSize: size }}>
    {lines.map((line, index) => {
      const rowMatches = matchesByLine.get(index) || noMatches;
      let offset = 0;
      return <div className={'eterx-workspace-code-line ' + (rowMatches.some(match => match.index === activeMatch) ? 'is-match' : '')} data-source-line={index + 1} key={index}>
        <span className="eterx-workspace-line-number" aria-hidden="true">{index + 1}</span>
        <code>{tokens?.[index] ? tokens[index].map((token, i) => {
          const start = offset; offset += token.text.length;
          return <span key={i} className="eterx-workspace-syntax-token" style={{ '--ws-code-light': token.light, '--ws-code-dark': token.dark } as React.CSSProperties}>{rowMatches.length ? markText(token.text, start, rowMatches) : token.text}</span>;
        }) : rowMatches.length ? markText(line, 0, rowMatches) : line}{line ? '' : '\u00a0'}</code>
      </div>;
    })}
  </div>;
});

export function WorkspaceMenu({ label, trigger, children, onOpen, disabled = false, align = 'end' }: { label: string; trigger: React.ReactNode; children: React.ReactNode; onOpen?: () => void; disabled?: boolean; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const node = useRef<HTMLDivElement>(null);
  const focusEdge = useRef<'first' | 'last' | null>(null);
  useLayoutEffect(() => {
    if (disabled) { setOpen(false); return; }
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
      const preferredLeft = align === 'start' ? bounds.left : bounds.right - width;
      menu.style.left = Math.max(leftEdge, Math.min(preferredLeft, rightEdge - width)) - bounds.left + 'px';
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
  }, [open, disabled, align]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!node.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div ref={node} className="eterx-workspace-menu-anchor" onKeyDown={event => {
    if (disabled) return;
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
    <button type="button" aria-label={label} aria-expanded={open && !disabled} aria-haspopup="menu" disabled={disabled} onClick={() => { if (!open) onOpen?.(); setOpen(value => !value); }}>{trigger}</button>
    {open && !disabled && <div className="eterx-workspace-menu eterx-scrollbar" role="menu" aria-label={label} onClick={event => { if ((event.target as HTMLElement).closest('button')) { setOpen(false); node.current?.querySelector('button')?.focus(); } }}>{children}</div>}
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
  for (const segment of relative.slice(0, -1)) {
    path = path.replace(/[\\/]$/, '') + '/' + segment;
    parts.push({ label: segment, path });
  }
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
      <summary data-file-tree-item aria-label={directory}>
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
  const [showTree, setShowTree] = useState(() => !isMarkdownDocument(tab.path || ''));
  const [treeMounted, setTreeMounted] = useState(showTree);
  const treeScroll = useRef<HTMLDivElement>(null);
  const treePosition = useRef({ top: 0, left: 0 });
  useLayoutEffect(() => { if (showTree && isActive) treeScroll.current?.scrollTo({ ...treePosition.current, behavior: 'auto' }); }, [showTree, isActive]);
  const [showHidden, setShowHidden] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [markdownWrap, setMarkdownWrap] = useState(true);
  const [sourceViews, setSourceViews] = useState<Record<string, boolean>>({});
  const [activeMatch, setActiveMatch] = useState(0);
  const [findNavigation, setFindNavigation] = useState(0);
  const pendingFind = useRef(false);
  const findInput = useRef<HTMLInputElement>(null);
  const [findFocusRequest, setFindFocusRequest] = useState(0);
  const handledFindFocus = useRef(0);
  const [fontSize, setFontSize] = useState(13);
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [binary, setBinary] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [apps, setApps] = useState<OpenApp[]>([]);
  const [openingApps, setOpeningApps] = useState(false);
  const [appsError, setAppsError] = useState('');
  const [openingFile, setOpeningFile] = useState(false);
  const appsPending = useRef(false);
  const actionPending = useRef(false);
  const mounted = useRef(true);
  const [preferred, setPreferred] = useState('default');
  const [folderMenu, setFolderMenu] = useState('');
  const toolbar = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const selected = tab.path || '';
  const markdown = isMarkdownDocument(selected);
  const markdownPreview = markdown && !sourceViews[selected];
  const sourceWrap = markdown ? markdownWrap : wrap;
  const media = /\.(png|jpg|jpeg|webp|gif|svg|avif|ico|mp4|webm|mov|mp3|wav|ogg|pdf)$/i.test(selected);
  const office = /\.(xlsx?|docx?|pptx?|od[stp]|rtf|numbers|pages|key|zip|7z|exe|dll)$/i.test(selected);
  const revision = useFolderRevision(selected ? parentPath(selected) : '', isActive);
  const request = useRef<AbortController>(undefined);
  const documents = useRef(new Map<string, { doc: Document | null; binary: boolean }>());
  const docRef = useRef(doc); docRef.current = doc;
  const saveReadingPosition = useWorkspaceReadingPosition(scroll, selected, markdownPreview ? 'preview' : 'source', Boolean(doc && documents.current.get(selected)?.doc === doc), isActive);
  const openFile = useCallback((path: string, root: string) => { saveReadingPosition(); onOpenFile(path, root); }, [saveReadingPosition, onOpenFile]);
  const matches = useMemo(() => findSourceMatches(doc?.content || '', query), [doc?.content, query]);
  const currentMatch = matches.length ? Math.min(activeMatch, matches.length - 1) : 0;
  useLayoutEffect(() => {
    if (!pendingFind.current || markdownPreview || !isActive) return;
    const frame = requestAnimationFrame(() => {
      const target = scroll.current?.querySelector<HTMLElement>(`[data-workspace-match="${currentMatch}"]`);
      if (target && scroll.current) revealInWorkspaceScroller(scroll.current, target, 'center');
      pendingFind.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [currentMatch, matches, findNavigation, markdownPreview, isActive]);
  useEffect(() => {
    if (!findFocusRequest || handledFindFocus.current === findFocusRequest || markdownPreview || !isActive) return;
    handledFindFocus.current = findFocusRequest;
    findInput.current?.focus({ preventScroll: true }); findInput.current?.select();
  }, [findFocusRequest, markdownPreview, isActive]);
  const availableApps = selected ? apps : apps.filter(item => item.folders !== false);
  const appChoice = availableApps.find(item => item.id === preferred);
  const preferenceKey = 'eterx.workspace.open-app.' + (selected ? fileName(selected).split('.').slice(1).pop()?.toLowerCase() || 'text' : 'folder');
  const currentPreferenceKey = useRef(preferenceKey); currentPreferenceKey.current = preferenceKey;
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
      const response = await fetch('/api/code/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: selected, knownVersion: append ? undefined : previous?.version, offset: append ? (previous?.endLine || 0) + 1 : 1, limit: append ? 1000 : Math.min(10000, Math.max(markdown ? 10000 : 1000, previous?.loadedLines || 0)) }), signal: abort.signal });
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
  useLayoutEffect(() => { request.current?.abort(); const saved = documents.current.get(selected); setDoc(saved?.doc || null); docRef.current = saved?.doc || null; setError(''); setBinary(saved?.binary || false); setQuery(''); pendingFind.current = false; setActiveMatch(0); setCopied(false); setFolderMenu(''); if (media || office) scroll.current?.scrollTo(0, 0); }, [selected]);
  useEffect(() => { if (isActive && selected && !media && !office) void readFile(); else setLoading(false); return () => request.current?.abort(); }, [selected, revision, isActive]);
  const chooseFolder = async () => {
    setFolderMenu('');
    try { const next = await api()?.selectFolder(); if (typeof next === 'string' && next) onAddFolder(next); } catch (error) { setActionError(String(error)); }
  };
  const loadApps = (refresh = false) => {
    const desktop = api();
    if (!desktop?.workspaceOpenApps || appsPending.current) return;
    appsPending.current = true;
    setOpeningApps(true);
    setAppsError('');
    void Promise.resolve().then(() => desktop.workspaceOpenApps(refresh)).then((items: OpenApp[]) => {
      if (!Array.isArray(items)) throw new Error('Could not read the installed applications.');
      const seen = new Set<string>();
      const detected = items.filter(item => { if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || seen.has(item.id)) return false; seen.add(item.id); return true; });
      if (mounted.current) setApps(detected);
    }).catch((error: unknown) => {
      if (mounted.current) setAppsError(error instanceof Error ? error.message : 'Could not find installed applications.');
    }).finally(() => { appsPending.current = false; if (mounted.current) setOpeningApps(false); });
  };
  useEffect(() => { mounted.current = true; loadApps(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let saved = ''; try { saved = localStorage.getItem(preferenceKey) || ''; } catch {}
    const editor = selected && !media && !office && !binary ? apps.find(item => ['code', 'code-insiders', 'cursor', 'antigravity', 'windsurf', 'zed', 'sublime'].includes(item.id))?.id : undefined;
    setPreferred(saved === 'default' || apps.some(item => item.id === saved && (selected || item.folders !== false)) ? saved : saved ? 'default' : editor || 'default');
  }, [apps, preferenceKey, selected, media, office, binary]);
  const openWith = async (application = appChoice?.id || 'default') => {
    if (actionPending.current || (!selected && !root)) return;
    actionPending.current = true;
    setOpeningFile(true);
    setActionError('');
    try {
      if (application === 'terminal') {
        addWorkspaceTab(owner, 'terminal'); showTerminal(owner, 'right');
        await createTerminal(owner, selected ? parentPath(selected) : root);
      } else if (api()?.workspaceOpenFile) await api().workspaceOpenFile(selected || root, application);
      else if (application === 'default') {
        if (api()?.openPath) { const result = await api().openPath(selected || root); if (result) throw new Error(result); }
        else {
          const response = await fetch('/api/files/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selected || root }) });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || 'Could not open this path.');
        }
      }
      else throw new Error('Restart EterX to enable this action.');
      if (!['terminal', 'reveal', 'save-as'].includes(application)) {
        if (mounted.current && currentPreferenceKey.current === preferenceKey) setPreferred(application);
        try { localStorage.setItem(preferenceKey, application); } catch {}
      }
    } catch (error) {
      if (mounted.current) { setActionError(String((error as Error).message || error)); loadApps(true); }
    } finally { actionPending.current = false; if (mounted.current) setOpeningFile(false); }
  };
  const copy = async () => {
    if (!doc) return;
    setCopied(await safeCopyTextToClipboard(doc.content));
    clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1800);
  };
  const switchMarkdownView = () => {
    saveReadingPosition();
    setSourceViews(previous => {
      const next = { ...previous }; delete next[selected]; next[selected] = markdownPreview;
      const keys = Object.keys(next); if (keys.length > 48) delete next[keys[0]];
      return next;
    });
  };
  const beginFind = () => {
    if (markdownPreview) switchMarkdownView();
    setFindFocusRequest(value => value + 1);
  };
  const moveMatch = (direction: number) => {
    if (!matches.length) return;
    pendingFind.current = true;
    setActiveMatch((currentMatch + direction + matches.length) % matches.length);
    setFindNavigation(value => value + 1);
  };
  const closeFind = () => { setQuery(''); pendingFind.current = false; scroll.current?.focus({ preventScroll: true }); };
  const toggleTree = () => {
    if (showTree && treeScroll.current) treePosition.current = { top: treeScroll.current.scrollTop, left: treeScroll.current.scrollLeft };
    setTreeMounted(true); setShowTree(value => !value);
  };
  return <FileActivity.Provider value={isActive}><div className="eterx-workspace-files" data-markdown={markdown} data-file-view={markdownPreview ? 'preview' : 'source'} onKeyDown={event => {
    if (!isActive || !selected || media || office || binary || event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); beginFind(); }
    else if (event.key === 'F3') { event.preventDefault(); event.stopPropagation(); if (markdownPreview || !query) beginFind(); else moveMatch(event.shiftKey ? -1 : 1); }
  }}>
    <div ref={toolbar} className="eterx-workspace-file-toolbar eterx-workspace-file-navigation" onKeyDown={event => { if (event.key === 'Escape') setFolderMenu(''); }}>
      <nav className="eterx-workspace-breadcrumb" aria-label="File path" title={selected || root}>
        {!selected && roots.length !== 1 ? <strong>{roots.length ? 'Chat folders' : 'Files'}</strong> : breadcrumbs(root, selected).map((part, index) => <span key={part.path} className="eterx-workspace-path-part">{index > 0 && <ChevronRight size={12} />}<button aria-expanded={folderMenu === part.path} onClick={() => setFolderMenu(value => value === part.path ? '' : part.path)}>{part.label || 'Workspace'}</button></span>)}
        {selected && <><ChevronRight size={12} /><strong>{fileName(selected)}</strong></>}
      </nav>
      {markdown && <>
        <Tooltip text="Find in source"><button className="eterx-workspace-markdown-action" aria-label="Find in source" aria-keyshortcuts="Control+f Meta+f" onClick={beginFind}><FileSearchCorner size={17} /></button></Tooltip>
        <button type="button" className="eterx-workspace-markdown-toggle" onClick={switchMarkdownView} aria-label={markdownPreview ? 'View Markdown source' : 'View Markdown preview'}>{markdownPreview ? 'View source' : 'View preview'}</button>
        <Tooltip text={copied ? 'Copied' : 'Copy Markdown'}><button className="eterx-workspace-markdown-action eterx-workspace-markdown-copy" aria-label={copied ? 'Copied' : 'Copy Markdown'} disabled={!doc} onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></Tooltip>
      </>}
      <Tooltip text={showTree ? 'Hide file tree' : 'Show file tree'}><button className={markdown ? 'eterx-workspace-markdown-action' : undefined} aria-label={showTree ? 'Hide file tree' : 'Show file tree'} aria-expanded={showTree} aria-controls={`workspace-tree-${tab.id}`} onClick={toggleTree}><Folders size={17} /></button></Tooltip>
      <div className="eterx-workspace-open-group">
        <button aria-label={'Open in ' + (appChoice?.name || 'default app')} disabled={openingFile || (!selected && !root)} onClick={() => void openWith()}>{openingFile ? <Loader2 size={16} className="animate-spin" /> : <OpenAppIcon icon={appChoice?.icon} />}<span>Open</span></button>
        <WorkspaceMenu label="Open with" trigger={<ChevronDown size={13} />} onOpen={() => loadApps(true)}>
          {openingApps && <div className="eterx-workspace-tree-status" role="status"><Loader2 size={14} className="animate-spin" /> Finding apps…</div>}
          {appsError && <div className="eterx-workspace-tree-status" role="alert">{appsError} Reopen this menu to retry.</div>}
          {!openingApps && !appsError && !availableApps.length && <div className="eterx-workspace-tree-status">{api()?.workspaceOpenApps ? 'No compatible editors found.' : 'App discovery is available in the desktop app.'}</div>}
          {availableApps.map(item => <button role="menuitemradio" aria-checked={appChoice?.id === item.id} disabled={openingFile || (!selected && !root)} key={item.id} onClick={() => void openWith(item.id)}><OpenAppIcon icon={item.icon} /><span>{item.name}</span>{appChoice?.id === item.id && <Check size={13} />}</button>)}
          <button role="menuitemradio" aria-checked={!appChoice} disabled={openingFile || (!selected && !root)} onClick={() => void openWith('default')}><AppWindow size={16} /><span>Default app</span>{!appChoice && <Check size={13} />}</button>
          <button role="menuitem" disabled={openingFile || (!selected && !root)} onClick={() => void openWith('terminal')}><TerminalSquare size={16} />Terminal</button>
          <hr /><button role="menuitem" disabled={openingFile || (!selected && !root) || !api()?.workspaceOpenFile} onClick={() => void openWith('reveal')}><FolderOpen size={16} />Show in folder</button>
          <button role="menuitem" disabled={openingFile || !selected || !api()?.workspaceOpenFile} onClick={() => void openWith('save-as')}>Save a copy…</button>
        </WorkspaceMenu>
      </div>
      {folderMenu && <div className="eterx-workspace-folder-menu"><div className="eterx-workspace-folder-menu-heading"><WorkspaceFileIcon path={folderMenu} folder /><span>{fileName(folderMenu)}</span><button aria-label="Close folder menu" onClick={() => setFolderMenu('')}><X size={14} /></button></div><div className="eterx-workspace-folder-menu-scroll eterx-scrollbar"><FolderEntries key={folderMenu} path={folderMenu} selected={selected} filter="" showHidden={showHidden} compact={compactFolders} onSelect={path => { setFolderMenu(''); openFile(path, root); }} /></div>{!workspacePath && <button className="eterx-workspace-file-row" onClick={() => void chooseFolder()}>Add folder to this chat…</button>}</div>}
    </div>
    {actionError && <div className="eterx-workspace-inline-error" role="alert">{actionError}<button aria-label="Dismiss error" onClick={() => setActionError('')}><X size={14} /></button></div>}
    <div className="eterx-workspace-files-body" data-tree={showTree} data-empty={!selected && roots.length > 0 && showTree}>
      <div className="eterx-workspace-document">
        {selected && !media && !office && !binary && !markdownPreview && <div className="eterx-workspace-document-tools">
          <div className="eterx-workspace-search">
            <FileSearchCorner size={14} />
            <input ref={findInput} placeholder="Find in file" aria-label="Find in loaded file text" value={query} onChange={event => { setQuery(event.target.value); setActiveMatch(0); pendingFind.current = true; setFindNavigation(value => value + 1); }} onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); moveMatch(event.shiftKey ? -1 : 1); }
              else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
            }} />
            {query && <><span className="eterx-workspace-find-count" role="status" aria-live="polite">{matches.length ? `${currentMatch + 1} / ${matches.length}` : 'No matches'}</span><button aria-label="Clear search" onClick={closeFind}><X size={13} /></button></>}
          </div>
          <button aria-label="Previous match" disabled={!matches.length} onClick={() => moveMatch(-1)}><ChevronUp size={15} /></button>
          <button aria-label="Next match" disabled={!matches.length} onClick={() => moveMatch(1)}><ChevronDown size={15} /></button>
          <Tooltip text="Word wrap"><button aria-label="Toggle word wrap" aria-pressed={sourceWrap} onClick={() => markdown ? setMarkdownWrap(value => !value) : setWrap(value => !value)}><WrapText size={16} /></button></Tooltip>
          <Tooltip text={copied ? 'Copied' : 'Copy loaded text'}><button aria-label={copied ? 'Copied' : 'Copy loaded text'} disabled={!doc} onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></Tooltip>
          <WorkspaceMenu label="Text size" trigger={<><span>{fontSize}px</span><ChevronDown size={12} /></>}>{[12,13,14,16,18,20,24].map(size => <button role="menuitemradio" aria-checked={fontSize === size} key={size} onClick={() => setFontSize(size)}><span>{size}px</span>{fontSize === size && <Check size={13} />}</button>)}</WorkspaceMenu>
        </div>}
        <div ref={scroll} className="eterx-workspace-document-scroll eterx-scrollbar" data-markdown-preview={markdownPreview} tabIndex={selected ? 0 : -1} role="region" aria-label={selected ? `${fileName(selected)} ${markdownPreview ? 'preview' : 'source'}` : 'File viewer'}
          onPointerDown={event => {
            const target = event.target as Element;
            const focusable = target.closest('[tabindex]');
            if (event.button === 0 && (!focusable || focusable === event.currentTarget) && !target.closest('a,button,input,textarea,select,[contenteditable="true"],iframe,video,audio')) event.currentTarget.focus({ preventScroll: true });
          }}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !media && !office && !binary) {
              const content = event.currentTarget.querySelector('.eterx-workspace-code,.eterx-workspace-markdown');
              if (content) { event.preventDefault(); event.stopPropagation(); const range = document.createRange(); range.selectNodeContents(content); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
            } else if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End',' '].includes(event.key)) event.stopPropagation();
          }}>
          {!selected ? <Empty><FolderOpen size={32} strokeWidth={1.5} /><h3>Select a file</h3><p>{roots.length ? workspacePath ? 'Browse your selected workspace in the file tree.' : 'Browse the folders used in this chat.' : rootsLoading ? 'Finding this chat’s folders…' : 'Folders appear here when the agent works with files, or you can add one.'}</p>{rootError && <p role="alert">{rootError}</p>}{!workspacePath && <button onClick={() => void chooseFolder()}>Add folder</button>}</Empty>
            : error && !doc ? <Empty><File size={30} /><p role="alert">{error}</p><button onClick={() => void readFile()}>Try again</button><button onClick={() => void openWith()}>Open in app</button></Empty>
            : office || binary ? <WorkspaceDocumentPreview key={selected} path={selected} revision={revision} isActive={isActive} onOpen={() => void openWith()} />
            : media ? /\.(png|jpe?g|webp|gif|svg|avif|ico)$/i.test(selected) ? <WorkspaceImagePreview key={selected} path={selected} revision={revision} /> : <div className="eterx-workspace-media">{/\.pdf$/i.test(selected) ? <iframe title={fileName(selected)} src={buildFilePreviewUrl(selected)} /> : /\.(mp4|webm|mov)$/i.test(selected) ? <video controls src={buildFilePreviewUrl(selected)} /> : <audio controls src={buildFilePreviewUrl(selected)} />}</div>
            : doc ? <>{error && <div className="eterx-workspace-inline-error" role="alert">{error}</div>}{markdownPreview ? <WorkspaceMarkdownPreview content={doc.content} path={selected} onOpenFile={path => openFile(path, root)} /> : <WorkspaceCode content={doc.content} path={selected} language={doc.language} matches={matches} activeMatch={currentMatch} wrap={sourceWrap} size={fontSize} />}{doc.truncated && <button className="eterx-workspace-load-more" disabled={loading || doc.loadedLines >= 10000} onClick={() => void readFile(true)}>{doc.loadedLines >= 10000 ? '10,000 lines shown · Open in app to read more' : loading ? 'Loading…' : 'Read next 1,000 lines (' + doc.loadedLines + ' of ' + doc.totalLines + ')'}</button>}</>
            : loading ? <Empty><Loader2 size={24} className="animate-spin" /><p>Reading file…</p></Empty> : null}
        </div>
        {doc && <div className="eterx-workspace-file-status"><span>{markdownPreview ? 'Markdown preview' : doc.language || 'Plain text'}</span><span>{doc.totalLines.toLocaleString()} lines · {(doc.size / 1024).toFixed(1)} KB</span><span>{loading ? 'Updating…' : 'Read only'}</span></div>}
      </div>
      {treeMounted && <FileActivity.Provider value={isActive && showTree}><WorkspaceTreePane owner={owner} tabId={tab.id} width={tab.treeWidth} hidden={!showTree} full={!selected && roots.length > 0}><div className="eterx-workspace-search"><FileSearchCorner size={14} /><input aria-label="Filter files in expanded folders" placeholder="Filter files…" value={filter} onChange={event => setFilter(event.target.value)} /></div><div ref={treeScroll} className="eterx-workspace-tree-scroll eterx-scrollbar" tabIndex={0} role="region" aria-label="Workspace files" onScroll={event => { if (isActive && showTree) treePosition.current = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft }; }}>{roots.map(directory => <FilesRootFolder key={directory} directory={directory} rootsLength={roots.length} filter={filter} showHidden={showHidden} compact={compactFolders} selected={selected} onOpenFile={openFile} />)}{!roots.length && <p className="eterx-workspace-tree-status">{rootError || (rootsLoading ? 'Finding chat folders…' : 'No folders used in this chat yet.')}</p>}</div></WorkspaceTreePane></FileActivity.Provider>}
    </div>
  </div></FileActivity.Provider>;
}
