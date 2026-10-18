'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, GitBranch, Loader2, Plus, ChevronDown, ArrowUpRight, RefreshCw } from 'lucide-react';
import { GIT_CHANGED_EVENT, mutateGit, readGit, readGitStatus, useGitPreferences } from '../../lib/git/client';
import type { GitBranch as Branch, GitSnapshot } from '../../lib/git/types';
import { addWorkspaceTab } from '../../lib/side-workspace-store';
import { isAppVisible, useAppVisibility } from '../../lib/app-visibility';
import { AdaptiveMenu } from '../ui/adaptive-menu';

export function GitBranchControl({ root, owner, open, onToggle, onClose }: {
  root?: string | null; owner: string; open: boolean; onToggle: (event: React.MouseEvent) => void; onClose: () => void;
}) {
  const preferences = useGitPreferences();
  const visible = useAppVisibility();
  const enabled = preferences.ready && preferences.gitIntegration;
  const [snapshot, setSnapshot] = useState<{ key: string; value: GitSnapshot | null } | null>(null);
  const [branches, setBranches] = useState<{ key: string; items: Branch[] } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [branchesError, setBranchesError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const pending = useRef(false);
  const generation = useRef(0);
  const current = snapshot && snapshot.key === root ? snapshot.value : null;
  const currentBranches = branches && branches.key === root ? branches.items : [];

  useEffect(() => { generation.current++; setError(''); setActionError(''); setBranchesError(''); setCreating(false); setQuery(''); return () => { generation.current++; }; }, [root, owner]);
  useEffect(() => { if (open) { setCreating(false); setQuery(''); setName(preferences.gitBranchPrefix); } }, [open, preferences.gitBranchPrefix]);
  useEffect(() => {
    if (!root || !enabled || !visible || pending.current) return;
    let disposed = false;
    const abort = new AbortController();
    setLoading(true);
    void readGitStatus(root, abort.signal).then(value => {
      if (!disposed) { setSnapshot({ key: root, value: value.available ? value : null }); setError(''); }
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; abort.abort(); };
  }, [root, enabled, visible, nonce, open]);

  useEffect(() => {
    if (!root || !enabled || !open || !visible) return;
    let disposed = false;
    const abort = new AbortController();
    setBranchesError('');
    void readGit<{ branches: Branch[] }>(root, 'branches', {}, abort.signal).then(result => {
      if (!disposed) setBranches({ key: root, items: result.branches.filter(branch => !branch.remote) });
    }).catch(cause => { if (!disposed) setBranchesError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; abort.abort(); };
  }, [root, enabled, open, visible, nonce]);

  useEffect(() => {
    if (!enabled || !root || !visible) return;
    const refresh = () => { if (isAppVisible() && !pending.current) setNonce(value => value + 1); };
    window.addEventListener(GIT_CHANGED_EVENT, refresh);
    if (preferences.gitAutoDetect) window.addEventListener('focus', refresh);
    const interval = preferences.gitAutoDetect ? setInterval(refresh, 30_000) : undefined;
    return () => { window.removeEventListener(GIT_CHANGED_EVENT, refresh); window.removeEventListener('focus', refresh); clearInterval(interval); };
  }, [enabled, root, visible, preferences.gitAutoDetect]);

  const changeBranch = async (branch: string, create: boolean) => {
    if (!current || pending.current || loading || error) return;
    const revision = generation.current;
    pending.current = true; setBusy(true); setActionError('');
    try {
      await mutateGit({ root: current.root, revision: current.revision, action: create ? 'create-branch' : 'switch-branch', branch });
      if (generation.current === revision) { setCreating(false); onClose(); }
    } catch (cause) {
      if (generation.current === revision) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false); setNonce(value => value + 1);
    }
  };
  if (!enabled || !root || (!current && !error)) return null;
  const label = current ? current.detached ? current.branch + ' · detached' : current.branch : 'Git unavailable';
  const displayError = actionError || error || branchesError;

  return <div className="eterx-new-chat-status-anchor">
    <button type="button" className={`eterx-new-chat-status-item ${open ? 'is-open' : ''}`} aria-label={`Git branch ${label}${current?.files.length ? `, ${current.files.length} changed files` : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={onToggle}>
      <GitBranch className="eterx-new-chat-status-icon" strokeWidth={1.9} /><span>{label}</span>
      {!!current?.files.length && <span className="eterx-git-composer-count" aria-description={`${current.files.length} changed files`}>{current.files.length}</span>}
      <ChevronDown className="eterx-new-chat-status-chevron" strokeWidth={2.1} />
    </button>
    {open && <AdaptiveMenu className="eterx-composer-popout eterx-status-popout eterx-status-popout-branch" role="dialog" aria-label="Git branch menu" onClick={event => event.stopPropagation()}>
      <div className="eterx-status-menu-label">{current?.detached ? 'Detached HEAD' : 'Branch'}<button className="eterx-git-composer-refresh" aria-label="Refresh branches" disabled={loading || busy} onClick={() => setNonce(value => value + 1)}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button></div>
      {displayError && <div className="eterx-git-composer-error" role="alert"><AlertCircle size={14} /><span>{displayError}</span></div>}
      {preferences.gitWorkspaceEnabled && <button type="button" className="eterx-status-menu-item" onClick={() => { addWorkspaceTab(owner, 'git', { root }); onClose(); }}><GitBranch className="eterx-status-menu-icon" /><span className="min-w-0 flex-1 text-left">Open Git workspace</span><ArrowUpRight size={15} /></button>}
      {current && <>
        <div className="eterx-status-menu-rule" />
        {currentBranches.length > 7 && <div className="eterx-status-search mx-1 my-1"><input aria-label="Find branch" placeholder="Find a branch…" value={query} onChange={event => setQuery(event.target.value)} className="w-full bg-transparent text-[12px] outline-none" /></div>}
        <div data-menu-scroll-region className="eterx-status-menu-section flex-1 min-h-0 overflow-y-auto eterx-scrollbar">
          {currentBranches.filter(branch => branch.name.toLowerCase().includes(query.toLowerCase())).map(branch => <button key={branch.name} type="button" disabled={busy || loading || branch.current || !!branch.worktree} className={`eterx-status-menu-item ${branch.current ? 'is-selected' : ''}`} aria-description={branch.worktree && !branch.current ? 'Open in another worktree' : branch.name} onClick={() => void changeBranch(branch.name, false)}><GitBranch className="eterx-status-menu-icon" strokeWidth={1.95} /><span className="min-w-0 flex-1 truncate text-left">{branch.name}</span>{branch.current && <Check className="h-4 w-4 shrink-0" />}</button>)}
          {!currentBranches.length && <div className="eterx-git-composer-hint">{loading ? 'Reading branches…' : !current.head ? 'Create your first commit to save this branch.' : 'No local branches.'}</div>}
        </div>
        <div className="eterx-status-menu-rule" />
        {creating ? <form className="eterx-git-composer-create" onSubmit={event => { event.preventDefault(); if (name.trim()) void changeBranch(name.trim(), true); }}><input autoFocus aria-label="New branch name" value={name} maxLength={240} disabled={busy} placeholder="New branch name…" onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setCreating(false); } }} /><button type="submit" disabled={busy || loading || !name.trim()}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}Create</button></form> : <button type="button" disabled={busy || !!current.operation} className="eterx-status-menu-item" onClick={() => { setCreating(true); setName(preferences.gitBranchPrefix); }}><Plus className="eterx-status-menu-icon" /><span className="min-w-0 flex-1 text-left">Create new branch</span></button>}
        {!!current.files.length && <div className="eterx-git-composer-hint">Commit or stash changes before switching branches.</div>}
      </>}
    </AdaptiveMenu>}
  </div>;
}
