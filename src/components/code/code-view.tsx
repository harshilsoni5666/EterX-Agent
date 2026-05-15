"use client";

import React, { useState, useEffect, useRef } from 'react';
import { CodeChat } from './code-chat';
import {
  Terminal, GitBranch, FolderOpen,
  Command, ChevronDown, ChevronRight, FolderInput, Zap, Code2,
  Cpu, Shield, Bug, TestTube, Hammer, Plus,
  FileSearch, GitCommit, Eye, Search, ArrowLeft,
  FolderPlus, Home, Folder, Sparkles, Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * Code View — Full AI coding agent with real folder browsing.
 * 
 * Architecture connected to code/ folder:
 *   - code/src/constants/prompts.ts → system prompt patterns
 *   - code/src/tools/ → FileRead, FileWrite, FileEdit, Bash, Grep, Glob
 *   - code/src/commands/ → slash commands (/commit, /review, /fix, etc.)
 *   - code/src/skills/ → bundled skill system
 *   - code/src/context.ts → git status, environment detection
 *   - code/src/QueryEngine.ts → ReAct loop pattern
 */

interface CodeViewProps {
  workspacePath: string;
  onChangeWorkspace: (path: string) => void;
}

interface BrowseFolder {
  name: string;
  path: string;
  isProject?: boolean;
}

// Slash commands mapped from code/src/commands/
const QUICK_COMMANDS = [
  { cmd: '/commit', label: 'Commit', desc: 'Auto-commit', icon: GitCommit, color: 'text-emerald-400' },
  { cmd: '/review', label: 'Review', desc: 'Code review', icon: Eye, color: 'text-blue-400' },
  { cmd: '/fix', label: 'Fix', desc: 'Fix errors', icon: Zap, color: 'text-amber-400' },
  { cmd: '/test', label: 'Test', desc: 'Run tests', icon: TestTube, color: 'text-purple-400' },
  { cmd: '/build', label: 'Build', desc: 'Build project', icon: Hammer, color: 'text-orange-400' },
  { cmd: '/plan', label: 'Plan', desc: 'Plan changes', icon: FileSearch, color: 'text-indigo-400' },
  { cmd: '/analyze', label: 'Analyze', desc: 'Architecture', icon: Search, color: 'text-cyan-400' },
  { cmd: '/security', label: 'Security', desc: 'Security audit', icon: Shield, color: 'text-red-400' },
  { cmd: '/bugs', label: 'Bugs', desc: 'Bug hunt', icon: Bug, color: 'text-rose-400' },
  { cmd: '/diff', label: 'Diff', desc: 'Git diff', icon: GitBranch, color: 'text-teal-400' },
];

export const CodeView: React.FC<CodeViewProps> = ({ workspacePath, onChangeWorkspace }) => {
  const [projectInfo, setProjectInfo] = useState<{ name: string; branch: string }>({ name: '', branch: '' });
  const [showCommands, setShowCommands] = useState(false);

  // Fetch project info when workspace changes
  useEffect(() => {
    if (!workspacePath) return;
    const name = workspacePath.split(/[/\\]/).filter(Boolean).pop() || 'Project';
    setProjectInfo(prev => ({ ...prev, name }));

    fetch('/api/code/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'git branch --show-current', cwd: workspacePath }),
    }).then(r => r.json()).then(data => {
      if (data.stdout?.trim()) setProjectInfo(prev => ({ ...prev, branch: data.stdout.trim() }));
    }).catch(() => {});
  }, [workspacePath]);

  // ─── Folder Picker ───
  if (!workspacePath) {
    return <FolderPicker onSelect={onChangeWorkspace} />;
  }

  // ─── Main Coding Agent ───
  return (
    <div className="flex flex-col h-full bg-[#050505] text-[#E8E6E3] overflow-hidden">
      {/* Top Bar */}
      <div className="h-11 flex items-center justify-between px-4 border-b border-white/[0.06] bg-[#080808] shrink-0 z-10 [-webkit-app-region:drag]">
        <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#E2765A] to-[#C85A3E] flex items-center justify-center shadow-sm">
              <Terminal className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-[12px] font-semibold text-white/90 tracking-tight">EterX Code</span>
          </div>

          <div className="h-4 w-px bg-white/8" />

          <button
            onClick={() => onChangeWorkspace('')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[11px] text-[#A3A19E] hover:text-white transition-all group"
            title="Change project folder"
          >
            <FolderOpen className="w-3 h-3 text-[#E2765A]/70 group-hover:text-[#E2765A]" />
            <span className="truncate max-w-[160px] font-medium">{projectInfo.name}</span>
            <ChevronDown className="w-3 h-3 text-[#555350]" />
          </button>

          {projectInfo.branch && (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/8 border border-emerald-500/10 text-[10px]">
              <GitBranch className="w-3 h-3 text-emerald-400/70" />
              <span className="text-emerald-400/80 font-mono">{projectInfo.branch}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 [-webkit-app-region:no-drag]">
          <button
            onClick={() => setShowCommands(!showCommands)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
              showCommands
                ? 'bg-[#E2765A]/12 text-[#E2765A] border border-[#E2765A]/20'
                : 'text-[#8C8A88] hover:text-white hover:bg-white/5 border border-transparent'
            }`}
          >
            <Command className="w-3 h-3" />
            <span className="hidden sm:inline">Commands</span>
          </button>
        </div>
      </div>

      {/* Quick Commands */}
      <AnimatePresence>
        {showCommands && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="border-b border-white/[0.06] bg-[#080808] overflow-hidden"
          >
            <div className="px-4 py-3">
              <div className="text-[10px] text-[#555350] uppercase tracking-wider mb-2 font-medium">Slash Commands</div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                {QUICK_COMMANDS.map(({ cmd, label, desc, icon: Icon, color }) => (
                  <button
                    key={cmd}
                    onClick={() => {
                      setShowCommands(false);
                      window.dispatchEvent(new CustomEvent('eterx-code-command', { detail: cmd }));
                    }}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/[0.04] bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/[0.08] transition-all group text-left"
                  >
                    <Icon className={`w-3.5 h-3.5 ${color} opacity-60 group-hover:opacity-100 shrink-0`} />
                    <div className="min-w-0">
                      <div className="text-[11px] text-[#C8C6C3] font-medium truncate">{label}</div>
                      <div className="text-[9px] text-[#555350] truncate">{desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat — full screen */}
      <div className="flex-1 overflow-hidden">
        <CodeChat
          workspacePath={workspacePath}
          activeFile={null}
          onClose={() => {}}
        />
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════
// FOLDER PICKER — Real filesystem browsing + New Project
// ═══════════════════════════════════════════════════════

const FolderPicker: React.FC<{ onSelect: (path: string) => void }> = ({ onSelect }) => {
  const [roots, setRoots] = useState<BrowseFolder[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [folders, setFolders] = useState<BrowseFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [manualInput, setManualInput] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newParentPath, setNewParentPath] = useState('');
  const [isCurrentProject, setIsCurrentProject] = useState(false);

  // Load roots on mount
  useEffect(() => {
    setLoading(true);
    fetch('/api/code/browse')
      .then(r => r.json())
      .then(data => {
        if (data.roots) setRoots(data.roots);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Browse into a folder
  const browseTo = async (folderPath: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/code/browse?path=${encodeURIComponent(folderPath)}`);
      const data = await res.json();
      if (data.folders) {
        setCurrentPath(data.current || folderPath);
        setParentPath(data.parent || null);
        setFolders(data.folders);
        setIsCurrentProject(data.isProject || false);
        setManualInput(data.current || folderPath);
      }
    } catch { }
    setLoading(false);
  };

  // Go back
  const goUp = () => {
    if (parentPath) browseTo(parentPath);
    else { setCurrentPath(''); setFolders([]); setParentPath(null); }
  };

  // Create new project
  const createNewProject = async () => {
    if (!newParentPath || !newFolderName) return;
    try {
      const res = await fetch('/api/code/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath: newParentPath, folderName: newFolderName }),
      });
      const data = await res.json();
      if (data.path) {
        onSelect(data.path);
      }
    } catch { }
  };

  return (
    <div className="flex flex-col h-full bg-[#050505] text-[#E8E6E3]">
      {/* Header */}
      <div className="h-11 flex items-center px-4 border-b border-white/[0.06] bg-[#080808] shrink-0 [-webkit-app-region:drag]">
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#E2765A] to-[#C85A3E] flex items-center justify-center">
            <Terminal className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-[12px] font-semibold text-white/90">EterX Code</span>
          <div className="h-4 w-px bg-white/8 mx-1" />
          <span className="text-[11px] text-[#555350]">Select Project</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-lg mx-auto px-6 py-8">
          {/* Logo section */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center mb-8"
          >
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#E2765A] via-[#E2765A]/80 to-[#C85A3E] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[#E2765A]/20">
              <Terminal className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-[20px] font-bold text-white mb-1.5">Open a Project</h1>
            <p className="text-[12px] text-[#8C8A88]">Browse to any folder or create a new project</p>
          </motion.div>

          {/* Native Folder Dialog (Electron) */}
          <button
            onClick={async () => {
              const w = window as any;
              if (w.electronAPI?.selectFolder) {
                // Use native OS folder dialog via Electron IPC
                const selected = await w.electronAPI.selectFolder();
                if (selected) onSelect(selected);
              } else {
                // Fallback: prompt for path
                const path = prompt('Enter project folder path:');
                if (path?.trim()) onSelect(path.trim());
              }
            }}
            className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-xl bg-[#E2765A] text-white font-medium text-[13px] hover:bg-[#D2664A] active:scale-[0.98] transition-all shadow-lg shadow-[#E2765A]/20 mb-4"
          >
            <FolderOpen className="w-5 h-5" />
            Browse for Folder
          </button>

          {/* Manual path input */}
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 flex items-center gap-2 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 focus-within:border-[#E2765A]/30 transition-all">
              <FolderOpen className="w-4 h-4 text-[#555350] shrink-0" />
              <input
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && manualInput.trim()) {
                    onSelect(manualInput.trim());
                  }
                }}
                placeholder="Paste folder path or browse below..."
                className="flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-[#555350]"
              />
            </div>
            <button
              onClick={() => manualInput.trim() && onSelect(manualInput.trim())}
              disabled={!manualInput.trim()}
              className={`px-4 py-2.5 rounded-xl text-[12px] font-medium transition-all shrink-0 ${
                manualInput.trim()
                  ? 'bg-[#E2765A] text-white hover:bg-[#D2664A] active:scale-95'
                  : 'bg-white/5 text-[#555350]'
              }`}
            >
              Open
            </button>
          </div>

          {/* Create New / New Project button */}
          <div className="flex gap-2 mb-5">
            <button
              onClick={() => setShowNewProject(!showNewProject)}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[12px] font-medium border transition-all ${
                showNewProject
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                  : 'bg-white/[0.03] border-white/[0.06] text-[#A3A19E] hover:bg-white/[0.06] hover:text-white'
              }`}
            >
              <FolderPlus className="w-4 h-4" />
              Start New Project
            </button>
          </div>

          {/* New Project Form */}
          <AnimatePresence>
            {showNewProject && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden mb-5"
              >
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-3">
                  <input
                    type="text"
                    value={newParentPath}
                    onChange={(e) => setNewParentPath(e.target.value)}
                    placeholder="Parent folder (e.g. C:\Projects)"
                    className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-[12px] text-white outline-none placeholder:text-[#555350] focus:border-emerald-500/30"
                  />
                  <input
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="New project name (e.g. my-app)"
                    className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-[12px] text-white outline-none placeholder:text-[#555350] focus:border-emerald-500/30"
                  />
                  <button
                    onClick={createNewProject}
                    disabled={!newParentPath.trim() || !newFolderName.trim()}
                    className="w-full py-2.5 rounded-lg text-[12px] font-medium bg-emerald-500 text-white hover:bg-emerald-600 disabled:bg-white/5 disabled:text-[#555350] transition-all"
                  >
                    Create & Open
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-[#E2765A] animate-spin" />
            </div>
          )}

          {/* Root folders */}
          {!loading && !currentPath && roots.length > 0 && (
            <div>
              <div className="text-[10px] text-[#555350] uppercase tracking-wider mb-2 font-medium px-1">Quick Access</div>
              <div className="space-y-1">
                {roots.map(root => (
                  <button
                    key={root.path}
                    onClick={() => browseTo(root.path)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.05] text-left transition-all group"
                  >
                    <Home className="w-4 h-4 text-[#E2765A]/60 group-hover:text-[#E2765A] shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-[#C8C6C3] font-medium truncate">{root.name}</div>
                      <div className="text-[10px] text-[#555350] truncate font-mono">{root.path}</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#333] group-hover:text-[#8C8A88] shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Browsing folders */}
          {!loading && currentPath && (
            <div>
              {/* Current path + back */}
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={goUp}
                  className="p-1.5 rounded-lg hover:bg-white/5 text-[#8C8A88] hover:text-white transition-all"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="text-[11px] text-[#8C8A88] font-mono truncate flex-1">{currentPath}</div>
                {isCurrentProject && (
                  <button
                    onClick={() => onSelect(currentPath)}
                    className="px-3 py-1.5 rounded-lg bg-[#E2765A] text-white text-[11px] font-medium hover:bg-[#D2664A] transition-all shrink-0"
                  >
                    Open Here
                  </button>
                )}
              </div>

              {/* Folder list */}
              <div className="space-y-0.5 max-h-[350px] overflow-y-auto custom-scrollbar">
                {folders.length === 0 ? (
                  <div className="text-center py-6">
                    <FolderOpen className="w-8 h-8 text-[#333] mx-auto mb-2" />
                    <p className="text-[12px] text-[#555350]">No subfolders</p>
                    <button
                      onClick={() => onSelect(currentPath)}
                      className="mt-3 px-4 py-2 rounded-lg bg-[#E2765A] text-white text-[11px] font-medium hover:bg-[#D2664A] transition-all"
                    >
                      Open This Folder
                    </button>
                  </div>
                ) : (
                  folders.map(folder => (
                    <div
                      key={folder.path}
                      className="flex items-center gap-2 group"
                    >
                      <button
                        onClick={() => browseTo(folder.path)}
                        className="flex-1 flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/[0.05] text-left transition-all min-w-0"
                      >
                        <Folder className={`w-4 h-4 shrink-0 ${folder.isProject ? 'text-[#E2765A]' : 'text-[#555350]'}`} />
                        <span className="text-[12px] text-[#C8C6C3] truncate">{folder.name}</span>
                        {folder.isProject && (
                          <span className="text-[9px] bg-[#E2765A]/10 text-[#E2765A] px-1.5 py-0.5 rounded-full border border-[#E2765A]/15 shrink-0">project</span>
                        )}
                      </button>
                      {folder.isProject && (
                        <button
                          onClick={() => onSelect(folder.path)}
                          className="opacity-0 group-hover:opacity-100 px-2 py-1 rounded-lg bg-[#E2765A]/15 text-[#E2765A] text-[10px] font-medium hover:bg-[#E2765A]/25 transition-all shrink-0"
                        >
                          Open
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Features */}
          <div className="mt-8 grid grid-cols-3 gap-2">
            {[
              { icon: Code2, label: 'Read & Edit', sub: 'Any files' },
              { icon: Terminal, label: 'Shell Access', sub: 'Run anything' },
              { icon: Cpu, label: 'AI Agent', sub: 'Autonomous' },
            ].map(({ icon: Icon, label, sub }) => (
              <div key={label} className="flex flex-col items-center py-3 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                <Icon className="w-4 h-4 text-[#E2765A]/50 mb-1" />
                <span className="text-[10px] text-[#A3A19E] font-medium">{label}</span>
                <span className="text-[9px] text-[#555350]">{sub}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
