import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, RefreshCw, ChevronDown, FileText, Check, Clock, ChevronRight, MessageSquarePlus, Activity, Minimize2, CornerDownLeft } from 'lucide-react';
import { ThinkingProcess, ProfessionalThought } from '../chat/thought-sequence';
import { AskUserPrompt } from '../chat/ask-user-prompt';
import { Tooltip } from '../ui/tooltip';
import { notifyAgentFaceTraceLog } from './agent-face-controller';
import { resolveAgentIcon } from './agent-icons';

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
}

const NakedCopyButton = ({ content }: { content: string }) => {
  const [copied, setCopied] = useState(false);
  const handle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = content;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };
  return (
    <Tooltip text={copied ? "Copied!" : "Copy"}>
      <button onClick={handle} className="p-[6px] text-[#555350] hover:text-[#E8E6E3] transition-colors rounded-md hover:bg-white/[0.06]">
        {copied ? <Check className="w-[15px] h-[15px] text-[#56D364]" /> : <Copy className="w-[15px] h-[15px]" />}
      </button>
    </Tooltip>
  );
};

export const LiveActionChip = ({ text, secondary, isActive, inCard = false }: { text: string, secondary?: string, isActive?: boolean, inCard?: boolean }) => {
  const { Icon, color } = resolveAgentIcon(text, secondary);
  return (
    <motion.div
      initial={{ opacity: 0, y: -3, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      className={`eterx-live-action-chip flex min-h-[46px] w-full items-center gap-3 px-3 py-2 text-[#8C8A88] transition-colors ${ inCard ? 'hover:bg-white/[0.035]' : 'rounded-[14px] hover:bg-white/[0.03]' }`}
    >
      <span className="flex h-8 w-8 items-center justify-center shrink-0">
        <Icon size={19} color={color} />
      </span>
      <span className={`max-w-[46%] shrink-0 truncate text-[14px] font-semibold tracking-normal ${ isActive ? 'eterx-live-text eterx-live-text--medium' : 'text-[#A7A39E]' }`}>
        {text}
      </span>
      {secondary && <span className="h-4 w-px shrink-0 bg-white/[0.08]" />}
      {secondary && <span className="min-w-0 truncate font-mono text-[13px] text-[#605D59]">{secondary}</span>}
      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-[#45423E]" />
    </motion.div>
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
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button onClick={copy} className="p-1.5 text-[#555350] hover:text-[#8C8A88] hover:bg-white/[0.05] rounded-md transition-all">
      <AnimatePresence mode="wait">
        {copied
          ? <motion.div key="check" initial={{ scale: 0.7 }} animate={{ scale: 1 }} exit={{ scale: 0.7 }}><Check className="w-3.5 h-3.5 text-emerald-500" /></motion.div>
          : <motion.div key="copy" initial={{ scale: 0.7 }} animate={{ scale: 1 }} exit={{ scale: 0.7 }}><Copy className="w-3.5 h-3.5" /></motion.div>
        }
      </AnimatePresence>
    </button>
  );
};

// ════════════════════════════════════════════════════════════════════
// SteeringFeedCard — left-aligned enterprise card shown in the main
// chat feed whenever the user sends a live steering message while the
// agent is running. Feels native to the conversation thread.
// ════════════════════════════════════════════════════════════════════
const SteeringFeedCard = ({ log, isCompressed = false }: { log: any; isCompressed?: boolean }) => (
  <motion.div
    initial={{ opacity: 0, x: 20, y: 10, scale: 0.95 }}
    animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
    transition={{ type: 'spring', stiffness: 450, damping: 24 }}
    className="flex justify-end w-full my-3.5 relative z-10 group/steer"
  >
    <div className={`eterx-steering-bubble bg-[#242424] text-white px-5 py-3.5 rounded-[22px] rounded-tr-[6px] ml-auto text-[15.5px] shadow-[0_2px_12px_rgba(0,0,0,0.28)] leading-relaxed whitespace-pre-wrap relative border border-white/[0.07] select-text flex flex-row items-end gap-3.5 ${ isCompressed ? 'max-w-[92%]' : 'max-w-[84%]' }`}>
      <span className="block w-full text-left break-words [word-break:break-word] [overflow-wrap:anywhere]">{log.text}</span>
      
      {/* CornerDownLeft arrow representing steering entry */}
      <div className="shrink-0 mb-1 select-none text-[#8C8A88]">
        <CornerDownLeft className="w-[18px] h-[18px]" strokeWidth={2.5} />
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
  @keyframes eterx-shimmer {
    0%   { background-position: 260% center, 0 0; }
    22%  { background-position: 260% center, 0 0; }
    70%  { background-position: -260% center, 0 0; }
    100% { background-position: -260% center, 0 0; }
  }
  .eterx-live-text {
    --eterx-live-shimmer-duration: 5.8s;
    --eterx-live-shimmer-ease: cubic-bezier(.4, 0, .12, 1);
    --eterx-live-shimmer-a: #9A9A98;
    --eterx-live-shimmer-d: #FFFFFF;
    background:
      linear-gradient(
        102deg,
        transparent 0%,
        transparent 44%,
        var(--eterx-live-shimmer-d) 50%,
        var(--eterx-live-shimmer-d) 56%,
        transparent 62%,
        transparent 100%
      ),
      linear-gradient(var(--eterx-live-shimmer-a), var(--eterx-live-shimmer-a));
    background-size: 245% 100%, 100% 100%;
    background-position: 260% center, 0 0;
    background-repeat: no-repeat, no-repeat;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: eterx-shimmer var(--eterx-live-shimmer-duration) var(--eterx-live-shimmer-ease) infinite;
    text-shadow: none;
    will-change: background-position;
  }
  .eterx-live-text * { -webkit-text-fill-color: inherit; }
  .eterx-live-text--medium { --eterx-live-shimmer-duration: 5.8s; }
  .eterx-live-text--slow { --eterx-live-shimmer-duration: 7.4s; }
  :root[data-theme="light"] .eterx-live-text,
  [data-theme="light"] .eterx-live-text {
    --eterx-live-shimmer-a: #9A9A98;
    --eterx-live-shimmer-d: #FFFFFF;
    text-shadow: none;
  }
  .eterx-live-dot { animation: eterx-live-dot 1.45s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .eterx-live-text {
      background: none;
      -webkit-text-fill-color: #C8C5BF;
      animation: none;
    }
    .eterx-live-dot { animation: none; opacity: .75; }
  }
`;

const WORKFLOW_COUNT_TYPES = new Set([
  'command',
  'exploration',
  'file_edit',
  'communication',
  'safety_warning',
  'sub_agent_answer',
  'sub_agent_result',
  'progress',
  'browser',
  'html_preview',
  'tool_result',
  'tool_error',
]);
const HIDDEN_HELPER_TYPES = new Set(['answer', 'ask_user', 'file_preview', 'console_output']);
const USER_QUERY_PREVIEW_LIMIT = 520;
const USER_QUERY_PREVIEW_LINES = 8;
const INITIAL_VISIBLE_GROUPS = 40;

const normalizeTraceText = (value: any) => String(value || '')
  .replace(/<\/?thought>/gi, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const isNarrationThought = (value: any) => {
  const text = String(value || '').trim();
  return /^(i['’]?ll|i will|i['’]?m|i am|let me|now let me|next\b|i need to|i can|i should|i will now)\b/i.test(text);
};

const isExternalWorkNoteNoise = (value: any) => {
  const text = String(value || '').trim();
  if (!text) return true;
  if (isNarrationThought(text)) return true;
  return /^(?:i will|i['â€™]?ll|i need|i am|i['â€™]?m|let me|to (?:find|see|check|verify|inspect|understand|locate|confirm)\b|checking|searching|reading|analyzing|this will\b|now i\b)/i.test(text);
};

const isInternalStatusThought = (log: any) => {
  if (!log || log.type !== 'thought') return false;
  const text = normalizeTraceText(log.text);
  return !text ||
    /^generation stopped by user\.?$/.test(text) ||
    /^agent stopped\b/.test(text) ||
    /^agent connection failed\b/.test(text) ||
    /^agent start failed\b/.test(text);
};

const isLikelyAnswerEcho = (candidate: any, answer: any) => {
  const left = normalizeTraceText(candidate);
  const right = normalizeTraceText(answer);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return shorter.length > 80 && longer.includes(shorter);
};

const getUserQueryPreview = (value: any) => {
  const text = String(value || '');
  const lines = text.split(/\r?\n/);
  const isLong = text.length > USER_QUERY_PREVIEW_LIMIT || lines.length > USER_QUERY_PREVIEW_LINES;
  return { isLong };
};

/**
 * CollapsibleThinking — wraps ThinkingProcess.
 * While thinking: always open (live).
 * After answer delivered: auto-collapses to a compact "N steps" pill.
 * User can click to expand/re-read the full work.
 */
const HIDDEN_MODEL_STATUS_PATTERN = /^(?:(?:using|starting|selected)\s+)?(?:model\s*:?\s*)?(?:gemini[\s-]*3(?:\.5)?[\s-]*flash|gemini-3\.5-flash|mistral\s+devstral\s+2|devstral-2512)(?:\s+(?:is\s+)?(?:starting|loading|initializing|selected|ready|working))?(?:\s+model)?$/i;
const DASH_ONLY_STATUS_PATTERN = /^[\s\-–—]{2,}$/;

const isHiddenStatusOnlyLog = (log: any) => {
  if (log?.type === 'task_plan') return true;
  if (!log || log.type === 'user_action' || log.type === 'answer') return false;
  const values = [log.text, log.secondary, log.modelName, log.model]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return values.some(value =>
    HIDDEN_MODEL_STATUS_PATTERN.test(value) ||
    DASH_ONLY_STATUS_PATTERN.test(value)
  );
};

const isWorkNoteDisplayNoise = (value: any) => {
  const text = String(value || '').trim();
  if (!text) return true;
  if (HIDDEN_MODEL_STATUS_PATTERN.test(text) || DASH_ONLY_STATUS_PATTERN.test(text)) return true;
  if (/^(?:generation stopped by user|agent stopped|agent connection failed|agent start failed)\.?$/i.test(text)) return true;
  if (/^(?:checking|searching|reading|analyzing|running|executing|creating|generating|processing|loading)(?:\s+[\w.-]+){0,4}$/i.test(text)) return true;
  return false;
};

const formatWorkElapsed = (seconds: number) => {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return minutes > 0 ? `${ minutes }m ${ rest }s` : `${ rest }s`;
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
  const startRef = React.useRef<number | null>(null);
  const [seconds, setSeconds] = React.useState(0);
  const bounds = React.useMemo(() => getWorkTimeBounds(logs, startedAt), [logs, startedAt]);
  const normalizedEndedAt = React.useMemo(() => normalizeWorkTimestamp(endedAt), [endedAt]);

  React.useEffect(() => {
    if (!active) {
      const finalEnd = normalizedEndedAt ?? bounds.end ?? (startRef.current !== null ? Date.now() : null);
      const finalStart = bounds.start ?? startRef.current;
      const finalSeconds = getWorkElapsedFromBounds(finalStart, finalEnd);
      startRef.current = null;
      setSeconds(finalSeconds);
      return;
    }

    const nextStart = bounds.start ?? Date.now();
    startRef.current = startRef.current === null ? nextStart : Math.min(startRef.current, nextStart);

    const tick = () => {
      const start = startRef.current ?? Date.now();
      const elapsedMs = Math.max(0, Math.min(Date.now() - start, MAX_REASONABLE_WORK_MS));
      setSeconds(Math.floor(elapsedMs / 1000));
    };

    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [active, bounds.start, bounds.end, normalizedEndedAt]);

  return seconds;
};

const ThoughtSequence = ({
  logs, liveLogs = [], isThinking, isLast, hasAnswer, stepCount, turnStartedAt, turnEndedAt
}: { logs: any[], liveLogs?: any[], isThinking: boolean, isLast: boolean, hasAnswer: boolean, stepCount: number, turnStartedAt?: number | null, turnEndedAt?: number | null }) => {
  const [open, setOpen] = React.useState(() => isThinking || !hasAnswer);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const prevHasAnswer = React.useRef(false);
  const isLiveThinking = isThinking && !hasAnswer;

  React.useEffect(() => {
    if (isLiveThinking) {
      setOpen(true);
      return;
    }
    if (hasAnswer && !prevHasAnswer.current) {
      setOpen(false);
      prevHasAnswer.current = true;
    }
    if (!hasAnswer && prevHasAnswer.current) {
      setOpen(true);
      prevHasAnswer.current = false;
    } else if (!hasAnswer) {
      prevHasAnswer.current = false;
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
  const shouldShowFaceStatus = isLiveThinking && isLast;
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
    padding: '4px 8px 4px 6px',
    borderRadius: 13,
    border: 'none',
    background: counterBackground,
    outline: `1px solid ${counterOutline}`,
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    boxShadow: counterShadow,
    color: counterColor,
  };

  return (
    <div className="relative" ref={containerRef}>
      {showWorkedSummary && (
        <div className="eterx-worked-summary mb-2 flex w-full items-center gap-4 pt-1">
          <div className="eterx-worked-summary-line h-px flex-1 bg-white/[0.08]" />
          <span className="eterx-worked-summary-label shrink-0 py-[1px] text-center text-[14.5px] font-medium leading-[1.35] tracking-normal text-[#8F8B85]">
            {`Worked for ${ workElapsedLabel }`}
          </span>
          <div className="eterx-worked-summary-line h-px flex-1 bg-white/[0.08]" />
        </div>
      )}

      {hasCounter && (
        <div className={`eterx-process-summary-row ${shouldStickCounter ? 'sticky top-3 z-20' : ''} ${isCollapsedWithAnswer ? 'mb-2' : 'mb-1'} flex w-full items-center overflow-visible py-1.5`}>
          {isLiveWorkCounter ? (
            <button
              type="button"
              onClick={toggleOpen}
              aria-expanded={isOpen}
              className="eterx-process-summary-chip eterx-process-summary-chip-live group inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full bg-[#1C1C1C]/78 px-3 py-[6px] text-[13px] font-semibold leading-[1.35] tracking-normal text-[#C9C6C0] outline outline-1 outline-white/[0.12] backdrop-blur-xl transition-colors duration-150 hover:bg-[#262626]/92 hover:text-[#E8E6E3]"
            >
              <span className="eterx-process-summary-label eterx-live-text eterx-live-text--slow inline-flex items-center pb-[1px] leading-[1.35]">
                {`Working for ${ workElapsedLabel }`}
              </span>
              {isOpen
                ? <ChevronDown className="h-3 w-3 opacity-55 transition-opacity group-hover:opacity-80" />
                : <ChevronRight className="h-3 w-3 opacity-55 transition-opacity group-hover:opacity-80" />
              }
            </button>
          ) : (
            <button
              type="button"
              onClick={toggleOpen}
              aria-expanded={isOpen}
              className="eterx-process-summary-chip inline-flex h-[30px] items-center gap-1.5 transition-all duration-200"
              style={{
                ...compactCounterStyle,
                cursor: 'pointer',
                position: 'relative',
                zIndex: 1,
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.color = '#C2BFBA';
                (e.currentTarget as HTMLElement).style.background = counterHoverBackground;
              }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = counterColor; (e.currentTarget as HTMLElement).style.background = counterBackground; }}
            >
              <span
                className="eterx-process-summary-icon"
                style={{
                  display: 'inline-flex',
                  width: 20,
                  height: 20,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 8,
                  color: 'inherit',
                  background: 'rgba(255,255,255,0.055)',
                  outline: '1px solid rgba(255,255,255,0.12)',
                }}
              >
                <StepCounterIcon live={isLiveThinking} />
              </span>
              <span className={`eterx-process-summary-label${isLiveThinking ? ' eterx-live-text eterx-live-text--medium' : ''}`} style={{ fontSize: 13, fontWeight: 650, letterSpacing: 0, lineHeight: 1 }}>{actionLabel}</span>
              {isOpen
                ? <ChevronDown style={{ width: 9, height: 9, flexShrink: 0, opacity: 0.6 }} />
                : <ChevronRight style={{ width: 9, height: 9, flexShrink: 0, opacity: 0.6 }} />
              }
            </button>
          )}
        </div>
      )}

      <AnimatePresence>
        {isOpen && (
          <motion.div
            layout
            initial={false}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0 } }}
            style={{ overflow: 'hidden' }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className={shouldShowFaceStatus
              ? 'mb-2 flex items-center'
              : 'mb-1'}
          >
            <ThinkingProcess logs={logs} liveLogs={liveLogs} isThinking={isLiveThinking} isLast={isLast} showLiveIndicator={shouldShowFaceStatus} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export const ChatFeed: React.FC<ChatFeedProps> = ({
  traceLogs, isThinking, messagesEndRef, setSidebarOpen, sidebarOpen, handleScroll: externalHandleScroll, showScrollBottom, isCompressed = false
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const prevTraceCountRef = useRef(traceLogs.length);
  const shouldAutoFollowRef = useRef(true);
  const lastFaceTraceRef = useRef('');
  const lastFaceLiveNotifyAtRef = useRef(0);
  const scrollUpdateFrameRef = useRef<number | null>(null);
  const latestScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewUserMessage, setPreviewUserMessage] = useState<{ text: string; index: number } | null>(null);
  const [historyWindowSize, setHistoryWindowSize] = useState(INITIAL_VISIBLE_GROUPS);
  const AUTO_FOLLOW_THRESHOLD = 24;

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
      shouldAutoFollowRef.current = false;
    } else if (distanceFromBottom <= AUTO_FOLLOW_THRESHOLD) {
      shouldAutoFollowRef.current = true;
    }
  }, [showScrollBottom]);

  useEffect(() => {
    const hasNewLog = traceLogs.length !== prevTraceCountRef.current;
    prevTraceCountRef.current = traceLogs.length;

    if (!hasNewLog && !isThinking) return;

    if (!shouldAutoFollowRef.current) return;

    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container || !shouldAutoFollowRef.current) return;
      container.scrollTop = container.scrollHeight;
    });
  }, [traceLogs.length, isThinking]);

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
    });
  };

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

  const hiddenGroupCount = Math.max(0, groups.length - historyWindowSize);
  const visibleGroups = hiddenGroupCount > 0 ? groups.slice(hiddenGroupCount) : groups;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: liveMotionStyles }} />
      <div className="eterx-chat-feed relative flex-1 min-h-0 w-full overflow-hidden">
      <div
        className={`eterx-chat-feed-scroll relative h-full w-full flex flex-col overflow-y-auto overflow-x-hidden pb-44 eterx-scrollbar ${ isCompressed ? 'pl-3 pr-3 sm:pl-4 sm:pr-4' : 'px-4 sm:px-12' }`}
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
        <div className={`eterx-chat-feed-content w-full mx-auto pb-4 relative ${ isCompressed ? 'max-w-[520px] pt-16' : 'max-w-[800px] pt-20' }`}>
          {hiddenGroupCount > 0 && (
            <div className="mb-8 flex justify-center">
              <button
                type="button"
                onClick={() => setHistoryWindowSize(size => size + INITIAL_VISIBLE_GROUPS)}
                className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-[#A3A19E] transition-colors hover:border-white/[0.16] hover:bg-white/[0.07] hover:text-[#E8E6E3]"
              >
                Show previous {hiddenGroupCount} messages
              </button>
            </div>
          )}
          {visibleGroups.map((group, visibleGroupIdx) => {
            const groupIdx = hiddenGroupCount + visibleGroupIdx;
            const first = group[0];
            if (first?.type === 'user_action') {
              const userText = String(first.text || '');
              const { isLong } = getUserQueryPreview(userText);
              return (
                <div key={`group-${ groupIdx }`} id={`message-${ groupIdx }`} className="eterx-chat-message-group mt-9 mb-6 flex w-full scroll-m-20 flex-col items-end group/user">
                  <div className={`eterx-user-message-bubble eterx-chat-feed-user-bubble ml-auto flex flex-col items-end rounded-[22px] border border-white/[0.055] bg-[#242424] px-[18px] py-3 text-[15.5px] leading-[1.56] text-[#E8E6E3] shadow-[0_10px_28px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.035)] selection:bg-[#E2765A]/30 relative whitespace-pre-wrap select-text ${ isCompressed ? 'max-w-[92%]' : 'max-w-[560px]' }`}>
                    {first.attachments && first.attachments.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-2.5 mb-3 w-full">
                        {first.attachments.map((att: any, i: number) => {
                          const isImage = !!att.preview;
                           const fileName = att.name || att.file?.name || 'file';
                           const extension = fileName.split('.').pop()?.toUpperCase() || 'FILE';
                           const isPdf = extension === 'PDF';
 
                           if (isImage) {
                             return (
                               <a key={att.id || i} href={att.preview} target="_blank" rel="noopener noreferrer" className="relative group w-[72px] h-[72px] rounded-[16px] shadow-sm hover:shadow-md transition-all cursor-pointer border border-white/[0.06] shrink-0">
                                 <img src={att.preview} alt="attached" className="w-full h-full object-cover rounded-[16px] hover:opacity-80 transition-opacity" />
                               </a>
                             );
                           }
 
                           return (
                             <div key={att.id || i} className="flex flex-col items-center justify-center gap-1.5 w-[72px] h-[72px] rounded-[16px] bg-white/[0.025] border border-white/[0.05] shadow-sm shrink-0">
                               <div className={`w-[26px] h-[26px] rounded-md flex items-center justify-center shrink-0 shadow-sm ${ isPdf ? 'bg-[#EF4444]' : 'bg-[#007AFF]' }`}>
                                 <FileText className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
                               </div>
                               <span className="text-[10px] font-medium text-[#C4C1BC] truncate max-w-[90%] px-1">{att.name || fileName}</span>
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
                          className="eterx-chat-feed-user-fade absolute inset-x-0 bottom-0 flex h-24 items-end justify-center bg-gradient-to-b from-[#242424]/0 via-[#242424]/82 to-[#242424] pb-1.5 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                          aria-label="Show full prompt"
                        >
                          <span className="text-[13px] font-medium text-[#A4A19D] transition-colors hover:text-[#C4C1BC]">
                            Show more
                          </span>
                        </button>
                      )}
                    </div>
                    <div className="absolute -bottom-8 right-0 flex items-center gap-1 opacity-0 group-hover/user:opacity-100 transition-opacity duration-200 pointer-events-none group-hover/user:pointer-events-auto">
                      <Tooltip text="Copy message">
                        <button onClick={() => navigator.clipboard.writeText(userText)} className="p-1.5 text-[#555350] hover:text-[#8C8A88] hover:bg-white/[0.05] rounded-md transition-all">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              );
            }

            const isThinkingTurn = isThinking && groupIdx === groups.length - 1;
            const previousUserLog = groups
              .slice(0, groupIdx)
              .reverse()
              .find((candidate) => candidate[0]?.type === 'user_action')?.[0];
            const turnStartedAtRaw = previousUserLog?.startTime ?? previousUserLog?.timestamp ?? previousUserLog?.endTime;
            const turnStartedAt = Number.isFinite(Number(turnStartedAtRaw)) ? Number(turnStartedAtRaw) : null;

            // 1. Separate logs into those rendered as LiveActionChips and those rendered via ThoughtSequence
            const liveCommandLogs = group.filter((l: any) => l.type === 'command' && l.isLive && !isHiddenStatusOnlyLog(l));
            const standardLogs = group.filter((l: any) => !(l.type === 'command' && l.isLive) && !isHiddenStatusOnlyLog(l));

            let processLogs: any[] = [];
            let finalAnswer: any = null;
            let tailLogs: any[] = [];

            // 2. Of the standard logs, identify the final answer
            let firstAnswerIdx = -1;
            let lastAnswerIdx = -1;
            for (let i = 0; i < standardLogs.length; i++) {
              if (standardLogs[i].type === 'answer') {
                if (firstAnswerIdx === -1) firstAnswerIdx = i;
                lastAnswerIdx = i;
              }
            }
            if (firstAnswerIdx >= 0) {
              const firstIdx = firstAnswerIdx;
              const lastIdx = lastAnswerIdx;
              processLogs = standardLogs.slice(0, firstIdx);
              const lastAnswerLog = standardLogs[lastIdx];

              const answerText = lastAnswerLog?.text || '';

              finalAnswer = {
                type: 'answer',
                text: answerText,
                isLiveTyping: lastAnswerLog?.isLiveTyping || false,
                spokenText: lastAnswerLog?.spokenText || '',
                timestamp: lastAnswerLog?.timestamp,
                startTime: lastAnswerLog?.startTime,
                endTime: lastAnswerLog?.endTime
              };
              tailLogs = standardLogs.slice(lastIdx + 1).filter((l: any) => l.type !== 'answer');
            } else {
              // Only treat user-visible thought logs as a potential final answer.
              // Internal stop/status notes and generic work narration should stay out
              // of the chat transcript instead of becoming loose assistant text.
              const lastThoughtIdx = [...standardLogs].reverse().findIndex((l: any) =>
                l.type === 'thought' &&
                !isInternalStatusThought(l) &&
                !isExternalWorkNoteNoise(l.text)
              );
              const actualLastThoughtIdx = lastThoughtIdx === -1 ? -1 : standardLogs.length - 1 - lastThoughtIdx;
              // Everything except the final 'thought' goes into processLogs (including thought_stream)
              processLogs = actualLastThoughtIdx === -1 ? standardLogs : standardLogs.slice(0, actualLastThoughtIdx);
              finalAnswer = actualLastThoughtIdx === -1 ? null : standardLogs[actualLastThoughtIdx];
              tailLogs = actualLastThoughtIdx === -1 ? [] : standardLogs.slice(actualLastThoughtIdx + 1);
            }

            const displayProcessLogs = processLogs;
            const displayFinalAnswer = finalAnswer;
            const isAnswerActivelyTyping = !!displayFinalAnswer?.isLiveTyping && isThinkingTurn;

            // Extract ask_user events from process logs for inline rendering
            const askUserLogs = standardLogs.filter((l: any) => l.type === 'ask_user');

            const seenWorkNotes = new Set<string>();
            const rawWorkLogs = [...displayProcessLogs, ...tailLogs];
            const hasStructuredWork = rawWorkLogs.some((l: any) =>
              WORKFLOW_COUNT_TYPES.has(l.type) && !HIDDEN_HELPER_TYPES.has(l.type)
            );

            const segments: { type: 'thoughts' | 'steering' | 'ask_user'; logs?: any[]; log?: any }[] = [];
            let currentThoughts: any[] = [];

            rawWorkLogs.forEach(log => {
              if (log.type === 'steering_received') {
                if (currentThoughts.length > 0) {
                  segments.push({ type: 'thoughts', logs: currentThoughts });
                  currentThoughts = [];
                }
                segments.push({ type: 'steering', log });
              } else if (log.type === 'ask_user') {
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
                }
                if (log.type === 'work_note') {
                  const text = String(log.text || '').trim().toLowerCase();
                  if (!text) isValid = false;
                  else if (isWorkNoteDisplayNoise(log.text)) isValid = false;
                  else {
                    const key = `${ log.subAgent || '' }::${ text }`;
                    if (seenWorkNotes.has(key)) isValid = false;
                    seenWorkNotes.add(key);
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
                key={`group-${ groupIdx }`}
                id={`message-${ groupIdx }`}
                data-live={isThinkingTurn ? 'true' : undefined}
                className="eterx-chat-message-group w-full flex flex-col mb-8 scroll-m-20 relative"
              >
                {segments.map((seg, segIdx) => {
                  if (seg.type === 'steering') {
                    return <SteeringFeedCard key={`steer-${groupIdx}-${segIdx}`} log={seg.log} />;
                  }
                  if (seg.type === 'ask_user') {
                    return (
                      <AskUserPrompt
                        key={`ask-${ groupIdx }-${ segIdx }`}
                        question={seg.log.question}
                        mode={seg.log.mode || 'text'}
                        options={seg.log.options || []}
                        context={seg.log.context}
                        defaultValue={seg.log.defaultValue}
                        urgent={seg.log.urgent}
                        timestamp={seg.log.timestamp}
                        onAnswer={(answer) => {
                          console.log('[ChatFeed] User answered ask_user:', answer);
                        }}
                      />
                    );
                  }
                  
                  // 'thoughts'
                  const isLastThoughts = segIdx === segments.length - 1 || segments.slice(segIdx + 1).every(s => s.type !== 'thoughts');
                  const stepCount = (seg.logs || []).filter((l: any) =>
                    WORKFLOW_COUNT_TYPES.has(l.type) && !HIDDEN_HELPER_TYPES.has(l.type)
                  ).length + (isLastThoughts ? liveCommandLogs.length : 0);

                  if (stepCount === 0 && (seg.logs || []).length === 0 && !(isThinkingTurn && isLastThoughts)) return null;

                  return (
                    <ThoughtSequence
                      key={`thoughts-${groupIdx}-${segIdx}`}
                      logs={seg.logs || []}
                      liveLogs={isLastThoughts ? liveCommandLogs : []}
                      isThinking={isThinkingTurn && isLastThoughts}
                      isLast={groupIdx === groups.length - 1 && isLastThoughts}
                      hasAnswer={!!displayFinalAnswer && isLastThoughts}
                      stepCount={stepCount}
                      turnStartedAt={turnStartedAt}
                      turnEndedAt={displayFinalAnswer?.endTime ?? displayFinalAnswer?.timestamp ?? null}
                    />
                  );
                })}

                {/* Render Live Action Chips */}
                <AnimatePresence>
                  {liveCommandLogs.length > 0 && (
                    <>
                      {liveCommandLogs.length === 1 ? (
                        <LiveActionChip key={`live-cmd-${ groupIdx }-0`} text={liveCommandLogs[0].text} secondary={liveCommandLogs[0].secondary} isActive={isThinkingTurn} inCard={false} />
                      ) : (
                        <motion.div
                          key={`live-actions-${ groupIdx }`}
                          layout
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -3 }}
                          transition={{ duration: 0.18, ease: 'easeOut' }}
                          className="eterx-live-action-card mb-4 mt-1 overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#1A1A1A]/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_16px_rgba(0,0,0,0.22)]"
                        >
                          {liveCommandLogs.map((cmd: any, cmdIdx: number) => (
                            <div key={`live-cmd-wrap-${ groupIdx }-${ cmdIdx }`} className={`eterx-live-action-row ${cmdIdx > 0 ? 'border-t border-white/[0.055]' : ''}`}>
                              <LiveActionChip key={`live-cmd-${ groupIdx }-${ cmdIdx }`} text={cmd.text} secondary={cmd.secondary} isActive={isThinkingTurn} inCard={true} />
                            </div>
                          ))}
                        </motion.div>
                      )}
                    </>
                  )}
                </AnimatePresence>

                {displayFinalAnswer && (
                  <div className="eterx-assistant-answer w-full group/assistant mt-0 [&_.professional-thought>*:first-child]:!mt-0">
                    <div className="relative group/thought">
                      {/* Live typing uses the same renderer so Mermaid, math, and tables appear as soon as Markdown is complete. */}
                      {isAnswerActivelyTyping ? (
                        <div className="eterx-assistant-answer-body eterx-assistant-live-text text-[15.5px] leading-[1.85] text-[#C4C1BC] font-sans relative">
                          <ProfessionalThought
                            text={displayFinalAnswer.text}
                            isLatest={groupIdx === groups.length - 1}
                            isThinking={isAnswerActivelyTyping}
                            variant="answer"
                            updatedAt={displayFinalAnswer.timestamp}
                          />
                        </div>
                      ) : (
                        <div className="eterx-assistant-answer-body text-[15.5px] leading-[1.85] text-[#C4C1BC] font-sans relative">
                          <ProfessionalThought
                            text={displayFinalAnswer.text}
                            isLatest={groupIdx === groups.length - 1}
                            isThinking={isThinkingTurn}
                            variant="answer"
                            suffix={
                              <div className="inline-flex items-center gap-2 ml-2 align-middle mt-[-2px]">
                                <div className="flex items-center gap-0 opacity-0 group-hover/thought:opacity-100 transition-opacity duration-200">
                                  <NakedCopyButton content={displayFinalAnswer.text} />
                                  <Tooltip text="Import to chat">
                                    <button className="p-[6px] text-[#555350] hover:text-[#E8E6E3] transition-colors rounded-md hover:bg-white/[0.06]">
                                      <MessageSquarePlus className="w-[15px] h-[15px]" />
                                    </button>
                                  </Tooltip>
                                </div>
                              </div>
                            }
                          />
                        </div>
                      )}

                    </div>
                  </div>
                )}

              </div>
            );
          })}

          <div ref={messagesEndRef} className="h-[2px]" />
        </div>
      )}
      </div>
      </div>
      <AnimatePresence>
        {previewUserMessage && (
          <motion.div
            className={`fixed bottom-0 right-0 top-0 z-[80] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-[2px] ${ sidebarOpen ? 'left-0 md:left-[280px]' : 'left-0 md:left-[68px]' }`}
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
              className={`eterx-prompt-preview-dialog relative max-h-[82vh] w-[calc(100vw-32px)] overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#1D1D1D] shadow-[0_28px_90px_rgba(0,0,0,0.55)] sm:w-[calc(100vw-96px)] ${ isCompressed ? 'max-w-[720px]' : 'max-w-[920px]' }`}
              initial={{ opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setPreviewUserMessage(null)}
                className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.09] bg-[#2A2A2A]/95 text-[#B9B6B0] shadow-[0_12px_30px_rgba(0,0,0,0.42)] transition-all duration-200 hover:bg-[#343434] hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
                aria-label="Close prompt preview"
              >
                <Minimize2 className="h-4 w-4" strokeWidth={2.2} />
              </button>
              <div
                ref={previewScrollRef}
                className="max-h-[82vh] overflow-y-auto eterx-scrollbar eterx-prompt-preview-scroll px-6 py-8 pr-8 sm:px-8 sm:py-9 sm:pr-10"
              >
                <div className="eterx-prompt-preview-text whitespace-pre-wrap break-words text-[16px] leading-[1.75] text-[#C4C1BC] [overflow-wrap:anywhere]">
                  {previewUserMessage.text}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
