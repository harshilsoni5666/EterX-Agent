'use client';

import { useRef, useState } from 'react';
import { ArrowLeft, Check, GitFork, Info, LaptopMinimal, Loader2, Terminal, Clock3 } from 'lucide-react';
import type { ManagedWorkspace, RunLocation } from '../../lib/managed-workspaces';

const options = [
  { id: 'local' as const, label: 'Work locally', icon: LaptopMinimal },
  { id: 'worktree' as const, label: 'New worktree', icon: GitFork },
  { id: 'sandbox' as const, label: 'Scratch workspace', icon: Terminal },
];

export function WorkspaceLocationMenu({ location, workspace, retentionDays, busy, error, locked, choose, update }: {
  location: RunLocation; workspace: ManagedWorkspace | null; retentionDays: number; busy: boolean; error: string; locked: boolean;
  choose: (location: RunLocation) => Promise<void>; update: (action: 'keep' | 'extend' | 'remove') => Promise<void>;
}) {
  const [details, setDetails] = useState<RunLocation | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const infoButtons = useRef<Partial<Record<RunLocation, HTMLButtonElement | null>>>({});
  const selectedDetails = workspace?.kind === details ? workspace : null;
  const back = () => { const previous = details; setDetails(null); setConfirmRemove(false); requestAnimationFrame(() => previous && infoButtons.current[previous]?.focus()); };
  return <div className="eterx-workspace-location-menu" aria-busy={busy}>
    {details ? <section className="eterx-workspace-details" aria-label={`${details === 'worktree' ? 'Worktree' : 'Scratch workspace'} details`}>
      <button type="button" autoFocus onClick={back} className="eterx-workspace-back">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{details === 'worktree' ? 'New worktree' : 'Scratch workspace'}</span>
      </button>
      <p>{details === 'worktree'
        ? 'Work on a separate branch and folder from the selected repository’s current commit. Your original folder stays available.'
        : `A fresh local folder for temporary work. New scratch workspaces expire ${retentionDays} ${retentionDays === 1 ? 'day' : 'days'} after creation.`}</p>
      {details === 'worktree' ? <>
        <div className="eterx-workspace-detail-block"><strong>Separate changes</strong><p>Uncommitted changes stay in the source folder. Dependencies are installed only when your task needs them.</p></div>
        <div className="eterx-workspace-detail-block"><strong>Keep your work</strong><p>Worktrees do not expire. Review and merge the branch when you are ready.</p></div>
      </> : <>
        <div className="eterx-workspace-detail-block"><strong>Automatic cleanup</strong><p>Files are deleted after expiry while EterX is running, or after its next launch. Active agents and open terminals delay cleanup. Chat history stays available.</p></div>
        <div className="eterx-workspace-detail-block"><strong>Your device, your tools</strong><p>This is a temporary folder on this device. It uses the same permissions as local work.</p></div>
      </>}
      {selectedDetails && <div className="eterx-workspace-receipt">
        <strong>{selectedDetails.status === 'expired' ? 'Workspace expired' : details === 'worktree' ? 'Current worktree' : 'Current scratch workspace'}</strong>
        <p className="eterx-workspace-path" title={selectedDetails.path}>{selectedDetails.path}</p>
        {selectedDetails.branch && <p>Branch · {selectedDetails.branch}</p>}
        <p>Created · {new Date(selectedDetails.createdAt).toLocaleString()}</p>
        {details === 'sandbox' && <p>{selectedDetails.expiresAt ? `Expires · ${new Date(selectedDetails.expiresAt).toLocaleString()}` : 'Kept until you remove it'}</p>}
        {details === 'sandbox' && selectedDetails.status === 'ready' && <div className="eterx-workspace-actions">
          <button type="button" disabled={busy} onClick={() => void update('extend')}>+{retentionDays} days</button>
          {selectedDetails.expiresAt && <button type="button" disabled={busy} onClick={() => void update('keep')}>Keep workspace</button>}
        </div>}
        {selectedDetails.status === 'ready' && <div className="eterx-workspace-actions">
          {confirmRemove ? <>
            <p>{details === 'sandbox' ? 'Permanently delete the files in this scratch workspace? Chat history will be kept.' : 'Remove this worktree folder? Uncommitted changes block removal. The branch will be kept.'}</p>
            <button type="button" disabled={busy || locked} onClick={() => void update('remove')}>{details === 'sandbox' ? 'Delete scratch files' : 'Remove worktree'}</button>
            <button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button>
          </> : <button type="button" disabled={busy || locked} onClick={() => setConfirmRemove(true)}>Remove workspace…</button>}
        </div>}
      </div>}
      {details === 'sandbox' && <p className="eterx-workspace-footnote">Change the default in Settings → General → Scratch workspace retention. Changes apply to new workspaces.</p>}
    </section> : <>
      <div className="eterx-status-menu-label">Start in</div>
      {options.map(option => <div key={option.id} className="eterx-workspace-option" data-selected={location === option.id}>
        <button type="button" disabled={busy || locked} aria-pressed={location === option.id} onClick={() => void choose(option.id)}>
          <option.icon className="eterx-status-menu-icon" strokeWidth={1.95} />
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {location === option.id && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.05} />}
        </button>
        {option.id !== 'local' && <button type="button" ref={node => { infoButtons.current[option.id] = node; }} className="eterx-workspace-info" aria-label={`About ${option.label.toLowerCase()}`} aria-haspopup="dialog" onClick={() => setDetails(option.id)}>
          <Info className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
        </button>}
      </div>)}
      {workspace?.kind === 'sandbox' && <button type="button" className="eterx-workspace-expiry" onClick={() => setDetails('sandbox')}>
        <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{workspace.status === 'expired' ? 'Expired · create a new workspace' : workspace.expiresAt ? `Expires ${new Date(workspace.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Kept · no automatic deletion'}</span>
      </button>}
      {locked && <p className="eterx-workspace-footnote">Workspace changes are available when this run finishes.</p>}
    </>}
    {busy && <div className="eterx-workspace-feedback" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing workspace…</div>}
    {error && <p className="eterx-workspace-error" role="alert">{error}</p>}
  </div>;
}
