import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { Copy, RefreshCw, ChevronDown, FileText, Check, Clock, ChevronRight, MessageSquarePlus, Activity, Minimize2, CornerDownLeft, CircleStop, TriangleAlert } from 'lucide-react';
import { ThinkingProcess, ProfessionalThought } from '../chat/thought-sequence';
import { AskUserPrompt } from '../chat/ask-user-prompt';
import { Tooltip } from '../ui/tooltip';
import { Shimmer } from '../ui/shimmer';
import { notifyAgentFaceTraceLog } from './agent-face-controller';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, normalizeMarkdownForRendering, remarkPlugins, rehypePlugins } from './markdown-renderer';
import { LocalFileLinkChip, decodeLocalFileHref } from './local-file-link';
import { isInternalWorkNoteNoise, isTerminalWorkTrace, isTurnWorkActive, orderFeedTimelineLogs, shouldRenderContextCompactionEvent, shouldRenderProgressTrace, shouldShowWorkflowSequence } from '../../lib/chat-feed-lifecycle';
import { shouldRenderThoughtStream } from '../../lib/thought-stream-lifecycle';
import { isPrivateReasoningTrace } from '../../lib/agent/trace-visibility';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { buildFilePreviewUrl } from '../../lib/path-utils';

interface ChatFeedProps {
  traceLogs: any[];
  chatId: string | null;
  isThinking: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  setSidebarOpen: (o: boolean) => void;
  sidebarOpen: boolean;
  handleScroll: (e: any) => void;
  showScrollBottom: boolean;
  isCompressed?: boolean;
  onOpenAgentTeam?: (agentName?: string) => void;
  subAgentAssetIndexes?: Record<string, number>;
  isFeedActivityPaused?: boolean;
  onAnswerAskUser?: (timestamp: number, answer: string, responseKey?: string) => void;
  onEditUserMessage?: (text: string) => void;
  isSubAgentTab?: boolean;
  liveState?: string;
}

const FadeScrollContainer = React.memo(({
  children,
  className = '',
  maxHeightClass = 'max-h-[230px]',
  fadeClass = 'eterx-user-msg-fade',
}: {
  children: React.ReactNode;
  className?: string;
  maxHeightClass?: string;
  fadeClass?: string;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showBottomFade, setShowBottomFade] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasOverflow = el.scrollHeight > el.clientHeight + 4;
    const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 6;
    setShowBottomFade(hasOverflow && !isAtBottom);
  }, []);

  useEffect(() => {
    checkScroll();
    const timer = setTimeout(checkScroll, 120);
    window.addEventListener('resize', checkScroll);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', checkScroll);
    };
  }, [checkScroll, children]);

  return (
    <div className="relative w-full overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={checkScroll}
        className={`min-w-0 max-w-full w-full overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${maxHeightClass} ${className}`}
      >
        {children}
      </div>
      <AnimatePresence>
        {showBottomFade && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={`pointer-events-none absolute bottom-0 left-0 right-0 h-9 z-10 ${fadeClass}`}
          />
        )}
      </AnimatePresence>
    </div>
  );
});

import { safeCopyTextToClipboard } from '../ui/copy-button';

const copyTextToClipboard = async (text: string) => {
  return await safeCopyTextToClipboard(text);
};

const NakedCopyButton = React.memo(({ content }: { content: string }) => {
  const [copied, setCopied] = useState(false);
  const handle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const didCopy = await copyTextToClipboard(content);
    if (didCopy) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <Tooltip text={copied ? "Copied!" : "Copy"}>
      <button type="button" onClick={handle} className="rounded-[8px] p-[6px] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]">
        <span className="sr-only">{copied ? 'Copied' : 'Copy answer'}</span>
        {copied ? <Check className="w-[15px] h-[15px] text-[#74D39A]" /> : <Copy className="w-[15px] h-[15px]" />}
      </button>
    </Tooltip>
  );
});

const StepCounterIcon = ({ live = false }: { live?: boolean }) => (
  <svg
    width="18"
    height="16"
    viewBox="0 0 18 16"
    fill="none"
    aria-hidden="true"
    className="h-4 w-[18px] shrink-0 overflow-visible"
  >
    <path
      d="M8.35 3.5h7.15M8.35 8h7.15M8.35 12.5h7.15"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      opacity="0.68"
    />
    <path
      d="M2.05 3.55l1.28 1.28L5.95 2.1M2.05 8.05l1.28 1.28L5.95 6.6"
      stroke={live ? "#DCD8D1" : "currentColor"}
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity="0.92"
    />
    {live ? (
      <>
        <circle
          cx="3.85"
          cy="12.5"
          r="1.85"
          stroke="#DCD8D1"
          strokeWidth="1.3"
          opacity="0.9"
        />
        <circle
          cx="3.85"
          cy="12.5"
          r="0.58"
          fill="#DCD8D1"
          opacity="0.86"
        />
      </>
    ) : (
      <path
        d="M2.05 12.55l1.28 1.28 2.62-2.73"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.92"
      />
    )}
    {live && (
      <path
        d="M8.35 12.5h7.15"
        stroke="#F2EFE9"
        strokeWidth="1.55"
        strokeLinecap="round"
        opacity="0.5"
      >
        <animate attributeName="opacity" values="0.18;0.72;0.18" dur="1.55s" repeatCount="indefinite" />
      </path>
    )}
  </svg>
);

/** Copy button that shows a checkmark for 2s after clicking */
const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const copy = async () => {
    const didCopy = await copyTextToClipboard(text);
    if (!didCopy) return;
    clearTimeout(timerRef.current);
    setCopied(true);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button type="button" onClick={copy} className="rounded-[8px] p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]">
      <AnimatePresence mode="wait">
        {copied
          ? <motion.div key="check" initial={{ scale: 0.7 }} animate={{ scale: 1 }} exit={{ scale: 0.7 }}><Check className="w-3.5 h-3.5 text-emerald-500" /></motion.div>
          : <motion.div key="copy" initial={{ scale: 0.7 }} animate={{ scale: 1 }} exit={{ scale: 0.7 }}><Copy className="w-3.5 h-3.5" /></motion.div>
        }
      </AnimatePresence>
    </button>
  );
};

const EditMessageIcon = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
    <path
      d="M5 18.7 6.05 14.8 15.7 5.15a2.1 2.1 0 0 1 2.98 0l.17.17a2.1 2.1 0 0 1 0 2.98L9.2 17.95 5 18.7Z"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M14.2 6.65 17.35 9.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

const UserMessageActionButton = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) => {
  return (
    <button
      type="button"
      onClick={(event) => {
        onClick(event);
      }}
      aria-label={label}
      className="eterx-user-message-action-button relative isolate grid h-8 w-8 place-items-center rounded-full text-[#736E67] outline-none focus-visible:ring-2 focus-visible:ring-white/18"
    >
      <span className="pointer-events-none relative z-10 grid h-6 w-6 place-items-center rounded-full">
        {children}
      </span>
    </button>
  );
};

const formatShortTime = (timestamp: number | string | undefined | null): string => {
  if (!timestamp) return '';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  // Normalize seconds → milliseconds
  const ms = ts < 10_000_000_000 ? ts * 1000 : ts;
  try {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
};

const formatProviderTokenCount = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(tokens));
};

const UserMessageActions = React.memo(({ text, onEdit, timestamp }: { text: string; onEdit?: (text: string) => void; timestamp?: number | string | null }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const didCopy = await copyTextToClipboard(text);
    if (didCopy) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const timeLabel = formatShortTime(timestamp);

  return (
    <div className="eterx-user-message-actions absolute right-full top-1/2 mr-2 flex -translate-y-1/2 shrink-0 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover/user:opacity-100 group-hover/user:pointer-events-auto group-hover/steer:opacity-100 group-hover/steer:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto">
      {timeLabel && (
        <span className="eterx-chat-message-time eterx-professional-number mr-1 text-[11px] font-[550] leading-none tracking-[-0.015em] text-[#736E67] select-none whitespace-nowrap">
          {timeLabel}
        </span>
      )}
      <UserMessageActionButton label={copied ? "Copied" : "Copy message"} onClick={handleCopy}>
        {copied ? <Check className="h-[18px] w-[18px] text-emerald-400" strokeWidth={2.15} /> : <Copy className="h-[18px] w-[18px]" strokeWidth={2.15} />}
      </UserMessageActionButton>
      {onEdit && (
        <UserMessageActionButton
          label="Edit message"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(text);
          }}
        >
          <EditMessageIcon className="h-[18px] w-[18px]" />
        </UserMessageActionButton>
      )}
    </div>
  );
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SteeringFeedCard â€” left-aligned enterprise card shown in the main
// chat feed whenever the user sends a live steering message while the
// agent is running. Feels native to the conversation thread.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const SteeringFeedCard = React.memo(({ log, isCompressed = false, onEdit }: { log: any; isCompressed?: boolean; onEdit?: (text: string) => void }) => {
  const isProxy = log?._autonomyProxy === true || log?.source === 'user_proxy' || log?.source === 'proxy_manager';
  const text = String(log?.text || '').trim();
  if (!text) return null;

  return (
    <motion.div
      initial={{ opacity: 0, x: 12, y: 4 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="group/steer relative z-10 my-1.5 flex w-full justify-end"
    >
      <div
        className={`eterx-steering-bubble relative ml-auto flex items-end gap-2.5 rounded-[18px] rounded-tr-[7px] border px-4 py-2.5 text-[13.5px] leading-[1.5] text-[#F4F2EE] shadow-none ${ isProxy ? 'border-[#34383D] bg-[#16181A]' : 'border-white/[0.065] bg-[#20201F]' } ${ isCompressed ? 'max-w-[92%]' : 'max-w-[84%]' }`}
        data-proxy={isProxy ? 'true' : undefined}
        aria-label={isProxy ? 'Proxy guidance' : 'Guidance sent to the running agent'}
      >
        <UserMessageActions text={text} onEdit={isProxy ? undefined : onEdit} />
        <span className="min-w-0 whitespace-pre-wrap break-words text-left [overflow-wrap:anywhere]">{text}</span>
        <CornerDownLeft className="mb-0.5 h-4 w-4 shrink-0 select-none text-[#8F887E]" strokeWidth={2.15} aria-hidden="true" />
      </div>
    </motion.div>
  );
});

const liveMotionStyles = `
  @keyframes blink { 0%,100%{opacity:0.7} 50%{opacity:0} }
  @keyframes wi-spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
  @keyframes wi-breathe { 0%,100%{opacity:.6;filter:brightness(.85)} 50%{opacity:1;filter:brightness(1.25)} }
  @keyframes eterx-live-dot {
    0%, 76%, 100% { transform: translateY(0) scale(.92); opacity: .36; box-shadow: 0 0 0 rgba(190,190,186,0); }
    38% { transform: translateY(-2px) scale(1.08); opacity: .95; box-shadow: 0 0 9px rgba(190,190,186,.34); }
  }
  .eterx-live-dot { animation: eterx-live-dot 1.45s ease-in-out infinite; }
  @keyframes eterx-turns-wave {
    0%,100% { opacity: 0.35; transform: scaleX(1); }
    50% { opacity: 1; transform: scaleX(1.22); }
  }
  .eterx-turns-wave { animation: eterx-turns-wave 1.4s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .eterx-live-dot, .eterx-turns-wave { animation: none; opacity: .62; transform: none; }
  }
`;

const chatFeedSurfaceStyles = `
  .eterx-chat-feed {
    --eterx-chat-feed-bg: #0F0F0F;
    background: var(--eterx-chat-feed-bg);
  }
  :root[data-theme="light"] .eterx-chat-feed {
    --eterx-chat-feed-bg: #FFFFFF;
    color: #252A31;
  }
  :root[data-theme="dark"] .eterx-chat-feed {
    --eterx-chat-feed-bg: #0F0F0F;
    color: #E3E3E3;
  }
  .eterx-chat-feed-scroll,
  .eterx-chat-feed-content {
    background: var(--eterx-chat-feed-bg);
  }
  .eterx-chat-feed[data-agent-builder="true"][data-compressed="false"] .eterx-agent-builder-feed-content {
    max-width: min(760px, 100%) !important;
  }
  .eterx-chat-feed[data-agent-builder="true"] .eterx-thinking-process-stack {
    gap: 10px;
  }
  .eterx-chat-feed-empty {
    --eterx-chat-feed-bg: transparent;
    background: transparent;
  }
  .eterx-chat-feed-empty .eterx-chat-feed-scroll,
  .eterx-chat-feed-empty .eterx-chat-feed-content {
    background: transparent;
  }
  .eterx-proxy-status-divider {
    display: flex;
    align-items: center;
    gap: 16px;
    color: rgba(213, 211, 206, 0.58);
  }
  .eterx-proxy-status-divider-line {
    height: 1px;
    flex: 1 1 0%;
    min-width: 24px;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.13));
  }
  .eterx-proxy-status-divider-line:last-child {
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.13), transparent);
  }
  .eterx-proxy-status-divider-label {
    display: inline-flex;
    max-width: min(72%, 540px);
    align-items: center;
    justify-content: center;
    text-align: center;
    font-size: 12px;
    font-weight: 400;
    line-height: 1.45;
    letter-spacing: 0.01em;
  }
  .eterx-proxy-intervention-level {
    font-weight: 500;
  }
  .eterx-proxy-intervention-level-high {
    color: #c99a72;
  }
  .eterx-proxy-intervention-level-normal {
    color: #9aa9b7;
  }
  .eterx-proxy-intervention-level-minimal {
    color: #9eae9d;
  }
  :root[data-theme="light"] .eterx-proxy-status-divider {
    color: rgba(75, 82, 91, 0.68);
  }
  :root[data-theme="light"] .eterx-proxy-status-divider-label {
    color: rgba(75, 82, 91, 0.76);
    font-weight: 400;
  }
  :root[data-theme="light"] .eterx-proxy-intervention-level-high {
    color: #a56f3f;
  }
  :root[data-theme="light"] .eterx-proxy-intervention-level-normal {
    color: #5f7182;
  }
  :root[data-theme="light"] .eterx-proxy-intervention-level-minimal {
    color: #5f785f;
  }
  :root[data-theme="light"] .eterx-proxy-status-divider-line {
    background: linear-gradient(90deg, transparent, rgba(75, 82, 91, 0.22));
  }
  :root[data-theme="light"] .eterx-proxy-status-divider-line:last-child {
    background: linear-gradient(90deg, rgba(75, 82, 91, 0.22), transparent);
  }
  .eterx-chat-turns-nav {
    mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);
    scroll-padding-block: 16px;
  }

  .eterx-user-message-action-fade {
    filter: none;
    background:
      linear-gradient(90deg, rgba(32, 32, 31, 0) 0%, rgba(32, 32, 31, 0.54) 58%, #20201F 100%),
      linear-gradient(180deg, rgba(32, 32, 31, 0) 0%, rgba(32, 32, 31, 0.46) 64%, #20201F 100%);
  }
  :root[data-theme="light"] .eterx-user-message-action-fade {
    background:
      linear-gradient(90deg, rgba(247, 250, 253, 0) 0%, rgba(247, 250, 253, 0.70) 58%, #F7FAFD 100%),
      linear-gradient(180deg, rgba(247, 250, 253, 0) 0%, rgba(247, 250, 253, 0.64) 64%, #F7FAFD 100%);
  }
  @media (hover: none), (pointer: coarse) {
    .eterx-user-message-actions {
      opacity: 1;
      pointer-events: auto;
    }
  }
  @media (max-width: 640px) {
    .eterx-chat-turns-nav { display: none; }
    .eterx-user-message-actions { margin-right: 0.25rem; }
  }
`;

const WORKFLOW_COUNT_TYPES = new Set([
  'command',
  'tool_call',
  'tool_call',
  'exploration',
  'file_edit',
  'communication',
  'safety_warning',
  'sub_agent_spawn',
  'progress',
  'browser',
]);
const HIDDEN_HELPER_TYPES = new Set(['answer', 'ask_user', 'file_preview', 'console_output', 'html_preview']);
const RENDERABLE_TIMELINE_TYPES = new Set([
  'thought_stream',
  'work_note',
  'command',
  'tool_call',
  'exploration',
  'file_edit',
  'progress',
  'browser',
  'safety_warning',
  'communication',
  'steering_received',
  'autonomy_proxy_status',
  'sub_agent_spawn',
  'sub_agent_answer',
  'sub_agent_result',
  'sub_agent_action',
  'sub_agent_complete',
  'sub_agent_error',
  'sub_agent_pause',
  'sub_agent_resume',
  'sub_agent_close',
  'inter_agent_comm',
  'inter_agent_message',
  'file_preview',
  'console_output',
  'ask_user',
  'tool_result_preview',
  'context_compaction',
]);
const USER_QUERY_PREVIEW_LIMIT = 520;
const USER_QUERY_PREVIEW_LINES = 8;
const MAX_TURN_NAV_ITEMS = 80;
const AGENT_BUILDER_INTERNAL_REQUEST_PATTERN = /^\[AGENT BUILDER REQUEST\]\s*\r?\nTarget agent ID:[^\r\n]*\r?\n\s*\r?\n\[USER REQUEST\]\s*\r?\n?([\s\S]*)$/i;

function normalizeTraceText(value: any) {
  return String(value || '')
    .replace(/<\/?thought>/gi, '')
    .replace(/^[\s*_`~]+|[\s*_`~]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const normalizeInternalUserActionLogs = (logs: any[]) => {
  const visibleRunIds = new Set(
    logs
      .filter(log => log?.type === 'user_action' && !AGENT_BUILDER_INTERNAL_REQUEST_PATTERN.test(String(log.text || '')))
      .map(log => String(log.runId || log.turnId || '').trim())
      .filter(Boolean),
  );

  return logs.reduce<any[]>((next, log) => {
    if (log?.type !== 'user_action') {
      next.push(log);
      return next;
    }
    const source = String(log.source || '').trim().toLowerCase();
    const steeringIds = [log.steeringId, ...(Array.isArray(log.steeringIds) ? log.steeringIds : [])]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    const isInjectedProxyBoundary =
      (source === 'user_proxy' || source === 'proxy_manager') && steeringIds.length > 0;
    // A steer is already represented by steering_received. Its internal
    // context-injection boundary must never become a second user bubble or a
    // new visual turn, even if the acknowledgement and boundary poll in on
    // different frames.
    if (isInjectedProxyBoundary) return next;
    const rawText = String(log.text || '');
    const match = rawText.match(AGENT_BUILDER_INTERNAL_REQUEST_PATTERN);
    if (!match) {
      next.push(log);
      return next;
    }
    const runId = String(log.runId || log.turnId || '').trim();
    if (runId && visibleRunIds.has(runId)) return next;
    next.push({ ...log, text: String(match[1] || '').trim() });
    return next;
  }, []);
};

const mergeDuplicateFeedLog = (previous: any, incoming: any) => {
  const previousText = String(previous?.text || '');
  const incomingText = String(incoming?.text || '');
  const text = incomingText.length >= previousText.length ? incomingText : previousText;
  const previousStart = Number(previous?.startTime || previous?.timestamp || 0);
  const incomingStart = Number(incoming?.startTime || incoming?.timestamp || 0);
  const previousEnd = Number(previous?.endTime || previous?.timestamp || 0);
  const incomingEnd = Number(incoming?.endTime || incoming?.timestamp || 0);
  const previousNarrativeClosed =
    (previous?.type === 'thought_stream' || previous?.type === 'work_note') &&
    (previous?.isStreaming === false || previous?.streamState === 'closed');
  const narrativeRank = (type: any) =>
    type === 'autonomy_proxy_status' ? 3 : type === 'work_note' ? 2 : type === 'thought_stream' ? 1 : 0;
  const preferredType = narrativeRank(previous?.type) > narrativeRank(incoming?.type)
    ? previous.type
    : incoming?.type;
  return {
    ...previous,
    ...incoming,
    type: preferredType,
    text,
    startTime: previousStart > 0 && incomingStart > 0
      ? Math.min(previousStart, incomingStart)
      : previousStart || incomingStart || undefined,
    endTime: (previousNarrativeClosed ? previousEnd || incomingEnd : Math.max(previousEnd, incomingEnd)) || undefined,
    ...(previousNarrativeClosed
      ? {
        timestamp: previous?.timestamp ?? previous?.endTime ?? incoming?.timestamp,
        isStreaming: false,
        streamState: 'closed',
      }
      : {}),
    wasStreaming: Boolean(
      previous?.wasStreaming ||
      previous?.isStreaming ||
      previous?.isLiveTyping ||
      incoming?.wasStreaming ||
      incoming?.isStreaming ||
      incoming?.isLiveTyping
    ),
  };
};

const dedupeFeedLogs = (logs: any[]) => {
  const deduped: any[] = [];
  const stableIndexes = new Map<string, number>();
  const userBoundaryIndexes = new Map<string, number>();
  const liveUserTextIndexes = new Map<string, number>();
  const steeringIndexes = new Map<string, number>();
  let semanticIndexes = new Map<string, number>();

  logs.forEach((log: any) => {
    if (!log) return;
    const runId = String(log.runId || log.turnId || '').trim();
    const stableId = log._traceIdx ?? log.traceId ?? log.id ?? null;
    const stableType = log.type === 'tool_call' ? 'command' : String(log.type || '');
    const stableKey = stableId === null || stableId === undefined
      ? ''
      : `${ runId }::${ String(stableId) }::${ stableType }`;

    if (stableKey && stableIndexes.has(stableKey)) {
      const index = stableIndexes.get(stableKey)!;
      deduped[index] = mergeDuplicateFeedLog(deduped[index], log);
      return;
    }

    if (log.type === 'user_action') {
      const normalizedUserText = normalizeTraceText(log.text);
      const source = String(log.source || 'human').trim().toLowerCase();
      const liveUserKey = `${ source }::${ normalizedUserText }`;
      const priorLiveIndex = liveUserTextIndexes.get(liveUserKey);
      if (normalizedUserText && priorLiveIndex !== undefined) {
        const priorBoundary = deduped[priorLiveIndex];
        const logsBetween = deduped.slice(priorLiveIndex + 1);
        const hasAssistantResponseBetween = logsBetween.some(candidate =>
          candidate?.type === 'answer' ||
          ['command', 'tool_call', 'exploration', 'file_edit', 'browser'].includes(candidate?.type)
        );
        const priorAt = Number(priorBoundary?.startTime || priorBoundary?.timestamp || 0);
        const incomingAt = Number(log?.startTime || log?.timestamp || 0);
        const closeInTime = priorAt > 0 && incomingAt > 0 && Math.abs(incomingAt - priorAt) <= 15_000;
        const isLiveReconciliation = Boolean(priorBoundary?.isLive || log?.isLive) && !hasAssistantResponseBetween;
        if (!hasAssistantResponseBetween && (closeInTime || isLiveReconciliation)) {
          deduped[priorLiveIndex] = mergeDuplicateFeedLog(priorBoundary, log);
          if (stableKey) stableIndexes.set(stableKey, priorLiveIndex);
          return;
        }
      }
      const userBoundaryKey = [
        runId,
        source,
        normalizedUserText,
      ].join('::');
      const priorBoundaryIndex = userBoundaryIndexes.get(userBoundaryKey);
      if (priorBoundaryIndex !== undefined) {
        const priorBoundary = deduped[priorBoundaryIndex];
        const priorIsOptimistic = priorBoundary?._traceIdx === undefined || priorBoundary?._traceIdx === null;
        const incomingIsOptimistic = log._traceIdx === undefined || log._traceIdx === null;
        if (priorIsOptimistic || incomingIsOptimistic) {
          deduped[priorBoundaryIndex] = mergeDuplicateFeedLog(priorBoundary, log);
          if (stableKey) stableIndexes.set(stableKey, priorBoundaryIndex);
          return;
        }
      }
      const previous = deduped[deduped.length - 1];
      const sameOptimisticBoundary = previous?.type === 'user_action' &&
        String(previous.runId || previous.turnId || '').trim() === runId &&
        String(previous.source || 'human') === String(log.source || 'human') &&
        String(previous.text || '').trim() === String(log.text || '').trim();
      if (sameOptimisticBoundary) {
        deduped[deduped.length - 1] = mergeDuplicateFeedLog(previous, log);
        if (stableKey) stableIndexes.set(stableKey, deduped.length - 1);
        return;
      }
      semanticIndexes = new Map();
      userBoundaryIndexes.set(userBoundaryKey, deduped.length);
      if (normalizedUserText) liveUserTextIndexes.set(liveUserKey, deduped.length);
    }

    if (log.type === 'steering_received') {
      const steeringId = String(log.steeringId || '').trim();
      const steeringKey = steeringId
        ? `${ runId }::id::${ steeringId }`
        : `${ runId }::legacy::${ String(log.source || 'user') }::${ normalizeTraceText(log.text) }`;
      const priorSteeringIndex = steeringIndexes.get(steeringKey);
      if (priorSteeringIndex !== undefined) {
        deduped[priorSteeringIndex] = mergeDuplicateFeedLog(deduped[priorSteeringIndex], log);
        if (stableKey) stableIndexes.set(stableKey, priorSteeringIndex);
        return;
      }
      steeringIndexes.set(steeringKey, deduped.length);
    }

    const normalizedText = normalizeTraceText(log.text || log.question || log.secondary);
    const owner = String(log.subAgentChatId || log.subAgentId || log.subAgent || log.agentName || 'main');
    const chatScope = String(log.chatId || log.ownerChatId || '').trim();
    const runScope = String(log.runId || log.turnId || '').trim();
    const identityScope = `${ chatScope }::${ runScope }`;
    let semanticKey = '';
    if (normalizedText && ['thought_stream', 'work_note', 'autonomy_proxy_status'].includes(log.type)) {
      // Providers sometimes promote the same narration from thought_stream to
      // work_note (or Proxy status) with a new type. The stream anchor is part
      // of the key: text alone is not identity because two real phases can
      // legitimately repeat the same sentence and must keep separate timers.
      const narrativeAnchor = String(
        log.thoughtId ||
        log.noteId ||
        log.startTime ||
        log.timestamp ||
        ''
      ).trim();
      semanticKey = `narrative::${ identityScope }::${ owner }::${ normalizedText }::${ narrativeAnchor }`;
    } else if (normalizedText && log.type === 'progress') {
      // Retry transports can publish the same durable notice more than once.
      // Preserve distinct messages, but collapse exact repeats within a turn.
      semanticKey = `progress::${ identityScope }::${ normalizedText }::${ normalizeTraceText(log.secondary) }`;
    } else if (normalizedText && log.type === 'agent_status') {
      semanticKey = `agent-status::${ identityScope }::${ String(log.status || '') }::${ normalizedText }`;
    } else if (
      normalizedText &&
      (log.isLive || log._instant) &&
      ['command', 'tool_call', 'exploration', 'file_edit', 'browser', 'communication'].includes(log.type)
    ) {
      const semanticType = log.type === 'tool_call' ? 'command' : log.type;
      semanticKey = `live-action::${ identityScope }::${ semanticType }::${ normalizedText }::${ String(log.filepath || log.filename || log.command || '') }`;
    } else if (log.type === 'answer' && normalizedText && (log.isLive || log.isStreaming || log.isLiveTyping)) {
      semanticKey = `answer::${ identityScope }::${ String(log.answerId || normalizedText) }`;
    }

    if (semanticKey && semanticIndexes.has(semanticKey)) {
      const index = semanticIndexes.get(semanticKey)!;
      deduped[index] = mergeDuplicateFeedLog(deduped[index], log);
      if (stableKey) stableIndexes.set(stableKey, index);
      return;
    }

    const index = deduped.length;
    deduped.push(log);
    if (stableKey) stableIndexes.set(stableKey, index);
    if (semanticKey) semanticIndexes.set(semanticKey, index);
  });

  return deduped;
};

const isNarrationThought = (value: any) => {
  const text = String(value || '').trim();
  return /^(i['â€™]?ll|i will|i['â€™]?m|i am|let me|now let me|next\b|i need to|i can|i should|i will now)\b/i.test(text);
};

const isInternalStatusThought = (log: any) => {
  if (!log || (log.type !== 'thought' && log.type !== 'agent_status')) return false;
  if (log.type === 'agent_status') return true;
  const text = normalizeTraceText(log.text);
  return !text ||
    /^generation stopped by user\.?$/.test(text) ||
    /^agent stopped\b/.test(text) ||
    /^agent connection did not start\b/.test(text) ||
    /^agent connection failed\b/.test(text) ||
    /^agent start failed\b/.test(text) ||
    /^custom agent (?:start|connection) failed\b/.test(text) ||
    /^could not stop the agent\b/.test(text) ||
    /^failed to send message to\b/.test(text);
};

type AgentRunNotice = {
  tone: 'stopped' | 'error' | 'warning';
  title: string;
  detail: string;
};

const cleanAgentStatusText = (value: unknown) => String(value || '')
  .replace(/^\s*[*_`]+|[*_`]+\s*$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const getAgentRunNotice = (log: any): AgentRunNotice | null => {
  if (!isInternalStatusThought(log)) return null;

  const detail = cleanAgentStatusText(log.detail || log.text || log.message);
  if (log.type !== 'agent_status' && !detail) return null;
  const explicitStatus = String(log.status || '').toLowerCase();
  const explicitTitle = cleanAgentStatusText(log.title);

  if (log.type === 'agent_status') {
    const tone = explicitStatus === 'stopped'
      ? 'stopped'
      : explicitStatus === 'warning'
        ? 'warning'
        : 'error';
    return {
      tone,
      title: explicitTitle || (tone === 'stopped' ? 'Run stopped' : tone === 'warning' ? 'Action needed' : 'Run failed'),
      detail: detail || (tone === 'stopped' ? 'The agent was stopped.' : 'The agent could not continue.'),
    };
  }

  if (/^generation stopped by user\.?$/i.test(detail)) {
    return { tone: 'stopped', title: 'Run stopped', detail: 'Stopped by you.' };
  }
  if (/^could not stop the agent\b/i.test(detail)) {
    return { tone: 'warning', title: 'Stop request failed', detail: detail.replace(/^could not stop the agent\s*:?\s*/i, '') || 'The agent may still be running.' };
  }
  if (/^agent stopped\s*:/i.test(detail)) {
    return { tone: 'error', title: 'Run ended with an error', detail: detail.replace(/^agent stopped\s*:?\s*/i, '') || 'The agent could not continue.' };
  }
  if (/^agent stopped\b/i.test(detail)) {
    return { tone: 'stopped', title: 'Run stopped', detail: detail.replace(/^agent stopped\s*:?\s*/i, '') || 'The agent was stopped.' };
  }
  if (/connection (?:failed|did not start)|start failed/i.test(detail)) {
    return { tone: 'error', title: 'Agent unavailable', detail };
  }
  return { tone: 'error', title: 'Request failed', detail: detail || 'The request could not be completed.' };
};

const AgentRunStatusNotice = ({ notice }: { notice: AgentRunNotice }) => {
  const isStopped = notice.tone === 'stopped';
  const Icon = isStopped ? CircleStop : TriangleAlert;

  return (
    <div
      role={isStopped ? 'status' : 'alert'}
      className={`eterx-agent-run-notice eterx-agent-run-notice-${ notice.tone } mb-3 flex w-full items-start gap-2 py-1 text-[13px] leading-[1.5]`}
    >
      <Icon className="eterx-agent-run-notice-icon mt-[3px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0 whitespace-pre-wrap break-words">
        <span className="font-semibold">{notice.title}.</span>{' '}
        <span className="eterx-agent-run-notice-detail">{notice.detail}</span>
      </span>
    </div>
  );
};

const ContextCompactionNotice = ({ log }: { log: any }) => {
  const isCompacting = log?.phase === 'compacting';
  const isRetrying = log?.phase === 'retrying';
  const before = Number(log?.beforeTokens || 0);
  const after = Number(log?.afterTokens || 0);
  const detail = isRetrying
    ? 'Run continuing · retry scheduled'
    : !isCompacting && before > 0 && after > 0
      ? `${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens`
      : '';

  const label = isCompacting
    ? 'Context automatically compacting'
    : isRetrying
      ? 'Context compaction will retry'
      : 'Context successfully compacted';

  return (
    <div
      role="status"
      aria-live="polite"
      className="eterx-context-compaction my-3.5 flex min-h-7 w-full items-center gap-3.5 py-1 text-[13px] text-[#1D1D1B] dark:text-[#F4F4F4]"
    >
      <span className={`h-px min-w-8 flex-1 bg-gradient-to-r from-transparent to-[var(--border)] ${isCompacting ? 'opacity-80' : 'opacity-55'}`} />
      <span className="inline-flex min-w-0 max-w-full flex-1 items-center gap-2 overflow-hidden">
        <span
          aria-hidden="true"
          className={`inline-block h-4 w-4 shrink-0 bg-current transition-opacity ${isCompacting ? 'opacity-90' : 'opacity-100'}`}
          style={{
            WebkitMask: 'url(/icons/settings/context.png) center / contain no-repeat',
            mask: 'url(/icons/settings/context.png) center / contain no-repeat',
          }}
        />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={`${log?.compactionId || 'context'}-${log?.phase || 'compacted'}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="min-w-0 truncate font-medium tracking-[-0.01em]"
          >
            {isCompacting ? <Shimmer>{label}</Shimmer> : label}
          </motion.span>
        </AnimatePresence>
        {detail && <span className="hidden shrink-0 text-[11.5px] font-normal text-[#666664] dark:text-[#B0B0B0] sm:inline">{detail}</span>}
      </span>
      <span className={`h-px min-w-8 flex-1 bg-gradient-to-l from-transparent to-[var(--border)] ${isCompacting ? 'opacity-80' : 'opacity-55'}`} />
    </div>
  );
};

const isLikelyAnswerEcho = (candidate: any, answer: any) => {
  const left = normalizeTraceText(candidate);
  const right = normalizeTraceText(answer);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return (shorter.length >= 25 && longer.includes(shorter)) || (shorter.length > 80 && longer.includes(shorter));
};

const getUserQueryPreview = (value: any) => {
  const text = String(value || '');
  const lines = text.split(/\r?\n/);
  const isLong = text.length > USER_QUERY_PREVIEW_LIMIT || lines.length > USER_QUERY_PREVIEW_LINES;
  return { isLong };
};

const getTraceActivitySignature = (logs: any[]) => {
  const start = Math.max(0, logs.length - 3);
  return logs
    .slice(start)
    .map((log, offset) => {
      const text = String(log?.text ?? log?.output ?? log?.content ?? log?.secondary ?? '');
      return [
        start + offset,
        log?._traceIdx ?? '',
        log?.type ?? '',
        log?.answerId ?? '',
        log?.noteId ?? '',
        log?.thoughtId ?? '',
        log?.endTime ?? log?.timestamp ?? '',
        log?.isStreaming === true ? 'streaming' : 'settled',
        log?.isLiveTyping === true ? 'typing' : 'stable',
        log?.streamState ?? '',
        text.length,
        text.slice(-32),
      ].join(':');
    })
    .join('|');
};

const getGroupMountIdentity = (group: any[], groupIdx: number) => {
  const anchor = group[0];
  if (!anchor) return `pending-${ groupIdx }`;
  return String(
    anchor.id ??
    anchor._traceIdx ??
    anchor.turnId ??
    anchor.responseKey ??
    anchor.timestamp ??
    anchor.startTime ??
    `${ anchor.type || 'log' }-${ groupIdx }`
  );
};

const countVisibleWorkflowActions = (logs: any[]) => {
  const identities = new Set<string>();
  const fallbackOccurrences = new Map<string, number>();
  logs.forEach((log, index) => {
    if (!WORKFLOW_COUNT_TYPES.has(log?.type) || HIDDEN_HELPER_TYPES.has(log?.type) || isHiddenStatusOnlyLog(log)) return;
    const actionType = log.type === 'tool_call' ? 'command' : String(log.type || '');
    const stableIdentity = log._traceIdx ?? log.traceId ?? log.id ?? log.toolCallId ?? log.ownerTraceId;
    const stableScope = `${actionType}|${log.runId || log.turnId || ''}|${log.subAgent || log.agentName || ''}`;
    const semanticIdentity = [
      actionType,
      log.subAgent || log.agentName || '',
      normalizeTraceText(log.command || log.text || log.secondary || ''),
      String(log.filename || log.filepath || log.path || '').trim().toLowerCase(),
    ].join('|');
    if (stableIdentity !== undefined && stableIdentity !== null && String(stableIdentity).trim()) {
      identities.add(`stable:${stableScope}|${String(stableIdentity)}`);
      return;
    }

    // Live providers can emit the same action once as a start event and
    // again as a hydrated/polled event without preserving a trace id. Use
    // the event time when available so those updates share one counter entry.
    // If no time exists, keep an occurrence suffix: identical actions in a
    // real sequence still count separately instead of collapsing together.
    const rawTime = log.startTime ?? log.timestamp ?? log.endTime;
    const eventTime = normalizeWorkTimestamp(rawTime);
    const base = `semantic:${semanticIdentity}`;
    if (eventTime !== null) {
      identities.add(`${base}|${eventTime}`);
      return;
    }
    const occurrence = fallbackOccurrences.get(base) || 0;
    fallbackOccurrences.set(base, occurrence + 1);
    identities.add(`${base}|occurrence:${occurrence}|index:${index}`);
  });
  return identities.size;
};

/**
 * CollapsibleThinking â€” wraps ThinkingProcess.
 * While thinking: always open (live).
 * After answer delivered: auto-collapses to a compact "N steps" pill.
 * User can click to expand/re-read the full work.
 */
const HIDDEN_MODEL_STATUS_PATTERN = /^(?:(?:using|starting|selected)\s+)?(?:model\s*:?\s*)?(?:gemini[\s-]*3(?:\.5)?[\s-]*flash|gemini-3\.5-flash|mistral\s+devstral\s+2|devstral-2512)(?:\s+(?:is\s+)?(?:starting|loading|initializing|selected|ready|working))?(?:\s+model)?$/i;
const DASH_ONLY_STATUS_PATTERN = /^[\s\-â€“â€”]{2,}$/;

const isHiddenStatusOnlyLog = (log: any) => {
  if (log?.type === 'progress' && !shouldRenderProgressTrace(log)) return true;
  if (log?.type === 'model_usage') return true;
  if (log?.type === 'work_note_cancel') return true;
  if (log?.type === 'answer_cancel') return true;
  if (log?.type === 'task_plan') return true;
  // Older direct Chat runs emitted lifecycle work notes as plain rows. The
  // direct path now uses the shared thought container, but hide those legacy
  // rows when an existing chat is reopened.
  if (
    log?.type === 'work_note' &&
    /^direct_(?:thinking|search)_/i.test(String(log.noteId || ''))
  ) return true;
  // Hide streaming worknote placeholders that were cancelled and not yet replaced
  if (log?.type === 'work_note' && log?._streamingCancelled === true) return true;
  if (!log || log.type === 'user_action' || log.type === 'answer') return false;
  const values = [log.text, log.secondary, log.modelName, log.model]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return values.some(value =>
    HIDDEN_MODEL_STATUS_PATTERN.test(value) ||
    DASH_ONLY_STATUS_PATTERN.test(value)
  );
};

const formatWorkElapsed = (seconds: number) => {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;

  if (hours > 0) {
    return `${ hours }h ${ minutes }m ${ rest }s`;
  }
  return minutes > 0 ? `${ minutes }m ${ rest }s` : `${ rest }s`;
};

const RollingTimeDisplay = ({ label }: { label: string }) => {
  const parts = label.split(/(\d+)/g);

  return (
    <span className="eterx-professional-number inline-block min-w-[3ch] whitespace-nowrap font-[550] tracking-[-0.015em]">
      {parts.map((part, index) => /^\d+$/.test(part) ? (
        <span key={`${part}-${index}`} className="eterx-professional-number font-[600] tracking-[-0.02em]">
          {part}
        </span>
      ) : part)}
    </span>
  );
};

const MAX_REASONABLE_WORK_MS = 24 * 60 * 60 * 1000;

const normalizeWorkTimestamp = (value: unknown): number | null => {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  // Some persisted/live traces may store epoch seconds while newer traces store
  // epoch milliseconds. Normalize before comparing or elapsed time explodes.
  let timestamp = raw < 10_000_000_000 ? raw * 1000 : raw;

  // Guard against microsecond/nanosecond-ish values without accepting tiny
  // relative timers like performance.now(), which cannot be mixed with Date.now().
  while (timestamp > 10_000_000_000_000) timestamp = Math.floor(timestamp / 1000);

  const now = Date.now();
  const minPlausible = Date.UTC(2020, 0, 1);
  if (timestamp < minPlausible || timestamp > now + 60_000) return null;
  return timestamp;
};

const isCountedWorkflowLog = (log: any) =>
  WORKFLOW_COUNT_TYPES.has(log?.type) &&
  !HIDDEN_HELPER_TYPES.has(log?.type) &&
  !isHiddenStatusOnlyLog(log);

const isLiveWorkflowLog = (log: any) =>
  isCountedWorkflowLog(log) &&
  (
    log?.isLive === true ||
    log?.isStreaming === true ||
    log?.isLiveTyping === true ||
    log?.streamState === 'open' ||
    ['running', 'working', 'pending'].includes(String(log?.status || '').toLowerCase())
  );

const isTimedWorkLog = (log: any) =>
  isCountedWorkflowLog(log) ||
  (
    (
      log?.type === 'work_note' ||
      (log?.type === 'thought_stream' && shouldRenderThoughtStream(log))
    ) &&
    !isHiddenStatusOnlyLog(log)
  );

const getWorkTimeBounds = (logs: any[]) => {
  let start: number | null = null;
  let end: number | null = null;
  logs.forEach((log) => {
    const startValue = normalizeWorkTimestamp(log?.startTime ?? log?.timestamp ?? log?.endTime);
    const endValue = normalizeWorkTimestamp(log?.endTime ?? log?.timestamp ?? log?.startTime);
    // Work begins with the first visible reasoning, note, or action. The user
    // message and request-admission/network wait remain outside this duration.
    if (isTimedWorkLog(log) && startValue !== null) {
      start = start === null ? startValue : Math.min(start, startValue);
    }
    // Do not let bookkeeping traces (usage, model metadata, late polling
    // records, etc.) extend the visible work duration. Only visible work and
    // the answer/terminal boundary are valid endpoints for this counter.
    const isWorkEnd = isTimedWorkLog(log) || log?.type === 'answer' || isTerminalWorkTrace(log);
    if (isWorkEnd && endValue !== null) end = end === null ? endValue : Math.max(end, endValue);
  });
  if (start !== null && end !== null && end < start) end = start;
  return { start, end };
};

const getWorkElapsedFromBounds = (start: number | null, end: number | null) => {
  if (start === null || end === null) return 0;
  const elapsedMs = Math.max(0, Math.min(end - start, MAX_REASONABLE_WORK_MS));
  return Math.floor(elapsedMs / 1000);
};

const useWorkElapsedSeconds = (active: boolean, logs: any[], endedAt?: number | null) => {
  const [seconds, setSeconds] = React.useState(0);
  const sessionStartRef = React.useRef<number | null>(null);

  const normalizedEndedAt = React.useMemo(() => normalizeWorkTimestamp(endedAt), [endedAt]);
  const actionStart = React.useMemo(() => getWorkTimeBounds(logs).start, [logs]);

  // 1. Establish stable session start time
  React.useEffect(() => {
    if (active) {
      if (sessionStartRef.current === null) {
        sessionStartRef.current = actionStart ?? Date.now();
      } else if (actionStart !== null) {
        // The first provider event can arrive after the timer has painted.
        // Re-anchor to its real start instead of permanently losing that
        // portion of the live stream.
        sessionStartRef.current = Math.min(sessionStartRef.current, actionStart);
      }
    } else {
      sessionStartRef.current = null;
    }
  }, [active, actionStart]);

  // 2. Manage the live tick interval when active (no dependence on logs/bounds changes)
  React.useEffect(() => {
    if (!active) return;

    const tick = () => {
      if (sessionStartRef.current !== null) {
        const elapsedMs = Math.max(0, Math.min(Date.now() - sessionStartRef.current, MAX_REASONABLE_WORK_MS));
        setSeconds(Math.floor(elapsedMs / 1000));
      }
    };

    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [active]);

  // 3. Fallback to static bounds calculation when inactive
  React.useEffect(() => {
    if (!active) {
      const bounds = getWorkTimeBounds(logs);
      const finalEnd = normalizedEndedAt ?? bounds.end;
      const finalStart = bounds.start;
      setSeconds(getWorkElapsedFromBounds(finalStart, finalEnd));
    }
  }, [active, logs, normalizedEndedAt]);

  return seconds;
};

const ThoughtSequence = ({
  logs, liveLogs = [], isThinking, isLast, hasAnswer, hasInteractionBoundary = false, stepCount, turnEndedAt, onOpenAgentTeam, isSubAgentTab = false, isAgentBuilder = false, groupIdx = 0, onEditUserMessage, subAgentAssetIndexes
}: { logs: any[], liveLogs?: any[], isThinking: boolean, isLast: boolean, hasAnswer: boolean, hasInteractionBoundary?: boolean, stepCount: number, turnEndedAt?: number | null, onOpenAgentTeam?: (agentName?: string) => void, isSubAgentTab?: boolean, isAgentBuilder?: boolean, groupIdx?: number, onEditUserMessage?: (text: string) => void, subAgentAssetIndexes?: Record<string, number> }) => {
  // Start collapsed for completed turns, open for active/no-answer turns
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const anchorFrameRef = React.useRef<number | null>(null);
  // Latch: once hasAnswer becomes true, never re-open on a transient false
  const hasAnswerLatchRef = React.useRef(false);
  // The trace stream is more precise than the briefly stale global running
  // flag. Scan the whole turn: terminal events are often followed by late
  // cleanup traces, and a final answer itself conclusively ends work timing.
  const turnLogs = React.useMemo(() => [...logs, ...liveLogs], [logs, liveLogs]);
  const isLiveThinking = React.useMemo(
    () => isTurnWorkActive(isThinking, hasAnswer, turnLogs),
    [hasAnswer, isThinking, turnLogs],
  );

  // Reset latch when this component's group index changes (new conversation turn)
  React.useEffect(() => {
    hasAnswerLatchRef.current = false;
  }, [groupIdx]);

  const setOpenPreservingViewport = React.useCallback((nextOpen: boolean) => {
    const collapsible = containerRef.current;
    const chatContainer = collapsible?.closest<HTMLElement>('.eterx-chat-feed-scroll') ?? null;
    const messageGroup = collapsible?.closest<HTMLElement>('.eterx-chat-message-group') ?? null;
    const chatRect = chatContainer?.getBoundingClientRect();
    const collapsibleRect = collapsible?.getBoundingClientRect();
    const anchor = chatRect && collapsibleRect && collapsibleRect.top < chatRect.top
      ? (collapsible?.nextElementSibling as HTMLElement | null) || (messageGroup?.nextElementSibling as HTMLElement | null)
      : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const scrollTopBefore = chatContainer?.scrollTop;

    setOpen(nextOpen);

    if (anchor && chatContainer && anchorTop !== undefined && scrollTopBefore !== undefined) {
      if (anchorFrameRef.current !== null) window.cancelAnimationFrame(anchorFrameRef.current);
      anchorFrameRef.current = window.requestAnimationFrame(() => {
        anchorFrameRef.current = null;
        if (!anchor.isConnected) return;
        const nextAnchorTop = anchor.getBoundingClientRect().top;
        chatContainer.scrollTop = scrollTopBefore + (nextAnchorTop - anchorTop);
      });
    }
  }, []);

  React.useEffect(() => () => {
    if (anchorFrameRef.current !== null) window.cancelAnimationFrame(anchorFrameRef.current);
  }, []);

  React.useEffect(() => {
    if (isLiveThinking) {
      setOpenPreservingViewport(true);
      return;
    }
    // Answer just arrived for the first time â€” collapse
    if (hasAnswer && !hasAnswerLatchRef.current) {
      setOpenPreservingViewport(false);
      hasAnswerLatchRef.current = true;
      return;
    }
    // Only re-open if we never had an answer (new turn without answer yet)
    if (!hasAnswer && !hasAnswerLatchRef.current) {
      setOpenPreservingViewport(true);
    }
  }, [hasAnswer, isLiveThinking, setOpenPreservingViewport]);

  const toggleOpen = () => {
    setOpenPreservingViewport(!open);
  };

  const isOpen = open;
  const hasRealActions = stepCount > 0;
  // A direct answer can still carry a provider-generated thought/work-note
  // trace. Once the answer is settled, that narrative is not user-visible
  // work and must not create a fake Working chip or duration summary.
  const isSettledNarrativeOnly = hasAnswer && !isLiveThinking && !hasRealActions;
  // Start the timer as soon as the turn is active. Waiting for the first
  // trace made the live pill appear late, then disappear/reappear as polling
  // swapped between an empty group and its first streamed event.
  const workElapsedSeconds = useWorkElapsedSeconds(isLiveThinking, turnLogs, turnEndedAt);
  const workElapsedLabel = formatWorkElapsed(workElapsedSeconds);

  if (isSettledNarrativeOnly || (!shouldShowWorkflowSequence(stepCount) && !isLiveThinking)) return null;

  const hasCounter = hasRealActions;
  const isCollapsedWithAnswer = hasAnswer && !isOpen;
  const isLiveWorkCounter = isLiveThinking;
  const hasTerminalBoundary = hasAnswer || hasInteractionBoundary || turnLogs.some(isTerminalWorkTrace);
  const showWorkedSummary = !isLiveThinking && hasRealActions && hasTerminalBoundary;
  const shouldStickCounter = hasAnswer || isLiveWorkCounter;
  const counterColor = 'var(--muted-foreground)';
  const counterBackground = 'var(--muted)';
  const counterHoverBackground = 'var(--secondary)';
  const counterOutline = 'var(--border)';
  const counterShadow = 'none';
  const compactCounterStyle: React.CSSProperties = {
    padding: '4px 8px 4px 6px', borderRadius: 13, border: 'none', background: counterBackground,
    outline: `1px solid ${ counterOutline }`, backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
    boxShadow: counterShadow, color: counterColor,
  };

  return (
    <div className="relative" ref={containerRef}>
      {showWorkedSummary && <div className="eterx-worked-summary mb-2 flex w-full items-center gap-4 pt-1"><div className="eterx-worked-summary-line h-px flex-1 bg-[var(--border)]" /><span className="eterx-worked-summary-label shrink-0 py-[1px] text-center text-[12px] font-medium leading-[1.35] tracking-normal text-[var(--muted-foreground)]"><span>Worked for&nbsp;</span><RollingTimeDisplay label={workElapsedLabel} /></span><div className="eterx-worked-summary-line h-px flex-1 bg-[var(--border)]" /></div>}
      {hasCounter && <div className={`eterx-process-summary-row ${ shouldStickCounter ? 'sticky top-3 z-20' : '' } ${ isCollapsedWithAnswer ? 'mb-2' : 'mb-1' } flex w-full items-center overflow-visible py-1.5`}>
        {isLiveWorkCounter ? <button type="button" onClick={toggleOpen} aria-expanded={isOpen} className="eterx-process-summary-chip eterx-process-summary-chip-live group inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] border border-[var(--border)] bg-[var(--muted)] px-3 text-[13px] font-medium leading-none tracking-[-0.01em] text-[var(--muted-foreground)] shadow-none backdrop-blur-[12px] transition-[background,border-color,color,box-shadow] duration-150 hover:border-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"><Shimmer active={false} className="eterx-process-summary-label inline-flex -translate-y-[0.5px] items-center gap-0 pb-[1px] leading-none" style={{ color: 'var(--eterx-ui-working-text)' }}><span>Working for&nbsp;</span><RollingTimeDisplay label={workElapsedLabel} /></Shimmer>{isOpen ? <ChevronDown className="h-3 w-3 -translate-y-[0.5px] opacity-50" /> : <ChevronRight className="h-3 w-3 -translate-y-[0.5px] opacity-50" />}</button> : <button type="button" onClick={toggleOpen} aria-expanded={isOpen} className="eterx-process-summary-chip inline-flex h-[30px] items-center gap-1.5 transition-all duration-200" style={{ ...compactCounterStyle, cursor: 'pointer', position: 'relative', zIndex: 1 }} onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--foreground)'; (e.currentTarget as HTMLElement).style.background = counterHoverBackground; }} onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = counterColor; (e.currentTarget as HTMLElement).style.background = counterBackground; }}><span className="eterx-process-summary-icon" style={{ display: 'inline-flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 8, color: 'inherit', background: 'var(--border)', outline: '1px solid var(--border)' }}><StepCounterIcon live={isLiveThinking} /></span><Shimmer active={isLiveThinking} className="eterx-process-summary-label" style={{ fontSize: 13, fontWeight: 650, letterSpacing: 0, lineHeight: 1 } as any}>{stepCount > 0 ? <><span className="eterx-professional-number">{stepCount}</span> action{stepCount !== 1 ? 's' : ''}</> : 'Working'}</Shimmer>{isOpen ? <ChevronDown style={{ width: 9, height: 9, flexShrink: 0, opacity: 0.6 }} /> : <ChevronRight style={{ width: 9, height: 9, flexShrink: 0, opacity: 0.6 }} />}</button>}
      </div>}

      {isOpen && (
        <div className="mb-1 overflow-hidden">
          <ThinkingProcess
            logs={logs}
            liveLogs={liveLogs}
            isThinking={isLiveThinking}
            isLast={isLast}
            showLiveIndicator={isLiveThinking && isLast}
            onOpenAgentTeam={onOpenAgentTeam}
            assetIndexes={subAgentAssetIndexes}
            isSubAgentTab={isSubAgentTab}
            isAgentBuilder={isAgentBuilder}
            onEditUserMessage={onEditUserMessage}
          />
        </div>
      )}
    </div>
  );
};

const RENDER_RELEVANT_LOG_FIELDS = [
  'id', '_traceIdx', 'type', 'text', 'secondary', 'output', 'content',
  'timestamp', 'startTime', 'endTime', 'isStreaming', 'isLiveTyping',
  'wasStreaming', 'isLive', 'answerId', 'spokenText', 'noteId', 'thoughtId',
  'subAgent', 'subAgentId', 'subAgentChatId', 'agentName', 'status', 'progress', 'error',
  'question', 'mode', 'options', 'questions', 'context', 'defaultValue',
  'urgent', 'responseKey', 'answeredWith', 'answeredAt', 'attachments',
  'filename', 'fileName', 'filepath', 'filePath', 'path', 'preview',
  'lineCount', 'totalLines', 'truncated', 'command', 'result', 'toolName',
  'toolCallId', 'action', 'occurrenceCount', 'spawnedAgents', 'agentDetails',
  'agentStatus', 'agentStep', 'currentAction', 'stepCount', 'durationMs', 'task',
  'taskSummary', 'traceId', 'ownerTraceId', 'isDelta', 'dedupe', 'args', 'cmd',
  'tool', 'toolArgs', 'toolResult', 'fileOperationResult', 'exitCode', 'errorType', 'streamId', 'taskId', 'backgroundTaskId',
  'file', 'files', 'fileCount', 'filesCount', 'targetPath', 'contentPreview',
  'startLine', 'endLine', 'loadedLines', 'added', 'removed', 'additions',
  'deletions', 'insertions', 'linesAdded', 'linesRemoved', 'diffLines',
  'name', 'title', 'subject', 'body', 'from', 'to', 'priority', 'commType',
  'message', 'detail', 'messageType', 'deliveryMode', 'deliverAfter', 'scheduled', 'updatedAt',
  'senderSubAgentId', 'senderSubAgentChatId', 'recipientAgentId', 'recipientSubAgentChatId',
  'broadcast', 'broadcastRecipientRuns', 'unreadCount', '_teamPollSignature',
  'icon', 'iconCategory', 'size', '_autonomyProxy', '_streamingCancelled',
  '_autonomyCheckpoint', '_autonomyBoundaryFollowUp', '_connection', 'model', 'modelName',
  'phase', 'compactionId', 'beforeTokens', 'afterTokens', 'contextWindow', 'modelProvider',
  'provider', 'source', 'promptTokens', 'inputTokens', 'completionTokens', 'outputTokens',
  'totalTokens', 'cachedTokens', 'uncachedPromptTokens', 'cacheHitRatio',
  'reasoningTokens', 'toolUsePromptTokens', 'interaction', 'usageId', 'runId', 'turnId', 'uiOnly',
] as const;

const haveSameNestedValue = (left: unknown, right: unknown) => {
  if (left === right) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const haveSameRenderedLog = (left: any, right: any) => {
  if (left === right) return true;
  if (!left || !right) return false;
  for (const field of RENDER_RELEVANT_LOG_FIELDS) {
    if (!haveSameNestedValue(left[field], right[field])) return false;
  }
  return true;
};

const ChatFeedMessageGroup = React.memo(({
  group,
  groupIdx,
  isThinkingTurn,
  isLiveSessionActive,
  suppressInitialReveal,
  isCompressed,
  onOpenAgentTeam,
  subAgentAssetIndexes,
  onAnswerAskUser,
  onEditUserMessage,
  isSubAgentTab,
  isAgentBuilder,
  setPreviewUserMessage,
  showTokenCount,
}: {
  group: any[];
  groupIdx: number;
  isThinkingTurn: boolean;
  isLiveSessionActive: boolean;
  suppressInitialReveal: boolean;
  isCompressed: boolean;
  onOpenAgentTeam?: (agentName?: string) => void;
  subAgentAssetIndexes?: Record<string, number>;
  onAnswerAskUser?: (timestamp: number, answer: string, responseKey?: string) => void;
  onEditUserMessage?: (text: string) => void;
  isSubAgentTab: boolean;
  isAgentBuilder: boolean;
  setPreviewUserMessage: (msg: { text: string; index: number } | null) => void;
  showTokenCount: boolean;
}) => {
  // Retain only a fuller snapshot of an answer that is still present. An
  // explicit cancellation or turn replacement must be able to clear it.
  const lastKnownAnswerRef = React.useRef<any>(null);
  // Reset latch when a genuinely new group mounts (groupIdx changes means a new turn)
  const lastGroupIdxRef = React.useRef(groupIdx);
  if (lastGroupIdxRef.current !== groupIdx) {
    lastGroupIdxRef.current = groupIdx;
    lastKnownAnswerRef.current = null;
  }
  const first = group[0];
  if (first?.type === 'user_action') {
    const userText = String(first.text || '');
    const { isLong } = getUserQueryPreview(userText);
    const delegatedSource = first.source === 'proxy_manager'
      ? 'Side Proxy-Agent'
      : first.source === 'user_proxy'
        ? 'Proxy-Agent'
        : first.source && first.source !== 'human' && first.source !== 'user'
          ? String(first.delegatedBy || 'Agent request')
          : '';
    return (
      <div data-chat-group-index={groupIdx} className="eterx-chat-message-group mt-8 mb-3 flex w-full scroll-m-20 justify-end group/user">
        <div className="flex w-full justify-end">
          <div data-delegated={delegatedSource ? 'true' : undefined} className={`eterx-user-message-bubble eterx-chat-feed-user-bubble flex min-w-0 flex-col items-end rounded-[22px] ${ delegatedSource ? 'bg-[#1B1B1B]' : 'bg-[#1F1F1F]' } px-4 py-2.5 text-[13.5px] leading-[1.5] text-[#F4F2EE] selection:bg-[#D98B6A]/25 relative whitespace-pre-wrap select-text shadow-none ${ isCompressed ? 'max-w-[92%]' : 'max-w-[520px]' }`}>
            <UserMessageActions text={userText} onEdit={onEditUserMessage} timestamp={first.timestamp} />

            {delegatedSource && (
              <div className="eterx-delegated-source-header mb-1.5 w-full border-b border-white/[0.09] pb-1.5 text-left text-[11px] font-medium tracking-[0.01em] text-white/55">
                {delegatedSource}
              </div>
            )}

            {first.attachments && first.attachments.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2.5 mb-3 w-full">
                {first.attachments.map((att: any, i: number) => {
                  const mimeType = String(att.mimeType || att.file?.type || '').toLowerCase();
                  const fileName = att.name || att.file?.name || 'file';
                  const extension = fileName.split('.').pop()?.toUpperCase() || 'FILE';
                  const isImage = mimeType.startsWith('image/') || ['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'AVIF'].includes(extension);
                  const isVideo = mimeType.startsWith('video/') || ['MP4', 'WEBM', 'MOV', 'M4V'].includes(extension);
                  const previewUrl = att.preview || (att.localPath || att.path ? buildFilePreviewUrl(att.localPath || att.path) : '');
                  const isPdf = extension === 'PDF';
                  const isDocPreviewable = extension === 'PDF' || extension === 'DOCX';

                  if (isImage || isVideo) {
                    return (
                      <button
                        type="button"
                        key={att.id || i}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (previewUrl) {
                            window.dispatchEvent(new CustomEvent(isVideo ? 'eterx-preview-media' : 'eterx-preview-image', { detail: { previewUrl, kind: isVideo ? 'video' : 'image', fileName } }));
                          }
                        }}
                        className="relative group h-[72px] w-[72px] shrink-0 cursor-pointer rounded-[14px] border border-white/[0.06] shadow-none transition-colors hover:border-white/[0.10] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                        aria-label={`Preview ${ fileName }`}
                      >
                        {isVideo ? (
                          <video src={previewUrl} muted playsInline preload="metadata" className="h-full w-full rounded-[14px] object-cover opacity-90" />
                        ) : (
                          <img src={previewUrl} alt={fileName} className="w-full h-full object-cover rounded-[14px] transition-opacity hover:opacity-90" />
                        )}
                        {isVideo && <span className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-white/80">Video</span>}
                      </button>
                    );
                  }

                  return (
                    <button
                      type="button"
                      key={att.id || i}
                      disabled={!isDocPreviewable}
                      onClick={() => {
                        if (isDocPreviewable) {
                          const targetPath = att.localPath || att.path || att.name;
                          window.dispatchEvent(new CustomEvent('eterx-preview-document', { detail: { filePath: targetPath } }));
                        }
                      }}
                      className={`flex h-[72px] w-[72px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-[14px] border border-white/[0.055] bg-white/[0.024] shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 ${ isDocPreviewable ? 'cursor-pointer transition-all hover:border-white/[0.10] hover:bg-white/[0.045]' : 'cursor-default' }`}
                      aria-label={isDocPreviewable ? `Preview ${ fileName }` : fileName}
                    >
                      <div className={`w-[26px] h-[26px] rounded-[7px] flex items-center justify-center shrink-0 ${ isPdf ? 'bg-[#C65D58]' : extension === 'DOCX' ? 'bg-[#2A6B9C]' : 'bg-[#596B7B]' }`}>
                        <FileText className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
                      </div>
                      <span className="text-[10px] font-medium text-[#C8C1B8] truncate max-w-[90%] px-1">{att.name || fileName}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="min-w-0 max-w-full w-full text-left">
              <FadeScrollContainer maxHeightClass={isLong ? 'max-h-[230px]' : ''}>
                <span className="block min-w-0 max-w-full w-full text-left break-words [word-break:break-word] [overflow-wrap:anywhere]">{userText}</span>
              </FadeScrollContainer>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const answerTokenCount = (() => {
    const seen = new Set<string>();
    return group.reduce((total: number, log: any) => {
      if (log?.type !== 'model_usage') return total;
      const tokenTotal = Number(log.totalTokens ?? log.total_tokens ?? 0);
      if (!Number.isFinite(tokenTotal) || tokenTotal <= 0) return total;
      const key = String(log.usageId || log._traceIdx || `${log.runId || log.turnId || ''}:${log.provider || ''}:${log.model || ''}:${log.interaction ?? ''}:${log.timestamp || ''}:${tokenTotal}`);
      if (seen.has(key)) return total;
      seen.add(key);
      return total + tokenTotal;
    }, 0);
  })();

  // Bug 9: Empty groups (appended for live thinking indicator) must not
  // render a blank mb-8 div when the group truly has no content yet.
  if (group.length === 0 && !isThinkingTurn) return null;

  // Every workflow action uses the same live-to-settled reconciliation path.
  // Treating only commands as live made file/browser/progress updates appear
  // as new rows or mutate the first semantically similar action.
  const liveActionLogs = group.filter(isLiveWorkflowLog);
  const rawStandardLogs = group.filter((l: any) =>
    !isLiveWorkflowLog(l) &&
    shouldRenderProgressTrace(l) &&
    !isPrivateReasoningTrace(l) &&
    !(l.type === 'thought' && !isInternalStatusThought(l)) &&
    !isHiddenStatusOnlyLog(l)
  );
  const standardLogs = rawStandardLogs.map((rawLog: any, index: number) => {
    const log = rawLog.type === 'thought' && !isInternalStatusThought(rawLog)
      ? { ...rawLog, type: 'thought_stream', isStreaming: false, streamState: 'closed' }
      : rawLog.type === 'tool_call'
        ? {
          ...rawLog,
          type: 'command',
          text: String(rawLog.text || rawLog.action || rawLog.toolName || rawLog.tool || rawLog.name || 'Tool call'),
        }
        : rawLog;
    const turnIsActive = isThinkingTurn || isLiveSessionActive;
    const isProvisionalAnswer =
      log.type === 'answer' &&
      !log.isLive &&
      turnIsActive &&
      (
        log.isStreaming === true ||
        log.isLiveTyping === true ||
        log._autonomyCheckpoint === true
      );
    const hasLaterWorkflowActivity = rawStandardLogs.slice(index + 1).some((later: any) =>
      later.type === 'work_note' ||
      (WORKFLOW_COUNT_TYPES.has(later.type) && !HIDDEN_HELPER_TYPES.has(later.type) && shouldRenderProgressTrace(later))
    );
    const shouldStayInWorkSequence =
      isProvisionalAnswer ||
      (
        (log.isStreaming === true || log.isLiveTyping === true) &&
        hasLaterWorkflowActivity
      );
    if (
      log.type !== 'answer' ||
      !shouldStayInWorkSequence
    ) {
      return log;
    }

    // A streamed response is provisional until the provider confirms that
    // the response boundary has no tool calls or continuation. Keep it in the
    // chronological work sequence so it cannot stop the timer, collapse the
    // actions, or appear as a final answer between two real tool events.
    return {
      ...log,
      type: 'work_note',
      noteId: log.noteId || log.answerId || `recovered_work_note_${ index }`,
      isStreaming: false,
      isLiveTyping: false,
    };
  });
  const latestAgentStatusLog = [...standardLogs].reverse().find(isInternalStatusThought);
  const agentRunNotice = latestAgentStatusLog ? getAgentRunNotice(latestAgentStatusLog) : null;

  let processLogs: any[] = [];
  let finalAnswer: any = null;
  let tailLogs: any[] = [];

  let firstAnswerIdx = -1;
  let lastAnswerIdx = -1;
  for (let i = 0; i < standardLogs.length; i++) {
    if (standardLogs[i].type === 'answer' && String(standardLogs[i].text || '').trim()) {
      if (firstAnswerIdx === -1) firstAnswerIdx = i;
      lastAnswerIdx = i;
    }
  }
  if (firstAnswerIdx >= 0) {
    const lastIdx = lastAnswerIdx;
    processLogs = standardLogs.slice(0, lastIdx).filter((l: any) => l.type !== 'answer');
    const lastAnswerLog = standardLogs[lastIdx];

    const answerText = lastAnswerLog?.text || '';

    finalAnswer = {
      type: 'answer',
      text: answerText,
      isLive: lastAnswerLog?.isLive || false,
      isLiveTyping: lastAnswerLog?.isLiveTyping || false,
      isStreaming: lastAnswerLog?.isStreaming || false,
      wasStreaming: lastAnswerLog?.wasStreaming || false,
      answerId: lastAnswerLog?.answerId,
      spokenText: lastAnswerLog?.spokenText || '',
      timestamp: lastAnswerLog?.timestamp,
      startTime: lastAnswerLog?.startTime,
      endTime: lastAnswerLog?.endTime
    };
    tailLogs = standardLogs.slice(lastIdx + 1).filter((l: any) => l.type !== 'answer');
  } else {
    // No answer log yet â€” keep all logs in processLogs, no final answer bubble
    processLogs = standardLogs;
    finalAnswer = null;
    tailLogs = [];
  }

  const displayProcessLogs = processLogs;
  // ANSWER LATCH â€” never let a transient polling race blank the answer bubble.
  // Rules:
  //   1. If finalAnswer is non-null, always save it (update ref).
  //   2. If finalAnswer is null but we have a cached answer, keep the cached one.
  //   3. If finalAnswer is non-null but shorter than the cached one AND we're still
  //      actively thinking, keep the cached (longer) version â€” the shorter frame is
  //      a transient mid-stream snapshot.
  if (finalAnswer !== null) {
    const cached = lastKnownAnswerRef.current;
    const newText = finalAnswer.text || '';
    const cachedText = cached?.text || '';
    const sameAnswer = Boolean(
      cached &&
      (
        (cached.answerId && finalAnswer.answerId && cached.answerId === finalAnswer.answerId) ||
        (!cached.answerId && !finalAnswer.answerId)
      )
    );
    if (!sameAnswer || !isThinkingTurn || newText.length >= cachedText.length) {
      lastKnownAnswerRef.current = finalAnswer;
    }
  } else if (!isThinkingTurn && !isLiveSessionActive) {
    lastKnownAnswerRef.current = null;
  }
  const displayFinalAnswer = finalAnswer ??
    ((isThinkingTurn || isLiveSessionActive) ? lastKnownAnswerRef.current : null);
  // Only a real active stream may animate token-by-token. A settled answer can
  // be delivered again by polling or history restoration, but must render once
  // without replaying its entrance animation.
  const isAnswerActivelyTyping = Boolean(
    (isThinkingTurn || isLiveSessionActive) &&
    (displayFinalAnswer?.isLiveTyping || displayFinalAnswer?.isStreaming)
  );
  const shouldAnimateAnswerReveal = isAnswerActivelyTyping && !suppressInitialReveal;
  const hasSettledAnswer = Boolean(
    displayFinalAnswer &&
    !displayFinalAnswer.isLiveTyping &&
    !displayFinalAnswer.isStreaming
  );

  // Stable deduplication set for work notes â€” keyed on noteId or content
  const seenWorkNoteKeys = new Set<string>();
  // Status/interruptions have their own professional notice. Keeping them in
  // the thinking timeline creates an empty "Thinking" pill because plain
  // internal status thoughts are not actionable timeline rows.
  const rawWorkLogs = [...displayProcessLogs, ...tailLogs].filter(log =>
    !isInternalStatusThought(log) &&
    shouldRenderProgressTrace(log) &&
    !isPrivateReasoningTrace(log) &&
    !(
      log?.type === 'work_note' &&
      /^direct_(?:thinking|search)_/i.test(String(log.noteId || ''))
    ) &&
    RENDERABLE_TIMELINE_TYPES.has(String(log?.type || '')) &&
    (log?.type !== 'thought_stream' || shouldRenderThoughtStream(log))
  );
  const isAskUserInteractionLog = (log: any) =>
    log?.type === 'ask_user' &&
    typeof log.question === 'string' &&
    log.question.trim().length > 0 &&
    Number.isFinite(Number(log.timestamp));
  const askUserKey = (log: any) => {
    const responseKey = String(log?.responseKey || '').trim();
    if (responseKey) return responseKey;
    return `question:${ String(log?.question || '').trim().toLowerCase() }`;
  };
  const hasAskUserInteractionLog = rawWorkLogs.some(isAskUserInteractionLog);
  const preferredAskUserLogs = new Map<string, any>();
  rawWorkLogs.forEach((log: any) => {
    if (!isAskUserInteractionLog(log)) return;
    const key = askUserKey(log);
    const existing = preferredAskUserLogs.get(key);
    const existingAnswered = Boolean(existing?.answeredWith);
    const nextAnswered = Boolean(log?.answeredWith);
    const existingTime = Number(existing?.answeredAt || existing?.timestamp || 0);
    const nextTime = Number(log?.answeredAt || log?.timestamp || 0);
    if (!existing || (nextAnswered && !existingAnswered) || (nextAnswered === existingAnswered && nextTime >= existingTime)) {
      preferredAskUserLogs.set(key, log);
    }
  });
  const interactionFilteredWorkLogs = hasAskUserInteractionLog
    ? rawWorkLogs.filter((log: any) => {
      if (log.type !== 'ask_user') return true;
      if (!isAskUserInteractionLog(log)) return false;
      return preferredAskUserLogs.get(askUserKey(log)) === log;
    })
    : rawWorkLogs;
  const visibleWorkLogs = interactionFilteredWorkLogs.filter((log: any, index: number, logs: any[]) =>
    shouldRenderContextCompactionEvent(log, index, logs, isThinkingTurn)
  );
  const segments: { type: 'thoughts' | 'steering' | 'ask_user' | 'context'; logs?: any[]; log?: any }[] = [];
  let currentThoughts: any[] = [];
  const segmentIdentity = (seg: { logs?: any[]; log?: any }, fallback: number) => {
    const anchor = seg.log || seg.logs?.[0];
    const primary = String(
      anchor?.thoughtId ||
      anchor?.noteId ||
      anchor?.responseKey ||
      anchor?.steeringId ||
      anchor?.id ||
      ''
    ).trim();
    const timeAnchor = anchor?.startTime ?? anchor?.timestamp ?? anchor?._traceIdx ?? fallback;
    return primary ? `${ primary }:${ String(timeAnchor) }` : String(timeAnchor);
  };

  visibleWorkLogs.forEach(log => {
    if (log.type === 'context_compaction') {
      if (currentThoughts.length > 0) {
        segments.push({ type: 'thoughts', logs: currentThoughts });
        currentThoughts = [];
      }
      segments.push({ type: 'context', log });
    } else if (log.type === 'steering_received') {
      if (currentThoughts.length > 0) {
        segments.push({ type: 'thoughts', logs: currentThoughts });
        currentThoughts = [];
      }
      segments.push({ type: 'steering', log });
    } else if (isAskUserInteractionLog(log)) {
      if (currentThoughts.length > 0) {
        segments.push({ type: 'thoughts', logs: currentThoughts });
        currentThoughts = [];
      }
      segments.push({ type: 'ask_user', log });
    } else {
      let isValid = true;
      if (['progress', 'command', 'exploration'].includes(log.type) && /analyz(?:e|ing) task complexity/i.test(String(log.text || ''))) isValid = false;

      if (log.type === 'thought_stream') {
        if (displayFinalAnswer && isLikelyAnswerEcho(log.text, displayFinalAnswer.text)) isValid = false;
        if (displayFinalAnswer && isValid) {
          const thoughtEndTime = Number(log.endTime ?? log.timestamp ?? 0);
          const answerStartTime = Number(displayFinalAnswer.startTime ?? displayFinalAnswer.timestamp ?? 0);
          if (thoughtEndTime > 0 && answerStartTime > 0 && thoughtEndTime >= answerStartTime) isValid = false;
        }
      }
      if (log.type === 'work_note') {
        const text = String(log.text || '').trim().toLowerCase();
        if (!text) isValid = false;
        else if (isInternalWorkNoteNoise(log.text)) isValid = false;
        else if (displayFinalAnswer && isLikelyAnswerEcho(log.text, displayFinalAnswer.text)) isValid = false;
        else {
          // Work-note ids are regenerated by some live runtimes. The visible
          // content and owning agent form the stable UI identity, so repeated
          // delivery cannot create duplicate "Working" notes.
      const key = `${ log.runId || log.turnId || '' }::${ log.subAgentChatId || log.subAgentId || log.subAgent || log.agentName || '' }::${ text }`;
          if (seenWorkNoteKeys.has(key)) isValid = false;
          else seenWorkNoteKeys.add(key);
        }
      }

      if (isValid) {
        currentThoughts.push(log);
      }
    }
  });

  const groupIsThinking = isTurnWorkActive(
    // The live transport can remain active for a short interval while the
    // primary thinking flag catches up. Treat either signal as authoritative
    // so the work indicator does not blink during that handoff.
    isThinkingTurn || isLiveSessionActive,
    hasSettledAnswer,
    [...standardLogs, ...liveActionLogs],
  );

  if (currentThoughts.length > 0 || groupIsThinking) {
    segments.push({ type: 'thoughts', logs: currentThoughts });
  }

  // Helper-only groups (done markers, raw tool results, retry bookkeeping,
  // cancelled placeholders) have no visual row. Do not leave an empty
  // assistant container and its margin in the primary transcript.
  if (segments.length === 0 && !agentRunNotice && !displayFinalAnswer) {
    return null;
  }

  return (
    <div
      data-chat-group-index={groupIdx}
      data-live={groupIsThinking ? 'true' : undefined}
      className="eterx-chat-message-group w-full flex flex-col mb-8 scroll-m-20 relative"
    >
      {segments.map((seg, segIdx) => {
        if (seg.type === 'context') {
          return <ContextCompactionNotice key={`context-${groupIdx}-${segmentIdentity(seg, segIdx)}`} log={seg.log} />;
        }
        if (seg.type === 'steering') {
          return <SteeringFeedCard key={`steer-${ groupIdx }-${ segmentIdentity(seg, segIdx) }`} log={seg.log} isCompressed={isCompressed} onEdit={onEditUserMessage} />;
        }
        if (seg.type === 'ask_user') {
          return (
            <AskUserPrompt
              key={`ask-${ groupIdx }-${ segmentIdentity(seg, segIdx) }`}
              question={seg.log.question}
              mode={seg.log.mode || 'text'}
              options={seg.log.options || []}
              questions={Array.isArray(seg.log.questions) ? seg.log.questions : undefined}
              context={seg.log.context}
              defaultValue={seg.log.defaultValue}
              urgent={seg.log.urgent}
              timestamp={seg.log.timestamp}
              responseKey={seg.log.responseKey}
              answeredWith={seg.log.answeredWith}
              onAnswer={(answer) => {
                onAnswerAskUser?.(seg.log.timestamp, answer, seg.log.responseKey);
              }}
            />
          );
        }

        const isLastThoughts = segIdx === segments.length - 1 || segments.slice(segIdx + 1).every(s => s.type !== 'thoughts');
        const hasInteractionBoundary = segments.slice(segIdx + 1).some(s => s.type === 'steering' || s.type === 'ask_user');
        const stepCount = countVisibleWorkflowActions([
          ...(seg.logs || []),
          ...(isLastThoughts ? liveActionLogs : []),
        ]);

        // A settled or streaming direct answer may have a provider narration
        // row but no actual workflow action. Keep that answer on the normal
        // answer surface instead of manufacturing a thought-sequence card.
        if (displayFinalAnswer && stepCount === 0) return null;
        if (stepCount === 0 && (seg.logs || []).length === 0 && !(groupIsThinking && isLastThoughts)) return null;

        return (
          <ThoughtSequence
            key={`thoughts-${ groupIdx }-${ segmentIdentity(seg, segIdx) }`}
            logs={seg.logs || []}
            liveLogs={isLastThoughts ? liveActionLogs : []}
            isThinking={groupIsThinking && isLastThoughts}
            isLast={isLastThoughts}
            hasAnswer={hasSettledAnswer && isLastThoughts}
            hasInteractionBoundary={hasInteractionBoundary}
            stepCount={stepCount}
            turnEndedAt={hasSettledAnswer ? displayFinalAnswer?.endTime ?? displayFinalAnswer?.timestamp ?? null : null}
            onOpenAgentTeam={onOpenAgentTeam}
            subAgentAssetIndexes={subAgentAssetIndexes}
            isSubAgentTab={isSubAgentTab}
            isAgentBuilder={isAgentBuilder}
            groupIdx={groupIdx}
            onEditUserMessage={onEditUserMessage}
          />
        );
      })}

      {agentRunNotice && <AgentRunStatusNotice notice={agentRunNotice} />}

      {displayFinalAnswer && (
        <div className="eterx-assistant-answer w-full group/assistant mt-0 [&_.professional-thought>*:first-child]:!mt-0">

          <div className="relative group/thought">
            <div className={`eterx-assistant-answer-body ${ isAnswerActivelyTyping ? 'eterx-assistant-live-text' : '' } text-[13.5px] leading-[1.56] text-[#F2F0EC] font-sans relative`}>
              <ProfessionalThought
                text={displayFinalAnswer.text}
                // A completed answer must stay in the answer surface even if
                // a late trace event keeps the turn marked as active. Using
                // the turn flag here made direct answers look like thoughts
                // and incorrectly showed the thinking treatment around
                // citations and other answer markdown.
                isLatest={shouldAnimateAnswerReveal}
                isThinking={shouldAnimateAnswerReveal}
                variant="answer"
                updatedAt={shouldAnimateAnswerReveal ? displayFinalAnswer.timestamp : undefined}
                reveal={shouldAnimateAnswerReveal}
                suffix={!isAnswerActivelyTyping ? (
                  <div className="inline-flex items-center gap-1.5 ml-2 align-middle mt-[-2px]">
                    <div className="flex items-center gap-0 opacity-0 group-hover/thought:opacity-100 transition-opacity duration-200">
                      <NakedCopyButton content={displayFinalAnswer.text} />
                      {onEditUserMessage && (
                        <Tooltip text="Import to chat">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onEditUserMessage(displayFinalAnswer.text);
                            }}
                            className="rounded-[8px] p-[6px] text-[#746F67] transition-colors hover:bg-white/[0.045] hover:text-[#DAD4CA]"
                            aria-label="Import answer to chat"
                          >
                            <MessageSquarePlus className="w-[15px] h-[15px]" />
                          </button>
                        </Tooltip>
                      )}
                      {formatShortTime(displayFinalAnswer.endTime ?? displayFinalAnswer.timestamp) && (
                        <span className="eterx-chat-message-time eterx-professional-number ml-1 text-[11px] font-[550] leading-none tracking-[-0.015em] text-[#746F67] select-none whitespace-nowrap">
                          {formatShortTime(displayFinalAnswer.endTime ?? displayFinalAnswer.timestamp)}
                        </span>
                      )}
                      {showTokenCount && answerTokenCount > 0 && (
                        <span className="eterx-professional-number ml-1.5 text-[11px] font-medium leading-none text-[#746F67] select-none whitespace-nowrap" title="Provider-reported processed tokens across this run; cached prompt tokens are included in the processed total.">
                          {formatProviderTokenCount(answerTokenCount)} processed tokens
                        </span>
                      )}
                    </div>
                  </div>
                ) : undefined}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, (previous, next) => {
  if (previous.groupIdx !== next.groupIdx) return false;
  if (previous.isThinkingTurn !== next.isThinkingTurn) return false;
  if (previous.isLiveSessionActive !== next.isLiveSessionActive) return false;
  if (previous.suppressInitialReveal !== next.suppressInitialReveal) return false;
  if (previous.isCompressed !== next.isCompressed) return false;
  if (previous.isSubAgentTab !== next.isSubAgentTab) return false;
  if (previous.isAgentBuilder !== next.isAgentBuilder) return false;
  if (previous.showTokenCount !== next.showTokenCount) return false;
  if (previous.onOpenAgentTeam !== next.onOpenAgentTeam) return false;
  if (previous.subAgentAssetIndexes !== next.subAgentAssetIndexes) return false;
  if (previous.onAnswerAskUser !== next.onAnswerAskUser) return false;
  if (previous.onEditUserMessage !== next.onEditUserMessage) return false;
  if (previous.setPreviewUserMessage !== next.setPreviewUserMessage) return false;
  if (previous.group === next.group) return true;
  if (previous.group.length !== next.group.length) return false;

  for (let index = 0; index < previous.group.length; index += 1) {
    if (!haveSameRenderedLog(previous.group[index], next.group[index])) return false;
  }
  return true;
});

const getGroupDateKey = (group: any[]): string => {
  for (const log of group) {
    const raw = log?.timestamp ?? log?.startTime ?? log?.endTime;
    const ts = normalizeWorkTimestamp(raw);
    if (ts !== null) {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  return '';
};

const formatDateLabel = (dateKey: string): string => {
  if (!dateKey) return '';
  const [year, month, day] = dateKey.split('-').map(Number);
  const messageDate = new Date(year, month - 1, day);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  if (dateKey === todayKey) return 'Today';
  if (dateKey === yesterdayKey) return 'Yesterday';
  const isThisYear = messageDate.getFullYear() === today.getFullYear();
  return messageDate.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(isThisYear ? {} : { year: 'numeric' }),
  });
};

const ChatDateDivider = React.memo(({ label }: { label: string }) => (
  <div
    aria-label={label}
    className="eterx-date-divider flex w-full items-center gap-3 py-2 my-1 select-none"
  >
    <span className="h-px flex-1 bg-gradient-to-r from-transparent to-[var(--border)] opacity-40" />
    <span className="shrink-0 text-[11px] font-medium tracking-[0.02em] text-[var(--muted-foreground)] opacity-60 leading-none">
      {label}
    </span>
    <span className="h-px flex-1 bg-gradient-to-l from-transparent to-[var(--border)] opacity-40" />
  </div>
));

export const ChatFeed = React.memo<ChatFeedProps>(({
  traceLogs: incomingTraceLogs, chatId, isThinking, messagesEndRef, setSidebarOpen, sidebarOpen, handleScroll: externalHandleScroll, showScrollBottom, isCompressed = false, onOpenAgentTeam, subAgentAssetIndexes, isFeedActivityPaused = false, onAnswerAskUser, onEditUserMessage, isSubAgentTab = false, liveState
}) => {
  const isAgentBuilderFeed = String(chatId || '').startsWith('agent_builder_');
  // Final presentation boundary: a trace carrying an owner ID can only render
  // inside that exact chat. This protects the feed even if an upstream async
  // state update arrives during navigation.
  const traceLogs = useMemo(
    () => normalizeInternalUserActionLogs(
      (Array.isArray(incomingTraceLogs) ? incomingTraceLogs : [])
        .filter(log => {
          const owners = [log?.chatId, log?.ownerChatId]
            .map(value => String(value || '').trim())
            .filter(Boolean);
          return owners.length === 0 || owners.includes(String(chatId || '').trim());
        }),
    ),
    [chatId, incomingTraceLogs]
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const navContainerRef = useRef<HTMLDivElement>(null);
  const previewCloseButtonRef = useRef<HTMLButtonElement>(null);
  const previewRestoreFocusRef = useRef<HTMLElement | null>(null);
  const previewTitleId = React.useId();
  const [showTokenCount, setShowTokenCount] = useState(false);

  useEffect(() => {
    const refreshTokenCountPreference = () => {
      try {
        const saved = JSON.parse(appStorage.getItem('eterx_settings') || '{}');
        setShowTokenCount(saved?.showTokenCount === true);
      } catch {
        setShowTokenCount(false);
      }
    };
    refreshTokenCountPreference();
    void appStorageReady.then(refreshTokenCountPreference);
    window.addEventListener('eterx-settings-updated', refreshTokenCountPreference);
    window.addEventListener('eterx-folder-storage-updated', refreshTokenCountPreference);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, refreshTokenCountPreference);
    return () => {
      window.removeEventListener('eterx-settings-updated', refreshTokenCountPreference);
      window.removeEventListener('eterx-folder-storage-updated', refreshTokenCountPreference);
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, refreshTokenCountPreference);
    };
  }, []);

  // Keep the presentation state alive through the short handoff between the
  // renderer's running flag, transport state, and the next trace batch. A
  // query should not lose its status pill just because those signals commit
  // on adjacent render frames.
  const activeFeedTurnLogs = useMemo(() => {
    let latestUserIndex = -1;
    for (let index = traceLogs.length - 1; index >= 0; index -= 1) {
      if (traceLogs[index]?.type === 'user_action') {
        latestUserIndex = index;
        break;
      }
    }
    return traceLogs.slice(latestUserIndex >= 0 ? latestUserIndex : 0);
  }, [traceLogs]);
  const activeFeedRunLogs = useMemo(() => {
    const latestRunId = [...activeFeedTurnLogs]
      .reverse()
      .map(log => String(log?.runId || log?.turnId || '').trim())
      .find(Boolean);
    if (!latestRunId) return activeFeedTurnLogs;
    return activeFeedTurnLogs.filter(log => {
      const runId = String(log?.runId || log?.turnId || '').trim();
      return !runId || runId === latestRunId;
    });
  }, [activeFeedTurnLogs]);
  const activeTurnHasTerminalTrace = useMemo(
    () => activeFeedRunLogs.some(isTerminalWorkTrace),
    [activeFeedRunLogs],
  );
  const activeTurnHasSettledAnswer = useMemo(
    () => activeFeedRunLogs.some(log =>
      log?.type === 'answer' &&
      String(log.text || '').trim().length > 0 &&
      log.isStreaming !== true &&
      log.isLiveTyping !== true
    ),
    [activeFeedRunLogs],
  );
  const liveTransportActive = !isSubAgentTab && !isFeedActivityPaused &&
    liveState !== undefined && liveState !== 'idle' && liveState !== 'error';
  const transportWorkActive = !isFeedActivityPaused && Boolean(isThinking || liveTransportActive);
  const workActivityLatchRef = useRef(false);
  if (activeTurnHasTerminalTrace || activeTurnHasSettledAnswer || isFeedActivityPaused) {
    workActivityLatchRef.current = false;
  } else if (transportWorkActive) {
    workActivityLatchRef.current = true;
  }
  const feedWorkActive = !activeTurnHasTerminalTrace &&
    !activeTurnHasSettledAnswer &&
    (transportWorkActive || workActivityLatchRef.current);

  const groups = useMemo(() => {
    const nextGroups: any[][] = [];
    let currentGroup: any[] = [];
    let currentTurnIdentity = '';
    const assistantGroupsByTurn = new Map<string, any[]>();
    let hasUserBoundary = false;
    const normalizedLogs = orderFeedTimelineLogs(dedupeFeedLogs(traceLogs));
    const containsUserBoundary = normalizedLogs.some(log => log?.type === 'user_action');

    normalizedLogs.forEach(log => {
      if (log.type === 'user_action') {
        // Startup/reconnect helper events can precede the authoritative user
        // boundary. If this conversation has a real user turn, those orphaned
        // preamble rows must not become a separate assistant/thought group.
        if (currentGroup.length > 0 && (hasUserBoundary || !containsUserBoundary)) {
          nextGroups.push(currentGroup);
        }
        nextGroups.push([log]);
        currentGroup = [];
        hasUserBoundary = true;
        currentTurnIdentity = String(log.turnId || log.runId || '').trim();
        if (currentTurnIdentity) assistantGroupsByTurn.set(currentTurnIdentity, currentGroup);
      } else {
        const logTurnIdentity = String(log.turnId || log.runId || '').trim();
        const owningGroup = logTurnIdentity && logTurnIdentity !== currentTurnIdentity
          ? assistantGroupsByTurn.get(logTurnIdentity)
          : null;
        if (owningGroup) {
          // Late polling can append an older run after a newer user boundary.
          // Put it back beside its owning query instead of leaking it into the
          // current conversation or hiding it.
          if (!nextGroups.includes(owningGroup)) {
            const ownerUserIndex = nextGroups.findLastIndex(candidate =>
              candidate[0]?.type === 'user_action' &&
              String(candidate[0]?.turnId || candidate[0]?.runId || '').trim() === logTurnIdentity
            );
            nextGroups.splice(ownerUserIndex >= 0 ? ownerUserIndex + 1 : nextGroups.length, 0, owningGroup);
          }
          owningGroup.push(log);
          return;
        }
        // Child/delegated run IDs may not have their own visible user boundary;
        // those actions correctly remain in the active owner's sequence.
        currentGroup.push(log);
      }
    });
    if (currentGroup.length > 0) nextGroups.push(currentGroup);

    // If the agent is currently thinking and the last recorded log is the user's prompt,
    // append an empty group so the UI instantly renders the Agent's "Thinking" container
    // before the first stream chunk arrives.
    if (feedWorkActive && nextGroups.length > 0 && nextGroups[nextGroups.length - 1][0]?.type === 'user_action') {
      nextGroups.push([]);
    }

    return nextGroups;
  }, [feedWorkActive, traceLogs]);

  const [activeTurnIdx, setActiveTurnIdx] = useState<number>(0);
  const conversationIdentity = useMemo(() => {
    const anchor = traceLogs.find((log) => log?.type === 'user_action') ?? traceLogs[0];
    if (!anchor) return 'empty';
    return String(anchor.id ?? anchor._traceIdx ?? anchor.timestamp ?? anchor.startTime ?? anchor.text ?? 'conversation');
  }, [traceLogs]);

  const userTurns = useMemo(() => {
    const ERROR_PATTERNS = ['agent stopped', 'execution failed', 'agent execution', '*agent', 'error:', 'failed:'];
    const isErrorText = (t: string) => ERROR_PATTERNS.some(p => t.toLowerCase().startsWith(p));
    return groups.map((g, idx) => {
      if (g[0]?.type === 'user_action') {
        const nextGroup = groups[idx + 1] || [];
        const answerLog = [...nextGroup].reverse().find((l: any) => l.type === 'answer' && l.text && !isErrorText(l.text));
        const fallbackLog = [...nextGroup].reverse().find((l: any) => l.text && l.type !== 'user_action' && !isErrorText(l.text));
        const firstAttachment = g[0]?.attachments?.[0];
        const attachmentName = firstAttachment?.name || firstAttachment?.file?.name || null;
        return {
          idx,
          userText: g[0]?.text || 'User request',
          assistantText: answerLog?.text || fallbackLog?.text || '',
          attachmentName
        };
      }
      return null;
    }).filter(Boolean).slice(-MAX_TURN_NAV_ITEMS) as Array<{ idx: number; userText: string; assistantText: string; attachmentName: string | null }>;
  }, [groups]);

  useEffect(() => {
    if (userTurns.length > 0) {
      setActiveTurnIdx(userTurns.length - 1);
    }
  }, [conversationIdentity, userTurns.length]);

  useEffect(() => {
    const navContainer = navContainerRef.current;
    const activeEl = navContainerRef.current?.querySelector<HTMLElement>(`[data-turn-index="${ activeTurnIdx }"]`);
    if (!activeEl || !navContainer) return;

    // Keep the turn marker visible by scrolling only its small navigation rail.
    // Element.scrollIntoView() also scrolls ancestor containers and could move
    // the main chat while the user was reading it.
    const itemTop = activeEl.offsetTop;
    const itemBottom = itemTop + activeEl.offsetHeight;
    const visibleTop = navContainer.scrollTop;
    const visibleBottom = visibleTop + navContainer.clientHeight;
    if (itemTop < visibleTop) navContainer.scrollTop = itemTop;
    else if (itemBottom > visibleBottom) navContainer.scrollTop = itemBottom - navContainer.clientHeight;
  }, [activeTurnIdx]);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const feedContentRef = useRef<HTMLDivElement>(null);
  const prevTraceActivityRef = useRef('');
  const shouldAutoFollowRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const lastFaceTraceRef = useRef('');
  const lastFaceLiveNotifyAtRef = useRef(0);
  const scrollUpdateFrameRef = useRef<number | null>(null);
  const autoFollowFrameRef = useRef<number | null>(null);
  const latestScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewUserMessage, setPreviewUserMessage] = useState<{ text: string; index: number } | null>(null);
  const [hoveredTurn, setHoveredTurn] = useState<{ turn: any; rect: DOMRect } | null>(null);
  const hoveredTurnHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHoveredTurn = useCallback((next: { turn: any; rect: DOMRect }) => {
    if (hoveredTurnHideTimeoutRef.current !== null) {
      clearTimeout(hoveredTurnHideTimeoutRef.current);
      hoveredTurnHideTimeoutRef.current = null;
    }
    setHoveredTurn(next);
  }, []);
  const hideHoveredTurn = useCallback(() => {
    if (hoveredTurnHideTimeoutRef.current !== null) clearTimeout(hoveredTurnHideTimeoutRef.current);
    hoveredTurnHideTimeoutRef.current = setTimeout(() => {
      hoveredTurnHideTimeoutRef.current = null;
      setHoveredTurn(null);
    }, 90);
  }, []);
  const previousConversationIdentityRef = useRef(conversationIdentity);
  const isHydratingConversation = previousConversationIdentityRef.current !== conversationIdentity;
  const AUTO_FOLLOW_THRESHOLD = 24;
  const traceActivitySignature = useMemo(() => getTraceActivitySignature(traceLogs), [traceLogs]);

  const pinLatestMessage = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !shouldAutoFollowRef.current) return;
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  }, []);

  useEffect(() => {
    previousConversationIdentityRef.current = conversationIdentity;
    setPreviewUserMessage(null);
    shouldAutoFollowRef.current = true;
  }, [conversationIdentity]);

  useEffect(() => () => {
    if (hoveredTurnHideTimeoutRef.current !== null) clearTimeout(hoveredTurnHideTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!previewUserMessage) return;
    previewRestoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = window.requestAnimationFrame(() => previewCloseButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewUserMessage(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKeyDown);
      previewRestoreFocusRef.current?.focus();
      previewRestoreFocusRef.current = null;
    };
  }, [previewUserMessage]);



  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    // showScrollBottom is derived from geometry and can briefly become true
    // while a final answer replaces its streaming row. Never interpret that
    // programmatic layout transition as the user choosing to read upward.
    if (distanceFromBottom <= AUTO_FOLLOW_THRESHOLD) {
      shouldAutoFollowRef.current = true;
    }
  }, [showScrollBottom]);

  React.useLayoutEffect(() => {
    const hasTraceActivity = traceActivitySignature !== prevTraceActivityRef.current;
    prevTraceActivityRef.current = traceActivitySignature;

    if (!hasTraceActivity && !isThinking) return;
    pinLatestMessage();

    if (autoFollowFrameRef.current !== null) window.cancelAnimationFrame(autoFollowFrameRef.current);
    autoFollowFrameRef.current = window.requestAnimationFrame(() => {
      autoFollowFrameRef.current = null;
      pinLatestMessage();
    });
  }, [traceActivitySignature, isThinking, pinLatestMessage]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = feedContentRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    // Composer resizing, streamed content, images, and collapsing work panels
    // can all change geometry without adding a trace. Keep a bottom-following
    // reader pinned through those changes, but never move someone reading up.
    const observer = new ResizeObserver(() => {
      if (!shouldAutoFollowRef.current) return;
      pinLatestMessage();
      if (autoFollowFrameRef.current !== null) window.cancelAnimationFrame(autoFollowFrameRef.current);
      autoFollowFrameRef.current = window.requestAnimationFrame(() => {
        autoFollowFrameRef.current = null;
        pinLatestMessage();
      });
    });
    observer.observe(container);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [conversationIdentity, pinLatestMessage]);

  useEffect(() => {
    return () => {
      if (scrollUpdateFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollUpdateFrameRef.current);
      }
      if (autoFollowFrameRef.current !== null) {
        window.cancelAnimationFrame(autoFollowFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const latest = traceLogs[traceLogs.length - 1];
    if (!latest) return;
    const latestText = String(latest.text || '');
    const isLiveTyping = !!latest.isLiveTyping;

    const signature = [
      traceLogs.length,
      latest.type || '',
      isLiveTyping ? Math.floor(latestText.length / 96) : latestText,
      latest.secondary || '',
      latest.filename || '',
      isLiveTyping ? 'live' : '',
    ].join(':');

    if (signature === lastFaceTraceRef.current) return;
    if (isLiveTyping) {
      const now = performance.now();
      if (now - lastFaceLiveNotifyAtRef.current < 420) return;
      lastFaceLiveNotifyAtRef.current = now;
    }
    lastFaceTraceRef.current = signature;
    notifyAgentFaceTraceLog(latest, isThinking);
  }, [traceLogs, isThinking]);

  const handleScrollWrap = (e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= AUTO_FOLLOW_THRESHOLD) {
      shouldAutoFollowRef.current = true;
    } else if (performance.now() <= userScrollIntentUntilRef.current) {
      shouldAutoFollowRef.current = false;
    }
    latestScrollContainerRef.current = container;

    if (scrollUpdateFrameRef.current !== null) return;
    scrollUpdateFrameRef.current = window.requestAnimationFrame(() => {
      scrollUpdateFrameRef.current = null;
      const latestContainer = latestScrollContainerRef.current;
      if (!latestContainer) return;
      externalHandleScroll({ currentTarget: latestContainer } as React.UIEvent<HTMLDivElement>);

      const containerRect = latestContainer.getBoundingClientRect();
      const containerCenter = containerRect.top + containerRect.height / 2;
      let closestIdx = -1;
      let minDistance = Infinity;

      userTurns.forEach((turn, k) => {
        const el = latestContainer.querySelector<HTMLElement>(`[data-chat-group-index="${ turn.idx }"]`);
        if (el) {
          const rect = el.getBoundingClientRect();
          const elCenter = rect.top + rect.height / 2;
          const distance = Math.abs(elCenter - containerCenter);
          if (distance < minDistance) {
            minDistance = distance;
            closestIdx = k;
          }
        }
      });

      if (closestIdx !== -1) {
        setActiveTurnIdx(closestIdx);
      }
    });
  };



  // Keep the complete conversation mounted. Live polling can append older or
  // late-arriving turns, and silently windowing the head of the feed makes
  // users believe history was lost behind a "previous messages" affordance.
  const visibleGroups = groups;
  const isEmptyNewChatFeed = traceLogs.length === 0 && !isThinking;
  const navigateToTurn = (turn: { idx: number }, turnIndex: number) => {
    const scrollToTurn = () => {
      const container = scrollContainerRef.current;
      const target = container?.querySelector<HTMLElement>(`[data-chat-group-index="${ turn.idx }"]`);
      if (!container || !target) return;
      shouldAutoFollowRef.current = false;
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetTop = container.scrollTop + targetRect.top - containerRect.top;
      const centeredTop = targetTop - Math.max(0, (container.clientHeight - targetRect.height) / 2);
      container.scrollTo({ top: Math.max(0, centeredTop), behavior: 'smooth' });
    };

    setActiveTurnIdx(turnIndex);
    scrollToTurn();
  };

  const previewViewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const previewViewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight;
  const previewLeft = hoveredTurn
    ? Math.max(12, Math.min(hoveredTurn.rect.right + 10, previewViewportWidth - 312))
    : 12;
  const previewTop = hoveredTurn
    ? Math.max(90, Math.min(hoveredTurn.rect.top + hoveredTurn.rect.height / 2, previewViewportHeight - 90))
    : 90;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `${ liveMotionStyles }\n${ chatFeedSurfaceStyles }` }} />
      <div className="relative flex-1 min-h-0 w-full flex flex-col">
        {hoveredTurn && typeof document !== 'undefined' && createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[10000] -translate-y-1/2 transition-[left,top] duration-200 ease-out"
            style={{ left: previewLeft, top: previewTop }}
          >
            <motion.div
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1], layout: { duration: 0.18, ease: [0.22, 1, 0.36, 1] } }}
              className="eterx-chat-turns-popover relative flex min-h-[54px] max-h-[calc(100vh-24px)] w-[min(320px,calc(100vw-24px))] flex-col overflow-hidden rounded-[15px] border border-white/[0.10] bg-[#1A1A19]/95 px-3.5 pb-3 pt-3 text-left shadow-none backdrop-blur-xl"
            >
              <span aria-hidden="true" className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.14] to-transparent" />
              <div className="relative min-w-0">
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.div
                  key={hoveredTurn.turn.idx}
                  layout
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  transition={{ duration: 0.14, ease: 'easeOut' }}
                  className="flex min-w-0 flex-col"
                >
                <p className="eterx-chat-turns-usertext shrink-0 text-[12.5px] font-semibold leading-[1.4] tracking-[-0.01em] text-[var(--foreground)]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {hoveredTurn.turn.userText}
                </p>
                {hoveredTurn.turn.assistantText && (
                  <div className="eterx-chat-turns-assistanttext mt-2 max-h-[92px] overflow-hidden border-t border-[var(--border)] pt-2 text-[11px] leading-[1.45] text-[var(--muted-foreground)]">
                    <ReactMarkdown
                      remarkPlugins={remarkPlugins}
                      rehypePlugins={rehypePlugins}
                      components={{
                        ...markdownComponents,
                        p: ({ node, ...props }: any) => <p className="mb-1.5 last:mb-0" {...props} />,
                        h1: ({ node, ...props }: any) => <span className="font-semibold text-[var(--foreground)]" {...props} />,
                        h2: ({ node, ...props }: any) => <span className="font-semibold text-[var(--foreground)]" {...props} />,
                        h3: ({ node, ...props }: any) => <span className="font-semibold text-[var(--foreground)]" {...props} />,
                        h4: ({ node, ...props }: any) => <span className="font-semibold text-[var(--foreground)]" {...props} />,
                        h5: ({ node, ...props }: any) => <span className="font-semibold text-[var(--foreground)]" {...props} />,
                        h6: ({ node, ...props }: any) => <span className="font-semibold text-[var(--foreground)]" {...props} />,
                        ul: ({ node, ...props }: any) => <ul className="my-1 list-disc space-y-0.5 pl-4" {...props} />,
                        ol: ({ node, ...props }: any) => <ol className="my-1 list-decimal space-y-0.5 pl-4" {...props} />,
                        li: ({ node, ...props }: any) => <li className="pl-0.5" {...props} />,
                        blockquote: ({ node, ...props }: any) => <blockquote className="my-1 border-l border-[var(--border)] pl-2 text-[var(--muted-foreground)]" {...props} />,
                        strong: ({ node, ...props }: any) => <strong className="font-semibold text-[var(--foreground)]" {...props} />,
                        em: ({ node, ...props }: any) => <em className="italic text-[var(--muted-foreground)]" {...props} />,
                        code: ({ node, inline, ...props }: any) => <code className="rounded bg-[var(--muted)] px-1 py-0.5 font-mono text-[10px] text-[var(--foreground)]" {...props} />,
                        pre: ({ node, children }: any) => <div className="my-1 overflow-hidden rounded bg-[var(--muted)] px-2 py-1 font-mono text-[10px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{children}</div>,
                        a: ({ node, href, children, ...props }: any) => {
                          const localPath = decodeLocalFileHref(href);
                          if (localPath) return <LocalFileLinkChip filePath={localPath} compact />;
                          return <a className="text-[#E2765A] underline-offset-2 hover:underline" target="_blank" rel="noopener noreferrer" href={href} {...props}>{children}</a>;
                        },
                      }}
                    >
                      {normalizeMarkdownForRendering(String(hoveredTurn.turn.assistantText))}
                    </ReactMarkdown>
                  </div>
                )}
                {hoveredTurn.turn.attachmentName && (
                  <div className="eterx-chat-turns-attachment mt-2 inline-flex max-w-full shrink-0 items-center rounded-lg border border-[var(--border)] bg-[var(--muted)] px-2 py-0.5">
                    <span className="eterx-chat-turns-attachment-name truncate text-[10.5px] font-medium text-[var(--muted-foreground)]">{hoveredTurn.turn.attachmentName}</span>
                  </div>
                )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </motion.div>
          </div>,
          document.body,
        )}
        <div
          className={`eterx-chat-feed relative flex-1 min-h-0 w-full overflow-hidden ${ isEmptyNewChatFeed ? 'eterx-chat-feed-empty' : '' }`}
          data-compressed={isCompressed ? 'true' : 'false'}
          data-agent-builder={isAgentBuilderFeed ? 'true' : 'false'}
        >
          {userTurns.length > 1 && (
            <motion.div
              ref={navContainerRef}
              role="navigation"
              aria-label="Conversation turns"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.24, ease: 'easeOut' }}
              className="eterx-chat-turns-nav pointer-events-none absolute inset-y-0 left-2 z-[60] flex items-center"
            >
              <div className="pointer-events-auto flex max-h-[min(52vh,460px)] flex-col gap-0 overflow-y-auto overscroll-contain py-3 pl-1.5 pr-1.5 scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {userTurns.map((turn, k) => (
                  <motion.button
                    type="button"
                    key={turn.idx}
                    data-turn-index={k}
                    aria-label={`Go to turn ${ k + 1 }: ${ turn.userText.slice(0, 80) }`}
                    aria-current={activeTurnIdx === k ? 'step' : undefined}
                    className="group relative flex min-h-[18px] w-[34px] shrink-0 items-center justify-center rounded-lg py-1 text-left outline-none transition-colors duration-150 hover:bg-[var(--muted)] focus-visible:bg-[var(--muted)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]/30"
                    whileTap={{ scale: 0.94 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                    onMouseEnter={(event) => showHoveredTurn({ turn, rect: event.currentTarget.getBoundingClientRect() })}
                    onMouseLeave={hideHoveredTurn}
                    onFocus={(event) => showHoveredTurn({ turn, rect: event.currentTarget.getBoundingClientRect() })}
                    onBlur={hideHoveredTurn}
                    onClick={() => navigateToTurn(turn, k)}
                  >
                    <span
                      className={`eterx-chat-turns-dash h-[2px] rounded-full transition-[width,background-color,opacity] duration-200 ease-out ${ activeTurnIdx === k
                          ? 'bg-[var(--sidebar-strong-text)] w-[22px] opacity-100'
                          : 'bg-[var(--sidebar-icon)] w-[12px] opacity-30 group-hover:w-[18px] group-hover:opacity-60'
                        }`}
                    />
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}
          <div
            id="chat-container"
            className={`eterx-chat-feed-scroll relative h-full w-full flex flex-col overflow-y-auto overflow-x-hidden eterx-scrollbar [overflow-anchor:none] [scrollbar-gutter:stable] ${ isCompressed ? 'px-4 sm:px-8' : 'px-4 sm:px-14'
              }`}
            style={{
              paddingBottom: 'max(10rem, var(--eterx-chat-composer-inset, 10rem))',
              scrollPaddingBottom: 'max(10rem, var(--eterx-chat-composer-inset, 10rem))',
            }}
            ref={scrollContainerRef}
            onScroll={handleScrollWrap}
            onWheel={(e) => {
              const container = e.currentTarget;
              const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
              userScrollIntentUntilRef.current = performance.now() + 500;
              if (e.deltaY < 0 || distanceFromBottom > AUTO_FOLLOW_THRESHOLD) {
                shouldAutoFollowRef.current = false;
              }
            }}
            onTouchMove={(e) => {
              const container = e.currentTarget;
              const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
              userScrollIntentUntilRef.current = performance.now() + 500;
              if (distanceFromBottom > AUTO_FOLLOW_THRESHOLD) shouldAutoFollowRef.current = false;
            }}
          >



            {traceLogs.length === 0 && liveState === 'connecting' && (
              <div className="flex-1 flex flex-col items-center justify-center min-h-[380px] p-6 my-auto text-center select-none bg-transparent">
                <Shimmer className="inline-block text-2xl font-semibold tracking-wide text-white">
                  Connecting...
                </Shimmer>
              </div>
            )}

            {traceLogs.length > 0 && (
              <div ref={feedContentRef} className={`eterx-chat-feed-content w-full mx-auto pb-4 relative ${ isAgentBuilderFeed ? 'eterx-agent-builder-feed-content' : '' } ${ isCompressed ? 'max-w-[460px] pt-14' : 'max-w-[660px] pt-16' }`}>
                {visibleGroups.map((group, visibleGroupIdx) => {
                  const groupIdx = visibleGroupIdx;
                  const isThinkingTurn = feedWorkActive && groupIdx === groups.length - 1;
                  const isLiveSessionActive =
                    groupIdx === groups.length - 1 &&
                    !isFeedActivityPaused &&
                    !isSubAgentTab &&
                    liveState !== undefined &&
                    liveState !== 'idle' &&
                    liveState !== 'error';

                  // --- Date divider logic ---
                  const thisDateKey = getGroupDateKey(group);
                  const prevGroup = visibleGroupIdx > 0 ? visibleGroups[visibleGroupIdx - 1] : null;
                  const prevDateKey = prevGroup ? getGroupDateKey(prevGroup) : '';
                  const showDateDivider = thisDateKey && thisDateKey !== prevDateKey;
                  const dateLabel = showDateDivider ? formatDateLabel(thisDateKey) : '';

                  return (
                    <div
                      key={`group-${ conversationIdentity }-${ getGroupMountIdentity(group, groupIdx) }`}
                      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 280px' }}
                    >
                      {showDateDivider && dateLabel && (
                        <ChatDateDivider label={dateLabel} />
                      )}
                      <ChatFeedMessageGroup
                        group={group}
                        groupIdx={groupIdx}
                        isThinkingTurn={isThinkingTurn}
                        isLiveSessionActive={isLiveSessionActive}
                        suppressInitialReveal={isHydratingConversation}
                        isCompressed={isCompressed}
                        onOpenAgentTeam={onOpenAgentTeam}
                        subAgentAssetIndexes={subAgentAssetIndexes}
                        onAnswerAskUser={onAnswerAskUser}
                        onEditUserMessage={onEditUserMessage}
                        isSubAgentTab={isSubAgentTab}
                        isAgentBuilder={isAgentBuilderFeed}
                        setPreviewUserMessage={setPreviewUserMessage}
                        showTokenCount={showTokenCount}
                      />
                    </div>
                  );
                })}

                <div ref={messagesEndRef} className="h-[2px]" />
              </div>
            )}
          </div>
        </div>
      </div>
      <AnimatePresence>
        {previewUserMessage && (
          <motion.div
            className={`fixed bottom-0 right-0 top-0 z-[80] flex items-center justify-center bg-black/40 px-4 py-6 backdrop-blur-[2px] ${ sidebarOpen ? 'left-0 md:left-[280px]' : 'left-0 md:left-[68px]' }`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={() => setPreviewUserMessage(null)}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby={previewTitleId}
              className={`eterx-prompt-preview-dialog relative max-h-[82vh] w-[calc(100vw-32px)] overflow-hidden rounded-[20px] border border-white/[0.07] bg-[#1A1A19] shadow-none sm:w-[calc(100vw-96px)] ${ isCompressed ? 'max-w-[720px]' : 'max-w-[920px]' }`}
              initial={{ opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                ref={previewCloseButtonRef}
                type="button"
                onClick={() => setPreviewUserMessage(null)}
                className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-[#242423]/90 text-[#B9B2A8] shadow-none transition-colors duration-150 hover:bg-[#2C2C2A] hover:text-[#EFE9DF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                aria-label="Close prompt preview"
              >
                <Minimize2 className="h-4 w-4" strokeWidth={2.2} />
              </button>
              <div
                ref={previewScrollRef}
                className="max-h-[82vh] overflow-y-auto eterx-scrollbar eterx-prompt-preview-scroll px-6 py-7 pr-8 sm:px-8 sm:py-8 sm:pr-10"
              >
                <h2 id={previewTitleId} className="sr-only">Full prompt preview</h2>
                <div className="eterx-prompt-preview-text whitespace-pre-wrap break-words text-[15.5px] leading-[1.7] text-[#C9C3BA] [overflow-wrap:anywhere]">
                  {previewUserMessage.text}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
});
