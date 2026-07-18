import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, RefreshCw, ChevronDown, FileText, Check, Clock, ChevronRight, MessageSquarePlus, Activity, Minimize2, CornerDownLeft } from 'lucide-react';
import { ThinkingProcess, ProfessionalThought } from '../chat/thought-sequence';
import { AskUserPrompt } from '../chat/ask-user-prompt';
import { Tooltip } from '../ui/tooltip';
import { notifyAgentFaceTraceLog } from './agent-face-controller';

interface ChatFeedProps {
  traceLogs: any[];
  isThinking: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  setSidebarOpen: (o: boolean) => void;
  sidebarOpen: boolean;
  handleScroll: (e: any) => void;
  showScrollBottom: boolean;
  isCompressed?: boolean;
  onOpenAgentTeam?: (agentName?: string) => void;
  onAnswerAskUser?: (timestamp: number, answer: string, responseKey?: string) => void;
  onEditUserMessage?: (text: string) => void;
  isSubAgentTab?: boolean;
}

const copyTextToClipboard = async (text: string) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back below when Clipboard API permission is denied.
  }

  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textArea);
    return copied;
  } catch (err) {
    console.error('Failed to copy:', err);
    return false;
  }
};

const NakedCopyButton = ({ content }: { content: string }) => {
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
      <button type="button" onClick={handle} className="rounded-[8px] p-[6px] text-[#746F67] transition-colors hover:bg-white/[0.045] hover:text-[#DAD4CA]">
        {copied ? <Check className="w-[15px] h-[15px] text-[#74D39A]" /> : <Copy className="w-[15px] h-[15px]" />}
      </button>
    </Tooltip>
  );
};

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
    <button type="button" onClick={copy} className="rounded-[8px] p-1.5 text-[#746F67] transition-colors hover:bg-white/[0.045] hover:text-[#DAD4CA]">
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

const UserMessageActions = ({ text, onEdit }: { text: string; onEdit?: (text: string) => void }) => {
  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const didCopy = await copyTextToClipboard(text);
    if (!didCopy) return;
  };

  return (
    <div className="eterx-user-message-actions absolute right-full top-1/2 mr-2 flex -translate-y-1/2 shrink-0 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover/user:opacity-100 group-hover/user:pointer-events-auto group-hover/steer:opacity-100 group-hover/steer:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto">
      <UserMessageActionButton label="Copy message" onClick={handleCopy}>
        <Copy className="h-[18px] w-[18px]" strokeWidth={2.15} />
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
};

// ════════════════════════════════════════════════════════════════════
// SteeringFeedCard — left-aligned enterprise card shown in the main
// chat feed whenever the user sends a live steering message while the
// agent is running. Feels native to the conversation thread.
// ════════════════════════════════════════════════════════════════════
const SteeringFeedCard = ({ log, isCompressed = false, onEdit }: { log: any; isCompressed?: boolean; onEdit?: (text: string) => void }) => (
  <motion.div
    initial={{ opacity: 0, x: 20, y: 10, scale: 0.95 }}
    animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
    transition={{ type: 'spring', stiffness: 450, damping: 24 }}
    className="flex justify-end w-full my-3 relative z-10 group/steer"
  >
    <div className={`eterx-steering-bubble bg-[#20201F] px-4 py-3 rounded-[18px] rounded-tr-[6px] ml-auto text-[13.5px] text-[#F4F2EE] shadow-[0_4px_16px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.025)] leading-[1.56] whitespace-pre-wrap relative border border-white/[0.06] select-text flex flex-row items-end gap-3 ${ isCompressed ? 'max-w-[92%]' : 'max-w-[84%]' }`}>
      <UserMessageActions text={log.text} onEdit={onEdit} />
      <span className="block w-full text-left break-words [word-break:break-word] [overflow-wrap:anywhere]">{log.text}</span>

      {/* CornerDownLeft arrow representing steering entry */}
      <div className="shrink-0 mb-1 select-none text-[#8F887E]">
        <CornerDownLeft className="w-[17px] h-[17px]" strokeWidth={2.25} />
      </div>
    </div>
  </motion.div>
);

const liveMotionStyles = `
  @keyframes blink { 0%,100%{opacity:0.7} 50%{opacity:0} }
  @keyframes wi-spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
  @keyframes wi-breathe { 0%,100%{opacity:.6;filter:brightness(.85)} 50%{opacity:1;filter:brightness(1.25)} }
  @keyframes eterx-live-dot {
    0%, 76%, 100% { transform: translateY(0) scale(.92); opacity: .36; box-shadow: 0 0 0 rgba(190,190,186,0); }
    38% { transform: translateY(-2px) scale(1.08); opacity: .95; box-shadow: 0 0 9px rgba(190,190,186,.34); }
  }
  .eterx-live-dot { animation: eterx-live-dot 1.45s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .eterx-live-dot { animation: none; opacity: .75; }
  }
`;

const chatFeedSurfaceStyles = `
  .eterx-chat-feed {
    --eterx-chat-feed-bg: #0F0F0F;
    background: var(--eterx-chat-feed-bg);
  }
  :root[data-theme="light"] .eterx-chat-feed {
    --eterx-chat-feed-bg: #F8F9FB;
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
  .eterx-chat-feed-empty {
    --eterx-chat-feed-bg: transparent;
    background: transparent;
  }
  .eterx-chat-feed-empty .eterx-chat-feed-scroll,
  .eterx-chat-feed-empty .eterx-chat-feed-content {
    background: transparent;
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
`;

const WORKFLOW_COUNT_TYPES = new Set([
  'command',
  'exploration',
  'file_edit',
  'communication',
  'safety_warning',
  'sub_agent_spawn',
  'progress',
  'browser',
  'tool_result',
  'tool_error',
]);
const HIDDEN_HELPER_TYPES = new Set(['answer', 'ask_user', 'file_preview', 'console_output', 'html_preview']);
const USER_QUERY_PREVIEW_LIMIT = 520;
const USER_QUERY_PREVIEW_LINES = 8;
const INITIAL_VISIBLE_GROUPS = 40;

const normalizeTraceText = (value: any) => String(value || '')
  .replace(/<\/?thought>/gi, '')
  .replace(/^[\s*_`~]+|[\s*_`~]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const isNarrationThought = (value: any) => {
  const text = String(value || '').trim();
  return /^(i['’]?ll|i will|i['’]?m|i am|let me|now let me|next\b|i need to|i can|i should|i will now)\b/i.test(text);
};

const isExternalWorkNoteNoise = (value: any) => {
  const text = String(value || '').trim();
  if (!text || text.length < 4) return true;
  // Only filter very short pure-narration sentences (no real content, under 60 chars)
  if (text.length < 60 && /^(?:i will|i'll|let me|now i will|now let me|i am going to)\s+(?:now\s+)?(?:check|look|see|find|read|run|search|analyze|inspect|verify|open|edit|write|create|update|fix|use|get|list|scan|review|explore)\b[^.!?]*$/i.test(text)) return true;
  // Filter meta-commentary about the work note style itself
  if (/\b(?:work note|timeline note|status line)\b/i.test(text) && /\b(?:workspace|external|prompt|rule|communication style|phase change|highly professional)\b/i.test(text)) return true;
  return false;
};

const isInternalStatusThought = (log: any) => {
  if (!log || log.type !== 'thought') return false;
  const text = normalizeTraceText(log.text);
  return !text ||
    /^generation stopped by user\.?$/.test(text) ||
    /^agent stopped\b/.test(text) ||
    /^agent connection failed\b/.test(text) ||
    /^agent start failed\b/.test(text) ||
    /^custom agent (?:start|connection) failed\b/.test(text) ||
    /^failed to send message to\b/.test(text);
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

const getTraceActivitySignature = (logs: any[]) => logs
  .map((log, index) => {
    const text = String(log?.text ?? log?.output ?? log?.content ?? log?.secondary ?? '');
    return [
      index,
      log?._traceIdx ?? '',
      log?.type ?? '',
      log?.answerId ?? '',
      log?.noteId ?? '',
      log?.thoughtId ?? '',
      log?.endTime ?? log?.timestamp ?? '',
      text.length,
      text.slice(-32),
    ].join(':');
  })
  .join('|');

/**
 * CollapsibleThinking — wraps ThinkingProcess.
 * While thinking: always open (live).
 * After answer delivered: auto-collapses to a compact "N steps" pill.
 * User can click to expand/re-read the full work.
 */
const HIDDEN_MODEL_STATUS_PATTERN = /^(?:(?:using|starting|selected)\s+)?(?:model\s*:?\s*)?(?:gemini[\s-]*3(?:\.5)?[\s-]*flash|gemini-3\.5-flash|mistral\s+devstral\s+2|devstral-2512)(?:\s+(?:is\s+)?(?:starting|loading|initializing|selected|ready|working))?(?:\s+model)?$/i;
const DASH_ONLY_STATUS_PATTERN = /^[\s\-–—]{2,}$/;

const isHiddenStatusOnlyLog = (log: any) => {
  if (log?.type === 'work_note_cancel') return true;
  if (log?.type === 'task_plan') return true;
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
  return (
    <span className="eterx-text-shimmer eterx-text-shimmer-working font-sans font-semibold text-[13px] tracking-normal">
      {label}
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

const getWorkTimeBounds = (logs: any[], startedAt?: number | null) => {
  let start: number | null = normalizeWorkTimestamp(startedAt);
  let end: number | null = null;
  logs.forEach((log) => {
    const startValue = normalizeWorkTimestamp(log?.startTime ?? log?.timestamp ?? log?.endTime);
    const endValue = normalizeWorkTimestamp(log?.endTime ?? log?.timestamp ?? log?.startTime);
    if (startValue !== null) start = start === null ? startValue : Math.min(start, startValue);
    if (endValue !== null) end = end === null ? endValue : Math.max(end, endValue);
  });
  if (start !== null && end !== null && end < start) end = start;
  return { start, end };
};

const getWorkElapsedFromBounds = (start: number | null, end: number | null) => {
  if (start === null || end === null) return 0;
  const elapsedMs = Math.max(0, Math.min(end - start, MAX_REASONABLE_WORK_MS));
  return Math.floor(elapsedMs / 1000);
};

const useWorkElapsedSeconds = (active: boolean, logs: any[], startedAt?: number | null, endedAt?: number | null) => {
  const [seconds, setSeconds] = React.useState(0);
  const sessionStartRef = React.useRef<number | null>(null);

  const normalizedStartedAt = React.useMemo(() => normalizeWorkTimestamp(startedAt), [startedAt]);
  const normalizedEndedAt = React.useMemo(() => normalizeWorkTimestamp(endedAt), [endedAt]);

  // 1. Establish stable session start time
  React.useEffect(() => {
    if (active) {
      if (sessionStartRef.current === null) {
        const bounds = getWorkTimeBounds(logs, normalizedStartedAt);
        sessionStartRef.current = bounds.start ?? normalizedStartedAt ?? Date.now();
      }
    } else {
      sessionStartRef.current = null;
    }
  }, [active, normalizedStartedAt]);

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
      const bounds = getWorkTimeBounds(logs, normalizedStartedAt);
      const finalEnd = normalizedEndedAt ?? bounds.end ?? Date.now();
      const finalStart = bounds.start ?? normalizedStartedAt ?? Date.now();
      setSeconds(getWorkElapsedFromBounds(finalStart, finalEnd));
    }
  }, [active, logs, normalizedStartedAt, normalizedEndedAt]);

  return seconds;
};

const ThoughtSequence = ({
  logs, liveLogs = [], isThinking, isLast, hasAnswer, stepCount, turnStartedAt, turnEndedAt, onOpenAgentTeam, isSubAgentTab = false, groupIdx = 0, onEditUserMessage
}: { logs: any[], liveLogs?: any[], isThinking: boolean, isLast: boolean, hasAnswer: boolean, stepCount: number, turnStartedAt?: number | null, turnEndedAt?: number | null, onOpenAgentTeam?: (agentName?: string) => void, isSubAgentTab?: boolean, groupIdx?: number, onEditUserMessage?: (text: string) => void }) => {
  // Start collapsed for completed turns, open for active/no-answer turns
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  // Latch: once hasAnswer becomes true, never re-open on a transient false
  const hasAnswerLatchRef = React.useRef(false);
  // isLiveThinking: true while the turn is actively thinking regardless of streaming answer
  const isLiveThinking = isThinking;

  // Reset latch when this component's group index changes (new conversation turn)
  React.useEffect(() => {
    hasAnswerLatchRef.current = false;
  }, [groupIdx]);

  React.useEffect(() => {
    if (isLiveThinking) {
      setOpen(true);
      return;
    }
    // Answer just arrived for the first time — collapse
    if (hasAnswer && !hasAnswerLatchRef.current) {
      setOpen(false);
      hasAnswerLatchRef.current = true;
      return;
    }
    // Only re-open if we never had an answer (new turn without answer yet)
    if (!hasAnswer && !hasAnswerLatchRef.current) {
      setOpen(true);
    }
  }, [hasAnswer, isLiveThinking]);

  const toggleOpen = () => {
    setOpen(currentOpen => {
      if (currentOpen) {
        // Anchor before collapse so the list doesn't jump above the viewport.
        const chatContainer = document.getElementById('chat-container');
        if (containerRef.current && chatContainer) {
          const containerRect = containerRef.current.getBoundingClientRect();
          const chatRect = chatContainer.getBoundingClientRect();

          if (containerRect.top < chatRect.top) {
            chatContainer.scrollBy({ top: containerRect.top - chatRect.top - 8, behavior: 'auto' });
          }
        }
      }
      return !currentOpen;
    });
  };

  const isOpen = open;
  const elapsedLogs = React.useMemo(() => [...logs, ...liveLogs], [logs, liveLogs]);
  const workElapsedSeconds = useWorkElapsedSeconds(isLiveThinking, elapsedLogs, turnStartedAt, turnEndedAt);
  const workElapsedLabel = formatWorkElapsed(workElapsedSeconds);

  if (stepCount === 0 && logs.length === 0 && !isLiveThinking) return null;

  const isWaitingForFirstTrace = isLiveThinking && stepCount === 0 && logs.length === 0 && liveLogs.length === 0;
  const actionLabel = stepCount > 0
    ? `${ stepCount } action${ stepCount !== 1 ? 's' : '' }`
    : 'Thinking';
  const hasCounter = stepCount > 0 || logs.length > 0;
  const isCollapsedWithAnswer = hasAnswer && !isOpen;
  const hasRealActions = stepCount > 0;
  const isLiveWorkCounter = isLiveThinking && hasRealActions && !isWaitingForFirstTrace;
  const showWorkedSummary = !isLiveThinking && hasRealActions;
  const shouldStickCounter = hasAnswer || isLiveWorkCounter;
  const counterColor = '#E8E6E3';
  const counterBackground = 'rgba(28,28,28,0.76)';
  const counterHoverBackground = 'rgba(38,38,38,0.92)';
  const counterOutline = 'rgba(255,255,255,0.14)';
  const counterShadow = 'inset 0 1px 0 rgba(255,255,255,0.075), 0 8px 24px rgba(0,0,0,0.22)';
  const compactCounterStyle: React.CSSProperties = {
    padding: '4px 8px 4px 6px', borderRadius: 13, border: 'none', background: counterBackground,
    outline: `1px solid ${ counterOutline }`, backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
    boxShadow: counterShadow, color: counterColor,
  };

  return (
    <div className="relative" ref={containerRef}>
      {showWorkedSummary && <div className="eterx-worked-summary mb-2 flex w-full items-center gap-4 pt-1"><div className="eterx-worked-summary-line h-px flex-1 bg-white/[0.08]" /><span className="eterx-worked-summary-label shrink-0 py-[1px] text-center text-[12px] font-medium leading-[1.35] tracking-normal text-[#8F8B85]">{`Worked for ${ workElapsedLabel }`}</span><div className="eterx-worked-summary-line h-px flex-1 bg-white/[0.08]" /></div>}
      {hasCounter && <div className={`eterx-process-summary-row ${ shouldStickCounter ? 'sticky top-3 z-20' : '' } ${ isCollapsedWithAnswer ? 'mb-2' : 'mb-1' } flex w-full items-center overflow-visible py-1.5`}>
        {isLiveWorkCounter ? <button type="button" onClick={toggleOpen} aria-expanded={isOpen} className="eterx-process-summary-chip eterx-process-summary-chip-live group inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full bg-[#1C1C1C] px-3 py-[6px] text-[13px] font-semibold leading-[1.35] tracking-normal text-[#C9C6C0] outline outline-1 outline-white/[0.12] shadow-[inset_0_-1px_0_rgba(255,255,255,0.12)] transition-all duration-150 hover:bg-[#262626] hover:outline-white/[0.2] hover:text-[#E8E6E3]"><span className="eterx-process-summary-label inline-flex items-center pb-[1px] leading-[1.35] text-[#C9C6C0]"><span className="eterx-text-shimmer eterx-text-shimmer-working mr-1">Working for</span><RollingTimeDisplay label={workElapsedLabel} /></span>{isOpen ? <ChevronDown className="h-3 w-3 opacity-55" /> : <ChevronRight className="h-3 w-3 opacity-55" />}</button> : <button type="button" onClick={toggleOpen} aria-expanded={isOpen} className="eterx-process-summary-chip inline-flex h-[30px] items-center gap-1.5 transition-all duration-200" style={{ ...compactCounterStyle, cursor: 'pointer', position: 'relative', zIndex: 1 }} onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#C2BFBA'; (e.currentTarget as HTMLElement).style.background = counterHoverBackground; }} onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = counterColor; (e.currentTarget as HTMLElement).style.background = counterBackground; }}><span className="eterx-process-summary-icon" style={{ display: 'inline-flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 8, color: 'inherit', background: 'rgba(255,255,255,0.055)', outline: '1px solid rgba(255,255,255,0.12)' }}><StepCounterIcon live={isLiveThinking} /></span><span className={`eterx-process-summary-label${ isLiveThinking ? ' eterx-text-shimmer eterx-text-shimmer-active' : '' }`} style={{ fontSize: 13, fontWeight: 650, letterSpacing: 0, lineHeight: 1 }}>{actionLabel}</span>{isOpen ? <ChevronDown style={{ width: 9, height: 9, flexShrink: 0, opacity: 0.6 }} /> : <ChevronRight style={{ width: 9, height: 9, flexShrink: 0, opacity: 0.6 }} />}</button>}
      </div>}

      <AnimatePresence>
        {isOpen && (
          <motion.div
            layout={false}
            initial={false}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.15, ease: 'easeIn' } }}
            style={{ overflow: 'hidden' }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="mb-1"
          >
            <ThinkingProcess
              logs={logs}
              liveLogs={liveLogs}
              isThinking={isLiveThinking}
              isLast={isLast}
              showLiveIndicator={isLiveThinking && isLast && liveLogs.length === 0}
              onOpenAgentTeam={onOpenAgentTeam}
              isSubAgentTab={isSubAgentTab}
              onEditUserMessage={onEditUserMessage}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const ChatFeedMessageGroup = React.memo(({
  group,
  groupIdx,
  isThinkingTurn,
  turnStartedAt,
  isCompressed,
  onOpenAgentTeam,
  onAnswerAskUser,
  onEditUserMessage,
  isSubAgentTab,
  setPreviewUserMessage,
}: {
  group: any[];
  groupIdx: number;
  isThinkingTurn: boolean;
  turnStartedAt: number | null;
  isCompressed: boolean;
  onOpenAgentTeam?: (agentName?: string) => void;
  onAnswerAskUser?: (timestamp: number, answer: string, responseKey?: string) => void;
  onEditUserMessage?: (text: string) => void;
  isSubAgentTab: boolean;
  setPreviewUserMessage: (msg: { text: string; index: number } | null) => void;
}) => {
  // Latch ref: once finalAnswer is computed as non-null for this group,
  // never let a transient polling race blank the answer bubble.
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
    return (
      <div id={`message-${ groupIdx }`} className="eterx-chat-message-group mt-8 mb-6 flex w-full scroll-m-20 justify-end group/user">
        <div className="flex w-full justify-end">
          <div className={`eterx-user-message-bubble eterx-chat-feed-user-bubble flex min-w-0 flex-col items-end rounded-[18px] border border-white/[0.06] bg-[#20201F] px-4 py-2.5 text-[13.5px] leading-[1.56] text-[#F4F2EE] shadow-[0_4px_18px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.025)] selection:bg-[#D98B6A]/25 relative whitespace-pre-wrap select-text ${ isCompressed ? 'max-w-[92%]' : 'max-w-[520px]' }`}>
            <UserMessageActions text={userText} onEdit={onEditUserMessage} />
            {first.attachments && first.attachments.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2.5 mb-3 w-full">
                {first.attachments.map((att: any, i: number) => {
                  const isImage = !!att.preview;
                  const fileName = att.name || att.file?.name || 'file';
                  const extension = fileName.split('.').pop()?.toUpperCase() || 'FILE';
                  const isPdf = extension === 'PDF';
                  const isDocPreviewable = extension === 'PDF' || extension === 'DOCX';

                  if (isImage) {
                    return (
                      <div
                        key={att.id || i}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          window.dispatchEvent(new CustomEvent('eterx-preview-image', { detail: { previewUrl: att.preview } }));
                        }}
                        className="relative group w-[72px] h-[72px] rounded-[14px] shadow-[0_3px_12px_rgba(0,0,0,0.16)] transition-colors cursor-pointer border border-white/[0.06] shrink-0 hover:border-white/[0.10]"
                      >
                        <img src={att.preview} alt="attached" className="w-full h-full object-cover rounded-[14px] transition-opacity hover:opacity-90" />
                      </div>
                    );
                  }

                  return (
                    <div
                      key={att.id || i}
                      onClick={() => {
                        if (isDocPreviewable) {
                          const targetPath = att.localPath || att.path || att.name;
                          window.dispatchEvent(new CustomEvent('eterx-preview-document', { detail: { filePath: targetPath } }));
                        }
                      }}
                      className={`flex flex-col items-center justify-center gap-1.5 w-[72px] h-[72px] rounded-[14px] bg-white/[0.024] border border-white/[0.055] shadow-[0_3px_12px_rgba(0,0,0,0.12)] shrink-0 ${ isDocPreviewable ? 'cursor-pointer hover:border-white/[0.10] hover:bg-white/[0.045] transition-all' : 'cursor-default' }`}
                    >
                      <div className={`w-[26px] h-[26px] rounded-[7px] flex items-center justify-center shrink-0 ${ isPdf ? 'bg-[#C65D58]' : extension === 'DOCX' ? 'bg-[#2A6B9C]' : 'bg-[#596B7B]' }`}>
                        <FileText className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
                      </div>
                      <span className="text-[10px] font-medium text-[#C8C1B8] truncate max-w-[90%] px-1">{att.name || fileName}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className={`relative w-full text-left ${ isLong ? 'max-h-[230px] overflow-hidden pb-8' : '' }`}>
              <span className="block w-full text-left break-words [word-break:break-word] [overflow-wrap:anywhere]">{userText}</span>
              {isLong && (
                <button
                  type="button"
                  onClick={() => setPreviewUserMessage({ text: userText, index: groupIdx })}
                  className="eterx-chat-feed-user-fade absolute inset-x-0 bottom-0 flex h-24 items-end justify-center bg-gradient-to-b from-[#20201F]/0 via-[#20201F]/82 to-[#20201F] pb-1.5 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/18"
                  aria-label="Show full prompt"
                >
                  <span className="text-[12.5px] font-medium text-[#A9A197] transition-colors hover:text-[#D2CBC1]">
                    Show more
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Bug 9: Empty groups (appended for live thinking indicator) must not
  // render a blank mb-8 div when the group truly has no content yet.
  if (group.length === 0 && !isThinkingTurn) return null;

  const liveCommandLogs = group.filter((l: any) => l.type === 'command' && l.isLive && !isHiddenStatusOnlyLog(l));
  // thought_stream are internal streaming chunks; exclude them from the rendered log list
  const standardLogs = group.filter((l: any) =>
    !(l.type === 'command' && l.isLive) &&
    l.type !== 'thought_stream' &&
    !isHiddenStatusOnlyLog(l)
  );

  let processLogs: any[] = [];
  let finalAnswer: any = null;
  let tailLogs: any[] = [];

  let firstAnswerIdx = -1;
  let lastAnswerIdx = -1;
  for (let i = 0; i < standardLogs.length; i++) {
    if (standardLogs[i].type === 'answer') {
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
    // No answer log yet — keep all logs in processLogs, no final answer bubble
    processLogs = standardLogs;
    finalAnswer = null;
    tailLogs = [];
  }

  const displayProcessLogs = processLogs;
  // ANSWER LATCH — never let a transient polling race blank the answer bubble.
  // Rules:
  //   1. If finalAnswer is non-null, always save it (update ref).
  //   2. If finalAnswer is null but we have a cached answer, keep the cached one.
  //   3. If finalAnswer is non-null but shorter than the cached one AND we're still
  //      actively thinking, keep the cached (longer) version — the shorter frame is
  //      a transient mid-stream snapshot.
  if (finalAnswer !== null) {
    const cached = lastKnownAnswerRef.current;
    const newText = finalAnswer.text || '';
    const cachedText = cached?.text || '';
    // Only update cache if the new answer is longer, or we're not thinking (settled)
    if (!isThinkingTurn || newText.length >= cachedText.length) {
      lastKnownAnswerRef.current = finalAnswer;
    }
  }
  const displayFinalAnswer = finalAnswer ?? lastKnownAnswerRef.current;
  const answerUpdatedAt = Number(displayFinalAnswer?.startTime ?? displayFinalAnswer?.timestamp ?? 0);
  const answerRecentlyStreamed = !!displayFinalAnswer &&
    Number.isFinite(answerUpdatedAt) &&
    answerUpdatedAt > 0 &&
    Date.now() - answerUpdatedAt < 10000;
  // Decouple from isThinkingTurn so live class persists through end-of-turn animation
  const isAnswerActivelyTyping = !!(displayFinalAnswer?.isLiveTyping || displayFinalAnswer?.isStreaming);

  // Stable deduplication set for work notes — keyed on noteId or content
  const seenWorkNoteKeys = new Set<string>();
  const rawWorkLogs = [...displayProcessLogs, ...tailLogs];
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
  const visibleWorkLogs = hasAskUserInteractionLog
    ? rawWorkLogs.filter((log: any) => {
      if (log.type !== 'ask_user') return true;
      if (!isAskUserInteractionLog(log)) return false;
      return preferredAskUserLogs.get(askUserKey(log)) === log;
    })
    : rawWorkLogs;
  const hasStructuredWork = [...rawWorkLogs, ...liveCommandLogs].some((l: any) =>
    WORKFLOW_COUNT_TYPES.has(l.type) && !HIDDEN_HELPER_TYPES.has(l.type)
  );

  const segments: { type: 'thoughts' | 'steering' | 'ask_user'; logs?: any[]; log?: any }[] = [];
  let currentThoughts: any[] = [];

  visibleWorkLogs.forEach(log => {
    if (log.type === 'steering_received') {
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
        if (hasStructuredWork && isExternalWorkNoteNoise(log.text)) isValid = false;
        if (displayFinalAnswer && isValid) {
          const thoughtEndTime = Number(log.endTime ?? log.timestamp ?? 0);
          const answerStartTime = Number(displayFinalAnswer.startTime ?? displayFinalAnswer.timestamp ?? 0);
          if (thoughtEndTime > 0 && answerStartTime > 0 && thoughtEndTime >= answerStartTime) isValid = false;
        }
      }
      if (log.type === 'work_note') {
        const text = String(log.text || '').trim().toLowerCase();
        if (!text) isValid = false;
        else if (hasStructuredWork && isExternalWorkNoteNoise(log.text)) isValid = false;
        else if (displayFinalAnswer && isLikelyAnswerEcho(log.text, displayFinalAnswer.text)) isValid = false;
        else {
          const noteId = String(log.noteId || '').trim();
          const key = noteId
            ? `${ log.subAgent || '' }::id::${ noteId }`
            : `${ log.subAgent || '' }::${ text }`;
          if (seenWorkNoteKeys.has(key)) isValid = false;
          else seenWorkNoteKeys.add(key);
        }
      }

      if (isValid) {
        currentThoughts.push(log);
      }
    }
  });

  if (currentThoughts.length > 0 || isThinkingTurn) {
    segments.push({ type: 'thoughts', logs: currentThoughts });
  }

  return (
    <div
      id={`message-${ groupIdx }`}
      data-live={isThinkingTurn ? 'true' : undefined}
      className="eterx-chat-message-group w-full flex flex-col mb-8 scroll-m-20 relative"
    >
      {segments.map((seg, segIdx) => {
        if (seg.type === 'steering') {
          return <SteeringFeedCard key={`steer-${ groupIdx }-${ segIdx }`} log={seg.log} isCompressed={isCompressed} onEdit={onEditUserMessage} />;
        }
        if (seg.type === 'ask_user') {
          return (
            <AskUserPrompt
              key={`ask-${ groupIdx }-${ segIdx }`}
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
        const stepCount = (seg.logs || []).filter((l: any) =>
          WORKFLOW_COUNT_TYPES.has(l.type) && !HIDDEN_HELPER_TYPES.has(l.type)
        ).length + (isLastThoughts ? liveCommandLogs.length : 0);

        if (stepCount === 0 && (seg.logs || []).length === 0 && !(isThinkingTurn && isLastThoughts)) return null;

        return (
          <ThoughtSequence
            key={`thoughts-${ groupIdx }-${ segIdx }`}
            logs={seg.logs || []}
            liveLogs={isLastThoughts ? liveCommandLogs : []}
            isThinking={isThinkingTurn && isLastThoughts}
            isLast={isLastThoughts}
            hasAnswer={!!displayFinalAnswer && isLastThoughts}
            stepCount={stepCount}
            turnStartedAt={turnStartedAt}
            turnEndedAt={displayFinalAnswer?.endTime ?? displayFinalAnswer?.timestamp ?? null}
            onOpenAgentTeam={onOpenAgentTeam}
            isSubAgentTab={isSubAgentTab}
            groupIdx={groupIdx}
            onEditUserMessage={onEditUserMessage}
          />
        );
      })}

      {displayFinalAnswer && (
        <div className="eterx-assistant-answer w-full group/assistant mt-0 [&_.professional-thought>*:first-child]:!mt-0">
          <div className="relative group/thought">
            <div className={`eterx-assistant-answer-body ${ isAnswerActivelyTyping ? 'eterx-assistant-live-text' : '' } text-[13.5px] leading-[1.56] text-[#F2F0EC] font-sans relative`}>
              <ProfessionalThought
                text={displayFinalAnswer.text}
                isLatest={isThinkingTurn}
                isThinking={isAnswerActivelyTyping || isThinkingTurn}
                variant="answer"
                updatedAt={isAnswerActivelyTyping ? displayFinalAnswer.timestamp : undefined}
                reveal={answerRecentlyStreamed}
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
}, (prev, next) => {
  // Re-render only when thinking state CHANGES, not on every parent render while thinking is true
  if (prev.isThinkingTurn !== next.isThinkingTurn) return false;
  if (prev.groupIdx !== next.groupIdx) return false;
  if (prev.isCompressed !== next.isCompressed) return false;
  if (prev.isSubAgentTab !== next.isSubAgentTab) return false;
  if (prev.turnStartedAt !== next.turnStartedAt) return false;

  const prevGroup = prev.group;
  const nextGroup = next.group;
  if (prevGroup === nextGroup) return true;

  // CRITICAL: Never skip render if group size changed — a transient null answer
  // must run through the component so the latch ref updates correctly.
  if (!prevGroup || !nextGroup || prevGroup.length !== nextGroup.length) return false;

  // Extract answer logs from both groups for comparison
  const prevAnswer = prevGroup.find((l: any) => l?.type === 'answer');
  const nextAnswer = nextGroup.find((l: any) => l?.type === 'answer');

  // If answer existence or content changed, always re-render
  if (!!prevAnswer !== !!nextAnswer) return false;
  if (prevAnswer && nextAnswer) {
    if (prevAnswer.text !== nextAnswer.text) return false;
    if (prevAnswer.isStreaming !== nextAnswer.isStreaming) return false;
    if (prevAnswer.isLiveTyping !== nextAnswer.isLiveTyping) return false;
  }

  for (let i = 0; i < prevGroup.length; i++) {
    const p = prevGroup[i];
    const n = nextGroup[i];
    if (p === n) continue;
    if (!p || !n) return false;
    if (p.id !== n.id || p.type !== n.type || p.text !== n.text || p.timestamp !== n.timestamp) return false;
    if (p.secondary !== n.secondary || p.isStreaming !== n.isStreaming || p.isLiveTyping !== n.isLiveTyping) return false;
  }
  return true;
});

export const ChatFeed = React.memo<ChatFeedProps>(({
  traceLogs, isThinking, messagesEndRef, setSidebarOpen, sidebarOpen, handleScroll: externalHandleScroll, showScrollBottom, isCompressed = false, onOpenAgentTeam, onAnswerAskUser, onEditUserMessage, isSubAgentTab = false
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const nextGroups: any[][] = [];
    let currentGroup: any[] = [];

    traceLogs.forEach(log => {
      if (log.type === 'user_action') {
        if (currentGroup.length > 0) nextGroups.push(currentGroup);
        nextGroups.push([log]);
        currentGroup = [];
      } else {
        currentGroup.push(log);
      }
    });
    if (currentGroup.length > 0) nextGroups.push(currentGroup);

    // If the agent is currently thinking and the last recorded log is the user's prompt,
    // append an empty group so the UI instantly renders the Agent's "Thinking" container
    // before the first stream chunk arrives.
    if (isThinking && nextGroups.length > 0 && nextGroups[nextGroups.length - 1][0]?.type === 'user_action') {
      nextGroups.push([]);
    }

    return nextGroups;
  }, [traceLogs, isThinking]);

  const [activeTurnIdx, setActiveTurnIdx] = useState<number>(0);



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
    }).filter(Boolean) as Array<{ idx: number; userText: string; assistantText: string; attachmentName: string | null }>;
  }, [groups]);

  useEffect(() => {
    if (userTurns.length > 0) {
      setActiveTurnIdx(userTurns.length - 1);
    }
  }, [userTurns.length]);

  useEffect(() => {
    const activeEl = document.getElementById(`dash-${activeTurnIdx}`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeTurnIdx]);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const prevTraceActivityRef = useRef('');
  const shouldAutoFollowRef = useRef(true);
  const lastFaceTraceRef = useRef('');
  const lastFaceLiveNotifyAtRef = useRef(0);
  const scrollUpdateFrameRef = useRef<number | null>(null);
  const latestScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewUserMessage, setPreviewUserMessage] = useState<{ text: string; index: number } | null>(null);
  const [historyWindowSize, setHistoryWindowSize] = useState(INITIAL_VISIBLE_GROUPS);
  const AUTO_FOLLOW_THRESHOLD = 24;
  const traceActivitySignature = useMemo(() => getTraceActivitySignature(traceLogs), [traceLogs]);

  useEffect(() => {
    if (!previewUserMessage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewUserMessage(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewUserMessage]);



  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (showScrollBottom) {
      // Only suppress auto-follow when user is meaningfully far from bottom
      if (distanceFromBottom > AUTO_FOLLOW_THRESHOLD * 3) {
        shouldAutoFollowRef.current = false;
      }
    } else if (distanceFromBottom <= AUTO_FOLLOW_THRESHOLD) {
      shouldAutoFollowRef.current = true;
    }
  }, [showScrollBottom]);

  // Reset auto-follow on every new agent run so the feed always scrolls to show new output
  useEffect(() => {
    if (isThinking) {
      shouldAutoFollowRef.current = true;
    }
  }, [isThinking]);

  useEffect(() => {
    const hasTraceActivity = traceActivitySignature !== prevTraceActivityRef.current;
    prevTraceActivityRef.current = traceActivitySignature;

    if (!hasTraceActivity && !isThinking) return;

    if (!shouldAutoFollowRef.current) return;

    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container || !shouldAutoFollowRef.current) return;
      container.scrollTop = container.scrollHeight;
    });
  }, [traceActivitySignature, isThinking]);

  useEffect(() => {
    return () => {
      if (scrollUpdateFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollUpdateFrameRef.current);
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
    shouldAutoFollowRef.current = distanceFromBottom <= AUTO_FOLLOW_THRESHOLD;
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
        const el = document.getElementById(`message-${turn.idx}`);
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



  const hiddenGroupCount = Math.max(0, groups.length - historyWindowSize);
  const visibleGroups = hiddenGroupCount > 0 ? groups.slice(hiddenGroupCount) : groups;
  const isEmptyNewChatFeed = traceLogs.length === 0 && !isThinking;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `${ liveMotionStyles }\n${ chatFeedSurfaceStyles }` }} />
      <div className="relative flex-1 min-h-0 w-full flex flex-col">
        {userTurns.length > 2 && (
          <div className="absolute left-2 top-[44%] -translate-y-1/2 flex flex-col gap-[3px] z-[60] py-3">
            {userTurns.map((turn, k) => (
              <div key={turn.idx} className="group relative flex items-center py-2 cursor-pointer" onClick={() => {
                    const el = document.getElementById(`message-${turn.idx}`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    setActiveTurnIdx(k);
                  }}>
                <div
                  id={`dash-${k}`}
                  className={`h-[2px] transition-all duration-200 ${
                    activeTurnIdx === k
                      ? 'bg-[#F4F2EE] w-[22px]'
                      : 'bg-white/30 w-[14px] group-hover:w-[22px] group-hover:bg-white/55'
                  }`}
                  aria-label={`Go to turn ${k + 1}`}
                />
                
                {/* Popover */}
                <div className="absolute left-8 top-1/2 -translate-y-1/2 w-[290px] rounded-xl border border-white/[0.06] bg-[#1C1C1B] backdrop-blur-2xl px-3 pt-2.5 pb-2.5 shadow-[0_12px_36px_rgba(0,0,0,0.6)] opacity-0 pointer-events-none group-hover:opacity-100 z-[70]">
                  <p className="text-[12.5px] font-semibold text-[#EDEBE7] leading-[1.4] tracking-[-0.01em] mb-1" style={{display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden'}}>
                    {turn.userText}
                  </p>
                  {turn.assistantText && (
                    <p className="text-[11px] text-[#6E6A64] leading-[1.55]" style={{display:'-webkit-box',WebkitLineClamp:3,WebkitBoxOrient:'vertical',overflow:'hidden'}}>
                      {turn.assistantText}
                    </p>
                  )}
                  {turn.attachmentName && (
                    <div className="mt-2 inline-flex items-center rounded-lg bg-white/[0.05] border border-white/[0.05] px-2 py-0.5 max-w-full">
                      <span className="text-[10.5px] font-medium text-[#A09A93] truncate">{turn.attachmentName}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className={`eterx-chat-feed relative flex-1 min-h-0 w-full overflow-hidden ${ isEmptyNewChatFeed ? 'eterx-chat-feed-empty' : '' }`}>
        <div
          className={`eterx-chat-feed-scroll relative h-full w-full flex flex-col overflow-y-auto overflow-x-hidden pb-40 eterx-scrollbar ${
            isCompressed ? 'px-11' : 'px-11 sm:px-14'
          }`}
          id="chat-container"
          ref={scrollContainerRef}
          onScroll={handleScrollWrap}
          onWheel={(e) => {
            const container = e.currentTarget;
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            if (isThinking && (e.deltaY < 0 || distanceFromBottom > AUTO_FOLLOW_THRESHOLD)) shouldAutoFollowRef.current = false;
          }}
          onTouchMove={(e) => {
            const container = e.currentTarget;
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            if (isThinking && distanceFromBottom > AUTO_FOLLOW_THRESHOLD) shouldAutoFollowRef.current = false;
          }}
        >



          {traceLogs.length > 0 && (
            <div className={`eterx-chat-feed-content w-full mx-auto pb-4 relative ${ isCompressed ? 'max-w-[460px] pt-14' : 'max-w-[660px] pt-16' }`}>
              {hiddenGroupCount > 0 && (
                <div className="mb-7 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setHistoryWindowSize(size => size + INITIAL_VISIBLE_GROUPS)}
                    className="rounded-full border border-white/[0.07] bg-white/[0.028] px-3 py-1.5 text-[12px] font-medium text-[#A8A198] transition-colors hover:border-white/[0.12] hover:bg-white/[0.045] hover:text-[#DAD4CA]"
                  >
                    Show previous {hiddenGroupCount} messages
                  </button>
                </div>
              )}
              {visibleGroups.map((group, visibleGroupIdx) => {
                const groupIdx = hiddenGroupCount + visibleGroupIdx;
                const isThinkingTurn = isThinking && groupIdx === groups.length - 1;
                const previousUserLog = groups
                  .slice(0, groupIdx)
                  .reverse()
                  .find((candidate) => candidate[0]?.type === 'user_action')?.[0];
                const turnStartedAtRaw = previousUserLog?.startTime ?? previousUserLog?.timestamp ?? previousUserLog?.endTime;
                const turnStartedAt = Number.isFinite(Number(turnStartedAtRaw)) ? Number(turnStartedAtRaw) : null;

                return (
                  <ChatFeedMessageGroup
                    key={`group-${ groupIdx }`}
                    group={group}
                    groupIdx={groupIdx}
                    isThinkingTurn={isThinkingTurn}
                    turnStartedAt={turnStartedAt}
                    isCompressed={isCompressed}
                    onOpenAgentTeam={onOpenAgentTeam}
                    onAnswerAskUser={onAnswerAskUser}
                    onEditUserMessage={onEditUserMessage}
                    isSubAgentTab={isSubAgentTab}
                    setPreviewUserMessage={setPreviewUserMessage}
                  />
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
              aria-label="Full prompt preview"
              className={`eterx-prompt-preview-dialog relative max-h-[82vh] w-[calc(100vw-32px)] overflow-hidden rounded-[20px] border border-white/[0.07] bg-[#1A1A19] shadow-[0_20px_70px_rgba(0,0,0,0.42)] sm:w-[calc(100vw-96px)] ${ isCompressed ? 'max-w-[720px]' : 'max-w-[920px]' }`}
              initial={{ opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setPreviewUserMessage(null)}
                className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-[#242423]/90 text-[#B9B2A8] shadow-[0_8px_24px_rgba(0,0,0,0.30)] transition-colors duration-150 hover:bg-[#2C2C2A] hover:text-[#EFE9DF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                aria-label="Close prompt preview"
              >
                <Minimize2 className="h-4 w-4" strokeWidth={2.2} />
              </button>
              <div
                ref={previewScrollRef}
                className="max-h-[82vh] overflow-y-auto eterx-scrollbar eterx-prompt-preview-scroll px-6 py-7 pr-8 sm:px-8 sm:py-8 sm:pr-10"
              >
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
