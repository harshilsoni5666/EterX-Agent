"use client";

import React, { useState, useRef, useEffect } from 'react';
import { Terminal, Trash2, ChevronRight } from 'lucide-react';

interface TerminalEntry {
  command: string;
  output: string;
  exitCode: number;
  cwd: string;
}

interface TerminalPanelProps {
  history: TerminalEntry[];
  onExecute: (command: string) => void;
  cwd: string;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ history, onExecute, cwd }) => {
  const [input, setInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isExecuting, setIsExecuting] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isExecuting) return;

    const cmd = input.trim();
    setInput('');
    setCommandHistory(prev => [...prev, cmd]);
    setHistoryIdx(-1);
    setIsExecuting(true);
    await onExecute(cmd);
    setIsExecuting(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIdx = historyIdx < commandHistory.length - 1 ? historyIdx + 1 : historyIdx;
        setHistoryIdx(newIdx);
        setInput(commandHistory[commandHistory.length - 1 - newIdx] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx > 0) {
        const newIdx = historyIdx - 1;
        setHistoryIdx(newIdx);
        setInput(commandHistory[commandHistory.length - 1 - newIdx] || '');
      } else {
        setHistoryIdx(-1);
        setInput('');
      }
    }
  };

  const getShortCwd = (cwdPath: string) => {
    const parts = cwdPath.replace(/\\/g, '/').split('/');
    return parts.slice(-2).join('/');
  };

  return (
    <div className="flex flex-col h-full bg-[#070707]">
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2 text-[11px] font-semibold text-[#555350] uppercase tracking-wider">
          <Terminal className="w-3.5 h-3.5" />
          Terminal
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-[#555350] font-mono mr-2">{getShortCwd(cwd)}</span>
        </div>
      </div>

      {/* Terminal Output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto custom-scrollbar px-3 py-2 font-mono text-[12px] leading-[18px]"
        onClick={() => inputRef.current?.focus()}
      >
        {history.length === 0 && (
          <div className="text-[#555350] italic text-[11px] mb-2 flex items-center gap-2 py-1">
            <Terminal className="w-3 h-3" />
            EterX Terminal — Type a command to get started
          </div>
        )}

        {history.map((entry, i) => (
          <div key={i} className="mb-3">
            {/* Command Line */}
            <div className="flex items-center gap-1.5 text-[#E2765A]">
              <ChevronRight className="w-3 h-3 text-[#E2765A]/60" />
              <span className="text-[#8C8A88]">{getShortCwd(entry.cwd)}</span>
              <span className="text-[#555350]">$</span>
              <span className="text-[#E8E6E3]">{entry.command}</span>
            </div>
            {/* Output */}
            {entry.output && (
              <pre className={`mt-1 ml-5 whitespace-pre-wrap break-all ${
                entry.exitCode === 0 ? 'text-[#A3A19E]' : 'text-red-400'
              }`}>
                {entry.output}
              </pre>
            )}
            {/* Exit code for failures */}
            {entry.exitCode !== 0 && (
              <div className="mt-0.5 ml-5 text-[10px] text-red-400/60">
                Exit code: {entry.exitCode}
              </div>
            )}
          </div>
        ))}

        {isExecuting && (
          <div className="flex items-center gap-2 text-[#555350] ml-5">
            <div className="w-3 h-3 border border-[#E2765A]/30 border-t-[#E2765A] rounded-full animate-spin" />
            <span className="text-[11px]">Running...</span>
          </div>
        )}
      </div>

      {/* Input Line */}
      <form onSubmit={handleSubmit} className="flex items-center gap-1.5 px-3 py-2 border-t border-white/5 shrink-0 bg-[#0A0A0A]">
        <ChevronRight className="w-3 h-3 text-[#E2765A]/60 shrink-0" />
        <span className="text-[12px] text-[#8C8A88] font-mono shrink-0">{getShortCwd(cwd)} $</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent text-[#E8E6E3] font-mono text-[12px] outline-none border-none placeholder:text-[#333]"
          placeholder="Type a command..."
          spellCheck={false}
          autoFocus
        />
      </form>
    </div>
  );
};
