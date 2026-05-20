import React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, ChevronRight, Check } from 'lucide-react';
import { PremiumShare, PremiumEdit, PremiumStar, PremiumFolder, PremiumTrash, PremiumSearch, PremiumDashboard, PremiumBot, PremiumLayers, PremiumFolderOpen, PremiumPanelLeft, PremiumDownload, PremiumMoreHorizontal, PremiumCheckSquare, PremiumSettings } from '../ui/premium-icons';
import { Tooltip } from '../ui/tooltip';

const SidebarToggleIcon = ({ isOpen, isHovered }: { isOpen: boolean, isHovered: boolean }) => {
  if (isOpen) {
    if (isHovered) {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-[18px] h-[18px] text-[#E8E6E3] transition-all duration-200">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <path d="M9 3v18" />
          <path d="M16 15l-3-3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    } else {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-[18px] h-[18px] text-[#8C8A88] transition-all duration-200">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <path d="M9 3v18" />
        </svg>
      );
    }
  } else {
    if (isHovered) {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-[18px] h-[18px] text-[#E8E6E3] transition-all duration-200">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <path d="M9 3v18" />
          <path d="M13 9l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    } else {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-[18px] h-[18px] text-[#8C8A88] transition-all duration-200">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <path d="M9 3v18" />
        </svg>
      );
    }
  }
};


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
  activeView: 'chat' | 'code' | 'agents';
  setActiveView: (view: 'chat' | 'code' | 'agents') => void;
  runningChats?: Set<string>;
  onSettingsClick?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen, setIsOpen, createNewChat, chats, activeChatId, loadChat, deleteChat, deleteChats, renameChat, toggleFavorite, onSearchClick, activeView, setActiveView, runningChats, onSettingsClick
}) => {
  const [menuState, setMenuState] = React.useState<{ id: string, x: number, y: number, dropUp: boolean } | null>(null);
  const [toggleHovered, setToggleHovered] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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
          const edgeDwell = Math.max(0, timestamp - dragEdgeStateRef.current.enteredAt);
          const dwellFactor = Math.min(1, edgeDwell / 180);
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
    setIsDragSelecting(false);
    setShowDeleteConfirm(false);
    setIsSelectMode(false);
    commitSelectedChatIds(new Set());
  }, [commitSelectedChatIds]);

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

  return (
    <>
      <motion.div
        animate={{ 
          width: isOpen ? 280 : (isMobile ? 0 : 68),
          opacity: (isOpen || !isMobile) ? 1 : 0
        }}
        transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
        className="relative border-r border-white/[0.055] bg-[linear-gradient(180deg,#0C0C0C_0%,#070707_46%,#030303_100%)] shadow-[inset_-1px_0_0_rgba(255,255,255,0.025),10px_0_36px_rgba(0,0,0,0.28)] flex flex-col flex-shrink-0 z-[60] h-full rounded-tr-[32px] rounded-br-[32px] overflow-hidden"
      >
        <div className="pointer-events-none absolute inset-0 rounded-tr-[32px] rounded-br-[32px] bg-[linear-gradient(90deg,rgba(255,255,255,0.026),transparent_18%,transparent_100%)]" />
        
        <div className="relative z-10 flex flex-col h-full w-full overflow-hidden">
          {/* Header containing Branding + Toggle */}
          <div className={`px-3 py-3.5 flex items-center justify-between cursor-pointer tracking-tight ${!isOpen ? 'justify-center' : ''}`}>
            {isOpen ? (
              <motion.span
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
                className="font-serif text-[26px] text-[#E8E6E3] font-medium leading-none hover:opacity-85 transition-opacity whitespace-nowrap"
              >
                EterX
              </motion.span>
            ) : null}
            <Tooltip text={isOpen ? "Close sidebar" : "Open sidebar"} side="right">
              <div
                onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}
                onMouseEnter={() => setToggleHovered(true)}
                onMouseLeave={() => setToggleHovered(false)}
                className="h-8 w-8 rounded-[10px] hover:bg-white/[0.075] active:bg-white/[0.12] active:scale-95 transition-all duration-200 ease-out text-[#8C8A88] hover:text-[#E8E6E3] flex items-center justify-center cursor-pointer border border-transparent hover:border-white/[0.06]"
              >
                <SidebarToggleIcon isOpen={isOpen} isHovered={toggleHovered} />
              </div>
            </Tooltip>
          </div>

          {/* Navigation Actions */}
          <div className="px-3 pb-2">
            {isOpen ? (
              // Expanded "New Chat" Button
              <Tooltip text="Start a fresh conversation" side="right">
                <button
                  onClick={() => { createNewChat(); setActiveView('chat'); }}
                  className="w-full h-[48px] flex items-center justify-between px-3 text-[14px] font-semibold text-[#E8E6E3] bg-white/[0.035] border border-white/[0.07] rounded-[16px] transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:bg-white/[0.075] hover:border-white/[0.14] active:scale-[0.985] shadow-[0_8px_22px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.045)] hover:shadow-[0_10px_26px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.08)] group relative overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-t from-white/0 to-white/[0.055] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                  <div className="flex items-center gap-3 relative z-10">
                    <div className="w-[30px] h-[30px] flex items-center justify-center bg-white/[0.045] border border-white/[0.085] rounded-[11px] group-hover:bg-white/[0.12] group-hover:border-white/[0.16] transition-all duration-300 shadow-sm shrink-0">
                      <PremiumEdit className="w-[16px] h-[16px] text-[#E8E6E3]" strokeWidth={2.2} />
                    </div>
                    New chat
                  </div>
                </button>
              </Tooltip>
            ) : (
              // Collapsed Circular "New Chat" Button
              <Tooltip text="New chat" side="right">
                <button
                  onClick={() => { createNewChat(); setActiveView('chat'); }}
                  className="w-10 h-10 flex items-center justify-center text-[#E8E6E3] bg-white/[0.035] border border-white/[0.07] rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:bg-white/[0.075] hover:border-white/[0.14] active:scale-[0.95] shadow-[0_8px_22px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.045)] hover:shadow-[0_10px_26px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.08)] group relative mx-auto"
                >
                  <div className="absolute inset-0 bg-gradient-to-t from-white/0 to-white/[0.055] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none rounded-full" />
                  <PremiumEdit className="w-[18px] h-[18px] text-[#E8E6E3] group-hover:scale-110 transition-all duration-300 relative z-10" strokeWidth={2.2} />
                </button>
              </Tooltip>
            )}

            <div className="h-2"></div>

            {/* Menu Items */}
            <div className="space-y-[3px] mt-2">
              {[
                { id: 'search', label: 'Search', icon: PremiumSearch, tooltip: 'Search conversations', onClick: onSearchClick },
                { id: 'workspace', label: 'Workspace', icon: PremiumDashboard, tooltip: 'Manage workspace' },
                { id: 'agents', label: 'Agents', icon: PremiumBot, tooltip: 'Manage agents', onClick: () => setActiveView('agents'), active: activeView === 'agents' },
                { id: 'channels', label: 'Channels', icon: PremiumLayers, tooltip: 'View channels' },
                { id: 'file-manager', label: 'File Manager', icon: PremiumFolderOpen, tooltip: 'File Manager' },
              ].map(item => {
                const Icon = item.icon;
                const isActive = item.active;
                
                if (isOpen) {
                  return (
                    <Tooltip key={item.id} text={item.tooltip} side="right">
                      <button
                        onClick={item.onClick}
                        className={`w-full h-[40px] flex items-center gap-3 px-3 text-[14px] font-medium rounded-[13px] transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] active:scale-[0.985] group border relative overflow-hidden ${
                          isActive
                            ? 'bg-white/[0.085] text-[#E8E6E3] border-white/[0.095] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_18px_rgba(0,0,0,0.18)]'
                            : 'text-[#A7A39D] hover:text-[#E8E6E3] hover:bg-white/[0.055] active:bg-white/[0.085] border-transparent hover:border-white/[0.045]'
                        }`}
                      >
                        {isActive && <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/5 to-white/0 pointer-events-none" />}
                        <Icon
                          className={`w-[18px] h-[18px] transition-all duration-200 ease-out relative z-10 ${
                            isActive ? 'text-[#E8E6E3] scale-[1.05]' : 'text-[#8C8A88] group-hover:text-[#E8E6E3] group-hover:scale-[1.06]'
                          }`}
                          strokeWidth={2.2}
                        />
                        <span className="relative z-10 whitespace-nowrap">{item.label}</span>
                      </button>
                    </Tooltip>
                  );
                } else {
                  return (
                    <Tooltip key={item.id} text={item.tooltip} side="right">
                      <button
                        onClick={item.onClick}
                        className={`w-10 h-10 flex items-center justify-center rounded-[13px] transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] active:scale-[0.95] group border relative mx-auto ${
                          isActive
                            ? 'bg-white/[0.085] text-[#E8E6E3] border-white/[0.095] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_18px_rgba(0,0,0,0.18)]'
                            : 'text-[#A7A39D] hover:text-[#E8E6E3] hover:bg-white/[0.055] active:bg-white/[0.085] border-transparent hover:border-white/[0.045]'
                        }`}
                      >
                        {isActive && <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/5 to-white/0 pointer-events-none" />}
                        <Icon
                          className={`w-[18px] h-[18px] transition-all duration-200 ease-out relative z-10 ${
                            isActive ? 'text-[#E8E6E3] scale-[1.05]' : 'text-[#8C8A88] group-hover:text-[#E8E6E3] group-hover:scale-[1.1]'
                          }`}
                          strokeWidth={2.2}
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
            <div className="flex-1 mt-1 mx-[6px] mb-[6px] bg-[linear-gradient(180deg,rgba(24,24,24,0.76),rgba(7,7,7,0.96))] backdrop-blur-2xl rounded-[22px] border border-white/[0.045] shadow-[0_12px_34px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.026)] flex flex-col py-3 overflow-hidden relative">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[0.055]" />
              <div className="flex items-center justify-between px-4 mb-2 min-h-[26px] relative z-30">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-[#B8B4AE] tracking-normal shrink-0 transition-colors duration-300">
                    {isSelectMode ? `${selectedCount} selected` : 'Recents'}
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
                            className={`h-7 w-7 inline-flex items-center justify-center rounded-[9px] hover:bg-white/[0.07] disabled:text-[#4A4743] disabled:hover:bg-transparent transition-colors ${allChatsSelected ? 'text-[#E8E6E3] bg-white/[0.08]' : 'text-[#A3A19E]'}`}
                          >
                            <Check className="w-[13px] h-[13px]" strokeWidth={2.6} />
                          </button>
                        </Tooltip>
                        <Tooltip text="Delete selected" side="right">
                          <button
                            onClick={(e) => { e.stopPropagation(); selectedCount > 0 && setShowDeleteConfirm(true); }}
                            className={`h-7 w-7 inline-flex items-center justify-center rounded-[9px] transition-colors ${selectedCount > 0 ? 'text-[#EF4444] hover:bg-red-500/10' : 'text-[#555350] cursor-not-allowed'}`}
                          >
                            <PremiumTrash className="w-[14px] h-[14px]" />
                          </button>
                        </Tooltip>
                        <Tooltip text="Cancel selection" side="right">
                          <button
                            onClick={(e) => { e.stopPropagation(); exitSelectMode(); }}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-[9px] text-[#A3A19E] hover:bg-white/10 hover:text-white transition-colors"
                          >
                            <X className="w-[14px] h-[14px]" strokeWidth={2.5} />
                          </button>
                        </Tooltip>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="select-trigger"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                      >
                        <Tooltip text="Select multiple chats" side="right">
                          <button
                            onClick={(e) => { e.stopPropagation(); setIsSelectMode(true); }}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-[9px] text-[#555350] hover:text-[#A3A19E] hover:bg-white/5 transition-colors"
                          >
                            <PremiumCheckSquare className="w-[14px] h-[14px]" />
                          </button>
                        </Tooltip>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              <div
                ref={scrollContainerRef}
                className="flex-1 overflow-y-auto eterx-modern-scrollbar px-2.5 space-y-[3px] relative z-10"
                style={{ scrollBehavior: isDragSelecting ? 'auto' : undefined, overscrollBehavior: 'contain' }}
              >
                {chats.length === 0 ? (
                  <div className="px-3 py-2 text-[13px] text-[#555350] italic">No active projects</div>
                ) : (
                  chats.map((chat, index) => {
                    const isActive = activeChatId === chat.id && activeView === 'chat';
                    const isWorking = runningChats?.has(chat.id) ?? false;
                    const isMenuOpen = menuState?.id === chat.id;

                    return (
                      <div
                        key={chat.id}
                        onPointerDown={(e) => {
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
                        data-chat-id={chat.id}
                        aria-current={isActive && !isSelectMode ? 'page' : undefined}
                        onClick={() => { 
                          if (!isSelectMode) {
                            loadChat(chat.id); setActiveView('chat'); 
                          }
                        }}
                        className={`w-full h-[44px] text-left px-3.5 transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] flex items-center justify-between group cursor-pointer active:scale-[0.988] text-[13.5px] leading-none rounded-[14px] border relative z-0 ${ isActive && !isSelectMode ? 'bg-[#2A2A2A]/95 text-[#F1EFEB] border-white/[0.085] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_18px_rgba(0,0,0,0.22)]' : isWorking && !isSelectMode ? 'bg-white/[0.04] text-[#E8E6E3] border-white/[0.04]' : 'text-[#A7A39D] border-transparent hover:bg-white/[0.052] active:bg-white/[0.075] hover:text-[#E8E6E3]' } ${isSelectMode && selectedChatIds.has(chat.id) ? 'bg-white/[0.065] text-[#E8E6E3] border-white/[0.075]' : ''} ${isSelectMode ? 'select-none touch-none' : ''}`}
                      >
                        <div className="flex items-center overflow-hidden flex-1 relative z-10 w-full">
                          <div className={`transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] overflow-hidden flex items-center justify-center shrink-0 ${isSelectMode ? 'w-[15px] h-[15px] mr-2.5 rounded-[5px] border opacity-100' : 'w-0 h-[15px] mr-0 border-0 opacity-0'} ${selectedChatIds.has(chat.id) ? 'bg-[#E8E6E3] border-[#E8E6E3] text-[#0A0A0A]' : 'border-white/20 bg-transparent text-transparent group-hover:border-white/40'}`}>
                            <Check className="w-[10px] h-[10px] shrink-0" strokeWidth={3} />
                          </div>
                          {isWorking ? (
                            <motion.span
                              animate={{ backgroundPosition: ["200% 50%", "-200% 50%"] }}
                              transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                              style={{ backgroundSize: '300% auto' }}
                              className="truncate pr-2 relative z-10 bg-gradient-to-r from-[#555350] via-[#E8E6E3] to-[#555350] bg-clip-text text-transparent font-medium leading-none"
                            >
                              {chat.title}
                            </motion.span>
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
                              className="bg-transparent border-none outline-none text-[#E8E6E3] font-medium w-full text-[13.5px] leading-none relative z-10 p-0 m-0"
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <div className="flex items-center truncate pr-2 relative z-10 w-full min-w-0">
                              {chat.isFavorite && <PremiumStar className="w-3.5 h-3.5 text-yellow-500/90 mr-1.5 shrink-0 drop-shadow-[0_0_6px_rgba(234,179,8,0.4)]" />}
                              <span className="truncate text-current leading-none">{chat.title}</span>
                            </div>
                          )}
                        </div>

                        {isWorking && (
                          <div className={`absolute right-0 top-0 bottom-0 w-[4.5rem] pointer-events-none z-20 flex items-center justify-end pr-3 ${isActive ? 'bg-gradient-to-l from-[#242424] via-[#242424]/92 to-transparent rounded-r-[14px]' : 'bg-gradient-to-l from-[#141414] via-[#141414]/90 to-transparent rounded-r-[14px]'}`}>
                            <div className="w-[14px] h-[14px] rounded-full border-[2px] border-[#1e3a8a] border-r-[#3b82f6] animate-[spin_0.8s_linear_infinite]" />
                          </div>
                        )}

                        <div className="relative ml-1 flex h-7 w-7 shrink-0 items-center justify-center">
                          <div
                            className={`flex h-7 w-7 items-center justify-center rounded-[10px] transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${ isMenuOpen ? 'opacity-100 bg-white/[0.11] text-[#E8E6E3] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] border border-white/[0.085]' : (isWorking || isSelectMode ? 'opacity-0 pointer-events-none hidden' : 'opacity-0 group-hover:opacity-100 text-[#8C8A88] hover:bg-white/[0.075] hover:text-[#E8E6E3] border border-transparent hover:border-white/[0.055] active:scale-95') } relative z-40`}
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
                            <PremiumMoreHorizontal className={`w-4 h-4 transition-transform duration-300 ${isMenuOpen ? 'scale-110 drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]' : ''}`} />
                          </div>
                        </div>
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
            <div className="relative z-10 p-3 pt-2 border-t border-white/[0.055] bg-[linear-gradient(180deg,rgba(9,9,9,0.9),rgba(3,3,3,1))] rounded-br-[32px]">
              <Tooltip text="User settings & plan" side="right">
                <div onClick={onSettingsClick} className="flex items-center justify-between cursor-pointer group px-2.5 py-2.5 hover:bg-white/[0.055] rounded-[16px] w-full transition-all duration-200 border border-transparent hover:border-white/[0.055] active:scale-[0.988]">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#343230] to-[#1A1918] flex items-center justify-center text-[#E8E6E3] font-semibold text-xs shrink-0 border border-white/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_12px_rgba(0,0,0,0.22)]">
                      H
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[13px] font-medium text-[#E8E6E3] group-hover:text-white">harshil</span>
                      <span className="text-[11px] text-[#A3A19E]"></span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <PremiumDownload className="w-4 h-4 text-[#8C8A88] group-hover:text-[#E8E6E3] transition-all duration-200 group-hover:scale-[1.06]" strokeWidth={2.2} />
                    <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.58)]"></div>
                  </div>
                </div>
              </Tooltip>
            </div>
          ) : (
            <div className="relative z-10 p-3 pt-2 border-t border-white/[0.055] bg-[linear-gradient(180deg,rgba(9,9,9,0.9),rgba(3,3,3,1))] rounded-br-[32px] flex flex-col items-center gap-3">
              <Tooltip text="Settings" side="right">
                <button
                  onClick={onSettingsClick}
                  className="w-10 h-10 flex items-center justify-center rounded-[12px] hover:bg-white/[0.055] text-[#8C8A88] hover:text-[#E8E6E3] border border-transparent hover:border-white/[0.045] transition-all active:scale-95 group"
                >
                  <PremiumSettings className="w-5 h-5 group-hover:scale-[1.08] transition-transform" strokeWidth={2.2} />
                </button>
              </Tooltip>
              
              <Tooltip text="User plan" side="right">
                <div
                  onClick={onSettingsClick}
                  className="w-8 h-8 rounded-full bg-gradient-to-br from-[#343230] to-[#1A1918] flex items-center justify-center text-[#E8E6E3] font-semibold text-xs shrink-0 border border-white/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_12px_rgba(0,0,0,0.22)] cursor-pointer hover:border-white/20 hover:scale-[1.04] transition-all active:scale-[0.96]"
                >
                  H
                </div>
              </Tooltip>
            </div>
          )}
        </div>
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
              className="w-52 bg-[#191919]/92 backdrop-blur-3xl border border-white/[0.075] rounded-[18px] shadow-[0_22px_58px_rgba(0,0,0,0.56),inset_0_1px_0_rgba(255,255,255,0.08)] p-1.5 flex flex-col gap-0.5"
            >
              <button
                onClick={(e) => { e.stopPropagation(); handleShare(menuState.id); }}
                className="w-full px-3 py-2 text-[13.5px] font-medium text-[#A7A39D] hover:text-[#E8E6E3] hover:bg-white/[0.065] rounded-[12px] flex items-center gap-3 transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] text-left group/btn active:scale-[0.985]"
              >
                <PremiumShare className="w-4 h-4 text-[#8C8A88] group-hover/btn:text-[#E8E6E3] transition-transform duration-200 group-hover/btn:scale-[1.06]" />
                {shareCopiedId === menuState.id ? <span className="text-[#34D399]">Link copied!</span> : "Share"}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingChatId(menuState.id);
                  setEditTitle(chats.find(c => c.id === menuState.id)?.title || "");
                  setMenuState(null);
                }}
                className="w-full px-3 py-2 text-[13.5px] font-medium text-[#A7A39D] hover:text-[#E8E6E3] hover:bg-white/[0.065] rounded-[12px] flex items-center gap-3 transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] text-left group/btn active:scale-[0.985]"
              >
                <PremiumEdit className="w-4 h-4 text-[#8C8A88] group-hover/btn:text-[#E8E6E3] transition-transform duration-200 group-hover/btn:scale-[1.06]" /> Rename
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(menuState.id);
                  setMenuState(null);
                }}
                className="w-full px-3 py-2 text-[13.5px] font-medium text-[#A7A39D] hover:text-[#E8E6E3] hover:bg-white/[0.065] rounded-[12px] flex items-center gap-3 transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] text-left group/btn active:scale-[0.985]"
              >
                <PremiumStar className="w-4 h-4 text-[#8C8A88] group-hover/btn:text-[#E8E6E3] transition-transform duration-200 group-hover/btn:scale-[1.06]" />
                {chats.find(c => c.id === menuState.id)?.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              </button>
              <button className="w-full px-3 py-2 text-[13.5px] font-medium text-[#A7A39D] hover:text-[#E8E6E3] hover:bg-white/[0.065] rounded-[12px] flex items-center gap-3 transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] text-left justify-between group/btn cursor-not-allowed opacity-70 active:scale-[0.985]" title="Coming soon">
                <div className="flex items-center gap-3">
                  <PremiumFolder className="w-4 h-4 text-[#8C8A88] group-hover/btn:text-[#E8E6E3] transition-transform duration-200 group-hover/btn:scale-[1.06]" /> Move to Project
                </div>
                <ChevronRight className="w-4 h-4 text-[#555350] transition-transform duration-200 group-hover/btn:translate-x-0.5" />
              </button>

              <div className="h-[1px] w-full bg-white/10 my-1 rounded-full shadow-[0_1px_0_rgba(0,0,0,0.3)]" />

              <button
                className="w-full px-3 py-2 text-[13.5px] font-medium text-[#EF4444]/90 hover:text-[#FF5A5A] hover:bg-[#EF4444]/[0.14] rounded-[12px] flex items-center gap-3 transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] text-left group/btn active:scale-[0.985]"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChat(menuState.id);
                  setMenuState(null);
                }}
              >
                <PremiumTrash className="w-4 h-4 transition-transform duration-200 group-hover/btn:scale-[1.06]" /> Delete
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
              className="fixed inset-0 z-[1000] flex items-center justify-center transition-all duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] bg-black/60 backdrop-blur-sm" 
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
                    className={`px-4 py-2 rounded-[12px] text-[#A3A19E] hover:text-[#E8E6E3] hover:bg-white/[0.05] transition-colors text-[14px] font-medium ${isDeleting ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''}`}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleBulkDelete}
                    disabled={isDeleting}
                    className={`relative flex items-center justify-center gap-2 py-2 rounded-[12px] bg-[#EF4444] text-white transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] active:scale-95 text-[14px] font-medium overflow-hidden ${isDeleting ? 'w-[150px] cursor-not-allowed hover:bg-[#EF4444]' : 'w-[130px] hover:bg-[#DC2626]'}`}
                  >
                    <span className={`transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] whitespace-nowrap ${isDeleting ? '-translate-x-3' : 'translate-x-0'}`}>
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
};
