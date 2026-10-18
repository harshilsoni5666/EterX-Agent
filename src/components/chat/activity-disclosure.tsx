'use client';

import type { ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion';

const softEase: [number, number, number, number] = [0.22, 0.8, 0.3, 1];

function DisclosureContent({ children, id, className }: {
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      id={id}
      className={className}
      style={{ overflow: 'hidden', minWidth: 0 }}
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      initial={reducedMotion ? false : { height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={reducedMotion ? { duration: 0 } : {
        height: { duration: present ? 0.22 : 0.18, ease: softEase },
        opacity: { duration: present ? 0.16 : 0.1, ease: 'easeOut' },
      }}
    >
      {children}
    </motion.div>
  );
}

/** A short reveal with a softer close; rapid toggles reverse the same motion. */
export function ActivityDisclosure({ open, children, id, className }: {
  open: boolean;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && <DisclosureContent key="content" id={id} className={className}>{children}</DisclosureContent>}
    </AnimatePresence>
  );
}
