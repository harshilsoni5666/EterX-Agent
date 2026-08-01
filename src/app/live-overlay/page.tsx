'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import AbstractBall from '../../components/ui/AbstractBall';
import { PremiumMic, PremiumMicOff, PremiumVolume2, PremiumVolumeX } from '../../components/ui/premium-icons';
import { Camera, CameraOff, Monitor, X } from 'lucide-react';

const LIVE_ORB_SIZE = 132;
const LIVE_ORB_CONTROL_TOP = 107;

export default function LiveOverlayPage() {
  const [liveState, setLiveState] = useState<string>('listening');
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isSpeakerMuted, setIsSpeakerMuted] = useState(false);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isDraggingRef = useRef(false);

  const [statusText, setStatusText] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.documentElement.style.background = 'none';
    document.body.style.background = 'none';

    // Start with 100% click pass-through so invisible window area doesn't block OS clicks
    if (typeof window !== 'undefined' && (window as any).electronAPI?.setIgnoreMouseEvents) {
      (window as any).electronAPI.setIgnoreMouseEvents(true, { forward: true });
    }

    let unsubscribe: (() => void) | undefined;
    if (typeof window !== 'undefined' && (window as any).electronAPI?.onPetStatus) {
      unsubscribe = (window as any).electronAPI.onPetStatus((status: any) => {
        if (typeof status?.isMicMuted === 'boolean') {
          setIsMicMuted(status.isMicMuted);
        }
        if (typeof status?.isSpeakerMuted === 'boolean') {
          setIsSpeakerMuted(status.isSpeakerMuted);
        }
        if (typeof status?.isCameraEnabled === 'boolean') {
          setIsCameraEnabled(status.isCameraEnabled);
        }
        if (typeof status?.isScreenSharing === 'boolean') {
          setIsScreenSharing(status.isScreenSharing);
        }
        const nextState = typeof status?.liveState === 'string'
          ? status.liveState
          : status?.isThinking
            ? 'thinking'
            : 'listening';
        setLiveState(nextState);
        const text = String(status?.text || '').trim().replace(/\s+/g, ' ').slice(0, 28);
        setStatusText(text || (nextState === 'thinking' ? 'Thinking' : null));
      });
    }
    return () => {
      unsubscribe?.();
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const handlePillEnter = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHovered(true);
    if (typeof window !== 'undefined' && (window as any).electronAPI?.setIgnoreMouseEvents) {
      (window as any).electronAPI.setIgnoreMouseEvents(false);
    }
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
    if (isDraggingRef.current) return;
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
      if (typeof window !== 'undefined' && (window as any).electronAPI?.setIgnoreMouseEvents) {
        (window as any).electronAPI.setIgnoreMouseEvents(true, { forward: true });
      }
    }, 250);
  };

  const handleOrbMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;
    const radius = rect.width / 2;

    // Strict circular check: drag ONLY triggers inside true circle radius
    if (dx * dx + dy * dy > radius * radius) return;

    if (typeof window !== 'undefined' && (window as any).electronAPI?.setIgnoreMouseEvents) {
      (window as any).electronAPI.setIgnoreMouseEvents(false);
    }
    isDraggingRef.current = true;

    const startScreenX = e.screenX;
    const startScreenY = e.screenY;
    const startWinX = window.screenX;
    const startWinY = window.screenY;

    let animFrameId: number | null = null;
    let targetX = startWinX;
    let targetY = startWinY;

    const onMove = (moveEvt: MouseEvent) => {
      targetX = Math.round(startWinX + (moveEvt.screenX - startScreenX));
      targetY = Math.round(startWinY + (moveEvt.screenY - startScreenY));

      if (animFrameId === null) {
        animFrameId = requestAnimationFrame(() => {
          animFrameId = null;
          if (typeof window !== 'undefined' && (window as any).electronAPI?.movePetWindow) {
            (window as any).electronAPI.movePetWindow({ x: targetX, y: targetY });
          }
        });
      }
    };

    const onUp = () => {
      isDraggingRef.current = false;
      if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
      if (typeof window !== 'undefined' && (window as any).electronAPI?.movePetWindow) {
        (window as any).electronAPI.movePetWindow({ x: targetX, y: targetY });
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const isSpeaking = liveState === 'speaking';
  const isListening = liveState === 'listening';
  const perlinMorph = isSpeaking ? 32.0 : isListening ? 20.0 : 16.0;
  const perlinTime = isSpeaking ? 40.0 : isListening ? 25.0 : 18.0;

  const handleClose = () => {
    if (typeof window !== 'undefined' && (window as any).electronAPI?.petReply) {
      (window as any).electronAPI.petReply(JSON.stringify({ action: 'stop' }));
    }
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
        :root, html, body, #__next, main { background: transparent !important; background-color: transparent !important; margin: 0; padding: 0; overflow: hidden; pointer-events: none; color-scheme: dark; }
        body::before, body::after { display: none !important; content: none !important; }
        canvas { background: transparent !important; }
        button, a, input { pointer-events: auto !important; }
        @keyframes eterx-shimmer-anim {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      ` }} />
      <div
        className="w-screen h-screen flex flex-col items-center justify-center select-none"
        style={{ background: 'transparent', pointerEvents: 'none' }}
      >
        <div className="flex flex-col items-center pointer-events-none relative" style={{ width: LIVE_ORB_SIZE }}>
          {/* Compact circular Live orb */}
          <div
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
            }}
          >
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

            {/* Transparent overlay — reliable circular drag + hover detection */}
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
              onMouseDown={handleOrbMouseDown}
              onMouseEnter={handleMouseEnter}
              onMouseMove={handleOrbMouseMove}
              onMouseLeave={handleMouseLeave}
            />
          </div>

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
                  pointerEvents: 'auto',
                  WebkitAppRegion: 'no-drag',
                } as any}
                onMouseEnter={handlePillEnter}
                onMouseMove={handlePillEnter}
                onMouseLeave={handleMouseLeave}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePillEnter(e);
                    const next = !isSpeakerMuted;
                    setIsSpeakerMuted(next);
                    if (typeof window !== 'undefined' && (window as any).electronAPI?.petReply) {
                      (window as any).electronAPI.petReply(JSON.stringify({ action: 'toggle-speaker', muted: next }));
                    }
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
                    if (typeof window !== 'undefined' && (window as any).electronAPI?.petReply) {
                      (window as any).electronAPI.petReply(JSON.stringify({ action: 'toggle-camera' }));
                    }
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
                    if (typeof window !== 'undefined' && (window as any).electronAPI?.petReply) {
                      (window as any).electronAPI.petReply(JSON.stringify({ action: 'toggle-screen-share' }));
                    }
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
                    const next = !isMicMuted;
                    setIsMicMuted(next);
                    if (typeof window !== 'undefined' && (window as any).electronAPI?.petReply) {
                      (window as any).electronAPI.petReply(JSON.stringify({ action: 'toggle-mic', muted: next }));
                    }
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
                    handleClose();
                  }}
                  className="w-[26px] h-[26px] flex items-center justify-center rounded-full transition-colors duration-150 hover:brightness-105 pointer-events-auto cursor-pointer"
                  style={{
                    background: 'linear-gradient(145deg, #39A9FF, #1688EE)',
                    color: '#ffffff',
                    boxShadow: 'none',
                    pointerEvents: 'auto',
                  }}
                  title="Close Overlay"
                >
                  <X className="w-3.5 h-3.5 stroke-[2.35] pointer-events-none" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}
