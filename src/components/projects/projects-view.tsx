"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  ChevronRight,
  Coffee,
  Copy,
  File,
  FolderOpen,
  MessageSquare,
  Mic,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  Send,
  Share2,
  Trash2,
} from 'lucide-react';
import { CodeView } from '../code/code-view';

type RecentProject = {
  path: string;
  name: string;
  openedAt: number;
};

type ProjectConversation = {
  id: string;
  title: string;
  createdAt: number;
};

const RECENT_PROJECTS_KEY = 'eterx_recent_projects';
const PROJECT_INSTRUCTIONS_KEY = 'eterx_project_instructions';
const PROJECT_CONVERSATIONS_KEY = 'eterx_project_conversations';
const PROJECT_TITLE_KEY = 'eterx_project_title';

const readJsonArray = <T,>(key: string): T[] => {
  if (typeof window === 'undefined') return [];
  try {
    const saved = localStorage.getItem(key);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const readString = (key: string, fallback = '') => {
  if (typeof window === 'undefined') return fallback;
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
};

const getProjectName = (projectPath: string) =>
  projectPath.split(/[/\\]/).filter(Boolean).pop() || projectPath || 'Project';

const saveRecentProject = (projectPath: string) => {
  if (typeof window === 'undefined' || !projectPath.trim()) return;
  const cleanPath = projectPath.trim();
  const next = [
    { path: cleanPath, name: getProjectName(cleanPath), openedAt: Date.now() },
    ...readJsonArray<RecentProject>(RECENT_PROJECTS_KEY).filter(project => project.path !== cleanPath),
  ].slice(0, 8);
  localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
};

const ProjectMenuButton = ({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`eterx-project-menu-item flex h-12 w-full items-center gap-3 rounded-[14px] px-4 text-left text-[15px] font-semibold transition active:scale-[0.99] ${danger ? 'eterx-project-menu-danger' : ''}`}
  >
    <Icon className="h-5 w-5 shrink-0" strokeWidth={2.05} />
    {label}
  </button>
);

const ProjectPanel = ({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) => (
  <section className="eterx-project-panel overflow-hidden rounded-[18px] border">
    <div className="eterx-project-panel-header flex min-h-[68px] items-center gap-3 border-b px-6">
      <Icon className="h-5 w-5 shrink-0" strokeWidth={2.1} />
      <h2 className="text-[18px] font-semibold tracking-tight">{title}</h2>
    </div>
    {children}
  </section>
);

const SourceRow = ({
  icon: Icon,
  label,
  value,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="eterx-project-source-row group flex h-[44px] w-full items-center gap-3 px-6 text-left transition"
  >
    <Icon className="h-5 w-5 shrink-0 text-[var(--eterx-project-muted)] transition group-hover:text-[var(--eterx-project-text)]" strokeWidth={2.05} />
    <span className="min-w-0 flex-1 truncate text-[17px] font-semibold">{label}</span>
    <span className="text-[17px] font-medium text-[var(--eterx-project-muted)]">{value}</span>
    <ChevronRight className="h-5 w-5 shrink-0 text-[var(--eterx-project-muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--eterx-project-text)]" />
  </button>
);

export const ProjectsView = () => {
  const [workspacePath, setWorkspacePath] = useState('');
  const [projectTitle, setProjectTitle] = useState(() => readString(PROJECT_TITLE_KEY, 'New Workspace'));
  const [instructions, setInstructions] = useState(() => readString(PROJECT_INSTRUCTIONS_KEY));
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() => readJsonArray<RecentProject>(RECENT_PROJECTS_KEY));
  const [conversations, setConversations] = useState<ProjectConversation[]>(() => readJsonArray<ProjectConversation>(PROJECT_CONVERSATIONS_KEY));
  const [inputValue, setInputValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PROJECT_TITLE_KEY, projectTitle);
    } catch { }
  }, [projectTitle]);

  useEffect(() => {
    try {
      localStorage.setItem(PROJECT_INSTRUCTIONS_KEY, instructions);
    } catch { }
  }, [instructions]);

  useEffect(() => {
    try {
      localStorage.setItem(PROJECT_CONVERSATIONS_KEY, JSON.stringify(conversations));
    } catch { }
  }, [conversations]);

  const personalFileCount = workspacePath || recentProjects.length > 0 ? 1 : 0;

  const openWorkspace = useCallback((projectPath: string) => {
    const cleanPath = projectPath.trim();
    if (!cleanPath) return;
    saveRecentProject(cleanPath);
    setRecentProjects(readJsonArray<RecentProject>(RECENT_PROJECTS_KEY));
    setWorkspacePath(cleanPath);
  }, []);

  const openNativeFolderDialog = useCallback(async () => {
    const w = window as any;
    if (w.electronAPI?.selectFolder) {
      const selected = await w.electronAPI.selectFolder();
      if (selected) openWorkspace(selected);
      return;
    }

    const selected = window.prompt('Paste a project folder path');
    if (selected?.trim()) openWorkspace(selected.trim());
  }, [openWorkspace]);

  const changeWorkspace = useCallback((path: string) => {
    if (!path) {
      setWorkspacePath('');
      return;
    }
    openWorkspace(path);
  }, [openWorkspace]);

  const startConversation = useCallback((text?: string) => {
    const title = (text || inputValue).trim();
    if (!title) {
      inputRef.current?.focus();
      return;
    }
    const next = {
      id: `project-conversation-${Date.now()}`,
      title: title.length > 54 ? `${title.slice(0, 51)}...` : title,
      createdAt: Date.now(),
    };
    setConversations(prev => [next, ...prev].slice(0, 12));
    setInputValue('');
  }, [inputValue]);

  const renameProject = useCallback(() => {
    const next = window.prompt('Rename workspace', projectTitle);
    if (next?.trim()) setProjectTitle(next.trim());
    setMenuOpen(false);
  }, [projectTitle]);

  const cloneProject = useCallback(() => {
    setProjectTitle(`${projectTitle} Copy`);
    setMenuOpen(false);
  }, [projectTitle]);

  const shareProject = useCallback(() => {
    navigator.clipboard?.writeText(projectTitle).catch(() => { });
    setMenuOpen(false);
  }, [projectTitle]);

  const removeProject = useCallback(() => {
    setInstructions('');
    setConversations([]);
    setWorkspacePath('');
    setProjectTitle('New Workspace');
    setMenuOpen(false);
  }, []);

  const conversationList = useMemo(
    () => [...conversations].sort((a, b) => b.createdAt - a.createdAt),
    [conversations],
  );

  if (workspacePath) {
    return (
      <div className="eterx-project-code-shell flex h-full min-h-0 flex-1 flex-col">
        <div className="eterx-project-code-header flex h-12 shrink-0 items-center justify-between border-b px-4">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setWorkspacePath('')}
              className="eterx-project-back-button flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] font-semibold transition active:scale-95"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Workspace
            </button>
            <div className="hidden min-w-0 items-center gap-2 sm:flex">
              <FolderOpen className="h-4 w-4 text-[var(--eterx-project-icon)]" />
              <span className="truncate text-[12px] font-medium text-[var(--eterx-project-muted)]">{workspacePath}</span>
            </div>
          </div>
          <span className="hidden rounded-full border border-[var(--eterx-project-success-border)] bg-[var(--eterx-project-success-bg)] px-3 py-1 text-[11px] font-semibold text-[var(--eterx-project-success-text)] md:inline-flex">
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
    <div className="eterx-projects-view flex min-h-0 flex-1 overflow-hidden">
      <aside className="eterx-project-rail flex h-full w-[424px] shrink-0 flex-col border-r">
        <header className="eterx-project-rail-header relative flex h-[76px] shrink-0 items-center justify-between px-8">
          <div className="flex min-w-0 items-center gap-4">
            <Coffee className="h-5 w-5 shrink-0 text-[var(--eterx-project-icon)]" strokeWidth={2.2} />
            <h1 className="truncate text-[22px] font-semibold tracking-tight">{projectTitle}</h1>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMenuOpen(open => !open)}
              className="eterx-project-header-button flex h-9 w-9 items-center justify-center rounded-full transition"
              aria-label="Workspace options"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="eterx-project-header-button flex h-9 w-9 items-center justify-center rounded-full transition"
              aria-label="Toggle workspace panel"
            >
              <PanelRight className="h-5 w-5" />
            </button>
          </div>

          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.98 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="eterx-project-menu absolute right-[54px] top-[64px] z-30 w-[240px] rounded-[22px] border p-2 shadow-2xl"
              >
                <ProjectMenuButton icon={Share2} label="Share" onClick={shareProject} />
                <ProjectMenuButton icon={Pencil} label="Rename" onClick={renameProject} />
                <ProjectMenuButton icon={Copy} label="Clone" onClick={cloneProject} />
                <ProjectMenuButton icon={Trash2} label="Remove" danger onClick={removeProject} />
              </motion.div>
            )}
          </AnimatePresence>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <div className="flex flex-col gap-6">
            <ProjectPanel title="Instructions" icon={Pencil}>
              <textarea
                value={instructions}
                onChange={event => setInstructions(event.target.value)}
                placeholder="Set up instructions for EterX in this project"
                className="eterx-project-instructions min-h-[96px] w-full resize-none px-6 py-5 text-[20px] font-medium italic leading-8 outline-none"
              />
            </ProjectPanel>

            <ProjectPanel title="Sources" icon={Copy}>
              <div className="py-2">
                <SourceRow icon={Copy} label="Connectors" value={0} onClick={() => { }} />
                <SourceRow icon={File} label="Personal files" value={personalFileCount} onClick={openNativeFolderDialog} />
              </div>
            </ProjectPanel>

            <div>
              <h2 className="px-3 text-[20px] font-semibold tracking-tight">Conversations</h2>
              <div className="eterx-project-section-rule mt-4 h-px" />

              {conversationList.length === 0 ? (
                <div className="eterx-project-conversation-empty mt-5 flex h-[148px] flex-col items-center justify-center rounded-[20px] border text-center">
                  <MessageSquare className="h-8 w-8 text-[var(--eterx-project-muted)]" strokeWidth={1.85} />
                  <p className="mt-4 text-[18px] font-semibold text-[var(--eterx-project-muted)]">No conversations yet</p>
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-2">
                  {conversationList.map(conversation => (
                    <button
                      key={conversation.id}
                      type="button"
                      className="eterx-project-conversation-row flex min-h-[44px] items-center gap-3 rounded-[13px] px-3 text-left transition"
                    >
                      <MessageSquare className="h-4 w-4 shrink-0 text-[var(--eterx-project-muted)]" />
                      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{conversation.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>

      <main className="eterx-project-canvas relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="flex max-w-[860px] flex-col items-center"
          >
            <h2 className="text-[24px] font-semibold tracking-tight md:text-[25px]">Start a conversation in this project</h2>
            <p className="mt-5 text-[21px] leading-8 text-[var(--eterx-project-muted)]">
              Projects are a great way to keep your conversations and files in a single place.
            </p>
            <div className="mt-9 flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={() => inputRef.current?.focus()}
                className="eterx-project-suggestion flex h-[60px] items-center justify-center rounded-full border px-7 text-[20px] font-semibold transition active:scale-95"
              >
                Ask a question
              </button>
              <button
                type="button"
                onClick={() => {
                  setInputValue('Help me plan the first task for this project');
                  inputRef.current?.focus();
                }}
                className="eterx-project-suggestion flex h-[60px] items-center justify-center rounded-full border px-7 text-[20px] font-semibold transition active:scale-95"
              >
                Get help with a task
              </button>
            </div>
          </motion.div>
        </div>

        <div className="shrink-0 px-6 pb-10">
          <div className="eterx-project-composer mx-auto flex h-[90px] w-full max-w-[1070px] items-center gap-4 rounded-full border px-6">
            <button
              type="button"
              onClick={openNativeFolderDialog}
              className="eterx-project-composer-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition active:scale-95"
              aria-label="Add project files"
            >
              <Plus className="h-7 w-7" />
            </button>
            <input
              ref={inputRef}
              value={inputValue}
              onChange={event => setInputValue(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') startConversation();
              }}
              placeholder="Ask anything"
              className="min-w-0 flex-1 bg-transparent text-[24px] font-medium outline-none"
            />
            <button type="button" className="eterx-project-speed-button flex h-11 items-center gap-2 rounded-full px-3 text-[20px] font-semibold transition">
              Fast
              <ChevronRight className="h-5 w-5 rotate-90 text-[var(--eterx-project-muted)]" />
            </button>
            <button
              type="button"
              className="eterx-project-composer-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition active:scale-95"
              aria-label="Voice input"
            >
              <Mic className="h-6 w-6" strokeWidth={2.3} />
            </button>
            <button
              type="button"
              onClick={() => startConversation()}
              className="eterx-project-send-button flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full transition active:scale-95"
              aria-label="Send"
            >
              <Send className="h-6 w-6 -rotate-90" strokeWidth={2.25} />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default ProjectsView;
