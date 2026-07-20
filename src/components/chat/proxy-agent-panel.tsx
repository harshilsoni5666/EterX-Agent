import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { 
  Shield, 
  Activity, 
  SlidersHorizontal, 
  Lock, 
  CheckCircle2, 
  AlertCircle, 
  Play, 
  Pause, 
  HelpCircle, 
  Info, 
  Check, 
  Terminal, 
  FileText,
  Sliders
} from 'lucide-react';
import { Tooltip } from '../ui/tooltip';

interface ProxyAgentPanelProps {
  onClose?: () => void;
}

type AutonomyMode = 'strict' | 'balanced' | 'autonomous';

interface SafetyToggle {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

interface ProxyLog {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'warning' | 'action';
  title: string;
  description: string;
}

export const ProxyAgentPanel: React.FC<ProxyAgentPanelProps> = ({ onClose }) => {
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>('balanced');
  const [isMonitoring, setIsMonitoring] = useState(true);
  const [interventionThreshold, setInterventionThreshold] = useState(75);
  const [maxSteps, setMaxSteps] = useState(25);
  
  const [safetyToggles, setSafetyToggles] = useState<SafetyToggle[]>([
    {
      id: 'cmd-approval',
      label: 'Approve Modifying Commands',
      description: 'Require user confirmation for system-altering bash/powershell executions.',
      enabled: true,
    },
    {
      id: 'file-write-lock',
      label: 'Write Verification',
      description: 'Run deep linters and sanity checks before saving file writes.',
      enabled: true,
    },
    {
      id: 'loop-prevent',
      label: 'Agent Loop Safeguard',
      description: 'Automatically intervene if the agent repeats similar tool calls in sequence.',
      enabled: true,
    },
    {
      id: 'telemetry',
      label: 'Telemetry Shielding',
      description: 'Filter sensitive environment variables and API keys from agent logs.',
      enabled: false,
    }
  ]);

  const [logs, setLogs] = useState<ProxyLog[]>([
    {
      id: '1',
      timestamp: '19:15:32',
      type: 'success',
      title: 'Output Verified',
      description: 'Proxy approved final artifact completion. No regressions detected.'
    },
    {
      id: '2',
      timestamp: '19:14:05',
      type: 'info',
      title: 'Evaluating Code Quality',
      description: 'Verified syntax tree on package modifications. 0 errors found.'
    },
    {
      id: '3',
      timestamp: '19:11:44',
      type: 'action',
      title: 'Tool execution observed',
      description: 'Grep search completed autonomously in 122ms.'
    },
    {
      id: '4',
      timestamp: '19:08:21',
      type: 'warning',
      title: 'Intervention Averted',
      description: 'Main agent self-healed workspace compilation error.'
    }
  ]);

  const handleToggle = (id: string) => {
    setSafetyToggles(prev =>
      prev.map(item => (item.id === id ? { ...item, enabled: !item.enabled } : item))
    );
  };

  const getModeInfo = (mode: AutonomyMode) => {
    switch (mode) {
      case 'strict':
        return {
          title: 'Strict Verification',
          desc: 'Proxy halts execution on any write/run action, asking for human confirmation.',
          badge: 'border-[#F87171] text-[#F87171] bg-[#F87171]/10'
        };
      case 'balanced':
        return {
          title: 'Standard Co-Pilot',
          desc: 'Proxy observes quietly, intervenes only when loops or clear errors are detected.',
          badge: 'border-[#FBBF24] text-[#FBBF24] bg-[#FBBF24]/10'
        };
      case 'autonomous':
        return {
          title: 'Full Autonomy',
          desc: 'Maximum freedom. Agent resolves sub-tasks, error recovery, and reviews autonomously.',
          badge: 'border-[#34D399] text-[#34D399] bg-[#34D399]/10'
        };
    }
  };

  const activeModeInfo = getModeInfo(autonomyMode);

  return (
    <motion.div
      initial={{ opacity: 0, x: 30 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 30 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="w-[340px] shrink-0 border-l border-black/10 dark:border-white/[0.06] bg-[#FAF9F5]/90 dark:bg-[#121212]/90 backdrop-blur-xl h-full flex flex-col relative z-20 text-black dark:text-white"
    >
      {/* Top Header */}
      <div className="h-[52px] px-5 border-b border-black/10 dark:border-white/[0.06] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="relative flex items-center justify-center">
            <Shield className="w-[18px] h-[18px] text-[#22C55E]" strokeWidth={2} />
            {isMonitoring && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[#22C55E] animate-ping" />
            )}
          </div>
          <span className="text-[12px] font-black uppercase tracking-[0.14em] text-neutral-800 dark:text-neutral-200">
            Proxy-Agent
          </span>
        </div>
        
        <div className="flex items-center gap-2">
          {/* Active status pulse */}
          <div className="flex items-center gap-1.5 rounded-full bg-black/[0.04] dark:bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold tracking-wide border border-black/5 dark:border-white/5">
            <span className={`w-1.5 h-1.5 rounded-full ${isMonitoring ? 'bg-[#22C55E]' : 'bg-neutral-400'}`} />
            <span className="text-neutral-500 dark:text-neutral-400 uppercase">
              {isMonitoring ? 'Active' : 'Paused'}
            </span>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto eterx-scrollbar p-4 flex flex-col gap-4 select-none">
        
        {/* Modern First Container: Controller Card */}
        <div className="rounded-xl border border-black/10 dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] p-4 flex flex-col gap-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <h3 className="text-[12.5px] font-bold tracking-tight text-neutral-850 dark:text-neutral-100">
                Proxy-Agent Controller
              </h3>
              <p className="text-[10px] text-neutral-500 dark:text-neutral-400">
                Supervisor loop parameters & safeguards
              </p>
            </div>
            
            <button
              onClick={() => setIsMonitoring(!isMonitoring)}
              className={`rounded-lg p-1.5 transition-all border ${
                isMonitoring 
                  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' 
                  : 'border-neutral-500/20 bg-neutral-500/10 text-neutral-400 hover:bg-neutral-500/20'
              }`}
              title={isMonitoring ? 'Pause monitoring' : 'Resume monitoring'}
            >
              {isMonitoring ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
          </div>

          <div className="h-px bg-black/10 dark:bg-white/[0.06]" />

          {/* Autonomy Mode Selector */}
          <div className="flex flex-col gap-2">
            <label className="text-[10.5px] font-semibold text-neutral-600 dark:text-neutral-400">
              Autonomy Level
            </label>
            <div className="grid grid-cols-3 gap-1 bg-black/[0.05] dark:bg-white/[0.04] p-1 rounded-lg border border-black/5 dark:border-white/5">
              {(['strict', 'balanced', 'autonomous'] as AutonomyMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setAutonomyMode(mode)}
                  className={`py-1 text-[10.5px] font-semibold rounded-md capitalize transition-all ${
                    autonomyMode === mode
                      ? 'bg-white dark:bg-[#1E1E1E] text-black dark:text-white shadow-sm border border-black/[0.06] dark:border-white/[0.05]'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-black dark:hover:text-white'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            
            {/* Mode Description Box */}
            <div className="rounded-lg bg-black/[0.03] dark:bg-white/[0.015] border border-black/[0.04] dark:border-white/[0.04] p-2.5 text-[10.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-black border uppercase tracking-wider ${activeModeInfo.badge}`}>
                  {autonomyMode}
                </span>
                <span className="font-semibold text-neutral-700 dark:text-neutral-350">
                  {activeModeInfo.title}
                </span>
              </div>
              {activeModeInfo.desc}
            </div>
          </div>

          <div className="h-px bg-black/10 dark:bg-white/[0.06]" />

          {/* Intervention Sensitivity Slider */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-[10.5px] font-semibold text-neutral-600 dark:text-neutral-400 flex items-center gap-1">
                Intervention Threshold
                <Tooltip text="How sensitive the User-Proxy is to deviations from user intent. Higher threshold means more frequent interventions.">
                  <Info className="w-3 h-3 text-neutral-500 cursor-pointer" />
                </Tooltip>
              </label>
              <span className="text-[10.5px] font-bold text-neutral-800 dark:text-neutral-200">
                {interventionThreshold}%
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="10"
                max="100"
                value={interventionThreshold}
                onChange={(e) => setInterventionThreshold(Number(e.target.value))}
                className="flex-1 accent-[#22C55E] h-1 bg-black/10 dark:bg-white/[0.08] rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>

          {/* Step Budget */}
          <div className="flex flex-col gap-2 mt-1">
            <div className="flex items-center justify-between">
              <label className="text-[10.5px] font-semibold text-neutral-600 dark:text-neutral-400 flex items-center gap-1">
                Max Autonomous Steps
                <Tooltip text="Maximum consecutive actions the main agent can execute autonomously before the User Proxy triggers a forced pause.">
                  <Info className="w-3 h-3 text-neutral-500 cursor-pointer" />
                </Tooltip>
              </label>
              <span className="text-[10.5px] font-bold text-neutral-800 dark:text-neutral-200">
                {maxSteps}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="5"
                max="100"
                step="5"
                value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
                className="flex-1 accent-[#22C55E] h-1 bg-black/10 dark:bg-white/[0.08] rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>

        </div>

        {/* Safety Options Container */}
        <div className="rounded-xl border border-black/10 dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] p-4 flex flex-col gap-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
          <h4 className="text-[11.5px] font-bold uppercase tracking-wider text-neutral-600 dark:text-neutral-400">
            Safety Safeguards
          </h4>
          
          <div className="flex flex-col gap-3">
            {safetyToggles.map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-3">
                <div className="flex flex-col min-w-0">
                  <span className="text-[11px] font-bold text-neutral-800 dark:text-neutral-200 truncate">
                    {item.label}
                  </span>
                  <span className="text-[9.5px] text-neutral-500 dark:text-neutral-400 leading-normal">
                    {item.description}
                  </span>
                </div>
                
                <button
                  onClick={() => handleToggle(item.id)}
                  className={`w-7 h-4 rounded-full transition-all relative shrink-0 border ${
                    item.enabled 
                      ? 'bg-[#22C55E] border-[#22C55E]' 
                      : 'bg-black/10 dark:bg-white/10 border-black/20 dark:border-white/20'
                  }`}
                >
                  <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-all ${
                    item.enabled ? 'left-[15px]' : 'left-0.5'
                  }`} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Autonomy Stream Log */}
        <div className="rounded-xl border border-black/10 dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] p-4 flex-1 flex flex-col gap-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] min-h-[220px]">
          <div className="flex items-center justify-between shrink-0">
            <h4 className="text-[11.5px] font-bold uppercase tracking-wider text-neutral-600 dark:text-neutral-400 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-[#22C55E]" />
              Autonomy Stream
            </h4>
            <span className="text-[9px] font-medium text-neutral-500">Live feed</span>
          </div>

          <div className="flex-1 overflow-y-auto eterx-scrollbar flex flex-col gap-3 pr-0.5">
            {logs.map((log) => (
              <div 
                key={log.id} 
                className="flex gap-2.5 text-[10.5px] border-b border-black/[0.04] dark:border-white/[0.04] pb-2.5 last:border-0 last:pb-0"
              >
                <div className="shrink-0 mt-0.5">
                  {log.type === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-[#22C55E]" />}
                  {log.type === 'info' && <Info className="w-3.5 h-3.5 text-blue-400" />}
                  {log.type === 'action' && <Terminal className="w-3.5 h-3.5 text-neutral-450 dark:text-neutral-400" />}
                  {log.type === 'warning' && <AlertCircle className="w-3.5 h-3.5 text-[#F59E0B]" />}
                </div>
                
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-neutral-850 dark:text-neutral-250 truncate">
                      {log.title}
                    </span>
                    <span className="text-[8.5px] text-neutral-500 shrink-0 font-medium font-mono">
                      {log.timestamp}
                    </span>
                  </div>
                  <span className="text-[9.5px] text-neutral-500 dark:text-neutral-400 mt-0.5 leading-relaxed">
                    {log.description}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </motion.div>
  );
};
