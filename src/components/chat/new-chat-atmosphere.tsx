'use client';

import { memo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import styles from './new-chat-atmosphere.module.css';

/** A grounded color wave with a soft crest and gently tapered sides. */
export const NewChatAtmosphere = memo(function NewChatAtmosphere() {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      aria-hidden="true"
      className={styles.field}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.9, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className={`${styles.color} ${styles.firstWave}`} />
      <div className={`${styles.color} ${styles.secondWave}`} />
      <div className={`${styles.color} ${styles.thirdWave}`} />
    </motion.div>
  );
});
