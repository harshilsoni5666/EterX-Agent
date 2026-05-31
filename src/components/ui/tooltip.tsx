import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

const tooltipMeasureCache = new Map<string, number>();
let tooltipMeasureCanvas: HTMLCanvasElement | null = null;

const measureTooltipText = (text: string, font: string) => {
  const key = `${font}::${text}`;
  const cached = tooltipMeasureCache.get(key);
  if (cached !== undefined) return cached;

  let width = text.length * 7.2;
  try {
    tooltipMeasureCanvas = tooltipMeasureCanvas || document.createElement('canvas');
    const context = tooltipMeasureCanvas.getContext('2d');
    if (context) {
      context.font = font;
      width = context.measureText(text).width;
    }
  } catch { }

  tooltipMeasureCache.set(key, width);
  if (tooltipMeasureCache.size > 220) {
    const firstKey = tooltipMeasureCache.keys().next().value;
    if (firstKey) tooltipMeasureCache.delete(firstKey);
  }

  return width;
};

export const Tooltip = ({
  children,
  text,
  side = 'bottom',
  variant = 'light',
  disabled = false,
}: {
  children: React.ReactNode;
  text: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  variant?: 'light' | 'dark';
  disabled?: boolean;
}) => {
  const [visible, setVisible] = useState(false);
  const [isPositioned, setIsPositioned] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0, width: 96, arrowLeft: 43, arrowTop: 10 });
  const ref = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  const tooltipFontFamily = '"Google Sans Text", "Google Sans", "Product Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  const handleMouseEnter = () => {
    if (disabled) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setVisible(true);
    }, 120); // 120ms enter delay prevents tooltip spam on fast cursor sweep
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setVisible(false);
      setIsPositioned(false);
    }, 50); // 50ms leave delay acts as active window transition buffer
  };

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!disabled) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setVisible(false);
    setIsPositioned(false);
  }, [disabled]);

  useEffect(() => {
    if (disabled || !visible || !ref.current || typeof window === 'undefined') return;

    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
    
    let isTicking = false;
    const updatePosition = () => {
      const trigger = ref.current;
      if (!trigger) {
        isTicking = false;
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const margin = 16;
      const gap = 10;
      const tooltipFont = `600 12px ${tooltipFontFamily}`;
      const measuredTextWidth = measureTooltipText(text, tooltipFont);
      const width = Math.min(
        window.innerWidth - margin * 2,
        Math.max(76, Math.ceil(measuredTextWidth + 32))
      );
      const height = 30;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      let left = centerX - width / 2;
      let top = rect.bottom + gap;

      if (side === 'top') {
        top = rect.top - gap - height;
      } else if (side === 'left') {
        left = rect.left - gap - width;
        top = centerY - height / 2;
      } else if (side === 'right') {
        left = rect.right + gap;
        top = centerY - height / 2;
      }

      left = clamp(left, margin, window.innerWidth - margin - width);
      top = clamp(top, margin, window.innerHeight - margin - height);

      setCoords({
        left,
        top,
        width,
        arrowLeft: clamp(centerX - left - 5, 16, width - 26),
        arrowTop: clamp(centerY - top - 5, 10, height - 20),
      });
      
      setIsPositioned(true);
      isTicking = false;
    };

    const handleUpdate = () => {
      if (!isTicking) {
        isTicking = true;
        window.requestAnimationFrame(updatePosition);
      }
    };

    // Run first position update immediately
    updatePosition();

    window.addEventListener('resize', handleUpdate, { passive: true });
    window.addEventListener('scroll', handleUpdate, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, { capture: true });
    };
  }, [disabled, visible, side, text]);

  const arrowClass = {
    top: variant === 'dark' ? "border-b border-r border-white/[0.08]" : "border-b border-r border-white",
    bottom: variant === 'dark' ? "border-t border-l border-white/[0.08]" : "border-t border-l border-white",
    left: variant === 'dark' ? "border-t border-r border-white/[0.08]" : "border-t border-r border-white",
    right: variant === 'dark' ? "border-b border-l border-white/[0.08]" : "border-b border-l border-white"
  };

  const arrowStyle =
    side === 'top' ? { left: coords.arrowLeft, bottom: -5 } :
      side === 'bottom' ? { left: coords.arrowLeft, top: -5 } :
        side === 'left' ? { right: -5, top: coords.arrowTop } :
          { left: -5, top: coords.arrowTop };

  return (
    <div ref={ref} className="relative flex items-center justify-center shrink-0" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {children}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {visible && (
            <div 
              style={{ 
                position: 'fixed', 
                left: coords.left, 
                top: coords.top, 
                zIndex: 99999, 
                width: coords.width,
                opacity: isPositioned ? 1 : 0, // Prevent coordinate layout position flash
                transition: 'opacity 80ms ease'
              }} 
              className="pointer-events-none"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: side === 'top' ? 4 : side === 'bottom' ? -4 : side === 'left' ? 4 : -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
              >
                <div
                  data-side={side}
                  data-variant={variant}
                  className={`eterx-tooltip-card relative w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-[10px] px-2.5 py-1.5 text-center text-[12px] font-semibold tracking-[0.005em] shadow-[0_10px_22px_rgba(0,0,0,0.22)] ${
                    variant === 'dark'
                      ? 'border border-white/[0.08] bg-[#2C2C2C] text-[#D4D1CB] shadow-[0_14px_32px_rgba(0,0,0,0.38),inset_0_1px_0_rgba(255,255,255,0.05)]'
                      : 'border border-white bg-white text-[#1F2933] shadow-[0_10px_22px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,1)]'
                  }`}
                  style={{ fontFamily: tooltipFontFamily, willChange: 'transform, opacity' }}
                >
                  {text}
                  <div
                    className={`eterx-tooltip-arrow absolute h-2.5 w-2.5 rotate-45 ${variant === 'dark' ? 'bg-[#2C2C2C]' : 'bg-white'} ${arrowClass[side]}`}
                    style={arrowStyle}
                  />
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
};
