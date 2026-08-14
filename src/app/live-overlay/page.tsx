'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import AbstractBall from '../../components/ui/AbstractBall';
import { useLiveOrbTheme } from '../../components/ui/live-orb-theme';
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
  const [micVolume, setMicVolume] = useState(0);
  const [modelVolume, setModelVolume] = useState<number | number[]>(0);
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hoverSurfaceRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const dragFrameRef = useRef<number | null>(null);

  const [statusText, setStatusText] = useState<string | null>(null);
  const orbTheme = useLiveOrbTheme(liveState !== 'idle' && liveState !== 'error');

  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.documentElement.style.background = 'none';
    document.body.style.background = 'none';

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
        if (typeof status?.micVolume === 'number' && Number.isFinite(status.micVolume)) {
          setMicVolume(Math.min(100, Math.max(0, status.micVolume)));
        }
        if (Array.isArray(status?.modelVolume)) {
          setModelVolume(status.modelVolume.slice(0, 8).map((value: unknown) => (
            Math.min(100, Math.max(0, Number(value) || 0))
          )));
        } else if (typeof status?.modelVolume === 'number' && Number.isFinite(status.modelVolume)) {
          setModelVolume(Math.min(100, Math.max(0, status.modelVolume)));
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
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    };
  }, []);

  const handlePillEnter = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHovered(true);
  };

  const handleMouseLeave = (e?: React.MouseEvent) => {
    const nextTarget = e?.relatedTarget;
    if (nextTarget instanceof Node && hoverSurfaceRef.current?.contains(nextTarget)) return;
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 180);
  };

  const handleOrbPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      originX: window.screenX,
      originY: window.screenY,
    };
  };

  const handleOrbPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const nextPosition = {
      x: Math.round(dragState.originX + event.screenX - dragState.startX),
      y: Math.round(dragState.originY + event.screenY - dragState.startY),
    };
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = requestAnimationFrame(() => {
      (window as any).electronAPI?.movePetWindow?.(nextPosition);
      dragFrameRef.current = null;
    });
  };

  const handleOrbPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const isSpeaking = liveState === 'speaking';
  const isListening = liveState === 'listening';
  const normalizedModelVolume = Array.isArray(modelVolume)
    ? modelVolume.reduce((total, value) => total + (Number(value) || 0), 0) / Math.max(1, modelVolume.length)
    : Number(modelVolume) || 0;
  const currentVolume = isSpeaking
    ? normalizedModelVolume
    : isListening
      ? micVolume
      : 0;
  const perlinMorph = 16.0 + (currentVolume / 100) * 24.0;
  const perlinTime = 22.0 + (currentVolume / 100) * 28.0;

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
        <div ref={hoverSurfaceRef} className="flex flex-col items-center pointer-events-none relative" style={{ width: LIVE_ORB_SIZE }}>
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
              audioVolume={currentVolume}
              orbTheme={orbTheme}
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
                    backgroundImage: `linear-gradient(90deg, ${orbTheme.statusStart} 0%, ${orbTheme.statusMid} 50%, ${orbTheme.statusEnd} 100%)`,
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
                border: `1px solid ${orbTheme.border}`,
                transform: 'translateZ(0)',
              }}
            />

            <div
              className="absolute inset-0 rounded-full cursor-grab active:cursor-grabbing z-40"
              style={{
                clipPath: 'circle(50% at 50% 50%)',
                WebkitClipPath: 'circle(50% at 50% 50%)',
                pointerEvents: 'auto',
                WebkitAppRegion: 'no-drag',
                touchAction: 'none',
              } as any}
              onMouseEnter={handlePillEnter}
              onMouseMove={handlePillEnter}
              onMouseLeave={handleMouseLeave}
              onPointerDown={handleOrbPointerDown}
              onPointerMove={handleOrbPointerMove}
              onPointerUp={handleOrbPointerUp}
              onPointerCancel={handleOrbPointerUp}
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
                className="absolute flex items-center gap-px p-1 rounded-full pointer-events-auto z-[50] shrink-0"
                style={{
                  top: LIVE_ORB_CONTROL_TOP,
                  left: '50%',
                  background: 'rgba(255, 255, 255, 0.985)',
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
                    if (typeof window !== 'undefined' && (window as any).electronAPI?.petReply) {
                      (window as any).electronAPI.petReply(JSON.stringify({ action: 'toggle-speaker' }));
                    }
                  }}
                  className="w-[26px] h-[26px] flex items-center justify-center rounded-full transition-colors duration-150 hover:bg-black/[0.07] pointer-events-auto cursor-pointer"
                  style={{ color: isSpeakerMuted ? '#ef4444' : '#374151', pointerEvents: 'auto' }}
                  title={isSpeakerMuted ? "Unmute Audio" : "Mute Audio"}
                  aria-pressed={isSpeakerMuted}
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
                  style={{ color: isCameraEnabled ? orbTheme.primary : '#374151', pointerEvents: 'auto' }}
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
                  style={{ color: isScreenSharing ? orbTheme.primary : '#374151', pointerEvents: 'auto' }}
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
                    if (typeof window !== 'undefined' && (window as any).electronAPI?.petReply) {
                      (window as any).electronAPI.petReply(JSON.stringify({ action: 'toggle-mic' }));
                    }
                  }}
                  className="w-[26px] h-[26px] flex items-center justify-center rounded-full transition-colors duration-150 hover:bg-black/[0.07] pointer-events-auto cursor-pointer"
                  style={{ color: isMicMuted ? '#ef4444' : '#374151', pointerEvents: 'auto' }}
                  title={isMicMuted ? "Unmute Microphone" : "Mute Microphone"}
                  aria-pressed={isMicMuted}
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
                    background: orbTheme.controlGradient,
                    color: orbTheme.controlText,
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
