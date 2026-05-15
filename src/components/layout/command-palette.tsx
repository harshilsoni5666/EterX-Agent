import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Bot, Maximize2, Command } from 'lucide-react';

interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  traceLogs?: any[];
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  createNewChat: () => void;
  chats: ChatSession[];
  loadChat: (id: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, createNewChat, chats, loadChat }) => {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) return chats.slice(0, 6);
    const query = searchQuery.toLowerCase();

    const results: any[] = [];

    chats.forEach(chat => {
      if (chat.title.toLowerCase().includes(query)) {
        results.push({ ...chat, matchType: 'title' });
        return;
      }

      const matchingLog = chat.traceLogs?.find(log => 
        log.text && typeof log.text === 'string' && log.text.toLowerCase().includes(query)
      );

      if (matchingLog) {
        const text = matchingLog.text as string;
        const index = text.toLowerCase().indexOf(query);
        const start = Math.max(0, index - 30);
        const end = Math.min(text.length, index + 50);
        let snippet = text.substring(start, end).replace(/\n/g, ' ');
        if (start > 0) snippet = '...' + snippet;
        if (end < text.length) snippet = snippet + '...';

        results.push({ ...chat, matchType: 'content', snippet });
      }
    });

    return results.sort((a, b) => {
      if (a.matchType === 'title' && b.matchType === 'content') return -1;
      if (a.matchType === 'content' && b.matchType === 'title') return 1;
      return b.updatedAt - a.updatedAt;
    }).slice(0, 10);
  }, [chats, searchQuery]);

  const formatDate = (timestamp: number) => {
    try {
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(timestamp);
    } catch (e) {
      return "";
    }
  };

  useEffect(() => {
    if (isOpen) setSearchQuery("");
  }, [isOpen]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 pointer-events-none">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-[#050505]/80 backdrop-blur-[10px] pointer-events-auto"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 8, filter: 'blur(12px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.98, y: 8, filter: 'blur(12px)' }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
            className="w-full max-w-[540px] bg-[#0A0A0A]/90 backdrop-blur-[32px] border border-white/10 rounded-[24px] shadow-[0_32px_128px_-16px_rgba(0,0,0,1)] z-50 overflow-hidden flex flex-col pointer-events-auto ring-1 ring-white/5"
          >
            {/* Header Search */}
            <div className="flex items-center px-5 py-4 border-b border-white/5 relative group">
              <div className="bg-white/5 p-1.5 rounded-lg border border-white/10 mr-3 shrink-0 transition-colors group-focus-within:border-white/20">
                <Search className="w-4 h-4 text-[#8C8A88]" />
              </div>
              <input
                type="text"
                placeholder="Find anything..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-transparent text-[#E8E6E3] placeholder:text-[#555350] outline-none text-[15px] font-medium font-sans tracking-tight"
                autoFocus
              />
              <div className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-white/5 border border-white/10 shrink-0">
                <Command className="w-2.5 h-2.5 text-[#555350]" />
                <span className="text-[9px] text-[#555350] font-bold tracking-tighter">K</span>
              </div>
            </div>

            <div className="p-2 overflow-y-auto max-h-[420px] custom-scrollbar flex flex-col gap-4">
              {/* Actions Section */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between px-3 mb-1">
                  <span className="text-[10px] font-bold text-[#555350] uppercase tracking-[0.15em]">Quick Actions</span>
                </div>
                <button
                  onClick={() => { onClose(); createNewChat(); }}
                  className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-white/5 rounded-xl transition-all duration-150 active:scale-[0.985] group group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center group-hover:bg-white/10 group-hover:border-white/20 transition-all shadow-inner">
                      <Bot className="w-3.5 h-3.5 text-[#A3A19E] group-hover:text-white" />
                    </div>
                    <span className="text-[14px] font-medium text-[#A3A19E] group-hover:text-white transition-colors">Create New Private Chat</span>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[9px] text-[#555350] font-mono border border-white/5 px-1.5 py-0.5 rounded bg-white/[0.02]">ENTER</span>
                  </div>
                </button>
              </div>

              {/* Filtering Results Section */}
              <div className="flex flex-col gap-0.5 pb-2">
                <div className="px-3 mb-1">
                  <span className="text-[10px] font-bold text-[#555350] uppercase tracking-[0.15em]">
                    {searchQuery ? 'Results' : 'Recents'}
                  </span>
                </div>
                <div className="flex flex-col gap-[1px]">
                  {filteredChats.length > 0 ? (
                    filteredChats.map((chat) => (
                      <div
                        key={chat.id}
                        onClick={() => { loadChat(chat.id); onClose(); }}
                        className="w-full flex flex-col px-3 py-2.5 hover:bg-white/[0.03] rounded-xl transition-all cursor-pointer group active:scale-[0.99]"
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="text-[14px] font-medium text-[#A3A19E] group-hover:text-[#E8E6E3] transition-colors truncate pr-4">
                            {chat.title}
                          </span>
                          <span className="text-[10px] text-[#32312F] group-hover:text-[#555350] whitespace-nowrap tabular-nums">
                            {formatDate(chat.updatedAt)}
                          </span>
                        </div>
                        {chat.matchType === 'content' && chat.snippet && (
                          <div className="text-[11px] text-[#555350] group-hover:text-[#8C8A88] mt-1.5 line-clamp-1 italic font-light opacity-80 pl-1 border-l border-white/10 ml-0.5">
                            {chat.snippet}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-10 text-center flex flex-col items-center gap-2">
                       <div className="w-10 h-10 rounded-full bg-white/[0.02] border border-white/5 flex items-center justify-center mb-1">
                          <Search className="w-4 h-4 text-[#1A1A1A]" />
                       </div>
                       <span className="text-[#32312F] text-[13px] font-medium italic">No matches found for "{searchQuery}"</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-2.5 border-t border-white/5 flex justify-between items-center bg-[#070708]/40">
               <div className="flex items-center gap-3 text-[9px] text-[#32312F] font-bold tracking-widest uppercase">
                  <div className="flex items-center gap-1.5 bg-white/5 px-2 py-0.5 rounded border border-white/5">
                     <span className="text-[10px]">⏎</span>
                     <span>Select</span>
                  </div>
                  <div className="flex items-center gap-1.5 bg-white/5 px-2 py-0.5 rounded border border-white/5">
                     <span className="text-[10px] scale-90">⎋</span>
                     <span>Close</span>
                  </div>
               </div>
               <Maximize2 className="w-3 h-3 text-[#32312F] rotate-45 hover:text-[#555350] transition-colors cursor-pointer" />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
