'use client';

import { useEffect, useRef, useState } from 'react';

/** Decorative animation only needs to run while its surface can be seen. */
export function useAnimationVisibility<T extends Element>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let intersecting = true;
    const syncVisibility = () => setVisible(intersecting && document.visibilityState !== 'hidden');
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      intersecting = entries[0]?.isIntersecting ?? false;
      syncVisibility();
    });
    observer?.observe(element);
    document.addEventListener('visibilitychange', syncVisibility);
    syncVisibility();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  }, []);

  return { ref, visible };
}
