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

    // 1. Initial pass across the document to strip native title attributes
    const existing = document.querySelectorAll('[title]');
    existing.forEach(sanitizeElement);

    // 2. Pointer/mouse hover capture listeners to neutralize titles before browser timer fires
    const handleOver = (e: Event) => {
      let node = e.target as Element | null;
      while (node && node !== document.body && node !== document.documentElement) {
        if (node.hasAttribute && node.hasAttribute('title')) {
          sanitizeElement(node);
        }
        node = node.parentElement;
      }
    };

    window.addEventListener('mouseover', handleOver, { capture: true, passive: true });
    window.addEventListener('pointerover', handleOver, { capture: true, passive: true });

    // 3. MutationObserver to catch dynamically added or updated elements
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'title') {
          sanitizeElement(m.target as Element);
        } else if (m.type === 'childList') {
          m.addedNodes.forEach((node) => {
            if (node instanceof Element) {
              sanitizeElement(node);
              if (node.querySelectorAll) {
                node.querySelectorAll('[title]').forEach(sanitizeElement);
              }
            }
          });
        }
      }
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title'],
    });

    return () => {
      window.removeEventListener('mouseover', handleOver, { capture: true } as any);
      window.removeEventListener('pointerover', handleOver, { capture: true } as any);
      observer.disconnect();
    };
  }, []);

  return null;
};
