"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Code2,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  Home,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wand2,
  X,
} from 'lucide-react';
import { CodeView } from '../code/code-view';

type BrowseFolder = {
  name: string;
  path: string;
  isProject?: boolean;
};

type RecentProject = {
  path: string;
  name: string;
  openedAt: number;
};

const RECENT_PROJECTS_KEY = 'eterx_recent_projects';

const readRecentProjects = (): RecentProject[] => {
  if (typeof window === 'undefined') return [];
  try {
    const saved = localStorage.getItem(RECENT_PROJECTS_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const getProjectName = (projectPath: string) =>
  projectPath.split(/[/\\]/).filter(Boolean).pop() || projectPath || 'Project';

const saveRecentProject = (projectPath: string) => {
  if (typeof window === 'undefined' || !projectPath.trim()) return;
  const cleanPath = projectPath.trim();
  const next = [
    { path: cleanPath, name: getProjectName(cleanPath), openedAt: Date.now() },
    ...readRecentProjects().filter(project => project.path !== cleanPath),
  ].slice(0, 8);
  localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
};

const formatOpenedAt = (ts: number) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(ts);
  } catch {
    return 'Recently';
  }
};

export const ProjectsView = () => {
  const [workspacePath, setWorkspacePath] = useState('');
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() => readRecentProjects());
  const [roots, setRoots] = useState<BrowseFolder[]>([]);
  const [folders, setFolders] = useState<BrowseFolder[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [createParent, setCreateParent] = useState('');
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [activeTab, setActiveTab] = useState<'open' | 'create'>('open');

  const openWorkspace = useCallback((projectPath: string) => {
    const cleanPath = projectPath.trim();
    if (!cleanPath) return;
    saveRecentProject(cleanPath);
    setRecentProjects(readRecentProjects());
    setWorkspacePath(cleanPath);
  }, []);

  const changeWorkspace = useCallback((path: string) => {
    if (!path) {
      setWorkspacePath('');
      return;
    }
    openWorkspace(path);
  }, [openWorkspace]);

  const loadRoots = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/code/browse', { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data.roots)) setRoots(data.roots);
    } catch {
      setRoots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const browseTo = useCallback(async (folderPath: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/code/browse?path=${encodeURIComponent(folderPath)}`, { cache: 'no-store' });
      const data = await res.json();
      setCurrentPath(data.current || folderPath);
      setParentPath(data.parent || null);
      setManualPath(data.current || folderPath);
      setFolders(Array.isArray(data.folders) ? data.folders : []);
      if (!createParent) setCreateParent(data.current || folderPath);
    } catch {
      setFolders([]);
    } finally {
      setLoading(false);
    }
  }, [createParent]);

  useEffect(() => {
    loadRoots();
  }, [loadRoots]);

  const filteredRecent = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return recentProjects;
    return recentProjects.filter(project =>
      project.name.toLowerCase().includes(query) ||
      project.path.toLowerCase().includes(query),
    );
  }, [recentProjects, search]);

  const createProject = async () => {
    if (!createParent.trim() || !createName.trim() || creating) return;
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch('/api/code/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath: createParent.trim(), folderName: createName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data.error || 'Could not create project.');
        return;
      }
      if (data.path) openWorkspace(data.path);
    } catch (error: any) {
      setCreateError(String(error?.message || 'Could not create project.'));
    } finally {
      setCreating(false);
    }
  };

  const openNativeFolderDialog = async () => {
    const w = window as any;
    if (w.electronAPI?.selectFolder) {
      const selected = await w.electronAPI.selectFolder();
      if (selected) openWorkspace(selected);
      return;
    }
    if (manualPath.trim()) openWorkspace(manualPath);
  };

  if (workspacePath) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col bg-[#050505]">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#080808] px-4 text-[#E8E6E3]">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setWorkspacePath('')}
              className="flex h-8 items-center gap-2 rounded-full border border-white/[0.09] bg-white/[0.045] px-3 text-[12px] font-semibold text-white/70 transition hover:bg-white/[0.08] hover:text-white active:scale-95"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Projects
            </button>
            <div className="hidden min-w-0 items-center gap-2 sm:flex">
              <FolderOpen className="h-4 w-4 text-[#E2765A]" />
              <span className="truncate text-[12px] font-medium text-white/78">{workspacePath}</span>
            </div>
          </div>
          <span className="hidden rounded-full border border-emerald-400/15 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold text-emerald-300 md:inline-flex">
            Code agent ready
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <CodeView workspacePath={workspacePath} onChangeWorkspace={changeWorkspace} />
        </div>
      </div>
    );
  }

  return (
    <div className="eterx-projects-view flex-1 min-h-0 w-full overflow-y-auto bg-transparent px-5 py-5 text-[#E8E6E3] md:px-8 md:pt-6">
      <div className="mx-auto flex w-full max-w-[1380px] flex-col gap-5">
        <section className="relative overflow-hidden rounded-[26px] border border-white/[0.075] bg-[#0B0B0B]/82 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_24px_70px_rgba(0,0,0,0.32)] md:p-7">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_76%_20%,rgba(226,118,90,0.14),transparent_32%),radial-gradient(circle_at_18%_70%,rgba(72,187,120,0.08),transparent_28%)]" />
          <div className="relative grid gap-7 lg:grid-cols-[minmax(0,1fr)_430px] lg:items-center">
            <div className="min-w-0">
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="inline-flex items-center gap-2 rounded-full border border-white/[0.09] bg-white/[0.045] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/58"
              >
                <Terminal className="h-3.5 w-3.5 text-[#E2765A]" />
                Project workspace
              </motion.div>
              <h1 className="mt-4 max-w-3xl text-[30px] font-semibold leading-[1.08] tracking-tight text-white md:text-[42px]">
                Open a previous project or create a new one for the code agent.
              </h1>
              <p className="mt-4 max-w-2xl text-[14px] leading-6 text-[#9B9690]">
                Pick any local folder, start a fresh workspace, then let EterX read files, edit code, run terminal commands, review diffs, and continue work from where you left off.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {[
                  { icon: FileCode2, label: 'Read and edit files' },
                  { icon: Terminal, label: 'Run shell commands' },
                  { icon: GitBranch, label: 'Git-aware workflow' },
                  { icon: ShieldCheck, label: 'Review before ship' },
                ].map(item => (
                  <span key={item.label} className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-white/70">
                    <item.icon className="h-3.5 w-3.5 text-[#E2765A]" />
                    {item.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="relative rounded-[22px] border border-white/[0.075] bg-[#101010]/92 p-4 shadow-[0_20px_52px_rgba(0,0,0,0.28)]">
              <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-[12px] bg-[#E2765A]/14 text-[#E2765A]">
                    <Code2 className="h-[18px] w-[18px]" />
                  </span>
                  <div>
                    <div className="text-[13px] font-semibold text-white">Start coding</div>
                    <div className="text-[11px] text-[#706D68]">Two clear ways in</div>
                  </div>
                </div>
                <Sparkles className="h-4 w-4 text-white/32" />
              </div>
              <div className="mt-4 grid gap-3">
                <button
                  type="button"
                  onClick={() => setActiveTab('open')}
                  className={`flex items-center gap-3 rounded-[16px] border p-3 text-left transition active:scale-[0.99] ${activeTab === 'open' ? 'border-[#E2765A]/35 bg-[#E2765A]/10' : 'border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.055]'}`}
                >
                  <FolderOpen className="h-5 w-5 text-[#E2765A]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-white">Open existing project</span>
                    <span className="block truncate text-[11px] text-[#8C8A88]">Continue from a folder you already built</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-white/35" />
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('create')}
                  className={`flex items-center gap-3 rounded-[16px] border p-3 text-left transition active:scale-[0.99] ${activeTab === 'create' ? 'border-emerald-400/35 bg-emerald-400/10' : 'border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.055]'}`}
                >
                  <FolderPlus className="h-5 w-5 text-emerald-300" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-white">Create new project</span>
                    <span className="block truncate text-[11px] text-[#8C8A88]">Make a new folder and open it instantly</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-white/35" />
                </button>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
          <section className="rounded-[24px] border border-white/[0.075] bg-[#0B0B0B]/82 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
            <div className="flex flex-col gap-3 border-b border-white/[0.06] p-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-[17px] font-semibold text-white">
                  {activeTab === 'open' ? 'Open existing project' : 'Create new project'}
                </h2>
                <p className="mt-1 text-[12px] text-[#706D68]">
                  {activeTab === 'open' ? 'Use a native folder picker, paste a path, or browse common folders.' : 'Choose a parent folder, name the project, and EterX opens it in the code agent.'}
                </p>
              </div>
              <div className="flex rounded-full border border-white/[0.08] bg-white/[0.035] p-1">
                {(['open', 'create'] as const).map(tab => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`h-8 rounded-full px-4 text-[12px] font-semibold transition ${activeTab === tab ? 'bg-white text-black' : 'text-white/55 hover:text-white'}`}
                  >
                    {tab === 'open' ? 'Open' : 'Create'}
                  </button>
                ))}
              </div>
            </div>

            {activeTab === 'open' ? (
              <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={openNativeFolderDialog}
                    className="flex h-12 items-center justify-center gap-2 rounded-[15px] bg-white text-[13px] font-semibold text-black transition hover:bg-[#E8E6E3] active:scale-[0.99]"
                  >
                    <FolderOpen className="h-4 w-4" />
                    Browse for folder
                  </button>
                  <div className="flex items-center gap-2 rounded-[15px] border border-white/[0.08] bg-[#141414] px-3 py-2">
                    <Folder className="h-4 w-4 shrink-0 text-white/35" />
                    <input
                      value={manualPath}
                      onChange={event => setManualPath(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') openWorkspace(manualPath);
                      }}
                      placeholder="Paste folder path..."
                      className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-white outline-none placeholder:text-white/24"
                    />
                    {manualPath && (
                      <button type="button" onClick={() => setManualPath('')} className="text-white/35 hover:text-white">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => openWorkspace(manualPath)}
                    disabled={!manualPath.trim()}
                    className="flex h-10 items-center justify-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.045] text-[12px] font-semibold text-white/70 transition hover:bg-white/[0.08] hover:text-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Play className="h-3.5 w-3.5" />
                    Open path
                  </button>

                  <div className="mt-2 rounded-[16px] border border-white/[0.06] bg-white/[0.025] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#706D68]">Quick access</span>
                      <button type="button" onClick={loadRoots} className="text-white/35 transition hover:text-white">
                        <RefreshCw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="flex flex-col gap-1">
                      {loading && roots.length === 0 ? (
                        <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-[#706D68]">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading folders
                        </div>
                      ) : roots.length === 0 ? (
                        <div className="px-2 py-3 text-[12px] text-[#706D68]">No quick folders found.</div>
                      ) : (
                        roots.map(root => (
                          <button
                            key={root.path}
                            type="button"
                            onClick={() => browseTo(root.path)}
                            className="flex items-center gap-2 rounded-[11px] px-2 py-2 text-left transition hover:bg-white/[0.055]"
                          >
                            <Home className="h-3.5 w-3.5 shrink-0 text-[#E2765A]" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] font-semibold text-white/82">{root.name}</span>
                              <span className="block truncate font-mono text-[10px] text-[#706D68]">{root.path}</span>
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="min-h-[420px] rounded-[18px] border border-white/[0.06] bg-[#101010]/82 p-3">
                  <div className="mb-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (parentPath) browseTo(parentPath);
                        else {
                          setCurrentPath('');
                          setFolders([]);
                          setParentPath(null);
                        }
                      }}
                      disabled={!currentPath}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-white/55 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                    </button>
                    <div className="min-w-0 flex-1 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 font-mono text-[11px] text-[#8C8A88]">
                      <span className="block truncate">{currentPath || 'Select a folder to browse'}</span>
                    </div>
                    {currentPath && (
                      <button
                        type="button"
                        onClick={() => openWorkspace(currentPath)}
                        className="flex h-8 items-center gap-1.5 rounded-full bg-[#E2765A] px-3 text-[11px] font-semibold text-white transition hover:bg-[#D2664A] active:scale-95"
                      >
                        Open here
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  {loading && currentPath ? (
                    <div className="flex h-[340px] items-center justify-center text-[12px] text-[#706D68]">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#E2765A]" />
                      Reading folders
                    </div>
                  ) : !currentPath ? (
                    <div className="flex h-[340px] flex-col items-center justify-center rounded-[16px] border border-dashed border-white/[0.08] text-center">
                      <FolderOpen className="h-10 w-10 text-white/18" />
                      <div className="mt-3 text-[14px] font-semibold text-white/72">Browse local folders</div>
                      <div className="mt-1 max-w-xs text-[12px] leading-5 text-[#706D68]">Choose a quick access folder, paste a path, or open the native folder picker.</div>
                    </div>
                  ) : folders.length === 0 ? (
                    <div className="flex h-[340px] flex-col items-center justify-center rounded-[16px] border border-dashed border-white/[0.08] text-center">
                      <CheckCircle2 className="h-9 w-9 text-emerald-300/75" />
                      <div className="mt-3 text-[14px] font-semibold text-white/72">This folder can be opened</div>
                      <button
                        type="button"
                        onClick={() => openWorkspace(currentPath)}
                        className="mt-4 rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-black transition hover:bg-[#E8E6E3] active:scale-95"
                      >
                        Open this project
                      </button>
                    </div>
                  ) : (
                    <div className="max-h-[390px] overflow-y-auto pr-1">
                      {folders.map(folder => (
                        <div key={folder.path} className="group flex items-center gap-2 rounded-[13px] px-2 py-2 transition hover:bg-white/[0.045]">
                          <button
                            type="button"
                            onClick={() => browseTo(folder.path)}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          >
                            <Folder className={`h-4 w-4 shrink-0 ${folder.isProject ? 'text-[#E2765A]' : 'text-white/35'}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] font-semibold text-white/80">{folder.name}</span>
                              <span className="block truncate font-mono text-[10px] text-[#706D68]">{folder.path}</span>
                            </span>
                            {folder.isProject && <span className="rounded-full border border-[#E2765A]/20 bg-[#E2765A]/10 px-2 py-0.5 text-[10px] font-semibold text-[#E2765A]">project</span>}
                          </button>
                          <button
                            type="button"
                            onClick={() => openWorkspace(folder.path)}
                            className="flex h-7 items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 text-[10px] font-semibold text-white/55 opacity-0 transition hover:bg-white/[0.08] hover:text-white group-hover:opacity-100"
                          >
                            Open
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,430px)_minmax(0,1fr)]">
                <div className="rounded-[18px] border border-white/[0.06] bg-[#101010]/82 p-4">
                  <label className="block">
                    <span className="text-[12px] font-semibold text-[#A3A19E]">Parent folder</span>
                    <div className="mt-2 flex items-center gap-2 rounded-[14px] border border-white/[0.08] bg-[#141414] px-3 py-2.5">
                      <FolderOpen className="h-4 w-4 shrink-0 text-white/35" />
                      <input
                        value={createParent}
                        onChange={event => setCreateParent(event.target.value)}
                        placeholder="C:\\Harshil projects"
                        className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-white outline-none placeholder:text-white/22"
                      />
                    </div>
                  </label>
                  <label className="mt-4 block">
                    <span className="text-[12px] font-semibold text-[#A3A19E]">Project name</span>
                    <div className="mt-2 flex items-center gap-2 rounded-[14px] border border-white/[0.08] bg-[#141414] px-3 py-2.5">
                      <Wand2 className="h-4 w-4 shrink-0 text-emerald-300/70" />
                      <input
                        value={createName}
                        onChange={event => setCreateName(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') createProject();
                        }}
                        placeholder="my-new-agent-app"
                        className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-white outline-none placeholder:text-white/22"
                      />
                    </div>
                  </label>
                  {createError && (
                    <div className="mt-3 rounded-[12px] border border-red-400/18 bg-red-400/10 px-3 py-2 text-[12px] text-red-200">{createError}</div>
                  )}
                  <button
                    type="button"
                    onClick={createProject}
                    disabled={!createParent.trim() || !createName.trim() || creating}
                    className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-white text-[13px] font-semibold text-black transition hover:bg-[#E8E6E3] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
                    Create and open
                  </button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { title: 'Clean workspace', desc: 'Creates a folder only; the code agent can scaffold the stack you ask for next.', icon: Sparkles },
                    { title: 'Immediate handoff', desc: 'After creation, the project opens directly inside EterX Code.', icon: ArrowRight },
                    { title: 'Local-first', desc: 'Your project stays on this machine unless your agent deploys or pushes it.', icon: ShieldCheck },
                    { title: 'Deep work ready', desc: 'Use chat, terminal, file editing, review, and build loops in one place.', icon: Terminal },
                  ].map(item => (
                    <div key={item.title} className="rounded-[18px] border border-white/[0.06] bg-[#101010]/82 p-4">
                      <item.icon className="h-5 w-5 text-[#E2765A]" />
                      <h3 className="mt-3 text-[13px] font-semibold text-white">{item.title}</h3>
                      <p className="mt-2 text-[12px] leading-5 text-[#8C8A88]">{item.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <aside className="flex flex-col gap-4">
            <section className="rounded-[24px] border border-white/[0.075] bg-[#0B0B0B]/82 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-[15px] font-semibold text-white">Previous projects</h2>
                  <p className="mt-1 text-[11px] text-[#706D68]">Quickly resume recent code work.</p>
                </div>
                <History className="h-4 w-4 text-white/35" />
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-[14px] border border-white/[0.08] bg-[#141414] px-3 py-2">
                <Search className="h-3.5 w-3.5 shrink-0 text-white/32" />
                <input
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Search projects..."
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-white/22"
                />
              </div>
              <div className="mt-3 flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
                {filteredRecent.length === 0 ? (
                  <div className="rounded-[16px] border border-dashed border-white/[0.08] px-3 py-7 text-center">
                    <FolderOpen className="mx-auto h-8 w-8 text-white/18" />
                    <div className="mt-2 text-[12px] font-semibold text-white/58">No recent projects yet</div>
                    <div className="mt-1 text-[11px] text-[#706D68]">Open or create one to pin it here.</div>
                  </div>
                ) : (
                  filteredRecent.map(project => (
                    <button
                      key={project.path}
                      type="button"
                      onClick={() => openWorkspace(project.path)}
                      className="group flex items-center gap-3 rounded-[15px] border border-white/[0.055] bg-white/[0.025] p-3 text-left transition hover:border-white/[0.11] hover:bg-white/[0.055] active:scale-[0.99]"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#E2765A]/12 text-[#E2765A]">
                        <Folder className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-white">{project.name}</span>
                        <span className="block truncate font-mono text-[10px] text-[#706D68]">{project.path}</span>
                        <span className="mt-1 block text-[10px] text-white/32">{formatOpenedAt(project.openedAt)}</span>
                      </span>
                      <ArrowRight className="h-4 w-4 text-white/25 transition group-hover:text-white/70" />
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-[24px] border border-white/[0.075] bg-[#0B0B0B]/82 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
              <h2 className="text-[15px] font-semibold text-white">What opens next</h2>
              <div className="mt-3 flex flex-col gap-2">
                {[
                  'Full code-agent chat for the selected folder',
                  'Project-aware command shortcuts',
                  'Terminal execution in the project directory',
                  'File read, write, patch, review, and build workflows',
                ].map(item => (
                  <div key={item} className="flex items-start gap-2 rounded-[12px] bg-white/[0.025] px-3 py-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
                    <span className="text-[12px] leading-5 text-[#C9C5BF]">{item}</span>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
};

export default ProjectsView;
