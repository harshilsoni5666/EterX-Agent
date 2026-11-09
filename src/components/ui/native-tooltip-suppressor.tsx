'use client';

import { useEffect } from 'react';

const sanitizeElement = (el: Element | null) => {
  if (!el || typeof el.getAttribute !== 'function') return;

  // If element has a native title attribute, neutralize it
  if (el.hasAttribute('title')) {
    const titleVal = el.getAttribute('title');
    if (titleVal) {
      if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
        el.setAttribute('aria-label', titleVal);
      }
      el.setAttribute('data-native-title', titleVal);
    }
    el.removeAttribute('title');
  }
};

/**
 * Globally suppresses native default browser tooltips (triggered by HTML title attributes)
 * across the entire application.
 * Ensures that only our defined, modern custom `<Tooltip>` components appear on hover.
 */
export const NativeTooltipSuppressor = () => {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    let listenersAttached = false;
    let firstFrame = 0;
    let secondFrame = 0;
    let activationTimer = 0;

    // Wait until the app shell is visible before changing any React-managed DOM.
    // The previous eager sweep/observer could remove title attributes while Next
    // was hydrating the page, leaving the server and client trees inconsistent.
    const activateAfterStartup = () => {
      if (listenersAttached || !document.querySelector('[data-startup-ready="true"]')) return;

      startupObserver.disconnect();
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          activationTimer = window.setTimeout(() => {
            if (!document.querySelector('[data-startup-ready="true"]')) return;
            window.addEventListener('mouseover', handleOver, { capture: true, passive: true });
            window.addEventListener('pointerover', handleOver, { capture: true, passive: true });
            listenersAttached = true;
          }, 100);
        });
      });
    };

    // Only alter a title when its element is actually hovered. This preserves
    // custom tooltip behavior without mutating the document during hydration.
    const handleOver = (e: Event) => {
      let node = e.target as Element | null;
      while (node && node !== document.body && node !== document.documentElement) {
        if (node.hasAttribute && node.hasAttribute('title')) {
          sanitizeElement(node);
        }
        node = node.parentElement;
      }
    };

    // Observe only the app's readiness marker. Watching title attributes or
    // inserted subtrees here would race with React's selective hydration.
    const startupObserver = new MutationObserver(() => {
      activateAfterStartup();
    });

    startupObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-startup-ready'],
    });
    activateAfterStartup();

    return () => {
      startupObserver.disconnect();
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(activationTimer);
      if (listenersAttached) {
        window.removeEventListener('mouseover', handleOver, true);
        window.removeEventListener('pointerover', handleOver, true);
      }
    };
  }, []);

  return null;
};
