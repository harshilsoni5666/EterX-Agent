/**
 * Sub-Agent Live Panel — Professional Enterprise-Grade UI
 * 
 * Shows:
 * - Live agent cards with status, progress, duration
 * - Inter-agent message feed
 * - Agent-to-agent connection lines
 * - Collapsible per-agent trace logs
 * 
 * Integrates into the thought-sequence flow via trace events.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Users, MessageCircle, Activity, Clock,
  CheckCircle2, XCircle, Loader2, ChevronDown,
  ArrowRight, Zap, Send
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface AgentInfo {
  name: string;
  status: 'spawning' | 'working' | 'completed' | 'error' | 'idle';
  task: string;
  currentAction?: string;
  stepCount: number;
  durationMs: number;
  startedAt: number;
  result?: string;
}

interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  subject: string;
  body: string;
  timestamp: number;
}

interface SubAgentPanelProps {
  traces: any[];
  isActive: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Agent Status Badge
// ═══════════════════════════════════════════════════════════════

const StatusBadge: React.FC<{ status: AgentInfo['status'] }> = ({ status }) => {
  const config = {
    spawning: { color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20', icon: <Loader2 className="w-3 h-3 animate-spin" />, label: 'Starting' },
    working: { color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20', icon: <Activity className="w-3 h-3" />, label: 'Working' },
    completed: { color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', icon: <CheckCircle2 className="w-3 h-3" />, label: 'Done' },
    error: { color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', icon: <XCircle className="w-3 h-3" />, label: 'Error' },
    idle: { color: 'text-gray-400', bg: 'bg-gray-500/10 border-gray-500/20', icon: <Clock className="w-3 h-3" />, label: 'Idle' },
  }[status];

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${config.color} ${config.bg}`}>
      {config.icon}
      {config.label}
    </span>
  );
};

// ═══════════════════════════════════════════════════════════════
// Single Agent Card
// ═══════════════════════════════════════════════════════════════

const AgentCard: React.FC<{ agent: AgentInfo; isExpanded: boolean; onToggle: () => void }> = ({
  agent, isExpanded, onToggle
}) => {
  const elapsed = agent.durationMs > 0
    ? `${(agent.durationMs / 1000).toFixed(1)}s`
    : `${((Date.now() - agent.startedAt) / 1000).toFixed(0)}s`;

  // Color ring based on status
  const ringColor = {
    spawning: 'ring-blue-500/30',
    working: 'ring-amber-500/30',
    completed: 'ring-emerald-500/30',
    error: 'ring-red-500/30',
    idle: 'ring-gray-500/30',
  }[agent.status];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="rounded-[14px] bg-[#141414] border border-white/[0.06] overflow-hidden"
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3.5 py-3 hover:bg-white/[0.02] transition-colors"
      >
        {/* Agent Avatar */}
        <div className={`relative flex h-9 w-9 items-center justify-center rounded-full bg-[#1a1a1a] ring-2 ${ringColor} shrink-0`}>
          <span className="text-[13px] font-bold text-[#D4D0CB]">
            {agent.name.charAt(0)}
          </span>
          {agent.status === 'working' && (
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-amber-400 border-2 border-[#141414] animate-pulse" />
          )}
          {agent.status === 'completed' && (
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 border-2 border-[#141414]" />
          )}
        </div>

        {/* Agent Info */}
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[#E0DCD6]">{agent.name}</span>
            <StatusBadge status={agent.status} />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] text-[#6B6660] truncate max-w-[200px]">
              {agent.currentAction || agent.task.substring(0, 50)}
            </span>
          </div>
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right">
            <div className="text-[11px] font-mono text-[#8B8580]">{elapsed}</div>
            <div className="text-[10px] text-[#555350]">{agent.stepCount} steps</div>
          </div>
          <ChevronDown className={`h-3.5 w-3.5 text-[#555350] transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* Expanded Detail */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 border-t border-white/[0.04]">
              <div className="mt-2 text-[11px] text-[#7A756F] font-mono leading-relaxed">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Zap className="w-3 h-3 text-amber-400/60" />
                  <span className="text-[#9B958D] font-semibold">Task:</span>
                </div>
                <p className="ml-4.5 text-[#8B8580]">{agent.task}</p>
                {agent.result && (
                  <>
                    <div className="flex items-center gap-1.5 mt-2 mb-1">
                      <CheckCircle2 className="w-3 h-3 text-emerald-400/60" />
                      <span className="text-[#9B958D] font-semibold">Result:</span>
                    </div>
                    <p className="ml-4.5 text-[#8B8580] max-h-[120px] overflow-y-auto whitespace-pre-wrap">
                      {agent.result.substring(0, 500)}
                    </p>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

// ═══════════════════════════════════════════════════════════════
// Message Feed Item
// ═══════════════════════════════════════════════════════════════

const MessageItem: React.FC<{ message: AgentMessage }> = ({ message }) => {
  const typeIcon = {
    info_share: '💡',
    question: '❓',
    answer: '✅',
    alert: '🚨',
    coordination: '🤝',
    discovery: '🔍',
    progress: '📊',
    handoff: '📋',
  }[message.type] || '📩';

  const age = Math.round((Date.now() - message.timestamp) / 1000);
  const ageStr = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-start gap-2.5 py-1.5"
    >
      <span className="text-[12px] mt-0.5">{typeIcon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-bold text-[#C9C5BE]">{message.from}</span>
          <ArrowRight className="w-2.5 h-2.5 text-[#555350]" />
          <span className="text-[11px] font-bold text-[#C9C5BE]">{message.to === '*' ? 'All' : message.to}</span>
          <span className="text-[9px] text-[#555350] ml-auto">{ageStr}</span>
        </div>
        <p className="text-[11px] text-[#8B8580] mt-0.5 truncate">{message.subject}</p>
      </div>
    </motion.div>
  );
};

// ═══════════════════════════════════════════════════════════════
// Main Panel
// ═══════════════════════════════════════════════════════════════

export const SubAgentLivePanel: React.FC<SubAgentPanelProps> = ({ traces, isActive }) => {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [showMessages, setShowMessages] = useState(false);

  // Build agent state from traces
  const { agents, messages } = useMemo(() => {
    const agentMap = new Map<string, AgentInfo>();
    const msgList: AgentMessage[] = [];
    let msgCounter = 0;

    for (const trace of traces) {
      if (!trace) continue;
      const name = trace.agentName || trace.subAgent;
      if (!name) continue;

      if (trace.type === 'sub_agent_spawn') {
        agentMap.set(name, {
          name,
          status: 'spawning',
          task: trace.secondary || trace.text || '',
          stepCount: 0,
          durationMs: 0,
          startedAt: Date.now(),
        });
      }
      else if (trace.type === 'sub_agent_action') {
        const existing = agentMap.get(name);
        if (existing) {
          existing.status = 'working';
          existing.currentAction = trace.text?.substring(0, 80);
          existing.stepCount = trace.agentStep || (existing.stepCount + 1);
        }
      }
      else if (trace.type === 'sub_agent_complete') {
        const existing = agentMap.get(name);
        if (existing) {
          existing.status = 'completed';
          existing.durationMs = trace.durationMs || 0;
          existing.stepCount = trace.stepCount || existing.stepCount;
          existing.result = trace.taskSummary || trace.result;
        }
      }
      else if (trace.type === 'sub_agent_error') {
        const existing = agentMap.get(name);
        if (existing) {
          existing.status = 'error';
          existing.result = trace.secondary || trace.text;
        }
      }

      // Collect inter-agent messages from traces
      if (trace.interAgentMessage) {
        msgList.push({
          id: `msg_${++msgCounter}`,
          ...trace.interAgentMessage,
          timestamp: trace.timestamp || Date.now(),
        });
      }
    }

    return {
      agents: Array.from(agentMap.values()),
      messages: msgList.slice(-20), // Keep last 20 messages
    };
  }, [traces]);

  const activeCount = agents.filter(a => a.status === 'working' || a.status === 'spawning').length;
  const completedCount = agents.filter(a => a.status === 'completed').length;

  if (agents.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="my-3 rounded-[16px] bg-[#0E0E0E] border border-white/[0.06] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.04]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-violet-500/20 to-blue-500/20 border border-violet-500/20">
            <Users className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <h3 className="text-[13px] font-bold text-[#E0DCD6]">Agent Team</h3>
            <p className="text-[10px] text-[#6B6660]">
              {activeCount > 0 ? `${activeCount} active` : ''} 
              {activeCount > 0 && completedCount > 0 ? ' · ' : ''}
              {completedCount > 0 ? `${completedCount} done` : ''}
              {agents.length > activeCount + completedCount ? ` · ${agents.length - activeCount - completedCount} other` : ''}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              onClick={() => setShowMessages(!showMessages)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider transition-colors ${
                showMessages
                  ? 'bg-violet-500/15 text-violet-400 border border-violet-500/25'
                  : 'bg-white/[0.04] text-[#8B8580] border border-white/[0.06] hover:bg-white/[0.06]'
              }`}
            >
              <MessageCircle className="w-3 h-3" />
              {messages.length}
            </button>
          )}
          {activeCount > 0 && (
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/20">
              <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />
              <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">Live</span>
            </div>
          )}
        </div>
      </div>

      {/* Agent Cards */}
      <div className="p-3 space-y-2">
        {agents.map(agent => (
          <AgentCard
            key={agent.name}
            agent={agent}
            isExpanded={expandedAgent === agent.name}
            onToggle={() => setExpandedAgent(expandedAgent === agent.name ? null : agent.name)}
          />
        ))}
      </div>

      {/* Messages Feed */}
      <AnimatePresence>
        {showMessages && messages.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 border-t border-white/[0.04]">
              <div className="flex items-center gap-1.5 mt-2.5 mb-2">
                <Send className="w-3 h-3 text-violet-400/60" />
                <span className="text-[11px] font-bold text-[#9B958D] uppercase tracking-wider">Agent Messages</span>
              </div>
              <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
                {messages.map(msg => (
                  <MessageItem key={msg.id} message={msg} />
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default SubAgentLivePanel;
