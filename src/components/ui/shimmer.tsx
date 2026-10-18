// @refresh reset
import React, { useLayoutEffect, useRef } from 'react';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';

// Share observation across active labels. Nothing runs per frame in React,
// and completed labels do not keep observers or compositor hints alive.
const shimmerLabels = new Map<HTMLElement, { visible: boolean; duration: number; once: boolean }>();
let shimmerVisibility: IntersectionObserver | null = null;
let shimmerSizes: ResizeObserver | null = null;
let stopAppVisibility: (() => void) | null = null;

function updateShimmerVisibility(element: HTMLElement) {
  const state = shimmerLabels.get(element);
  if (!state) return;
  const visible = state.visible && isAppVisible();
  element.dataset.shimmerVisible = visible ? 'true' : 'false';
  if (visible && !state.once) {
    // Resuming a label follows the current live cycle instead of replaying it.
    const phase = performance.now() % state.duration;
    for (const animation of element.getAnimations({ subtree: true })) {
      const name = (animation as CSSAnimation).animationName;
      if (name === 'tw-shimmer' || name === 'eterx-shimmer-stable' || name === 'eterx-shimmer-band' || name === 'eterx-shimmer-copy') animation.currentTime = phase;
    }
  }
}

function resumeShimmers() { shimmerLabels.forEach((_, element) => updateShimmerVisibility(element)); }

function observeShimmer(element: HTMLElement, duration: number, once: boolean) {
  if (!shimmerLabels.size) {
    shimmerVisibility = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const state = shimmerLabels.get(target);
        if (!state) continue;
        state.visible = entry.isIntersecting;
        updateShimmerVisibility(target);
      }
    });
    shimmerSizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      for (const entry of entries) {
        const observed = entry.target as HTMLElement;
        const target = shimmerLabels.has(observed) ? observed : observed.closest<HTMLElement>('.shimmer');
        if (!target || !shimmerLabels.has(target) || entry.contentRect.width <= 0) continue;
        target.style.setProperty('--shimmer-width', `${entry.contentRect.width}px`);
        target.dataset.shimmerReady = 'true';
      }
    });
    stopAppVisibility = subscribeAppVisibility(resumeShimmers);
  }
  // Follow the rendered duration, including scoped heading styles, on resume.
  const cssDuration = getComputedStyle(element).getPropertyValue('--shimmer-duration').trim();
  const cssDurationMs = Number.parseFloat(cssDuration) * (cssDuration.endsWith('ms') ? 1 : 1000);
  shimmerLabels.set(element, { visible: !shimmerVisibility, duration: Number.isFinite(cssDurationMs) && cssDurationMs > 0 ? cssDurationMs : duration, once });
  updateShimmerVisibility(element);
  shimmerVisibility?.observe(element);
  const measuredText = element.querySelector<HTMLElement>('.eterx-shimmer-base') || element;
  if (element.classList.contains('eterx-shimmer-composite')) shimmerSizes?.observe(measuredText);
  return () => {
    shimmerVisibility?.unobserve(element);
    shimmerSizes?.unobserve(measuredText);
    shimmerLabels.delete(element);
    element.removeAttribute('data-shimmer-visible');
    element.removeAttribute('data-shimmer-ready');
    if (!shimmerLabels.size) {
      shimmerVisibility?.disconnect(); shimmerVisibility = null;
      shimmerSizes?.disconnect(); shimmerSizes = null;
      stopAppVisibility?.(); stopAppVisibility = null;
    }
  };
}

function plainShimmerText(children: React.ReactNode): string | null {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (!Array.isArray(children)) return null;
  const parts = children.map(plainShimmerText);
  return parts.some(part => part === null) ? null : parts.join('');
}

type ShimmerProps = {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  active?: boolean;
  as?: 'span' | 'div' | 'p';
  durationMs?: number;
  /** Keep the sweep distance fixed when a live label changes length. */
  stableSweep?: boolean;
  angle?: number;
  spread?: string;
  color?: string;
  baseColor?: string;
  textColor?: string;
  surfaceColor?: string;
  once?: boolean;
  reverse?: boolean;
};

type ShimmerStyle = React.CSSProperties & {
  '--shimmer-duration'?: string;
  '--shimmer-angle'?: string;
  '--shimmer-spread'?: string;
  '--shimmer-color'?: string;
  '--shimmer-base'?: string;
  '--shimmer-surface'?: string;
};

/**
 * Local React adaptation of the shadcn-style shimmer CSS utility.
 * Reference: https://www.shadcn-svelte.com/docs/utils/shimmer
 *
 * Call sites can override the palette and timing; activity-feed.css supplies
 * the shared live-activity colors. Text updates do not restart a stable sweep.
 */
export const Shimmer = React.memo(({
  children,
  className = '',
  style,
  active = true,
  as: Tag = 'span',
  durationMs,
  stableSweep = false,
  angle,
  spread,
  color,
  baseColor,
  textColor,
  surfaceColor,
  once = false,
  reverse = false,
}: ShimmerProps) => {
  const elementRef = useRef<HTMLElement | null>(null);
  const plainText = plainShimmerText(children);
  const composite = plainText !== null && !once && !stableSweep;
  const observationMode = stableSweep ? 'stable' : composite ? 'composite' : 'text';
  useLayoutEffect(() => {
    if (!active || !elementRef.current) return;
    return observeShimmer(elementRef.current, Math.max(1, durationMs ?? 2400), once);
  }, [active, durationMs, once, observationMode]);
  const classes = [
    active ? 'shimmer' : '',
    active && composite ? 'eterx-shimmer-composite' : '',
    active && stableSweep ? 'eterx-shimmer-stable' : '',
    active && once ? 'shimmer-once' : '',
    active && reverse ? 'shimmer-reverse' : '',
    className,
  ].filter(Boolean).join(' ');

  const shimmerStyle: ShimmerStyle = {
    ...style,
    ...(durationMs !== undefined ? { '--shimmer-duration': `${Math.max(1, durationMs)}ms` } : {}),
    ...(angle !== undefined ? { '--shimmer-angle': `${angle}deg` } : {}),
    ...(spread ? { '--shimmer-spread': spread } : {}),
    ...(color ? { '--shimmer-color': color } : {}),
    ...(baseColor ? { '--shimmer-base': baseColor } : {}),
    ...(surfaceColor ? { '--shimmer-surface': surfaceColor } : {}),
    ...(textColor ? { color: textColor } : {}),
  };

  return <Tag ref={(element: HTMLElement | null) => { elementRef.current = element; }} className={classes} style={shimmerStyle}>
    {active && composite ? <>
      <span className="eterx-shimmer-base">{children}
        <span className="eterx-shimmer-window" aria-hidden="true">
          <span className="eterx-shimmer-band"><span className="eterx-shimmer-copy">{plainText}</span></span>
          <span className="eterx-shimmer-band eterx-shimmer-band-next"><span className="eterx-shimmer-copy">{plainText}</span></span>
        </span>
      </span>
    </> : children}
  </Tag>;
});
