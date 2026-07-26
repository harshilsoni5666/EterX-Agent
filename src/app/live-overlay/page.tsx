'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import AbstractBall from '../../components/ui/AbstractBall';
import { PremiumMic, PremiumMicOff, PremiumVolume2, PremiumVolumeX } from '../../components/ui/premium-icons';
import { X } from 'lucide-react';

export default function LiveOverlayPage() {
  const [liveState, setLiveState] = useState<string>('listening');
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isSpeakerMuted, setIsSpeakerMuted] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

    if (typeof window !== 'undefined' && (window as any).electronAPI?.onPetStatus) {
      (window as any).electronAPI.onPetStatus((status: any) => {
        const text = status?.text || '';
        if (text) {
          const toolLower = text.toLowerCase();
          if (toolLower.includes('search') || toolLower.includes('web')) setStatusText('Searching');
          else if (toolLower.includes('read') || toolLower.includes('file')) setStatusText('Reading');
          else if (toolLower.includes('write')) setStatusText('Writing');
          else if (toolLower.includes('send') || toolLower.includes('prompt')) setStatusText('Dispatching');
          else if (toolLower.includes('switch') || toolLower.includes('chat')) setStatusText('Switching');
          else if (toolLower.includes('thinking')) setStatusText('Thinking');
          else if (toolLower.includes('executing') || toolLower.includes('tool')) setStatusText('Executing');
          else setStatusText(null);
        } else {
          setStatusText(null);
        }
      });
    }
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
    if (typeof window !== 'undefined' && (window as any).electronAPI?.closePetWindow) {
      (window as any).electronAPI.closePetWindow();
    }
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
        html, body, #__next, main { background: transparent !important; background-color: transparent !important; margin: 0; padding: 0; overflow: hidden; pointer-events: none; }
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
        <div className="flex flex-col items-center w-[175px] pointer-events-none relative">
          {/* 175px PERFECT CIRCULAR ORB */}
          <div
            className="w-[175px] h-[175px] rounded-full overflow-hidden relative pointer-events-auto cursor-grab active:cursor-grabbing shrink-0"
            style={{
              clipPath: 'circle(50% at 50% 50%)',
              WebkitClipPath: 'circle(50% at 50% 50%)',
              border: 'none',
              outline: 'none',
              boxShadow: 'none',
            }}
          >
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

            {/* Transparent overlay — reliable circular drag + hover detection */}
            <div
              className="absolute inset-0 rounded-full cursor-grab active:cursor-grabbing z-20"
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
                className="absolute top-[140px] flex items-center gap-1.5 px-3 py-1.5 rounded-full pointer-events-auto z-20 shrink-0"
                style={{
                  left: '50%',
                  background: 'rgba(255, 255, 255, 0.96)',
                  backdropFilter: 'blur(24px) saturate(1.8)',
                  WebkitBackdropFilter: 'blur(24px) saturate(1.8)',
                  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05)',
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
                    const next = !isMicMuted;
                    setIsMicMuted(next);
                    if (typeof window !== 'undefined' && (window as any).electronAPI?.petReply) {
                      (window as any).electronAPI.petReply(JSON.stringify({ action: 'toggle-mic', muted: next }));
                    }
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
                    handleClose();
                  }}
                  className="w-7 h-7 flex items-center justify-center rounded-full transition-all duration-150 active:scale-90 hover:opacity-90 pointer-events-auto cursor-pointer"
                  style={{
                    background: 'linear-gradient(135deg, #27272a, #09090b)',
                    color: '#ffffff',
                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
                    pointerEvents: 'auto',
                  }}
                  title="Close Overlay"
                >
                  <X className="w-3.5 h-3.5 stroke-[2.5] pointer-events-none" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}
