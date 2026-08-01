import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Camera, CameraOff, Monitor, X } from 'lucide-react';
import { PremiumMic, PremiumMicOff, PremiumVolume2, PremiumVolumeX } from '../ui/premium-icons';
import AbstractBall from '../ui/AbstractBall';

export interface FloatingLiveWidgetProps {
  liveState: string;
  liveMicVolume: number;
  liveModelVolume: number | number[];
  isMicMuted: boolean;
  isSpeakerMuted: boolean;
  isCameraEnabled: boolean;
  isScreenSharing: boolean;
  liveActiveTool?: string | null;
  liveActivityLabel?: string | null;
  onToggleMicMute: () => void;
  onToggleSpeakerMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onLiveStop: () => void;
}

const LIVE_ORB_SIZE = 132;
const LIVE_ORB_CONTROL_TOP = 107;

export const FloatingLiveWidget: React.FC<FloatingLiveWidgetProps> = ({
  liveState,
  liveMicVolume,
  liveModelVolume,
  isMicMuted,
  isSpeakerMuted,
  isCameraEnabled,
  isScreenSharing,
  liveActiveTool,
  liveActivityLabel,
  onToggleMicMute,
  onToggleSpeakerMute,
  onToggleCamera,
  onToggleScreenShare,
  onLiveStop,
}) => {
  const [mounted, setMounted] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [nativeOverlayFailed, setNativeOverlayFailed] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const nativeReopenTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const liveStateRef = useRef(liveState);
  const nativeStatusRef = useRef<Record<string, unknown> | null>(null);
  liveStateRef.current = liveState;

  const isElectron = typeof window !== 'undefined' && Boolean((window as any).electronAPI?.openPetWindow);

  useEffect(() => {
    setMounted(true);
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (nativeReopenTimeoutRef.current) clearTimeout(nativeReopenTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (isElectron) {
      if (liveState !== 'idle' && liveState !== 'error') {
        let statusStr = liveActivityLabel?.trim() || '';
        if (liveActiveTool) {
          const toolLower = liveActiveTool.toLowerCase();
          if (!statusStr && (toolLower.includes('search') || toolLower.includes('web'))) statusStr = 'Searching';
          else if (!statusStr && toolLower.includes('browser')) statusStr = 'Browsing';
          else if (!statusStr && toolLower.includes('screen')) statusStr = 'Viewing screen';
          else if (!statusStr && (toolLower.includes('camera') || toolLower.includes('computer'))) statusStr = 'Viewing';
          else if (!statusStr && (toolLower.includes('read') || toolLower.includes('file'))) statusStr = 'Reading';
          else if (!statusStr && toolLower.includes('write')) statusStr = 'Writing';
          else if (!statusStr && (toolLower.includes('send') || toolLower.includes('prompt'))) statusStr = 'Dispatching';
          else if (!statusStr) statusStr = 'Working';
        } else if (liveState === 'thinking') {
          statusStr = 'Thinking';
        }
        statusStr = statusStr.replace(/\s+/g, ' ').slice(0, 28);
        const nativeStatus = {
          title: 'EterX Live Agent',
          text: statusStr,
          liveState,
          isThinking: liveState === 'thinking' || Boolean(liveActiveTool),
          isMicMuted,
          isSpeakerMuted,
          isCameraEnabled,
          isScreenSharing,
        };
        nativeStatusRef.current = nativeStatus;
        Promise.resolve((window as any).electronAPI.openPetWindow(nativeStatus))
          .then(() => setNativeOverlayFailed(false))
          .catch(() => setNativeOverlayFailed(true));
      } else {
        nativeStatusRef.current = null;
        (window as any).electronAPI.closePetWindow?.();
      }
    }
  }, [liveState, liveActiveTool, liveActivityLabel, isElectron, isMicMuted, isSpeakerMuted, isCameraEnabled, isScreenSharing]);

  useEffect(() => {
    if (!isElectron) return;
    const api = (window as any).electronAPI;
    const unsubscribe = api?.onPetWindowClosed?.(() => {
      if (nativeReopenTimeoutRef.current) clearTimeout(nativeReopenTimeoutRef.current);
      nativeReopenTimeoutRef.current = setTimeout(() => {
        nativeReopenTimeoutRef.current = null;
        const currentState = liveStateRef.current;
        const currentStatus = nativeStatusRef.current;
        if (
          currentStatus &&
          currentState !== 'idle' &&
          currentState !== 'error'
        ) {
          Promise.resolve(api.openPetWindow(currentStatus))
            .then(() => setNativeOverlayFailed(false))
            .catch(() => setNativeOverlayFailed(true));
        }
      }, 280);
    });
    return () => {
      unsubscribe?.();
      if (nativeReopenTimeoutRef.current) {
        clearTimeout(nativeReopenTimeoutRef.current);
        nativeReopenTimeoutRef.current = null;
      }
    };
  }, [isElectron]);

  if (
    !mounted ||
    liveState === 'idle' ||
    liveState === 'error' ||
    (isElectron && !nativeOverlayFailed)
  ) return null;

  const isSpeaking = liveState === 'speaking';
  const isListening = liveState === 'listening';

  const getCenterStatusText = (): string | null => {
    if (liveActivityLabel?.trim()) {
      return liveActivityLabel.trim().replace(/\s+/g, ' ').slice(0, 28);
    }
    if (liveActiveTool) {
      const toolLower = liveActiveTool.toLowerCase();
      if (toolLower.includes('search') || toolLower.includes('web')) return 'Searching';
      if (toolLower.includes('browser')) return 'Browsing';
      if (toolLower.includes('screen')) return 'Viewing screen';
      if (toolLower.includes('camera') || toolLower.includes('computer')) return 'Viewing';
      if (toolLower.includes('read') || toolLower.includes('file')) return 'Reading';
      if (toolLower.includes('write')) return 'Writing';
      if (toolLower.includes('send') || toolLower.includes('prompt')) return 'Dispatching';
      if (toolLower.includes('switch') || toolLower.includes('chat')) return 'Switching';
      if (toolLower.includes('memory')) return 'Remembering';
      if (toolLower.includes('model') || toolLower.includes('agent')) return 'Configuring';
      return 'Working';
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
      <div
        className="fixed bottom-[124px] left-1/2 -translate-x-1/2 z-[999999] select-none"
        style={{ pointerEvents: 'none' }}
      >
      <motion.div
        drag
        dragMomentum={false}
        dragElastic={0}
        initial={{ opacity: 0, scale: 0.88 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        whileDrag={{ scale: 1.02 }}
        transition={{ type: 'spring', stiffness: 440, damping: 32, mass: 0.7 }}
        className="relative flex flex-col items-center"
        style={{ width: LIVE_ORB_SIZE, pointerEvents: 'none', touchAction: 'none' }}
      >
        {/* Compact circular Live orb */}
        <motion.div
          animate={{ scale: volumeScale }}
          transition={{ type: 'spring', stiffness: 350, damping: 20 }}
          className="rounded-full overflow-hidden relative pointer-events-auto cursor-grab active:cursor-grabbing shrink-0"
          style={{
            width: LIVE_ORB_SIZE,
            height: LIVE_ORB_SIZE,
            boxSizing: 'border-box',
            clipPath: 'circle(50% at 50% 50%)',
            WebkitClipPath: 'circle(50% at 50% 50%)',
            border: 'none',
            outline: 'none',
            boxShadow: 'none',
            background: 'transparent',
            transformOrigin: '50% 50%',
            backfaceVisibility: 'hidden',
            willChange: 'transform',
          }}
        >
          {/* 3D Sphere */}
          <AbstractBall
            perlinTime={perlinTime}
            perlinMorph={perlinMorph}
            chromaRGBr={7.5}
            chromaRGBg={5.0}
            chromaRGBb={7.0}
            cameraZoom={58.5}
            cameraSpeedX={0.3}
            cameraSpeedY={0.4}
            style={{ width: '100%', height: '100%', borderRadius: '50%', clipPath: 'circle(50% at 50% 50%)', WebkitClipPath: 'circle(50% at 50% 50%)', pointerEvents: 'none', border: 'none', boxShadow: 'none', outline: 'none' }}
            liveState={liveState as any}
            audioVolume={currentVol}
          />

          {/* PLAIN GRAY SHIMMER TEXT — Smooth Continuous 1-Pass Linear Shimmer */}
          {statusText && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
              <span
                className="select-none text-center text-[12px] font-semibold leading-[1.18] tracking-[0.01em] text-transparent bg-clip-text"
                style={{
                  fontWeight: 600,
                  maxWidth: 104,
                  overflowWrap: 'break-word',
                  backgroundImage: 'linear-gradient(90deg, #09090b 0%, #e4e4e7 50%, #09090b 100%)',
                  backgroundSize: '200% 100%',
                  animation: 'eterx-shimmer-anim 3.5s linear infinite',
                  filter: 'none'
                }}
              >
                {statusText}
              </span>
            </div>
          )}

          {/* Transparent overlay — reliable hover detection on top of canvas */}
          <div
            className="absolute inset-0 rounded-full pointer-events-none z-30"
            style={{
              boxSizing: 'border-box',
              border: '1px solid rgba(255, 255, 255, 0.62)',
              transform: 'translateZ(0)',
            }}
          />

          <div
            className="absolute inset-0 rounded-full cursor-grab active:cursor-grabbing z-40"
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
            className="absolute flex items-center gap-px p-1 rounded-full pointer-events-auto z-30 shrink-0"
            style={{
              top: LIVE_ORB_CONTROL_TOP,
              left: '50%',
              background: 'rgba(255, 255, 255, 0.96)',
              backdropFilter: 'blur(24px) saturate(1.8)',
              WebkitBackdropFilter: 'blur(24px) saturate(1.8)',
              boxShadow: '0 0 0 1px rgba(15, 23, 42, 0.08)',
              whiteSpace: 'nowrap',
            }}
            onPointerDown={(e) => e.stopPropagation()}
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
              className="w-[26px] h-[26px] flex items-center justify-center rounded-full transition-colors duration-150 hover:bg-black/[0.07] pointer-events-auto cursor-pointer"
              style={{ color: isSpeakerMuted ? '#ef4444' : '#374151', pointerEvents: 'auto' }}
              title={isSpeakerMuted ? "Unmute Audio" : "Mute Audio"}
            >
              {isSpeakerMuted
                ? <PremiumVolumeX className="w-3.5 h-3.5 text-red-500 pointer-events-none" />
                : <PremiumVolume2 className="w-3.5 h-3.5 text-gray-600 pointer-events-none" />}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePillEnter(e);
                onToggleScreenShare();
              }}
              className="w-[26px] h-[26px] flex items-center justify-center rounded-full transition-colors duration-150 hover:bg-black/[0.07] pointer-events-auto cursor-pointer"
              style={{ color: isScreenSharing ? '#1688EE' : '#374151', pointerEvents: 'auto' }}
              title={isScreenSharing ? 'Stop sharing screen' : 'Share screen with Live'}
              aria-pressed={isScreenSharing}
            >
              <Monitor className="w-3.5 h-3.5 pointer-events-none" />
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePillEnter(e);
                onToggleCamera();
              }}
              className="w-[26px] h-[26px] flex items-center justify-center rounded-full transition-colors duration-150 hover:bg-black/[0.07] pointer-events-auto cursor-pointer"
              style={{ color: isCameraEnabled ? '#1688EE' : '#374151', pointerEvents: 'auto' }}
              title={isCameraEnabled ? 'Stop Camera' : 'Start Camera'}
              aria-pressed={isCameraEnabled}
            >
              {isCameraEnabled
                ? <Camera className="w-3.5 h-3.5 pointer-events-none" />
                : <CameraOff className="w-3.5 h-3.5 text-gray-600 pointer-events-none" />}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePillEnter(e);
                onToggleMicMute();
              }}
              className="w-[26px] h-[26px] flex items-center justify-center rounded-full transition-colors duration-150 hover:bg-black/[0.07] pointer-events-auto cursor-pointer"
              style={{ color: isMicMuted ? '#ef4444' : '#374151', pointerEvents: 'auto' }}
              title={isMicMuted ? "Unmute Microphone" : "Mute Microphone"}
            >
              {isMicMuted
                ? <PremiumMicOff className="w-3.5 h-3.5 text-red-500 pointer-events-none" />
                : <PremiumMic className="w-3.5 h-3.5 text-gray-600 pointer-events-none" />}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePillEnter(e);
                onLiveStop();
              }}
              className="w-[26px] h-[26px] flex items-center justify-center rounded-full transition-colors duration-150 hover:brightness-105 pointer-events-auto cursor-pointer"
              style={{
                background: 'linear-gradient(145deg, #39A9FF, #1688EE)',
                color: '#ffffff',
                boxShadow: 'none',
                pointerEvents: 'auto',
              }}
              title="Close Live Session"
            >
              <X className="w-3.5 h-3.5 stroke-[2.35] pointer-events-none" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      </motion.div>
      </div>
    </>,
    document.body
  );
};
