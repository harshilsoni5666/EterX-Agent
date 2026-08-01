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

export const Tooltip = React.memo(({
  children,
  text,
  content,
  contentWidth,
  contentHeight,
  cardClassName = '',
  side = 'bottom',
  variant = 'dark',
  disabled = false,
  delay = 600,
}: {
  children: React.ReactNode;
  text?: string;
  content?: React.ReactNode;
  contentWidth?: number;
  contentHeight?: number;
  cardClassName?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  variant?: 'light' | 'dark';
  disabled?: boolean;
  delay?: number;
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
    if (delay <= 0) {
      setVisible(true);
      return;
    }
    hoverTimerRef.current = setTimeout(() => {
      setVisible(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setVisible(false);
      setIsPositioned(false);
    }, 40);
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
      const margin = 12;
      const gap = 8;
      const tooltipFont = `500 12px ${tooltipFontFamily}`;
      const measuredTextWidth = measureTooltipText(text || '', tooltipFont);
      const width = Math.min(
        window.innerWidth - margin * 2,
        content
          ? Math.max(68, contentWidth || 248)
          : Math.max(68, Math.ceil(measuredTextWidth + 32))
      );
      const height = content ? Math.max(28, contentHeight || 96) : 28;
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
        arrowLeft: clamp(centerX - left - 4, 14, width - 24),
        arrowTop: clamp(centerY - top - 4, 8, height - 18),
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

    updatePosition();

    window.addEventListener('resize', handleUpdate, { passive: true });
    window.addEventListener('scroll', handleUpdate, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, { capture: true });
    };
  }, [content, contentHeight, contentWidth, disabled, visible, side, text]);

  const tooltipText = text || '';
  const hasHotkey = tooltipText.includes('@') || tooltipText.includes('⌘') || tooltipText.includes('Ctrl') || tooltipText.includes('Alt');
  const mainText = hasHotkey ? tooltipText.replace(/\s*(@|⌘|Ctrl|Alt).*/, '').trim() : tooltipText;
  const hotkeyMatch = tooltipText.match(/(@|⌘|Ctrl|Alt.*)/);
  const hotkey = hotkeyMatch ? hotkeyMatch[0].trim() : '';

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
                opacity: isPositioned ? 1 : 0,
                transition: 'opacity 0ms'
              }} 
              className="pointer-events-none"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.04, ease: 'easeOut' }}
              >
                <div
                  data-side={side}
                  className={`eterx-tooltip-card relative w-full overflow-hidden rounded-[16px] border border-white/[0.12] bg-[#242424] text-[12px] font-medium text-[#F2F0EC] shadow-[0_8px_24px_rgba(0,0,0,0.36)] ${content ? '' : 'flex items-center justify-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-center text-ellipsis'} ${cardClassName}`}
                  style={{ fontFamily: tooltipFontFamily, willChange: 'transform, opacity' }}
                >
                  {content || (
                    <>
                      <span>{mainText}</span>
                      {hotkey && (
                        <span className="inline-flex items-center justify-center rounded-md border border-white/[0.12] bg-white/[0.08] px-1.5 py-0.5 text-[10.5px] font-medium text-white/75 leading-none">
                          {hotkey}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
});
