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
        if (status?.text?.includes('Speaking')) setLiveState('speaking');
        else if (status?.text?.includes('Listening')) setLiveState('listening');
      });
    }
  }, []);

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
      if (typeof window !== 'undefined' && (window as any).electronAPI?.setIgnoreMouseEvents) {
        (window as any).electronAPI.setIgnoreMouseEvents(false);
      }
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

    const startScreenX = e.screenX;
    const startScreenY = e.screenY;
    const startWinX = window.screenX;
    const startWinY = window.screenY;

    const onMove = (moveEvt: MouseEvent) => {
      const deltaX = moveEvt.screenX - startScreenX;
      const deltaY = moveEvt.screenY - startScreenY;
      if (typeof window !== 'undefined' && (window as any).electronAPI?.movePetWindow) {
        (window as any).electronAPI.movePetWindow({
          x: startWinX + deltaX,
          y: startWinY + deltaY,
        });
      }
    };

    const onUp = () => {
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
    if (typeof window !== 'undefined' && (window as any).electronAPI?.closePetWindow) {
      (window as any).electronAPI.closePetWindow();
    }
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
        html, body, #__next, main { background: transparent !important; background-color: transparent !important; margin: 0; padding: 0; overflow: hidden; }
        * { box-sizing: border-box; pointer-events: none; }
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
            {/* Transparent overlay — reliable circular drag + hover detection */}
            <div
              className="absolute inset-0 rounded-full cursor-grab active:cursor-grabbing"
              style={{
                clipPath: 'circle(50% at 50% 50%)',
                WebkitClipPath: 'circle(50% at 50% 50%)',
                pointerEvents: 'auto',
              }}
              onMouseDown={handleOrbMouseDown}
              onMouseEnter={handleMouseEnter}
              onMouseMove={handleMouseMove}
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
                  WebkitAppRegion: 'no-drag',
                } as any}
                onMouseEnter={handleMouseEnter}
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
              >
                <button
                  type="button"
                  onClick={() => setIsSpeakerMuted(!isSpeakerMuted)}
                  className="w-7 h-7 flex items-center justify-center rounded-full transition-all duration-150 active:scale-90 hover:bg-black/5"
                  style={{ color: isSpeakerMuted ? '#bbb' : '#555' }}
                >
                  {isSpeakerMuted
                    ? <PremiumVolumeX className="w-4 h-4" />
                    : <PremiumVolume2 className="w-4 h-4" />}
                </button>

                <button
                  type="button"
                  onClick={() => setIsMicMuted(!isMicMuted)}
                  className="w-7 h-7 flex items-center justify-center rounded-full transition-all duration-150 active:scale-90 hover:bg-black/5"
                  style={{ color: isMicMuted ? '#bbb' : '#555' }}
                >
                  {isMicMuted
                    ? <PremiumMicOff className="w-4 h-4" />
                    : <PremiumMic className="w-4 h-4" />}
                </button>

                <button
                  type="button"
                  onClick={handleClose}
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
        </div>
      </div>
    </>
  );
}
