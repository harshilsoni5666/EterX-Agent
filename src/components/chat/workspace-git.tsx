'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Archive, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, ExternalLink, FileDiff, FolderOpen, GitBranch, GitCommitHorizontal, GitMerge, History, Loader2, Minus, Plus, RefreshCw, RotateCcw, Search, TerminalSquare, Trash2, UserRound, X } from 'lucide-react';
import { GIT_CHANGED_EVENT, mutateGit, readGit, useGitPreferences } from '../../lib/git/client';
import type { GitBranch as Branch, GitCommit, GitDiff, GitFile, GitMutation, GitStash, GitStatus, GitView } from '../../lib/git/types';
import { addWorkspaceTab, openWorkspaceReview, updateWorkspaceTab, type WorkspaceTab } from '../../lib/side-workspace-store';
import { createTerminal, showTerminal } from '../../lib/chat-terminal-store';
import { isAppVisible, useAppVisibility } from '../../lib/app-visibility';
import { watchWorkspaceFolder } from '../../lib/workspace-file-events';
import { appStorage } from '../../lib/client-storage';
import { safeCopyTextToClipboard } from '../ui/copy-button';
import { WorkspaceFileIcon } from './workspace-file-icon';
import { WorkspaceMenu } from './workspace-files';
import { Tooltip } from '../ui/tooltip';

type Selection = { kind: 'file'; path: string; staged: boolean } | { kind: 'commit' | 'stash'; hash: string; title: string };
type Confirmation = { title: string; detail: string; label: string; danger?: boolean; input: GitMutation };
type Lists = { key: string; branches?: Branch[]; commits?: GitCommit[]; stashes?: GitStash[]; hasMore?: boolean };
const views = [{ id: 'changes', title: 'Changes', icon: FileDiff }, { id: 'branches', title: 'Branches', icon: GitBranch }, { id: 'history', title: 'History', icon: History }, { id: 'stashes', title: 'Stashes', icon: Archive }] as const;
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() || value;
const isStaged = (file: GitFile) => !file.untracked && !file.conflicted && file.index !== ' ';
const isUnstaged = (file: GitFile) => !file.conflicted && (file.untracked || file.working !== ' ');
const fullPath = (root: string, file: string) => root.replace(/[\\/]+$/, '') + '/' + file;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const dateLabel = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
const statusLabels: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };
const statusLabel = (file: GitFile, staged: boolean) => file.conflicted ? 'Conflict' : file.untracked ? 'New file' : (statusLabels[staged ? file.index : file.working] || 'Modified');

function FileDiffStats({ file, staged }: { file: GitFile; staged: boolean }) {
  const stats = staged ? file.stagedStats : file.workingStats;
  const label = statusLabel(file, staged);
  if (file.conflicted) return <span className="eterx-git-file-state is-conflict" aria-description="Resolve conflicts to see line counts">Conflict</span>;
  if (stats?.binary) return <span className="eterx-git-file-state" aria-description={`${label} · Binary file`}>Binary</span>;
  if (!stats) return <span className="eterx-git-file-state" aria-description={`${label} · Line counts unavailable`}>{file.untracked ? 'New' : '—'}</span>;
  return <span className="eterx-git-file-stats" aria-description={`${label} · ${stats.added} lines added, ${stats.removed} lines removed`}>
    <span className="is-added">+{stats.added}</span><span className="is-removed">−{stats.removed}</span>
  </span>;
}

function DiffPreview({ diff, loading, error }: { diff: GitDiff | null; loading: boolean; error: string }) {
  const [limit, setLimit] = useState(800);
  useEffect(() => setLimit(800), [diff]);
  if (loading) return <div className="eterx-git-placeholder"><Loader2 size={19} className="animate-spin" /><p>Loading diff…</p></div>;
  if (error) return <div className="eterx-git-placeholder" role="alert"><AlertCircle size={20} /><p>{error}</p></div>;
  if (!diff) return null;
  const lines = diff.text.split('\n');
  return <>
    {diff.notice && <p className="eterx-git-note">{diff.notice}</p>}
    {!diff.text ? <div className="eterx-git-placeholder"><Check size={22} /><p>No text changes in this selection.</p></div> : <div className="eterx-git-diff-scroll eterx-scrollbar" tabIndex={0} aria-label="Diff preview">
      <pre className="eterx-git-diff">{lines.slice(0, limit).map((line, index) => <span key={index} className={line.startsWith('@@') ? 'is-hunk' : /^(diff |index |--- |\+\+\+ )/.test(line) ? 'is-meta' : line.startsWith('+') ? 'is-added' : line.startsWith('-') ? 'is-removed' : ''}>{line || ' '}{'\n'}</span>)}</pre>
      {lines.length > limit && <button className="eterx-git-load-more" onClick={() => setLimit(value => value + 800)}>Show more lines ({lines.length - limit} remaining)</button>}
    </div>}
    {diff.truncated && <p className="eterx-git-note">Large diff · preview limited to 240 KB. Open Terminal for the complete patch.</p>}
  </>;
}

export function WorkspaceGit({ owner, tab, isActive, workspacePath, roots, rootsLoading, rootError, onAddFolder, onOpenFile }: {
  owner: string; tab: WorkspaceTab; isActive: boolean; workspacePath?: string | null; roots: string[]; rootsLoading: boolean; rootError: string;
  onAddFolder: (root: string) => void; onOpenFile: (path: string, root?: string) => void;
}) {
  const preferences = useGitPreferences();
  const visible = useAppVisibility();
  const enabled = preferences.ready && preferences.gitIntegration && preferences.gitWorkspaceEnabled;
  const [selectedRoot, setSelectedRoot] = useState(tab.root || tab.git?.root || '');
  const root = workspacePath || selectedRoot || roots[0] || '';
  const rootRef = useRef(root); rootRef.current = root;
  const [view, setView] = useState<GitView>(tab.git?.view || 'changes');
  const [drafts, setDrafts] = useState<Record<string, string>>(tab.git?.drafts || {});
  const [draftsLoaded, setDraftsLoaded] = useState('');
  const draftStorageKey = 'eterx_git_commit_drafts_' + owner;
  const [status, setStatus] = useState<{ key: string; data: GitStatus } | null>(null);
  const [statusError, setStatusError] = useState('');
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const listRequest = useRef(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [filter, setFilter] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [diffState, setDiffState] = useState<{ key: string; data: GitDiff } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [branchDraft, setBranchDraft] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [stashMessage, setStashMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [remoteChoice, setRemoteChoice] = useState('');
  const [addingRemote, setAddingRemote] = useState(false);
  const [remoteName, setRemoteName] = useState('origin');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [identity, setIdentity] = useState<{ root: string; name: string; email: string } | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [folderInput, setFolderInput] = useState('');
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [fileLimit, setFileLimit] = useState(150);
  const currentStatus = status?.key === root ? status.data : null;
  const current = currentStatus?.available ? currentStatus : null;
  const draftKey = current?.root || root;
  const commitMessage = drafts[draftKey] || '';
  const remote = !current ? '' : current.remotes.includes(remoteChoice) ? remoteChoice : current.remotes.find(name => current.upstream.startsWith(name + '/')) || (current.remotes.includes('origin') ? 'origin' : current.remotes[0]) || '';
  const listKey = JSON.stringify([current?.root, view]);
  const list = lists?.key === listKey ? lists : null;
  const selectionKey = JSON.stringify([root, selection, current?.revision, nonce]);
  const diff = diffState?.key === selectionKey ? diffState.data : null;
  const locked = !!busy || !!statusError || loading;
  const staged = useMemo(() => current?.files.filter(isStaged) || [], [current]);
  const unstaged = useMemo(() => current?.files.filter(isUnstaged) || [], [current]);
  const conflicts = useMemo(() => current?.files.filter(file => file.conflicted) || [], [current]);
  const canCommit = !!current && !locked && !!commitMessage.trim() && (staged.length > 0 || current.operation === 'MERGE_HEAD') && !conflicts.length && !current.detached && (!current.operation || current.operation === 'MERGE_HEAD');
  const refresh = useCallback(() => setNonce(value => value + 1), []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (tab.root) setSelectedRoot(tab.root); }, [tab.root]);
  useEffect(() => {
    if (!preferences.ready) return;
    try {
      const stored = JSON.parse(appStorage.getItem(draftStorageKey) || '{}');
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        const safe = Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key, value.slice(0, 20_000)]));
        setDrafts(previous => ({ ...safe, ...previous }));
      }
    } catch { /* A malformed draft must not prevent repository access. */ }
    setDraftsLoaded(draftStorageKey);
  }, [preferences.ready, draftStorageKey]);
  useEffect(() => {
    if (draftsLoaded === draftStorageKey) appStorage.setItem(draftStorageKey, JSON.stringify(drafts));
  }, [draftStorageKey, draftsLoaded, drafts]);
  useEffect(() => { updateWorkspaceTab(owner, tab.id, { git: { root, view, drafts } }); }, [owner, tab.id, root, view, drafts]);
  useEffect(() => {
    setSelection(null); setConfirmation(null); setFeedback(null); setFilter(''); setRemoteChoice(''); setCreatingBranch(false); setAddingRemote(false); setIdentity(null);
  }, [root]);
  useEffect(() => { setFileLimit(150); }, [filter, root]);

  useEffect(() => {
    if (!enabled || !isActive || !visible || !root || pending.current) return;
    const controller = new AbortController();
    let disposed = false;
    setLoading(true);
    void readGit<GitStatus>(root, 'status', { stats: 'true' }, controller.signal).then(data => {
      if (!disposed) { setStatus({ key: root, data }); setStatusError(''); }
    }).catch(error => { if (!disposed) setStatusError(messageOf(error)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [root, nonce, enabled, isActive, visible]);

  useEffect(() => {
    if (!enabled || !isActive) return;
    const changed = () => { if (!pending.current) refresh(); };
    window.addEventListener(GIT_CHANGED_EVENT, changed);
    return () => window.removeEventListener(GIT_CHANGED_EVENT, changed);
  }, [enabled, isActive, refresh]);

  useEffect(() => {
    if (!enabled || !preferences.gitAutoDetect || !isActive || !visible || !root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!isAppVisible() || pending.current) return;
      clearTimeout(timer); timer = setTimeout(refresh, 650);
    };
    const stops = [...new Set([root, current?.gitDirectory].filter((item): item is string => !!item))].map(path => watchWorkspaceFolder(path, schedule));
    const interval = setInterval(schedule, 20_000);
    window.addEventListener('focus', schedule);
    return () => { stops.forEach(stop => stop()); clearTimeout(timer); clearInterval(interval); window.removeEventListener('focus', schedule); };
  }, [enabled, preferences.gitAutoDetect, isActive, visible, root, current?.gitDirectory, refresh]);

  useEffect(() => {
    const request = ++listRequest.current;
    if (!enabled || !isActive || !visible || !current || view === 'changes') return;
    const controller = new AbortController();
    let disposed = false;
    setListLoading(true); setListError('');
    void readGit<Omit<Lists, 'key'>>(current.root, view, {}, controller.signal).then(data => {
      if (!disposed && listRequest.current === request) setLists(previous => {
        // Keep already loaded history pages when the branch tip is unchanged.
        if (view === 'history' && data.commits?.length && previous && previous.key === listKey && previous.commits && previous.commits.length > data.commits.length && previous.commits[0]?.hash === data.commits[0].hash) {
          return { ...data, key: listKey, commits: previous.commits, hasMore: previous.hasMore };
        }
        return { ...data, key: listKey };
      });
    }).catch(error => { if (!disposed && listRequest.current === request) setListError(messageOf(error)); }).finally(() => { if (!disposed && listRequest.current === request) setListLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [enabled, isActive, visible, current?.root, current?.revision, view, listKey, nonce]);

  useEffect(() => {
    if (selection?.kind !== 'file' || !current) return;
    const file = current.files.find(file => file.path === selection.path);
    if (!file || (selection.staged ? !isStaged(file) : !isUnstaged(file) && !file.conflicted)) setSelection(null);
  }, [current, selection]);

  useEffect(() => {
    if (!enabled || !isActive || !visible || !current || !selection) return;
    const controller = new AbortController();
    let disposed = false;
    setDiffLoading(true); setDiffError('');
    const options: Record<string, string> = selection.kind === 'file' ? { path: selection.path, staged: String(selection.staged) } : { hash: selection.hash };
    void readGit<GitDiff>(current.root, selection.kind === 'file' ? 'diff' : selection.kind, options, controller.signal).then(data => {
      if (!disposed) setDiffState({ key: selectionKey, data });
    }).catch(error => { if (!disposed) setDiffError(messageOf(error)); }).finally(() => { if (!disposed) setDiffLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [enabled, isActive, visible, selectionKey, current?.root]);

  const perform = async (input: GitMutation, label: string) => {
    if (pending.current || !enabled) return;
    const requestedRoot = root;
    pending.current = true; setBusy(label); setFeedback(null); setConfirmation(null);
    try {
      const result = await mutateGit(input);
      if (!mounted.current || rootRef.current !== requestedRoot) return;
      setFeedback({ error: false, text: result.message });
      if (input.action === 'commit') setDrafts(previous => previous[draftKey] === input.message ? { ...previous, [draftKey]: '' } : previous);
      if (input.action === 'create-branch') { setCreatingBranch(false); setBranchDraft(''); }
      if (input.action === 'stash-save') setStashMessage('');
      if (input.action === 'add-remote') { setAddingRemote(false); setRemoteUrl(''); }
      if (input.action === 'set-identity') setIdentity(null);
    } catch (error) {
      if (mounted.current && rootRef.current === requestedRoot) setFeedback({ error: true, text: messageOf(error) });
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(''); refresh(); }
    }
  };
  const action = (action: GitMutation['action'], extra: Partial<GitMutation> = {}): GitMutation => ({ root: current?.root || root, revision: current?.revision, action, ...extra });
  const openTerminal = async () => {
    try {
      showTerminal(owner, 'right'); addWorkspaceTab(owner, 'terminal');
      // A new terminal ensures the shell belongs to this repository, even if
      // an existing session was opened for a different project.
      await createTerminal(owner, current?.root || root || undefined);
    } catch (error) { setFeedback({ error: true, text: messageOf(error) }); }
  };
  const chooseFolder = async () => {
    const api = (window as any).electronAPI;
    if (!api?.selectFolder) { setShowFolderInput(value => !value); return; }
    try { const next = await api.selectFolder(); if (typeof next === 'string' && next) { onAddFolder(next); setSelectedRoot(next); } }
    catch (error) { setFeedback({ error: true, text: messageOf(error) }); }
  };
  const editIdentity = async () => {
    if (!current || identityLoading) return;
    if (identity) { setIdentity(null); return; }
    const requestedRoot = root;
    setIdentityLoading(true);
    try {
      const value = await readGit<{ name: string; email: string }>(current.root, 'identity');
      if (mounted.current && rootRef.current === requestedRoot) setIdentity({ ...value, root: current.root });
    } catch (error) { if (mounted.current && rootRef.current === requestedRoot) setFeedback({ error: true, text: messageOf(error) }); }
    finally { if (mounted.current) setIdentityLoading(false); }
  };
  const chooseView = (next: GitView) => { setView(next); setSelection(null); setFilter(''); setConfirmation(null); };
  const confirm = (title: string, detail: string, label: string, input: GitMutation, danger = false) => setConfirmation({ title, detail, label, input: { ...input, confirmed: true }, danger });
  const pushBranch = () => {
    if (!current || locked || !remote) return;
    const destination = current.upstream.startsWith(remote + '/') ? current.upstream : remote + '/' + current.branch;
    const input = action('push', { remote });
    if (preferences.gitConfirmPush) confirm('Push this branch?', `Publish commits from ${current.branch} in ${current.root} to ${destination}.${current.upstream ? '' : ' This will also set the upstream for this branch.'} Uncommitted files are not included.`, 'Push branch', input);
    else void perform(input, 'Pushing…');
  };
  const copy = async (text: string, label: string) => {
    const ok = await safeCopyTextToClipboard(text);
    setFeedback({ error: !ok, text: ok ? label + ' copied.' : 'Could not copy to the clipboard.' });
  };
  const loadMoreHistory = async () => {
    if (!current || !list?.commits || listLoading) return;
    const request = ++listRequest.current;
    const capturedKey = listKey, capturedRoot = root;
    setListLoading(true);
    try {
      const result = await readGit<{ commits: GitCommit[]; hasMore: boolean }>(current.root, 'history', { skip: String(list.commits.length) });
      if (mounted.current && rootRef.current === capturedRoot && listRequest.current === request) setLists(previous => previous?.key === capturedKey ? { ...previous, commits: [...(previous.commits || []), ...result.commits.filter(commit => !previous.commits?.some(item => item.hash === commit.hash))], hasMore: result.hasMore } : previous);
    } catch (error) { if (mounted.current && listRequest.current === request) setListError(messageOf(error)); }
    finally { if (mounted.current && listRequest.current === request) setListLoading(false); }
  };
  const renderFiles = (title: string, files: GitFile[], stagedGroup: boolean, conflictGroup = false) => {
    const matching = files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase()));
    if (!files.length) return null;
    return <section className="eterx-git-file-group" aria-label={title}>
      <div className="eterx-git-group-heading"><h3>{title} <span>{files.length}</span></h3>{!conflictGroup && <button disabled={locked || !matching.length || matching.length > 500} aria-description={matching.length > 500 ? 'Stage or unstage up to 500 files at a time. Narrow the filter.' : undefined} onClick={() => void perform(action(stagedGroup ? 'unstage' : 'stage', { paths: matching.map(file => file.path) }), stagedGroup ? 'Unstaging…' : 'Staging…')}>{stagedGroup ? <Minus size={13} /> : <Plus size={13} />}{filter ? 'Matching' : 'All'}</button>}</div>
      {matching.slice(0, fileLimit).map(file => <div key={file.path} className={'eterx-git-file-row' + (selection?.kind === 'file' && selection.path === file.path && selection.staged === stagedGroup ? ' is-selected' : '')}>
        <button className="eterx-git-file-main" onClick={() => setSelection({ kind: 'file', path: file.path, staged: stagedGroup })} aria-pressed={selection?.kind === 'file' && selection.path === file.path && selection.staged === stagedGroup} aria-label={`Preview ${file.path}, ${statusLabel(file, stagedGroup)}`}>
          <WorkspaceFileIcon path={file.path} size={16} /><span className="eterx-git-file-name"><strong>{basename(file.path)}</strong><small>{file.originalPath ? file.originalPath + ' → ' + file.path : file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''}</small></span>
          <FileDiffStats file={file} staged={stagedGroup} />
        </button>
        <Tooltip text={stagedGroup ? 'Unstage file' : file.conflicted ? 'Stage resolved file' : 'Stage file'} showOnFocus><button className="eterx-git-icon-button" aria-label={`${stagedGroup ? 'Unstage' : file.conflicted ? 'Mark resolved' : 'Stage'} ${file.path}`} disabled={locked} onClick={() => file.conflicted ? confirm('Mark conflict resolved?', `Stage ${file.path} after resolving its conflict markers.`, 'Stage resolved file', action('stage', { paths: [file.path] })) : void perform(action(stagedGroup ? 'unstage' : 'stage', { paths: [file.path] }), stagedGroup ? 'Unstaging…' : 'Staging…')}>{stagedGroup ? <Minus size={15} /> : <Plus size={15} />}</button></Tooltip>
      </div>)}
      {!matching.length && <p className="eterx-git-note">No matching files.</p>}
      {matching.length > fileLimit && <button className="eterx-git-load-more" onClick={() => setFileLimit(value => value + 150)}>Show more files</button>}
    </section>;
  };

  if (!preferences.ready) return <div className="eterx-git-placeholder"><Loader2 size={22} className="animate-spin" /><p>Loading Git preferences…</p></div>;
  if (!enabled) return <div className="eterx-workspace-empty"><GitBranch size={30} /><h3>Git workspace is off</h3><p>Enable Git integration and Git workspace tab in Settings → Git to use this panel.</p></div>;

  return <div className="eterx-git" aria-label="Git workspace" aria-busy={!!busy}>
    <div className="eterx-git-toolbar">
      <FolderOpen size={15} />
      <select aria-label="Repository folder" disabled={!!busy || !!workspacePath} value={root} onChange={event => setSelectedRoot(event.target.value)}>
        {!root && <option value="">Choose a folder</option>}
        {[...new Set([root, ...roots].filter(Boolean))].map(folder => <option key={folder} value={folder}>{basename(folder)}</option>)}
      </select>
      {!workspacePath && <Tooltip text="Choose repository folder" showOnFocus><button className="eterx-git-icon-button" aria-label="Choose repository folder" disabled={!!busy} onClick={() => void chooseFolder()}><Plus size={16} /></button></Tooltip>}
      <Tooltip text="Refresh Git" showOnFocus><button className="eterx-git-icon-button" aria-label="Refresh Git" disabled={!!busy || loading || !root} onClick={refresh}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button></Tooltip>
      {current && <Tooltip text="Commit author settings" showOnFocus><button className="eterx-git-icon-button" aria-label="Commit author settings" disabled={!!busy || identityLoading} onClick={() => void editIdentity()}>{identityLoading ? <Loader2 size={15} className="animate-spin" /> : <UserRound size={15} />}</button></Tooltip>}
      <Tooltip text="Open repository terminal" showOnFocus><button className="eterx-git-icon-button" aria-label="Open repository terminal" disabled={!root} onClick={() => void openTerminal()}><TerminalSquare size={15} /></button></Tooltip>
    </div>
    {showFolderInput && <form className="eterx-git-inline-form" onSubmit={event => { event.preventDefault(); const next = folderInput.trim(); if (next) { onAddFolder(next); setSelectedRoot(next); setShowFolderInput(false); } }}><input autoFocus aria-label="Absolute repository folder" placeholder="Absolute folder path" value={folderInput} onChange={event => setFolderInput(event.target.value)} /><button type="submit">Open</button></form>}
    {root && <div className="eterx-git-root" aria-description={current?.root || root}>{current?.root || root}</div>}
    {identity && identity.root === current?.root && <form className="eterx-git-form" onSubmit={event => { event.preventDefault(); if (!locked) void perform(action('set-identity', { name: identity.name, email: identity.email }), 'Saving identity…'); }}><label>Commit author<input autoFocus value={identity.name} maxLength={200} disabled={!!busy} onChange={event => setIdentity({ ...identity, name: event.target.value })} required /></label><label>Commit email<input type="email" value={identity.email} maxLength={320} disabled={!!busy} onChange={event => setIdentity({ ...identity, email: event.target.value })} required /></label><p>This identity appears in commits. Saving overrides the identity for this repository only.</p><div className="eterx-git-form-actions"><button type="button" onClick={() => setIdentity(null)}>Cancel</button><button className="eterx-git-primary" disabled={locked || !identity.name.trim() || !identity.email.trim()}>Save identity</button></div></form>}
    {(rootError || statusError) && <div className="eterx-git-notice is-error" role="alert"><AlertCircle size={15} /><span>{statusError || rootError}</span><button onClick={refresh} disabled={loading}>Retry</button></div>}
    {feedback && <div className={'eterx-git-notice' + (feedback.error ? ' is-error' : ' is-success')} role={feedback.error ? 'alert' : 'status'}>{feedback.error ? <AlertCircle size={15} /> : <Check size={15} />}<span>{feedback.text}</span><button aria-label="Dismiss message" onClick={() => setFeedback(null)}><X size={14} /></button></div>}
    {busy && <div className="eterx-git-progress" role="status"><Loader2 size={14} className="animate-spin" />{busy}</div>}
    {confirmation && <section className={'eterx-git-confirm' + (confirmation.danger ? ' is-danger' : '')} aria-label={confirmation.title}>
      <strong>{confirmation.title}</strong><p>{confirmation.detail}</p><div><button autoFocus onClick={() => setConfirmation(null)}>Cancel</button><button className="eterx-git-primary" disabled={!!busy || !!statusError || loading} onClick={() => void perform(confirmation.input, confirmation.label + '…')}>{confirmation.label}</button></div>
    </section>}

    {!root ? <div className="eterx-git-placeholder"><GitBranch size={30} strokeWidth={1.4} /><h3>Your repository, within reach</h3><p>{rootsLoading ? 'Finding your workspace folders…' : 'Choose a project to review changes, create commits, and manage branches.'}</p>{!rootsLoading && <button className="eterx-git-button" onClick={() => void chooseFolder()}><FolderOpen size={15} />Choose project folder</button>}</div>
      : !currentStatus ? <div className="eterx-git-placeholder">{loading && <Loader2 size={22} className="animate-spin" />}<p>{loading ? 'Reading repository…' : 'Refresh to read this repository.'}</p></div>
      : !currentStatus.available ? <div className="eterx-git-placeholder"><GitBranch size={30} strokeWidth={1.4} /><h3>{currentStatus.reason === 'not-installed' ? 'Git is not available' : 'Start versioning this project'}</h3><p>{currentStatus.reason === 'not-installed' ? 'Install Git and restart EterX so it is available on PATH.' : 'This folder is not in a Git repository. Initialize it, then choose which files belong in your first commit.'}</p>{currentStatus.reason === 'not-repository' && <button className="eterx-git-button" disabled={!!busy} onClick={() => confirm('Initialize a repository?', `Create a Git repository in ${root} with an initial branch named main. Files will remain unstaged.`, 'Initialize repository', action('init', { branch: 'main' }))}><Plus size={15} />Initialize repository</button>}</div>
      : <>
        <div className="eterx-git-branch-bar"><button className="eterx-git-current-branch" onClick={() => chooseView('branches')}><GitBranch size={15} /><strong>{currentStatus.branch || 'Unborn branch'}</strong><ChevronDown size={12} /></button><span className="eterx-git-track" aria-description={currentStatus.upstream || 'No tracking branch'}>{currentStatus.detached ? 'Detached HEAD' : !currentStatus.head ? 'No commits yet' : currentStatus.upstream || 'Local branch'}</span>{currentStatus.upstream && <span className="eterx-git-sync-count" aria-description="Compared with the last fetched upstream"><ArrowUp size={12} />{currentStatus.ahead}<ArrowDown size={12} />{currentStatus.behind}</span>}</div>
        {currentStatus.operation && <div className="eterx-git-notice is-warning"><AlertCircle size={15} /><span>{currentStatus.operation.replace(/_/g, ' ')} in progress. Resolve files here; use Terminal to continue or abort.</span></div>}
        {currentStatus.detached && <div className="eterx-git-notice is-warning"><GitBranch size={15} /><span>Create a branch to keep new commits attached to a branch.</span><button onClick={() => { chooseView('branches'); setCreatingBranch(true); setBranchDraft(preferences.gitBranchPrefix); }}>Create branch</button></div>}
        <div className="eterx-git-remote-bar">
          {currentStatus.remotes.length ? <>
            <div className="eterx-git-remote-picker">
              <WorkspaceMenu key={currentStatus.root} label={`Select remote, current: ${remote}`} disabled={!!busy} align="start" trigger={<><span aria-description={remote}>{remote}</span><ChevronDown size={12} aria-hidden="true" /></>}>
                <div className="eterx-workspace-menu-heading" role="presentation">Remotes</div>
                {currentStatus.remotes.map(name => <button key={name} type="button" role="menuitemradio" aria-checked={name === remote} aria-description={name} onClick={() => setRemoteChoice(name)}><span>{name}</span><Check size={14} aria-hidden="true" /></button>)}
              </WorkspaceMenu>
            </div>
            <div className="eterx-git-remote-actions">
              <button disabled={locked} aria-description="Update remote references without changing your files" onClick={() => void perform(action('fetch', { remote }), 'Fetching…')}><RefreshCw size={13} />Fetch</button>
              <button disabled={locked || !currentStatus.upstream.startsWith(remote + '/') || !!currentStatus.files.length || !!currentStatus.operation || currentStatus.detached} aria-description="Fast-forward from the tracking branch; requires a clean working tree" onClick={() => void perform(action('pull', { remote }), 'Pulling…')}><ArrowDown size={13} />Pull</button>
              <button disabled={locked || !currentStatus.head || currentStatus.detached || !!currentStatus.operation} onClick={pushBranch}><ArrowUp size={13} />{currentStatus.upstream ? 'Push' : 'Publish'}</button>
              <Tooltip text="Add another remote" showOnFocus><button className="eterx-git-icon-button" aria-label="Add another remote" disabled={locked} onClick={() => setAddingRemote(value => !value)}><Plus size={13} /></button></Tooltip>
            </div>
          </> : <><span>This repository is local</span><button disabled={locked} onClick={() => setAddingRemote(value => !value)}><Plus size={13} />Add remote</button></>}
        </div>
        {addingRemote && <form className="eterx-git-form" onSubmit={event => { event.preventDefault(); void perform(action('add-remote', { remote: remoteName, url: remoteUrl }), 'Adding remote…'); }}><label>Remote name<input autoFocus value={remoteName} onChange={event => setRemoteName(event.target.value)} placeholder="origin" disabled={!!busy} required /></label><label>Repository URL<input value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="https://host/owner/repository.git" disabled={!!busy} required /></label><p>Uses your system Git credentials. Adding a remote does not push files.</p><div className="eterx-git-form-actions"><button type="button" onClick={() => setAddingRemote(false)}>Cancel</button><button className="eterx-git-primary" disabled={locked || !remoteName.trim() || !remoteUrl.trim()}>Add remote</button></div></form>}
        <div className="eterx-git-nav" role="tablist" aria-label="Git views">{views.map((item, index) => <button key={item.id} role="tab" tabIndex={view === item.id ? 0 : -1} aria-selected={view === item.id} onClick={() => chooseView(item.id)} onKeyDown={event => { if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length; chooseView(views[next].id); (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus(); }}><item.icon size={14} /><span>{item.title}</span>{item.id === 'changes' && currentStatus.files.length > 0 && <small>{currentStatus.files.length}</small>}</button>)}</div>
        <div className={'eterx-git-body' + (selection ? ' has-preview' : '')}>
          <div className="eterx-git-list-pane" role="tabpanel" aria-label={views.find(item => item.id === view)?.title}>
            <div className="eterx-git-filter"><Search size={14} /><input aria-label={`Filter ${view}`} placeholder={view === 'history' ? 'Filter loaded commits…' : `Filter ${view}…`} value={filter} onChange={event => setFilter(event.target.value)} />{filter && <button aria-label="Clear filter" onClick={() => setFilter('')}><X size={13} /></button>}</div>
            {listError && view !== 'changes' && <div role="alert" className="eterx-git-notice is-error"><span>{listError}</span><button onClick={refresh}>Retry</button></div>}
            <div className="eterx-git-list-scroll eterx-scrollbar">
              {view === 'changes' && <>
                {renderFiles('Conflicts', conflicts, false, true)}{renderFiles('Staged changes', staged, true)}{renderFiles('Changes', unstaged, false)}
                {!currentStatus.files.length && <div className="eterx-git-placeholder"><span className="eterx-git-clean-icon"><Check size={24} /></span><h3>Working tree is clean</h3><p>{currentStatus.head ? 'Your changes are committed. Keep building.' : 'Add files to your project to make your first commit.'}</p></div>}
              </>}
              {view === 'branches' && <>
                <div className="eterx-git-group-heading"><h3>Branches <span>{list?.branches?.length || 0}</span></h3><button disabled={locked} onClick={() => { setCreatingBranch(value => !value); setBranchDraft(preferences.gitBranchPrefix); }}><Plus size={13} />New branch</button></div>
                {creatingBranch && <form className="eterx-git-form" onSubmit={event => { event.preventDefault(); void perform(action('create-branch', { branch: branchDraft.trim() }), 'Creating branch…'); }}><label>Branch name<input autoFocus placeholder="eterx/my-feature" value={branchDraft} maxLength={240} disabled={!!busy} onChange={event => setBranchDraft(event.target.value)} /></label><p>Starts from your current position and keeps existing edits.</p><div className="eterx-git-form-actions"><button type="button" onClick={() => setCreatingBranch(false)}>Cancel</button><button className="eterx-git-primary" disabled={locked || !branchDraft.trim()}>Create & switch</button></div></form>}
                {list?.branches?.filter(branch => branch.name.toLowerCase().includes(filter.toLowerCase())).map(branch => <div key={(branch.remote ? 'remote:' : 'local:') + branch.name} className="eterx-git-branch-row"><GitBranch size={15} /><div><strong>{branch.name}</strong><small>{branch.current ? 'Current branch' : branch.remote ? 'Remote branch' : branch.worktree ? 'Open in another worktree' : branch.upstream || 'Local branch'}</small><p>{branch.subject}</p></div>{branch.current ? <Check size={15} /> : <WorkspaceMenu label={'Actions for ' + branch.name} trigger={<ChevronRight size={15} />}><button role="menuitem" disabled={!currentStatus.head} onClick={() => openWorkspaceReview(owner, { scope: 'branch', selected: '', filter: '', baseRefs: { [root]: (branch.remote ? 'refs/remotes/' : 'refs/heads/') + branch.name } })}><FileDiff size={14} />Compare with current branch</button><button role="menuitem" disabled={locked || !!branch.worktree} onClick={() => confirm('Switch branch?', `Switch from ${currentStatus.branch} to ${branch.name}. Commit or stash any changes first.`, 'Switch branch', action('switch-branch', { branch: branch.name, branchSource: branch.remote ? 'remote' : 'local' }))}><GitBranch size={14} />Switch to branch</button><button role="menuitem" disabled={locked || currentStatus.detached || !currentStatus.head} onClick={() => confirm(preferences.gitMergeMethod === 'squash' ? 'Squash into current branch?' : 'Merge into current branch?', `${branch.name} → ${currentStatus.branch}. ${preferences.gitMergeMethod === 'squash' ? 'Combined changes will be staged for review.' : 'Git will fast-forward or create a merge commit.'}`, preferences.gitMergeMethod === 'squash' ? 'Squash branch' : 'Merge branch', action('merge', { branch: branch.name, branchSource: branch.remote ? 'remote' : 'local', method: preferences.gitMergeMethod }))}><GitMerge size={14} />{preferences.gitMergeMethod === 'squash' ? 'Squash' : 'Merge'} into {currentStatus.branch}</button>{!branch.remote && <button role="menuitem" disabled={locked || !!branch.worktree} onClick={() => confirm('Delete local branch?', `Delete ${branch.name}. Git will refuse if it contains unmerged work or is checked out in another worktree.`, 'Delete branch', action('delete-branch', { branch: branch.name }), true)}><Trash2 size={14} />Delete merged branch</button>}</WorkspaceMenu>}</div>)}
                {!listLoading && list?.branches?.length === 0 && <p className="eterx-git-note">Branches appear after the first commit. Your initial branch is {currentStatus.branch}.</p>}
              </>}
              {view === 'history' && <>
                {list?.commits?.filter(commit => `${commit.subject} ${commit.author} ${commit.hash}`.toLowerCase().includes(filter.toLowerCase())).map(commit => <button key={commit.hash} className={'eterx-git-history-row' + (selection?.kind === 'commit' && selection.hash === commit.hash ? ' is-selected' : '')} onClick={() => setSelection({ kind: 'commit', hash: commit.hash, title: commit.subject })}><GitCommitHorizontal size={16} /><span><strong>{commit.subject}</strong><small>{commit.author} · {dateLabel(commit.date)}</small>{commit.refs && <em>{commit.refs}</em>}</span><code>{commit.shortHash}</code></button>)}
                {list?.hasMore && <button className="eterx-git-load-more" disabled={listLoading} onClick={() => void loadMoreHistory()}>Load older commits</button>}
                {!listLoading && list?.commits?.length === 0 && <div className="eterx-git-placeholder"><History size={26} /><h3>Your history starts here</h3><p>Stage files and create your first commit in Changes.</p></div>}
              </>}
              {view === 'stashes' && <>
                <form className="eterx-git-form" onSubmit={event => { event.preventDefault(); confirm('Save changes in a stash?', 'Save ' + (includeUntracked ? 'tracked edits and new untracked files' : 'tracked edits only') + ' and remove those changes from the working tree. Ignored files stay untouched.', 'Save stash', action('stash-save', { message: stashMessage, includeUntracked })); }}><label>Save work for later<input placeholder="What are you working on?" value={stashMessage} maxLength={2000} disabled={!!busy} onChange={event => setStashMessage(event.target.value)} /></label><label className="eterx-git-checkbox"><input type="checkbox" checked={includeUntracked} disabled={!!busy} onChange={event => setIncludeUntracked(event.target.checked)} />Include untracked files</label><button className="eterx-git-button" disabled={locked || !currentStatus.head || !currentStatus.files.length || !!conflicts.length || !!currentStatus.operation}><Archive size={14} />Save stash</button></form>
                {list?.stashes?.filter(stash => `${stash.subject} ${stash.ref}`.toLowerCase().includes(filter.toLowerCase())).map(stash => <div key={stash.hash + stash.ref} className="eterx-git-stash-row"><button className="eterx-git-stash-preview" onClick={() => setSelection({ kind: 'stash', hash: stash.hash, title: stash.subject })}><Archive size={15} /><span><strong>{stash.subject}</strong><small>{stash.ref} · {dateLabel(stash.date)}</small></span></button><WorkspaceMenu label={'Actions for ' + stash.ref} trigger={<ChevronRight size={15} />}><button role="menuitem" disabled={locked} onClick={() => confirm('Apply saved changes?', `Apply ${stash.ref} to ${currentStatus.branch}. Your working tree must be clean. The saved stash will be kept.`, 'Apply stash', action('stash-apply', { stash: stash.ref, stashHash: stash.hash }))}><Archive size={14} />Apply and keep stash</button><button role="menuitem" disabled={locked} onClick={() => confirm('Permanently drop this stash?', `${stash.ref}: ${stash.subject}. This removes the saved copy of these changes.`, 'Drop stash', action('stash-drop', { stash: stash.ref, stashHash: stash.hash }), true)}><Trash2 size={14} />Drop stash</button></WorkspaceMenu></div>)}
                {!listLoading && list?.stashes?.length === 0 && <div className="eterx-git-placeholder"><Archive size={25} /><h3>No saved stashes</h3><p>Set changes aside when you need a clean working tree.</p></div>}
              </>}
              {view !== 'changes' && listLoading && <div className="eterx-git-progress" role="status"><Loader2 size={14} className="animate-spin" />Loading {view}…</div>}
            </div>
            {view === 'changes' && <form className="eterx-git-commit-form" onSubmit={event => { event.preventDefault(); if (canCommit) void perform(action('commit', { message: commitMessage }), 'Committing…'); }}>
              <label htmlFor={'commit-message-' + tab.id}>Commit message</label><textarea id={'commit-message-' + tab.id} placeholder="Describe what changed…" rows={3} value={commitMessage} maxLength={20_000} disabled={!!busy} onChange={event => setDrafts(previous => ({ ...previous, [draftKey]: event.target.value }))} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
              <div><span>{conflicts.length ? `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} to resolve` : `${staged.length} staged · ${unstaged.length} unstaged`}</span><button type="submit" className="eterx-git-primary" disabled={!canCommit}><Check size={14} />Commit staged</button></div>
            </form>}
          </div>
          {selection && <section className="eterx-git-preview" aria-label="Selected diff">
            <div className="eterx-git-preview-heading"><FileDiff size={15} /><strong aria-description={selection.kind === 'file' ? selection.path : selection.title}>{selection.kind === 'file' ? basename(selection.path) : selection.title}</strong><button className="eterx-git-icon-button" aria-label="Close diff preview" onClick={() => setSelection(null)}><X size={15} /></button></div>
            <div className="eterx-git-preview-actions">{selection.kind === 'file' ? <><span>{selection.staged ? 'Staged' : 'Working tree'}</span><button onClick={() => onOpenFile(fullPath(currentStatus.root, selection.path), currentStatus.root)} aria-description="Open in Files"><ExternalLink size={13} />Open file</button><button onClick={() => openWorkspaceReview(owner, { scope: 'working', selected: fullPath(currentStatus.root, selection.path), filter: '' })}><FileDiff size={13} />Review working tree</button>{!selection.staged && diff?.token && !currentStatus.files.find(file => file.path === selection.path)?.conflicted && <button disabled={locked || diffLoading || /^Binary files /m.test(diff.text)} onClick={() => confirm('Discard unstaged changes?', `Restore ${selection.path} to its staged version. Its unstaged edits will be lost. Staged changes are kept.`, 'Discard changes', action('discard', { paths: [selection.path], token: diff.token }), true)}><RotateCcw size={13} />Discard</button>}</> : <><code>{selection.hash.slice(0, 8)}</code><button onClick={() => void copy(selection.hash, 'Commit ID')}><Copy size={13} />Copy ID</button></>}</div>
            <DiffPreview diff={diff} loading={diffLoading} error={diffError} />
          </section>}
        </div>
        <div className="eterx-git-footer"><span>{preferences.gitAutoDetect ? 'Auto-refresh on' : 'Manual refresh'} · {currentStatus.upstream ? 'Sync counts use last fetch' : 'Local repository'}</span><Tooltip text="Copy repository summary" side="top" showOnFocus><button aria-label="Copy repository summary" onClick={() => void copy(`${currentStatus.root}\nBranch: ${currentStatus.branch}\n${currentStatus.files.map(file => `${file.index}${file.working} ${file.path}`).join('\n')}`, 'Repository summary')}><Copy size={12} /></button></Tooltip></div>
      </>}
  </div>;
}
