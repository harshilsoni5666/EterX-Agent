'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Check, FolderClosed, FolderOpen, FolderPlus, Plus, Search, X } from 'lucide-react';
import { appStorage, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { normalizePathForComparison } from '../../lib/path-utils';
import { AdaptiveMenu } from '../ui/adaptive-menu';

const recentProjectsKey = 'eterx_recent_projects';
type RecentProject = { path: string; name: string; openedAt?: number };

function readRecentProjects(): RecentProject[] {
  try {
    const stored: unknown = JSON.parse(appStorage.getItem(recentProjectsKey) || '[]');
    return Array.isArray(stored) ? stored.filter(project =>
      typeof project?.path === 'string' && project.path.trim() && typeof project.name === 'string',
    ) : [];
  } catch { return []; }
}

function writeRecentProjects(projects: RecentProject[]) {
  try { appStorage.setItem(recentProjectsKey, JSON.stringify(projects)); } catch {}
}

export function projectFolderName(path?: string | null) {
  return path?.split(/[/\\]/).filter(Boolean).pop() || path || 'Chat workspace';
}

function rememberProject(path: string) {
  const key = normalizePathForComparison(path);
  writeRecentProjects([
    { path, name: projectFolderName(path), openedAt: Date.now() },
    ...readRecentProjects().filter(project => normalizePathForComparison(project.path) !== key),
  ].slice(0, 8));
}

export function useProjectFolderBrowse(owner: string, workspacePath: string | null, locked: boolean, select: (path: string) => void, onError: () => void) {
  const current = useRef({ owner, workspacePath, locked, select, onError });
  current.current = { owner, workspacePath, locked, select, onError };
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  return useCallback(async () => {
    const target = current.current;
    if (pending.current || target.locked) return;
    pending.current = true;
    try {
      const desktop = (window as any).electronAPI;
      const path: string | null = typeof desktop?.selectFolder === 'function'
        ? await desktop.selectFolder()
        : window.prompt('Paste or type your local project folder path:');
      const latest = current.current;
      if (!path?.trim() || !mounted.current || latest.owner !== target.owner || latest.workspacePath !== target.workspacePath || latest.locked) return;
      const folder = path.trim();
      rememberProject(folder);
      latest.select(folder);
    } catch {
      if (mounted.current && current.current.owner === target.owner) current.current.onError();
    } finally {
      pending.current = false;
    }
  }, []);
}

export function ProjectFolderPicker({ workspacePath, workspaceName, locked, onSelect, onBrowse, onClose, portalAnchorRef, menuRef }: {
  workspacePath: string | null;
  workspaceName: string;
  locked: boolean;
  onSelect: (path: string | null) => void;
  onBrowse: () => void;
  onClose: () => void;
  portalAnchorRef?: RefObject<HTMLElement | null>;
  menuRef?: RefObject<HTMLDivElement | null>;
}) {
  const [search, setSearch] = useState('');
  const [recentProjects, setRecentProjects] = useState(readRecentProjects);
  useEffect(() => {
    const refresh = () => setRecentProjects(readRecentProjects());
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, refresh);
    return () => window.removeEventListener(FOLDER_STORAGE_READY_EVENT, refresh);
  }, []);

  const pathKey = normalizePathForComparison(workspacePath || '');
  const query = search.trim().toLowerCase();
  const pastedPath = search.trim();
  const looksLikePath = /[/\\]/.test(pastedPath);
  const recentKeys = new Set(recentProjects.map(project => normalizePathForComparison(project.path)));
  const seen = new Set<string>();
  const projects = [
    ...(workspacePath ? [{ path: workspacePath, name: workspaceName }] : []),
    ...recentProjects,
  ].filter(project => {
    const key = normalizePathForComparison(project.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return project.name.toLowerCase().includes(query) || project.path.toLowerCase().includes(query);
  });

  const select = (path: string | null) => {
    if (locked) return;
    if (!path || normalizePathForComparison(path) !== pathKey) {
      if (path) rememberProject(path);
      onSelect(path);
    }
    onClose();
  };

  return (
    <AdaptiveMenu
      className="eterx-composer-popout eterx-status-popout eterx-status-popout-project"
      heightLimit={420}
      portalAnchorRef={portalAnchorRef}
      menuRef={menuRef}
      role="dialog"
      aria-label="Workspace folder selector"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          const anchor = portalAnchorRef?.current || event.currentTarget.parentElement;
          onClose();
          anchor?.querySelector<HTMLButtonElement>(':scope > button')?.focus({ preventScroll: true });
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.eterx-status-menu-item:not(:disabled)')];
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1);
        items[next]?.focus();
      }}
    >
      <label className="eterx-status-search">
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <input autoFocus aria-label="Search projects by name or path" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search projects or paste path..." className="min-w-0 flex-1 bg-transparent text-[12px] outline-hidden" />
      </label>
      <div data-menu-scroll-region className="eterx-status-menu-section flex-1 min-h-0 overflow-y-auto eterx-scrollbar">
        {looksLikePath && <button type="button" disabled={locked} className="eterx-status-menu-item" onClick={() => select(pastedPath)}>
          <FolderPlus className="eterx-status-menu-icon" />
          <span className="min-w-0 flex-1"><span className="block">Use pasted path</span><span className="block truncate text-[10px] opacity-65">{pastedPath}</span></span>
        </button>}
        {projects.map(project => {
          const key = normalizePathForComparison(project.path);
          const selected = key === pathKey;
          return <div key={key} className="eterx-project-picker-choice">
            <button type="button" disabled={locked} title={project.path} aria-pressed={selected} className={`eterx-status-menu-item ${selected ? 'is-selected' : ''}`} onClick={() => select(project.path)}>
              <FolderClosed className="eterx-status-menu-icon" strokeWidth={1.95} />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {selected && <Check className="eterx-project-selected-check h-4 w-4 shrink-0" strokeWidth={2.45} />}
            </button>
            {recentKeys.has(key) && <button type="button" disabled={locked} className="eterx-project-picker-remove" aria-label={`Remove ${project.name} from recent projects`} title="Remove from list" onClick={() => {
              const next = readRecentProjects().filter(item => normalizePathForComparison(item.path) !== key);
              writeRecentProjects(next);
              setRecentProjects(next);
            }}><X size={13} /></button>}
          </div>;
        })}
        {!projects.length && !looksLikePath && <div className="eterx-status-empty" role="status">
          <FolderOpen className="mx-auto mb-2 h-5 w-5" strokeWidth={1.6} />
          <p>{query ? 'No matching projects' : 'Choose your first project'}</p>
          <p className="eterx-project-empty-hint">{query ? 'Try another name or paste a folder path.' : 'Open a folder to give this chat a workspace.'}</p>
        </div>}
      </div>
      <div className="eterx-status-menu-rule" />
      <button type="button" disabled={locked} className="eterx-status-menu-item eterx-project-action" onClick={() => { onClose(); onBrowse(); }}>
        <Plus className="eterx-status-menu-icon" strokeWidth={1.95} /><span className="flex-1">New project</span>
      </button>
      <button type="button" disabled={locked} className="eterx-status-menu-item eterx-project-action" aria-pressed={!workspacePath} onClick={() => select(null)}>
        <X className="eterx-status-menu-icon" strokeWidth={1.8} /><span className="flex-1">Don&apos;t work in a project</span>
        {!workspacePath && <Check className="eterx-project-selected-check h-4 w-4 shrink-0" strokeWidth={2} />}
      </button>
    </AdaptiveMenu>
  );
}
