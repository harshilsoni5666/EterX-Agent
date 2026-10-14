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
  showOnFocus = false,
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
  showOnFocus?: boolean;
}) => {
  const [visible, setVisible] = useState(false);
  const [isPositioned, setIsPositioned] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0, width: 96, arrowLeft: 43, arrowTop: 10 });
  const ref = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const dismissedRef = useRef(false);
  const tooltipFontFamily = '"Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif';

  const handleMouseEnter = () => {
    hoveredRef.current = true;
    if (disabled) return;
    dismissedRef.current = false;
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
    hoveredRef.current = false;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    if (showOnFocus && focusedRef.current) return;
    hoverTimerRef.current = setTimeout(() => {
      setVisible(false);
      setIsPositioned(false);
    }, 40);
  };

  const handleFocus = () => {
    if (!showOnFocus || disabled) return;
    focusedRef.current = true;
    dismissedRef.current = false;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setVisible(true);
  };

  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!showOnFocus) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    focusedRef.current = false;
    if (hoveredRef.current && !dismissedRef.current && !disabled) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setVisible(false);
    setIsPositioned(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!showOnFocus || event.key !== 'Escape' || (!visible && !hoverTimerRef.current)) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    dismissedRef.current = true;
    setVisible(false);
    setIsPositioned(false);
    event.stopPropagation();
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
    
    let frame = 0;
    const updatePosition = () => {
      const trigger = ref.current;
      if (!trigger) {
        frame = 0;
        return;
      }
      const rect = trigger.getBoundingClientRect();
      if (!rect.width || !rect.height) { setVisible(false); setIsPositioned(false); frame = 0; return; }
      const margin = 12;
      const gap = 8;
      const pane = trigger.closest('.eterx-conversation-pane, .eterx-side-workspace, .eterx-main-header')?.getBoundingClientRect();
      const minLeft = Math.max(margin, pane ? pane.left + 6 : margin);
      const maxRight = Math.min(window.innerWidth - margin, pane ? pane.right - 6 : window.innerWidth - margin);
      const tooltipFont = `500 12px ${tooltipFontFamily}`;
      const measuredTextWidth = measureTooltipText(text || '', tooltipFont);
      const width = Math.min(
        Math.max(40, maxRight - minLeft),
        content
          ? Math.max(68, contentWidth || 248)
          : Math.max(68, Math.ceil(measuredTextWidth + 32))
      );
      const height = content ? Math.max(28, contentHeight || 96) : Math.max(28, contentHeight || 28);
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

      left = clamp(left, minLeft, Math.max(minLeft, maxRight - width));
      top = clamp(top, margin, window.innerHeight - margin - height);

      setCoords({
        left,
        top,
        width,
        arrowLeft: clamp(centerX - left - 4, 14, width - 24),
        arrowTop: clamp(centerY - top - 4, 8, height - 18),
      });
      
      setIsPositioned(true);
      frame = 0;
    };

    const handleUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updatePosition);
    };

    updatePosition();
    const resizeObserver = new ResizeObserver(handleUpdate);
    resizeObserver.observe(ref.current);
    const paneElement = ref.current.closest('.eterx-conversation-pane, .eterx-side-workspace, .eterx-main-header');
    if (paneElement) resizeObserver.observe(paneElement);

    window.addEventListener('resize', handleUpdate, { passive: true });
    window.addEventListener('scroll', handleUpdate, { capture: true, passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
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
    <div ref={ref} className="relative flex items-center justify-center shrink-0" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onFocusCapture={handleFocus} onBlurCapture={handleBlur} onKeyDownCapture={handleKeyDown}>
      {children}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {visible && (
            <div role="tooltip"
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
                  className={`eterx-tooltip-card relative w-full overflow-hidden rounded-[16px] border border-white/[0.12] bg-[#242424] text-[12px] font-medium text-[#F2F0EC] shadow-none ${content ? '' : 'flex items-center justify-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-center text-ellipsis'} ${cardClassName}`}
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
