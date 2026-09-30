'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, EyeOff, FileCheck, FileText, Folder, Folders, FoldVertical, GitBranch, Highlighter, Image, Loader2, MoreHorizontal, RefreshCw, RotateCcw, UnfoldVertical, WrapText } from 'lucide-react';
import type { FilePanelProps } from './file-panel';
import { WorkspaceFileIcon } from './workspace-file-icon';
import { FileCodeCorner, FileSearchCorner, SquareSplitHorizontal } from './workspace-icons';
import { WorkspaceMenu } from './workspace-files';
import { reviewDisplayPath, WorkspaceReviewTree } from './workspace-review-tree';
import { watchWorkspaceFolder } from '../../lib/workspace-file-events';
import { Tooltip } from '../ui/tooltip';
import { safeCopyTextToClipboard } from '../ui/copy-button';
import { highlightWorkspaceCode, workspaceLanguage, type WorkspaceToken } from '../../lib/workspace-syntax';
import { updateWorkspaceTab, type WorkspaceTab } from '../../lib/side-workspace-store';
import { isWithinWorkspace, workspacePathKey, workspaceParent } from '../../lib/workspace-paths';
import { workspaceChatDiffLines } from '../../lib/workspace-review-data';
import { WorkspaceTreePane } from './workspace-tree-pane';
import { WorkspaceImagePreview } from './workspace-image-preview';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';

type Line = NonNullable<FilePanelProps['diffLines']>[number];
type Scope = 'chat' | 'working' | 'branch';
type ReviewFile = FilePanelProps & { relativePath?: string; status?: string; directory?: boolean; repositoryRoot?: string; baseRef?: string };
type Project = { root: string; scopeRoot: string; branch: string; upstream: string; baseRef: string; references: string[]; gitDirectory: string };
type Repository = Project & { key: string; projects?: Project[]; warnings?: string[]; files: ReviewFile[]; truncated?: boolean };
type Row = { left?: Line; right?: Line; line?: Line; hidden?: number; requestContext?: boolean; key: string };
const labels: Record<Scope, string> = { chat: 'Chat changes', working: 'Working tree', branch: 'Branch' };
const noFiles: ReviewFile[] = [];
const noLines: Line[] = [];

function makeRows(lines: Line[], split: boolean, expanded: boolean, unfolded: Set<string>): Row[] {
  const result: Row[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.isGap && line.skipped) { result.push({ key: 'gap-' + i, hidden: line.skipped, requestContext: true }); i++; continue; }
    if (!expanded && line.type === 'unchanged') {
      let end = i; while (lines[end]?.type === 'unchanged') end++;
      if (unfolded.has('fold-' + i)) {
        for (let n = i; n < end; n++) result.push({ key: String(n), line: lines[n] });
        i = end; continue;
      }
      if (end - i > 8) {
        for (let n = i; n < i + 3; n++) result.push({ key: String(n), line: lines[n] });
        result.push({ key: 'fold-' + i, hidden: end - i - 6 });
        for (let n = end - 3; n < end; n++) result.push({ key: String(n), line: lines[n] });
        i = end; continue;
      }
    }
    if (split && (line.type === 'removed' || line.type === 'added')) {
      const removed: Line[] = [], added: Line[] = [];
      const start = i;
      while (lines[i]?.type === 'removed' || lines[i]?.type === 'added') { (lines[i].type === 'removed' ? removed : added).push(lines[i]); i++; }
      for (let n = 0; n < Math.max(removed.length, added.length); n++) result.push({ key: start + '-' + n, left: removed[n], right: added[n] });
    } else { result.push({ key: String(i), line }); i++; }
  }
  return result;
}

function ignoreWhitespaceChanges(lines: Line[]): Line[] {
  const result: Line[] = [];
  for (let i = 0; i < lines.length;) {
    if (!['removed', 'added'].includes(lines[i].type)) { result.push(lines[i++]); continue; }
    const removed: Line[] = [], added: Line[] = [];
    const start = i;
    while (lines[i] && ['removed', 'added'].includes(lines[i].type)) { (lines[i].type === 'removed' ? removed : added).push(lines[i]); i++; }
    if (removed.length === added.length && removed.every((line, index) => line.content.replace(/\s/g, '') === added[index].content.replace(/\s/g, ''))) {
      result.push(...added.map((line, index) => ({ ...line, type: 'unchanged' as const, oldLine: removed[index].oldLine })));
    } else result.push(...lines.slice(start, i));
  }
  return result;
}

function inlineChanges(lines: Line[]) {
  const ranges = new Map<Line, [number, number]>();
  for (const row of makeRows(lines, true, true, new Set())) {
    if (!row.left || !row.right) continue;
    const before = row.left.content, after = row.right.content;
    let start = 0, suffix = 0;
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
    while (suffix < Math.min(before.length, after.length) - start && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    ranges.set(row.left, [start, before.length - suffix]); ranges.set(row.right, [start, after.length - suffix]);
  }
  return ranges;
}

export function WorkspaceReview({ owner, tab, isActive = true, files, workspacePath, roots, rootsLoading, rootError, onAddFolder, onOpenFile }: { owner: string; tab: WorkspaceTab; isActive?: boolean; files: FilePanelProps[]; workspacePath?: string | null; roots: string[]; rootsLoading: boolean; rootError: string; onAddFolder: (path: string) => void; onOpenFile: (path: string, root?: string) => void }) {
  const [scope, setScope] = useState<Scope>(tab.review?.scope || 'chat');
  const [selected, setSelected] = useState(tab.review?.selected ?? tab.path ?? '');
  const [filter, setFilter] = useState(tab.review?.filter || '');
  const [expanded, setExpanded] = useState(tab.review?.expanded || false);
  const [split, setSplit] = useState(tab.review?.split || false);
  const [showTree, setShowTree] = useState(tab.review?.showTree ?? true);
  const [wrap, setWrap] = useState(tab.review?.wrap || false);
  const [loadFull, setLoadFull] = useState(tab.review?.loadFull ?? true);
  const [richPreview, setRichPreview] = useState(tab.review?.richPreview ?? true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(tab.review?.ignoreWhitespace || false);
  const [wordDiffs, setWordDiffs] = useState(tab.review?.wordDiffs ?? true);
  const [viewed, setViewed] = useState<string[]>(tab.review?.viewed || []);
  const [hideViewed, setHideViewed] = useState(tab.review?.hideViewed || false);
  const [compactFolders, setCompactFolders] = useState(tab.review?.compactFolders ?? true);
  const [baseRefs, setBaseRefs] = useState<Record<string, string>>(tab.review?.baseRefs || {});
  const [branchQuery, setBranchQuery] = useState('');
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [previewFailed, setPreviewFailed] = useState('');
  const [repositoryState, setRepository] = useState<Repository | null>(null);
  const [diff, setDiff] = useState<{ key: string; diffLines: Line[]; notice?: string; truncated?: boolean } | null>(null);
  const [rowLimit, setRowLimit] = useState(1500);
  const [syntax, setSyntax] = useState<{ lines: Line[]; colors: Map<Line, WorkspaceToken[]> } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const api = typeof window !== 'undefined' ? (window as any).electronAPI : undefined;
  const rootsKey = JSON.stringify(roots);
  const reviewKey = JSON.stringify([owner, scope, roots, baseRefs]);
  const repository = repositoryState?.key === reviewKey ? repositoryState : null;

  useEffect(() => {
    updateWorkspaceTab(owner, tab.id, { review: { scope, root: '', selected, filter, expanded, split, showTree, wrap, loadFull, richPreview, ignoreWhitespace, wordDiffs, viewed, hideViewed, compactFolders, baseRefs } });
  }, [owner, tab.id, scope, selected, filter, expanded, split, showTree, wrap, loadFull, richPreview, ignoreWhitespace, wordDiffs, viewed, hideViewed, compactFolders, baseRefs]);
  const lastPathRequest = useRef(tab.reviewPathRequest);
  useEffect(() => {
    if (tab.path && tab.reviewPathRequest !== lastPathRequest.current) { setSelected(tab.path); setScope('chat'); }
    lastPathRequest.current = tab.reviewPathRequest;
  }, [tab.path, tab.reviewPathRequest]);
  useEffect(() => {
    if (!isActive) return;
    if (scope === 'chat' || !roots.length) { setLoading(false); setError(''); return; }
    if (!api?.workspaceReviewList) { setError('Restart EterX to enable project review.'); setLoading(false); return; }
    let disposed = false;
    setLoading(true);
    const load = async () => {
      const changed = new Map<string, ReviewFile>();
      const projects: Project[] = [], warnings: string[] = [];
      let truncated = false;
      for (const directory of roots) {
        if (disposed) return;
        try {
          const result: Repository = await api.workspaceReviewList(directory, scope, baseRefs[directory] || '');
          projects.push({ root: result.root, scopeRoot: directory, branch: result.branch, upstream: result.upstream, baseRef: result.baseRef, references: result.references, gitDirectory: result.gitDirectory });
          truncated ||= !!result.truncated;
          for (const file of result.files) if (isWithinWorkspace(file.filepath, directory)) changed.set(workspacePathKey(file.filepath), { ...file, repositoryRoot: result.root, baseRef: result.baseRef });
        } catch (error) { warnings.push(directory + ': ' + ((error as Error).message || String(error))); }
      }
      if (disposed) return;
      const first = projects[0];
      if (!first) { setError(warnings.join('\n')); setRepository(null); return; }
      const result = { ...first, key: reviewKey, projects, files: [...changed.values()], warnings, truncated };
      setError(''); setRepository(previous => JSON.stringify(previous) === JSON.stringify(result) ? previous : result);
    };
    void load().catch(error => { if (!disposed) setError(error.message || String(error)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [reviewKey, nonce, isActive]);

  const chatFiles = useMemo(() => workspacePath ? files.filter(file => isWithinWorkspace(file.filepath, workspacePath)) : files, [files, workspacePath]);
  const changed: ReviewFile[] = scope === 'chat' ? chatFiles : repository?.files || noFiles;
  const visibleFiles = useMemo(() => changed.filter(file => (!filter || file.filepath.toLowerCase().includes(filter.toLowerCase())) && (!hideViewed || !viewed.includes(workspacePathKey(file.filepath)))), [changed, filter, hideViewed, viewed]);
  const active = changed.find(file => workspacePathKey(file.filepath) === workspacePathKey(selected || '\0'));
  const activeIndex = active ? visibleFiles.indexOf(active) : -1;
  useEffect(() => {
    if (hideViewed && selected && viewed.includes(workspacePathKey(selected))) setSelected(visibleFiles[0]?.filepath || '');
  }, [hideViewed, viewed, selected, visibleFiles]);
  const diffKey = JSON.stringify([reviewKey, active?.filepath || '', loadFull]);
  const watchKey = useMemo(() => JSON.stringify([...new Set([...roots, ...(repository?.projects || []).map(project => project.gitDirectory), ...changed.map(file => workspaceParent(file.filepath))].filter(Boolean))].slice(0, 40)), [rootsKey, repository, changed]);
  useEffect(() => {
    if (!isActive || scope === 'chat' || !roots.length || error) return;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!isAppVisible() || !document.hasFocus()) return;
      clearTimeout(pending); pending = setTimeout(() => setNonce(value => value + 1), 600);
    };
    const stops = (JSON.parse(watchKey) as string[]).map(path => watchWorkspaceFolder(path, refresh));
    const reconcile = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh); const unsubscribeVisibility = subscribeAppVisibility(refresh);
    return () => { stops.forEach(stop => stop()); clearTimeout(pending); clearInterval(reconcile); window.removeEventListener('focus', refresh); unsubscribeVisibility(); };
  }, [rootsKey, scope, watchKey, error, isActive]);
  useEffect(() => { setRowLimit(1500); setUnfolded(new Set()); setCopied(''); scroll.current?.scrollTo(0, 0); }, [diffKey]);
  useEffect(() => {
    if (!isActive) return;
    if (scope === 'chat' || !active?.relativePath || !active.repositoryRoot || !api?.workspaceReviewDiff) { setDiffLoading(false); return; }
    let disposed = false;
    setDiffLoading(true);
    void api.workspaceReviewDiff(active.repositoryRoot, active.relativePath, scope, loadFull, active.baseRef).then((result: { diffLines: Line[]; notice?: string; truncated?: boolean }) => {
      if (!disposed) setDiff(previous => previous?.key === diffKey && JSON.stringify(previous.diffLines) === JSON.stringify(result.diffLines) && previous.notice === result.notice && previous.truncated === result.truncated ? previous : { ...result, key: diffKey });
    }).catch((error: Error) => { if (!disposed) setDiff({ key: diffKey, diffLines: [], notice: error.message || String(error) }); }).finally(() => { if (!disposed) setDiffLoading(false); });
    return () => { disposed = true; };
  }, [diffKey, active?.relativePath, active?.repositoryRoot, active?.baseRef, nonce, isActive]);
  const currentDiff = diff?.key === diffKey ? diff : null;
  const sourceLines = useMemo(() => scope === 'chat' ? workspaceChatDiffLines(active, loadFull) : currentDiff?.diffLines || noLines, [scope, active, loadFull, currentDiff]);
  const lines = useMemo(() => ignoreWhitespace ? ignoreWhitespaceChanges(sourceLines) : sourceLines, [sourceLines, ignoreWhitespace]);
  const wordRanges = useMemo(() => wordDiffs ? inlineChanges(lines) : null, [lines, wordDiffs]);
  useEffect(() => {
    if (!lines.length) return;
    let disposed = false;
    const language = workspaceLanguage(active?.filepath || '', active?.language);
    const before = lines.filter(line => line.type === 'removed' || line.type === 'unchanged');
    const after = lines.filter(line => line.type === 'added' || line.type === 'unchanged');
    void Promise.all([before, after].map(version => highlightWorkspaceCode(version.map(line => line.content).join('\n'), language))).then(versions => {
      if (disposed) return;
      const colors = new Map<Line, WorkspaceToken[]>();
      [before, after].forEach((version, side) => version.forEach((line, index) => { const tokens = versions[side]?.[index]; if (tokens) colors.set(line, tokens); }));
      setSyntax({ lines, colors });
    });
    return () => { disposed = true; };
  }, [lines, active?.filepath, active?.language]);
  const renderCode = (line?: Line) => {
    if (!line) return ' ';
    const tokens = syntax?.lines === lines ? syntax.colors.get(line) : undefined;
    const range = wordRanges?.get(line);
    let offset = 0;
    return (tokens || [{ text: line.content || ' ', light: '', dark: '' }]).map((token, index) => {
      const start = offset; offset += token.text.length;
      const from = range ? Math.max(0, range[0] - start) : token.text.length;
      const to = range ? Math.min(token.text.length, range[1] - start) : 0;
      const text = to > from ? <>{token.text.slice(0, from)}<mark className={'eterx-workspace-word-change diff-' + line.type}>{token.text.slice(from, to)}</mark>{token.text.slice(to)}</> : token.text;
      return <span key={index} className="eterx-workspace-syntax-token" style={token.light ? { '--ws-code-light': token.light, '--ws-code-dark': token.dark } as React.CSSProperties : undefined}>{text}</span>;
    });
  };
  const rows = useMemo(() => makeRows(lines, split, expanded, unfolded), [lines, split, expanded, unfolded]);
  const splitLineWidth = useMemo(() => lines.reduce((width, line) => line.type === 'context' ? width : Math.max(width, line.content.replace(/\t/g, '    ').length), 20), [lines]);
  const counts = (file: ReviewFile) => ({ added: file.linesAdded ?? file.diffLines?.filter(line => line.type === 'added').length, removed: file.linesRemoved ?? file.diffLines?.filter(line => line.type === 'removed').length });
  const toggleViewed = (file: ReviewFile) => { const key = workspacePathKey(file.filepath); setViewed(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key]); };
  const copyPath = async (file: ReviewFile) => { const success = await safeCopyTextToClipboard(file.filepath); setCopied(success ? file.filepath : ''); if (!success) setError('Could not copy this path.'); };
  const totals = changed.reduce((total, file) => { const count = counts(file); return { added: total.added + (count.added || 0), removed: total.removed + (count.removed || 0) }; }, { added: 0, removed: 0 });
  const activeCounts = active ? { added: active.linesAdded ?? sourceLines.filter(line => line.type === 'added').length, removed: active.linesRemoved ?? sourceLines.filter(line => line.type === 'removed').length } : null;
  const imagePreview = active && richPreview && !active.status?.includes('D') && /\.(png|jpe?g|webp|gif|svg|avif|ico)$/i.test(active.filepath) && previewFailed !== active.filepath;
  const navigate = (offset: number) => { const file = visibleFiles[activeIndex + offset]; if (file) setSelected(file.filepath); };

  return <div className="eterx-workspace-review-view">
    <div className="eterx-workspace-file-toolbar">
      <WorkspaceMenu label="Review scope" trigger={<><span>{labels[scope]}</span><ChevronDown size={13} /></>}>
        {(Object.keys(labels) as Scope[]).map(value => <button role="menuitemradio" aria-checked={scope === value} key={value} onClick={() => { setScope(value); setSelected(''); setError(''); }}><span>{labels[value]}</span>{scope === value && <Check size={13} />}</button>)}
        {!workspacePath && api?.selectFolder && <><hr /><button role="menuitem" onClick={() => { void api.selectFolder().then((path: string | null) => { if (path) { onAddFolder(path); setSelected(''); setScope('working'); } }).catch((error: Error) => setError(error.message || String(error))); }}><Folder size={15} /><span>Add folder to this chat…</span></button></>}
      </WorkspaceMenu>
      <span className="eterx-workspace-review-count">{changed.length} {changed.length === 1 ? 'file' : 'files'}</span>
      {(loading || diffLoading) && <Loader2 size={13} className="animate-spin" aria-label="Updating changes" />}
      <WorkspaceMenu label="Review options" trigger={<MoreHorizontal size={16} />}>
        <p className="eterx-workspace-menu-heading">Layout</p>
        <button role="menuitemradio" aria-checked={!split} onClick={() => setSplit(false)}><FileText size={15} /><span>Unified diff</span>{!split && <Check size={13} />}</button>
        <button role="menuitemradio" aria-checked={split} onClick={() => setSplit(true)}><SquareSplitHorizontal size={15} /><span>Side by side</span>{split && <Check size={13} />}</button>
        <button role="menuitemcheckbox" aria-checked={wrap} onClick={() => setWrap(value => !value)}><WrapText size={15} /><span>Wrap long lines</span>{wrap && <Check size={13} />}</button>
        <button role="menuitemcheckbox" aria-checked={richPreview} onClick={() => setRichPreview(value => !value)}><Image size={15} /><span>Preview images</span>{richPreview && <Check size={13} />}</button>
        <hr /><p className="eterx-workspace-menu-heading">Change detail</p>
        <button role="menuitemcheckbox" aria-checked={wordDiffs} onClick={() => setWordDiffs(value => !value)}><Highlighter size={15} /><span>Highlight changed text</span>{wordDiffs && <Check size={13} />}</button>
        <button role="menuitemcheckbox" aria-checked={ignoreWhitespace} onClick={() => setIgnoreWhitespace(value => !value)}><EyeOff size={15} /><span>Ignore whitespace changes</span>{ignoreWhitespace && <Check size={13} />}</button>
        <button role="menuitemcheckbox" aria-checked={loadFull} onClick={() => setLoadFull(value => !value)}><FileText size={15} /><span>Include surrounding code</span>{loadFull && <Check size={13} />}</button>
        <hr /><p className="eterx-workspace-menu-heading">File list</p>
        <button role="menuitemcheckbox" aria-checked={compactFolders} onClick={() => setCompactFolders(value => !value)}><Folder size={15} /><span>Compact folder paths</span>{compactFolders && <Check size={13} />}</button>
        <button role="menuitemcheckbox" aria-checked={hideViewed} onClick={() => setHideViewed(value => !value)}><FileCheck size={15} /><span>Show only unviewed files</span>{hideViewed && <Check size={13} />}</button>
        <button role="menuitem" disabled={!viewed.length} onClick={() => setViewed([])}><RotateCcw size={15} /><span>Reset viewed files</span></button>
        <hr /><button role="menuitem" onClick={() => { setError(''); setPreviewFailed(''); setNonce(value => value + 1); }}><RefreshCw size={15} /><span>Refresh changes</span></button>
      </WorkspaceMenu>
      <Tooltip text={expanded ? 'Collapse unchanged lines' : 'Expand unchanged lines'}><button aria-label="Toggle unchanged lines" aria-pressed={expanded} onClick={() => { setExpanded(value => !value); setUnfolded(new Set()); if (!expanded) setLoadFull(true); }}>{expanded ? <FoldVertical size={16} /> : <UnfoldVertical size={16} />}</button></Tooltip>
      <Tooltip text={split ? 'Unified diff' : 'Split diff'}><button aria-label="Toggle split diff" aria-pressed={split} onClick={() => setSplit(value => !value)}><SquareSplitHorizontal size={16} /></button></Tooltip>
      <Tooltip text={showTree ? 'Hide changed files' : 'Show changed files'}><button aria-label="Toggle changed files" aria-pressed={showTree} onClick={() => setShowTree(value => !value)}><Folders size={16} /></button></Tooltip>
    </div>
    {scope !== 'chat' && repository && <div className="eterx-workspace-review-branch">
      <GitBranch size={13} /><span>{(repository.projects?.length || 0) > 1 ? repository.projects!.length + ' folders' : repository.branch}</span>
      {scope === 'branch' && <WorkspaceMenu label="Compare with branch" trigger={<><span>→ {repository.projects?.length === 1 ? repository.baseRef : 'Compare branches'}</span><ChevronDown size={12} /></>} onOpen={() => setBranchQuery('')}>
        <div className="eterx-workspace-search"><FileSearchCorner size={13} /><input aria-label="Search comparison branches" placeholder="Search branches…" value={branchQuery} onChange={event => setBranchQuery(event.target.value)} /></div>
        {repository.projects?.map(project => <div key={project.scopeRoot}>{repository.projects!.length > 1 && <p className="eterx-workspace-menu-heading">{project.scopeRoot}</p>}{[...new Set([project.baseRef, 'HEAD', ...(project.references || [])])].filter(ref => ref.toLowerCase().includes(branchQuery.toLowerCase())).map(ref => <button role="menuitemradio" aria-checked={project.baseRef === ref} key={ref} onClick={() => { setBaseRefs(current => ({ ...current, [project.scopeRoot]: ref })); setSelected(''); }}><GitBranch size={14} /><span>{ref}</span>{project.baseRef === ref && <Check size={13} />}</button>)}</div>)}
      </WorkspaceMenu>}
      <span className="eterx-workspace-review-totals"><span className="eterx-workspace-diff-added">+{totals.added}</span><span className="eterx-workspace-diff-removed">−{totals.removed}</span></span>
    </div>}
    {error && <div className="eterx-workspace-inline-error" role="alert">{error}<button onClick={() => { setError(''); setNonce(value => value + 1); }}>Try again</button></div>}
    {rootError && <div className="eterx-workspace-inline-error" role="alert">{rootError}</div>}
    {!!repository?.warnings?.length && <details className="eterx-workspace-review-warnings"><summary>{repository.warnings.length} {repository.warnings.length === 1 ? 'folder unavailable' : 'folders unavailable'}</summary>{repository.warnings.map(message => <p key={message}>{message}</p>)}</details>}
    <div className="eterx-workspace-review-body">
      <div className="eterx-workspace-diff-document">
        {active && <div className="eterx-workspace-file-toolbar eterx-workspace-review-file-heading">
          <Tooltip text="All changed files"><button aria-label="Back to changed files" onClick={() => setSelected('')}><ArrowLeft size={15} /></button></Tooltip>
          <WorkspaceFileIcon path={active.filepath} folder={active.directory} /><span className="eterx-workspace-breadcrumb"><strong>{active.filename}</strong></span>
          {activeCounts && (activeCounts.added > 0 || activeCounts.removed > 0) && <span className="eterx-workspace-review-file-counts"><span className="eterx-workspace-diff-added">+{activeCounts.added}</span><span className="eterx-workspace-diff-removed">−{activeCounts.removed}</span></span>}
          <Tooltip text={copied === active.filepath ? 'Copied' : 'Copy path'}><button aria-label="Copy file path" onClick={() => void copyPath(active)}>{copied === active.filepath ? <Check size={14} className="text-white" /> : <Copy size={14} />}</button></Tooltip>
          <Tooltip text="Open in Files"><button aria-label="Open in Files" onClick={() => active.directory ? onOpenFile('', active.filepath) : onOpenFile(active.filepath)}><FileCodeCorner size={15} /></button></Tooltip>
          <Tooltip text={viewed.includes(workspacePathKey(active.filepath)) ? 'Mark as unviewed' : 'Mark as viewed'}><button aria-label="Mark file as viewed" aria-pressed={viewed.includes(workspacePathKey(active.filepath))} onClick={() => toggleViewed(active)}><Check size={15} /></button></Tooltip>
        </div>}
        {active && <div className="eterx-workspace-review-navigation"><span>{reviewDisplayPath(active.filepath, roots)}</span><button aria-label="Previous changed file" disabled={activeIndex <= 0} onClick={() => navigate(-1)}><ChevronLeft size={14} /></button><small>{activeIndex >= 0 ? activeIndex + 1 : '–'} / {visibleFiles.length}</small><button aria-label="Next changed file" disabled={activeIndex < 0 || activeIndex >= visibleFiles.length - 1} onClick={() => navigate(1)}><ChevronRight size={14} /></button></div>}
        <div ref={scroll} className="eterx-workspace-diff-scroll eterx-scrollbar" data-split={split} data-wrap={wrap} style={{ '--ws-diff-line-width': `${splitLineWidth}ch` } as React.CSSProperties}>
          {!active && !!changed.length && <div className="eterx-workspace-review-overview">
            <div className="eterx-workspace-review-overview-heading"><strong>Changed files</strong><span>{changed.filter(file => viewed.includes(workspacePathKey(file.filepath))).length} / {changed.length} viewed</span></div>
            {!showTree && <div className="eterx-workspace-search"><FileSearchCorner size={14} /><input aria-label="Filter changes" placeholder="Filter files…" value={filter} onChange={event => setFilter(event.target.value)} /></div>}
            {visibleFiles.map(file => { const count = counts(file), done = viewed.includes(workspacePathKey(file.filepath)); return <div className="eterx-workspace-review-overview-row" key={file.filepath} data-viewed={done}>
              <button className="eterx-workspace-review-overview-open" aria-label={'Review ' + file.filepath} onClick={() => setSelected(file.filepath)}><WorkspaceFileIcon path={file.filepath} folder={file.directory} /><span>{reviewDisplayPath(file.filepath, roots)}</span>{count.added != null && <small className="eterx-workspace-diff-added">+{count.added}</small>}{count.removed != null && <small className="eterx-workspace-diff-removed">−{count.removed}</small>}{file.status && <small className="eterx-workspace-review-status">{file.status}</small>}</button>
              <Tooltip text={done ? 'Mark as unviewed' : 'Mark as viewed'}><button className="eterx-workspace-review-viewed" aria-label={(done ? 'Mark as unviewed: ' : 'Mark as viewed: ') + file.filename} aria-pressed={done} onClick={() => toggleViewed(file)}><Check size={14} /></button></Tooltip>
            </div>; })}
            {!visibleFiles.length && <p className="eterx-workspace-tree-status">{hideViewed && viewed.length ? 'No unviewed files match this filter.' : 'No matching files.'}</p>}
          </div>}
          {active && imagePreview && <WorkspaceImagePreview key={active.filepath} path={active.filepath} revision={`${active.updatedAt || 0}-${nonce}`} label="Current file" onError={() => setPreviewFailed(active.filepath)} />}
          {active && !imagePreview && split && rows.length > 0 && <div className="eterx-workspace-diff-pair eterx-workspace-diff-columns"><span>Before</span><span>After</span></div>}
          {active && !imagePreview && rows.slice(0, rowLimit).map(row => row.hidden ? <button className="eterx-workspace-diff-fold" key={row.key} onClick={() => { if (row.requestContext) { if (!loadFull && active.content && !active.truncated) setLoadFull(true); else onOpenFile(active.filepath); } else setUnfolded(current => new Set([...current, row.key])); }}><ChevronDown size={13} />{row.hidden} {row.requestContext && (loadFull || !active.content || active.truncated) ? 'lines omitted · Open file' : 'unchanged lines'}</button>
            : row.line?.type === 'context' ? <div key={row.key} className="eterx-workspace-diff-context">{row.line.content}{!loadFull && scope !== 'chat' && <button onClick={() => setLoadFull(true)}>Show surrounding lines</button>}</div>
            : split ? <div className="eterx-workspace-diff-pair" key={row.key}>{[row.left || (row.line?.type === 'unchanged' ? row.line : undefined), row.right || (row.line?.type === 'unchanged' ? row.line : undefined)].map((line, side) => <div className={'eterx-workspace-diff-cell diff-' + (line?.type || 'empty')} key={side}><span>{side === 0 ? line?.oldLine : line?.newLine}</span><code>{renderCode(line)}</code></div>)}</div>
            : <div key={row.key} className={'eterx-workspace-diff-row diff-' + row.line?.type}><span>{row.line?.oldLine || ''}</span><span>{row.line?.newLine || ''}</span><b>{row.line?.type === 'added' ? '+' : row.line?.type === 'removed' ? '−' : ' '}</b><code>{renderCode(row.line)}</code></div>)}
          {(!changed.length || (active && !imagePreview && !rows.length)) && <div className="eterx-workspace-empty">{rootsLoading || loading || diffLoading ? <><Loader2 size={21} className="animate-spin" /><p>Reading changes…</p></> : <><FileCodeCorner size={30} strokeWidth={1.5} /><h3>{active ? 'No text diff' : 'No changes to show'}</h3><p>{currentDiff?.notice || (active ? 'Open this file in Files to see its contents.' : scope === 'chat' ? 'Completed edits from this conversation appear here.' : roots.length ? 'No changes in these folders for this comparison.' : 'Select a workspace or use files in this chat to start reviewing.')}</p></>}</div>}
          {active && !imagePreview && rows.length > rowLimit && <button className="eterx-workspace-load-more" onClick={() => setRowLimit(value => value + 1500)}>Show more diff lines</button>}
          {(currentDiff?.truncated || repository?.truncated || lines.length >= 10000) && <p className="eterx-workspace-tree-status">Some content is omitted from this preview. Open Files for the complete file.</p>}
        </div>
      </div>
      {showTree && <WorkspaceTreePane owner={owner} tabId={tab.id} width={tab.treeWidth}><div className="eterx-workspace-search"><FileSearchCorner size={14} /><input aria-label="Filter changed files" placeholder="Filter files…" value={filter} onChange={event => setFilter(event.target.value)} /></div><div className="eterx-workspace-tree-scroll eterx-scrollbar"><WorkspaceReviewTree files={visibleFiles} roots={roots} selected={active?.filepath} viewed={viewed} compact={compactFolders} onSelect={setSelected} />{!visibleFiles.length && <p className="eterx-workspace-tree-status">{loading ? 'Reading changes…' : filter ? 'No matching files' : 'No changed files'}</p>}</div></WorkspaceTreePane>}
    </div>
  </div>;
}
