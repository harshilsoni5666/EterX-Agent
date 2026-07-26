"use client";

import React, { useState, useRef, useEffect } from 'react';
import {
  Send, Sparkles, Code2, Loader, Terminal,
  CheckCircle2, AlertCircle, ChevronDown, ChevronRight,
  Brain, Wrench, FileCode, GitBranch, Search,
  Copy, RotateCcw
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

/**
 * Code Chat — Autonomous coding agent chat interface.
 * 
 * Connected to real tools via /api/code/chat:
 *   - File ops: workspace_read_file, workspace_write_file, workspace_edit_file
 *   - Search: workspace_search_text, workspace_list_directory
 *   - Shell: system_shell, workspace_run_command
 *   - Code: code_intelligence, workspace_verify_code
 *   - Git: git_tools, git_intelligence
 * 
 * System prompt patterns from code/src/constants/prompts.ts
 * Tool execution mirrors code/src/QueryEngine.ts ReAct loop
 * Slash commands from code/src/commands/ (expanded server-side)
 */

interface ToolExecution {
  tool: string;
  args?: any;
  uiActionText?: string;
  success?: boolean;
  result?: string;
  error?: string;
  status: 'running' | 'done' | 'error';
}

interface CodeChatMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  toolExecutions?: ToolExecution[];
  timestamp?: number;
}

interface CodeChatProps {
  workspacePath: string;
  activeFile: { path: string; name: string; content: string; language: string; modified: boolean } | null;
  onClose: () => void;
}

const TOOL_ICONS: Record<string, string> = {
  workspace_read_file: '📖',
  workspace_write_file: '📝',
  workspace_edit_file: '✏️',
  workspace_str_replace: '✏️',
  workspace_apply_patch: '🩹',
  workspace_edit_many_files: '📝',
  workspace_edit_session: '📋',
  workspace_list_directory: '📁',
  workspace_search_text: '🔍',
  workspace_semantic_search: '🔍',
  workspace_symbol_lookup: '🔎',
  workspace_file_outline: '📑',
  workspace_find_files: '📂',
  workspace_read_many_files: '📖',
  system_shell: '💻',
  workspace_run_command: '▶️',
  workspace_verify_code: '✅',
  code_intelligence: '🔬',
  smart_refactor: '🔄',
  git_tools: '📊',
  git_intelligence: '🧠',
  web_search: '🌐',
  web_scraper: '🕸️',
  auto_docs: '📚',
  tool_finder: '🧭',
};

const SUGGESTIONS = [
  { text: 'Analyze this project structure', icon: '🔬' },
  { text: 'Find and fix TypeScript errors', icon: '🔧' },
  { text: 'Add error handling to this codebase', icon: '🛡️' },
  { text: 'Write unit tests for the main functions', icon: '🧪' },
  { text: 'Refactor for better performance', icon: '⚡' },
  { text: 'Review code for security issues', icon: '🔐' },
];

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export const CodeChat: React.FC<CodeChatProps> = ({ workspacePath, activeFile, onClose }) => {
  const [messages, setMessages] = useState<CodeChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runSeqRef = useRef(0);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Listen for slash commands from code-view.tsx
  useEffect(() => {
    const handler = (e: Event) => {
      const cmd = (e as CustomEvent).detail;
      if (typeof cmd === 'string') {
        setInput(cmd);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    };
    window.addEventListener('eterx-code-command', handler);
    return () => window.removeEventListener('eterx-code-command', handler);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = '24px';
      el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    }
  }, [input]);

  useEffect(() => () => {
    runSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // ─── Stop handler ───
  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  };

  // ─── Send handler ───
  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage, timestamp: Date.now() }]);
    setIsStreaming(true);

    // Build history from current messages (before adding this one)
    const chatHistory = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }));

    // Add empty assistant message for streaming
    setMessages(prev => [...prev, { role: 'assistant', content: '', thinking: '', toolExecutions: [], timestamp: Date.now() }]);

    const controller = new AbortController();
    abortRef.current = controller;
    const runSeq = ++runSeqRef.current;
    const isCurrentRun = () => runSeqRef.current === runSeq;

    try {
      let terminalShell = 'auto';
      try {
        terminalShell = JSON.parse(localStorage.getItem('eterx_settings') || '{}')?.terminalShell || 'auto';
      } catch {}
      const response = await fetch('/api/code/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMessage,
          history: chatHistory,
          workspacePath,
          terminalShell,
          activeFile: activeFile ? { path: activeFile.path, name: activeFile.name, language: activeFile.language } : undefined,
        }),
        signal: controller.signal,
      });

      // Handle HTTP errors
      if (!response.ok) {
        let errorMsg = `Server error (${response.status})`;
        try {
          const errBody = await response.json();
          errorMsg = errBody.error || errBody.details || errorMsg;
        } catch { /* not JSON */ }
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: `Error: ${errorMsg}`, timestamp: Date.now() };
          return updated;
        });
        return;
      }

      if (!response.body) throw new Error('No stream body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!isCurrentRun()) break;

        // ─── Proper SSE buffering ───
        sseBuffer += decoder.decode(value, { stream: true });
        const chunks = sseBuffer.split('\n\n');
        sseBuffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const trimmed = chunk.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          try {
            const parsed = JSON.parse(trimmed.replace(/^data:\s*/, ''));
            if (!isCurrentRun()) break;

            if (parsed.type === 'trace' && parsed.data) {
              const { type: evtType } = parsed.data;

              if (evtType === 'thought_stream') {
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, thinking: parsed.data.text };
                  }
                  return updated;
                });
              } else if (evtType === 'answer') {
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, content: parsed.data.text };
                  }
                  return updated;
                });
              } else if (evtType === 'answer_cancel') {
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, content: parsed.data.text || '' };
                  }
                  return updated;
                });
              } else if (evtType === 'tool_start') {
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    const executions = [...(last.toolExecutions || [])];
                    executions.push({
                      tool: parsed.data.tool,
                      args: parsed.data.args,
                      uiActionText: parsed.data.uiActionText,
                      status: 'running',
                    });
                    updated[updated.length - 1] = { ...last, toolExecutions: executions };
                  }
                  return updated;
                });
              } else if (evtType === 'tool_result') {
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant' && last.toolExecutions) {
                    const executions = [...last.toolExecutions];
                    const idx = executions.findLastIndex(e => e.tool === parsed.data.tool && e.status === 'running');
                    if (idx >= 0) {
                      executions[idx] = { ...executions[idx], status: 'done', success: true, result: parsed.data.result };
                    }
                    updated[updated.length - 1] = { ...last, toolExecutions: executions };
                  }
                  return updated;
                });
              } else if (evtType === 'tool_error') {
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant' && last.toolExecutions) {
                    const executions = [...last.toolExecutions];
                    const idx = executions.findLastIndex(e => e.tool === parsed.data.tool && e.status === 'running');
                    if (idx >= 0) {
                      executions[idx] = { ...executions[idx], status: 'error', error: parsed.data.error };
                    }
                    updated[updated.length - 1] = { ...last, toolExecutions: executions };
                  }
                  return updated;
                });
              } else if (evtType === 'context_compressed') {
                console.log(`[CodeChat] Context compressed: ${parsed.data.savings}% savings at iteration ${parsed.data.iteration}`);
              }
            }
          } catch { /* malformed SSE chunk — skip */ }
        }
      }

      // Flush remaining buffer
      if (sseBuffer.trim() && isCurrentRun()) {
        try {
          const lastChunk = sseBuffer.trim();
          if (lastChunk.startsWith('data:')) {
            const parsed = JSON.parse(lastChunk.replace(/^data:\s*/, ''));
            if (parsed.type === 'trace' && parsed.data?.type === 'answer') {
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: parsed.data.text };
                }
                return updated;
              });
            }
          }
        } catch { /* ignore trailing */ }
      }
    } catch (error: any) {
      if (!isCurrentRun()) return;
      if (error.name === 'AbortError') {
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant' && !last.content) {
            updated[updated.length - 1] = { ...last, content: '*Stopped by user.*' };
          }
          return updated;
        });
      } else {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: `Connection error: ${error.message || 'Unknown error'}. Please try again.`,
            timestamp: Date.now(),
          };
          return updated;
        });
      }
    } finally {
      if (isCurrentRun()) {
        setIsStreaming(false);
      }
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#050505]">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto eterx-scrollbar">
        {messages.length === 0 ? (
          <EmptyState
            workspacePath={workspacePath}
            onSelect={(text) => setInput(text)}
          />
        ) : (
          <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}

            {isStreaming && messages[messages.length - 1]?.content === '' && !messages[messages.length - 1]?.thinking && !(messages[messages.length - 1]?.toolExecutions?.length) && (
              <div className="flex items-center gap-2.5 py-2 px-1">
                <div className="w-4 h-4 border-2 border-[#E2765A]/30 border-t-[#E2765A] rounded-full animate-spin" />
                <span className="text-[12px] text-[#8C8A88]">Connecting to agent...</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="shrink-0 border-t border-white/[0.06] bg-[#080808] px-4 py-3">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-2 bg-white/[0.04] rounded-2xl border border-white/[0.08] px-4 py-3 focus-within:border-[#E2765A]/30 focus-within:bg-white/[0.05] transition-all">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              className="flex-1 bg-transparent text-[13px] text-[#E8E6E3] outline-none resize-none placeholder:text-[#555350] leading-relaxed"
              placeholder={`Ask about code, or use /commands...`}
              style={{ minHeight: '24px' }}
            />
            {isStreaming ? (
              <button
                onClick={handleStop}
                className="p-2 rounded-xl transition-all shrink-0 bg-red-500/20 text-red-400 hover:bg-red-500/30 active:scale-90 border border-red-500/20"
                title="Stop generation"
              >
                <div className="w-4 h-4 flex items-center justify-center">
                  <div className="w-2.5 h-2.5 bg-red-400 rounded-sm" />
                </div>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className={`p-2 rounded-xl transition-all shrink-0 ${
                  input.trim()
                    ? 'bg-[#E2765A] text-white hover:bg-[#D2664A] active:scale-90 shadow-lg shadow-[#E2765A]/20'
                    : 'bg-white/5 text-[#555350]'
                }`}
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-between px-1">
            <span className="text-[10px] text-[#333]">Shift+Enter for new line · /commands available</span>
            <span className="text-[10px] text-[#333] font-mono truncate max-w-[200px]">{workspacePath.split(/[/\\]/).pop()}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// SUBCOMPONENTS
// ═══════════════════════════════════════════════════════════════

// ─── Empty State ───
const EmptyState: React.FC<{ workspacePath: string; onSelect: (text: string) => void }> = ({ workspacePath, onSelect }) => {
  const projectName = workspacePath.split(/[/\\]/).filter(Boolean).pop() || 'Project';

  return (
    <div className="flex flex-col items-center justify-center h-full px-4 py-12">
      <div className="max-w-md w-full flex flex-col items-center">
        {/* Icon */}
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#E2765A]/20 to-[#E2765A]/5 flex items-center justify-center mb-5 border border-[#E2765A]/10">
          <Code2 className="w-7 h-7 text-[#E2765A]/50" />
        </div>

        <h2 className="text-[16px] font-semibold text-white/90 mb-1">Ready to code</h2>
        <p className="text-[12px] text-[#8C8A88] text-center mb-6">
          Working in <span className="text-[#E2765A] font-mono font-medium">{projectName}</span>. Ask anything — I can read, edit, run, and debug your code.
        </p>

        <div className="w-full grid grid-cols-2 gap-2">
          {SUGGESTIONS.map(({ text, icon }) => (
            <button
              key={text}
              onClick={() => onSelect(text)}
              className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl border border-white/[0.04] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.08] text-left transition-all group"
            >
              <span className="text-[13px] mt-0.5 shrink-0">{icon}</span>
              <span className="text-[11px] text-[#8C8A88] group-hover:text-[#C8C6C3] leading-relaxed">{text}</span>
            </button>
          ))}
        </div>

        <div className="mt-6 flex items-center gap-2 text-[10px] text-[#333]">
          <Sparkles className="w-3 h-3" />
          <span>Powered by EterX coding agent · Full tool access</span>
        </div>
      </div>
    </div>
  );
};

// ─── Message Bubble ───
const MessageBubble: React.FC<{ message: CodeChatMessage }> = ({ message }) => {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-white/[0.06] border border-white/[0.06] rounded-2xl rounded-br-md px-4 py-2.5 max-w-[85%]">
          <p className="text-[13px] text-[#E8E6E3] leading-relaxed whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Thinking */}
      {message.thinking && !message.content && (
        <ThinkingBlock text={message.thinking} />
      )}

      {/* Tool executions */}
      {message.toolExecutions && message.toolExecutions.length > 0 && (
        <div className="space-y-1.5">
          {message.toolExecutions.map((exec, j) => (
            <ToolExecutionBlock key={j} execution={exec} />
          ))}
        </div>
      )}

      {/* Answer */}
      {message.content && (
        <div className="text-[13px] text-[#C8C6C3] leading-relaxed prose prose-invert prose-sm max-w-full">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                const isInline = !match;
                if (isInline) {
                  return (
                    <code className="bg-[#E2765A]/10 text-[#E2765A] rounded px-1.5 py-0.5 text-[12px] font-mono" {...props}>
                      {children}
                    </code>
                  );
                }
                return (
                  <div className="relative group">
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => navigator.clipboard.writeText(String(children))}
                        className="p-1 rounded bg-white/10 hover:bg-white/20 text-[#8C8A88] hover:text-white transition-all"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                    <SyntaxHighlighter
                      language={match?.[1] || 'text'}
                      style={oneDark}
                      customStyle={{
                        margin: '10px 0',
                        padding: '14px',
                        borderRadius: '12px',
                        fontSize: '12px',
                        background: '#0C0C0C',
                        border: '1px solid rgba(255,255,255,0.04)',
                      }}
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  </div>
                );
              },
              p({ children }) {
                return <p className="mb-2.5 last:mb-0">{children}</p>;
              },
              h1({ children }) {
                return <h1 className="text-[15px] font-bold text-white mt-4 mb-2">{children}</h1>;
              },
              h2({ children }) {
                return <h2 className="text-[14px] font-semibold text-white/90 mt-3 mb-1.5">{children}</h2>;
              },
              h3({ children }) {
                return <h3 className="text-[13px] font-medium text-white/80 mt-2 mb-1">{children}</h3>;
              },
              ul({ children }) {
                return <ul className="list-disc list-inside space-y-1 my-2">{children}</ul>;
              },
              li({ children }) {
                return <li className="text-[#A3A19E]">{children}</li>;
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
};

// ─── Thinking Block ───
const ThinkingBlock: React.FC<{ text: string }> = ({ text }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl px-3 py-2">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 cursor-pointer"
      >
        <Brain className="w-3.5 h-3.5 text-purple-400/60 animate-pulse shrink-0" />
        <span className="text-[11px] text-[#8C8A88] font-medium">Thinking...</span>
        {expanded ? <ChevronDown className="w-3 h-3 text-[#555350] ml-auto" /> : <ChevronRight className="w-3 h-3 text-[#555350] ml-auto" />}
      </div>
      {expanded && (
        <div className="mt-2 text-[11px] text-[#555350] leading-relaxed max-h-[150px] overflow-y-auto eterx-scrollbar whitespace-pre-wrap pl-5">
          {text}
        </div>
      )}
    </div>
  );
};

// ─── Diff Line Renderer ───
const DiffLineRenderer: React.FC<{ diff: string }> = ({ diff }) => {
  const lines = diff.split('\n');
  return (
    <div className="font-mono text-[10px] leading-[16px] rounded-lg overflow-hidden border border-white/[0.04] bg-[#0A0A0A]">
      {lines.map((line, i) => {
        let bgClass = '';
        let textClass = 'text-[#555350]';

        if (line.startsWith('@@')) {
          bgClass = 'bg-blue-500/[0.06]';
          textClass = 'text-blue-400/70';
        } else if (line.startsWith('+')) {
          bgClass = 'bg-emerald-500/[0.08]';
          textClass = 'text-emerald-400';
        } else if (line.startsWith('-')) {
          bgClass = 'bg-red-500/[0.08]';
          textClass = 'text-red-400';
        } else if (line.startsWith(' ')) {
          textClass = 'text-[#666]';
        }

        return (
          <div key={i} className={`px-2.5 py-[1px] ${bgClass} border-l-2 ${
            line.startsWith('+') ? 'border-l-emerald-500/40' :
            line.startsWith('-') ? 'border-l-red-500/40' :
            'border-l-transparent'
          }`}>
            <span className={textClass}>{line}</span>
          </div>
        );
      })}
    </div>
  );
};

// ─── Tool Execution Block ───
const ToolExecutionBlock: React.FC<{ execution: ToolExecution }> = ({ execution }) => {
  const [expanded, setExpanded] = useState(false);
  const icon = TOOL_ICONS[execution.tool] || '🔧';
  const label = execution.uiActionText || execution.tool.replace(/_/g, ' ');

  // Try to parse structured result for edit tools
  const parsedResult = React.useMemo(() => {
    if (!execution.result) return null;
    try {
      const parsed = JSON.parse(execution.result);
      return parsed;
    } catch {
      return null;
    }
  }, [execution.result]);

  const hasDiff = parsedResult?.diff && typeof parsedResult.diff === 'string';
  const hasReadback = parsedResult?.readback && typeof parsedResult.readback === 'string';
  const hasReadbacks = parsedResult?.readbacks && typeof parsedResult.readbacks === 'object';
  const isEditTool = ['workspace_str_replace', 'workspace_apply_patch', 'workspace_edit_file', 'workspace_edit_many_files'].includes(execution.tool);

  // Build compact status line for edit results
  const editSummary = React.useMemo(() => {
    if (!parsedResult || !isEditTool) return null;
    const parts: string[] = [];
    if (parsedResult.path) parts.push(parsedResult.path.split(/[/\\]/).pop() || '');
    if (parsedResult.replacements) parts.push(`${parsedResult.replacements} replacement${parsedResult.replacements > 1 ? 's' : ''}`);
    if (parsedResult.editLine) parts.push(`line ${parsedResult.editLine}`);
    if (parsedResult.totalLines) parts.push(`${parsedResult.totalLines} total`);
    if (parsedResult.filesModified?.length) parts.push(`${parsedResult.filesModified.length} file${parsedResult.filesModified.length > 1 ? 's' : ''} modified`);
    if (parsedResult.filesCreated?.length) parts.push(`${parsedResult.filesCreated.length} created`);
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [parsedResult, isEditTool]);

  const statusEl = execution.status === 'running'
    ? <div className="w-3.5 h-3.5 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin shrink-0" />
    : execution.status === 'done'
    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
    : <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;

  return (
    <div className={`border rounded-xl px-3 py-2 transition-all ${
      execution.status === 'running' ? 'bg-blue-500/[0.04] border-blue-500/10' :
      execution.status === 'error' ? 'bg-red-500/[0.04] border-red-500/10' :
      'bg-white/[0.015] border-white/[0.04]'
    }`}>
      <div
        onClick={() => (execution.result || execution.error) && setExpanded(!expanded)}
        className="flex items-center gap-2 cursor-pointer"
      >
        {statusEl}
        <span className="text-[12px] shrink-0">{icon}</span>
        <span className="text-[11px] text-[#A3A19E] font-medium truncate flex-1">{label}</span>
        {editSummary && execution.status === 'done' && (
          <span className="text-[10px] text-[#555350] font-mono truncate max-w-[200px] shrink-0">{editSummary}</span>
        )}
        {(execution.result || execution.error) && (
          expanded
            ? <ChevronDown className="w-3 h-3 text-[#555350] shrink-0" />
            : <ChevronRight className="w-3 h-3 text-[#555350] shrink-0" />
        )}
      </div>

      {expanded && (
        <div className="mt-2 space-y-2">
          {/* Diff view for edit tools — RED removed, GREEN added */}
          {hasDiff && (
            <div>
              <div className="text-[9px] text-[#555350] uppercase tracking-wider mb-1 font-medium">Changes</div>
              <DiffLineRenderer diff={parsedResult.diff} />
            </div>
          )}

          {/* Readback for str_replace */}
          {hasReadback && (
            <div>
              <div className="text-[9px] text-[#555350] uppercase tracking-wider mb-1 font-medium">Verified Result</div>
              <pre className="text-[10px] text-[#777] leading-[15px] max-h-[100px] overflow-y-auto eterx-scrollbar whitespace-pre-wrap font-mono bg-black/30 rounded-lg p-2 border border-white/[0.03]">
                {parsedResult.readback}
              </pre>
            </div>
          )}

          {/* Per-file readbacks for apply_patch */}
          {hasReadbacks && Object.entries(parsedResult.readbacks).map(([fileName, content]) => (
            <div key={fileName}>
              <div className="text-[9px] text-[#555350] uppercase tracking-wider mb-1 font-medium">{fileName}</div>
              <pre className="text-[10px] text-[#777] leading-[15px] max-h-[80px] overflow-y-auto eterx-scrollbar whitespace-pre-wrap font-mono bg-black/30 rounded-lg p-2 border border-white/[0.03]">
                {String(content)}
              </pre>
            </div>
          ))}

          {/* Raw result for non-edit tools */}
          {!hasDiff && !hasReadback && !hasReadbacks && execution.result && (
            <pre className="text-[10px] text-[#555350] leading-[15px] max-h-[120px] overflow-y-auto eterx-scrollbar whitespace-pre-wrap font-mono bg-black/30 rounded-lg p-2.5 border border-white/[0.03]">
              {execution.result.substring(0, 1500)}
            </pre>
          )}

          {/* Error display */}
          {execution.error && (
            <div className="text-[10px] text-red-400/80 leading-relaxed pl-5">
              {execution.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
