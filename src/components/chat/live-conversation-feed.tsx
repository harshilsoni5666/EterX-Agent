import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mic, MicOff, Volume2, VolumeX, Square, Sparkles, Activity,
  Globe, Terminal, Database, Clock, RefreshCw, Cpu, PhoneOff
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface LiveConversationFeedProps {
  liveState: 'idle' | 'connecting' | 'connected' | 'listening' | 'thinking' | 'speaking' | 'error';
  liveInputText: string;
  liveOutputText: string;
  liveSpokenText?: string;
  liveMicVolume: number;
  liveModelVolume: number | number[];
  liveActiveTool: string | null;
  liveCommands: any[];
  isMicMuted: boolean;
  onToggleMicMute: () => void;
  isSpeakerMuted: boolean;
  onToggleSpeakerMute: () => void;
  onStopLiveSession: () => void;
  historyTraceLogs: any[];
}

export const LiveConversationFeed: React.FC<LiveConversationFeedProps> = ({
  liveState,
  liveInputText,
  liveOutputText,
  liveSpokenText = '',
  liveMicVolume,
  liveModelVolume,
  liveActiveTool,
  liveCommands,
  isMicMuted,
  onToggleMicMute,
  isSpeakerMuted,
  onToggleSpeakerMute,
  onStopLiveSession,
  historyTraceLogs,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new transcript arrives
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveInputText, liveOutputText, liveSpokenText, liveCommands]);

  const isSpeaking = liveState === 'speaking';
  const isListening = liveState === 'listening';
  const isThinking = liveState === 'thinking';
  const isConnecting = liveState === 'connecting';

  // Filter completed live trace logs for preview
  const liveTurnLogs = historyTraceLogs.filter(l => l.isLive);

  return (
    <div className="flex flex-col w-full h-full min-h-[500px] bg-[#0D0D0E] text-[#F4F2EE] rounded-[24px] border border-white/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.6)] overflow-hidden relative backdrop-blur-2xl">
      
      {/* ═══ Top Status Header ═══ */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-white/[0.02]">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-8 h-8 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <span className="w-2.5 h-2.5 rounded-full bg-[#34D399] animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-white tracking-wide">Gemini 3.1 Live</span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[#34D399] text-[10px] font-bold tracking-wider uppercase">
                {liveState.toUpperCase()}
              </span>
            </div>
            <p className="text-[11px] text-[#8A8782] font-mono">Real-time Autonomous Voice Session</p>
          </div>
        </div>

        {/* Dynamic Tool Activity Pill */}
        <AnimatePresence mode="wait">
          {liveActiveTool && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 4 }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[12px] font-medium"
            >
              <Sparkles className="w-3.5 h-3.5 animate-spin text-amber-400" />
              <span>
                {liveActiveTool === 'web_search' && 'Searching Web...'}
                {liveActiveTool === 'run_terminal_command' && 'Running Tool...'}
                {liveActiveTool === 'store_chat_memory' && 'Updating Memory...'}
                {liveActiveTool === 'change_voice' && 'Configuring Voice...'}
                {!['web_search', 'run_terminal_command', 'store_chat_memory', 'change_voice'].includes(liveActiveTool) && `${liveActiveTool}...`}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ═══ Central Dynamic Visualizer ═══ */}
      <div className="flex flex-col items-center justify-center py-8 px-4 bg-gradient-to-b from-white/[0.015] to-transparent border-b border-white/[0.04] relative">
        <div className="relative flex items-center justify-center h-20 w-full max-w-md">
          {/* Animated 4-Band Multi-Band Equalizer Orb */}
          <div className="flex items-center justify-center gap-2 h-16">
            {Array.from({ length: 4 }).map((_, i) => {
              let h = 16;
              if (isSpeaking) {
                if (Array.isArray(liveModelVolume)) {
                  h = 16 + (liveModelVolume[i] / 100) * 36;
                } else {
                  h = 16 + ((liveModelVolume as number) / 100) * 30;
                }
              } else if (isListening) {
                h = 16 + (liveMicVolume / 100) * 28;
              }

              let animateHeight: any = Math.max(16, Math.min(52, h));
              let transitionCfg: any = { type: 'spring', stiffness: 350, damping: 20 };

              if (isConnecting) {
                animateHeight = [16, 36, 16];
                transitionCfg = { duration: 1.2, repeat: Infinity, ease: 'easeInOut', delay: i * 0.2 };
              }

              return (
                <motion.div
                  key={i}
                  className="w-4 rounded-full bg-gradient-to-t from-white/70 via-white to-emerald-400 shadow-[0_0_12px_rgba(255,255,255,0.4)]"
                  animate={{ height: animateHeight }}
                  transition={transitionCfg}
                />
              );
            })}
          </div>
        </div>

        <p className="mt-3 text-[12px] font-medium text-[#A09D98] tracking-wide">
          {isConnecting && 'Connecting to Gemini Live API...'}
          {isListening && (isMicMuted ? 'Microphone Muted' : 'Listening for your voice...')}
          {isThinking && 'Thinking and coordinating work...'}
          {isSpeaking && 'AI is speaking...'}
        </p>
      </div>

      {/* ═══ Live Conversation Stream ═══ */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 eterx-scrollbar">
        {/* Completed History Turns */}
        {liveTurnLogs.map((log, idx) => {
          if (log.type === 'user_action') {
            return (
              <div key={idx} className="flex justify-end">
                <div className="max-w-[80%] bg-[#1E1E1E] border border-white/[0.08] rounded-[18px] px-4 py-3 text-[13.5px] text-[#F2F0EC]">
                  <div className="flex items-center gap-1.5 mb-1 text-[10px] font-semibold text-[#E2765A] uppercase tracking-wider">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#E2765A]" />
                    <span>Voice Input</span>
                  </div>
                  <p>{log.text}</p>
                </div>
              </div>
            );
          }
          if (log.type === 'answer') {
            return (
              <div key={idx} className="flex justify-start">
                <div className="max-w-[85%] bg-white/[0.035] border border-white/[0.08] rounded-[18px] px-4 py-3 text-[13.5px] text-[#F2F0EC]">
                  <div className="flex items-center gap-1.5 mb-1 text-[10px] font-semibold text-[#34D399] uppercase tracking-wider">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#34D399]" />
                    <span>AI Voice Answer</span>
                  </div>
                  <div className="prose prose-invert text-[13.5px] leading-relaxed">
                    <ReactMarkdown>{log.text}</ReactMarkdown>
                  </div>
                </div>
              </div>
            );
          }
          return null;
        })}

        {/* Current Active User Speech Input */}
        {liveInputText && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex justify-end"
          >
            <div className="max-w-[80%] bg-[#252322] border border-[#E2765A]/30 rounded-[18px] px-4 py-3 text-[13.5px] text-white shadow-lg">
              <div className="flex items-center gap-1.5 mb-1 text-[10px] font-bold text-[#E2765A] uppercase tracking-wider">
                <span className="w-1.5 h-1.5 rounded-full bg-[#E2765A] animate-pulse" />
                <span>Streaming Speech...</span>
              </div>
              <p>{liveInputText}</p>
            </div>
          </motion.div>
        )}

        {/* Current Active Model Speech Output */}
        {liveOutputText && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex justify-start"
          >
            <div className="max-w-[85%] bg-[#1A1F1D] border border-[#34D399]/30 rounded-[18px] px-4 py-3 text-[13.5px] text-white shadow-lg">
              <div className="flex items-center gap-1.5 mb-1 text-[10px] font-bold text-[#34D399] uppercase tracking-wider">
                <span className="w-1.5 h-1.5 rounded-full bg-[#34D399] animate-pulse" />
                <span>AI Spoken Response</span>
              </div>
              <div className="prose prose-invert text-[13.5px] leading-relaxed">
                <ReactMarkdown>{liveSpokenText || liveOutputText}</ReactMarkdown>
              </div>
            </div>
          </motion.div>
        )}

        {/* Active Tool Executions */}
        {liveCommands.map((cmd, idx) => (
          <motion.div
            key={idx}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[12px] text-[#C4C0B9]"
          >
            <Terminal className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{cmd.text}</span>
            {cmd.secondary && <span className="text-white/40 font-mono">({cmd.secondary})</span>}
          </motion.div>
        ))}
      </div>

      {/* ═══ Floating Interactive Controls Footer ═══ */}
      <div className="flex items-center justify-between px-6 py-4 border-t border-white/[0.06] bg-white/[0.02]">
        <div className="flex items-center gap-2">
          {/* Mute Speaker */}
          <button
            onClick={onToggleSpeakerMute}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-full border transition-all text-[12px] font-medium ${
              isSpeakerMuted
                ? 'bg-red-500/15 border-red-500/30 text-red-400'
                : 'bg-white/[0.05] border-white/10 text-white hover:bg-white/10'
            }`}
          >
            {isSpeakerMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            <span>{isSpeakerMuted ? 'Muted' : 'Audio On'}</span>
          </button>

          {/* Mute Mic */}
          <button
            onClick={onToggleMicMute}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-full border transition-all text-[12px] font-medium ${
              isMicMuted
                ? 'bg-red-500/15 border-red-500/30 text-red-400'
                : 'bg-white/[0.05] border-white/10 text-white hover:bg-white/10'
            }`}
          >
            {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span>{isMicMuted ? 'Mic Muted' : 'Mic Active'}</span>
          </button>
        </div>

        {/* End Call Button */}
        <button
          onClick={onStopLiveSession}
          className="flex items-center gap-2 px-5 py-2 rounded-full bg-red-600 hover:bg-red-500 text-white text-[13px] font-semibold transition-all shadow-[0_4px_16px_rgba(239,68,68,0.3)] active:scale-95 cursor-pointer"
        >
          <PhoneOff className="w-4 h-4" />
          <span>End Live Session</span>
        </button>
      </div>

    </div>
  );
};
