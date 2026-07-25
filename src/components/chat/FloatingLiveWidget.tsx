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
        (window as any).electronAPI.openPetWindow({
          title: 'EterX Live Agent',
          text: liveState === 'speaking' ? 'EterX Speaking...' : liveState === 'listening' ? 'Listening...' : 'Live Session Connected',
          isThinking: liveState === 'connecting',
        });
      } else {
        (window as any).electronAPI.closePetWindow?.();
      }
    }
  }, [liveState, isElectron]);

  if (!mounted || liveState === 'idle' || liveState === 'error' || isElectron) return null;

  const isSpeaking = liveState === 'speaking';
  const isListening = liveState === 'listening';

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

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;
    const radius = rect.width / 2;
    const isInsideCircle = (dx * dx + dy * dy) <= (radius * radius);

    if (isInsideCircle) {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      setIsHovered(true);
    } else {
      handleMouseLeave();
    }
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    handleMouseMove(e);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 250);
  };

  return createPortal(
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
        {/* Transparent overlay — reliable hover detection on top of canvas */}
        <div
          className="absolute inset-0 rounded-full cursor-grab active:cursor-grabbing"
          style={{
            clipPath: 'circle(50% at 50% 50%)',
            WebkitClipPath: 'circle(50% at 50% 50%)',
            pointerEvents: 'auto',
          }}
          onMouseEnter={handleMouseEnter}
          onMouseMove={handleMouseMove}
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
            onMouseEnter={handleMouseEnter}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <button
              type="button"
              onClick={onToggleSpeakerMute}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-all duration-150 active:scale-90 hover:bg-black/5"
              style={{ color: isSpeakerMuted ? '#bbb' : '#555' }}
            >
              {isSpeakerMuted
                ? <PremiumVolumeX className="w-4 h-4" />
                : <PremiumVolume2 className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={onToggleMicMute}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-all duration-150 active:scale-90 hover:bg-black/5"
              style={{ color: isMicMuted ? '#bbb' : '#555' }}
            >
              {isMicMuted
                ? <PremiumMicOff className="w-4 h-4" />
                : <PremiumMic className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={onLiveStop}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-all duration-150 active:scale-90"
              style={{
                background: 'linear-gradient(135deg, #3B82F6, #2563EB)',
                color: '#fff',
                boxShadow: '0 1px 4px rgba(37, 99, 235, 0.3)',
              }}
            >
              <X className="w-3.5 h-3.5 stroke-[2.5]" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>,
    document.body
  );
};
