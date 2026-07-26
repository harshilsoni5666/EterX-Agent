import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { PremiumMic, PremiumMicOff, PremiumVolume2, PremiumVolumeX } from '../ui/premium-icons';
import AbstractBall from '../ui/AbstractBall';

export interface FloatingLiveWidgetProps {
  liveState: string;
  liveMicVolume: number;
  liveModelVolume: number | number[];
  isMicMuted: boolean;
  isSpeakerMuted: boolean;
  liveActiveTool?: string | null;
  onToggleMicMute: () => void;
  onToggleSpeakerMute: () => void;
  onLiveStop: () => void;
}

export const FloatingLiveWidget: React.FC<FloatingLiveWidgetProps> = ({
  liveState,
  liveMicVolume,
  liveModelVolume,
  isMicMuted,
  isSpeakerMuted,
  liveActiveTool,
  onToggleMicMute,
  onToggleSpeakerMute,
  onLiveStop,
}) => {
  const [mounted, setMounted] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isElectron = typeof window !== 'undefined' && Boolean((window as any).electronAPI?.openPetWindow);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isElectron) {
      if (liveState !== 'idle' && liveState !== 'error') {
        let statusStr = '';
        if (liveActiveTool) {
          const toolLower = liveActiveTool.toLowerCase();
          if (toolLower.includes('search') || toolLower.includes('web')) statusStr = 'Searching';
          else if (toolLower.includes('read') || toolLower.includes('file')) statusStr = 'Reading';
          else if (toolLower.includes('write')) statusStr = 'Writing';
          else if (toolLower.includes('send') || toolLower.includes('prompt')) statusStr = 'Dispatching';
          else statusStr = 'Executing';
        } else if (liveState === 'thinking') {
          statusStr = 'Thinking';
        }
        (window as any).electronAPI.openPetWindow({
          title: 'EterX Live Agent',
          text: statusStr,
          isThinking: liveState === 'thinking' || Boolean(liveActiveTool),
        });
      } else {
        (window as any).electronAPI.closePetWindow?.();
      }
    }
  }, [liveState, liveActiveTool, isElectron]);

  if (!mounted || liveState === 'idle' || liveState === 'error' || isElectron) return null;

  const isSpeaking = liveState === 'speaking';
  const isListening = liveState === 'listening';

  const getCenterStatusText = (): string | null => {
    if (liveActiveTool) {
      const toolLower = liveActiveTool.toLowerCase();
      if (toolLower.includes('search') || toolLower.includes('web')) return 'Searching';
      if (toolLower.includes('read') || toolLower.includes('file')) return 'Reading';
      if (toolLower.includes('write')) return 'Writing';
      if (toolLower.includes('send') || toolLower.includes('prompt')) return 'Dispatching';
      if (toolLower.includes('switch') || toolLower.includes('chat')) return 'Switching';
      if (toolLower.includes('memory')) return 'Remembering';
      if (toolLower.includes('model') || toolLower.includes('agent')) return 'Configuring';
      return 'Executing';
    }
    if (liveState === 'thinking') return 'Thinking';
    return null;
  };

  const statusText = getCenterStatusText();

  let volumeScale = 1;
  let currentVol = 0;
  if (isSpeaking) {
    const avgVol = Array.isArray(liveModelVolume)
      ? liveModelVolume.reduce((a, b) => a + b, 0) / 4
      : Number(liveModelVolume);
    currentVol = avgVol;
    volumeScale = 1 + (avgVol / 100) * 0.12;
  } else if (isListening) {
    currentVol = liveMicVolume;
    volumeScale = 1 + (liveMicVolume / 100) * 0.10;
  }

  const perlinMorph = 16.0 + (currentVol / 100) * 24.0;
  const perlinTime = 22.0 + (currentVol / 100) * 28.0;

  const handlePillEnter = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHovered(true);
  };

  const handleOrbMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;
    const radius = rect.width / 2;
    const isInsideOrbArea = (dx * dx + dy * dy) <= (radius * radius * 1.05) || (isHovered && dy > 0 && dy <= radius + 35 && Math.abs(dx) <= radius);

    if (isInsideOrbArea) {
      handlePillEnter(e);
    } else {
      handleMouseLeave();
    }
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    handleOrbMouseMove(e);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 250);
  };

  return createPortal(
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
        @keyframes eterx-shimmer-anim {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      ` }} />
      <motion.div
        drag
        dragMomentum={false}
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.85 }}
        transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[999999] select-none flex flex-col items-center w-[175px]"
        style={{ pointerEvents: 'none' }}
      >
        {/* 175px PERFECT CIRCULAR ORB */}
        <motion.div
          animate={{ scale: volumeScale }}
          transition={{ type: 'spring', stiffness: 350, damping: 20 }}
          className="w-[175px] h-[175px] rounded-full overflow-hidden relative pointer-events-auto cursor-grab active:cursor-grabbing shrink-0"
          style={{
            clipPath: 'circle(50% at 50% 50%)',
            WebkitClipPath: 'circle(50% at 50% 50%)',
            border: 'none',
            outline: 'none',
            boxShadow: 'none',
          }}
        >
          {/* 3D Sphere */}
          <AbstractBall
            perlinTime={perlinTime}
            perlinMorph={perlinMorph}
            chromaRGBr={7.5}
            chromaRGBg={5.0}
            chromaRGBb={7.0}
            cameraZoom={70}
            cameraSpeedX={0.3}
            cameraSpeedY={0.4}
            style={{ width: '175px', height: '175px', borderRadius: '50%', clipPath: 'circle(50% at 50% 50%)', WebkitClipPath: 'circle(50% at 50% 50%)', pointerEvents: 'none', border: 'none', boxShadow: 'none', outline: 'none' }}
            liveState={liveState as any}
            audioVolume={currentVol}
          />

          {/* PLAIN GRAY SHIMMER TEXT — Smooth Continuous 1-Pass Linear Shimmer */}
          {statusText && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
              <span
                className="text-[16px] font-semibold tracking-wide whitespace-nowrap select-none text-transparent bg-clip-text"
                style={{
                  fontWeight: 600,
                  backgroundImage: 'linear-gradient(90deg, #09090b 0%, #e4e4e7 50%, #09090b 100%)',
                  backgroundSize: '200% 100%',
                  animation: 'eterx-shimmer-anim 3.5s linear infinite',
                  filter: 'drop-shadow(0 0 6px rgba(255, 255, 255, 0.95)) drop-shadow(0 1px 2px rgba(255, 255, 255, 0.8))'
                }}
              >
                {statusText}
              </span>
            </div>
          )}

          {/* Transparent overlay — reliable hover detection on top of canvas */}
          <div
            className="absolute inset-0 rounded-full cursor-grab active:cursor-grabbing z-20"
            style={{
              clipPath: 'circle(50% at 50% 50%)',
              WebkitClipPath: 'circle(50% at 50% 50%)',
              pointerEvents: 'auto',
            }}
            onMouseEnter={handleMouseEnter}
            onMouseMove={handleOrbMouseMove}
            onMouseLeave={handleMouseLeave}
          />
        </motion.div>

      {/* ABSOLUTE FLOATING CONTROL PILL — 100% perfectly centered below abstract ball */}
      <AnimatePresence>
        {isHovered && (
          <motion.div
            initial={{ opacity: 0, x: '-50%', y: 4, scale: 0.95 }}
            animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
            exit={{ opacity: 0, x: '-50%', y: 4, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className="absolute top-[140px] flex items-center gap-1.5 px-3 py-1.5 rounded-full pointer-events-auto z-20 shrink-0"
            style={{
              left: '50%',
              background: 'rgba(255, 255, 255, 0.96)',
              backdropFilter: 'blur(24px) saturate(1.8)',
              WebkitBackdropFilter: 'blur(24px) saturate(1.8)',
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05)',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={handlePillEnter}
            onMouseMove={handlePillEnter}
            onMouseLeave={handleMouseLeave}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePillEnter(e);
                onToggleSpeakerMute();
              }}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-all duration-150 active:scale-90 hover:bg-black/10 pointer-events-auto cursor-pointer"
              style={{ color: isSpeakerMuted ? '#ef4444' : '#374151', pointerEvents: 'auto' }}
              title={isSpeakerMuted ? "Unmute Audio" : "Mute Audio"}
            >
              {isSpeakerMuted
                ? <PremiumVolumeX className="w-4 h-4 text-red-500 pointer-events-none" />
                : <PremiumVolume2 className="w-4 h-4 text-gray-700 pointer-events-none" />}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePillEnter(e);
                onToggleMicMute();
              }}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-all duration-150 active:scale-90 hover:bg-black/10 pointer-events-auto cursor-pointer"
              style={{ color: isMicMuted ? '#ef4444' : '#374151', pointerEvents: 'auto' }}
              title={isMicMuted ? "Unmute Microphone" : "Mute Microphone"}
            >
              {isMicMuted
                ? <PremiumMicOff className="w-4 h-4 text-red-500 pointer-events-none" />
                : <PremiumMic className="w-4 h-4 text-gray-700 pointer-events-none" />}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePillEnter(e);
                onLiveStop();
              }}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-all duration-150 active:scale-90 hover:opacity-90 pointer-events-auto cursor-pointer"
              style={{
                background: 'linear-gradient(135deg, #27272a, #09090b)',
                color: '#ffffff',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
                pointerEvents: 'auto',
              }}
              title="Close Live Session"
            >
              <X className="w-3.5 h-3.5 stroke-[2.5] pointer-events-none" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      </motion.div>
    </>,
    document.body
  );
};
