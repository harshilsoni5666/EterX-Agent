import React, { useState, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, Pause, Play, Loader2 } from 'lucide-react';
import { ChatFeed } from '../chat/chat-feed';

/**
 * SubAgentPanel — Enterprise-grade per-agent view
 * 
 * Renders a tabbed interface where each sub-agent gets its own full
 * ChatFeed + ChatInput, identical to the main agent experience.
 * 
 * Tab bar shows agent profile images, names, and status.
 * Control buttons (Pause / Resume / Close) are in each tab header.
 */

interface SubAgentInfo {
  name: string;
  status: string;
  task?: string;
  currentAction?: string;
  stepCount?: number;
  durationMs?: number;
  startedAt?: number;
}

interface SubAgentPanelProps {
  agents: SubAgentInfo[];
  traceLogs: any[];
  isOpen: boolean;
  onClose: () => void;
  activeChatId: string | null;
  focusedAgent?: string | null;
}

const SUB_AGENT_ICON_NAMES = [
  'einstein', 'heisenberg', 'sam', 'dario', 'elon',
  'tesla', 'newton', 'turing', 'ada', 'curie',
  'feynman', 'darwin', 'hawking', 'galileo', 'davinci',
  'aristotle', 'oppenheimer', 'gates', 'jobs', 'pascal'
];

function AgentAvatar({ name, size = 24 }: { name: string; size?: number }) {
  const lowerName = String(name || '').toLowerCase().trim();
  const hasImage = SUB_AGENT_ICON_NAMES.includes(lowerName);

  if (hasImage) {
    return (
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/[0.08] bg-black/10"
        style={{ width: size, height: size }}
      >
        <img
          src={`/icons/sub-agents/${lowerName}.png`}
          alt={name}
          className="w-full h-full object-cover select-none"
        />
      </span>
    );
  }

  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] font-bold text-white/60"
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.38) }}
    >
      {String(name || 'A').charAt(0).toUpperCase()}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === 'working' || status === 'spawning') {
    return <svg className="w-3 h-3 shrink-0 animate-spin text-emerald-400" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" /></svg>;
  }
  if (status === 'paused') {
    return <span className="flex h-3 w-3 shrink-0 items-center justify-center text-amber-400"><svg viewBox="0 0 10 10" fill="currentColor" className="w-2 h-2"><rect x="1" y="1" width="3" height="8" rx="0.5" /><rect x="6" y="1" width="3" height="8" rx="0.5" /></svg></span>;
  }
  if (status === 'completed') {
    return <span className="w-2 h-2 shrink-0 rounded-full bg-emerald-400/80" />;
  }
  if (status === 'error') {
    return <span className="w-2 h-2 shrink-0 rounded-full bg-red-400/80" />;
  }
  if (status === 'closed') {
    return <span className="w-2 h-2 shrink-0 rounded-full bg-white/15" />;
  }
  return <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-white/20" />;
}

export const SubAgentPanel: React.FC<SubAgentPanelProps> = ({
  agents,
  traceLogs,
  isOpen,
  onClose,
  activeChatId,
  focusedAgent,
}) => {
  const [activeTab, setActiveTab] = useState<string | null>(focusedAgent || null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null!);

  // Auto-select first agent if none selected
  const selectedAgent = activeTab && agents.find(a => a.name === activeTab)
    ? activeTab
    : agents.length > 0 ? agents[0].name : null;

  // Derive per-agent trace logs from the main traceLogs
  const agentTraceLogs = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const agent of agents) {
      map[agent.name] = [];
    }
    for (const log of traceLogs) {
      if (!log) continue;
      const agentName = log.agentName || log.subAgent;
      if (agentName && map[agentName]) {
        map[agentName].push(log);
      }
    }
    return map;
  }, [agents, traceLogs]);

  const currentAgent = agents.find(a => a.name === selectedAgent) || null;
  const currentLogs = selectedAgent ? (agentTraceLogs[selectedAgent] || []) : [];
  const isAgentWorking = currentAgent?.status === 'working' || currentAgent?.status === 'spawning';

  const handleControl = useCallback(async (action: string, agentName: string) => {
    try {
      await fetch('/api/agent/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, projectId: activeChatId, agentName }),
      });
    } catch (err) {
      console.error(`[SubAgentPanel] ${action} failed:`, err);
    }
  }, [activeChatId]);

  const handleSendMessage = useCallback(async (agentName: string) => {
    const text = inputValues[agentName]?.trim();
    if (!text) return;
    // TODO: Wire to steer API for the sub-agent
    setInputValues(prev => ({ ...prev, [agentName]: '' }));
  }, [inputValues]);

  if (!isOpen || agents.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col h-full w-full bg-[#0F0F10] border-l border-white/[0.06] overflow-hidden"
    >
      {/* Tab Bar — identical aesthetic to main agent header */}
      <div className="flex items-center border-b border-white/[0.06] bg-[#141416] shrink-0">
        {/* Agent Tabs */}
        <div className="flex-1 flex items-center overflow-x-auto hide-scrollbar px-1.5 py-1.5 gap-0.5">
          {agents.map(agent => {
            const isSelected = agent.name === selectedAgent;
            const isClosed = agent.status === 'closed';
            return (
              <button
                key={agent.name}
                type="button"
                onClick={() => setActiveTab(agent.name)}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition-all shrink-0 cursor-pointer select-none
                  ${isSelected
                    ? 'bg-white/[0.08] text-white/90 shadow-sm'
                    : isClosed
                      ? 'text-white/25 hover:bg-white/[0.03]'
                      : 'text-white/55 hover:bg-white/[0.04] hover:text-white/75'
                  }`}
              >
                <AgentAvatar name={agent.name} size={20} />
                <span className={isClosed ? 'line-through' : ''}>{agent.name}</span>
                <StatusDot status={agent.status} />
              </button>
            );
          })}
        </div>
        {/* Close panel button */}
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/70 mr-1.5"
          aria-label="Close agent panel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Agent Header Bar — shows current agent info + controls */}
      {currentAgent && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.04] bg-[#121214] shrink-0">
          <AgentAvatar name={currentAgent.name} size={32} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-white/90">{currentAgent.name}</span>
              <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider
                ${currentAgent.status === 'working' || currentAgent.status === 'spawning' ? 'bg-emerald-500/10 text-emerald-400'
                  : currentAgent.status === 'paused' ? 'bg-amber-500/10 text-amber-400'
                  : currentAgent.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400'
                  : currentAgent.status === 'error' ? 'bg-red-500/10 text-red-400'
                  : currentAgent.status === 'closed' ? 'bg-white/[0.04] text-white/30'
                  : 'bg-white/[0.04] text-white/40'
                }`}>
                {currentAgent.status}
              </span>
            </div>
            <div className="text-[11px] text-white/35 mt-0.5 truncate">
              {currentAgent.currentAction || currentAgent.task || 'Ready'}
            </div>
          </div>
          {/* Control Buttons */}
          {currentAgent.status !== 'closed' && currentAgent.status !== 'completed' && (
            <div className="flex items-center gap-1 shrink-0">
              {(currentAgent.status === 'working' || currentAgent.status === 'spawning') && (
                <button
                  type="button"
                  onClick={() => handleControl('pause', currentAgent.name)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-amber-500/10 hover:text-amber-400"
                  title="Pause agent"
                >
                  <Pause className="w-3.5 h-3.5" />
                </button>
              )}
              {currentAgent.status === 'paused' && (
                <button
                  type="button"
                  onClick={() => handleControl('resume', currentAgent.name)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-emerald-500/10 hover:text-emerald-400"
                  title="Resume agent"
                >
                  <Play className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => handleControl('close', currentAgent.name)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-red-500/10 hover:text-red-400"
                title="Close agent"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Chat Feed — same component as main agent */}
      <div className="flex-1 overflow-hidden relative">
        {selectedAgent ? (
          <ChatFeed
            key={selectedAgent}
            traceLogs={currentLogs}
            isThinking={isAgentWorking || false}
            messagesEndRef={messagesEndRef}
            setSidebarOpen={() => {}}
            sidebarOpen={false}
            handleScroll={() => {}}
            showScrollBottom={false}
            isCompressed={false}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-white/30">
            Select an agent to view their work
          </div>
        )}
      </div>

      {/* Chat Input — simplified version for sub-agent messaging */}
      {selectedAgent && currentAgent && currentAgent.status !== 'closed' && (
        <div className="shrink-0 border-t border-white/[0.06] bg-[#121214] px-4 py-3">
          <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 focus-within:border-white/[0.12] transition-colors">
            <input
              type="text"
              value={inputValues[selectedAgent] || ''}
              onChange={(e) => setInputValues(prev => ({ ...prev, [selectedAgent]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage(selectedAgent);
                }
              }}
              placeholder={`Message ${currentAgent.name}...`}
              className="flex-1 bg-transparent text-[13px] text-white/85 placeholder:text-white/25 outline-none"
            />
            <button
              type="button"
              onClick={() => handleSendMessage(selectedAgent)}
              disabled={!inputValues[selectedAgent]?.trim()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/60 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Messages end anchor */}
      <div ref={messagesEndRef} />
    </motion.div>
  );
};

export default SubAgentPanel;
