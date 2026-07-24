import React, { useState, useEffect } from 'react';
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

  return createPortal(
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
      drag
      dragMomentum={false}
      className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[999999] select-none cursor-grab active:cursor-grabbing flex flex-col items-center group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="relative flex flex-col items-center">
        {/* ═══ 3D ORGANIC ORB (210px Larger Prominent Size) ═══ */}
        <motion.div
          animate={{ scale: volumeScale }}
          transition={{ type: 'spring', stiffness: 350, damping: 20 }}
          className="relative w-[210px] h-[210px] flex items-center justify-center bg-transparent"
        >
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <AbstractBall
              perlinTime={perlinTime}
              perlinMorph={perlinMorph}
              chromaRGBr={7.5}
              chromaRGBg={5.0}
              chromaRGBb={7.0}
              cameraZoom={150}
              cameraSpeedX={0.3}
              cameraSpeedY={0.4}
              style={{ width: '210px', height: '210px' }}
            />
          </div>
        </motion.div>

        {/* ═══ MODERN ENTERPRISE HOVER CONTROL PILL BAR ═══ */}
        <AnimatePresence>
          {isHovered && (
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 450, damping: 25 }}
              className="absolute top-[142px] z-20 flex items-center gap-2 rounded-full px-3 py-1.5"
              style={{
                background: 'rgba(18, 18, 22, 0.92)',
                backdropFilter: 'blur(24px)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)'
              }}
            >
              {/* Speaker Toggle */}
              <button
                type="button"
                onClick={onToggleSpeakerMute}
                className={`w-8 h-8 flex items-center justify-center rounded-full transition-all duration-150 ${
                  isSpeakerMuted
                    ? 'text-zinc-500 bg-white/5 border border-white/5'
                    : 'text-zinc-300 hover:text-white hover:bg-white/10'
                }`}
              >
                {isSpeakerMuted ? <PremiumVolumeX className="w-4 h-4 opacity-70" /> : <PremiumVolume2 className="w-4 h-4" />}
              </button>

              {/* Mic Toggle */}
              <button
                type="button"
                onClick={onToggleMicMute}
                className={`w-8 h-8 flex items-center justify-center rounded-full transition-all duration-150 ${
                  isMicMuted
                    ? 'text-zinc-500 bg-white/5 border border-white/5'
                    : 'text-zinc-300 hover:text-white hover:bg-white/10'
                }`}
              >
                {isMicMuted ? <PremiumMicOff className="w-4 h-4 opacity-70" /> : <PremiumMic className="w-4 h-4" />}
              </button>

              {/* Close Session — Modern Sleek Enterprise Close Button */}
              <button
                type="button"
                onClick={onLiveStop}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/15 text-zinc-300 hover:text-white border border-white/5 transition-all duration-150 active:scale-95"
              >
                <X className="w-4 h-4 stroke-[2]" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>,
    document.body
  );
};
