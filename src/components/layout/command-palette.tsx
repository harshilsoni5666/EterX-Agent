import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  traceLogs?: any[];
  workspacePath?: string | null;
}

interface SearchResult extends ChatSession {
  snippet?: string;
  matchLabel?: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  chats: ChatSession[];
  loadChat: (id: string) => void;
  runningChats?: Set<string>;
  activeChatId?: string | null;
}

const textFromValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join(' ');
  if (!value || typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    'text', 'output', 'content', 'message', 'query', 'title', 'name', 'description',
    'summary', 'detail', 'command', 'result', 'value', 'url', 'path', 'status',
  ];
  const preferredText = preferredKeys.map(key => textFromValue(record[key])).filter(Boolean).join(' ');
  return preferredText || Object.values(record).map(textFromValue).filter(Boolean).join(' ');
};

const getWorkspaceName = (workspacePath?: string | null) => {
  const normalized = String(workspacePath || '').replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).pop() || '';
};

const getMatchLabel = (log: any) => {
  const type = String(log?.type || log?.kind || '').toLowerCase();
  if (/thought|thinking|plan|reason|deep/.test(type)) return 'Deep work';
  if (/tool|command|browser|computer|shell|search|action/.test(type)) return 'Agent work';
  if (/user|prompt|request/.test(type)) return 'Message';
  if (/answer|assistant|model|response/.test(type)) return 'Agent answer';
  return 'Conversation';
};

const makeSnippet = (value: string, query: string) => {
  const text = value.replace(/\s+/g, ' ').trim();
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text.slice(0, 120);

  const start = Math.max(0, index - 42);
  const end = Math.min(text.length, index + query.length + 70);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
};

const formatDate = (timestamp: number) => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(timestamp);
  } catch {
    return '';
  }
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  chats,
  loadChat,
  runningChats = new Set<string>(),
  activeChatId = null,
}) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo<SearchResult[]>(() => {
    const search = query.trim().toLowerCase();
    if (!search) return chats.slice(0, 18);

    return chats
      .flatMap(chat => {
        const title = String(chat.title || 'Untitled chat');
        if (title.toLowerCase().includes(search)) return [{ ...chat, matchLabel: 'Chat title' }];

        const logs = Array.isArray(chat.traceLogs) ? chat.traceLogs : [];
        for (let index = logs.length - 1; index >= 0; index -= 1) {
          const text = textFromValue(logs[index]).replace(/\s+/g, ' ').trim();
          if (!text.toLowerCase().includes(search)) continue;
          return [{
            ...chat,
            matchLabel: getMatchLabel(logs[index]),
            snippet: makeSnippet(text, query.trim()),
          }];
        }
        return [];
      })
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, 24);
  }, [chats, query]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [isOpen]);

  if (!isOpen) return null;

  const openChat = (chatId: string) => {
    loadChat(chatId);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none">
      <style suppressHydrationWarning dangerouslySetInnerHTML={{ __html: commandRunningIndicatorStyles }} />
      <button
        type="button"
        aria-label="Close chat search"
        onClick={onClose}
        className="absolute inset-0 pointer-events-auto cursor-default bg-transparent"
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label="Search chats"
        className="eterx-command-palette-dialog absolute left-1/2 top-1/2 flex max-h-[calc(100dvh-48px)] w-[calc(100%-48px)] max-w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] border border-white/[0.13] bg-[#252525]/[0.98] py-1 text-[#E8E6E3] shadow-[0_22px_64px_rgba(0,0,0,0.46)] backdrop-blur-[22px] pointer-events-auto dark:bg-[#252525]/[0.98]"
      >
        <div className="shrink-0 px-[20px] pb-1 pt-[15px]">
          <div className="flex items-center gap-2">
            <Search className="eterx-command-search-icon h-[17px] w-[17px] text-[#A6A3A0]" strokeWidth={1.8} aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="eterx-command-search-input min-w-0 flex-1 bg-transparent text-[16px] font-normal tracking-[-0.018em] text-[#E8E6E3] outline-none placeholder:text-[#A3A19E]"
            />
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              className={`eterx-command-clear-button flex h-7 w-7 items-center justify-center rounded-[8px] text-[#8E8B87] transition hover:bg-white/[0.08] hover:text-white ${query ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
        </div>

        <div className="eterx-command-search-section px-[20px] pb-1 pt-2 text-[13px] font-medium tracking-[-0.01em] text-[#A6A3A0]">
          Chats
        </div>

        <div className="max-h-[300px] min-h-0 overflow-y-auto px-1.5 pb-2 eterx-scrollbar">
          {results.length > 0 ? results.map((chat, index) => {
            const isWorking = runningChats.has(chat.id);
            const isActive = activeChatId === chat.id;
            const workspaceName = getWorkspaceName(chat.workspacePath);
            return (
              <button
                type="button"
                key={`${chat.id}-${index}`}
                onClick={() => openChat(chat.id)}
                className={`eterx-command-chat-row group flex min-h-[35px] w-full items-center gap-3 rounded-[10px] px-[14px] py-[4px] text-left transition-[background-color,color,transform] duration-150 hover:bg-white/[0.085] hover:text-[#F2F0ED] active:scale-[0.992] active:bg-white/[0.12] focus-visible:bg-white/[0.10] focus-visible:outline-none ${isActive ? 'bg-white/[0.105] text-[#F2F0ED]' : 'text-[#C7C5C2]'}`}
              >
                <span className="eterx-command-chat-title min-w-0 flex-1 truncate text-[13px] font-normal tracking-[-0.005em] group-hover:text-[#F2F0ED]">
                  {chat.title || 'Untitled chat'}
                  {chat.snippet && <span className="eterx-command-chat-match ml-2 text-[12px] text-[#888581]">{chat.matchLabel}</span>}
                </span>
                {workspaceName && <span className="eterx-command-chat-meta hidden shrink-0 max-w-[140px] truncate text-[10px] text-[#878480] sm:block">{workspaceName}</span>}
                <span className="eterx-command-chat-date shrink-0 text-[10px] tabular-nums text-[#8B8884]">{formatDate(chat.updatedAt)}</span>
                {isWorking && <span className="eterx-splash-spinner eterx-command-running-indicator shrink-0" role="status" aria-label="Agent working" />}
              </button>
            );
          }) : (
            <div className="eterx-command-empty flex flex-col items-center justify-center px-6 py-20 text-center text-[#8D8985]">
              <Search className="mb-3 h-6 w-6" strokeWidth={1.6} />
              <p className="text-[15px]">No chats found</p>
            </div>
          )}
        </div>

      </section>
    </div>
  );
};

// Keep palette-only layout/theme rules here; the shared splash ring lives in
// globals.css so the sidebar, palette, and thread switcher stay identical.
const commandRunningIndicatorStyles = `
  .eterx-command-palette-dialog .eterx-command-running-indicator {
    width: 14px;
    height: 14px;
  }
  :root[data-theme="light"] .eterx-command-palette-dialog {
    background: rgba(255, 255, 255, 0.97) !important;
    border-color: rgba(31, 31, 29, 0.11) !important;
    color: #262421 !important;
    box-shadow: 0 22px 64px rgba(31, 31, 29, 0.16) !important;
  }
  :root[data-theme="light"] .eterx-command-search-icon {
    color: #77736C !important;
  }
  :root[data-theme="light"] .eterx-command-search-input {
    color: #262421 !important;
  }
  :root[data-theme="light"] .eterx-command-search-input::placeholder {
    color: #8C8983 !important;
  }
  :root[data-theme="light"] .eterx-command-clear-button:hover {
    background: rgba(31, 31, 29, 0.07) !important;
    color: #262421 !important;
  }
  :root[data-theme="light"] .eterx-command-search-section {
    color: #77736C !important;
  }
  :root[data-theme="light"] .eterx-command-chat-row:hover,
  :root[data-theme="light"] .eterx-command-chat-row:focus-visible {
    background: rgba(31, 31, 29, 0.065) !important;
    color: #1F1F1D !important;
  }
  :root[data-theme="light"] .eterx-command-chat-row:active,
  :root[data-theme="light"] .eterx-command-chat-row.bg-white\/\[0\.105\] {
    background: rgba(31, 31, 29, 0.095) !important;
    color: #1F1F1D !important;
  }
  :root[data-theme="light"] .eterx-command-chat-title {
    color: #4B4945 !important;
  }
  :root[data-theme="light"] .eterx-command-chat-row:hover .eterx-command-chat-title,
  :root[data-theme="light"] .eterx-command-chat-row:focus-visible .eterx-command-chat-title {
    color: #1F1F1D !important;
  }
  :root[data-theme="light"] .eterx-command-chat-match,
  :root[data-theme="light"] .eterx-command-chat-meta,
  :root[data-theme="light"] .eterx-command-chat-date {
    color: #77736C !important;
  }
  :root[data-theme="light"] .eterx-command-empty {
    color: #77736C !important;
  }
`;
