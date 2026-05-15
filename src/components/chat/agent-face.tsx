import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  hashAgentFaceSignal,
  resolveAgentFaceExpression,
  type AgentFaceReaction,
  type LiveIndicatorMode,
} from './agent-face-model';
import {
  agentFaceController,
  ensureAgentFaceController,
  useAgentFaceSnapshot,
} from './agent-face-controller';

type AgentFaceSize = 'inline' | 'medium' | 'work' | 'welcome';

type AgentFaceProps = {
  mode?: LiveIndicatorMode;
  seed?: number;
  actionKey?: string;
  size?: AgentFaceSize;
  interactive?: boolean;
  syncWithController?: boolean;
  className?: string;
  ariaLabel?: string;
};

const sizeMap: Record<AgentFaceSize, { outer: string; faceScale: number; sparkScale: number }> = {
  inline: { outer: 'h-[20px] w-[21px]', faceScale: 0.52, sparkScale: 0 },
  medium: { outer: 'h-[32px] w-[34px]', faceScale: 0.76, sparkScale: 0.45 },
  work: { outer: 'h-[44px] w-[46px]', faceScale: 1, sparkScale: 1 },
  welcome: { outer: 'h-[58px] w-[58px]', faceScale: 1.22, sparkScale: 0.8 },
};

export const AgentFace = ({
  mode = 'idle',
  seed,
  actionKey = '',
  size = 'work',
  interactive = false,
  syncWithController = size !== 'inline',
  className = '',
  ariaLabel = 'EterX agent identity',
}: AgentFaceProps) => {
  const controllerSnapshot = useAgentFaceSnapshot(syncWithController);
  const [wiggleToken, setWiggleToken] = useState(0);
  const [reaction, setReaction] = useState<AgentFaceReaction>('none');
  const clickCountRef = useRef(0);
  const lastClickAtRef = useRef(0);
  const reactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverDroveControllerRef = useRef(false);
  const ambientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ambientFocus, setAmbientFocus] = useState({ x: 0, y: 0, lid: 0.35 });
  const effectiveMode = syncWithController ? controllerSnapshot.state : mode;
  const controllerReaction = syncWithController ? controllerSnapshot.reaction : 'none';
  const effectiveReaction = reaction !== 'none' ? reaction : controllerReaction;
  const controllerActionKey = syncWithController
    ? `${ actionKey }:${ controllerSnapshot.status }:${ controllerSnapshot.sequence }:${ controllerSnapshot.progress }`
    : actionKey;
  const resolvedSeed = seed ?? hashAgentFaceSignal(`${ effectiveMode }:${ controllerActionKey }`, 97);
  const sizeProfile = sizeMap[size];
  const face = resolveAgentFaceExpression({ mode: effectiveMode, reaction: effectiveReaction, seed: resolvedSeed, actionKey: controllerActionKey });
  const {
    active,
    isCurious,
    isLaughing,
    isSettling,
    isSleeping,
    isSurprised,
    isSkeptical,
    isWorking,
    pace,
    profile,
    gazeX,
    gazeY,
    blinkDuration,
    blinkScale,
    blinkTimes,
    blinkOpacity,
    eyeHeight,
    eyeWidth,
    eyeTop,
    eyeLeft,
    eyeFill,
    faceGradient,
    cheekLeftOpacity,
    cheekRightOpacity,
  } = face;

  useEffect(() => {
    ensureAgentFaceController();
    return () => {
      if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (size === 'inline') return;

    const scheduleAmbientFocus = () => {
      ambientTimerRef.current = setTimeout(() => {
        setAmbientFocus({
          x: (Math.random() - 0.5) * 0.56,
          y: (Math.random() - 0.5) * 0.34,
          lid: 0.24 + Math.random() * 0.42,
        });
        scheduleAmbientFocus();
      }, 1800 + Math.random() * 3400);
    };

    scheduleAmbientFocus();
    return () => {
      if (ambientTimerRef.current) clearTimeout(ambientTimerRef.current);
    };
  }, [size]);

  const resetReaction = (delay: number) => {
    if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);
    reactionTimerRef.current = setTimeout(() => setReaction('none'), delay);
  };

  const pulse = () => {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    setWiggleToken(0);
    window.requestAnimationFrame(() => setWiggleToken(now));
  };

  const handleClick = (event: React.MouseEvent) => {
    if (!interactive) return;
    event.stopPropagation();
    const now = Date.now();
    clickCountRef.current = now - lastClickAtRef.current < 680 ? clickCountRef.current + 1 : 1;
    lastClickAtRef.current = now;
    pulse();

    if (clickCountRef.current >= 4) {
      clickCountRef.current = 0;
      setReaction('curious');
      agentFaceController.flash('curious', 900);
      agentFaceController.setAttention('scan', 0.55, 1400);
      return;
    }

    if (clickCountRef.current === 2) {
      setReaction('laugh');
      agentFaceController.flash('celebrating', 1100);
      agentFaceController.burst('stars');
      resetReaction(1100);
      return;
    }

    setReaction('curious');
    agentFaceController.setAttention('scan', 0.42, 1100);
    agentFaceController.pulse('rgba(255,255,255,0.2)', 1);
    resetReaction(760);
  };

  const handleHoverStart = () => {
    if (!interactive || reaction !== 'none') return;
    setReaction('curious');
    hoverDroveControllerRef.current = agentFaceController.getSnapshot().state !== 'curious';
    agentFaceController.setState('curious');
  };

  const handleHoverEnd = () => {
    if (!interactive) return;
    setReaction('none');
    if (hoverDroveControllerRef.current && agentFaceController.getSnapshot().state === 'curious') {
      agentFaceController.setState('idle');
    }
    hoverDroveControllerRef.current = false;
  };

  const shimmerDuration = active ? 4.8 : 7.2;
  const faceScale = sizeProfile.faceScale;
  const attention = syncWithController ? controllerSnapshot.attention : 'center';
  const attentionIntensity = syncWithController ? controllerSnapshot.attentionIntensity : 0;
  const attentionPointX = syncWithController ? controllerSnapshot.attentionX : 0;
  const attentionPointY = syncWithController ? controllerSnapshot.attentionY : 0;
  const attentionMotion = (() => {
    switch (attention) {
      case 'input':
        return {
          targetX: attentionPointX * 1.05,
          targetY: 1.95 + attentionPointY * 0.72,
          driftX: [-0.08, 0.1, -0.04, 0.06],
          driftY: [0.12, 0.3, 0.05, 0.18],
          duration: 1.9,
        };
      case 'scan':
        return {
          targetX: attentionPointX * 0.4,
          targetY: attentionPointY * 0.28,
          driftX: [-1.2, 1.18, 0.64, -0.72, 0.18, -0.34],
          driftY: [-0.26, -0.08, 0.18, 0.05, -0.18, -0.04],
          duration: 5.8,
        };
      case 'work':
        return {
          targetX: 0.18 + attentionPointX * 0.35,
          targetY: 0.76 + attentionPointY * 0.34,
          driftX: [0.18, -0.12, 0.08, -0.04],
          driftY: [0.08, -0.04, 0.16, 0.02],
          duration: 2.4,
        };
      case 'listen':
        return {
          targetX: -0.24 + attentionPointX * 0.28,
          targetY: -0.72 + attentionPointY * 0.26,
          driftX: [-0.18, 0.18, -0.08, 0.05],
          driftY: [-0.08, 0.04, -0.04, 0.02],
          duration: 2.6,
        };
      case 'alert':
        return {
          targetX: attentionPointX * 0.18,
          targetY: -0.24 + attentionPointY * 0.16,
          driftX: [0, -0.22, 0.22, 0],
          driftY: [-0.02, -0.12, 0.02, -0.04],
          duration: 1.1,
        };
      default:
        return {
          targetX: 0,
          targetY: 0,
          driftX: [-0.42, 0.34, 0.12, -0.24, 0.46, -0.08, -0.36],
          driftY: [-0.1, -0.28, 0.02, 0.16, -0.08, 0.22, -0.04],
          duration: active ? pace + 2.2 : 8.4,
        };
    }
  })();
  const attentionScale = attention === 'center' ? 1 : Math.max(0.28, attentionIntensity);
  const ambientScale = attention === 'center' ? 1 : 0.22;
  const attentionTargetX = attentionMotion.targetX * attentionScale + ambientFocus.x * ambientScale;
  const attentionTargetY = attentionMotion.targetY * attentionScale + ambientFocus.y * ambientScale;
  const driftScale = attention === 'center' ? 1 : Math.max(0.16, attentionIntensity * 0.28);
  const eyeMotionX = gazeX.map((value, index) => value + attentionTargetX + attentionMotion.driftX[index % attentionMotion.driftX.length] * driftScale);
  const eyeMotionY = gazeY.map((value, index) => value + attentionTargetY + attentionMotion.driftY[index % attentionMotion.driftY.length] * driftScale);
  const eyeMotionTransition = { duration: attentionMotion.duration, repeat: Infinity, ease: [0.32, 0.02, 0.18, 1] as const };
  const isInputAttention = attention === 'input' && attentionIntensity > 0.2;
  const isScanAttention = attention === 'scan' && attentionIntensity > 0.2;
  const isWorkAttention = attention === 'work' && attentionIntensity > 0.2;
  const isListenAttention = attention === 'listen' && attentionIntensity > 0.2;
  const isAlertAttention = attention === 'alert' && attentionIntensity > 0.2;
  const motionProfile = (() => {
    switch (attention) {
      case 'input':
        return {
          outerY: [0, 0.28, 0.08, 0.22, 0],
          outerRotate: [-0.06, 0.08, -0.03, 0.04, -0.06],
          outerScale: [1, 1.004, 1.001, 1.003, 1],
          faceRotate: [-0.28, 0.18, -0.08, 0.12, -0.2],
          irisLift: 0.42,
          lidPressure: 1.18,
          duration: 3.2,
        };
      case 'scan':
        return {
          outerY: [0, -0.14, 0.08, -0.05, 0.02, 0],
          outerRotate: [-0.22, 0.18, 0.08, -0.16, 0.06, -0.08],
          outerScale: [1, 1.003, 1, 1.002, 1],
          faceRotate: [-0.38, 0.28, -0.18, 0.22, -0.1],
          irisLift: 0,
          lidPressure: 0.78,
          duration: 6.6,
        };
      case 'work':
        return {
          outerY: [0, -0.22, 0.1, -0.08, 0],
          outerRotate: [0.05, -0.06, 0.03, -0.02, 0.05],
          outerScale: [1, 1.005, 1.001, 1.004, 1],
          faceRotate: [0.08, -0.06, 0.04, -0.02, 0.08],
          irisLift: 0.2,
          lidPressure: 0.92,
          duration: 4.8,
        };
      case 'listen':
        return {
          outerY: [0, -0.3, -0.12, -0.24, 0],
          outerRotate: [-0.05, 0.08, -0.02, 0.05, -0.05],
          outerScale: [1, 1.004, 1.002, 1.003, 1],
          faceRotate: [-0.12, 0.08, -0.04, 0.06, -0.1],
          irisLift: -0.18,
          lidPressure: 0.7,
          duration: 4.1,
        };
      case 'alert':
        return {
          outerY: [0, -0.18, -0.04, -0.14, 0],
          outerRotate: [0, 0.12, -0.1, 0.04, 0],
          outerScale: [1, 1.008, 1.002, 1.005, 1],
          faceRotate: [0, 0.12, -0.12, 0.04, 0],
          irisLift: -0.06,
          lidPressure: 1.05,
          duration: 2.4,
        };
      default:
        return {
          outerY: active ? [0, -0.35, 0.12, 0] : [0, -0.16, 0.06, -0.08, 0],
          outerRotate: active ? [0, -0.08, 0.06, 0] : [-0.04, 0.06, -0.02, 0.04, -0.04],
          outerScale: [1, 1.003, 1],
          faceRotate: [-0.08, 0.1, -0.04, 0.06, -0.08],
          irisLift: 0,
          lidPressure: 0.64,
          duration: active ? pace + 1.2 : 7.6,
        };
    }
  })();
  const outerMotion = size === 'inline'
    ? { y: active ? [0, -0.25, 0] : 0, rotate: 0 }
    : { y: motionProfile.outerY, rotate: motionProfile.outerRotate, scale: motionProfile.outerScale };

  return (
    <motion.button
      type="button"
      aria-label={ariaLabel}
      tabIndex={interactive ? 0 : -1}
      onClick={handleClick}
      onHoverStart={handleHoverStart}
      onHoverEnd={handleHoverEnd}
      whileHover={interactive && size !== 'inline' ? { y: -1, scale: 1.02 } : undefined}
      whileTap={interactive ? { scale: 0.94 } : undefined}
      animate={outerMotion}
      transition={{ duration: size === 'inline' ? pace : motionProfile.duration, repeat: Infinity, ease: 'easeInOut' }}
      className={`relative z-20 shrink-0 overflow-visible rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/30 ${ interactive ? 'cursor-pointer' : 'pointer-events-none' } ${ sizeProfile.outer } ${ className }`}
    >
      <style>{`
        @keyframes eterx-agent-face-click {
          0%, 100% { transform: translateX(0); }
          18% { transform: translateX(-3px); }
          38% { transform: translateX(3px); }
          58% { transform: translateX(-1.8px); }
          76% { transform: translateX(1.2px); }
        }
        .eterx-agent-face-click { animation: eterx-agent-face-click 520ms cubic-bezier(0.2, 0.8, 0.2, 1); }
      `}</style>
      <div
        className={`absolute inset-0 ${ wiggleToken ? 'eterx-agent-face-click' : '' }`}
        onAnimationEnd={() => setWiggleToken(0)}
      >
        <motion.div
          animate={{
            x: '-50%',
            y: '-50%',
            rotate: motionProfile.faceRotate,
            scale: isLaughing
                ? [faceScale, faceScale * 1.024, faceScale * 0.998, faceScale]
                  : effectiveMode === 'error'
                    ? [faceScale, faceScale * 1.018, faceScale * 0.996, faceScale]
                  : active
                    ? [faceScale, faceScale * 1.012, faceScale * 0.998, faceScale]
                    : [faceScale, faceScale, faceScale * 1.006, faceScale],
            boxShadow: 'inset 0 2px 7px rgba(255,255,255,0.56), inset 0 -9px 16px rgba(6,24,54,0.47)'
          }}
          transition={{
            rotate: { duration: motionProfile.duration + 0.8, repeat: Infinity, ease: 'easeInOut' },
            scale: { duration: pace, repeat: Infinity, ease: 'easeInOut' }
          }}
          className="absolute left-1/2 top-1/2 h-[34px] w-[34px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full border border-white/65 ring-[1.5px] ring-white/20"
          style={{ background: faceGradient }}
        >
          <div className="pointer-events-none absolute inset-[1px] rounded-full border border-white/18" />
          <div className="pointer-events-none absolute inset-[2.5px] rounded-full shadow-[inset_0_1.5px_3px_rgba(255,255,255,0.28),inset_0_-8px_12px_rgba(3,12,34,0.32)]" />
          <span className="pointer-events-none absolute left-[7px] top-[4px] h-[7px] w-[12px] rotate-[-18deg] rounded-full bg-white/42 blur-[2px]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_74%_78%,rgba(4,13,38,0.52),transparent_44%)]" />
          <motion.span
            animate={{ opacity: active || isCurious || isLaughing ? [0.2, 0.38, 0.22] : 0.24, x: active || isLaughing ? [-5, 4, -5] : 0 }}
            transition={{ duration: pace + 0.6, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute -left-3 top-1 h-7 w-7 rounded-full bg-white/20 blur-[5px]"
          />
          <motion.span
            animate={{ x: active || isCurious || isLaughing ? [-18, 30] : [-14, 24], opacity: active || isCurious || isLaughing ? [0, 0.42, 0] : [0, 0.22, 0] }}
            transition={{ duration: shimmerDuration, repeat: Infinity, ease: 'easeInOut', delay: profile.shine }}
            className="absolute -top-2 h-11 w-[7px] rotate-[22deg] bg-white/32 blur-[3px]"
          />
          <motion.span
            animate={{ opacity: effectiveMode === 'error' ? [0.22, 0.38, 0.24] : isLaughing ? [0.22, 0.38, 0.22] : [0.16, 0.3, 0.16] }}
            transition={{ duration: pace, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute inset-x-0 top-0 h-[12px] bg-[linear-gradient(180deg,rgba(255,255,255,0.32),transparent)]"
          />
          <motion.span
              animate={{
                opacity: isInputAttention || isWorkAttention ? [0.12, 0.22, 0.14] : isAlertAttention ? [0.16, 0.28, 0.18] : [0.06, 0.13, 0.08],
                y: isInputAttention ? [0.8, 1.25, 0.95] : isWorkAttention ? [0.35, 0.75, 0.42] : isAlertAttention ? [0.62, 1, 0.72] : [0, ambientFocus.lid * motionProfile.lidPressure, 0.15],
              }}
            transition={{ duration: isInputAttention ? 1.8 : isWorkAttention ? 2.6 : isAlertAttention ? 1.7 : 4.6, repeat: Infinity, ease: 'easeInOut' }}
            className="pointer-events-none absolute inset-x-[5px] top-[8.5px] h-[3.5px] rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,0.42),rgba(255,255,255,0.02))] blur-[0.6px]"
          />
          <motion.span
            animate={{ opacity: cheekLeftOpacity, scale: active || isLaughing ? [1, 1.08, 1] : 1 }}
            transition={{ duration: pace + 1.1, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute left-[6px] top-[18px] h-[5px] w-[6px] rounded-full bg-white/40 blur-[2.5px]"
          />
          <motion.span
            animate={{ opacity: cheekRightOpacity, scale: active || isLaughing ? [1, 1.06, 1] : 1 }}
            transition={{ duration: pace + 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
            className="absolute right-[6px] top-[18.5px] h-[5px] w-[6px] rounded-full bg-white/34 blur-[2.5px]"
          />
          {!isSleeping && (
            <motion.svg
              viewBox="0 0 31 22"
              animate={{
                opacity: active || isCurious || isLaughing ? [0.1, 0.2, 0.12] : 0.12,
                y: isSurprised ? [-0.7, -0.42, -0.62] : isCurious || isLaughing ? [-0.28, -0.08, -0.2] : [0, -0.08, 0],
                rotate: isSkeptical ? [-0.6, -0.25, -0.45] : 0
              }}
              transition={{ duration: pace + 0.8, repeat: Infinity, ease: 'easeInOut' }}
              className="pointer-events-none absolute inset-x-0 top-[2px] h-[22px] w-full overflow-visible"
            >
              <path d="M8.85 10.55 C10.15 9.95 12.2 9.95 13.5 10.55" fill="none" stroke="rgba(255,255,255,0.38)" strokeWidth="0.95" strokeLinecap="round" />
              <path d="M17.5 10.55 C18.8 9.95 20.85 9.95 22.15 10.55" fill="none" stroke="rgba(255,255,255,0.38)" strokeWidth="0.95" strokeLinecap="round" />
            </motion.svg>
          )}
          <motion.div
            animate={{ x: eyeMotionX, y: eyeMotionY }}
            transition={eyeMotionTransition}
            className="absolute inset-x-0 top-[11.25px] h-[9px]"
          >
            {[0, 1].map((eye) => (
              <motion.span
                key={eye}
                animate={{
                  scaleX: isInputAttention
                    ? [1, 1.08, 1.02, 1.06]
                    : isScanAttention
                      ? [1, 0.94, 1.08, 0.98]
                      : isListenAttention
                        ? [1, 1.04, 0.98, 1.02]
                        : isAlertAttention
                          ? [1, 1.08, 1.03, 1.06]
                          : [1, 1.015, 1],
                  scaleY: controllerSnapshot.winkSide === (eye === 0 ? 'left' : 'right')
                    ? [1, 0.08, 1]
                    : blinkScale,
                  y: isWorkAttention ? [0, 0.22, 0.06, 0.16] : isListenAttention ? [-0.12, -0.3, -0.18, -0.24] : isAlertAttention ? [-0.08, -0.18, -0.1, -0.14] : 0,
                  opacity: controllerSnapshot.winkSide === (eye === 0 ? 'left' : 'right')
                    ? [1, 0.58, 1]
                    : blinkOpacity
                }}
                transition={controllerSnapshot.winkSide === (eye === 0 ? 'left' : 'right')
                  ? { duration: 0.32, times: [0, 0.42, 1], repeat: 0, ease: 'easeInOut' }
                  : { duration: blinkDuration, times: blinkTimes, repeat: Infinity, ease: 'easeInOut', delay: eye * 0.04 + profile.shine * 0.04 }
                }
                className="absolute top-0 overflow-hidden rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.68)] ring-[0.5px] ring-white/35"
                style={{
                  left: eyeLeft[eye],
                  top: eyeTop + (isSkeptical && eye === 1 ? 0.35 : 0),
                  width: eyeWidth + (isSurprised ? 0.4 : 0),
                  height: eyeHeight - (isSkeptical && eye === 1 ? 0.35 : 0),
                  background: eyeFill,
                  boxShadow: '0 0 8px rgba(255,255,255,0.68)',
                  transformOrigin: isInputAttention ? '50% 82%' : '50% 50%',
                }}
              >
                <motion.span
                  animate={{
                    opacity: isInputAttention || isWorkAttention ? [0.16, 0.3, 0.2] : isAlertAttention ? [0.2, 0.34, 0.22] : [0.08, 0.18, 0.1],
                    y: isInputAttention ? [0, 0.45, 0.15] : isWorkAttention ? [0.1, 0.34, 0.16] : isAlertAttention ? [0.18, 0.5, 0.24] : [0, ambientFocus.lid * 0.35, 0],
                  }}
                  transition={{ duration: isInputAttention ? 1.5 : isWorkAttention ? 2.4 : isAlertAttention ? 1.5 : 4.2, repeat: Infinity, ease: 'easeInOut' }}
                  className="pointer-events-none absolute inset-x-[-1px] top-[-1px] h-[2.4px] rounded-t-full bg-[#CFE6FF]/70 blur-[0.25px]"
                />
                <motion.span
                  animate={{
                    opacity: isInputAttention ? [0.9, 1, 0.92] : [0.72, 0.9, 0.76],
                    y: isInputAttention ? [0.45, 0.7, 0.5] : isListenAttention ? [-0.24, -0.42, -0.28] : [0, -0.12 + motionProfile.irisLift, motionProfile.irisLift * 0.35],
                  }}
                  transition={{ duration: isInputAttention ? 1.1 : pace + 0.7, repeat: Infinity, ease: 'easeInOut' }}
                  className="absolute left-[0.65px] top-[0.7px] h-[1.8px] w-[1.35px] rounded-full bg-white/90"
                />
                <motion.span
                  animate={{ opacity: isScanAttention ? [0.28, 0.62, 0.32] : [0.18, 0.3, 0.2] }}
                  transition={{ duration: isScanAttention ? 0.9 : pace + 0.9, repeat: Infinity, ease: 'easeInOut' }}
                  className="absolute inset-x-[0.6px] top-[2.3px] h-px rounded-full bg-[#EAF6FF]/45"
                />
                <span className="absolute inset-x-[0.7px] bottom-[0.75px] h-[1.4px] rounded-full bg-[#BFDFFF]/25 blur-[0.3px]" />
                <motion.span
                  animate={{ opacity: [0.1, 0.22, 0.12], x: isScanAttention ? [-1, 1.2, -0.6] : [0, 0.35, 0] }}
                  transition={{ duration: isScanAttention ? 1.2 : 5.4, repeat: Infinity, ease: 'easeInOut', delay: eye * 0.18 }}
                  className="pointer-events-none absolute bottom-[1px] left-[1px] h-[1.2px] w-[2.6px] rounded-full bg-[#8FC8FF]/45 blur-[0.35px]"
                />
              </motion.span>
            ))}
          </motion.div>

          <motion.span
            animate={{
              opacity: isInputAttention ? [0.18, 0.28, 0.2] : active || isCurious || isWorking ? [0.1, 0.18, 0.12] : [0.08, 0.14, 0.1],
              width: isInputAttention ? [7, 10, 8] : 8,
            }}
            transition={{ duration: isInputAttention ? 1.2 : pace + 0.9, repeat: Infinity, ease: 'easeInOut' }}
            className="pointer-events-none absolute left-1/2 top-[23px] h-[1.5px] -translate-x-1/2 rounded-full bg-white/35 blur-[1.1px]"
          />
          {sizeProfile.sparkScale > 0 && [0, 1, 2].map((spark) => (
            <motion.span
              key={spark}
              animate={{
                opacity: active || isCurious || isLaughing || isSettling ? [0, 0.42, 0] : [0, 0.18, 0],
                y: active || isLaughing ? [0, -4 - spark, 0] : [0, -2, 0],
                scale: [0.8, 1, 0.8]
              }}
              transition={{ duration: pace + spark * 0.45, repeat: Infinity, ease: 'easeInOut', delay: 0.45 + spark * 0.52 + profile.shine * 0.12 }}
              className="absolute h-[2px] w-[2px] rounded-full bg-white/80 shadow-[0_0_5px_rgba(255,255,255,0.65)]"
              style={{ left: `${ 8 + spark * 7 }px`, top: `${ 7 + (spark % 2) * 3 }px` }}
            />
          ))}
          {controllerSnapshot.burstToken > 0 && sizeProfile.sparkScale > 0 && (
            <span key={controllerSnapshot.burstToken} className="pointer-events-none absolute inset-0">
              {Array.from({ length: controllerSnapshot.burst === 'confetti' ? 12 : 8 }).map((_, particle) => {
                const angle = (Math.PI * 2 * particle) / (controllerSnapshot.burst === 'confetti' ? 12 : 8);
                const distance = controllerSnapshot.burst === 'stars' ? 20 : 16;
                return (
                  <motion.span
                    key={particle}
                    initial={{ opacity: 0, scale: 0.4, x: 16, y: 16 }}
                    animate={{
                      opacity: [0, 0.85, 0],
                      scale: [0.5, 1, 0.25],
                      x: 16 + Math.cos(angle) * distance,
                      y: 16 + Math.sin(angle) * distance,
                      rotate: particle % 2 ? 90 : -90
                    }}
                    transition={{ duration: 0.9, ease: 'easeOut', delay: particle * 0.025 }}
                    className="absolute h-[2.5px] w-[2.5px] rounded-full bg-white/85 shadow-[0_0_7px_rgba(255,255,255,0.7)]"
                  />
                );
              })}
            </span>
          )}
        </motion.div>
        {controllerSnapshot.progress > 0 && size !== 'inline' && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full -rotate-90 overflow-visible" viewBox="0 0 46 46">
            <motion.circle
              cx="23"
              cy="23"
              r="20"
              fill="none"
              stroke={controllerSnapshot.pulseColor || 'rgba(255,255,255,0.52)'}
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeDasharray={125.66}
              animate={{ strokeDashoffset: 125.66 - (125.66 * Math.min(controllerSnapshot.progress, 100)) / 100, opacity: [0.42, 0.82, 0.5] }}
              transition={{ strokeDashoffset: { duration: 0.35, ease: 'easeOut' }, opacity: { duration: 1.4, repeat: Infinity, ease: 'easeInOut' } }}
            />
          </svg>
        )}
      </div>
    </motion.button>
  );
};
