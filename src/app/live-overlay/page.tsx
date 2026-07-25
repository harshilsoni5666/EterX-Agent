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

    if (typeof window !== 'undefined' && (window as any).electronAPI?.onPetStatus) {
      (window as any).electronAPI.onPetStatus((status: any) => {
        if (status?.text?.includes('Speaking')) setLiveState('speaking');
        else if (status?.text?.includes('Listening')) setLiveState('listening');
      });
    }
  }, []);

  const handleMouseEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 200);
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
      <style dangerouslySetInnerHTML={{ __html: 'html, body, #__next, main, div { background: transparent !important; background-color: transparent !important; margin: 0; padding: 0; overflow: hidden; width: 100vw; height: 100vh; }' }} />
      <div className="w-screen h-screen flex flex-col items-center justify-center bg-transparent select-none pointer-events-none">
        {/* INTERACTIVE UNIT: ORB + ATTACHED CONTROL PILL */}
        <div className="flex flex-col items-center justify-center bg-transparent pointer-events-auto">
          {/* 3D ORGANIC ORB SPHERE — HOVER TRIGGERS ONLY ON THIS 150px CIRCLE */}
          <div
            className="relative w-[150px] h-[150px] flex items-center justify-center bg-transparent rounded-full cursor-grab active:cursor-grabbing"
            style={{ WebkitAppRegion: 'drag' } as any}
            onMouseEnter={handleMouseEnter}
            onMouseMove={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <AbstractBall
              perlinTime={perlinTime}
              perlinMorph={perlinMorph}
              chromaRGBr={7.5}
              chromaRGBg={5.0}
              chromaRGBb={7.0}
              cameraZoom={130}
              cameraSpeedX={0.3}
              cameraSpeedY={0.4}
              style={{ width: '150px', height: '150px' }}
            />
          </div>

          {/* CONTROL PILL ATTACHED DIRECTLY UNDER THE ORB */}
          <AnimatePresence>
            {isHovered && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.94 }}
                transition={{ type: 'spring', stiffness: 450, damping: 25 }}
                className="-mt-4 z-30 flex items-center gap-2 rounded-full px-3.5 py-1.5 shadow-[0_14px_36px_rgba(0,0,0,0.85)]"
                style={{
                  background: 'rgba(16, 16, 20, 0.96)',
                  backdropFilter: 'blur(32px)',
                  border: '1px solid rgba(255, 255, 255, 0.14)',
                  WebkitAppRegion: 'no-drag',
                } as any}
                onMouseEnter={handleMouseEnter}
                onMouseMove={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
              >
                {/* Speaker Toggle */}
                <button
                  type="button"
                  onClick={() => setIsSpeakerMuted(!isSpeakerMuted)}
                  className={`w-8 h-8 flex items-center justify-center rounded-full transition-all duration-150 active:scale-95 ${
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
                  onClick={() => setIsMicMuted(!isMicMuted)}
                  className={`w-8 h-8 flex items-center justify-center rounded-full transition-all duration-150 active:scale-95 ${
                    isMicMuted
                      ? 'text-zinc-500 bg-white/5 border border-white/5'
                      : 'text-zinc-300 hover:text-white hover:bg-white/10'
                  }`}
                >
                  {isMicMuted ? <PremiumMicOff className="w-4 h-4 opacity-70" /> : <PremiumMic className="w-4 h-4" />}
                </button>

                {/* Close Session — Filled Dark Circle Button */}
                <button
                  type="button"
                  onClick={handleClose}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-zinc-200 hover:text-white border border-white/10 transition-all duration-150 active:scale-95"
                >
                  <X className="w-4 h-4 stroke-[2]" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}
