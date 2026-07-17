import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X } from 'lucide-react';

const getPetLogText = (log: any) => {
  const raw = log?.text || log?.command || log?.summary || log?.message || '';
  return String(raw).replace(/\s+/g, ' ').trim();
};

export const getLatestPetMonitorText = (logs: any[], isThinking: boolean) => {
  if (isThinking) return 'Thinking';
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i];
    if (!log || log.type === 'user_action' || log.type === 'task_plan') continue;
    const text = getPetLogText(log);
    if (text) return text;
  }
  return isThinking ? 'Thinking' : '';
};

export const PetThinkingLabel = ({ className = '' }: { className?: string }) => (
  <span className={`eterx-pet-thinking-label inline-flex items-baseline gap-[3px] ${ className }`}>
    <span>Thinking</span>
    <span className="eterx-pet-thinking-dots inline-flex w-[22px] items-baseline justify-start gap-[2px]" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  </span>
);

export const FloatingPetMonitor = ({
  open,
  isThinking,
  title,
  logs,
  onClose,
  onReply,
}: {
  open: boolean;
  isThinking: boolean;
  title: string;
  logs: any[];
  onClose: () => void;
  onReply: (message: string) => void;
}) => {
  const [position, setPosition] = useState({ x: 28, y: 82 });
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const dragFrameRef = useRef<number | null>(null);

  const latestText = useMemo(() => getLatestPetMonitorText(logs, isThinking), [isThinking, logs]);

  const displayTitle = title?.trim() || 'EterX agent';
  const previewText = isThinking ? 'Thinking' : latestText;

  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button,input,textarea')) return;

    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;

    const handleMove = (moveEvent: PointerEvent) => {
      const next = {
        x: Math.max(8, Math.min(window.innerWidth - 96, origin.x + moveEvent.clientX - startX)),
        y: Math.max(8, Math.min(window.innerHeight - 64, origin.y + moveEvent.clientY - startY)),
      };

      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = window.requestAnimationFrame(() => {
        setPosition(next);
        dragFrameRef.current = null;
      });
    };

    const stopDrag = () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  }, [position]);

  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    };
  }, []);

  const submitReply = useCallback(() => {
    const message = replyText.trim();
    if (!message) return;
    onReply(message);
    setReplyText('');
    setReplyOpen(false);
  }, [onReply, replyText]);

  if (!open || !isThinking) return null;

  return (
    <div
      className={`eterx-pet-monitor group fixed z-[9998] w-[326px] max-w-[calc(100vw-24px)] select-none rounded-[24px] border border-white/[0.16] bg-[#171717]/96 text-[#F2F0EC] shadow-[0_18px_54px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.055)] backdrop-blur-2xl ${ replyOpen ? 'p-3' : 'px-4 py-3.5' }`}
      style={{ left: position.x, top: position.y }}
      onPointerDown={startDrag}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close pet monitor"
        className="eterx-pet-close absolute -left-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.16] bg-[#1F1F1F] text-white/72 opacity-0 shadow-[0_10px_26px_rgba(0,0,0,0.28)] transition-all duration-100 hover:bg-[#2A2A2A] hover:text-white group-hover:opacity-100 focus:opacity-100"
      >
        <X className="h-4 w-4" strokeWidth={2.3} />
      </button>

      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1 pt-0.5">
          {replyOpen ? (
            <div>
              <div className="eterx-pet-title truncate text-[13px] font-semibold leading-5 text-[#A8A39B]">
                {displayTitle}
              </div>
              <div className="eterx-pet-status mt-1 line-clamp-2 text-[15px] font-semibold leading-5 text-[#F2F0EC]">
                <PetThinkingLabel />
              </div>
            </div>
          ) : (
            <div className="eterx-pet-status text-[20px] font-semibold leading-7 text-[#F2F0EC]">
              <PetThinkingLabel />
            </div>
          )}
        </div>

        <span className="eterx-pet-spinner mt-1 h-[15px] w-[15px] shrink-0 rounded-full border-2 border-white/35 border-t-white animate-spin" />
      </div>

      {!replyOpen && (
        <button
          type="button"
          onClick={() => setReplyOpen(true)}
          className="eterx-pet-reply-button absolute bottom-3 right-4 hidden rounded-full border border-white/[0.10] bg-white/[0.055] px-4 py-1.5 text-[15px] font-medium text-[#E8E5DF] transition-colors hover:bg-white/[0.10] hover:text-white group-hover:block"
        >
          Reply
        </button>
      )}

      {replyOpen && (
        <div className="eterx-pet-reply-area mt-3 border-t border-white/[0.08] pt-3">
          <div className="flex items-center gap-2">
            <input
              value={replyText}
              onChange={(event) => setReplyText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitReply();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setReplyOpen(false);
                }
              }}
              autoFocus
              placeholder="Reply"
              className="eterx-pet-reply-input h-10 min-w-0 flex-1 select-text rounded-[10px] border border-[#6EA8FF]/70 bg-[#151515] px-3 text-[15px] font-medium text-white outline-none placeholder:text-[#8C8984] focus:border-[#8AB4FF]"
            />
            <button
              type="button"
              onClick={submitReply}
              disabled={!replyText.trim()}
              className="eterx-pet-reply-submit h-10 shrink-0 rounded-full bg-[#B8B4AC] px-4 text-[15px] font-semibold text-[#202020] transition-colors hover:bg-[#D8D4CC] disabled:cursor-default disabled:opacity-45"
            >
              Reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
