import React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronRight, Check } from 'lucide-react';
import { PremiumShare, PremiumEdit, PremiumStar, PremiumFolder, PremiumTrash, PremiumSearch, PremiumDashboard, PremiumAgent, PremiumChannels, PremiumMoreHorizontal, PremiumCheckSquare, PremiumSettings } from '../ui/premium-icons';
import { Tooltip } from '../ui/tooltip';

const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_AUTO_CLOSE_EDGE = 28;
const SIDEBAR_WIDTH_STORAGE_KEY = 'eterx.sidebar.width';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const clampSidebarWidth = (width: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));

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

const lightweightSidebarVars = {
  width: 'var(--eterx-shell-sidebar-width)',
} as React.CSSProperties;

const lightweightSidebarCss = `
  :root[data-theme="dark"] .eterx-sidebar-shell {
    --sidebar-hover-bg: rgba(255, 255, 255, 0.07);
    --sidebar-toggle-hover-bg: rgba(255, 255, 255, 0.07);
    --sidebar-active-bg: rgba(255, 255, 255, 0.105);
    --sidebar-toggle-active-bg: rgba(255, 255, 255, 0.105);
    --sidebar-active-fade: rgba(15, 15, 15, 0.96);
    --sidebar-menu-bg: #121212;
    --sidebar-menu-border: transparent;
    --sidebar-active-shadow: none;
    --sidebar-unread-dot: #77BCFF;
    --sidebar-unread-dot-ring: rgba(119, 188, 255, 0.18);
    --sidebar-time-text: rgba(210, 206, 197, 0.56);
    --sidebar-running-track: rgba(255, 255, 255, 0.20);
    --sidebar-running-head: rgba(241, 236, 228, 0.92);
    background: var(--sidebar-bg) !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell {
    --sidebar-hover-bg: #F1F1EE;
    --sidebar-toggle-hover-bg: #F1F1EE;
    --sidebar-active-bg: #E8E7E2;
    --sidebar-toggle-active-bg: #E8E7E2;
    --sidebar-active-fade: #E8E7E2;
    --sidebar-menu-bg: #F7F7F4;
    --sidebar-menu-border: transparent;
    --sidebar-active-shadow: none;
    --sidebar-unread-dot: #228BE6;
    --sidebar-unread-dot-ring: rgba(34, 139, 230, 0.16);
    --sidebar-time-text: rgba(80, 91, 104, 0.62);
    --sidebar-running-track: rgba(39, 49, 63, 0.18);
    --sidebar-running-head: rgba(39, 49, 63, 0.82);
    background: var(--sidebar-bg) !important;
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
    background: var(--sidebar-shell-sheen) !important;
    background-size: 180% 100% !important;
    opacity: 0.58;
    animation: none;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-recents,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-recents,
  .eterx-sidebar-shell .eterx-sidebar-recents {
    -webkit-backdrop-filter: blur(16px) saturate(1.08) !important;
    backdrop-filter: blur(16px) saturate(1.08) !important;
    border-color: rgba(255, 255, 255, 0.072) !important;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.052),
      inset 0 -1px 0 rgba(0, 0, 0, 0.18) !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-recents-scroll {
    scrollbar-gutter: auto !important;
  }



  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-recents,
  .eterx-sidebar-shell .eterx-sidebar-recents {
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.040), rgba(255, 255, 255, 0.018)),
      rgba(16, 16, 16, 0.30) !important;
  }

  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-recents {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.74), rgba(255, 255, 255, 0.52)) !important;
    border-color: rgba(31, 31, 29, 0.07) !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9) !important;
  }

  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-profile,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-profile,
  .eterx-sidebar-shell .eterx-sidebar-profile {
    background: transparent !important;
    border-top-color: transparent !important;
  }

  .eterx-sidebar-resize-handle {
    position: absolute;
    top: calc(var(--eterx-shell-topbar-height) + 6px);
    right: 0;
    bottom: 8px;
    z-index: 60;
    width: 18px;
    cursor: col-resize;
    touch-action: none;
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
    background: transparent !important;
    border-color: transparent !important;
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
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-selected,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active.eterx-sidebar-chat-working,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-nav-active,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-active,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-selected,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-active.eterx-sidebar-chat-working,
  .eterx-sidebar-shell .eterx-sidebar-nav-active,
  .eterx-sidebar-shell .eterx-sidebar-chat-active,
  .eterx-sidebar-shell .eterx-sidebar-chat-selected,
  .eterx-sidebar-shell .eterx-sidebar-chat-active.eterx-sidebar-chat-working {
    background: var(--sidebar-active-bg) !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-working:not(.eterx-sidebar-chat-active) {
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
    background: color-mix(in srgb, var(--sidebar-bg) 40%, var(--sidebar-strong-text) 12%) !important;
    border: 1px solid var(--sidebar-surface-border) !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16) !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-menu-button:hover {
    background: color-mix(in srgb, var(--sidebar-bg) 20%, var(--sidebar-strong-text) 20%) !important;
    border-color: var(--sidebar-surface-border) !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22) !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-menu-button:active {
    background: color-mix(in srgb, var(--sidebar-bg) 10%, var(--sidebar-strong-text) 26%) !important;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12) !important;
  }


  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-nav-active:hover,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-active:hover,
  :root[data-theme="dark"] .eterx-sidebar-shell .eterx-sidebar-chat-selected:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-nav-active:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-active:hover,
  :root[data-theme="light"] .eterx-sidebar-shell .eterx-sidebar-chat-selected:hover,
  .eterx-sidebar-shell .eterx-sidebar-nav-active:hover,
  .eterx-sidebar-shell .eterx-sidebar-chat-active:hover,
  .eterx-sidebar-shell .eterx-sidebar-chat-selected:hover {
    background: var(--sidebar-active-bg) !important;
    color: var(--sidebar-active-text) !important;
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

  .eterx-sidebar-shell .eterx-sidebar-chat-content {
    min-width: 0;
    -webkit-mask-image: linear-gradient(90deg, #000 0%, #000 calc(100% - 0.2rem), transparent calc(100% - 0.05rem)) !important;
    mask-image: linear-gradient(90deg, #000 0%, #000 calc(100% - 0.2rem), transparent calc(100% - 0.05rem)) !important;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-content-menu-visible,
  .eterx-sidebar-shell .eterx-sidebar-chat-row:hover .eterx-sidebar-chat-content {
    -webkit-mask-image: linear-gradient(90deg, #000 0%, #000 calc(100% - 2.35rem), transparent calc(100% - 2.2rem)) !important;
    mask-image: linear-gradient(90deg, #000 0%, #000 calc(100% - 2.35rem), transparent calc(100% - 2.2rem)) !important;
  }







  .eterx-sidebar-shell .eterx-sidebar-chat-content-working {
    padding-right: 0 !important;
  }


  .eterx-sidebar-shell .eterx-sidebar-chat-meta {
    min-width: 2.15rem;
    height: 100%;
    color: var(--sidebar-time-text);
    font-size: 12.5px;
    font-weight: 560;
    letter-spacing: 0;
    transition: opacity 150ms ease, transform 150ms ease, color 150ms ease, min-width 150ms ease, margin-left 150ms ease, width 150ms ease;
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-row:not(.eterx-sidebar-chat-working):hover .eterx-sidebar-chat-meta,
  .eterx-sidebar-shell .eterx-sidebar-chat-meta-hidden {
    opacity: 0;
    transform: translateX(3px);
    width: 0 !important;
    min-width: 0 !important;
    margin-left: 0 !important;
    overflow: hidden;
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
    animation: eterx-sidebar-spin 0.82s linear infinite;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.035);
  }

  .eterx-sidebar-shell .eterx-sidebar-chat-active .eterx-sidebar-running-indicator {
    border-color: color-mix(in srgb, var(--sidebar-active-text) 20%, transparent);
    border-right-color: color-mix(in srgb, var(--sidebar-active-text) 86%, transparent);
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

  @media (min-width: 769px) {
    .eterx-sidebar-shell {
      border-top-right-radius: 0 !important;
      border-bottom-right-radius: 0 !important;
      margin-right: -8px !important;
    }

    .eterx-sidebar-shell .eterx-sidebar-sheen {
      border-top-right-radius: 0 !important;
      border-bottom-right-radius: 0 !important;
    }
  }
`;

interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  traceLogs: any[];
  isFavorite?: boolean;
}

interface SidebarProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  createNewChat: () => void;
  chats: ChatSession[];
  activeChatId: string | null;
  loadChat: (id: string) => void;
  deleteChat: (id: string) => void;
  deleteChats?: (ids: string[]) => void;
  renameChat: (id: string, newTitle: string) => void;
  toggleFavorite: (id: string) => void;
  onSearchClick: () => void;
  activeView: 'chat' | 'code' | 'agents' | 'channels' | 'projects';
  setActiveView: (view: 'chat' | 'code' | 'agents' | 'channels' | 'projects') => void;
  runningChats?: Set<string>;
  unreadChats?: Set<string>;
  onSettingsClick?: () => void;
  isThinking?: boolean;
}

export const Sidebar = React.memo<SidebarProps>(({
  isOpen, setIsOpen, createNewChat, chats, activeChatId, loadChat, deleteChat, deleteChats, renameChat, toggleFavorite, onSearchClick, activeView, setActiveView, runningChats, unreadChats, onSettingsClick, isThinking
}) => {
  const [menuState, setMenuState] = React.useState<{ id: string, x: number, y: number, dropUp: boolean } | null>(null);
  const [toggleHovered, setToggleHovered] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);
  const [sidebarWidth, setSidebarWidth] = React.useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const resizeStartRef = React.useRef({ x: 0, width: SIDEBAR_DEFAULT_WIDTH });
  const resizeCurrentWidthRef = React.useRef(SIDEBAR_DEFAULT_WIDTH);
  const resizeLastClientXRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  React.useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  React.useEffect(() => {
    const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(storedWidth) && storedWidth >= SIDEBAR_MIN_WIDTH && storedWidth <= SIDEBAR_MAX_WIDTH) {
      const nextWidth = clampSidebarWidth(storedWidth);
      resizeCurrentWidthRef.current = nextWidth;
      setSidebarWidth(nextWidth);
    }
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
        resizeCurrentWidthRef.current = SIDEBAR_DEFAULT_WIDTH;
        setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
        setIsResizingSidebar(false);
        setIsOpen(false);
        return;
      }

      setIsResizingSidebar(false);
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(resizeCurrentWidthRef.current));
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

  const isNewChatActive = false;
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

  React.useEffect(() => {
    selectedChatIdsRef.current = selectedChatIds;
  }, [selectedChatIds]);

  React.useEffect(() => {
    dragSelectStateRef.current = dragSelectState;
  }, [dragSelectState]);

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

    const validIds = new Set(chats.map(chat => chat.id));
    const current = selectedChatIdsRef.current;
    const next = new Set([...current].filter(id => validIds.has(id)));
    if (next.size !== current.size) commitSelectedChatIds(next);
  }, [chats, commitSelectedChatIds, isSelectMode, selectedChatIds.size]);

  const chatIds = React.useMemo(() => chats.map(chat => chat.id), [chats]);
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
    if (chats.length === 0) return;
    setMenuState(null);
    setShowDeleteConfirm(false);
    setIsSelectMode(true);
    commitSelectedChatIds(new Set());
  }, [chats.length, commitSelectedChatIds]);

  const handleSelectAllToggle = React.useCallback(() => {
    if (chatIds.length === 0) return;
    commitSelectedChatIds(allChatsSelected ? new Set() : new Set(chatIds));
  }, [allChatsSelected, chatIds, commitSelectedChatIds]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showDeleteConfirm || isSelectMode || menuState) {
          event.preventDefault();
          setMenuState(null);
          if (showDeleteConfirm) setShowDeleteConfirm(false);
          else if (isSelectMode) exitSelectMode();
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && isSelectMode) {
        event.preventDefault();
        handleSelectAllToggle();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [exitSelectMode, handleSelectAllToggle, isSelectMode, menuState, showDeleteConfirm]);

  const handleBulkDelete = () => {
    if (isDeleting) return;
    const idsToDelete = [...selectedChatIds].filter(id => chats.some(chat => chat.id === id));
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

  const handleShare = (id: string) => {
    const chatToShare = chats.find(c => c.id === id);
    if (chatToShare) {
      navigator.clipboard.writeText(`Shared Session: ${ chatToShare.title }`);
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

  const sidebarStyle = React.useMemo(() => ({
    ...lightweightSidebarVars,
    '--eterx-shell-sidebar-width': `${ sidebarWidth }px`,
  } as React.CSSProperties), [sidebarWidth]);

  if (!isOpen) return null;

  return (
    <>
      <style suppressHydrationWarning dangerouslySetInnerHTML={{ __html: lightweightSidebarCss }} />
      <motion.div
        animate={{
          opacity: 1
        }}
        transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
        style={sidebarStyle}
        className="eterx-sidebar-shell relative bg-[var(--sidebar-bg)] shadow-none flex flex-col flex-shrink-0 z-[100] h-full overflow-hidden [-webkit-app-region:no-drag]"
      >
        <div className="eterx-sidebar-sheen pointer-events-none absolute inset-0 bg-transparent overflow-hidden">
          <div className="ambient-glow-layer ambient-glow-idle absolute inset-0" />
          <div className={`ambient-glow-layer ambient-glow-thinking absolute inset-0 transition-opacity duration-[3000ms] ease-in-out ${isThinking ? 'opacity-100' : 'opacity-0'}`} />
        </div>

        <div className="relative z-10 flex flex-col h-full w-full overflow-hidden">
          {/* Header containing Branding + Toggle */}
          <div className="eterx-sidebar-topbar h-[var(--eterx-shell-topbar-height)] px-3 tracking-tight flex items-center justify-start [-webkit-app-region:drag]">
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
                style={glassClickStyle('sidebar-toggle')}
                className={`eterx-sidebar-click-surface eterx-sidebar-toggle ${ glassClickClass('sidebar-toggle') } h-8 w-8 rounded-[8px] bg-transparent transition-colors duration-150 ease-out text-[var(--sidebar-muted-text)] flex items-center justify-center cursor-pointer border border-transparent hover:bg-[var(--sidebar-toggle-hover-bg)] hover:border-transparent hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)] [-webkit-app-region:no-drag]`}
              >
                <SidebarToggleIcon isOpen={isOpen} isHovered={toggleHovered} sizeClass="w-[18px] h-[18px]" />
              </button>
            </Tooltip>
          </div>

          {/* Navigation Actions */}
          <div className={`px-3 pb-1.5 ${ isOpen ? 'pt-1.5' : 'pt-0' }`}>
            {isOpen ? (
              // Expanded "New Chat" Button
              <Tooltip text="Start a fresh conversation" side="right">
                <button
                  onMouseDown={(e) => triggerGlassClick(e, 'new-chat-expanded')}
                  onClick={() => { createNewChat(); setActiveView('chat'); }}
                  style={glassClickStyle('new-chat-expanded')}
                  className={`eterx-sidebar-click-surface eterx-sidebar-nav-item eterx-sidebar-new-chat ${ glassClickClass('new-chat-expanded') } ${ isNewChatActive ? 'eterx-sidebar-nav-active' : '' } w-full h-[38px] flex items-center justify-between px-3 text-[13.5px] font-medium transition-colors duration-150 ease-out group border relative overflow-hidden ${ isNewChatActive
                      ? 'text-[var(--sidebar-active-text)] bg-[var(--sidebar-active-bg)] border-transparent rounded-[13px]'
                      : 'text-[var(--sidebar-text)] bg-transparent border-transparent rounded-[13px]'
                    }`}
                >
                  <div className="flex items-center gap-3 relative z-10">
                    <PremiumEdit className={`w-[17px] h-[17px] transition-colors duration-150 ease-out ${ isNewChatActive ? 'text-[var(--sidebar-active-text)]' : 'text-[var(--sidebar-icon)]' }`} strokeWidth={2.15} />
                    New chat
                  </div>
                </button>
              </Tooltip>
            ) : (
              // Collapsed Circular "New Chat" Button
              <Tooltip text="New chat" side="right">
                <button
                  onMouseDown={(e) => triggerGlassClick(e, 'new-chat-collapsed')}
                  onClick={() => { createNewChat(); setActiveView('chat'); }}
                  style={glassClickStyle('new-chat-collapsed')}
                  className={`eterx-sidebar-click-surface eterx-sidebar-nav-item eterx-sidebar-new-chat ${ glassClickClass('new-chat-collapsed') } ${ isNewChatActive ? 'eterx-sidebar-nav-active' : '' } w-[38px] h-[38px] flex items-center justify-center transition-colors duration-150 ease-out group relative mx-auto border ${ isNewChatActive
                      ? 'text-[var(--sidebar-active-text)] bg-[var(--sidebar-active-bg)] border-transparent rounded-full'
                      : 'text-[var(--sidebar-text)] bg-transparent border-transparent rounded-full'
                    }`}
                >
                  <PremiumEdit className={`w-[17px] h-[17px] transition-colors duration-150 relative z-10 ${ isNewChatActive ? 'text-[var(--sidebar-active-text)]' : 'text-[var(--sidebar-icon)]' }`} strokeWidth={2.15} />
                </button>
              </Tooltip>
            )}

            <div className={isOpen ? "h-1" : "h-1.5"}></div>

            {/* Menu Items */}
            <div className={isOpen ? "space-y-0.5 mt-0" : "space-y-1.5 mt-0"}>
              {[
                { id: 'tasks', label: 'Tasks', icon: PremiumCheckSquare, tooltip: 'Manage tasks', onClick: () => setActiveView('projects'), active: activeView === 'projects' },
                { id: 'agents', label: 'Agents', icon: PremiumAgent, tooltip: 'Manage agents', onClick: () => setActiveView('agents'), active: activeView === 'agents' },
                { id: 'channels', label: 'Channels', icon: PremiumChannels, tooltip: 'Deploy agents to channels', onClick: () => setActiveView('channels'), active: activeView === 'channels' },
              ].map(item => {
                const Icon = item.icon;
                const isActive = item.active;

                if (isOpen) {
                  return (
                    <Tooltip key={item.id} text={item.tooltip} side="right">
                      <button
                        onMouseDown={(e) => triggerGlassClick(e, `nav-${ item.id }`)}
                        onClick={item.onClick}
                        style={glassClickStyle(`nav-${ item.id }`)}
                        className={`eterx-sidebar-click-surface eterx-sidebar-nav-item ${ glassClickClass(`nav-${ item.id }`) } ${ isActive ? 'eterx-sidebar-nav-active' : '' } w-full h-[38px] flex items-center gap-3 px-3 text-[13.5px] font-medium rounded-[12px] transition-colors duration-150 ease-out group border relative overflow-hidden ${ isActive
                            ? 'text-[var(--sidebar-active-text)] border-transparent bg-[var(--sidebar-active-bg)]'
                            : 'text-[var(--sidebar-text)] border-transparent'
                          }`}
                      >
                        <Icon
                          className={`w-[18px] h-[18px] transition-colors duration-150 ease-out relative z-10 ${ isActive ? 'text-[var(--sidebar-active-text)]' : 'text-[var(--sidebar-icon)]'
                            }`}
                          strokeWidth={2.15}
                        />
                        <span className="relative z-10 whitespace-nowrap">{item.label}</span>
                      </button>
                    </Tooltip>
                  );
                } else {
                  return (
                    <Tooltip key={item.id} text={item.tooltip} side="right">
                      <button
                        onMouseDown={(e) => triggerGlassClick(e, `nav-${ item.id }`)}
                        onClick={item.onClick}
                        style={glassClickStyle(`nav-${ item.id }`)}
                        className={`eterx-sidebar-click-surface eterx-sidebar-nav-item ${ glassClickClass(`nav-${ item.id }`) } ${ isActive ? 'eterx-sidebar-nav-active' : '' } w-[38px] h-[38px] flex items-center justify-center rounded-full transition-colors duration-150 ease-out group border relative mx-auto ${ isActive
                            ? 'text-[var(--sidebar-active-text)] border-transparent bg-[var(--sidebar-active-bg)]'
                            : 'text-[var(--sidebar-text)] border-transparent'
                          }`}
                      >
                        <Icon
                          className={`w-[18px] h-[18px] transition-colors duration-150 ease-out relative z-10 ${ isActive ? 'text-[var(--sidebar-active-text)]' : 'text-[var(--sidebar-icon)]'
                            }`}
                          strokeWidth={2.15}
                        />
                      </button>
                    </Tooltip>
                  );
                }
              })}
            </div>
          </div>

          {/* Expanded Recents List */}
          {isOpen ? (
            <div className="eterx-sidebar-recents flex-1 mt-2 ml-2 mr-2 mb-1 bg-transparent rounded-[14px] border border-transparent flex flex-col py-2.5 overflow-hidden relative">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[var(--sidebar-surface-border)]" />
              <div className="flex items-center justify-between px-3.5 mb-1.5 min-h-[26px] relative z-30">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="eterx-sidebar-section-title text-[12px] font-medium text-[var(--sidebar-muted-text)] tracking-normal shrink-0 transition-colors duration-150">
                    {isSelectMode ? `${ selectedCount } selected` : 'Recents'}
                  </span>
                </div>
                <div className="flex items-center gap-1">
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
                            onClick={(e) => { e.stopPropagation(); handleSelectAllToggle(); }}
                            disabled={chats.length === 0}
                            className={`h-7 w-7 inline-flex items-center justify-center rounded-[8px] hover:bg-[var(--sidebar-hover-bg)] disabled:text-[var(--sidebar-muted-text)] disabled:hover:bg-transparent transition-colors ${ allChatsSelected ? 'text-[var(--sidebar-active-text)] bg-[var(--sidebar-active-bg)]' : 'text-[var(--sidebar-muted-text)]' }`}
                          >
                            <Check className="w-[13px] h-[13px]" strokeWidth={2.6} />
                          </button>
                        </Tooltip>
                        <Tooltip text="Delete selected" side="right">
                          <button
                            onClick={(e) => { e.stopPropagation(); selectedCount > 0 && setShowDeleteConfirm(true); }}
                            className={`h-7 w-7 inline-flex items-center justify-center rounded-[8px] transition-colors ${ selectedCount > 0 ? 'text-[#EF4444] hover:bg-red-500/10' : 'text-[#555350] cursor-not-allowed' }`}
                          >
                            <PremiumTrash className="w-[14px] h-[14px]" />
                          </button>
                        </Tooltip>
                        <Tooltip text="Cancel selection" side="right">
                          <button
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
                            disabled={chats.length === 0}
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
                className="eterx-sidebar-recents-scroll flex-1 overflow-y-auto eterx-scrollbar pl-2 pr-0 mr-0 space-y-0.5 relative z-10"
                style={{ scrollBehavior: isDragSelecting ? 'auto' : undefined, overscrollBehavior: 'contain' }}
              >
                {chats.length === 0 ? (
                  <div className="eterx-sidebar-empty px-3 py-2 text-[12.5px] text-[var(--sidebar-muted-text)]">No recent chats</div>
                ) : (
                  chats.map((chat) => {
                    const isActive = activeChatId === chat.id && activeView === 'chat';
                    const isWorking = runningChats?.has(chat.id) ?? false;
                    const hasUnread = !isActive && !isWorking && (unreadChats?.has(chat.id) ?? false);
                    const isMenuOpen = menuState?.id === chat.id;
                    const isSelected = selectedChatIds.has(chat.id);
                    const timeLabel = formatChatUpdatedAt(chat.updatedAt, now);

                    return (
                      <div
                        key={chat.id}
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
                          if (isWorking || isSelectMode) return;
                          e.preventDefault();
                          e.stopPropagation();
                          const dropUp = e.clientY + 220 > window.innerHeight;
                          setMenuState({ id: chat.id, x: e.clientX, y: dropUp ? e.clientY - 200 : e.clientY, dropUp });
                        }}
                        data-chat-id={chat.id}
                        aria-current={isActive && !isSelectMode ? 'page' : undefined}
                        onClick={() => {
                          if (!isSelectMode) {
                            loadChat(chat.id); setActiveView('chat');
                          }
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

                        <div className={`eterx-sidebar-chat-content ${ !isWorking && !isSelectMode && isMenuOpen ? 'eterx-sidebar-chat-content-menu-visible' : '' } ${ isWorking && !isSelectMode ? 'eterx-sidebar-chat-content-working' : '' } flex min-w-0 items-center overflow-hidden flex-1 relative z-10 w-full pl-0`}>
                          {isWorking ? (
                            <span className="eterx-sidebar-chat-title truncate relative z-10 font-medium leading-normal">
                              {chat.title}
                            </span>
                          ) : editingChatId === chat.id ? (
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
                            <div className="eterx-sidebar-chat-title-wrap flex items-center truncate relative z-10 w-full min-w-0">
                              {chat.isFavorite && <PremiumStar className="eterx-sidebar-favorite-icon w-3.5 h-3.5 text-yellow-500/90 mr-1.5 shrink-0" />}
                              <span className="eterx-sidebar-chat-title truncate text-current leading-normal">{chat.title}</span>
                            </div>
                          )}
                        </div>

                        {!isSelectMode && (
                          <div className={`eterx-sidebar-chat-meta ml-2 flex shrink-0 items-center justify-end relative z-10 ${ isMenuOpen ? 'eterx-sidebar-chat-meta-hidden' : '' }`}>
                            {isWorking ? (
                              <span className="eterx-sidebar-running-indicator" aria-label="Agent working" />
                            ) : hasUnread ? (
                              <span className="eterx-sidebar-unread-dot" aria-label="Unread agent update" />
                            ) : timeLabel ? (
                              <span className="eterx-sidebar-chat-time tabular-nums" title={new Date(chat.updatedAt).toLocaleString()}>{timeLabel}</span>
                            ) : null}
                          </div>
                        )}

                        {!isSelectMode && (
                          <div className="absolute right-1.5 top-1/2 z-30 flex h-7 w-7 -translate-y-1/2 items-center justify-center">
                            <button
                              type="button"
                              aria-label="Chat options"
                              onMouseDown={(e) => triggerGlassClick(e, `chat-menu-${ chat.id }`)}
                              style={glassClickStyle(`chat-menu-${ chat.id }`)}
                              className={`eterx-sidebar-click-surface eterx-sidebar-chat-menu-button ${ glassClickClass(`chat-menu-${ chat.id }`) } flex h-7 w-7 items-center justify-center rounded-[8px] bg-transparent transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)] ${ isMenuOpen ? 'opacity-100 text-[var(--sidebar-active-text)] border border-transparent' : (isWorking || isSelectMode ? 'opacity-0 pointer-events-none hidden' : 'opacity-0 group-hover:opacity-100 text-[var(--sidebar-muted-text)] hover:bg-transparent hover:text-[var(--sidebar-hover-text)] border border-transparent') } relative z-40`}
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
                    );
                  })
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
                  onClick={onSettingsClick}
                  aria-label="Open settings"
                  onMouseDown={(e) => triggerGlassClick(e, 'profile-settings-collapsed')}
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
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            aria-valuenow={sidebarWidth}
            onPointerDown={handleSidebarResizePointerDown}
            className={`eterx-sidebar-resize-handle ${ isResizingSidebar ? 'eterx-sidebar-resize-handle-active' : '' }`}
          />
        )}
      </motion.div>

      {menuState && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[999999]"
          onClick={(e) => { e.stopPropagation(); setMenuState(null); }}
          onContextMenu={(e) => { e.stopPropagation(); setMenuState(null); }}
        >
          <AnimatePresence>
            <motion.div
              initial={{ opacity: 0, y: menuState.dropUp ? 5 : -5, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: menuState.x - 16,
                ...(menuState.dropUp ? { bottom: window.innerHeight - menuState.y - 4 } : { top: menuState.y - 32 }),
              }}
              className="eterx-sidebar-menu w-52 bg-[var(--sidebar-menu-bg)] border border-transparent rounded-[12px] p-1.5 flex flex-col gap-0.5"
            >
              <button
                onClick={(e) => { e.stopPropagation(); handleShare(menuState.id); }}
                className="eterx-sidebar-menu-item w-full px-3 py-2 text-[13px] font-medium text-[var(--sidebar-muted-text)] hover:text-[var(--sidebar-hover-text)] hover:bg-[var(--sidebar-hover-bg)] rounded-[10px] flex items-center gap-3 transition-colors duration-150 ease-out text-left group/btn"
              >
                <PremiumShare className="w-4 h-4 text-[var(--sidebar-icon)] group-hover/btn:text-[var(--sidebar-hover-text)] transition-colors duration-150" />
                {shareCopiedId === menuState.id ? <span className="text-[#34D399]">Link copied!</span> : "Share"}
              </button>
              <button
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
              <button type="button" disabled aria-disabled="true" className="eterx-sidebar-menu-item w-full px-3 py-2 text-[13px] font-medium text-[var(--sidebar-muted-text)] rounded-[10px] flex items-center gap-3 transition-colors duration-150 ease-out text-left justify-between group/btn cursor-not-allowed opacity-60 disabled:hover:bg-transparent disabled:hover:text-[var(--sidebar-muted-text)]" title="Coming soon">
                <div className="flex items-center gap-3">
                  <PremiumFolder className="w-4 h-4 text-[var(--sidebar-icon)] group-hover/btn:text-[var(--sidebar-hover-text)] transition-colors duration-150" /> Move to Project
                </div>
                <ChevronRight className="eterx-sidebar-menu-chevron w-4 h-4 text-[var(--sidebar-muted-text)] transition-colors duration-150" />
              </button>

              <div className="h-[1px] w-full bg-[var(--sidebar-menu-border)] my-1 rounded-full" />

              <button
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
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-[#141414] border border-white/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.6)] rounded-[24px] p-6 max-w-[360px] w-full mx-4 flex flex-col gap-6 relative overflow-hidden"
              >
                <div className="flex flex-col gap-2 relative z-10">
                  <h3 className="text-[#E8E6E3] text-[18px] font-semibold">Delete {selectedChatIds.size} chats?</h3>
                  <p className="text-[#A3A19E] text-[14px] leading-relaxed">
                    Are you sure you want to delete the selected chats? This action cannot be undone and the history will be lost forever.
                  </p>
                </div>
                <div className="flex items-center justify-end gap-3 w-full relative z-10">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    disabled={isDeleting}
                    className={`px-4 py-2 rounded-[12px] text-[#A3A19E] hover:text-[#E8E6E3] hover:bg-white/[0.05] transition-colors text-[14px] font-medium ${ isDeleting ? 'opacity-50 cursor-not-allowed pointer-events-none' : '' }`}
                  >
                    Cancel
                  </button>
                  <button
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
