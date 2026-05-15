import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

export const Tooltip = ({ children, text, side = 'bottom' }: { children: React.ReactNode, text: string, side?: 'top' | 'bottom' | 'left' | 'right' }) => {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      let x = 0, y = 0;
      if (side === 'top') { x = rect.left + rect.width / 2; y = rect.top - 8; }
      if (side === 'bottom') { x = rect.left + rect.width / 2; y = rect.bottom + 8; }
      if (side === 'left') { x = rect.left - 8; y = rect.top + rect.height / 2; }
      if (side === 'right') { x = rect.right + 8; y = rect.top + rect.height / 2; }
      setCoords({ x, y });
    }
  }, [visible, side]);

  const originClass = {
    top: "-translate-x-1/2 -translate-y-full",
    bottom: "-translate-x-1/2",
    left: "-translate-x-full -translate-y-1/2",
    right: "-translate-y-1/2"
  };

  const arrowClass = {
    top: "bottom-[-4px] left-1/2 -translate-x-1/2 rotate-45 border-b border-r",
    bottom: "-top-[5px] left-1/2 -translate-x-1/2 rotate-45 border-t border-l",
    left: "right-[-4px] top-1/2 -translate-y-1/2 rotate-45 border-t border-r",
    right: "-left-[5px] top-1/2 -translate-y-1/2 rotate-45 border-b border-l"
  };

  return (
    <div ref={ref} className="relative flex items-center justify-center shrink-0" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      {children}
      {visible && typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          <div 
            style={{ position: 'fixed', left: coords.x, top: coords.y, zIndex: 99999 }} 
            className={`pointer-events-none ${originClass[side]}`}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: side === 'top' ? 4 : side === 'bottom' ? -4 : side === 'left' ? 4 : -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
            >
              <div className={`relative px-2.5 py-1.5 bg-[#000000] border border-white/10 text-white text-[12px] font-medium rounded-lg shadow-2xl whitespace-nowrap`}>
                {text}
                <div className={`absolute w-2.5 h-2.5 bg-[#000000] border-white/10 ${arrowClass[side]}`} />
              </div>
            </motion.div>
          </div>
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
};
