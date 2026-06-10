"use client";

import React, { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { 
  Play, Pause, RotateCcw, Send, Terminal as TerminalIcon, Globe, 
  Settings, Mic, Plus, Search, CornerDownLeft, ChevronRight, 
  ChevronDown, Check, Copy, ExternalLink, Maximize2, Minimize2, 
  Folder, FolderOpen, ShieldAlert, Sparkles, Undo, Eye, 
  CheckCircle2, GitCommit, GitPullRequest, Laptop, Smartphone,
  Info, AlertTriangle, ArrowLeft, RefreshCw, X, FileCode2,
  Trash2, Sliders, Volume2, ShieldCheck, Cpu
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { FilePanelProvider, useGlobalFilePanel } from '../../contexts/FilePanelContext';

const IdePanel = dynamic(
  () => import('../../components/chat/file-panel').then(mod => mod.IdePanel),
  { ssr: false }
);

// Mock Diff Content for Files changed in Scenario 1
const CHAT_FEED_DIFF = [
  { type: 'context', oldLine: 194, newLine: 194, content: '  const timerRef = useRef<ReturnType<typeof setTimeout>>();' },
  { type: 'removed', oldLine: 195, newLine: null, content: '- const UserMessageActions = ({ text, onEdit }: { text: string; onEdit?: () => void; }) => {' },
  { type: 'removed', oldLine: 196, newLine: null, content: '-   const [copied, setCopied] = useState(false);' },
  { type: 'removed', oldLine: 197, newLine: null, content: '-   return (' },
  { type: 'removed', oldLine: 198, newLine: null, content: '-     <button className="square-button" onClick={onEdit}>Edit</button>' },
  { type: 'removed', oldLine: 199, newLine: null, content: '-   );' },
  { type: 'removed', oldLine: 200, newLine: null, content: '- };' },
  { type: 'added', oldLine: null, newLine: 195, content: '+ const UserMessageActionButton = ({' },
  { type: 'added', oldLine: null, newLine: 196, content: '+   label,' },
  { type: 'added', oldLine: null, newLine: 197, content: '+   onClick,' },
  { type: 'added', oldLine: null, newLine: 198, content: '+   children,' },
  { type: 'added', oldLine: null, newLine: 199, content: '+ }: {' },
  { type: 'added', oldLine: null, newLine: 200, content: '+   label: string;' },
  { type: 'added', oldLine: null, newLine: 201, content: '+   onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;' },
  { type: 'added', oldLine: null, newLine: 202, content: '+   children: React.ReactNode;' },
  { type: 'added', oldLine: null, newLine: 203, content: '+ }) => {' },
  { type: 'added', oldLine: null, newLine: 204, content: '+   const [rippleKey, setRippleKey] = useState(0);' },
  { type: 'added', oldLine: null, newLine: 205, content: '+   useEffect(() => () => clearTimeout(timerRef.current), []);' },
  { type: 'added', oldLine: null, newLine: 206, content: '+   return (' },
  { type: 'added', oldLine: null, newLine: 207, content: '+     <button' },
  { type: 'added', oldLine: null, newLine: 208, content: '+       type="button"' },
  { type: 'added', oldLine: null, newLine: 209, content: '+       className="relative flex items-center justify-center overflow-hidden rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-bold text-[#E8E6E3] backdrop-blur-sm transition-all hover:bg-white/[0.08] active:scale-[0.98]"' },
  { type: 'added', oldLine: null, newLine: 210, content: '+       onClick={(event) => {' },
  { type: 'added', oldLine: null, newLine: 211, content: '+         setRippleKey(key => key + 1);' },
  { type: 'added', oldLine: null, newLine: 212, content: '+         onClick(event);' },
  { type: 'added', oldLine: null, newLine: 213, content: '+       }}' },
  { type: 'added', oldLine: null, newLine: 214, content: '+     >' },
  { type: 'added', oldLine: null, newLine: 215, content: '+       {children}' },
  { type: 'added', oldLine: null, newLine: 216, content: '+     </button>' },
  { type: 'added', oldLine: null, newLine: 217, content: '+   );' },
  { type: 'added', oldLine: null, newLine: 218, content: '+ };' },
  { type: 'context', oldLine: 201, newLine: 219, content: '  // Rest of the chat bubble actions component' },
];

const CHAT_INPUT_DIFF = [
  { type: 'context', oldLine: 45, newLine: 45, content: 'export const ChatInput = ({ onSend }: ChatInputProps) => {' },
  { type: 'removed', oldLine: 46, newLine: null, content: '-   const [input, setInput] = useState("");' },
  { type: 'removed', oldLine: 47, newLine: null, content: '-   return <input value={input} onChange={e => setInput(e.target.value)} />;' },
  { type: 'added', oldLine: null, newLine: 46, content: '+   const [input, setInput] = useState("");' },
  { type: 'added', oldLine: null, newLine: 47, content: '+   const [isRecording, setIsRecording] = useState(false);' },
  { type: 'added', oldLine: null, newLine: 48, content: '+   return (' },
  { type: 'added', oldLine: null, newLine: 49, content: '+     <div className="relative flex items-center rounded-[20px] border border-white/[0.08] bg-[#141414] p-2 focus-within:border-[#E2765A]/50">' },
  { type: 'added', oldLine: null, newLine: 50, content: '+       {/* Modern inputs and animated controls */}' },
  { type: 'added', oldLine: null, newLine: 51, content: '+     </div>' },
  { type: 'added', oldLine: null, newLine: 52, content: '+   );' },
  { type: 'context', oldLine: 48, newLine: 53, content: '};' },
];

// Simulator coding scenarios
const SCENARIOS = [
  {
    id: 'modernize-ui',
    name: 'Build Webiste Mdeorn Sophsivted',
    description: 'Updates active chat components with custom glassmorphism containers and round buttons.',
    steps: [
      {
        title: 'Project Analysis',
        detail: 'Scanning workspace to locate components of interest.',
        logs: [
          'Initializing deep scan of codebase layout...',
          'Found chat layout files: chat-feed.tsx, chat-input.tsx',
          'Scanning imports and theme styles: globals.css'
        ],
        command: 'find src/components/ -name "*chat*"',
        statusText: 'Scanning workspace structure...',
        statusFile: 'index.html'
      },
      {
        title: 'Inspecting Components',
        detail: 'Reading file headers and identifying action buttons.',
        logs: [
          'Opening src/components/chat/chat-feed.tsx',
          'Target line identified: UserMessageActions on line 195.',
          'Opening src/components/layout/chat-input.tsx'
        ],
        command: 'head -n 25 src/components/chat/chat-feed.tsx',
        statusText: 'Reading index.html limited drops and cart drawer',
        statusFile: 'index.html'
      },
      {
        title: 'Refactoring Component Code',
        detail: 'Generating file diff chunks to modernization system.',
        logs: [
          'Generating Replacement Chunks for chat-feed.tsx...',
          'Replacing square glyphs with rounded micro-interaction borders.',
          'Injecting CSS classes for ripple rippleKey animations.'
        ],
        command: 'git diff src/components/chat/chat-feed.tsx',
        filesChanged: [
          { filepath: 'src/components/chat/chat-feed.tsx', name: 'chat-feed.tsx', added: 47, removed: 21, diff: CHAT_FEED_DIFF },
          { filepath: 'src/components/layout/chat-input.tsx', name: 'chat-input.tsx', added: 15, removed: 13, diff: CHAT_INPUT_DIFF }
        ],
        statusText: 'Refactoring component UI layout and button selectors',
        statusFile: 'chat-feed.tsx'
      },
      {
        title: 'Verifying compilation',
        detail: 'Running test bundles and validating build.',
        logs: [
          'TypeScript compiler checking noEmit...',
          'Next.js dev bundle building...',
          '✓ Compiled successfully. 0 lint issues.',
          '✓ Component tests passed. All styles resolved.'
        ],
        command: 'npx tsc --noEmit && npm run dev',
        statusText: 'Verifying compilation and styles bundles checks',
        statusFile: 'chat-input.tsx'
      },
      {
        title: 'Task Completed',
        detail: 'All updates applied. Ready for review.',
        logs: [
          'Saved code workspace changes.',
          'Simulation process finished.'
        ],
        isFinal: true,
        statusText: 'Task completed. Ready for preview',
        statusFile: 'chat-feed.tsx'
      }
    ]
  },
  {
    id: 'optimize-orchestrator',
    name: 'Optimize Parallel Orchestrator',
    description: 'Fixes parallel subagent callbacks latency and throttles duplicate messages.',
    steps: [
      {
        title: 'Trace analysis',
        detail: 'Searching logs to verify socket latency spikes.',
        logs: [
          'Opening system_generated/logs/transcript.jsonl...',
          'Identified subagent socket callbacks delay: ~140ms.',
          'Scanning handler hooks inside sub_agent.ts'
        ],
        command: 'grep "latency" logs/transcript.jsonl',
        statusText: 'Analyzing transcript logs for socket latency spikes',
        statusFile: 'sub_agent.ts'
      },
      {
        title: 'Updating Socket Handlers',
        detail: 'Applying throttling checks on redundant subagent tasks.',
        logs: [
          'Applying message debounce mechanism inside src/lib/agent/roles/sub_agent.ts',
          'Added debounce limit: 50ms'
        ],
        command: 'git diff src/lib/agent/roles/sub_agent.ts',
        filesChanged: [
          {
            filepath: 'src/lib/agent/roles/sub_agent.ts',
            name: 'sub_agent.ts',
            added: 12,
            removed: 4,
            diff: [
              { type: 'context', oldLine: 120, newLine: 120, content: 'export const subagentCallback = () => {' },
              { type: 'removed', oldLine: 121, newLine: null, content: '-   triggerSocket();' },
              { type: 'added', oldLine: null, newLine: 121, content: '+   if (timerRef.current) return;' },
              { type: 'added', oldLine: null, newLine: 122, content: '+   timerRef.current = setTimeout(() => { triggerSocket(); }, 50);' },
              { type: 'context', oldLine: 122, newLine: 123, content: '};' }
            ]
          }
        ],
        statusText: 'Implementing message debounce mechanism inside handler',
        statusFile: 'sub_agent.ts'
      },
      {
        title: 'Verifying optimization',
        detail: 'Measuring benchmark response cycles.',
        logs: [
          'Benchmarking agent sub_agent.ts output...',
          '✓ latency decreased by 45%',
          '✓ 0 compilation issues'
        ],
        command: 'node scripts/test-subagents.js',
        statusText: 'Benchmarking parallel orchestration response triggers',
        statusFile: 'sub_agent.ts'
      },
      {
        title: 'Finished',
        detail: 'Optimization applied successfully.',
        logs: [
          'Process completed. Saved optimization code.'
        ],
        isFinal: true,
        statusText: 'Optimization checks completed successfully',
        statusFile: 'sub_agent.ts'
      }
    ]
  }
];

export default function ModernDashboard() {
  return (
    <FilePanelProvider>
      <ModernDashboardContent />
    </FilePanelProvider>
  );
}

function ModernDashboardContent() {
  const { openFiles, openPanel, clearPanels, setReviewFiles } = useGlobalFilePanel();
  const [model, setModel] = useState('gemini-3.5-flash');
  const [thinkingLevel, setThinkingLevel] = useState(65); // Slider value
  const [activeTab, setActiveTab] = useState<'review' | 'google' | 'terminal' | 'chat'>('review');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [chatInput, setChatInput] = useState('');
  
  // Custom Action Status (shown in header status bar)
  const [statusText, setStatusText] = useState('Reading index.html limited drops and cart drawer');
  const [statusFile, setStatusFile] = useState('index.html');
  
  // Simulation States
  const [currentScenario, setCurrentScenario] = useState(SCENARIOS[0]);
  const [simStepIndex, setSimStepIndex] = useState(-1); // -1 = not started
  const [simRunning, setSimRunning] = useState(false);
  const [filesChanged, setFilesChanged] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<any>(null);
  
  // Custom interactive terminal states
  const [terminalLines, setTerminalLines] = useState<string[]>([
    'EterX Agent OS [Version 1.0.4]',
    'Connected to local sandbox kernel (PID 4821)',
    'Type "help" for a list of available command utilities.',
    ''
  ]);
  const [terminalInput, setTerminalInput] = useState('');
  
  // Google mock browser states
  const [browserUrl, setBrowserUrl] = useState('https://www.google.com');
  const [browserInput, setBrowserInput] = useState('https://www.google.com');
  const [googleSearchQuery, setGoogleSearchQuery] = useState('EterX AI model selection');
  const [showSearchResults, setShowSearchResults] = useState(true);
  const [searchHistory, setSearchHistory] = useState<string[]>(['https://www.google.com']);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Chat Feed Messages
  const [messages, setMessages] = useState<any[]>([
    {
      id: 'msg-init',
      sender: 'agent',
      text: 'Hello Harshil! I am ready to begin our coding workspace updates. Please select an automation scenario or type a request to guide my steps.',
      timestamp: '12:00:05 PM',
      thought: ['Initializing agent loop', 'Loading local workspaces catalog...']
    }
  ]);

  // Terminal Ref
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalLines]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Run next step of simulation
  const advanceSimulation = (stepIdx: number) => {
    if (stepIdx < 0 || stepIdx >= currentScenario.steps.length) {
      setSimRunning(false);
      return;
    }

    const step = currentScenario.steps[stepIdx];
    
    // 1. Add thought trace and logs to terminal
    setTerminalLines(prev => [
      ...prev,
      `eterx-agent:~/workspace$ ${step.command || '# ' + step.title}`,
      ...(step.logs || []),
      ''
    ]);

    // 2. Add message to chat feed
    const thoughts = step.logs ? [...step.logs] : [];
    const newMsg: any = {
      id: `msg-sim-${Date.now()}-${stepIdx}`,
      sender: 'agent',
      text: `### ${step.title}\n${step.detail}`,
      timestamp: new Date().toLocaleTimeString(),
      thought: thoughts
    };

    if (step.filesChanged) {
      newMsg.modifiedFiles = step.filesChanged.map(f => `${f.name} (+${f.added} -${f.removed})`);
      setFilesChanged(step.filesChanged);
      setSelectedFile(step.filesChanged[0]);
      setActiveTab('review'); // Autofocus review tab when files change

      const panelPropsList = step.filesChanged.map(f => ({
        filename: f.name,
        filepath: f.filepath,
        diffLines: f.diff ? f.diff.map((l: any) => ({
          type: l.type as 'added' | 'removed' | 'context',
          content: l.content,
          oldLine: l.oldLine ?? undefined,
          newLine: l.newLine ?? undefined,
        })) : [],
        added: f.added,
        removed: f.removed,
        activeTabMode: 'diff' as const,
      }));
      setReviewFiles(panelPropsList);
      if (panelPropsList.length > 0) {
        openPanel(panelPropsList[0]);
      }
    }

    // Update real-time status texts
    if (step.statusText) setStatusText(step.statusText);
    if (step.statusFile) setStatusFile(step.statusFile);

    if (step.isFinal) {
      newMsg.text += '\n\nWorkspace changes compiled cleanly. Review them in the central code viewer!';
      newMsg.isFinal = true;
      setSimRunning(false);
    }

    setMessages(prev => [...prev, newMsg]);
    setSimStepIndex(stepIdx);
  };

  // Play/Pause simulation loop
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (simRunning) {
      const nextIdx = simStepIndex + 1;
      if (nextIdx < currentScenario.steps.length) {
        interval = setTimeout(() => {
          advanceSimulation(nextIdx);
        }, 3000);
      } else {
        setSimRunning(false);
      }
    }
    return () => clearTimeout(interval);
  }, [simRunning, simStepIndex, currentScenario]);

  const handleStartSim = () => {
    if (simStepIndex >= currentScenario.steps.length - 1) {
      // Reset first
      setSimStepIndex(-1);
      setFilesChanged([]);
      setSelectedFile(null);
      setStatusText('Starting agent task...');
      setStatusFile('index.html');
      setMessages([
        {
          id: `msg-reset-${Date.now()}`,
          sender: 'agent',
          text: `Resetting workspace state. Beginning new execution scenario: **${currentScenario.name}**.`,
          timestamp: new Date().toLocaleTimeString()
        }
      ]);
    }
    setSimRunning(true);
  };

  const handleStepSim = () => {
    const nextIdx = simStepIndex + 1;
    if (nextIdx < currentScenario.steps.length) {
      advanceSimulation(nextIdx);
    }
  };

  const handleResetSim = () => {
    setSimStepIndex(-1);
    setSimRunning(false);
    setFilesChanged([]);
    setSelectedFile(null);
    setStatusText('Reading index.html limited drops and cart drawer');
    setStatusFile('index.html');
    clearPanels();
    setReviewFiles([]);
    setMessages([
      {
        id: `msg-reset-${Date.now()}`,
        sender: 'agent',
        text: 'Sandbox workspace has been restored. Agent is idle.',
        timestamp: new Date().toLocaleTimeString()
      }
    ]);
    setTerminalLines(prev => [...prev, 'eterx-agent:~/workspace$ git checkout . && git clean -fd', 'Restored pristine sandbox state.', '']);
  };

  // Handle manual Chat inputs
  const handleSendChat = () => {
    if (!chatInput.trim()) return;

    const userText = chatInput.trim();
    const newMsg = {
      id: `msg-user-${Date.now()}`,
      sender: 'user',
      text: userText,
      timestamp: new Date().toLocaleTimeString()
    };

    setMessages(prev => [...prev, newMsg]);
    setChatInput('');

    // Simulate agent responding dynamically to steering
    setTimeout(() => {
      let replyText = "Understood. I will steer the workspace adjustments based on your comment.";
      let thoughtTraces = ["Steering instruction received", "Evaluating prompts changes..."];

      if (userText.toLowerCase().includes('dark') || userText.toLowerCase().includes('slate')) {
        replyText = "Steering: Modifying theme gradients to deep custom black and slate glassmorphism styles.";
        thoughtTraces.push("Updating globals.css styles rules", "Re-compiling styling bundle");
        setTerminalLines(prev => [...prev, 'eterx-agent:~/workspace$ npm run build:css', 'Applying theme configuration...', '']);
      } else if (userText.toLowerCase().includes('round') || userText.toLowerCase().includes('button')) {
        replyText = "Steering: Increasing border-radius tokens on components button selectors to `12px`.";
        thoughtTraces.push("Adjusting tailwind utility values", "Re-checking chat-feed diff content");
      }

      setMessages(prev => [
        ...prev,
        {
          id: `msg-agent-reply-${Date.now()}`,
          sender: 'agent',
          text: replyText,
          timestamp: new Date().toLocaleTimeString(),
          thought: thoughtTraces
        }
      ]);
    }, 1500);
  };

  // Handle interactive Terminal inputs
  const handleTerminalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!terminalInput.trim()) return;

    const cmd = terminalInput.trim();
    let reply = '';

    if (cmd === 'clear') {
      setTerminalLines([]);
      setTerminalInput('');
      return;
    } else if (cmd === 'help') {
      reply = 'Available commands: help, clear, ls, git status, git diff, npm run dev, eterx status';
    } else if (cmd === 'ls') {
      reply = 'package.json  tsconfig.json  next.config.mjs  src/  public/  node_modules/';
    } else if (cmd === 'git status') {
      if (filesChanged.length > 0) {
        reply = `On branch feature/modernize-chat\nChanges not staged for commit:\n${filesChanged.map(f => `  modified:   ${f.filepath}`).join('\n')}\n\nno changes added to commit (use "git add" and/or "git commit -a")`;
      } else {
        reply = 'On branch feature/modernize-chat\nnothing to commit, working tree clean';
      }
    } else if (cmd === 'git diff') {
      if (selectedFile) {
        reply = `diff --git a/${selectedFile.filepath} b/${selectedFile.filepath}\nindex 5fa2b..e8c1d 100644\n--- a/${selectedFile.filepath}\n+++ b/${selectedFile.filepath}\n` + 
          selectedFile.diff.map((l: any) => `${l.content}`).join('\n');
      } else {
        reply = 'No current workspace differences to display.';
      }
    } else if (cmd === 'npm run dev') {
      reply = '> EterX@0.1.0 dev\n> next dev\n\n▲ Next.js 14.1.4\n- Local: http://localhost:3000\n- Env local values loaded\n✓ Ready in 840ms';
    } else {
      reply = `sh: command not found: ${cmd.split(' ')[0]}`;
    }

    setTerminalLines(prev => [
      ...prev,
      `eterx-agent:~/workspace$ ${cmd}`,
      reply,
      ''
    ]);
    setTerminalInput('');
  };

  // Handle interactive Google browser navigation
  const handleBrowserGo = () => {
    if (!browserInput.trim()) return;
    setBrowserUrl(browserInput);
    if (browserInput.includes('google.com') || browserInput.includes('search')) {
      setShowSearchResults(true);
    } else {
      setShowSearchResults(false);
    }
  };

  const handleSearchClick = (url: string) => {
    setBrowserInput(url);
    setBrowserUrl(url);
    setShowSearchResults(false);
  };

  // Git committing & PR flow
  const handleCommitPush = () => {
    alert("Sandbox: Committing files changes to branch and pushing to Github remote repository...");
    setTerminalLines(prev => [
      ...prev,
      'eterx-agent:~/workspace$ git add . && git commit -m "feat: modernize chat UI components" && git push origin feature/modernize-chat',
      '✓ Committed and pushed to remote origin repository.',
      ''
    ]);
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#050505] text-[#E8E6E3] font-sans antialiased selection:bg-[#E2765A]/25">
      
      {/* ── HEADER NAVIGATION PANEL (MATCHING SCREENSHOT) ── */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.08] bg-[#0A0A0C] px-4 shadow-sm z-50">
        
        {/* Left: Sidebar Toggle & Dropdown Scenario Selection */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(s => !s)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-[#141416] text-[#8C8984] hover:text-white hover:bg-white/[0.06] transition-colors shadow-sm"
            title="Toggle Left Sidebar"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-[18px] h-[18px]">
              <rect x="3" y="3" width="18" height="18" rx="5.5" />
              <path d="M9 3v18" />
            </svg>
          </button>

          <div className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-[#141416] px-3 py-1.5 shadow-sm">
            <select
              value={currentScenario.id}
              onChange={(e) => {
                const selected = SCENARIOS.find(s => s.id === e.target.value);
                if (selected) {
                  setCurrentScenario(selected);
                  setSimStepIndex(-1);
                  setFilesChanged([]);
                  setSelectedFile(null);
                  setStatusText(selected.steps[0]?.statusText || 'Idle');
                  setStatusFile(selected.steps[0]?.statusFile || 'index.html');
                }
              }}
              className="bg-transparent text-[13px] font-bold text-white outline-none cursor-pointer hover:text-white"
            >
              {SCENARIOS.map(s => (
                <option key={s.id} value={s.id} className="bg-[#111] text-[#E8E6E3]">{s.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Center: Simulator Control Panel */}
        <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1 shadow-sm">
          <Cpu className="w-3.5 h-3.5 text-[#E2765A] animate-pulse" />
          <span className="text-[11px] font-mono text-[#8C8A87] font-semibold uppercase">SANDBOX RUNNER:</span>
          
          <button
            onClick={handleStartSim}
            className={`flex items-center justify-center rounded-lg h-7 px-2.5 text-[11px] font-bold transition-all ${
              simRunning
                ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400'
                : 'bg-[#E2765A] text-white hover:bg-[#F2866A] shadow-md'
            }`}
          >
            {simRunning ? (
              <>
                <Pause className="w-3 h-3 mr-1" fill="currentColor" />
                Running...
              </>
            ) : (
              <>
                <Play className="w-3 h-3 mr-1" fill="currentColor" />
                Start Agent
              </>
            )}
          </button>
          
          <button
            onClick={handleStepSim}
            disabled={simRunning || simStepIndex >= currentScenario.steps.length - 1}
            className="flex items-center justify-center rounded-lg h-7 w-7 border border-white/[0.08] text-[#A8A5A0] hover:text-white hover:bg-white/[0.05] disabled:opacity-40 transition-colors"
            title="Step Forward"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          
          <button
            onClick={handleResetSim}
            className="flex items-center justify-center rounded-lg h-7 w-7 border border-white/[0.08] text-[#A8A5A0] hover:text-white hover:bg-white/[0.05] transition-colors"
            title="Reset Sandbox Workspace"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Right: PREVIEW Button & Right Sidebar Toggle */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveTab('google')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11.5px] font-bold transition-all shadow-sm ${
              activeTab === 'google'
                ? 'bg-[#E2765A]/10 border-[#E2765A]/30 text-[#E2765A]'
                : 'bg-white/[0.02] border-white/[0.08] text-[#8C8A87] hover:text-white hover:bg-white/[0.05]'
            }`}
          >
            <Laptop className="w-3.5 h-3.5" />
            <span>PREVIEW</span>
          </button>

          <button
            onClick={() => setRightSidebarOpen(s => !s)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-[#141416] text-[#8C8984] hover:text-white hover:bg-white/[0.06] transition-colors shadow-sm"
            title="Toggle Right Sidebar"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-[18px] h-[18px]">
              <rect x="3" y="3" width="18" height="18" rx="5.5" />
              <path d="M15 3v18" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── AGENT WORKSPACE STATUS SUB-HEADER (FROM SCREENSHOT) ── */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#0E0E12] px-4 py-1.5 text-[12px] font-medium text-[#A8A5A0] z-40">
        <div className="flex items-center gap-2">
          <FileCode2 className="w-3.5 h-3.5 text-[#E2765A]" />
          <span>{statusText}</span>
          <button
            onClick={() => {
              const found = filesChanged.find(f => f.name === statusFile);
              if (found) {
                setSelectedFile(found);
                setActiveTab('review');
                openPanel({
                  filename: found.name,
                  filepath: found.filepath,
                  diffLines: found.diff ? found.diff.map((l: any) => ({
                    type: l.type as 'added' | 'removed' | 'context',
                    content: l.content,
                    oldLine: l.oldLine ?? undefined,
                    newLine: l.newLine ?? undefined,
                  })) : [],
                  added: found.added,
                  removed: found.removed,
                  activeTabMode: 'diff',
                });
              } else {
                const filepath = statusFile.includes('/')
                  ? statusFile
                  : statusFile === 'index.html'
                  ? 'public/index.html'
                  : `src/components/chat/${statusFile}`;
                openPanel({
                  filename: statusFile,
                  filepath: filepath,
                  activeTabMode: 'code',
                });
              }
            }}
            className="text-[#58A6FF] hover:underline cursor-pointer font-mono font-bold"
          >
            {statusFile}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-[#8C8A87]">Sandbox State:</span>
          <span className={`h-2 w-2 rounded-full ${simRunning ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
          <span className="text-[11px] font-mono font-bold text-[#E8E6E3]">{simRunning ? 'ACTIVE' : 'IDLE'}</span>
        </div>
      </div>

      {/* ── MAIN LAYOUT GRID ────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 w-full overflow-hidden">
        
        {/* ── LEFT PANE: DYNAMIC CHAT FEED ── */}
        <AnimatePresence initial={false}>
          {sidebarOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 440, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
              className="flex flex-col h-full border-r border-white/[0.08] bg-[#09090B] shrink-0"
            >
              {/* Active Task Summary Card */}
              <div className="p-4 border-b border-white/[0.06] bg-[#0A0A0C]">
                <div className="flex items-center justify-between">
                  <div className="text-[12px] font-mono font-bold tracking-wider text-[#A8A5A0] uppercase">Active Coding Task</div>
                  <span className="rounded-full bg-[#E2765A]/10 border border-[#E2765A]/20 px-2 py-0.5 text-[10px] font-bold text-[#E2765A]">Enterprise Run</span>
                </div>
                <h2 className="text-[15px] font-semibold text-white mt-1.5 truncate">Modernize chat feed UI</h2>
                <p className="text-[11.5px] text-[#8C8A87] mt-1 line-clamp-1">Refactoring user action buttons and layout containers in main workspace.</p>
              </div>

              {/* Chat Log Feed Scroll Area */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4 eterx-scrollbar [scrollbar-gutter:stable]">
                {messages.map((msg, i) => (
                  <div
                    key={msg.id || i}
                    className={`flex flex-col max-w-[92%] ${
                      msg.sender === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
                    }`}
                  >
                    {/* Timestamp */}
                    <span className="text-[10px] font-mono text-[#8C8A87] mb-1 px-1.5">{msg.timestamp}</span>

                    {/* Chat Bubble Container */}
                    <div
                      className={`relative rounded-2xl border px-3.5 py-2.5 text-[13.5px] leading-relaxed shadow-lg ${
                        msg.sender === 'user'
                          ? 'border-[#E2765A]/20 bg-[#251714] text-[#E8E6E3]'
                          : 'border-white/[0.08] bg-[#141416] text-[#E8E6E3]'
                      }`}
                    >
                      {/* Thought Segment (Collapsible thought accordion) */}
                      {msg.thought && msg.thought.length > 0 && (
                        <div className="mb-2.5 border-b border-white/[0.05] pb-2">
                          <details className="group">
                            <summary className="flex items-center gap-1.5 text-[10.5px] font-mono font-bold text-[#8C8A87] cursor-pointer hover:text-white select-none">
                              <Sparkles className="w-3 h-3 text-[#E2765A]" />
                              <span>Thought process ({msg.thought.length})</span>
                              <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90 ml-auto" />
                            </summary>
                            <div className="mt-1.5 pl-4 border-l border-white/[0.08] space-y-1 text-[11px] font-mono text-[#8C8A87]">
                              {msg.thought.map((t: string, ti: number) => (
                                <div key={ti} className="flex items-start gap-1">
                                  <span className="text-[#E2765A]">•</span>
                                  <span>{t}</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        </div>
                      )}

                      {/* Message Content */}
                      <div className="whitespace-pre-wrap break-words">
                        {msg.text}
                      </div>

                      {/* Display Modified files log badge */}
                      {msg.modifiedFiles && (
                        <div className="mt-3 space-y-1">
                          <div className="text-[11px] font-mono text-[#8C8A87] font-semibold uppercase">Edited files:</div>
                          {msg.modifiedFiles.map((file: string, fi: number) => (
                            <div key={fi} className="flex items-center gap-1.5 rounded-[6px] bg-[#22c55e]/10 border border-[#22c55e]/20 px-2 py-1 text-[11px] font-mono text-[#4ade80]">
                              <FileCode2 className="w-3.5 h-3.5" />
                              <span>{file}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Dynamic simulation buttons */}
                      {msg.isFinal && (
                        <div className="mt-3 flex items-center gap-2 border-t border-white/[0.05] pt-3">
                          <button 
                            onClick={() => {
                              setActiveTab('review');
                              setSelectedFile(filesChanged[0]);
                            }}
                            className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-bold text-white hover:bg-white/[0.08] transition-colors"
                          >
                            <Eye className="w-3 h-3" />
                            Review
                          </button>
                          <button 
                            onClick={handleResetSim}
                            className="flex items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-[11px] font-bold text-[#ff6c63] hover:bg-red-500/20 transition-colors"
                          >
                            <Undo className="w-3 h-3" />
                            Undo
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>

              {/* Chat Input Area */}
              <div className="p-4 border-t border-white/[0.08] bg-[#0A0A0C]">
                {/* Advanced Sliders & selections */}
                <div className="flex items-center justify-between mb-3 text-[11px] font-mono text-[#8C8A87]">
                  <div className="flex items-center gap-1.5">
                    <Sliders className="w-3.5 h-3.5 text-[#E2765A]" />
                    <span>Thinking:</span>
                    <span className="font-bold text-[#E8E6E3]">{thinkingLevel}%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="bg-transparent border-none outline-none font-bold text-[#E8E6E3] cursor-pointer"
                    >
                      <option value="gemini-3.5-flash" className="bg-[#111]">Gemini 3.5 Flash</option>
                      <option value="gemini-3.5-pro" className="bg-[#111]">Gemini 3.5 Pro</option>
                      <option value="gemini-3.1-live" className="bg-[#111]">Gemini 3.1 Live</option>
                    </select>
                  </div>
                </div>

                {/* Main Input Composer */}
                <div className="relative flex items-center rounded-2xl border border-white/[0.1] bg-[#141416] p-1.5 focus-within:border-[#E2765A]/40 transition-colors">
                  <textarea
                    rows={1}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendChat();
                      }
                    }}
                    placeholder="Type comments to steer agent coding flow..."
                    className="flex-1 min-h-[36px] max-h-[80px] bg-transparent pl-3 pr-10 py-1.5 text-[13px] outline-none placeholder-[#8C8A87] resize-none overflow-y-auto"
                  />

                  {/* Micro Interaction: Voice waves on recording */}
                  <AnimatePresence>
                    {isRecording ? (
                      <div className="absolute right-12 flex items-center gap-[3px] bg-red-500/10 border border-red-500/30 px-2 py-1 rounded-lg">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <motion.span
                            key={n}
                            animate={{ scaleY: [1, 2.5, 1] }}
                            transition={{ duration: 0.6, repeat: Infinity, delay: n * 0.1 }}
                            className="w-[2.5px] h-[10px] bg-[#ff6c63] rounded-full origin-center"
                          />
                        ))}
                        <span className="text-[10px] font-mono text-[#ff6c63] ml-1 font-bold">Live</span>
                      </div>
                    ) : null}
                  </AnimatePresence>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setIsRecording(r => !r)}
                      className={`flex items-center justify-center rounded-xl h-8 w-8 transition-colors ${
                        isRecording 
                          ? 'bg-[#ff6c63] text-white' 
                          : 'text-[#8C8A87] hover:bg-white/[0.05] hover:text-white'
                      }`}
                      title="Voice input mode"
                    >
                      <Mic className="w-4 h-4" />
                    </button>
                    <button
                      onClick={handleSendChat}
                      className="flex items-center justify-center rounded-xl h-8 w-8 bg-[#E2765A] text-white hover:bg-[#F2866A] transition-colors shadow-md"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── CENTER WORKSPACE: WORKSPACE TABS & CODE PANEL ── */}
        <div className="flex-1 flex flex-col h-full bg-[#0A0A0C]">
          
          {/* Tabs switch bar */}
          <div className="flex items-center justify-between border-b border-white/[0.08] bg-[#0E0E11] px-4 shrink-0">
            <div className="flex items-center gap-1">
              {[
                { id: 'review', name: 'Code Review', icon: FileCode2 },
                { id: 'google', name: 'Google Browser', icon: Globe },
                { id: 'terminal', name: 'Interactive Terminal', icon: TerminalIcon },
              ].map(tab => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`flex items-center gap-2 h-10 px-4 text-[12.5px] font-semibold border-b-2 transition-all ${
                      isActive 
                        ? 'border-[#E2765A] text-white bg-white/[0.02]' 
                        : 'border-transparent text-[#8C8A87] hover:text-white hover:bg-white/[0.01]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{tab.name}</span>
                  </button>
                );
              })}
            </div>
            
            {/* Quick dropdown layout options */}
            <div className="flex items-center gap-1.5 text-[#8C8A87]">
              <span className="text-[11px] font-mono">localhost:3000 proxy</span>
              <RefreshCw className="w-3.5 h-3.5 hover:text-white cursor-pointer transition-colors" />
            </div>
          </div>

          {/* Active Workspace View Content */}
          <div className="flex-1 min-h-0 relative overflow-hidden bg-[#050505]">
            
            {/* TAB 1: CODE REVIEW DIFF WRITER */}
            {activeTab === 'review' && (
              <div className="flex h-full w-full min-h-0">
                {/* Left: Files changed sub-panel */}
                <div className="w-64 border-r border-white/[0.08] bg-[#09090B] flex flex-col shrink-0">
                  <div className="p-3 border-b border-white/[0.06]">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[#555350]" />
                      <input
                        type="text"
                        placeholder="Filter changed files..."
                        className="w-full bg-[#141416] border border-white/[0.08] rounded-lg pl-8 pr-3 py-1.5 text-[11px] outline-none text-[#E8E6E3] placeholder-[#555350]"
                      />
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-2 space-y-1 eterx-scrollbar">
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[#8C8A87] text-[11.5px] font-bold">
                      <FolderOpen className="w-3.5 h-3.5 text-[#C09553]" />
                      <span>Workspace Modifies</span>
                    </div>

                    <div className="pl-4 space-y-0.5">
                      {filesChanged.length === 0 ? (
                        <div className="px-2.5 py-1.5 text-[11.5px] text-[#555350] italic">
                          No modified files logs yet. Execute agent to generate diff.
                        </div>
                      ) : (
                        filesChanged.map(f => {
                          const isSelected = selectedFile?.filepath === f.filepath;
                          return (
                            <button
                              key={f.filepath}
                              onClick={() => {
                                setSelectedFile(f);
                                openPanel({
                                  filename: f.name,
                                  filepath: f.filepath,
                                  diffLines: f.diff ? f.diff.map((l: any) => ({
                                    type: l.type as 'added' | 'removed' | 'context',
                                    content: l.content,
                                    oldLine: l.oldLine ?? undefined,
                                    newLine: l.newLine ?? undefined,
                                  })) : [],
                                  added: f.added,
                                  removed: f.removed,
                                  activeTabMode: 'diff',
                                });
                              }}
                              className={`flex items-center justify-between w-full text-left px-2.5 py-1.5 rounded-lg text-[12px] transition-colors ${
                                isSelected 
                                  ? 'bg-[#E2765A]/10 text-white border border-[#E2765A]/25' 
                                  : 'text-[#8C8A87] hover:bg-white/[0.03] hover:text-white border border-transparent'
                              }`}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <FileCode2 className="w-3.5 h-3.5 text-[#E2765A] shrink-0" />
                                <span className="truncate">{f.name}</span>
                              </div>
                              <div className="flex items-center gap-1 text-[9.5px] font-mono font-bold shrink-0">
                                <span className="text-[#4be37b]">+{f.added}</span>
                                <span className="text-[#ff6c63]">-{f.removed}</span>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* Right: Code Diff Viewer Pane */}
                <div className="flex-1 flex flex-col h-full bg-[#050505] overflow-hidden">
                  {/* Actions Header */}
                  <div className="flex items-center justify-between px-4 py-2 bg-[#0A0A0C] border-b border-white/[0.08] shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {selectedFile ? (
                        <>
                          <span className="w-2 h-2 rounded-full bg-[#E2765A]" />
                          <span className="text-[12.5px] font-semibold text-[#E8E6E3] truncate">{selectedFile.filepath}</span>
                          <span className="text-[9px] font-mono text-[#8C8A87] bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 rounded">MODIFIED</span>
                        </>
                      ) : (
                        <span className="text-[12px] text-[#555350] italic">No active diff loaded</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button 
                        onClick={handleCommitPush} 
                        disabled={!selectedFile}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#E2765A] text-white hover:bg-[#F2866A] disabled:opacity-40 transition-colors"
                      >
                        <GitCommit className="w-3.5 h-3.5" />
                        Push Branch
                      </button>
                    </div>
                  </div>

                  {/* Diff View Grid Panel */}
                  <div className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-6 eterx-scrollbar [scrollbar-gutter:stable] bg-[#070709]">
                    {selectedFile ? (
                      selectedFile.diff.map((row: any, ri: number) => {
                        const isAdded = row.type === 'added';
                        const isRemoved = row.type === 'removed';
                        return (
                          <div
                            key={ri}
                            className={`grid grid-cols-[40px_40px_20px_1fr] gap-0 px-2 rounded-[2px] ${
                              isAdded 
                                ? 'bg-[#20361F]/40 border-l-[3px] border-[#4be37b]/50' 
                                : isRemoved 
                                ? 'bg-[#441A1A]/40 border-l-[3px] border-[#ff6c63]/50' 
                                : 'hover:bg-white/[0.02]'
                            }`}
                          >
                            {/* Old Line Number */}
                            <span className="select-none text-right pr-3 text-[#555350]">{row.oldLine || ''}</span>
                            {/* New Line Number */}
                            <span className="select-none text-right pr-3 text-[#555350]">{row.newLine || ''}</span>
                            {/* Diff Marker */}
                            <span className={`select-none text-center pr-2 font-black ${isAdded ? 'text-[#4be37b]' : isRemoved ? 'text-[#ff6c63]' : 'text-white/20'}`}>
                              {isAdded ? '+' : isRemoved ? '-' : ''}
                            </span>
                            {/* Row Code content */}
                            <span className={`whitespace-pre-wrap break-all ${isAdded ? 'text-[#e6ffed]' : isRemoved ? 'text-[#ffeef0]' : 'text-[#A8A5A0]'}`}>
                              {row.content}
                            </span>
                          </div>
                        );
                      })
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-[#555350]">
                        <FileCode2 className="w-12 h-12 opacity-25" />
                        <span className="text-[12px] italic">Select a modified file from the left to view the changes.</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: GOOGLE BROWSER MOCK */}
            {activeTab === 'google' && (
              <div className="flex flex-col h-full w-full bg-[#0A0A0C]">
                {/* Browser address bar */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.08] bg-[#0E0E11] shrink-0">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
                    <div className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E]" />
                    <div className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
                  </div>
                  
                  <div className="flex items-center flex-1 bg-[#141416] border border-white/[0.08] rounded-lg px-2.5 py-1 min-w-0">
                    <Globe className="w-3.5 h-3.5 text-[#555350] mr-2 shrink-0" />
                    <input
                      type="text"
                      value={browserInput}
                      onChange={(e) => setBrowserInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleBrowserGo(); }}
                      className="w-full bg-transparent text-[11px] font-mono outline-none text-[#C8C6C3] placeholder-[#555350]"
                    />
                  </div>

                  <button
                    onClick={handleBrowserGo}
                    className="h-7 px-3 bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.1] text-[11px] rounded-lg font-bold transition-colors"
                  >
                    Go
                  </button>
                </div>

                {/* Mock Search Results or Web Page Container */}
                <div className="flex-1 overflow-y-auto bg-white text-[#1A1A1A] p-6 eterx-scrollbar">
                  {showSearchResults ? (
                    <div className="max-w-[720px] mx-auto space-y-6">
                      {/* Mock Google Search Bar */}
                      <div className="flex items-center border border-gray-300 rounded-full px-4 py-2.5 shadow-sm max-w-[500px]">
                        <Search className="w-4 h-4 text-gray-400 mr-2 shrink-0" />
                        <input
                          type="text"
                          value={googleSearchQuery}
                          onChange={(e) => setGoogleSearchQuery(e.target.value)}
                          className="w-full bg-transparent outline-none text-[13px] text-gray-900"
                        />
                      </div>

                      <div className="text-[12px] text-gray-500 font-mono border-b pb-2">
                        Search query: "{googleSearchQuery}" — About 12,400 results (0.32 seconds)
                      </div>

                      {/* Mock Results */}
                      <div className="space-y-5">
                        <div className="group">
                          <span className="text-[12px] text-gray-500 block truncate">https://tailwindcss.com › docs › border-radius</span>
                          <button
                            onClick={() => handleSearchClick('https://tailwindcss.com/docs/border-radius')}
                            className="text-[17px] text-[#1a0dab] font-semibold hover:underline block text-left"
                          >
                            Border Radius - Tailwind CSS Documentation
                          </button>
                          <p className="text-[13.5px] text-gray-600 mt-1 leading-normal">
                            Utilities for controlling the border radius of an element. Setting components round buttons using standard tailwind utilities.
                          </p>
                        </div>

                        <div className="group">
                          <span className="text-[12px] text-gray-500 block truncate">https://github.com › harshilsoni5666 › eterx-agent</span>
                          <button
                            onClick={() => handleSearchClick('https://github.com/harshilsoni5666/eterx-agent/chat-feed')}
                            className="text-[17px] text-[#1a0dab] font-semibold hover:underline block text-left"
                          >
                            Refactoring ChatFeed Action Row UI · harshilsoni5666
                          </button>
                          <p className="text-[13.5px] text-gray-600 mt-1 leading-normal">
                            Git issues #48: Modernize chat bubble buttons to custom glassmorphism containers. Remove old square design, replace with ripple active handlers.
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-[800px] mx-auto border border-gray-200 rounded-xl bg-[#F8F9FA] p-6 shadow-sm">
                      <div className="flex items-center justify-between border-b pb-3 mb-4">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 bg-gray-200 rounded text-[10px] font-mono text-gray-600">PAGE MOCK</span>
                          <h3 className="font-bold text-gray-800 text-[14px]">{browserUrl}</h3>
                        </div>
                        <button
                          onClick={() => setShowSearchResults(true)}
                          className="flex items-center gap-1.5 px-3 py-1 bg-gray-200 hover:bg-gray-300 text-[11.5px] font-bold text-gray-700 rounded-lg transition-colors"
                        >
                          <ArrowLeft className="w-3.5 h-3.5" />
                          Back to Search
                        </button>
                      </div>

                      {/* Mock documentation content */}
                      {browserUrl.includes('tailwindcss.com') ? (
                        <article className="prose max-w-none text-gray-800 text-[13.5px] leading-relaxed">
                          <h1 className="text-xl font-bold text-gray-900 border-b pb-2 mb-3">Border Radius Tokens</h1>
                          <p>Tailwind CSS provides visual tokens to configure rounded borders:</p>
                          <ul className="list-disc pl-5 mt-2 space-y-1">
                            <li><code>rounded-sm</code> (2px)</li>
                            <li><code>rounded-md</code> (6px)</li>
                            <li><code>rounded-lg</code> (8px)</li>
                            <li><code>rounded-xl</code> (12px)</li>
                            <li><code>rounded-2xl</code> (16px)</li>
                          </ul>
                          <div className="bg-[#EBEEF2] p-3 rounded-lg font-mono text-[12px] border border-gray-200 mt-3">
                            className="rounded-xl border border-white/[0.08] bg-[#222]/80 backdrop-blur-md"
                          </div>
                        </article>
                      ) : (
                        <div className="text-center py-12">
                          <ShieldCheck className="w-12 h-12 text-[#22c55e] mx-auto mb-3" />
                          <h4 className="font-bold text-gray-900">Workspace Sandbox Browser Proxy</h4>
                          <p className="text-[12.5px] text-gray-600 mt-1 max-w-[400px] mx-auto">
                            The agent sandbox has proxy-rendered the content of <b>{browserUrl}</b>. Local servers and code changes are automatically reloaded here.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 3: INTERACTIVE TERMINAL */}
            {activeTab === 'terminal' && (
              <div className="flex flex-col h-full w-full bg-[#050507] p-4 font-mono text-[13px] text-[#A2E0A2] overflow-hidden">
                <div className="flex-1 overflow-y-auto space-y-1.5 eterx-scrollbar [scrollbar-gutter:stable]">
                  {terminalLines.map((line, idx) => (
                    <div key={idx} className="whitespace-pre-wrap break-all leading-normal">
                      {line.startsWith('eterx-agent:') ? (
                        <span className="text-[#38bdf8]">{line}</span>
                      ) : line.startsWith('✓') ? (
                        <span className="text-[#4ade80]">{line}</span>
                      ) : line.startsWith('sh: command') ? (
                        <span className="text-[#f87171]">{line}</span>
                      ) : (
                        <span className="text-[#E8E6E3]/85">{line}</span>
                      )}
                    </div>
                  ))}
                  <div ref={terminalEndRef} />
                </div>

                {/* Command prompt form */}
                <form onSubmit={handleTerminalSubmit} className="flex items-center gap-1 border-t border-white/[0.08] pt-2 shrink-0">
                  <span className="text-[#38bdf8] shrink-0">eterx-agent:~/workspace$</span>
                  <input
                    type="text"
                    value={terminalInput}
                    onChange={(e) => setTerminalInput(e.target.value)}
                    className="flex-1 bg-transparent border-none outline-none text-[#E8E6E3] font-mono text-[13px]"
                    placeholder="ls, git status, npm run dev, help..."
                    autoFocus
                  />
                  <button type="submit" className="hidden" />
                </form>
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT PANE: FILE TREE & COMMIT/PR CONTROLS ── */}
        <AnimatePresence>
          {rightSidebarOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: openFiles.length > 0 ? 700 : 300, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
              className="flex flex-col h-full border-l border-white/[0.08] bg-[#09090B] shrink-0 overflow-hidden"
            >
              {openFiles.length > 0 ? (
                <div className="flex-1 h-full w-full overflow-hidden relative bg-[#0d0d0f]">
                  <IdePanel />
                </div>
              ) : (
                <>
              {/* Git commit/PR triggers */}
              <div className="p-4 border-b border-white/[0.08] bg-[#0A0A0C]">
                <div className="flex items-center gap-1.5 mb-3 text-[11px] font-mono font-bold text-[#8C8A87] uppercase tracking-wider">
                  <GitPullRequest className="w-3.5 h-3.5 text-[#E2765A]" />
                  <span>Version Controls</span>
                </div>
                
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[12px] bg-white/[0.03] border border-white/[0.06] rounded-xl px-3 py-2">
                    <span className="font-semibold text-white">Branch</span>
                    <span className="font-mono bg-white/[0.06] px-1.5 py-0.5 rounded text-[10px] text-[#E2765A]">feature/modernize-chat</span>
                  </div>

                  <button
                    onClick={handleCommitPush}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#E2765A] py-2 text-[12.5px] font-bold text-white hover:bg-[#F2866A] transition-all shadow-md active:scale-[0.98]"
                  >
                    <GitCommit className="w-4 h-4" />
                    Commit and Push
                  </button>

                  <button
                    onClick={() => alert("Sandbox PR: Pull request created. View at github.com/harshilsoni5666/eterx-agent-modelselector/pulls")}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] py-2 text-[12.5px] font-bold text-white hover:bg-white/[0.06] transition-all"
                  >
                    <GitPullRequest className="w-4 h-4 text-[#8C8A87]" />
                    Create Pull Request
                  </button>
                </div>
              </div>

              {/* Sandbox Project Files Browser Tree */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2 eterx-scrollbar [scrollbar-gutter:stable]">
                <div className="flex items-center gap-1.5 text-[11px] font-mono font-bold text-[#8C8A87] uppercase tracking-wider">
                  <Folder className="w-3.5 h-3.5 text-[#C09553]" />
                  <span>Files tree</span>
                </div>

                <div className="space-y-0.5 text-[12.5px]">
                  {/* ROOT */}
                  <div className="flex items-center gap-1.5 py-1 text-white font-semibold">
                    <FolderOpen className="w-3.5 h-3.5 text-[#C09553]" />
                    <span>EterX-Agent</span>
                  </div>

                  {/* SRC */}
                  <div className="pl-4">
                    <div className="flex items-center gap-1.5 py-1 text-[#C4C7C5]">
                      <FolderOpen className="w-3.5 h-3.5 text-[#C09553]" />
                      <span>src</span>
                    </div>

                    {/* SRC/COMPONENTS */}
                    <div className="pl-4">
                      <div className="flex items-center gap-1.5 py-1 text-[#C4C7C5]">
                        <FolderOpen className="w-3.5 h-3.5 text-[#C09553]" />
                        <span>components</span>
                      </div>

                      {/* SRC/COMPONENTS/CHAT */}
                      <div className="pl-4">
                        <div className="flex items-center gap-1.5 py-1 text-[#C4C7C5]">
                          <FolderOpen className="w-3.5 h-3.5 text-[#C09553]" />
                          <span className="font-semibold text-white">chat</span>
                        </div>

                        {/* Files in Chat */}
                        <div className="pl-4 space-y-0.5">
                          <button
                            onClick={() => {
                              const found = filesChanged.find(f => f.name === 'chat-feed.tsx');
                              if (found) {
                                setSelectedFile(found);
                                setActiveTab('review');
                                openPanel({
                                  filename: found.name,
                                  filepath: found.filepath,
                                  diffLines: found.diff ? found.diff.map((l: any) => ({
                                    type: l.type as 'added' | 'removed' | 'context',
                                    content: l.content,
                                    oldLine: l.oldLine ?? undefined,
                                    newLine: l.newLine ?? undefined,
                                  })) : [],
                                  added: found.added,
                                  removed: found.removed,
                                  activeTabMode: 'diff',
                                });
                              } else {
                                openPanel({
                                  filename: 'chat-feed.tsx',
                                  filepath: 'src/components/chat/chat-feed.tsx',
                                  activeTabMode: 'code',
                                });
                              }
                            }}
                            className="flex items-center gap-2 py-1 text-left w-full text-[#8C8A87] hover:text-white"
                          >
                            <FileCode2 className="w-3.5 h-3.5 text-[#E2765A]" />
                            <span className={filesChanged.some(f => f.name === 'chat-feed.tsx') ? 'text-emerald-400 font-bold' : ''}>chat-feed.tsx</span>
                          </button>

                          <button
                            onClick={() => {
                              openPanel({
                                filename: 'workspace-review-editor.tsx',
                                filepath: 'src/components/chat/workspace-review-editor.tsx',
                                activeTabMode: 'code',
                              });
                            }}
                            className="flex items-center gap-2 py-1 text-left w-full text-[#8C8A87] hover:text-white"
                          >
                            <FileCode2 className="w-3.5 h-3.5 text-[#8C8A87]" />
                            <span>workspace-review-editor.tsx</span>
                          </button>
                        </div>
                      </div>

                      {/* SRC/COMPONENTS/LAYOUT */}
                      <div className="pl-4">
                        <div className="flex items-center gap-1.5 py-1 text-[#C4C7C5]">
                          <FolderOpen className="w-3.5 h-3.5 text-[#C09553]" />
                          <span>layout</span>
                        </div>

                        {/* Files in Layout */}
                        <div className="pl-4 space-y-0.5">
                          <button
                            onClick={() => {
                              const found = filesChanged.find(f => f.name === 'chat-input.tsx');
                              if (found) {
                                setSelectedFile(found);
                                setActiveTab('review');
                                openPanel({
                                  filename: found.name,
                                  filepath: found.filepath,
                                  diffLines: found.diff ? found.diff.map((l: any) => ({
                                    type: l.type as 'added' | 'removed' | 'context',
                                    content: l.content,
                                    oldLine: l.oldLine ?? undefined,
                                    newLine: l.newLine ?? undefined,
                                  })) : [],
                                  added: found.added,
                                  removed: found.removed,
                                  activeTabMode: 'diff',
                                });
                              } else {
                                openPanel({
                                  filename: 'chat-input.tsx',
                                  filepath: 'src/components/layout/chat-input.tsx',
                                  activeTabMode: 'code',
                                });
                              }
                            }}
                            className="flex items-center gap-2 py-1 text-left w-full text-[#8C8A87] hover:text-white"
                          >
                            <FileCode2 className="w-3.5 h-3.5 text-[#E2765A]" />
                            <span className={filesChanged.some(f => f.name === 'chat-input.tsx') ? 'text-emerald-400 font-bold' : ''}>chat-input.tsx</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
            )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
