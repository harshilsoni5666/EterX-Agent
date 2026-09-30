'use client';

import React, { useLayoutEffect, useRef } from 'react';
import { motion, type MotionProps } from 'framer-motion';

type AdaptiveMenuProps = React.HTMLAttributes<HTMLDivElement> & {
  preferredSide?: 'top' | 'bottom';
  heightLimit?: number;
  allowFlip?: boolean;
  motionProps?: Pick<MotionProps, 'initial' | 'animate' | 'exit' | 'transition'>;
};

/** Keeps an anchored menu in the visible viewport without changing its DOM
 * ancestry (theme selectors and outside-click handlers keep working). */
export function AdaptiveMenu({ preferredSide = 'bottom', heightLimit = 480, allowFlip = true, motionProps, ...props }: AdaptiveMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    const anchor = menu?.parentElement;
    if (!menu || !anchor) return;
    let frame = 0;
    const set = (property: string, value: string) => {
      if (menu.style.getPropertyValue(property) !== value || menu.style.getPropertyPriority(property) !== 'important') {
        menu.style.setProperty(property, value, 'important');
      }
    };
    const update = () => {
      const viewport = window.visualViewport;
      let leftEdge = (viewport?.offsetLeft ?? 0) + 12;
      let topEdge = (viewport?.offsetTop ?? 0) + 12;
      let rightEdge = leftEdge + (viewport?.width ?? document.documentElement.clientWidth) - 24;
      let bottomEdge = topEdge + (viewport?.height ?? document.documentElement.clientHeight) - 24;
      // A side terminal makes the conversation a smaller clipping boundary
      // than the window. Keep composer menus within that visible pane.
      const pane = anchor.closest<HTMLElement>('.eterx-conversation-pane');
      if (pane) {
        const bounds = pane.getBoundingClientRect();
        leftEdge = Math.max(leftEdge, bounds.left + 8);
        rightEdge = Math.min(rightEdge, bounds.right - 8);
        topEdge = Math.max(topEdge, bounds.top + 8);
        bottomEdge = Math.min(bottomEdge, bounds.bottom - 8);
      }
      const trigger = anchor.getBoundingClientRect();

      // Individual translate composes with the existing centering transform.
      // Convert viewport distances back to CSS pixels for scaled app surfaces.
      set('translate', '0px 0px');
      const initial = menu.getBoundingClientRect();
      const scaleX = initial.width / menu.offsetWidth || 1;
      const scaleY = initial.height / menu.offsetHeight || scaleX;
      set('max-width', `${Math.max(0, rightEdge - leftEdge) / scaleX}px`);
      set('min-width', '0px');
      set('min-height', '0px');
      // Measure hidden list content without temporarily expanding the menu:
      // expanding a scroll area can clamp its scrollTop back to zero.
      const scrollRegion = menu.querySelector<HTMLElement>('[data-menu-scroll-region]');
      const hiddenListHeight = scrollRegion ? Math.max(0, scrollRegion.scrollHeight - scrollRegion.clientHeight) : 0;
      const desiredHeight = Math.min(menu.scrollHeight + hiddenListHeight + 2, heightLimit) * scaleY;
      const above = Math.max(0, Math.min(bottomEdge, trigger.top - 8) - topEdge);
      const below = Math.max(0, bottomEdge - Math.max(topEdge, trigger.bottom + 8));
      const preferredSpace = preferredSide === 'bottom' ? below : above;
      const otherSpace = preferredSide === 'bottom' ? above : below;
      const side = !allowFlip || preferredSpace >= desiredHeight || preferredSpace >= otherSpace
        ? preferredSide : preferredSide === 'bottom' ? 'top' : 'bottom';
      const available = side === 'bottom' ? below : above;
      // Own both edges, not only a compensating translation over the caller's
      // old top/bottom classes. A React style update can remove !important;
      // restore it even when the numeric value did not change.
      set('top', side === 'bottom' ? 'calc(100% + 8px)' : 'auto');
      set('bottom', side === 'top' ? 'calc(100% + 8px)' : 'auto');
      set('max-height', `${Math.floor(Math.min(heightLimit, available / scaleY))}px`);
      const rect = menu.getBoundingClientRect();
      const left = Math.max(leftEdge, Math.min(rect.left, rightEdge - rect.width));
      const desiredTop = side === 'bottom' ? trigger.bottom + 8 : trigger.top - 8 - rect.height;
      // A locked side stays attached there. Fit by scrolling, never by sliding
      // the menu above a centered New-chat composer when it grows.
      const top = allowFlip ? Math.max(topEdge, Math.min(desiredTop, bottomEdge - rect.height)) : desiredTop;
      set('translate', `${(left - rect.left) / scaleX}px ${(top - rect.top) / scaleY}px`);
      menu.dataset.side = side;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const handleScroll = (event: Event) => {
      // Scrolling choices does not move the anchor. Leave their scroll offset
      // alone; only page/ancestor scrolling requires menu repositioning.
      if (event.target instanceof Node && menu.contains(event.target)) return;
      schedule();
    };
    update();
    const resize = new ResizeObserver(schedule);
    resize.observe(menu);
    // Watch layout changes such as composer growth, sidebar resizing, and panels.
    for (let element: HTMLElement | null = anchor; element; element = element.parentElement) {
      resize.observe(element);
    }
    const mutations = new MutationObserver(schedule);
    mutations.observe(menu, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', handleScroll, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', handleScroll, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  });

  return motionProps
    ? <motion.div {...props} {...motionProps} ref={ref} data-adaptive-menu="true" />
    : <div {...props} ref={ref} data-adaptive-menu="true" />;
}
