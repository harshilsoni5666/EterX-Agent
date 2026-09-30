import React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X, ChevronRight, ChevronDown, Check, FolderClosed, Search, AlarmClockCheck, Link as LinkIcon, Users } from 'lucide-react';
import { PremiumShare, PremiumEdit, PremiumStar, PremiumFolder, PremiumTrash, PremiumDashboard, PremiumAgent, PremiumChannels, PremiumMoreHorizontal, PremiumCheckSquare, PremiumSettings } from '../ui/premium-icons';
import { Tooltip } from '../ui/tooltip';
import { appStorage, appStorageReady } from '../../lib/client-storage';
import { safeCopyTextToClipboard } from '../ui/copy-button';

const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_AUTO_CLOSE_EDGE = 28;
const SIDEBAR_WIDTH_STORAGE_KEY = 'eterx.sidebar.width';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const CHAT_RENDER_BATCH = 160;

const getSidebarViewportMax = (_viewportWidth: number) => SIDEBAR_MAX_WIDTH;

const ChatTitleMarquee = React.memo(({ title, isFavorite }: { title: string; isFavorite?: boolean }) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const textViewportRef = React.useRef<HTMLDivElement>(null);
  const textRef = React.useRef<HTMLSpanElement>(null);
  const [overflowDistance, setOverflowDistance] = React.useState(0);

  const measureOverflow = React.useCallback(() => {
    const viewport = textViewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;

    const diff = text.scrollWidth - viewport.clientWidth;
    const nextDistance = diff > 4 ? Math.ceil(diff) : 0;
    setOverflowDistance(current => current === nextDistance ? current : nextDistance);
  }, []);

  React.useEffect(() => {
    measureOverflow();
    const viewport = textViewportRef.current;
    const container = containerRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(viewport);
    if (container) observer.observe(container);
    return () => observer.disconnect();
  }, [isFavorite, measureOverflow, title]);

  React.useEffect(() => {
    window.addEventListener('resize', measureOverflow);
    return () => window.removeEventListener('resize', measureOverflow);
  }, [measureOverflow]);

  const marqueeDuration = Math.max(6, Math.min(18, 4.5 + overflowDistance * 0.16));
  const marqueeStyle = overflowDistance > 0 ? {
    '--eterx-sidebar-marquee-distance': `-${ overflowDistance }px`,
    '--eterx-sidebar-marquee-duration': `${ marqueeDuration + 2.8 }s`,
  } as React.CSSProperties : undefined;

  return (
    <div
      ref={containerRef}
      className="eterx-sidebar-chat-title-wrap flex min-w-0 flex-1 items-center overflow-hidden relative z-10"
    >
      {isFavorite && <PremiumStar className="eterx-sidebar-favorite-icon w-3.5 h-3.5 text-yellow-500/90 mr-1.5 shrink-0" />}
      <div ref={textViewportRef} className="min-w-0 flex-1 overflow-hidden">
        <span
          ref={textRef}
          style={marqueeStyle}
          className={`eterx-sidebar-chat-title text-current leading-normal whitespace-nowrap ${ overflowDistance > 0 ? 'eterx-sidebar-chat-title-overflow' : '' }`}
        >
          {title}
        </span>
      </div>
    </div>
  );
});

const getSidebarViewportMin = (_viewportWidth: number) => {
  return SIDEBAR_MIN_WIDTH;
};
const clampSidebarWidth = (width: number) => {
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const responsiveMin = getSidebarViewportMin(viewportWidth);
  const responsiveMax = getSidebarViewportMax(viewportWidth);
  return Math.min(responsiveMax, Math.max(responsiveMin, Math.round(width)));
};
const getAdaptiveSidebarDefault = (_viewportWidth: number) => {
  return SIDEBAR_DEFAULT_WIDTH;
};

const formatChatUpdatedAt = (updatedAt: number, now: number) => {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';

  const age = Math.max(0, now - updatedAt);
  if (age < MINUTE_MS) return 'now';
  if (age < HOUR_MS) return `${ Math.max(1, Math.floor(age / MINUTE_MS)) }m`;
  if (age < DAY_MS) return `${ Math.max(1, Math.floor(age / HOUR_MS)) }h`;
  if (age < 30 * DAY_MS) return `${ Math.max(1, Math.floor(age / DAY_MS)) }d`;

  const date = new Date(updatedAt);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const SidebarToggleIcon = ({ isOpen, isHovered, sizeClass = "w-[18px] h-[18px]" }: { isOpen: boolean, isHovered: boolean, sizeClass?: string }) => {
  if (isOpen) {
    if (isHovered) {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`${ sizeClass } text-[var(--sidebar-hover-text)] transition-colors duration-150`}>
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <path d="M9 3v18" />
          <path d="M16 15l-3-3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    }

    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`${ sizeClass } text-[var(--sidebar-muted-text)] transition-colors duration-150`}>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <path d="M9 3v18" />
      </svg>
    );
  }

  if (isHovered) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`${ sizeClass } text-[var(--sidebar-hover-text)] transition-colors duration-150`}>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <path d="M9 3v18" />
        <path d="M13 9l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`${ sizeClass } text-[var(--sidebar-muted-text)] transition-colors duration-150`}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M9 3v18" />
    </svg>
  );
};

const handleMenuKeyboardNavigation = (event: React.KeyboardEvent<HTMLElement>) => {
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"], button[role="menuitemradio"]'),
  ).filter(item => !item.disabled);
  if (items.length === 0) return;

  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  let nextIndex = currentIndex;
  if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
  if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = items.length - 1;
  if (nextIndex === currentIndex || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

  event.preventDefault();
  items[nextIndex]?.focus();
};

const lightweightSidebarCss = `
:root[data-theme="dark"] .eterx-sidebar-shell {
    --sidebar-hover-bg: #262626;
    --sidebar-toggle-hover-bg: #262626;
    --sidebar-active-bg: #262626;
    --sidebar-toggle-active-bg: rgba(255, 255, 255, 0.105);
    --sidebar-active-border: rgba(255, 255, 255, 0.08);
    --sidebar-active-fade: rgba(15, 15, 15, 0.96);
    --sidebar-menu-bg: #121212;
    --sidebar-menu-border: transparent;
    --sidebar-active-shadow: 0 4px 12px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.035);
    --sidebar-unread-dot: #77BCFF;
    --sidebar-unread-dot-ring: rgba(119, 188, 255, 0.18);
    --sidebar-time-text: rgba(210, 206, 197, 0.56);
    --sidebar-running-track: rgba(255, 255, 255, 0.20);
    --sidebar-running-head: rgba(241, 236, 228, 0.92);
    background: var(--sidebar-bg) !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell {
    --sidebar-hover-bg: #E8E8E8;
    --sidebar-toggle-hover-bg: #E8E8E8;
    --sidebar-active-bg: #E8E8E8;
    --sidebar-toggle-active-bg: #DEDEDE;
    --sidebar-hover-border: transparent;
    --sidebar-active-border: transparent;
    --sidebar-focus-ring: transparent;
    --sidebar-active-fade: #E8E8E8;
    --sidebar-menu-bg: #FFFFFF;
    --sidebar-menu-border: transparent;
    --sidebar-active-shadow: 0 3px 10px rgba(31, 31, 29, 0.055), inset 0 1px 0 rgba(255, 255, 255, 0.58);
    --sidebar-unread-dot: #228BE6;
    --sidebar-unread-dot-ring: rgba(34, 139, 230, 0.16);
    --sidebar-time-text: rgba(75, 73, 69, 0.62);
    --sidebar-running-track: rgba(39, 49, 63, 0.18);
    --sidebar-running-head: rgba(39, 49, 63, 0.82);
    background: linear-gradient(180deg, #FFFFFF 0%, var(--sidebar-bg) 72%, #F7F7F5 100%) !important;
    animation: none !important;
    will-change: auto;
  }

  .eterx-sidebar-shell .eterx-sidebar-sheen,
  .eterx-sidebar-shell .eterx-sidebar-recents,
  .eterx-sidebar-shell .eterx-sidebar-profile,
  .eterx-sidebar-shell .eterx-sidebar-profile-card,
  .eterx-sidebar-shell .eterx-sidebar-profile-avatar,
  .eterx-sidebar-shell .eterx-sidebar-avatar,
  .eterx-sidebar-menu {
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    box-shadow: none !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-sheen,
  .eterx-sidebar-shell .eterx-sidebar-sheen {
    background: transparent !important;
    top: var(--sidebar-glow-start) !important;
    bottom: 0 !important;
    height: auto !important;
    opacity: 1;
    animation: none;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-sheen {
    background: transparent !important;
    top: 0 !important;
    bottom: 0 !important;
    height: auto !important;
    opacity: 1;
    animation: none;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-recents,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-recents,
  .eterx-sidebar-shell .eterx-sidebar-recents {
    -webkit-backdrop-filter: blur(16px) saturate(1.08) !important;
    backdrop-filter: blur(16px) saturate(1.08) !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-recents-scroll {
    /* Keep the scrollbar in its own lane so chat rows never sit underneath it. */
    scrollbar-gutter: stable !important;
    --eterx-sidebar-scroll-fade-size: 12px;
    -webkit-mask-image: none !important;
    mask-image: none !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-recents-scroll.eterx-sidebar-scroll-fade-top {
    -webkit-mask-image: linear-gradient(
      180deg,
      transparent 0%,
      #000 var(--eterx-sidebar-scroll-fade-size),
      #000 100%
    ) !important;
    mask-image: linear-gradient(
      180deg,
      transparent 0%,
      #000 var(--eterx-sidebar-scroll-fade-size),
      #000 100%
    ) !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-recents-scroll.eterx-sidebar-scroll-fade-bottom {
    -webkit-mask-image: linear-gradient(
      180deg,
      #000 0%,
      #000 calc(100% - var(--eterx-sidebar-scroll-fade-size)),
      transparent 100%
    ) !important;
    mask-image: linear-gradient(
      180deg,
      #000 0%,
      #000 calc(100% - var(--eterx-sidebar-scroll-fade-size)),
      transparent 100%
    ) !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-recents-scroll.eterx-sidebar-scroll-fade-both {
    -webkit-mask-image: linear-gradient(
      180deg,
      transparent 0%,
      #000 var(--eterx-sidebar-scroll-fade-size),
      #000 calc(100% - var(--eterx-sidebar-scroll-fade-size)),
      transparent 100%
    ) !important;
    mask-image: linear-gradient(
      180deg,
      transparent 0%,
      #000 var(--eterx-sidebar-scroll-fade-size),
      #000 calc(100% - var(--eterx-sidebar-scroll-fade-size)),
      transparent 100%
    ) !important;
  }

  .eterx-sidebar-project-filter {
    width: max-content;
    min-width: 0;
    max-width: 100%;
    flex: 0 1 auto;
    min-height: 26px;
    -webkit-tap-highlight-color: transparent;
    background: transparent;
  }

  .eterx-sidebar-project-filter:hover,
  .eterx-sidebar-project-filter:focus-visible,
  .eterx-sidebar-project-filter.is-open {
    background: var(--sidebar-active-bg);
    border-color: transparent !important;
    box-shadow: none;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-row {
    transition-duration: 140ms !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-row {
    border-radius: 12px !important;
  }

  .eterx-sidebar-project-menu {
    background: color-mix(in srgb, var(--sidebar-bg) 88%, var(--sidebar-strong-text) 12%);
    border-color: transparent !important;
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.28) !important;
    scrollbar-gutter: auto !important;
    transform-origin: top left;
  }

  .eterx-sidebar-project-search {
    color: var(--sidebar-muted-text);
    background: color-mix(in srgb, var(--sidebar-strong-text) 7%, transparent);
    border: 1px solid color-mix(in srgb, var(--sidebar-strong-text) 8%, transparent);
  }

  .eterx-sidebar-project-search:focus-within {
    color: var(--sidebar-hover-text);
    background: color-mix(in srgb, var(--sidebar-strong-text) 10%, transparent);
    border-color: color-mix(in srgb, var(--sidebar-hover-text) 18%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-hover-text) 8%, transparent);
  }

  .eterx-sidebar-project-search input {
    color: var(--sidebar-strong-text);
  }

  .eterx-sidebar-project-menu-item {
    min-height: 32px;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 5px 8px;
    color: var(--sidebar-muted-text);
    font-size: 12.5px;
    font-weight: 500;
    text-align: left;
    transition: background-color 150ms ease, color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
  }

  .eterx-sidebar-project-menu-item:hover,
  .eterx-sidebar-project-menu-item:focus-visible,
  .eterx-sidebar-project-menu-item.is-selected {
    background: var(--sidebar-hover-bg);
    border-color: transparent;
    color: var(--sidebar-hover-text);
    box-shadow: none;
    outline: none;
  }

  .eterx-sidebar-project-menu-item:hover,
  .eterx-sidebar-project-menu-item:focus-visible {
    box-shadow: none;
  }

  .eterx-sidebar-project-menu-item:active {
    transform: scale(0.985);
  }

  .eterx-sidebar-project-loading {
    animation: eterx-sidebar-spin 0.8s linear infinite;
  }



  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-recents,
  .eterx-sidebar-shell .eterx-sidebar-recents {
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.040), rgba(255, 255, 255, 0.018)),
      rgba(16, 16, 16, 0.30) !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-recents {
    background: rgba(255, 255, 255, 0.52) !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-recents-scroll {
    -webkit-backdrop-filter: blur(14px) saturate(1.08) !important;
    backdrop-filter: blur(14px) saturate(1.08) !important;
    --eterx-sb-thumb: rgba(31, 31, 29, 0.16);
    --eterx-sb-thumb-hover: rgba(31, 31, 29, 0.26);
    --eterx-sb-thumb-active: rgba(31, 31, 29, 0.34);
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-profile,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-profile,
  .eterx-sidebar-shell .eterx-sidebar-profile {
    background: rgba(255, 255, 255, 0.20) !important;
    border-top-color: rgba(31, 31, 29, 0.065) !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-profile {
    background: transparent !important;
    border-top-color: transparent !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-profile {
    background: transparent !important;
    border-top-color: transparent !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-profile-card {
    background: rgba(255, 255, 255, 0.86) !important;
    border-color: rgba(31, 31, 29, 0.08) !important;
    box-shadow: 0 1px 2px rgba(31, 31, 29, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.82) !important;
  }

  .eterx-sidebar-resize-handle {
    position: absolute;
    top: calc(var(--eterx-shell-topbar-height) + 6px);
    right: 0;
    bottom: 8px;
    z-index: 60;
    width: 18px;
    pointer-events: none;
  }

  .eterx-sidebar-resize-target {
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 8px;
    cursor: col-resize;
    touch-action: none;
    pointer-events: auto;
    -webkit-app-region: no-drag;
  }

  .eterx-sidebar-resize-handle::before {
    content: "";
    position: absolute;
    top: 14px;
    bottom: 14px;
    right: 1px;
    width: 1px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.16);
    opacity: 0.12;
    transition: opacity 160ms ease, background 160ms ease, width 160ms ease;
  }

  .eterx-sidebar-resize-handle:hover::before,
  .eterx-sidebar-resize-handle-active::before {
    width: 2px;
    background: rgba(255, 255, 255, 0.42);
    opacity: 0.72;
  }

  :root[data-theme="light"] .eterx-sidebar-resize-handle::before {
    background: rgba(31, 31, 29, 0.18);
  }

  :root[data-theme="light"] .eterx-sidebar-resize-handle:hover::before,
  :root[data-theme="light"] .eterx-sidebar-resize-handle-active::before {
    background: rgba(31, 31, 29, 0.34);
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-profile-card,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-profile-card,
  .eterx-sidebar-shell .eterx-sidebar-profile-card {
    background: rgba(255, 255, 255, 0.30) !important;
    border-color: rgba(31, 31, 29, 0.065) !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72) !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-profile-card {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-profile-card {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-settings-button {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-profile-avatar,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-avatar,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-profile-avatar,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-avatar,
  .eterx-sidebar-shell .eterx-sidebar-profile-avatar,
  .eterx-sidebar-shell .eterx-sidebar-avatar {
    background: var(--sidebar-active-bg) !important;
    border-color: transparent !important;
    color: var(--sidebar-active-text) !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-nav-active,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-nav-active,
  .eterx-sidebar-shell .eterx-sidebar-nav-active {
    background: var(--sidebar-active-bg) !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-selected,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active.eterx-sidebar-chat-working,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-active,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-selected,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-active.eterx-sidebar-chat-working,
  .eterx-sidebar-shell .eterx-sidebar-chat-active,
  .eterx-sidebar-shell .eterx-sidebar-chat-selected,
  .eterx-sidebar-shell .eterx-sidebar-chat-active.eterx-sidebar-chat-working {
    background: var(--sidebar-hover-bg) !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-selected,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active.eterx-sidebar-chat-working {
    border-radius: 12px !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-working:not(.eterx-sidebar-chat-active) {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-working:not(.eterx-sidebar-chat-active) {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active::after,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active::before,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-nav-active::before,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-active::after,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-active::before,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-nav-active::before,
  .eterx-sidebar-shell .eterx-sidebar-chat-active::after,
  .eterx-sidebar-shell .eterx-sidebar-chat-active::before,
  .eterx-sidebar-shell .eterx-sidebar-nav-active::before {
    content: none !important;
    display: none !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-toggle:hover,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-nav-item:hover,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-row:hover,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-settings-button:hover,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-profile-icon-button:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-toggle:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-nav-item:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-row:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-settings-button:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-profile-icon-button:hover,
  .eterx-sidebar-shell .eterx-sidebar-toggle:hover,
  .eterx-sidebar-shell .eterx-sidebar-nav-item:hover,
  .eterx-sidebar-shell .eterx-sidebar-chat-row:hover,
  .eterx-sidebar-shell .eterx-sidebar-settings-button:hover,
  .eterx-sidebar-shell .eterx-sidebar-profile-icon-button:hover,
  .eterx-sidebar-menu button:hover {
    background: var(--sidebar-hover-bg) !important;
    border-color: transparent !important;
    box-shadow: none !important;
    transform: none !important;
    filter: none !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-menu-button {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-menu-button:hover {
    background: var(--sidebar-hover-bg) !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-menu-button:active {
    background: var(--sidebar-toggle-active-bg) !important;
    box-shadow: none !important;
  }


  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-nav-active:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-nav-active:hover,
  .eterx-sidebar-shell .eterx-sidebar-nav-active:hover {
    background: var(--sidebar-active-bg) !important;
    border-color: transparent !important;
    box-shadow: none !important;
    color: var(--sidebar-active-text) !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-nav-item:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-nav-item:focus,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-nav-item:focus-visible {
    border: 1px solid transparent !important;
    border-color: transparent !important;
    outline: none !important;
    box-shadow: none !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active:hover,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-selected:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-active:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-selected:hover,
  .eterx-sidebar-shell .eterx-sidebar-chat-active:hover,
  .eterx-sidebar-shell .eterx-sidebar-chat-selected:hover {
    background: var(--sidebar-hover-bg) !important;
    border-color: transparent !important;
    box-shadow: none !important;
    color: var(--sidebar-hover-text) !important;
  }

  .eterx-sidebar-shell svg,
  .eterx-sidebar-shell svg:hover,
  .eterx-sidebar-shell .group:hover svg,
  .eterx-sidebar-menu button:hover svg,
  .eterx-sidebar-menu .eterx-sidebar-menu-chevron {
    transform: none !important;
    filter: none !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-title,
  .eterx-sidebar-shell .eterx-sidebar-chat-title-wrap {
    text-overflow: clip !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-title {
    font-size: 13.5px;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-title {
    display: inline-block !important;
    white-space: nowrap !important;
    overflow: visible !important;
    will-change: auto;
  }

  @keyframes eterx-sidebar-title-marquee {
    0%, 10% {
      transform: translate3d(0, 0, 0);
    }
    38%, 64% {
      transform: translate3d(var(--eterx-sidebar-marquee-distance), 0, 0);
    }
    86%, 100% {
      transform: translate3d(0, 0, 0);
    }
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-row:hover .eterx-sidebar-chat-title-overflow {
    animation: eterx-sidebar-title-marquee var(--eterx-sidebar-marquee-duration) cubic-bezier(0.25, 1, 0.5, 1) 420ms infinite;
    will-change: transform;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-title-wrap {
    overflow: hidden !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-content {
    min-width: 0;
    -webkit-mask-image: linear-gradient(90deg, #000 0%, #000 calc(100% - 8px), transparent 100%) !important;
    mask-image: linear-gradient(90deg, #000 0%, #000 calc(100% - 8px), transparent 100%) !important;
  }







  .eterx-sidebar-shell .eterx-sidebar-chat-content-working {
    padding-right: 0 !important;
  }


  .eterx-sidebar-shell .eterx-sidebar-chat-meta {
    min-width: 0;
    height: 100%;
    color: var(--sidebar-time-text);
    font-size: 12.5px;
    font-weight: 560;
    letter-spacing: 0;
    transition: opacity 150ms ease, transform 150ms ease, color 150ms ease, width 150ms ease, margin-left 150ms ease;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-active .eterx-sidebar-chat-meta {
    color: color-mix(in srgb, var(--sidebar-active-text) 64%, transparent);
  }

  .eterx-sidebar-shell .eterx-sidebar-unread-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--sidebar-unread-dot);
    box-shadow:
      0 0 0 2px var(--sidebar-unread-dot-ring),
      0 0 6px color-mix(in srgb, var(--sidebar-unread-dot) 40%, transparent);
  }

  .eterx-sidebar-shell .eterx-sidebar-running-indicator {
    position: relative;
    width: 16px;
    height: 16px;
    border-radius: 999px;
    border: 2px solid var(--sidebar-running-track);
    border-right-color: var(--sidebar-running-head);
    animation: eterx-sidebar-spin 1.35s linear infinite;
    box-shadow: none;
  }

  .eterx-sidebar-shell .eterx-sidebar-running-indicator::after {
    display: none;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-working .eterx-sidebar-chat-title {
    background: none !important;
    color: var(--sidebar-working-text) !important;
    -webkit-text-fill-color: currentColor !important;
    animation: none !important;
    text-shadow: none !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-active.eterx-sidebar-chat-working .eterx-sidebar-chat-title {
    color: var(--sidebar-active-text) !important;
  }

  @keyframes eterx-sidebar-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Match the CSS-only response of the chat rows inside All Chats search
     across every sidebar interaction. Keeping this scoped here prevents the
     app-wide hover policy from reintroducing slower filters or transforms. */
  @media (hover: hover) and (pointer: fine) {
    .eterx-sidebar-shell button:not(:disabled),
    .eterx-sidebar-shell [role="button"]:not([aria-disabled="true"]),
    .eterx-sidebar-project-menu button:not(:disabled),
    .eterx-sidebar-menu button:not(:disabled) {
      transition-property: background-color, border-color, color, opacity !important;
      transition-duration: 120ms !important;
      transition-timing-function: ease-out !important;
      transition-delay: 0ms !important;
      will-change: auto !important;
    }

    .eterx-sidebar-shell button [class*="transition-colors"],
    .eterx-sidebar-shell [role="button"] [class*="transition-colors"],
    .eterx-sidebar-project-menu button [class*="transition-colors"],
    .eterx-sidebar-menu button [class*="transition-colors"],
    .eterx-sidebar-shell .eterx-sidebar-chat-time {
      transition-property: background-color, border-color, color, opacity !important;
      transition-duration: 120ms !important;
      transition-timing-function: ease-out !important;
      transition-delay: 0ms !important;
    }

    .eterx-sidebar-shell button:hover,
    .eterx-sidebar-shell [role="button"]:hover,
    .eterx-sidebar-project-menu button:hover,
    .eterx-sidebar-menu button:hover {
      transform: none !important;
      filter: none !important;
    }
  }

  /* Navigation rows stay completely still in both themes. This rule is kept
     after the shared interaction policy so no later hover/focus transition,
     ring, shadow, or border can be reintroduced. */
  .eterx-sidebar-shell .eterx-sidebar-nav-item,
  .eterx-sidebar-shell .eterx-sidebar-new-chat,
  .eterx-sidebar-shell .eterx-sidebar-nav-item:hover,
  .eterx-sidebar-shell .eterx-sidebar-new-chat:hover,
  .eterx-sidebar-shell .eterx-sidebar-nav-item:active,
  .eterx-sidebar-shell .eterx-sidebar-new-chat:active,
  .eterx-sidebar-shell .eterx-sidebar-nav-item:focus,
  .eterx-sidebar-shell .eterx-sidebar-new-chat:focus,
  .eterx-sidebar-shell .eterx-sidebar-nav-item:focus-visible,
  .eterx-sidebar-shell .eterx-sidebar-new-chat:focus-visible,
  .eterx-sidebar-shell .eterx-sidebar-nav-active,
  .eterx-sidebar-shell .eterx-sidebar-nav-active:hover,
  .eterx-sidebar-shell .eterx-sidebar-nav-active:active,
  .eterx-sidebar-shell .eterx-sidebar-nav-active:focus-visible {
    border: 1px solid transparent !important;
    border-color: transparent !important;
    outline: none !important;
    box-shadow: none !important;
    transform: none !important;
    filter: none !important;
    transition: none !important;
    will-change: auto !important;
    --tw-ring-offset-shadow: 0 0 transparent !important;
    --tw-ring-shadow: 0 0 transparent !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-nav-item::before,
  .eterx-sidebar-shell .eterx-sidebar-nav-item::after,
  .eterx-sidebar-shell .eterx-sidebar-new-chat::before,
  .eterx-sidebar-shell .eterx-sidebar-new-chat::after {
    content: none !important;
    display: none !important;
  }

  /* Settings follows the same quiet interaction language as primary nav. */
  .eterx-sidebar-shell .eterx-sidebar-settings-button,
  .eterx-sidebar-shell .eterx-sidebar-settings-button:hover,
  .eterx-sidebar-shell .eterx-sidebar-settings-button:active,
  .eterx-sidebar-shell .eterx-sidebar-settings-button:focus,
  .eterx-sidebar-shell .eterx-sidebar-settings-button:focus-visible {
    border: 1px solid transparent !important;
    border-color: transparent !important;
    outline: none !important;
    box-shadow: none !important;
    transform: none !important;
    filter: none !important;
    transition: none !important;
    --tw-ring-offset-shadow: 0 0 transparent !important;
    --tw-ring-shadow: 0 0 transparent !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-settings-button:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-settings-button:focus-visible {
    background: #E7E7E7 !important;
    color: #2B2B2B !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-settings-button:hover,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-settings-button:focus-visible {
    background: var(--sidebar-hover-bg) !important;
    color: var(--sidebar-hover-text) !important;
  }

  /* The open desktop shell has a 32px geometry buffer behind the workspace.
     Keep it continuous with the real sidebar; the transparent workspace lane
     can then reveal Recents without placing a white block over the feed. */
  :root[data-theme="light"] .eterx-app-shell[data-sidebar-open="true"] .eterx-sidebar-shell {
    background: #F3F3F3 !important;
  }

  :root[data-theme="light"] .eterx-app-shell[data-sidebar-open="true"] .eterx-sidebar-shell > #eterx-sidebar-content {
    background: #F3F3F3 !important;
  }

  @media (prefers-reduced-motion: reduce) {
    .eterx-sidebar-shell *,
    .eterx-sidebar-menu,
    .eterx-sidebar-project-menu {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }

    .eterx-sidebar-shell .eterx-sidebar-running-indicator {
      animation: none;
    }

    .eterx-sidebar-shell .eterx-sidebar-chat-title-overflow {
      animation: none !important;
      transform: none !important;
    }
  }


`;

interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  traceLogs: any[];
  isFavorite?: boolean;
  workspacePath?: string | null;
}

interface SidebarProject {
  path: string;
  name: string;
  updatedAt: number;
}

const normalizeProjectPath = (value: unknown) => String(value || '').trim().replace(/[\\/]+$/, '');

const projectNameFromPath = (value: string) => {
  const normalized = normalizeProjectPath(value);
  return normalized.split(/[\\/]/).filter(Boolean).pop() || normalized;
};

interface SidebarProps {
  isOpen: boolean;
  titlebarToggleExternal?: boolean;
  setIsOpen: (open: boolean) => void;
  createNewChat: () => void;
  chats: ChatSession[];
  isLoadingChats?: boolean;
  activeChatId: string | null;
  additionalActiveChatIds?: Set<string> | string[];
  loadChat: (id: string) => void;
  deleteChat: (id: string) => void;
  deleteChats?: (ids: string[]) => void;
  renameChat: (id: string, newTitle: string) => void;
  toggleFavorite: (id: string) => void;
  onSearchClick: () => void;
  activeView: 'chat' | 'agents' | 'channels' | 'projects';
  setActiveView: (view: 'chat' | 'agents' | 'channels' | 'projects') => void;
  runningChats?: Set<string>;
  unreadChats?: Set<string>;
  onSettingsClick?: () => void;
  isThinking?: boolean;
}

export const Sidebar = React.memo<SidebarProps>(
  ({
    isOpen, titlebarToggleExternal = false, setIsOpen, createNewChat, chats, isLoadingChats = false, activeChatId, additionalActiveChatIds, loadChat, deleteChat, deleteChats, renameChat, toggleFavorite, onSearchClick, activeView, setActiveView, runningChats, unreadChats, onSettingsClick, isThinking
}) => {
  const reduceMotion = useReducedMotion();
  const [menuState, setMenuState] = React.useState<{ id: string, x: number, y: number, dropUp: boolean } | null>(null);
  const [toggleHovered, setToggleHovered] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);
  const [viewportWidth, setViewportWidth] = React.useState(1440);
  const [sidebarWidth, setSidebarWidth] = React.useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = React.useState(false);
  const [selectedProjectPath, setSelectedProjectPath] = React.useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = React.useState(false);
  const [projectMenuPosition, setProjectMenuPosition] = React.useState({ top: 0, left: 0 });
  const projectMenuRef = React.useRef<HTMLDivElement>(null);
  const projectMenuPortalRef = React.useRef<HTMLDivElement>(null);
  const chatMenuRef = React.useRef<HTMLDivElement>(null);
  const chatMenuButtonRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  const projects = React.useMemo<SidebarProject[]>(() => {
    const byPath = new Map<string, SidebarProject>();
    chats.forEach(chat => {
      const path = normalizeProjectPath(chat.workspacePath);
      if (!path) return;
      const key = path.toLowerCase();
      const existing = byPath.get(key);
      if (!existing || chat.updatedAt > existing.updatedAt) {
        byPath.set(key, {
          path,
          name: projectNameFromPath(path),
          updatedAt: chat.updatedAt,
        });
      }
    });
    return [...byPath.values()].sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.name.localeCompare(b.name);
    });
  }, [chats]);

  const activeProject = React.useMemo(
    () => projects.find(project => project.path.toLowerCase() === normalizeProjectPath(selectedProjectPath).toLowerCase()) || null,
    [projects, selectedProjectPath],
  );
  const filteredChats = React.useMemo(() => {
    const selectedPath = normalizeProjectPath(selectedProjectPath).toLowerCase();
    if (!selectedPath) return chats;
    return chats.filter(chat => normalizeProjectPath(chat.workspacePath).toLowerCase() === selectedPath);
  }, [chats, selectedProjectPath]);
  const [visibleChatCount, setVisibleChatCount] = React.useState(CHAT_RENDER_BATCH);
  const [recentScrollFades, setRecentScrollFades] = React.useState({ top: false, bottom: false });
  const visibleChats = React.useMemo(
    () => filteredChats.slice(0, visibleChatCount),
    [filteredChats, visibleChatCount]
  );

  React.useEffect(() => {
    if (!activeChatId) return;
    const activeIndex = filteredChats.findIndex(chat => chat.id === activeChatId);
    if (activeIndex >= visibleChatCount) {
      setVisibleChatCount(Math.ceil((activeIndex + 1) / CHAT_RENDER_BATCH) * CHAT_RENDER_BATCH);
    }
  }, [activeChatId, filteredChats, visibleChatCount]);

  React.useEffect(() => {
    if (selectedProjectPath && !activeProject) setSelectedProjectPath(null);
  }, [activeProject, selectedProjectPath]);

  React.useEffect(() => {
    if (!projectMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node) && !projectMenuPortalRef.current?.contains(event.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setProjectMenuOpen(false);
        window.requestAnimationFrame(() => projectMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [projectMenuOpen]);

  React.useEffect(() => {
    if (!projectMenuOpen) return;
    const frameId = window.requestAnimationFrame(() => {
      projectMenuPortalRef.current?.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [projectMenuOpen]);

  React.useEffect(() => {
    if (!menuState) return;
    const frameId = window.requestAnimationFrame(() => {
      chatMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [menuState]);

  const restoreChatMenuFocus = React.useCallback((chatId: string | null) => {
    if (!chatId) return;
    window.requestAnimationFrame(() => chatMenuButtonRefs.current[chatId]?.focus());
  }, []);

  const updateRecentScrollFades = React.useCallback((container: HTMLDivElement | null) => {
    if (!container) return;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const next = {
      top: maxScrollTop > 1 && container.scrollTop > 1,
      bottom: maxScrollTop > 1 && container.scrollTop < maxScrollTop - 1,
    };
    setRecentScrollFades(current => (
      current.top === next.top && current.bottom === next.bottom ? current : next
    ));
  }, []);

  const handleRecentChatsScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    updateRecentScrollFades(container);
    if (
      visibleChatCount < filteredChats.length &&
      container.scrollHeight - container.scrollTop - container.clientHeight < 320
    ) {
      setVisibleChatCount(current => Math.min(filteredChats.length, current + CHAT_RENDER_BATCH));
    }
  }, [filteredChats.length, updateRecentScrollFades, visibleChatCount]);

  const [now, setNow] = React.useState(() => Date.now());
  const resizeStartRef = React.useRef({ x: 0, width: SIDEBAR_DEFAULT_WIDTH });
  const resizeCurrentWidthRef = React.useRef(SIDEBAR_DEFAULT_WIDTH);
  const resizeLastClientXRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
      setViewportWidth(window.innerWidth);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  React.useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  React.useEffect(() => {
    const restoreWidth = () => {
      const storedWidth = Number(appStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
      if (Number.isFinite(storedWidth) && storedWidth >= SIDEBAR_MIN_WIDTH && storedWidth <= SIDEBAR_MAX_WIDTH) {
        const nextWidth = clampSidebarWidth(storedWidth);
        resizeCurrentWidthRef.current = nextWidth;
        setSidebarWidth(nextWidth);
        return;
      }
      const adaptiveWidth = getAdaptiveSidebarDefault(window.innerWidth);
      resizeCurrentWidthRef.current = adaptiveWidth;
      setSidebarWidth(adaptiveWidth);
    };
    restoreWidth();
    void appStorageReady.then(restoreWidth);
  }, []);

  React.useEffect(() => {
    const responsiveMin = getSidebarViewportMin(viewportWidth);
    const responsiveMax = getSidebarViewportMax(viewportWidth);
    setSidebarWidth(current => Math.min(responsiveMax, Math.max(responsiveMin, current)));
  }, [viewportWidth]);

  React.useEffect(() => {
    document.documentElement.style.setProperty('--eterx-shell-sidebar-width', `${sidebarWidth}px`);
  }, [sidebarWidth]);

  React.useEffect(() => () => {
    document.documentElement.style.removeProperty('--eterx-shell-sidebar-width');
  }, []);

  React.useEffect(() => {
    if (!isResizingSidebar) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (event: PointerEvent) => {
      resizeLastClientXRef.current = event.clientX;
      const nextWidth = resizeStartRef.current.width + event.clientX - resizeStartRef.current.x;
      const clampedWidth = clampSidebarWidth(nextWidth);
      resizeCurrentWidthRef.current = clampedWidth;
      setSidebarWidth(clampedWidth);
    };

    const stopResize = () => {
      if (resizeLastClientXRef.current !== null && resizeLastClientXRef.current <= SIDEBAR_AUTO_CLOSE_EDGE) {
        const adaptiveWidth = getAdaptiveSidebarDefault(window.innerWidth);
        resizeCurrentWidthRef.current = adaptiveWidth;
        setSidebarWidth(adaptiveWidth);
        setIsResizingSidebar(false);
        setIsOpen(false);
        return;
      }

      setIsResizingSidebar(false);
      appStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(resizeCurrentWidthRef.current));
    };

    const cancelResize = () => {
      resizeLastClientXRef.current = null;
      resizeCurrentWidthRef.current = resizeStartRef.current.width;
      setSidebarWidth(resizeStartRef.current.width);
      setIsResizingSidebar(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelResize();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', cancelResize);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', cancelResize);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      resizeLastClientXRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', cancelResize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', cancelResize);
    };
  }, [isResizingSidebar, setIsOpen]);

  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const dragPointerXRef = React.useRef<number | null>(null);
  const dragPointerYRef = React.useRef<number | null>(null);
  const lastDragTouchedChatRef = React.useRef<string | null>(null);
  const selectedChatIdsRef = React.useRef<Set<string>>(new Set());
  const dragSelectStateRef = React.useRef<boolean>(true);
  const dragEdgeStateRef = React.useRef<{ direction: 'up' | 'down' | null; enteredAt: number }>({ direction: null, enteredAt: 0 });

  const [isProjectPending, startProjectTransition] = React.useTransition();

  const [editingChatId, setEditingChatId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [shareCopiedId, setShareCopiedId] = React.useState<string | null>(null);

  const [isSelectMode, setIsSelectMode] = React.useState(false);
  const [selectedChatIds, setSelectedChatIds] = React.useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Smart drag selection states
  const [isDragSelecting, setIsDragSelecting] = React.useState(false);
  const [dragSelectState, setDragSelectState] = React.useState<boolean>(true);

  React.useEffect(() => {
    setVisibleChatCount(CHAT_RENDER_BATCH);
    setProjectMenuOpen(false);
    setIsSelectMode(false);
    setSelectedChatIds(new Set());
    selectedChatIdsRef.current = new Set();
  }, [selectedProjectPath]);

  React.useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const refreshFades = () => updateRecentScrollFades(container);
    refreshFades();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(refreshFades);
    observer.observe(container);
    return () => observer.disconnect();
  }, [isOpen, isProjectPending, isSelectMode, filteredChats.length, selectedProjectPath, updateRecentScrollFades, visibleChatCount]);

  const isNewChatActive = activeView === 'chat' && !activeChatId;
  const [glassClick, setGlassClick] = React.useState<{ key: string; x: number; y: number; tick: number } | null>(null);
  const glassClickTimeoutRef = React.useRef<number | null>(null);
  const handleSidebarResizePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();
    event.stopPropagation();
    resizeStartRef.current = { x: event.clientX, width: sidebarWidth };
    resizeCurrentWidthRef.current = sidebarWidth;
    resizeLastClientXRef.current = event.clientX;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizingSidebar(true);
  }, [isMobile, sidebarWidth]);

  const handleSidebarResizeKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isMobile) return;
    const min = getSidebarViewportMin(viewportWidth);
    const max = getSidebarViewportMax(viewportWidth);
    let nextWidth = sidebarWidth;

    if (event.key === 'ArrowLeft') nextWidth = Math.max(min, sidebarWidth - 16);
    if (event.key === 'ArrowRight') nextWidth = Math.min(max, sidebarWidth + 16);
    if (event.key === 'Home') nextWidth = min;
    if (event.key === 'End') nextWidth = max;
    if (nextWidth === sidebarWidth) return;

    event.preventDefault();
    resizeCurrentWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    appStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
  }, [isMobile, sidebarWidth, viewportWidth]);

  React.useEffect(() => {
    selectedChatIdsRef.current = selectedChatIds;
  }, [selectedChatIds]);

  React.useEffect(() => {
    dragSelectStateRef.current = dragSelectState;
  }, [dragSelectState]);

  const triggerGlassClick = React.useCallback((event: React.MouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>, key: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const tick = Date.now();
    setGlassClick({
      key,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      tick,
    });

    if (glassClickTimeoutRef.current !== null) window.clearTimeout(glassClickTimeoutRef.current);
    glassClickTimeoutRef.current = window.setTimeout(() => {
      setGlassClick(current => (current?.tick === tick ? null : current));
    }, 1000);
  }, []);

  const glassClickClass = React.useCallback((key: string) => (
    glassClick?.key === key ? 'eterx-sidebar-glass-clicked' : ''
  ), [glassClick]);

  const glassClickStyle = React.useCallback((key: string): React.CSSProperties | undefined => {
    if (glassClick?.key !== key) return undefined;
    return {
      '--eterx-click-x': `${ glassClick.x }px`,
      '--eterx-click-y': `${ glassClick.y }px`,
    } as React.CSSProperties;
  }, [glassClick]);

  React.useEffect(() => () => {
    if (glassClickTimeoutRef.current !== null) window.clearTimeout(glassClickTimeoutRef.current);
  }, []);

  const commitSelectedChatIds = React.useCallback((next: Set<string>) => {
    selectedChatIdsRef.current = next;
    setSelectedChatIds(next);
  }, []);

  const applyChatSelection = React.useCallback((chatId: string, shouldSelect: boolean) => {
    const current = selectedChatIdsRef.current;
    if (shouldSelect ? current.has(chatId) : !current.has(chatId)) return false;

    const next = new Set(current);
    if (shouldSelect) next.add(chatId);
    else next.delete(chatId);

    commitSelectedChatIds(next);
    return true;
  }, [commitSelectedChatIds]);

  React.useEffect(() => {
    const stopDragSelection = () => {
      dragPointerXRef.current = null;
      dragPointerYRef.current = null;
      lastDragTouchedChatRef.current = null;
      dragEdgeStateRef.current = { direction: null, enteredAt: 0 };
      setIsDragSelecting(false);
    };

    if (isDragSelecting) {
      window.addEventListener('pointerup', stopDragSelection);
      window.addEventListener('pointercancel', stopDragSelection);
      window.addEventListener('blur', stopDragSelection);
      return () => {
        window.removeEventListener('pointerup', stopDragSelection);
        window.removeEventListener('pointercancel', stopDragSelection);
        window.removeEventListener('blur', stopDragSelection);
      };
    }
  }, [isDragSelecting]);

  // Auto-scroll logic for drag selection
  React.useEffect(() => {
    let frameId: number | null = null;
    let lastTimestamp = 0;

    const applySelectionAtPointer = (pointerX: number, pointerY: number) => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      if (pointerX < rect.left - 18 || pointerX > rect.right + 18) return;

      const sampleX = Math.min(rect.right - 14, Math.max(rect.left + 14, Number.isFinite(pointerX) ? pointerX : rect.left + rect.width / 2));
      const sampleY = Math.min(rect.bottom - 12, Math.max(rect.top + 12, pointerY));
      const target = document.elementFromPoint(sampleX, sampleY);
      let row = target?.closest('[data-chat-id]');
      if (!row || !container.contains(row)) {
        const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-id]'));
        row = rows.find(item => {
          const rowRect = item.getBoundingClientRect();
          return sampleY >= rowRect.top && sampleY <= rowRect.bottom;
        }) ?? null;

        if (!row && (pointerY < rect.top || pointerY > rect.bottom)) {
          const visibleRows = rows.filter(item => {
            const rowRect = item.getBoundingClientRect();
            return rowRect.bottom >= rect.top && rowRect.top <= rect.bottom;
          });
          row = pointerY < rect.top ? visibleRows[0] ?? null : visibleRows[visibleRows.length - 1] ?? null;
        }
      }
      if (!row || !container.contains(row)) return;

      const chatId = row.getAttribute('data-chat-id');
      if (!chatId || lastDragTouchedChatRef.current === chatId) return;

      lastDragTouchedChatRef.current = chatId;
      applyChatSelection(chatId, dragSelectStateRef.current);
    };

    const handlePointerMove = (e: PointerEvent) => {
      dragPointerXRef.current = e.clientX;
      dragPointerYRef.current = e.clientY;
    };

    const tick = (timestamp: number) => {
      const container = scrollContainerRef.current;
      const pointerX = dragPointerXRef.current;
      const pointerY = dragPointerYRef.current;

      if (container && pointerX !== null && pointerY !== null) {
        const rect = container.getBoundingClientRect();
        const isHorizontallyInside = pointerX >= rect.left - 18 && pointerX <= rect.right + 18;
        const edgeZone = Math.min(86, Math.max(58, rect.height * 0.18));
        const outsideLimit = 72;
        const maxVelocity = 1040;
        const topDistance = pointerY - rect.top;
        const bottomDistance = rect.bottom - pointerY;
        let velocity = 0;
        let direction: 'up' | 'down' | null = null;

        if (isHorizontallyInside && topDistance < edgeZone && pointerY >= rect.top - outsideLimit) {
          direction = 'up';
          const outsideBoost = pointerY < rect.top ? Math.min(1.22, 1 + (rect.top - pointerY) / 260) : 1;
          const strength = Math.min(1, Math.max(0, (edgeZone - topDistance) / edgeZone));
          velocity = -maxVelocity * outsideBoost * Math.pow(strength, 1.35);
        } else if (isHorizontallyInside && bottomDistance < edgeZone && pointerY <= rect.bottom + outsideLimit) {
          direction = 'down';
          const outsideBoost = pointerY > rect.bottom ? Math.min(1.22, 1 + (pointerY - rect.bottom) / 260) : 1;
          const strength = Math.min(1, Math.max(0, (edgeZone - bottomDistance) / edgeZone));
          velocity = maxVelocity * outsideBoost * Math.pow(strength, 1.35);
        }

        if (direction !== dragEdgeStateRef.current.direction) {
          dragEdgeStateRef.current = { direction, enteredAt: timestamp };
        }

        if (velocity !== 0) {
          const egeDwell = Math.max(0, timestamp - dragEdgeStateRef.current.enteredAt);
          const dwellFactor = Math.min(1, egeDwell / 180);
          const delta = lastTimestamp ? Math.min(32, timestamp - lastTimestamp) / 1000 : 1 / 60;
          container.scrollTop += velocity * dwellFactor * delta;
        }
        applySelectionAtPointer(pointerX, pointerY);
      }

      lastTimestamp = timestamp;
      frameId = window.requestAnimationFrame(tick);
    };

    const handlePointerRawUpdate = handlePointerMove as EventListener;

    if (isDragSelecting) {
      window.addEventListener('pointermove', handlePointerMove, { passive: true });
      window.addEventListener('pointerrawupdate', handlePointerRawUpdate, { passive: true });
      frameId = window.requestAnimationFrame(tick);
      return () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerrawupdate', handlePointerRawUpdate);
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        dragPointerXRef.current = null;
        dragPointerYRef.current = null;
        lastDragTouchedChatRef.current = null;
        dragEdgeStateRef.current = { direction: null, enteredAt: 0 };
      };
    }
  }, [applyChatSelection, isDragSelecting]);

  React.useEffect(() => {
    if (!isSelectMode || selectedChatIds.size === 0) return;

    const validIds = new Set(filteredChats.map(chat => chat.id));
    const current = selectedChatIdsRef.current;
    const next = new Set([...current].filter(id => validIds.has(id)));
    if (next.size !== current.size) commitSelectedChatIds(next);
  }, [commitSelectedChatIds, filteredChats, isSelectMode, selectedChatIds.size]);

  const chatIds = React.useMemo(() => filteredChats.map(chat => chat.id), [filteredChats]);
  const allChatsSelected = chatIds.length > 0 && chatIds.every(id => selectedChatIds.has(id));
  const selectedCount = selectedChatIds.size;

  const exitSelectMode = React.useCallback(() => {
    dragPointerXRef.current = null;
    dragPointerYRef.current = null;
    lastDragTouchedChatRef.current = null;
    dragEdgeStateRef.current = { direction: null, enteredAt: 0 };
    setIsDragSelecting(false);
    setShowDeleteConfirm(false);
    setIsSelectMode(false);
    commitSelectedChatIds(new Set());
  }, [commitSelectedChatIds]);

  const enterSelectMode = React.useCallback(() => {
    if (filteredChats.length === 0) return;
    setMenuState(null);
    setShowDeleteConfirm(false);
    setIsSelectMode(true);
    commitSelectedChatIds(new Set());
  }, [commitSelectedChatIds, filteredChats.length]);

  const handleSelectAllToggle = React.useCallback(() => {
    if (chatIds.length === 0) return;
    commitSelectedChatIds(allChatsSelected ? new Set() : new Set(chatIds));
  }, [allChatsSelected, chatIds, commitSelectedChatIds]);

  React.useEffect(() => {
    const handleKeyDown = (KeyboardEvent: any) => {
      if (KeyboardEvent.key === 'Escape') {
        if (showDeleteConfirm || isSelectMode || menuState) {
          KeyboardEvent.preventDefault();
          const openMenuId = menuState?.id || null;
          setMenuState(null);
          if (showDeleteConfirm) setShowDeleteConfirm(false);
          else if (isSelectMode) exitSelectMode();
          else restoreChatMenuFocus(openMenuId);
        }
      }

      if ((KeyboardEvent.ctrlKey || KeyboardEvent.metaKey) && KeyboardEvent.key.toLowerCase() === 'a' && isSelectMode) {
        KeyboardEvent.preventDefault();
        handleSelectAllToggle();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [exitSelectMode, handleSelectAllToggle, isSelectMode, menuState, restoreChatMenuFocus, showDeleteConfirm]);

  const handleBulkDelete = () => {
    if (isDeleting) return;
    const idsToDelete = [...selectedChatIds].filter(id => filteredChats.some(chat => chat.id === id));
    if (idsToDelete.length === 0) {
      setShowDeleteConfirm(false);
      setIsSelectMode(false);
      commitSelectedChatIds(new Set());
      return;
    }

    setIsDeleting(true);

    if (deleteChats) deleteChats(idsToDelete);
    else idsToDelete.forEach(id => deleteChat(id));

    window.setTimeout(() => {
      commitSelectedChatIds(new Set());
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      setIsSelectMode(false);
    }, 180);
  };

  const handleProjectSelect = React.useCallback((path: string | null) => {
    const normalizedPath = normalizeProjectPath(path);
    const currentPath = normalizeProjectPath(selectedProjectPath);
    setProjectMenuOpen(false);
    if (normalizedPath.toLowerCase() === currentPath.toLowerCase()) return;
    startProjectTransition(() => setSelectedProjectPath(normalizedPath || null));
  }, [selectedProjectPath, startProjectTransition]);

  const handleShare = async (id: string) => {
    const chatToShare = chats.find(c => c.id === id);
    if (chatToShare) {
      const didCopy = await safeCopyTextToClipboard(`Shared Session: ${ chatToShare.title }`);
      if (!didCopy) return;
      setShareCopiedId(id);
      setTimeout(() => setShareCopiedId(null), 2000);
    }
  };

  React.useEffect(() => {
    const handleClickOutside = () => setMenuState(null);
    if (menuState) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => document.removeEventListener('click', handleClickOutside);
  }, [menuState]);

  return (
    <>

      <style suppressHydrationWarning dangerouslySetInnerHTML={{ __html: lightweightSidebarCss }} />
      <motion.aside
        animate={{
          opacity: 1
        }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
        className="eterx-sidebar-shell relative bg-[var(--sidebar-bg)] shadow-none flex flex-col flex-shrink-0 z-[100] h-full overflow-hidden [-webkit-app-region:no-drag]"
      >
        <div className="eterx-sidebar-sheen pointer-events-none absolute inset-0 bg-transparent overflow-hidden">
          <div
            className="ambient-glow-layer ambient-glow-idle absolute inset-0"
            style={{ animationPlayState: isThinking ? 'paused' : 'running' }}
          />
          <div
            className={`absolute inset-0 transition-opacity duration-[3000ms] ease-in-out ${isThinking ? 'opacity-100' : 'opacity-0'}`}
          >
            <div
              className="ambient-glow-layer ambient-glow-thinking absolute inset-0"
              style={{ animationPlayState: isThinking ? 'running' : 'paused' }}
            />
          </div>
        </div>

        <div id="eterx-sidebar-content" className="relative z-10 flex flex-col h-full w-full overflow-hidden">
          {/* Header containing Branding + Toggle */}
          <div className="eterx-sidebar-topbar h-[var(--eterx-shell-topbar-height)] px-3 tracking-tight flex items-center justify-start [-webkit-app-region:drag]">
            {titlebarToggleExternal ? (
              <span aria-hidden="true" className="h-8 w-8 shrink-0" />
            ) : (
            <Tooltip text={isOpen ? "Close sidebar" : "Open sidebar"} side="right">
              <button
                type="button"
                onMouseDown={(e) => { e.stopPropagation(); triggerGlassClick(e, 'sidebar-toggle'); }}
                onMouseEnter={() => setToggleHovered(true)}
                onMouseLeave={() => setToggleHovered(false)}
                onFocus={() => setToggleHovered(true)}
                onBlur={() => setToggleHovered(false)}
                onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}
                aria-label={isOpen ? "Close sidebar" : "Open sidebar"}
                aria-expanded={isOpen}
                aria-controls="eterx-sidebar-content"
                style={glassClickStyle('sidebar-toggle')}
                className={`eterx-sidebar-click-surface eterx-sidebar-toggle ${ glassClickClass('sidebar-toggle') } h-8 w-8 rounded-[8px] bg-transparent transition-colors duration-150 ease-out text-[var(--sidebar-muted-text)] flex items-center justify-center cursor-pointer border border-transparent hover:bg-[var(--sidebar-toggle-hover-bg)] hover:border-transparent hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)] [-webkit-app-region:no-drag]`}
              >
                <SidebarToggleIcon isOpen={isOpen} isHovered={toggleHovered} sizeClass="w-[18px] h-[18px]" />
              </button>
            </Tooltip>
            )}
            {isOpen && (
              <span className="eterx-sidebar-brand-text text-[var(--sidebar-text)] font-bold text-[19px] ml-3.5 select-none tracking-[0.01em] [-webkit-app-region:no-drag] leading-none flex items-center h-8 translate-y-[0.5px]">
                EterX
              </span>
            )}
          </div>

          {/* Navigation Actions */}
          <nav aria-label="Primary navigation" className={`px-3 pb-1.5 ${ isOpen ? 'pt-1.5' : 'pt-0' }`}>
            {isOpen ? (
              // Expanded "New Chat" Button
              <Tooltip text="Start a fresh conversation" side="right">
                <button
                  type="button"
                  aria-current={isNewChatActive ? 'page' : undefined}
                  onMouseDown={(e) => triggerGlassClick(e, 'new-chat-expanded')}
                  onClick={() => { createNewChat(); setActiveView('chat'); }}
                  style={glassClickStyle('new-chat-expanded')}
                  className={`eterx-sidebar-click-surface eterx-sidebar-nav-item eterx-sidebar-new-chat ${ glassClickClass('new-chat-expanded') } ${ isNewChatActive ? 'eterx-sidebar-nav-active' : '' } w-full h-[38px] flex items-center justify-between px-3 text-[13.5px] font-medium transition-colors duration-150 ease-out group relative overflow-hidden ${ isNewChatActive
                      ? 'text-[var(--sidebar-active-text)] bg-[var(--sidebar-active-bg)] rounded-[13px]'
                      : 'text-[var(--sidebar-text)] bg-transparent rounded-[13px]'
                    }`}
                >
                  <div className="flex items-center gap-3 relative z-10">
                    <PremiumEdit className={`w-[16px] h-[16px] transition-colors duration-150 ease-out ${ isNewChatActive ? 'text-[var(--sidebar-active-text)]' : 'text-[var(--sidebar-icon)]' }`} strokeWidth={2.0} />
                    New chat
                  </div>
                </button>
              </Tooltip>
            ) : (
              // Collapsed Circular "New Chat" Button
              <Tooltip text="New chat" side="right">
                <button
                  type="button"
                  aria-current={isNewChatActive ? 'page' : undefined}
                  onMouseDown={(e) => triggerGlassClick(e, 'new-chat-collapsed')}
                  onClick={() => { createNewChat(); setActiveView('chat'); }}
                  style={glassClickStyle('new-chat-collapsed')}
                  className={`eterx-sidebar-click-surface eterx-sidebar-nav-item eterx-sidebar-new-chat ${ glassClickClass('new-chat-collapsed') } ${ isNewChatActive ? 'eterx-sidebar-nav-active' : '' } w-[38px] h-[38px] flex items-center justify-center transition-colors duration-150 ease-out group relative mx-auto ${ isNewChatActive
                      ? 'text-[var(--sidebar-active-text)] bg-[var(--sidebar-active-bg)] rounded-full'
                      : 'text-[var(--sidebar-text)] bg-transparent rounded-full'
                    }`}
                >
                  <PremiumEdit className={`w-[16px] h-[16px] transition-colors duration-150 relative z-10 ${ isNewChatActive ? 'text-[var(--sidebar-active-text)]' : 'text-[var(--sidebar-icon)]' }`} strokeWidth={2.0} />
                </button>
              </Tooltip>
            )}

            <div className={isOpen ? "h-1" : "h-1.5"}></div>

            {/* Menu Items */}
            <div className={isOpen ? "space-y-0.5 mt-0" : "space-y-1.5 mt-0"}>
              {[
                { id: 'tasks', label: 'Tasks', icon: AlarmClockCheck, tooltip: 'Manage tasks', onClick: () => setActiveView('projects'), active: activeView === 'projects' },
                { id: 'agents', label: 'Agents', icon: Users, tooltip: 'Manage agents', onClick: () => setActiveView('agents'), active: activeView === 'agents' },
                { id: 'channels', label: 'Channels', icon: LinkIcon, tooltip: 'Deploy agents to channels', onClick: () => setActiveView('channels'), active: activeView === 'channels' },
              ].map(item => {
                const Icon = item.icon;
                const isActive = item.active;

                if (isOpen) {
                  return (
                    <Tooltip key={item.id} text={item.tooltip} side="right">
                      <button
                        type="button"
                        aria-current={isActive ? 'page' : undefined}
                        onMouseDown={(e) => triggerGlassClick(e, `nav-${ item.id }`)}
                        onClick={item.onClick}
                        style={glassClickStyle(`nav-${ item.id }`)}
                        className={`eterx-sidebar-click-surface eterx-sidebar-nav-item ${ glassClickClass(`nav-${ item.id }`) } ${ isActive ? 'eterx-sidebar-nav-active' : '' } w-full h-[38px] flex items-center gap-3 px-3 text-[13.5px] font-medium rounded-[12px] transition-colors duration-150 ease-out group relative overflow-hidden ${ isActive
                            ? 'text-[var(--sidebar-active-text)] bg-[var(--sidebar-active-bg)]'
                            : 'text-[var(--sidebar-text)]'
                          }`}
                      >
                        <Icon
                          className={`w-[16px] h-[16px] transition-colors duration-150 ease-out relative z-10 ${ isActive ? 'text-[var(--sidebar-active-text)]' : 'text-[var(--sidebar-icon)]'
                            }`}
                          strokeWidth={2.0}
                        />
                        <span className="relative z-10 whitespace-nowrap">{item.label}</span>
                      </button>
                    </Tooltip>
                  );
                } else {
                  return (
                    <Tooltip key={item.id} text={item.tooltip} side="right">
                      <button
                        type="button"
                        aria-label={item.label}
                        aria-current={isActive ? 'page' : undefined}
                        onMouseDown={(e) => triggerGlassClick(e, `nav-${ item.id }`)}
                        onClick={item.onClick}
                        style={glassClickStyle(`nav-${ item.id }`)}
                        className={`eterx-sidebar-click-surface eterx-sidebar-nav-item ${ glassClickClass(`nav-${ item.id }`) } ${ isActive ? 'eterx-sidebar-nav-active' : '' } w-[38px] h-[38px] flex items-center justify-center rounded-full transition-colors duration-150 ease-out group relative mx-auto ${ isActive
                            ? 'text-[var(--sidebar-active-text)] bg-[var(--sidebar-active-bg)]'
                            : 'text-[var(--sidebar-text)]'
                          }`}
                      >
                        <Icon
                          className={`w-[16px] h-[16px] transition-colors duration-150 ease-out relative z-10 ${ isActive ? 'text-[var(--sidebar-active-text)]' : 'text-[var(--sidebar-icon)]'
                            }`}
                          strokeWidth={2.0}
                        />
                      </button>
                    </Tooltip>
                  );
                }
              })}
            </div>
          </nav>

          {/* Expanded Recents List */}
          {isOpen ? (
            <div className="eterx-sidebar-recents flex-1 mt-0 ml-1 mr-1 mb-1 bg-transparent rounded-[16px] border border-transparent flex flex-col py-3 overflow-hidden relative">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-transparent" />
              <div className="flex items-center justify-between pl-3.5 pr-1.5 mb-1.5 min-h-[26px] relative z-30">
                <div ref={projectMenuRef} className="relative flex min-w-0 flex-1">
                  {isSelectMode ? (
                    <span className="eterx-sidebar-section-title text-[13px] font-medium text-[var(--sidebar-muted-text)] tracking-normal shrink-0 transition-colors duration-150">
                      {`${ selectedCount } selected`}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Chat scope: ${ activeProject?.name || 'Recents' }`}
                      aria-haspopup="menu"
                      aria-expanded={projectMenuOpen}
                      onClick={(event) => {
                        event.stopPropagation();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        const menuWidth = Math.min(220, Math.max(180, sidebarWidth - 48));
                        setProjectMenuPosition({
                          top: Math.round(bounds.bottom + 6),
                          left: Math.max(8, Math.min(Math.round(bounds.left), window.innerWidth - menuWidth - 8)),
                        });
                        setProjectMenuOpen(open => !open);
                      }}
                      className={`eterx-sidebar-project-filter group/filter flex min-w-0 max-w-full items-center gap-1 rounded-full border border-transparent px-2 py-1 text-left text-[13px] font-medium text-[var(--sidebar-muted-text)] transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out hover:bg-[var(--sidebar-hover-bg)] hover:text-[var(--sidebar-hover-text)] active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)] ${ projectMenuOpen ? 'is-open' : '' }`}
                    >
                      <span className="eterx-sidebar-section-title min-w-0 truncate">
                        {activeProject?.name || 'Recents'}
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${ projectMenuOpen ? 'rotate-180' : '' }`} strokeWidth={2.1} />
                    </button>
                  )}

                  {!isSelectMode && projectMenuOpen && typeof document !== 'undefined' && createPortal(
                    <motion.div
                      ref={projectMenuPortalRef}
                      initial={reduceMotion ? false : { opacity: 0, y: -4, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={reduceMotion ? undefined : { opacity: 0, y: -3, scale: 0.98 }}
                      transition={reduceMotion ? { duration: 0 } : { duration: 0.14, ease: 'easeOut' }}
                      role="menu"
                      aria-label="Chat scope"
                      aria-orientation="vertical"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setProjectMenuOpen(false);
                          window.requestAnimationFrame(() => projectMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
                          return;
                        }
                        handleMenuKeyboardNavigation(event);
                      }}
                      style={{ position: 'fixed', top: projectMenuPosition.top, left: projectMenuPosition.left }}
                      className="eterx-sidebar-project-menu eterx-scrollbar z-[120] max-h-[min(360px,calc(100vh-180px))] w-[220px] min-w-0 max-w-[calc(100vw-24px)] overflow-y-auto rounded-[16px] border-0 p-1.5"
                    >
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={!selectedProjectPath}
                        onClick={() => handleProjectSelect(null)}
                        className="eterx-sidebar-project-menu-item group/menu-item"
                      >
                        <span className="min-w-0 flex-1 truncate text-left">Recents</span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--sidebar-muted-text)] transition-transform duration-150 group-hover/menu-item:translate-x-0.5 group-hover/menu-item:text-[var(--sidebar-hover-text)]" strokeWidth={2} />
                      </button>

                      {projects.map(project => (
                        <button
                          key={project.path}
                          type="button"
                          role="menuitemradio"
                          aria-checked={activeProject?.path.toLowerCase() === project.path.toLowerCase()}
                          title={project.path}
                          onClick={() => handleProjectSelect(project.path)}
                          className="eterx-sidebar-project-menu-item group/menu-item"
                        >
                          <FolderClosed className="h-3.5 w-3.5 shrink-0" strokeWidth={1.95} />
                          <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--sidebar-muted-text)] transition-transform duration-150 group-hover/menu-item:translate-x-0.5 group-hover/menu-item:text-[var(--sidebar-hover-text)]" strokeWidth={2} />
                        </button>
                      ))}
                    </motion.div>,
                    document.body
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip text="Search all chats · Ctrl K" side="right">
                    <button
                      type="button"
                      aria-label="Search all chats"
                      onMouseDown={(event) => triggerGlassClick(event, 'search-chats')}
                      onClick={(event) => { event.stopPropagation(); onSearchClick(); }}
                      style={glassClickStyle('search-chats')}
                      className={`eterx-sidebar-click-surface ${ glassClickClass('search-chats') } h-7 w-7 inline-flex items-center justify-center rounded-[8px] border border-transparent text-[var(--sidebar-muted-text)] transition-colors hover:bg-[var(--sidebar-hover-bg)] hover:text-[var(--sidebar-hover-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)]`}
                    >
                      <Search className="w-[14px] h-[14px]" strokeWidth={2.1} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <AnimatePresence mode="popLayout">
                    {isSelectMode ? (
                      <motion.div
                        key="select-actions"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        className="flex items-center gap-1"
                      >
                        <Tooltip text={allChatsSelected ? "Clear selection" : "Select all chats"} side="right">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleSelectAllToggle(); }}
                            disabled={filteredChats.length === 0}
                            className={`h-7 w-7 inline-flex items-center justify-center rounded-[8px] hover:bg-[var(--sidebar-hover-bg)] disabled:text-[var(--sidebar-muted-text)] disabled:hover:bg-transparent transition-colors ${ allChatsSelected ? 'text-[var(--sidebar-active-text)] bg-[var(--sidebar-active-bg)]' : 'text-[var(--sidebar-muted-text)]' }`}
                          >
                            <Check className="w-[13px] h-[13px]" strokeWidth={2.6} />
                          </button>
                        </Tooltip>
                        <Tooltip text="Delete selected" side="right">
                          <button
                            type="button"
                            aria-label="Delete selected chats"
                            onClick={(e) => { e.stopPropagation(); selectedCount > 0 && setShowDeleteConfirm(true); }}
                            className={`h-7 w-7 inline-flex items-center justify-center rounded-[8px] transition-colors ${ selectedCount > 0 ? 'text-[#EF4444] hover:bg-red-500/10' : 'text-[#555350] cursor-not-allowed' }`}
                          >
                            <PremiumTrash className="w-[14px] h-[14px]" />
                          </button>
                        </Tooltip>
                        <Tooltip text="Cancel selection" side="right">
                          <button
                            type="button"
                            aria-label="Cancel chat selection"
                            onClick={(e) => { e.stopPropagation(); exitSelectMode(); }}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-[8px] text-[var(--sidebar-muted-text)] hover:bg-[var(--sidebar-hover-bg)] hover:text-[var(--sidebar-hover-text)] transition-colors"
                          >
                            <X className="w-[14px] h-[14px]" strokeWidth={2.5} />
                          </button>
                        </Tooltip>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="select-entry"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        className="flex items-center gap-1"
                      >
                        <Tooltip text="Select chats" side="right">
                          <button
                            type="button"
                            aria-label="Select chats"
                            disabled={filteredChats.length === 0}
                            onMouseDown={(e) => triggerGlassClick(e, 'select-chats')}
                            onClick={(e) => { e.stopPropagation(); enterSelectMode(); }}
                            style={glassClickStyle('select-chats')}
                            className={`eterx-sidebar-click-surface ${ glassClickClass('select-chats') } h-7 w-7 inline-flex items-center justify-center rounded-[8px] border border-transparent text-[var(--sidebar-muted-text)] transition-colors hover:bg-[var(--sidebar-hover-bg)] hover:text-[var(--sidebar-hover-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)] disabled:pointer-events-none disabled:text-[var(--sidebar-muted-text)] disabled:opacity-45`}
                          >
                            <PremiumCheckSquare className="w-[14px] h-[14px]" strokeWidth={2.1} />
                          </button>
                        </Tooltip>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              <div
                ref={scrollContainerRef}
                onScroll={handleRecentChatsScroll}
                className={`eterx-sidebar-recents-scroll min-w-0 flex-1 overflow-x-hidden overflow-y-auto eterx-scrollbar pl-2 pr-2 space-y-0.5 relative z-10 ${ recentScrollFades.top && recentScrollFades.bottom ? 'eterx-sidebar-scroll-fade-both' : recentScrollFades.top ? 'eterx-sidebar-scroll-fade-top' : recentScrollFades.bottom ? 'eterx-sidebar-scroll-fade-bottom' : '' }`}
                style={{ scrollBehavior: isDragSelecting ? 'auto' : undefined, overscrollBehavior: 'contain' }}
              >
                {isLoadingChats || isProjectPending ? (
                  <div className="eterx-sidebar-empty flex items-center gap-2 px-3 py-2 text-[12.5px] text-[var(--sidebar-muted-text)]">
                    <span className="eterx-sidebar-project-loading h-3 w-3 shrink-0 rounded-full border border-current border-r-transparent" aria-hidden="true" />
                    Loading chats…
                  </div>
                ) : filteredChats.length === 0 ? (
                  <div className="eterx-sidebar-empty px-3 py-2 text-[12.5px] text-[var(--sidebar-muted-text)]">
                    {selectedProjectPath ? 'No chats in this project yet' : 'No recent chats'}
                  </div>
                ) : (
                  visibleChats.map((chat) => {
                    const isActive = (activeChatId === chat.id || (additionalActiveChatIds instanceof Set ? additionalActiveChatIds.has(chat.id) : Array.isArray(additionalActiveChatIds) ? additionalActiveChatIds.includes(chat.id) : false)) && activeView === 'chat';
                    const isWorking = runningChats?.has(chat.id) ?? false;
                    const hasUnread = !isActive && !isWorking && (unreadChats?.has(chat.id) ?? false);
                    const isMenuOpen = menuState?.id === chat.id;
                    const isSelected = selectedChatIds.has(chat.id);
                    const timeLabel = formatChatUpdatedAt(chat.updatedAt, now);

                    return (
                      <div
                        key={chat.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`Open chat ${ chat.title }${ isWorking ? ', agent working' : hasUnread ? ', unread agent update' : '' }`}
                        aria-pressed={isSelectMode ? isSelected : undefined}
                        onPointerDown={(e) => {
                          triggerGlassClick(e, `chat-${ chat.id }`);
                          if (isSelectMode) {
                            e.preventDefault();
                            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
                            dragPointerXRef.current = e.clientX;
                            dragPointerYRef.current = e.clientY;
                            lastDragTouchedChatRef.current = chat.id;
                            setIsDragSelecting(true);
                            const willSelect = !selectedChatIdsRef.current.has(chat.id);
                            dragSelectStateRef.current = willSelect;
                            setDragSelectState(willSelect);
                            applyChatSelection(chat.id, willSelect);
                          }
                        }}
                        onContextMenu={(e) => {
                          if (isWorking) return;
                          if (isSelectMode) {
                            e.preventDefault();
                            return;
                          }
                          e.preventDefault();
                          e.stopPropagation();
                          setMenuState({ id: chat.id, x: e.clientX, y: e.clientY, dropUp: e.clientY + 260 > window.innerHeight });
                        }}
                        data-chat-id={chat.id}
                        aria-current={isActive && !isSelectMode ? 'page' : undefined}
                        onClick={() => {
                          if (!isSelectMode) {
                            loadChat(chat.id); setActiveView('chat');
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          if (isSelectMode) {
                            applyChatSelection(chat.id, !isSelected);
                            return;
                          }
                          loadChat(chat.id);
                          setActiveView('chat');
                        }}
                        style={glassClickStyle(`chat-${ chat.id }`)}
                        className={`eterx-sidebar-click-surface eterx-sidebar-chat-row ${ glassClickClass(`chat-${ chat.id }`) } ${ isActive && !isSelectMode ? 'eterx-sidebar-chat-active' : '' } ${ isWorking && !isSelectMode ? 'eterx-sidebar-chat-working' : '' } ${ hasUnread && !isSelectMode ? 'eterx-sidebar-chat-unread' : '' } ${ isSelectMode && isSelected ? 'eterx-sidebar-chat-selected' : '' } w-full min-h-[38px] text-left px-3 transition-colors duration-150 ease-out flex items-center group cursor-pointer text-[13px] leading-normal rounded-[10px] border relative z-0 overflow-hidden ${ isActive && !isSelectMode ? 'bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active-text)] border-transparent font-medium' : isWorking && !isSelectMode ? 'bg-transparent text-[var(--sidebar-text)] border-transparent' : 'text-[var(--sidebar-text)] border-transparent' } ${ isSelectMode && isSelected ? 'bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active-text)] border-transparent' : '' } ${ isSelectMode ? 'select-none touch-none' : '' }`}
                      >
                        {isSelectMode && (
                          <span
                            className={`eterx-sidebar-select-check mr-2 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border text-transparent transition-colors duration-150 ${ isSelected ? 'text-[#181714]' : '' }`}
                            aria-hidden="true"
                          >
                            {isSelected && <Check className="h-[11px] w-[11px]" strokeWidth={3} />}
                          </span>
                        )}

                        <div className={`eterx-sidebar-chat-content ${ !isWorking && !isSelectMode && isMenuOpen ? 'eterx-sidebar-chat-content-menu-visible' : '' } ${ isWorking && !isSelectMode ? 'eterx-sidebar-chat-content-working' : '' } flex min-w-0 max-w-full flex-1 items-center overflow-hidden relative z-10 pl-0`}>
                          {editingChatId === chat.id && !isWorking ? (
                            <input
                              autoFocus
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onBlur={() => {
                                if (editTitle.trim() && editTitle !== chat.title) renameChat(chat.id, editTitle.trim());
                                setEditingChatId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  if (editTitle.trim() && editTitle !== chat.title) renameChat(chat.id, editTitle.trim());
                                  setEditingChatId(null);
                                } else if (e.key === 'Escape') {
                                  setEditingChatId(null);
                                }
                              }}
                              className="bg-transparent border-none outline-none text-[var(--sidebar-strong-text)] font-medium w-full text-[13px] leading-normal relative z-10 p-0 m-0"
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            // Key by the actual title so replacement fully
                            // discards the temporary marquee measurement and
                            // animation state instead of painting both states.
                            <ChatTitleMarquee
                              key={`${chat.id}:${chat.title}`}
                              title={chat.title}
                              isFavorite={chat.isFavorite}
                            />
                          )}
                        </div>

                        {!isSelectMode && (
                          <div className="eterx-sidebar-chat-meta ml-1.5 flex shrink-0 items-center justify-end relative z-10">
                            {isWorking ? (
                              <span
                                className="eterx-sidebar-running-indicator eterx-splash-spinner"
                                aria-label="Agent working"
                              />
                            ) : hasUnread ? (
                              <span className="eterx-sidebar-unread-dot" aria-label="Unread agent update" />
                            ) : (
                              <div className="relative w-7 h-7 shrink-0 flex items-center justify-center">
                                {timeLabel && (
                                  <span
                                    className={`eterx-sidebar-chat-time tabular-nums transition-opacity duration-150 absolute inset-0 flex items-center justify-center pointer-events-none whitespace-nowrap ${ isMenuOpen ? 'opacity-0' : 'group-hover:opacity-0' }`}
                                    title={new Date(chat.updatedAt).toLocaleString()}
                                  >{timeLabel}</span>
                                )}
                                <button
                                  type="button"
                                  aria-label="Chat options"
                                  aria-haspopup="menu"
                                  aria-expanded={isMenuOpen}
                                  ref={(element) => { chatMenuButtonRefs.current[chat.id] = element; }}
                                  onMouseDown={(e) => triggerGlassClick(e, `chat-menu-${ chat.id }`)}
                                  style={glassClickStyle(`chat-menu-${ chat.id }`)}
                                  className={`eterx-sidebar-click-surface eterx-sidebar-chat-menu-button ${ glassClickClass(`chat-menu-${ chat.id }`) } absolute inset-0 z-20 flex items-center justify-center rounded-[8px] transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)] focus-visible:opacity-100 ${ isMenuOpen ? 'opacity-100 text-[var(--sidebar-active-text)]' : 'opacity-0 group-hover:opacity-100 text-[var(--sidebar-muted-text)]' }`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isWorking) return;
                                    if (isMenuOpen) {
                                      setMenuState(null);
                                    } else {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      const dropUp = rect.bottom + 220 > window.innerHeight;
                                      setMenuState({ id: chat.id, x: rect.right, y: dropUp ? rect.top : rect.bottom, dropUp });
                                    }
                                  }}
                                >
                                  <PremiumMoreHorizontal className="w-4 h-4 transition-colors duration-150" />
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                      </div>
                    );
                  })
                )}
                {visibleChatCount < filteredChats.length && (
                  <div className="px-3 py-2 text-center text-[11px] text-[var(--sidebar-muted-text)]">
                    Scroll for {filteredChats.length - visibleChatCount} older chats
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1" />
          )}

          {/* Bottom Profile Area */}
          {isOpen ? (
            <div className="eterx-sidebar-profile relative z-10 px-2 py-2 border-t border-transparent bg-transparent">
              <Tooltip text="Open settings" side="right">
                <button
                  type="button"
                  onMouseDown={(e) => triggerGlassClick(e, 'profile-card')}
                  onClick={onSettingsClick}
                  disabled={!onSettingsClick}
                  aria-label="Open settings"
                style={glassClickStyle('profile-card')}
                className={`eterx-sidebar-click-surface eterx-sidebar-profile-card eterx-sidebar-settings-button ${ glassClickClass('profile-card') } flex h-[42px] w-full cursor-pointer items-center gap-3 rounded-[10px] border border-transparent px-3 text-left text-[var(--sidebar-text)] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)] group`}
                >
                  <span className="eterx-sidebar-profile-action flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-transparent text-current transition-colors">
                    <PremiumSettings className="w-4 h-4 transition-colors duration-150" strokeWidth={2.15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-current transition-colors">
                    Settings
                  </span>
                </button>
              </Tooltip>
            </div>
          ) : (
            <div className="eterx-sidebar-profile relative z-10 px-2 py-2 border-t border-transparent bg-transparent flex flex-col items-center">
              <Tooltip text="Settings" side="right">
                <button
                  type="button"
                  onMouseDown={(e) => triggerGlassClick(e, 'profile-settings-collapsed')}
                  onClick={onSettingsClick}
                  aria-label="Open settings"
                  disabled={!onSettingsClick}
                  style={glassClickStyle('profile-settings-collapsed')}
                  className={`eterx-sidebar-click-surface eterx-sidebar-profile-icon-button ${ glassClickClass('profile-settings-collapsed') } w-[38px] h-[38px] flex items-center justify-center rounded-[12px] text-[var(--sidebar-muted-text)] border border-transparent hover:bg-[var(--sidebar-hover-bg)] hover:text-[var(--sidebar-hover-text)] transition-colors duration-150 group`}
                >
                  <PremiumSettings className="w-[18px] h-[18px] transition-colors duration-150" strokeWidth={2.15} />
                </button>
              </Tooltip>
            </div>
          )}
        </div>
        {!isMobile && (
          <div
            className={`eterx-sidebar-resize-handle ${ isResizingSidebar ? 'eterx-sidebar-resize-handle-active' : '' }`}
          >
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              aria-valuemin={getSidebarViewportMin(viewportWidth)}
              aria-valuemax={getSidebarViewportMax(viewportWidth)}
              aria-valuenow={sidebarWidth}
              onPointerDown={handleSidebarResizePointerDown}
              onKeyDown={handleSidebarResizeKeyDown}
              className="eterx-sidebar-resize-target"
            />
          </div>
        )}
      </motion.aside>

      {menuState && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[999999]"
          onClick={(e) => { e.stopPropagation(); setMenuState(null); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenuState(null); }}
        >
          <AnimatePresence>
            <motion.div
              ref={chatMenuRef}
              initial={reduceMotion ? false : { opacity: 0, y: menuState.dropUp ? 5 : -5, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, scale: 0.95 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
              role="menu"
              aria-label={`Chat options for ${ chats.find(chat => chat.id === menuState.id)?.title || 'conversation' }`}
              aria-orientation="vertical"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  const chatId = menuState.id;
                  setMenuState(null);
                  restoreChatMenuFocus(chatId);
                  return;
                }
                handleMenuKeyboardNavigation(event);
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
              style={{
                position: 'fixed',
                left: Math.max(8, Math.min(menuState.x - 16, window.innerWidth - 216)),
                top: Math.max(8, Math.min(menuState.dropUp ? menuState.y - 248 : menuState.y - 8, window.innerHeight - 280)),
              }}
              className="eterx-sidebar-menu w-52 bg-[var(--sidebar-menu-bg)] border border-transparent rounded-[12px] p-1.5 flex flex-col gap-0.5"
            >
              <button
                type="button"
                role="menuitem"
                onClick={(e) => { e.stopPropagation(); handleShare(menuState.id); }}
                className="eterx-sidebar-menu-item w-full px-3 py-2 text-[13px] font-medium text-[var(--sidebar-muted-text)] hover:text-[var(--sidebar-hover-text)] hover:bg-[var(--sidebar-hover-bg)] rounded-[10px] flex items-center gap-3 transition-colors duration-150 ease-out text-left group/btn"
              >
                <PremiumShare className="w-4 h-4 text-[var(--sidebar-icon)] group-hover/btn:text-[var(--sidebar-hover-text)] transition-colors duration-150" />
                {shareCopiedId === menuState.id ? <span className="text-[var(--sidebar-hover-text)]">Link copied!</span> : "Share"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingChatId(menuState.id);
                  setEditTitle(chats.find(c => c.id === menuState.id)?.title || "");
                  setMenuState(null);
                }}
                className="eterx-sidebar-menu-item w-full px-3 py-2 text-[13px] font-medium text-[var(--sidebar-muted-text)] hover:text-[var(--sidebar-hover-text)] hover:bg-[var(--sidebar-hover-bg)] rounded-[10px] flex items-center gap-3 transition-colors duration-150 ease-out text-left group/btn"
              >
                <PremiumEdit className="w-4 h-4 text-[var(--sidebar-icon)] group-hover/btn:text-[var(--sidebar-hover-text)] transition-colors duration-150" /> Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(menuState.id);
                  setMenuState(null);
                }}
                className="eterx-sidebar-menu-item w-full px-3 py-2 text-[13px] font-medium text-[var(--sidebar-muted-text)] hover:text-[var(--sidebar-hover-text)] hover:bg-[var(--sidebar-hover-bg)] rounded-[10px] flex items-center gap-3 transition-colors duration-150 ease-out text-left group/btn"
              >
                <PremiumStar className="w-4 h-4 text-[var(--sidebar-icon)] group-hover/btn:text-[var(--sidebar-hover-text)] transition-colors duration-150" />
                {chats.find(c => c.id === menuState.id)?.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              </button>
              <button type="button" role="menuitem" disabled aria-disabled="true" className="eterx-sidebar-menu-item w-full px-3 py-2 text-[13px] font-medium text-[var(--sidebar-muted-text)] rounded-[10px] flex items-center gap-3 transition-colors duration-150 ease-out text-left justify-between group/btn cursor-not-allowed opacity-60 disabled:hover:bg-transparent disabled:hover:text-[var(--sidebar-muted-text)]" title="Coming soon">
                <div className="flex items-center gap-3">
                  <FolderClosed className="w-4 h-4 text-[var(--sidebar-icon)] group-hover/btn:text-[var(--sidebar-hover-text)] transition-colors duration-150" strokeWidth={2.0} /> Move to Project
                </div>
                <ChevronRight className="eterx-sidebar-menu-chevron w-4 h-4 text-[var(--sidebar-muted-text)] transition-colors duration-150" />
              </button>

              <div className="h-[1px] w-full bg-[var(--sidebar-menu-border)] my-1 rounded-full" />

              <button
                type="button"
                role="menuitem"
                className="eterx-sidebar-menu-danger w-full px-3 py-2 text-[13px] font-medium text-[var(--sidebar-danger-text)] hover:text-[var(--sidebar-danger-text)] hover:bg-[var(--sidebar-danger-bg)] rounded-[10px] flex items-center gap-3 transition-colors duration-150 ease-out text-left group/btn"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChat(menuState.id);
                  setMenuState(null);
                }}
              >
                <PremiumTrash className="w-4 h-4 transition-colors duration-150" /> Delete
              </button>
            </motion.div>
          </AnimatePresence>
        </div>,
        document.body
      )}

      {/* Confirmation Modal */}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {showDeleteConfirm && (
            <motion.div
              className="fixed inset-0 z-[1000] flex items-center justify-center transition-colors duration-200 ease-out bg-black/60 backdrop-blur-sm"
              onClick={(e) => { e.stopPropagation(); !isDeleting && setShowDeleteConfirm(false); }}
            >
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, scale: 0.95, y: 10 }}
                transition={reduceMotion ? { duration: 0 } : undefined}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="eterx-delete-chats-title"
                aria-describedby="eterx-delete-chats-description"
                className="bg-[#141414] border border-white/[0.08] shadow-none rounded-[24px] p-6 max-w-[360px] w-full mx-4 flex flex-col gap-6 relative overflow-hidden"
              >
                <div className="flex flex-col gap-2 relative z-10">
                  <h3 id="eterx-delete-chats-title" className="text-[#E8E6E3] text-[18px] font-semibold">Delete {selectedChatIds.size} chats?</h3>
                  <p id="eterx-delete-chats-description" className="text-[#A3A19E] text-[14px] leading-relaxed">
                    Are you sure you want to delete the selected chats? This action cannot be undone and the history will be lost forever.
                  </p>
                </div>
                <div className="flex items-center justify-end gap-3 w-full relative z-10">
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    disabled={isDeleting}
                    className={`px-4 py-2 rounded-[12px] text-[#A3A19E] hover:text-[#E8E6E3] hover:bg-white/[0.05] transition-colors text-[14px] font-medium ${ isDeleting ? 'opacity-50 cursor-not-allowed pointer-events-none' : '' }`}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleBulkDelete}
                    disabled={isDeleting}
                    className={`relative flex items-center justify-center gap-2 py-2 rounded-[12px] bg-[#EF4444] text-white transition-[width,background-color,color] duration-200 ease-out text-[14px] font-medium overflow-hidden ${ isDeleting ? 'w-[150px] cursor-not-allowed hover:bg-[#EF4444]' : 'w-[130px] hover:bg-[#DC2626]' }`}
                  >
                    <span className={`transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] whitespace-nowrap ${ isDeleting ? '-translate-x-3' : 'translate-x-0' }`}>
                      {isDeleting ? 'Deleting' : 'Delete Forever'}
                    </span>
                    {isDeleting && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.5, x: 10 }}
                        animate={{ opacity: 1, scale: 1, x: 0 }}
                        className="absolute right-[14px] w-[14px] h-[14px] border-[2px] border-white/20 border-t-white rounded-full animate-spin"
                      />
                    )}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
});
