import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { Copy, RefreshCw, ChevronDown, FileText, Check, Clock, MessageSquarePlus, Activity, Minimize2, CircleStop, TriangleAlert } from 'lucide-react';
import { ThinkingProcess, ProfessionalThought } from '../chat/thought-sequence';
import { AskUserPrompt } from '../chat/ask-user-prompt';
import { Tooltip } from '../ui/tooltip';
import { Shimmer } from '../ui/shimmer';
import { notifyAgentFaceTraceLog } from './agent-face-controller';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, normalizeMarkdownForRendering, remarkPlugins, rehypePlugins } from './markdown-renderer';
import { LocalFileLinkChip, decodeLocalFileHref } from './local-file-link';
import { areLikelySameFeedActionLifecycle, ensureStableFeedPresentationIds, getFeedActionLifecycleCandidateKeys, getFeedActionSingletonIdentity, haveConflictingFeedActionInvocations, isFeedTraceExplicitlySettled, isFeedTraceOpen, isFeedTurnBoundary, isSettledAnswerTrace, isTerminalWorkTrace, isTurnWorkActive, mergeUserTurnBoundaries, orderFeedTimelineLogs, recoverMissingUserTurnBoundaries, settleFeedTraceLifecycles, shouldRenderContextCompactionEvent } from '../../lib/chat-feed-lifecycle';
import { shouldRenderThoughtStream } from '../../lib/thought-stream-lifecycle';
import { isLiveUserVisibleTrace } from '../../lib/agent/trace-visibility';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { buildFilePreviewUrl } from '../../lib/path-utils';
import { normalizeLifecycleTimestamp, useLifecycleElapsedMs } from './lifecycle-clock';

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
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
  .eterx-chat-feed[data-compressed="false"] .eterx-chat-feed-content {
    width: 100%;
    max-width: var(--eterx-reference-composer-max) !important;
  }
  .eterx-chat-feed[data-agent-builder="true"] .eterx-thinking-process-stack {
    gap: 10px;
  }
  .eterx-chat-feed .eterx-professional-thought {
    will-change: auto;
    transform: none;
  }
  .eterx-chat-feed .eterx-professional-thought.eterx-reveal-active {
    will-change: opacity;
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
  'exploration',
  'file_edit',
  'communication',
  'sub_agent_spawn',
  'progress',
  'browser',
  'task_plan',
]);
const HIDDEN_HELPER_TYPES = new Set(['answer', 'ask_user', 'file_preview', 'console_output', 'html_preview']);
const NARRATIVE_TRACE_TYPES = new Set(['thought_stream', 'work_note', 'autonomy_proxy_status']);
const getFeedNarrativeOwner = (log: any): string => {
  const explicitIdentity = String(log?.subAgentChatId || log?.subAgentId || log?.subAgent || '').trim();
  if (explicitIdentity) return `sub:${ explicitIdentity }`;
  const type = String(log?.type || '').trim().toLowerCase();
  const explicitlyChild = log?.isSubAgent === true ||
    Boolean(log?.terminalTask) ||
    String(log?.agentRole || '').trim().toLowerCase() === 'sub_agent' ||
    /^sub_agent_|^inter_agent_/.test(type);
  const agentName = String(log?.agentName || '').trim();
  return explicitlyChild && agentName ? `sub:${ agentName }` : 'main';
};
const RENDERABLE_TIMELINE_TYPES = new Set([
  'thought_stream',
  'work_note',
  'command',
  'tool_call',
  'exploration',
  'file_edit',
  'progress',
  'browser',
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
  'status',
  'run_status',
  'agent_status',
  'error',
  'done',
  'task_plan',
]);
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

const getVisibleUserBoundaryText = (log: any): string => {
  const text = [log?.text, log?.prompt, log?.task, log?.message]
    .map(value => String(value || '').trim())
    .find(Boolean);
  if (text) return text;
  return 'Request';
};

const isHiddenRecoveredUserBoundary = (log: any): boolean => Boolean(
  log?.type === 'user_action' &&
  log?._recoveredBoundary === true &&
  log?._hiddenRecoveredBoundary === true
);

const isProviderBootstrapTrace = (log: any): boolean => {
  if (!log) return false;
  if (
    log._connection === true ||
    String(log.noteId || '').trim() === 'eterx-agent-connection'
  ) return true;
  const type = String(log.type || '').trim().toLowerCase();
  if (!['work_note', 'progress', 'status'].includes(type)) return false;
  // Older persisted chats predate the explicit connection marker. Their
  // provider bootstrap was saved as a tiny narration line such as
  // "OpenRouter is starting". Match only that complete infrastructure phrase
  // so normal model prose containing the words "is starting" stays visible.
  const text = String(log.text || log.secondary || '').replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} ._+\-/:()]{0,70}\s+is\s+(?:starting|connecting)\.?$/iu.test(text);
};

const normalizeInternalUserActionLogs = (logs: any[]) => {
  return logs.reduce<any[]>((next, log) => {
    // Provider/model connection telemetry is represented by the live Working
    // state. It is not agent narration and must never become a permanent
    // "OpenRouter is starting" (or equivalent provider-name) transcript row.
    if (isProviderBootstrapTrace(log)) return next;
    if (log?.type === 'answer' && /\[LIVE GUIDANCE\b/i.test(String(log.text || ''))) {
      const rawText = String(log.text || '');
      const envelopePattern = /\[LIVE GUIDANCE\s+\d+(?:\s*\|\s*id=([^\]|]+))?(?:\s*\|\s*source=([^\]]+))?\]\s*([\s\S]*?)\s*\[\/LIVE GUIDANCE\]/gi;
      let match: RegExpExecArray | null;
      let ordinal = 0;
      while ((match = envelopePattern.exec(rawText)) !== null) {
        const text = String(match[3] || '').trim();
        if (!text) continue;
        const steeringId = String(match[1] || '').trim() || `recovered-${ String(log.answerId || log._traceIdx || log.timestamp || 'guidance') }-${ ordinal }`;
        next.push({
          ...log,
          type: 'steering_received',
          text,
          steeringId,
          steeringIds: [steeringId],
          source: String(match[2] || 'human').trim() || 'human',
          steeringSource: String(match[2] || 'human').trim() || 'human',
          turnId: `steering-turn-${ steeringId }`,
          timestamp: Number(log.timestamp || log.startTime || Date.now()) + ordinal,
          answerId: undefined,
          isStreaming: false,
          isLiveTyping: false,
          _recoveredGuidanceEnvelope: true,
        });
        ordinal += 1;
      }
      const remainingAnswer = rawText.replace(envelopePattern, '').trim();
      if (remainingAnswer) next.push({ ...log, text: remainingAnswer });
      return next;
    }
    if (log?.type !== 'user_action') {
      next.push(log);
      return next;
    }
    const rawText = String(log.text || '');
    const match = rawText.match(AGENT_BUILDER_INTERNAL_REQUEST_PATTERN);
    if (!match) {
      next.push(log);
      return next;
    }
    // Unwrap the internal envelope but keep the boundary. Run IDs can be
    // reused, so discarding this row merely because another visible boundary
    // shared its run hid genuine follow-up queries.
    next.push({
      ...log,
      text: String(match[1] || '').trim(),
      _internalEnvelopeBoundary: true,
    });
    return next;
  }, []);
};

const getFeedPresentationEventId = (log: any): string => {
  const preserved = String(log?._feedPresentationId || '').trim();
  if (preserved) return preserved;
  const perEvent = log?.toolCallId ?? log?.traceId ?? log?.id ?? log?._traceIdx ?? null;
  if (perEvent !== null && perEvent !== undefined && String(perEvent).trim()) return String(perEvent);
  const streamId = String(log?.streamId || '').trim();
  if (!streamId) return '';
  const timeAnchor = log?.streamStartedAt ?? log?.startTime ?? log?.timestamp ?? '';
  const actionAnchor = normalizeTraceText(
    log?.command || log?.filepath || log?.filename || log?.secondary || log?.text || '',
  );
  return `${ streamId }|${ String(timeAnchor) }|${ actionAnchor }`;
};

const mergeDuplicateFeedLog = (previous: any, incoming: any) => {
  if (previous?.type === 'user_action' && incoming?.type === 'user_action') {
    return mergeUserTurnBoundaries(previous, incoming);
  }
  const previousText = String(previous?.text || '');
  const incomingText = String(incoming?.text || '');
  let text = incomingText.length >= previousText.length ? incomingText : previousText;
  const previousStart = Number(previous?.startTime || previous?.timestamp || 0);
  const incomingStart = Number(incoming?.startTime || incoming?.timestamp || 0);
  const previousEnd = Number(previous?.endTime || previous?.timestamp || 0);
  const incomingEnd = Number(incoming?.endTime || incoming?.timestamp || 0);
  const previousClosed = isFeedTraceExplicitlySettled(previous);
  const previousOpen = isFeedTraceOpen(previous);
  const incomingOpen = isFeedTraceOpen(incoming);
  const previousNarrativeId = String(previous?.noteId || previous?.thoughtId || previous?.streamId || '').trim();
  const incomingNarrativeId = String(incoming?.noteId || incoming?.thoughtId || incoming?.streamId || '').trim();
  const previousNarrativeOwner = getFeedNarrativeOwner(previous);
  const incomingNarrativeOwner = getFeedNarrativeOwner(incoming);
  const sameNarrativeStream = Boolean(
    NARRATIVE_TRACE_TYPES.has(String(previous?.type || '')) &&
    NARRATIVE_TRACE_TYPES.has(String(incoming?.type || '')) &&
    previousNarrativeId &&
    previousNarrativeId === incomingNarrativeId &&
    previousNarrativeOwner === incomingNarrativeOwner
  );
  const incomingSettledNarrative = Boolean(
    NARRATIVE_TRACE_TYPES.has(String(incoming?.type || '')) &&
    !incomingOpen
  );
  // The settled payload is authoritative for its own narrative stream, even
  // when it is a concise rewrite of a longer provisional snapshot.
  if (sameNarrativeStream && incomingSettledNarrative && incomingText) text = incomingText;
  const cancelTraceIndex = Number(previous?._cancelTraceIdx);
  const incomingTraceIndex = Number(incoming?._traceIdx);
  const resolvesCancelledWorkNote = Boolean(
    previous?._streamingCancelled === true &&
    incoming?.type === 'work_note' &&
    incoming?._streamingCancelled !== true &&
    incomingSettledNarrative &&
    sameNarrativeStream &&
    (
      !Number.isFinite(cancelTraceIndex) ||
      !Number.isFinite(incomingTraceIndex) ||
      incomingTraceIndex >= cancelTraceIndex
    )
  );
  const preserveClosedLifecycle = previousClosed && incomingOpen;
  const incomingClosesLifecycle = previousOpen && !incomingOpen && (
    incoming?.type === 'answer' ||
    ['thought_stream', 'work_note', 'autonomy_proxy_status', 'command', 'tool_call', 'exploration', 'file_edit', 'progress', 'browser', 'communication', 'console_output', 'sub_agent_action'].includes(String(incoming?.type || ''))
  );
  const previousStatus = String(previous?.status || '').trim().toLowerCase();
  const incomingStatus = String(incoming?.status || '').trim().toLowerCase();
  const settledStatus = ['running', 'working', 'pending', 'streaming', 'spawning', 'started'].includes(previousStatus)
    ? 'completed'
    : previous?.status;
  const incomingSettledStatus = ['running', 'working', 'pending', 'streaming', 'spawning', 'started'].includes(incomingStatus || previousStatus)
    ? 'completed'
    : incoming?.status || settledStatus;
  const narrativeRank = (type: any) =>
    type === 'autonomy_proxy_status' ? 3 : type === 'work_note' ? 2 : type === 'thought_stream' ? 1 : 0;
  const preferredType = narrativeRank(previous?.type) > narrativeRank(incoming?.type)
    ? previous.type
    : incoming?.type;
  return {
    ...previous,
    ...incoming,
    _feedPresentationId: getFeedPresentationEventId(previous) || getFeedPresentationEventId(incoming) || undefined,
    _feedBoundaryId: previous?._feedBoundaryId || incoming?._feedBoundaryId || undefined,
    _feedBoundaryOrder: previous?._feedBoundaryOrder ?? incoming?._feedBoundaryOrder,
    _feedEventOrder: previous?._feedEventOrder ?? incoming?._feedEventOrder,
    type: preferredType,
    text,
    _originTraceIdx: previous?._originTraceIdx ?? previous?._traceIdx ?? incoming?._originTraceIdx ?? incoming?._traceIdx,
    _traceIdx: previous?._traceIdx ?? incoming?._traceIdx,
    _pollIdx: incoming?._pollIdx ?? incoming?._traceIdx ?? previous?._pollIdx ?? previous?._traceIdx,
    startTime: previousStart > 0 && incomingStart > 0
      ? Math.min(previousStart, incomingStart)
      : previousStart || incomingStart || undefined,
    endTime: (preserveClosedLifecycle ? previousEnd || incomingEnd : Math.max(previousEnd, incomingEnd)) || undefined,
    ...(incomingClosesLifecycle
      ? {
        isStreaming: false,
        isLiveTyping: false,
        isLive: false,
        isDelta: false,
        streamState: 'closed',
        status: incomingSettledStatus,
      }
      : {}),
    ...(preserveClosedLifecycle
      ? {
        timestamp: previous?.timestamp ?? previous?.endTime ?? incoming?.timestamp,
        isStreaming: false,
        isLiveTyping: false,
        isLive: false,
        streamState: 'closed',
        status: settledStatus,
      }
      : {}),
    ...(resolvesCancelledWorkNote
      ? {
        _streamingCancelled: undefined,
        _cancelTraceIdx: undefined,
        _cancelledAt: undefined,
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

// The transport is incremental, but reconnect/catch-up frames can still be
// temporarily thinner than the frame already painted. Treat a turn's visible
// work as a monotonic presentation ledger: an existing event may be enriched
// or settled in place, but absence from one later snapshot is not a retraction.
// Explicit cancellation is reconciled upstream into a closed lifecycle, so it
// remains an update to the same row instead of requiring destructive removal.
const getLandedTurnEventKeys = (log: any): string[] => {
  if (!log || log.type === 'answer') return [];
  const normalizedType = log.type === 'tool_call' ? 'command' : String(log.type || 'event');
  const owner = getFeedNarrativeOwner(log);
  const turnScope = String(log?._feedBoundaryId || log?.turnId || log?.runId || 'unscoped').trim();
  const buildKeys = (candidates: Array<[string, unknown]>) => candidates
    .map(([kind, value]) => {
      const normalized = String(value ?? '').trim();
      return normalized ? `${ normalizedType }:${ owner }:${ kind }:${ normalized }` : '';
    })
    .filter(Boolean);
  // Never register a weak stream/task alias beside a real event identity.
  // Providers can reuse those transport containers for several genuine
  // actions in one turn, which must remain separate rows.
  const strongKeys = buildKeys([
    // A cumulative registry snapshot receives a new polling cursor while its
    // immutable origin stays fixed. Legacy rows use their first trace index as
    // that origin, allowing the mounted monotonic ledger to settle the row in
    // place instead of retaining both the live and final copies.
    ['origin', log._originTraceIdx ?? log._traceIdx],
    ['singleton', getFeedActionSingletonIdentity(log)
      ? `${ turnScope }:${ getFeedActionSingletonIdentity(log) }`
      : ''],
    ['presentation', log._feedPresentationId],
    ['tool', log.toolCallId],
    ['trace', log.traceId],
    ['event', log.id],
    ['note', log.noteId],
    ['thought', log.thoughtId],
    ['response', log.responseKey],
    ['message', log.messageId],
    ['compaction', log.compactionId],
  ]);
  const isActionLifecycle = [
    'command', 'tool_call', 'exploration', 'file_edit', 'browser',
    'communication', 'sub_agent_action',
  ].includes(String(log?.type || ''));
  const actionIdentity = [
    log?.command,
    log?.tool || log?.toolName || log?.name,
    log?.filepath || log?.filename,
    log?.query || log?.searchQuery,
    log?.secondary,
    log?.text,
  ].map(value => normalizeTraceText(value)).join('|');
  const actionReplayKeys = isActionLifecycle && Number(log?.startTime || 0) > 0
    ? [
      `${ normalizedType }:${ owner }:turn:${ turnScope }:replay:${ actionIdentity }:` +
      `${ String(log.startTime) }:${ String(log.endTime || '') }:${ String(log.durationMs || '') }:` +
      `${ String(log.status || '') }:${ String(log.exitCode ?? '') }`,
    ]
    : [];
  if (strongKeys.length > 0) return Array.from(new Set([...strongKeys, ...actionReplayKeys]));

  // A background task/stream is a transport container, not an event ID. Scope
  // weak aliases by their owning query, time anchor and rendered operation so
  // two commands carried by the same task can never overwrite one another in
  // the monotonic landed ledger.
  const transportAnchor = [
    turnScope,
    String(log?.streamStartedAt ?? log?.startTime ?? log?.timestamp ?? ''),
    actionIdentity,
    normalizedType === 'console_output' ? normalizeTraceText(log?.command) : '',
  ].join('|');
  const transportKeys = buildKeys([
    ['stream', log.streamId ? `${ String(log.streamId) }|${ transportAnchor }` : ''],
    ['task', (log.taskId || log.backgroundTaskId)
      ? `${ String(log.taskId || log.backgroundTaskId) }|${ transportAnchor }`
      : ''],
    ['index', log._traceIdx],
  ]);
  if (transportKeys.length > 0) return Array.from(new Set([...transportKeys, ...actionReplayKeys]));

  const timestamp = log.streamStartedAt ?? log.startTime ?? log.timestamp ?? log.endTime;
  if (timestamp === undefined || timestamp === null || !String(timestamp).trim()) return [];
  const content = normalizeTraceText(
    log.text || log.question || log.command || log.filepath || log.filename || log.secondary || log.detail || '',
  );
  return [`${ normalizedType }:${ owner }:time:${ String(timestamp) }:${ content }`];
};

const reconcileLandedTurnLogs = (landedLogs: any[], incomingLogs: any[]): any[] => {
  const incomingAnswers = incomingLogs.filter(log => log?.type === 'answer');
  const isPromotedAnswerLifecycle = (log: any) => log?.type === 'work_note' && incomingAnswers.some(answer => {
    const presentationId = String(log?._feedPresentationId || '').trim();
    const answerPresentationId = String(answer?._feedPresentationId || '').trim();
    if (presentationId && answerPresentationId) return presentationId === answerPresentationId;
    const answerId = String(answer?.answerId || '').trim();
    return Boolean(answerId && [log?.answerId, log?.noteId, log?.id].map(String).includes(answerId));
  });
  const retainedLanded = (Array.isArray(landedLogs) ? landedLogs : [])
    .filter(log => log?.type !== 'answer' && !isPromotedAnswerLifecycle(log));
  const reconciled: any[] = [];
  const identityIndexes = new Map<string, number>();
  const actionCandidateIndexes = new Map<string, Set<number>>();
  const findIdentityIndex = (log: any, keys: string[]): number | undefined => {
    for (const key of keys) {
      const index = identityIndexes.get(key);
      if (index === undefined) continue;
      // A provider may reuse a generic event/presentation id for parallel
      // calls. Explicit invocation identities are authoritative and must veto
      // that weak collision or one card disappears into the other.
      if (haveConflictingFeedActionInvocations(reconciled[index], log)) continue;
      return index;
    }
    return undefined;
  };
  const registerActionCandidate = (log: any, index: number) => {
    getFeedActionLifecycleCandidateKeys(log).forEach(key => {
      const indexes = actionCandidateIndexes.get(key) || new Set<number>();
      indexes.add(index);
      actionCandidateIndexes.set(key, indexes);
    });
  };
  const findActionCandidate = (log: any): number | undefined => {
    const candidates = new Set<number>();
    getFeedActionLifecycleCandidateKeys(log).forEach(key => {
      actionCandidateIndexes.get(key)?.forEach(index => candidates.add(index));
    });
    for (const index of candidates) {
      if (areLikelySameFeedActionLifecycle(reconciled[index], log)) return index;
    }
    return undefined;
  };
  retainedLanded.forEach((log) => {
    const keys = getLandedTurnEventKeys(log);
    const existingIndex = findIdentityIndex(log, keys) ?? findActionCandidate(log);
    if (existingIndex !== undefined) {
      reconciled[existingIndex] = mergeDuplicateFeedLog(reconciled[existingIndex], log);
      getLandedTurnEventKeys(reconciled[existingIndex])
        .forEach(key => identityIndexes.set(key, existingIndex));
      registerActionCandidate(reconciled[existingIndex], existingIndex);
      return;
    }
    const nextIndex = reconciled.length;
    reconciled.push(log);
    keys.forEach(key => identityIndexes.set(key, nextIndex));
    registerActionCandidate(log, nextIndex);
  });

  incomingLogs.forEach((log) => {
    // Answers have their own explicit latch below. Keeping them in this
    // monotonic work ledger would duplicate every streaming render and would
    // prevent a provisional answer from being promoted out of Work cleanly.
    if (log?.type === 'answer') return;
    const keys = getLandedTurnEventKeys(log);
    const existingIndex = findIdentityIndex(log, keys) ?? findActionCandidate(log);
    if (existingIndex === undefined) {
      const nextIndex = reconciled.length;
      reconciled.push(log);
      keys.forEach(key => identityIndexes.set(key, nextIndex));
      registerActionCandidate(log, nextIndex);
      return;
    }

    reconciled[existingIndex] = mergeDuplicateFeedLog(reconciled[existingIndex], log);
    getLandedTurnEventKeys(reconciled[existingIndex])
      .forEach(key => identityIndexes.set(key, existingIndex));
    registerActionCandidate(reconciled[existingIndex], existingIndex);
  });

  const combined = [...reconciled, ...incomingAnswers];
  const fallbackOrder = orderFeedTimelineLogs(combined);
  const presentationOrderIdentity = (log: any, fallback: number) => String(
    log?._feedPresentationId ||
    log?.toolCallId ||
    log?.traceId ||
    log?.id ||
    log?.answerId ||
    log?.noteId ||
    log?.thoughtId ||
    log?.responseKey ||
    log?.messageId ||
    (log?._traceIdx !== undefined && log?._traceIdx !== null ? `${ String(log.type || 'event') }:${ String(log._traceIdx) }` : '') ||
    `${ String(log?.type || 'event') }:${ String(log?.startTime ?? log?.timestamp ?? fallback) }:${ normalizeTraceText(log?.text || log?.secondary || '') }`
  );
  const fallbackIndexes = new Map<string, number>();
  fallbackOrder.forEach((log, index) => {
    const key = presentationOrderIdentity(log, index);
    if (!fallbackIndexes.has(key)) fallbackIndexes.set(key, index);
  });
  return combined.slice().sort((left, right) => {
    const leftOrder = Number(left?._feedEventOrder);
    const rightOrder = Number(right?._feedEventOrder);
    const leftHasOrder = Number.isFinite(leftOrder);
    const rightHasOrder = Number.isFinite(rightOrder);
    if (leftHasOrder && rightHasOrder && leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (leftHasOrder !== rightHasOrder) return leftHasOrder ? -1 : 1;
    return (
      fallbackIndexes.get(presentationOrderIdentity(left, 0)) ?? 0
    ) - (
      fallbackIndexes.get(presentationOrderIdentity(right, 0)) ?? 0
    );
  });
};

const dedupeFeedLogs = (logs: any[]) => {
  const deduped: any[] = [];
  const stableIndexes = new Map<string, number>();
  const userBoundaryIndexes = new Map<string, number>();
  const userBoundaryTurnIndexes = new Map<string, number>();
  const liveUserTextIndexes = new Map<string, number>();
  const steeringIndexes = new Map<string, number>();
  const actionReplayIndexes = new Map<string, Set<number>>();
  let semanticIndexes = new Map<string, number>();
  let boundaryScope = 0;

  const explicitBoundaryIdentity = (log: any): string => String(
    log?.id || log?.messageId || log?.traceId || log?.steeringId || ''
  ).trim();
  const hasConflictingBoundaryIdentity = (left: any, right: any): boolean => {
    const leftIdentity = explicitBoundaryIdentity(left);
    const rightIdentity = explicitBoundaryIdentity(right);
    return Boolean(leftIdentity && rightIdentity && leftIdentity !== rightIdentity);
  };
  const hasMeaningfulTurnContent = (entries: any[]): boolean => entries.some(candidate =>
    candidate &&
    !isFeedTurnBoundary(candidate) &&
    ![
      'model_selection',
      'model_usage',
      'context_usage',
      'answer_cancel',
      'work_note_cancel',
    ].includes(String(candidate.type || ''))
  );

  const getStableKeys = (log: any, visualScope: number): string[] => {
    const isNarrativeTrace = NARRATIVE_TRACE_TYPES.has(String(log?.type || ''));
    const narrativeId = isNarrativeTrace
      ? log?.noteId ?? log?.thoughtId ?? null
      : null;
    const stableType = isNarrativeTrace
      ? 'narrative'
      : log?.type === 'tool_call' ? 'command' : String(log?.type || '');
    const narrativeOwner = isNarrativeTrace ? getFeedNarrativeOwner(log) : '';
    const chatScope = String(log?.ownerChatId || log?.chatId || 'chat').trim();
    const turnId = String(log?.turnId || '').trim();
    const runId = String(log?.runId || '').trim();
    // Ownership ordering has already resolved provider aliases to one stable
    // visual boundary. Use it for all later identity keys so an open action
    // and its settled replay cannot survive as two cards merely because one
    // transport path used the worker turn and another used the root turn.
    const resolvedBoundaryScope = String(log?._feedBoundaryId || '').trim();
    const traceScopes = [resolvedBoundaryScope || turnId || runId].filter(Boolean);
    const boundaryEventIdentity = isFeedTurnBoundary(log)
      ? String(log?.id || log?.messageId || log?.traceId || log?.steeringId || '').trim()
      : '';
    const eventScopes = isFeedTurnBoundary(log)
      ? [boundaryEventIdentity
          ? `boundary-event:${ boundaryEventIdentity }`
          : `boundary:${ visualScope }`]
      : traceScopes.length > 0
        ? traceScopes.map(scope => `turn:${ scope }`)
        : [`visual:${ visualScope }`];
    // Immutable transport IDs identify one event even when a late polling
    // snapshot was temporarily sorted beside the next query. Provider IDs are
    // reused by later runs, so immutable identity is chat + turn scoped. Run
    // identity is only the fallback for legacy events without a turn ID; a
    // long-lived run may legitimately contain several separate requests.
    const eventKeys = eventScopes.flatMap(eventScope => [
      ['presentationId', log?._feedPresentationId],
      ['toolCallId', log?.toolCallId],
      ['streamId', isNarrativeTrace && narrativeId
        ? null
        : log?.streamId
          ? `${ String(log.streamId) }|${ String(log.streamStartedAt ?? log.startTime ?? log.timestamp ?? '') }|${ normalizeTraceText(log.command || log.filepath || log.filename || log.secondary || log.text || '') }`
          : null],
      ['narrativeId', narrativeId],
      ['answerId', log?.answerId],
      ['responseKey', log?.responseKey],
      ['messageId', log?.messageId],
      ['traceId', log?.traceId],
      ['steeringId', log?.steeringId],
      ['id', log?.id],
    ].map(([field, value]) => {
      const normalized = String(value ?? '').trim();
      return normalized
        ? `event:${ chatScope }::${ eventScope }::${ stableType }::${ narrativeOwner }::${ field }:${ normalized }`
        : '';
    }).filter(Boolean));
    const traceIndexes = Array.from(new Set([
      log?._originTraceIdx,
      log?._traceIdx,
    ]
      .filter(value => value !== undefined && value !== null && String(value).trim())
      .map(value => String(value).trim())));
    const traceKeys = traceIndexes.flatMap(traceIndex =>
      (traceScopes.length > 0 ? traceScopes : [`visual:${ visualScope }`]).map(scope =>
        `index:${ chatScope }::${ scope }::${ stableType }::${ traceIndex }`
      )
    );
    const isActionLifecycle = [
      'command', 'tool_call', 'exploration', 'file_edit', 'browser',
      'communication', 'sub_agent_action',
    ].includes(String(log?.type || ''));
    const startedAt = Number(log?.startTime || 0);
    const actionReplayKeys = isActionLifecycle && startedAt > 0
      ? eventScopes.map(eventScope => {
        const content = [
          log?.command,
          log?.tool || log?.toolName || log?.name,
          log?.filepath || log?.filename,
          log?.query || log?.searchQuery,
          log?.secondary,
          log?.text,
        ].map(value => normalizeTraceText(value)).join('|');
        return `replay:${ chatScope }::${ eventScope }::${ stableType }::${ content }::${ startedAt }::` +
          `${ String(log?.endTime || '') }::${ String(log?.durationMs || '') }::${ String(log?.status || '') }::${ String(log?.exitCode ?? '') }`;
      })
      : [];
    const singletonIdentity = getFeedActionSingletonIdentity(log);
    const singletonKeys = singletonIdentity
      ? eventScopes.map(eventScope =>
        `singleton:${ chatScope }::${ eventScope }::${ stableType }::${ singletonIdentity }`
      )
      : [];
    return Array.from(new Set([...eventKeys, ...traceKeys, ...actionReplayKeys, ...singletonKeys]));
  };

  logs.forEach((log: any) => {
    if (!log) return;
    const candidateBoundaryScope = boundaryScope + (isFeedTurnBoundary(log) ? 1 : 0);
    const runId = String(log.runId || log.turnId || '').trim();
    const turnId = String(log.turnId || '').trim();
    const stableKeys = getStableKeys(log, candidateBoundaryScope);
    // A provider/transport can reuse a generic id or messageId across several
    // real user turns (especially queued follow-ups on one long-lived run).
    // Never let that weak identity enter the generic event deduper: doing so
    // merged a later query into the first boundary before the guarded
    // owner/text/time reconciliation below could run, and all work following
    // the removed boundary then appeared inside (or disappeared with) the old
    // turn. Turn boundaries have their own conservative reconciliation paths.
    const matchedStableKey = isFeedTurnBoundary(log)
      ? undefined
      : stableKeys.find(key => {
        const index = stableIndexes.get(key);
        return index !== undefined &&
          !haveConflictingFeedActionInvocations(deduped[index], log);
      });
    let likelyReplayIndex = -1;
    const needsActionReplayFallback = Boolean(
      getFeedActionSingletonIdentity(log) ||
      ([
        'command', 'tool_call', 'exploration', 'file_edit', 'browser',
        'communication', 'sub_agent_action',
      ].includes(String(log?.type || '')) && Number(log?.durationMs || 0) > 0)
    );
    if (!matchedStableKey && needsActionReplayFallback) {
      const candidateIndexes = new Set<number>();
      getFeedActionLifecycleCandidateKeys(log).forEach(key => {
        actionReplayIndexes.get(key)?.forEach(index => candidateIndexes.add(index));
      });
      const orderedCandidates = Array.from(candidateIndexes).sort((left, right) => right - left);
      for (const index of orderedCandidates) {
        if (areLikelySameFeedActionLifecycle(deduped[index], log)) {
          likelyReplayIndex = index;
          break;
        }
      }
    }
    const registerStableKeys = (index: number, mergedLog: any = log) => {
      Array.from(new Set([...stableKeys, ...getStableKeys(mergedLog, candidateBoundaryScope)]))
        .forEach(key => stableIndexes.set(key, index));
      getFeedActionLifecycleCandidateKeys(mergedLog).forEach(key => {
        const indexes = actionReplayIndexes.get(key) || new Set<number>();
        indexes.add(index);
        actionReplayIndexes.set(key, indexes);
      });
    };

    if (matchedStableKey || likelyReplayIndex >= 0) {
      const index = matchedStableKey
        ? stableIndexes.get(matchedStableKey)!
        : likelyReplayIndex;
      deduped[index] = mergeDuplicateFeedLog(deduped[index], log);
      registerStableKeys(index, deduped[index]);
      return;
    }

    if (log.type === 'user_action') {
      const normalizedUserText = normalizeTraceText(log.text);
      const source = String(log.source || 'human').trim().toLowerCase();
      const explicitTurnKey = turnId ? `${ turnId }::${ source }` : '';
      const priorExplicitTurnIndex = explicitTurnKey
        ? userBoundaryTurnIndexes.get(explicitTurnKey)
        : undefined;
      if (priorExplicitTurnIndex !== undefined) {
        const priorBoundary = deduped[priorExplicitTurnIndex];
        const priorText = normalizeTraceText(priorBoundary?.text);
        const compatibleTranscript = Boolean(
          priorText && normalizedUserText &&
          (priorText === normalizedUserText || priorText.startsWith(normalizedUserText) || normalizedUserText.startsWith(priorText))
        );
        const hasAssistantResponseBetween = hasMeaningfulTurnContent(
          deduped.slice(priorExplicitTurnIndex + 1),
        );
        const isTransportReconciliation = Boolean(
          priorBoundary?._traceIdx === undefined ||
          priorBoundary?._traceIdx === null ||
          log?._traceIdx === undefined ||
          log?._traceIdx === null ||
          priorBoundary?.isLive ||
          log?.isLive
        );
        // A live transcription can replace its own partial sentence. A Proxy
        // run may reuse the same turn id for several real user boundaries, so
        // an id match alone cannot collapse later messages into the first one.
        if (
          !hasConflictingBoundaryIdentity(priorBoundary, log) &&
          !hasAssistantResponseBetween &&
          compatibleTranscript &&
          isTransportReconciliation
        ) {
          deduped[priorExplicitTurnIndex] = mergeDuplicateFeedLog(priorBoundary, log);
          registerStableKeys(priorExplicitTurnIndex, deduped[priorExplicitTurnIndex]);
          if (normalizedUserText) liveUserTextIndexes.set(`${ source }::${ normalizedUserText }`, priorExplicitTurnIndex);
          return;
        }
      }
      const liveUserKey = `${ source }::${ normalizedUserText }`;
      const priorLiveIndex = liveUserTextIndexes.get(liveUserKey);
      if (normalizedUserText && priorLiveIndex !== undefined) {
        const priorBoundary = deduped[priorLiveIndex];
        const logsBetween = deduped.slice(priorLiveIndex + 1);
        const hasAssistantResponseBetween = hasMeaningfulTurnContent(logsBetween);
        const priorAt = Number(priorBoundary?.startTime || priorBoundary?.timestamp || 0);
        const incomingAt = Number(log?.startTime || log?.timestamp || 0);
        const closeInTime = priorAt > 0 && incomingAt > 0 && Math.abs(incomingAt - priorAt) <= 15_000;
        const isLiveReconciliation = Boolean(priorBoundary?.isLive || log?.isLive) && !hasAssistantResponseBetween;
        const priorTurnId = String(priorBoundary?.turnId || '').trim();
        const priorRunId = String(priorBoundary?.runId || '').trim();
        const hasExactTurnOwner = Boolean(priorTurnId && turnId && priorTurnId === turnId);
        const compatibleOwner = priorTurnId && turnId
          ? priorTurnId === turnId
          : priorRunId && runId
            ? priorRunId === runId
            : false;
        const isTransportReconciliation = Boolean(
          priorBoundary?._traceIdx === undefined ||
          priorBoundary?._traceIdx === null ||
          log?._traceIdx === undefined ||
          log?._traceIdx === null ||
          priorBoundary?.isLive ||
          log?.isLive
        );
        if (
          !hasConflictingBoundaryIdentity(priorBoundary, log) &&
          !hasAssistantResponseBetween &&
          compatibleOwner &&
          isTransportReconciliation &&
          (
            // Partial speech/live transcription is the only text-based
            // reconciliation allowed on a reused run. Ordinary repeated text
            // is a new query. An exact turn id is also safe for the brief
            // optimistic-to-persisted hand-off before any assistant activity.
            isLiveReconciliation || (hasExactTurnOwner && closeInTime)
          )
        ) {
          deduped[priorLiveIndex] = mergeDuplicateFeedLog(priorBoundary, log);
          registerStableKeys(priorLiveIndex, deduped[priorLiveIndex]);
          return;
        }
      }
      const userBoundaryKey = [
        turnId ? `turn:${ turnId }` : `run:${ runId }`,
        source,
        normalizedUserText,
      ].join('::');
      const priorBoundaryIndex = userBoundaryIndexes.get(userBoundaryKey);
      if (priorBoundaryIndex !== undefined) {
        const priorBoundary = deduped[priorBoundaryIndex];
        const priorIsOptimistic = priorBoundary?._traceIdx === undefined || priorBoundary?._traceIdx === null;
        const incomingIsOptimistic = log._traceIdx === undefined || log._traceIdx === null;
        const logsBetween = deduped.slice(priorBoundaryIndex + 1);
        const hasAssistantResponseBetween = hasMeaningfulTurnContent(logsBetween);
        const priorAt = Number(priorBoundary?.startTime || priorBoundary?.timestamp || 0);
        const incomingAt = Number(log?.startTime || log?.timestamp || 0);
        const internalEnvelopeReconciliation = Boolean(
          (priorBoundary?._internalEnvelopeBoundary || log?._internalEnvelopeBoundary) &&
          !hasAssistantResponseBetween &&
          (
            priorAt <= 0 || incomingAt <= 0 ||
            Math.abs(incomingAt - priorAt) <= 15_000
          )
        );
        // Live snapshots and persisted traces can carry different delivery
        // indices while still representing the exact same user boundary.
        // Only an optimistic/live boundary is safe to reconcile here. Two
        // persisted events with different stable IDs are distinct even when a
        // Proxy runtime reused the same turn id and text.
        if (
          !hasConflictingBoundaryIdentity(priorBoundary, log) &&
          !hasAssistantResponseBetween &&
          (priorIsOptimistic || incomingIsOptimistic || priorBoundary?.isLive || log?.isLive || internalEnvelopeReconciliation)
        ) {
          deduped[priorBoundaryIndex] = mergeDuplicateFeedLog(priorBoundary, log);
          registerStableKeys(priorBoundaryIndex, deduped[priorBoundaryIndex]);
          return;
        }
      }
      const previous = deduped[deduped.length - 1];
      const previousTurnId = String(previous?.turnId || '').trim();
      const previousRunId = String(previous?.runId || '').trim();
      const sameBoundaryOwner = previousTurnId && turnId
        ? previousTurnId === turnId
        : previousRunId && runId
          ? previousRunId === runId
          : false;
      const hasOptimisticCopy = Boolean(
        previous?._traceIdx === undefined ||
        previous?._traceIdx === null ||
        log?._traceIdx === undefined ||
        log?._traceIdx === null ||
        previous?.isLive ||
        log?.isLive
      );
      const sameOptimisticBoundary = previous?.type === 'user_action' &&
        !hasConflictingBoundaryIdentity(previous, log) &&
        sameBoundaryOwner &&
        hasOptimisticCopy &&
        String(previous.source || 'human') === String(log.source || 'human') &&
        String(previous.text || '').trim() === String(log.text || '').trim();
      if (sameOptimisticBoundary) {
        deduped[deduped.length - 1] = mergeDuplicateFeedLog(previous, log);
        registerStableKeys(deduped.length - 1, deduped[deduped.length - 1]);
        return;
      }
      // Commit the visual turn ordinal only after this boundary survives every
      // optimistic/persisted reconciliation path above. Incrementing before a
      // duplicate returned made all following actions enter a phantom scope,
      // so they briefly duplicated or disappeared until the next poll.
      boundaryScope = candidateBoundaryScope;
      semanticIndexes = new Map();
      userBoundaryIndexes.set(userBoundaryKey, deduped.length);
      if (explicitTurnKey) userBoundaryTurnIndexes.set(explicitTurnKey, deduped.length);
      if (normalizedUserText) liveUserTextIndexes.set(liveUserKey, deduped.length);
    }

    if (log.type === 'steering_received') {
      const steeringScope = String(log.turnId || log.runId || 'unscoped');
      const steeringKeys = Array.from(new Set([
        ...[log.steeringId, log.messageId, log.traceId, log.id]
          .map(value => String(value ?? '').trim())
          .filter(Boolean)
          .map(value => `steering::${ steeringScope }::event:${ value }`),
        ...(log._traceIdx !== undefined && log._traceIdx !== null && String(log._traceIdx).trim()
          ? [`steering::${ steeringScope }::index:${ String(log._traceIdx).trim() }`]
          : []),
      ]));
      const matchedSteeringKey = steeringKeys.find(key => steeringIndexes.has(key));
      const priorSteeringIndex = matchedSteeringKey
        ? steeringIndexes.get(matchedSteeringKey)
        : undefined;
      // Provider-local steering ids can be recycled. They reconcile only while
      // the boundary is still adjacent; once real work has landed this is a
      // distinct guidance phase even if its transport identity was reused.
      if (
        priorSteeringIndex !== undefined &&
        !hasMeaningfulTurnContent(deduped.slice(priorSteeringIndex + 1))
      ) {
        deduped[priorSteeringIndex] = mergeDuplicateFeedLog(deduped[priorSteeringIndex], log);
        registerStableKeys(priorSteeringIndex, deduped[priorSteeringIndex]);
        steeringKeys.forEach(key => steeringIndexes.set(key, priorSteeringIndex));
        return;
      }
      steeringKeys.forEach(key => steeringIndexes.set(key, deduped.length));
      boundaryScope = candidateBoundaryScope;
      semanticIndexes = new Map();
    }

    const normalizedText = normalizeTraceText(log.text || log.question || log.secondary);
    const owner = getFeedNarrativeOwner(log);
    const hasImmutableFeedIdentity = Boolean(
      log._feedPresentationId ||
      log.toolCallId ||
      log.traceId ||
      log.id ||
      log.noteId ||
      log.thoughtId ||
      log.answerId ||
      log.responseKey ||
      log.messageId ||
      log.steeringId ||
      log._traceIdx !== undefined && log._traceIdx !== null
    );
    // Semantic reconciliation already lives inside a visual user boundary.
    // Using run/turn ownership here made the key change when polling enriched
    // an optimistic row, so the same idless live action appeared twice.
    const identityScope = `turn:${ boundaryScope }`;
    let semanticKey = '';
    if (normalizedText && NARRATIVE_TRACE_TYPES.has(log.type) && !hasImmutableFeedIdentity) {
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
    } else if (
      normalizedText &&
      log.type === 'progress' &&
      !hasImmutableFeedIdentity &&
      (log._traceIdx === undefined || log._traceIdx === null || log.isLive)
    ) {
      // Reconcile only transport-level previews. Two persisted provider
      // failures with the same wording are still two real occurrences and
      // must retain their own positions in the trace sequence.
      semanticKey = `progress::${ identityScope }::${ normalizedText }::${ normalizeTraceText(log.secondary) }`;
    } else if (normalizedText && log.type === 'agent_status') {
      semanticKey = `agent-status::${ identityScope }::${ String(log.status || '') }::${ normalizedText }`;
    } else if (
      normalizedText &&
      !hasImmutableFeedIdentity &&
      (log.isLive || log._instant) &&
      ['command', 'tool_call', 'exploration', 'file_edit', 'browser', 'communication'].includes(log.type)
    ) {
      const semanticType = log.type === 'tool_call' ? 'command' : log.type;
      semanticKey = `live-action::${ identityScope }::${ semanticType }::${ normalizedText }::${ String(log.filepath || log.filename || log.command || '') }`;
    } else if (log.type === 'answer' && normalizedText && !hasImmutableFeedIdentity && (log.isLive || log.isStreaming || log.isLiveTyping)) {
      semanticKey = `answer::${ identityScope }::${ String(log.answerId || normalizedText) }`;
    }

    if (semanticKey && semanticIndexes.has(semanticKey)) {
      const index = semanticIndexes.get(semanticKey)!;
      const previous = deduped[index];
      const hasExplicitEventIdentity = (candidate: any) => Boolean(
        candidate?._feedPresentationId ||
        candidate?.traceId ||
        candidate?.id ||
        candidate?.toolCallId ||
        candidate?.streamId ||
        candidate?.noteId ||
        candidate?.thoughtId ||
        candidate?.answerId ||
        candidate?.responseKey ||
        candidate?.messageId
      );
      // Two real actions can legitimately repeat the same label/arguments.
      // Semantic fallback is only safe when at least one transport omitted an
      // immutable event identity (or one side is an explicit instant preview).
      if (
        !previous?._instant &&
        !log?._instant &&
        hasExplicitEventIdentity(previous) &&
        hasExplicitEventIdentity(log)
      ) {
        const nextIndex = deduped.length;
        deduped.push(log);
        registerStableKeys(nextIndex, log);
        semanticIndexes.set(semanticKey, nextIndex);
        return;
      }
      deduped[index] = mergeDuplicateFeedLog(deduped[index], log);
      registerStableKeys(index, deduped[index]);
      return;
    }

    const index = deduped.length;
    deduped.push(log);
    registerStableKeys(index, log);
    if (semanticKey) semanticIndexes.set(semanticKey, index);
  });

  return deduped;
};

const isInternalStatusThought = (log: any) => {
  if (!log) return false;
  if (['agent_status', 'status', 'run_status', 'error', 'done'].includes(String(log.type || ''))) return true;
  if (log.type !== 'thought') return false;
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

const cleanAgentStatusText = (value: unknown) => {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (value instanceof Error) text = value.message;
  else if (value && typeof value === 'object') {
    const record = value as Record<string, any>;
    const nested = record.message ?? record.error?.message ?? record.error ?? record.detail ?? record.reason;
    if (nested !== undefined && nested !== value) return cleanAgentStatusText(nested);
    try { text = JSON.stringify(value); } catch { text = ''; }
  } else text = String(value || '');
  return text
    .replace(/^\s*[*_`]+|[*_`]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const getAgentRunNotice = (log: any): AgentRunNotice | null => {
  if (!isInternalStatusThought(log)) return null;

  const detail = cleanAgentStatusText(log.detail || log.text || log.message);
  if (log.type !== 'agent_status' && !detail) return null;
  const explicitStatus = String(log.status || '').toLowerCase();
  const explicitTitle = cleanAgentStatusText(log.title);

  if (['agent_status', 'status', 'run_status', 'error', 'done'].includes(String(log.type || ''))) {
    const lifecycleStatus = String(log.phase || explicitStatus).toLowerCase();
    // `done` is a lifecycle boundary, not an error banner. Providers may put
    // their final summary in its text field; the answer surface already owns
    // that content. Only an explicitly failed/stopped done event is visible.
    if (
      log.type === 'done' &&
      !['failed', 'error', 'stopped', 'cancelled', 'canceled', 'warning'].includes(lifecycleStatus)
    ) return null;
    const tone = lifecycleStatus === 'stopped' || lifecycleStatus === 'cancelled' || lifecycleStatus === 'canceled'
      ? 'stopped'
      : lifecycleStatus === 'warning' || (log.type === 'status' && lifecycleStatus !== 'error' && lifecycleStatus !== 'failed')
        ? 'warning'
        : 'error';
    return {
      tone,
      title: explicitTitle || (tone === 'stopped' ? 'Run stopped' : tone === 'warning' ? 'Run update' : 'Run failed'),
      detail: detail || (tone === 'stopped' ? 'The agent was stopped.' : tone === 'warning' ? 'The run status changed.' : 'The agent could not continue.'),
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

// Compaction is request infrastructure, not conversation content. Its live and
// failure states belong in the context meter; a permanent success row would
// consume feed height forever and make the transcript itself noisier.
const ContextCompactionNotice = (_props: { log: any }) => null;

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

const countVisibleWorkflowActions = (logs: any[]) => {
  const identities = new Set<string>();
  const fallbackOccurrences = new Map<string, number>();
  logs.forEach((log, index) => {
    if (!WORKFLOW_COUNT_TYPES.has(log?.type) || HIDDEN_HELPER_TYPES.has(log?.type) || isHiddenStatusOnlyLog(log)) return;
    const actionType = log.type === 'tool_call' ? 'command' : String(log.type || '');
    const stableIdentity = log._feedPresentationId ?? log.toolCallId ?? log.traceId ?? log.id ?? log._traceIdx ?? log.ownerTraceId;
    const actionOwner = getFeedNarrativeOwner(log);
    const stableScope = `${actionType}|${actionOwner}`;
    const semanticIdentity = [
      actionType,
      actionOwner,
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
const isHiddenStatusOnlyLog = (log: any) => {
  // These records carry state used elsewhere in the UI but have no standalone
  // chat representation. User-facing notes, progress, model status, errors,
  // and starting actions are intentionally never classified as hidden here.
  return ['model_usage', 'work_note_cancel', 'answer_cancel']
    .includes(String(log?.type || ''));
};

const formatWorkElapsed = (seconds: number | null) => {
  if (seconds === null) return '';
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

const normalizeWorkTimestamp = normalizeLifecycleTimestamp;

const isCountedWorkflowLog = (log: any) =>
  WORKFLOW_COUNT_TYPES.has(log?.type) &&
  !HIDDEN_HELPER_TYPES.has(log?.type) &&
  !isHiddenStatusOnlyLog(log);

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

const hasVisibleNarrative = (logs: any[]) => (Array.isArray(logs) ? logs : []).some(log =>
  NARRATIVE_TRACE_TYPES.has(String(log?.type || '')) &&
  !isHiddenStatusOnlyLog(log) &&
  Boolean(String(log?.text || '').trim()) &&
  (log?.type !== 'thought_stream' || shouldRenderThoughtStream(log))
);

const useWorkElapsedSeconds = (active: boolean, logs: any[], endedAt?: number | null, fallbackStartedAt?: number | null) => {
  const normalizedEndedAt = React.useMemo(() => normalizeWorkTimestamp(endedAt), [endedAt]);
  const normalizedFallbackStart = React.useMemo(() => normalizeWorkTimestamp(fallbackStartedAt), [fallbackStartedAt]);
  const bounds = React.useMemo(() => getWorkTimeBounds(logs), [logs]);
  const hasTimedWork = React.useMemo(() => logs.some(isTimedWorkLog), [logs]);
  // Keep the empty live Worked container mounted immediately, but do not start
  // its clock at request admission. Network/provider startup is not visible
  // work and previously produced a fake elapsed value which then appeared to
  // reset when the first real Thought or action arrived. The turn timestamp is
  // retained only as a compatibility anchor for an actual legacy work event
  // whose own timestamp is missing.
  const recordedStart = bounds.start ?? (hasTimedWork ? normalizedFallbackStart : null);
  const recordedEnd = normalizedEndedAt ?? bounds.end;
  const elapsedMs = useLifecycleElapsedMs({
    active,
    startedAt: recordedStart,
    endedAt: recordedEnd,
  });
  if (elapsedMs === null) return null;
  return Math.max(1, Math.floor(elapsedMs / 1_000));
};

const ThoughtSequence = ({
  logs, liveLogs = [], isThinking, isLast, hasAnswer, stepCount, turnStartedAt, turnEndedAt, onOpenAgentTeam, isSubAgentTab = false, isAgentBuilder = false, onEditUserMessage, subAgentAssetIndexes
}: { logs: any[], liveLogs?: any[], isThinking: boolean, isLast: boolean, hasAnswer: boolean, stepCount: number, turnStartedAt?: number | null, turnEndedAt?: number | null, onOpenAgentTeam?: (agentName?: string) => void, isSubAgentTab?: boolean, isAgentBuilder?: boolean, onEditUserMessage?: (text: string) => void, subAgentAssetIndexes?: Record<string, number> }) => {
  // The trace stream is more precise than the briefly stale global running
  // flag. Scan the whole turn: terminal events are often followed by late
  // cleanup traces, and a final answer itself conclusively ends work timing.
  const turnLogs = React.useMemo(() => [...logs, ...liveLogs], [logs, liveLogs]);
  const isLiveThinking = React.useMemo(
    () => isTurnWorkActive(isThinking, hasAnswer, turnLogs),
    [hasAnswer, isThinking, turnLogs],
  );
  // Mount active work open on its first paint. Settled/restored work starts
  // collapsed; it should not briefly expose its full history during hydration.
  const [open, setOpen] = React.useState(() => isLiveThinking);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const anchorFrameRef = React.useRef<number | null>(null);
  const userControlledOpenRef = React.useRef(false);
  const wasLiveThinkingRef = React.useRef(isLiveThinking);

  const setOpenPreservingViewport = React.useCallback((nextOpen: boolean, preserveViewport = false) => {
    if (!preserveViewport) {
      setOpen(nextOpen);
      return;
    }

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
    const wasLive = wasLiveThinkingRef.current;
    wasLiveThinkingRef.current = isLiveThinking;
    if (userControlledOpenRef.current) return;
    if (isLiveThinking) {
      setOpenPreservingViewport(true, false);
    } else if (wasLive) {
      // Every untouched live sequence closes on a real terminal transition,
      // including stopped/error turns that never produced an answer.
      setOpenPreservingViewport(false, false);
    }
  }, [isLiveThinking, setOpenPreservingViewport]);

  const toggleOpen = () => {
    userControlledOpenRef.current = true;
    setOpenPreservingViewport(!open, true);
  };

  const isOpen = open;
  const hasRealActions = stepCount > 0;
  const hasNarrativeWork = hasVisibleNarrative(turnLogs);
  const hasRenderableTimelineWork = turnLogs.some(log =>
    isInternalStatusThought(log) || (
      RENDERABLE_TIMELINE_TYPES.has(String(log?.type || '')) &&
      (log?.type !== 'thought_stream' || shouldRenderThoughtStream(log))
    )
  );
  // Start the timer as soon as the turn is active. Waiting for the first
  // trace made the live pill appear late, then disappear/reappear as polling
  // swapped between an empty group and its first streamed event.
  const workElapsedSeconds = useWorkElapsedSeconds(isLiveThinking, turnLogs, turnEndedAt, turnStartedAt);
  const workElapsedLabel = formatWorkElapsed(workElapsedSeconds);

  // The container disappears only when the turn has never produced anything
  // renderable. Once a Thought, note, status, or action was shown, settling an
  // answer must not erase it from the transcript.
  if (!isLiveThinking && !hasRealActions && !hasNarrativeWork && !hasRenderableTimelineWork) return null;

  return (
    <div className="relative" ref={containerRef}>
      <div className={`eterx-worked-summary eterx-worked-summary-complete ${ isLiveThinking ? 'eterx-worked-summary-live' : '' } mb-1 flex w-full items-center gap-3 pt-0`}>
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={isOpen}
          className="eterx-worked-summary-button inline-flex shrink-0 items-center gap-1.5 rounded-md py-1 text-left outline-none transition-colors"
        >
          <span className="eterx-worked-summary-label py-[1px] text-[13px] font-semibold leading-[1.4] tracking-normal text-[var(--muted-foreground)]">
            <span>{isLiveThinking
              ? workElapsedLabel ? 'Working for\u00a0' : 'Working'
              : 'Worked for\u00a0'}</span>
            {workElapsedLabel && <RollingTimeDisplay label={workElapsedLabel} />}
          </span>
          <ChevronDown className={`eterx-worked-summary-chevron h-3.5 w-3.5 transition-transform ${ isOpen ? '' : '-rotate-90' }`} aria-hidden="true" />
        </button>
        <div className="eterx-worked-summary-line h-px flex-1 bg-[var(--border)]" />
      </div>

      {isOpen && (
        <div className="overflow-hidden">
          <ThinkingProcess
            logs={logs}
            liveLogs={liveLogs}
            isThinking={isLiveThinking}
            isLast={isLast}
            onOpenAgentTeam={onOpenAgentTeam}
            assetIndexes={subAgentAssetIndexes}
            isSubAgentTab={isSubAgentTab}
            isAgentBuilder={isAgentBuilder}
            onEditUserMessage={onEditUserMessage}
            renderContextCompaction={(log) => <ContextCompactionNotice log={log} />}
          />
        </div>
      )}
    </div>
  );
};

const RENDER_RELEVANT_LOG_FIELDS = [
  'id', '_traceIdx', 'type', 'text', 'secondary', 'output', 'content',
  'timestamp', 'startTime', 'endTime', 'streamStartedAt', 'isStreaming', 'isLiveTyping',
  'wasStreaming', 'isLive', 'streamState', 'final', 'done', 'answerId', 'spokenText', 'noteId', 'thoughtId',
  'subAgent', 'subAgentId', 'subAgentChatId', 'isSubAgent', 'agentRole', 'terminalTask', 'agentName', 'status', 'state', 'finishReason', 'finish_reason', 'progress', 'error',
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
  'icon', 'iconCategory', 'size', '_autonomyProxy', '_streamingCancelled', '_cancelTraceIdx', '_cancelledAt',
  '_autonomyCheckpoint', '_autonomyBoundaryFollowUp', '_connection', 'model', 'modelName',
  'phase', 'compactionId', 'beforeTokens', 'afterTokens', 'contextWindow', 'modelProvider',
  'provider', 'source', 'promptTokens', 'inputTokens', 'completionTokens', 'outputTokens',
  'totalTokens', 'providerReportedTotalTokens', 'cachedTokens', 'uncachedPromptTokens', 'cacheHitRatio',
  'visibleOutputTokens', 'generatedTokens',
  'reasoningTokens', 'toolUsePromptTokens', 'interaction', 'usageId', 'chatId', 'ownerChatId',
  // Query and worker ownership are presentation state. Several of these are
  // deliberately enriched after the optimistic row first lands; omitting one
  // from the memo comparator can leave a group visually attached to its old
  // query until some unrelated text changes.
  'runId', 'turnId', 'subAgentTurnId', 'originRunId', 'originTurnId',
  'messageId', 'steeringId', 'parentTurnId', 'parentRunId', 'rootTurnId', 'rootRunId',
  'mainTurnTerminal', 'terminalTurnId', 'directToSubAgent', 'optimistic', 'deliveryFailed', 'uiOnly',
  '_originTraceIdx', '_pollIdx', '_recoveredBoundary', '_recoveredExactText', '_hiddenRecoveredBoundary',
  '_feedPresentationId', '_feedBoundaryId', '_feedBoundaryOrder', '_feedEventOrder', '_internalEnvelopeBoundary',
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
  turnStartedAt,
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
  turnStartedAt?: number | null;
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
  // This component is keyed to one immutable user turn. Preserve everything
  // already shown in that turn across sparse polling frames; newer snapshots
  // can update matching rows but can never make earlier work vanish.
  const landedTurnLogsRef = React.useRef<any[]>([]);
  const first = group[0];
  if (isHiddenRecoveredUserBoundary(first)) return null;
  if (first?.type === 'user_action' || first?.type === 'steering_received') {
    const userText = getVisibleUserBoundaryText(first);
    const messageSource = String(first.source || '').toLowerCase();
    const delegatedSource = messageSource === 'proxy_manager'
      ? 'Side Proxy-Agent'
      : messageSource === 'user_proxy'
        ? 'Proxy-Agent'
      : messageSource && !['human', 'user', 'human_direct', 'direct_user', 'recovered'].includes(messageSource)
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
              <span className="block min-w-0 max-w-full w-full text-left break-words [word-break:break-word] [overflow-wrap:anywhere]">{userText}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const answerTokenUsage = (() => {
    const seen = new Set<string>();
    return group.reduce((usage: { input: number; output: number }, log: any) => {
      if (log?.type !== 'model_usage') return usage;
      const tokenTotal = Number(log.totalTokens ?? log.total_tokens ?? 0);
      if (!Number.isFinite(tokenTotal) || tokenTotal <= 0) return usage;
      const key = String(log.usageId || log._traceIdx || `${log.runId || log.turnId || ''}:${log.provider || ''}:${log.model || ''}:${log.interaction ?? ''}:${log.timestamp || ''}:${tokenTotal}`);
      if (seen.has(key)) return usage;
      seen.add(key);
      const input = Number(log.promptTokens ?? log.prompt_tokens ?? log.inputTokens ?? log.input_tokens ?? 0);
      const output = Number(log.generatedTokens ?? log.generated_tokens ?? log.outputTokens ?? log.output_tokens ?? log.completionTokens ?? log.completion_tokens ?? 0);
      return {
        input: usage.input + (Number.isFinite(input) && input > 0 ? input : 0),
        output: usage.output + (Number.isFinite(output) && output > 0 ? output : 0),
      };
    }, { input: 0, output: 0 });
  })();

  // Bug 9: Empty groups (appended for live thinking indicator) must not
  // render a blank mb-8 div when the group truly has no content yet.
  if (group.length === 0 && !isThinkingTurn) return null;

  // Keep every event in one chronological collection for its whole lifetime.
  // Moving an action between separate live and settled arrays changed its
  // parent/key at completion and caused the starting row to disappear, remount,
  // or briefly duplicate inside Worked.
  const liveActionLogs: any[] = [];
  const visibleGroupLogs = group.filter((l: any) =>
    isLiveUserVisibleTrace(l) &&
    !isHiddenStatusOnlyLog(l)
  );
  const rawStandardLogs = visibleGroupLogs.filter((log: any, index: number, logs: any[]) =>
    shouldRenderContextCompactionEvent(log, index, logs, isThinkingTurn || isLiveSessionActive)
  );
  const normalizedStandardLogs = rawStandardLogs.map((rawLog: any, index: number) => {
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
      turnIsActive;
    const hasLaterWorkflowActivity = rawStandardLogs.slice(index + 1).some((later: any) =>
      later.type === 'work_note' ||
      (WORKFLOW_COUNT_TYPES.has(later.type) && !HIDDEN_HELPER_TYPES.has(later.type))
    );
    // An answer followed by real workflow activity is an intermediate model
    // checkpoint even when its individual stream already settled. Only the
    // last answer after all actions can own the final-answer surface.
    const shouldStayInWorkSequence = isProvisionalAnswer || hasLaterWorkflowActivity;
    if (
      log.type !== 'answer' ||
      !shouldStayInWorkSequence
    ) {
      return log;
    }

    // Answer-shaped provider text is not user-facing until its response phase
    // conclusively settles. Hiding the provisional row prevents live model
    // reasoning from leaking as either an answer or a synthetic work note.
    return null;
  }).filter((log: any) => Boolean(log));
  const standardLogs = reconcileLandedTurnLogs(
    landedTurnLogsRef.current,
    normalizedStandardLogs,
  );
  landedTurnLogsRef.current = standardLogs;
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
      isLive: lastAnswerLog?.isLive,
      isLiveTyping: lastAnswerLog?.isLiveTyping,
      isStreaming: lastAnswerLog?.isStreaming,
      streamState: lastAnswerLog?.streamState,
      status: lastAnswerLog?.status,
      final: lastAnswerLog?.final,
      done: lastAnswerLog?.done,
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
  // Open provider answer snapshots are genuine live output and should render
  // immediately. A closed answer while the run is still active can still be
  // a pre-tool draft, so it remains hidden until the turn settles (or an
  // answer_cancel converts it into its owning work-note lifecycle).
  const answerTurnIsActive = isThinkingTurn || isLiveSessionActive;
  if (answerTurnIsActive) {
    lastKnownAnswerRef.current = null;
  } else if (finalAnswer !== null) {
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
    if (!sameAnswer || newText.length >= cachedText.length) {
      lastKnownAnswerRef.current = finalAnswer;
    }
  }
  // Incremental poll frames commonly omit an already-settled answer. Absence
  // from that sparse frame is not a retraction; this component is scoped to
  // one immutable turn, so keep the landed answer until the turn is replaced
  // (unmount) or becomes active again (the explicit clear above).
  const displayFinalAnswer = answerTurnIsActive
    ? finalAnswer && isFeedTraceOpen(finalAnswer)
      ? finalAnswer
      : null
    : finalAnswer ?? lastKnownAnswerRef.current;
  // Only a real active stream may animate token-by-token. A settled answer can
  // be delivered again by polling or history restoration, but must render once
  // without replaying its entrance animation.
  const isAnswerActivelyTyping = Boolean(
    answerTurnIsActive &&
    isFeedTraceOpen(displayFinalAnswer)
  );
  const shouldAnimateAnswerReveal = isAnswerActivelyTyping && !suppressInitialReveal;
  // A provider may close a text snapshot immediately before revealing its
  // tool call. While the transport is still active, keep the phase live so a
  // provisional answer cannot collapse Thought and then reopen it one frame
  // later when the action arrives.
  const hasSettledAnswer = isSettledAnswerTrace(displayFinalAnswer) &&
    !answerTurnIsActive;

  const selectWorkLogs = (logs: any[]) => logs.filter(log =>
    isInternalStatusThought(log) || (
      isLiveUserVisibleTrace(log) &&
      RENDERABLE_TIMELINE_TYPES.has(String(log?.type || '')) &&
      (log?.type !== 'thought_stream' || shouldRenderThoughtStream(log))
    )
  );
  // Keep status rows that occurred before the final answer inside the normal
  // sequence. Status rows emitted after the answer are rendered after it.
  const tailRunNotices = tailLogs.reduce<Array<{ log: any; notice: AgentRunNotice }>>((notices, log) => {
    const notice = getAgentRunNotice(log);
    if (notice) notices.push({ log, notice });
    return notices;
  }, []);
  // A reconnect may deliver an action/file settlement after the final-answer
  // snapshot even though that work semantically preceded the answer. The old
  // tail path rendered notices only, silently dropping those already-landed
  // rows. Reconcile non-notice tail work back into the stable Worked sequence;
  // terminal notices retain their deliberate post-answer placement.
  const tailWorkLogs = tailLogs.filter(log => !getAgentRunNotice(log));
  const rawWorkLogs = selectWorkLogs([
    ...displayProcessLogs,
    ...tailWorkLogs,
  ]);
  const isAskUserInteractionLog = (log: any) =>
    log?.type === 'ask_user' &&
    typeof log.question === 'string' &&
    log.question.trim().length > 0 &&
    Number.isFinite(Number(log.timestamp));
  // Snapshot reconciliation happens by responseKey/event identity before
  // rendering. Do not run a second question-content filter here; it could
  // suppress a valid repeated prompt from a later phase.
  const visibleWorkLogs = rawWorkLogs;
  const segments: { type: 'thoughts' | 'ask_user' | 'status'; logs?: any[]; log?: any; notice?: AgentRunNotice; phaseKey?: string }[] = [];
  let currentThoughts: any[] = [];
  const segmentIdentity = (seg: { logs?: any[]; log?: any }, fallback: number) => {
    const anchor = seg.log || seg.logs?.[0];
    const primary = String(
      anchor?._feedPresentationId ??
      anchor?.traceId ??
      anchor?.id ??
      anchor?._traceIdx ??
      anchor?.thoughtId ??
      anchor?.noteId ??
      anchor?.responseKey ??
      anchor?.steeringId ??
      ''
    ).trim();
    if (primary) return `${ String(anchor?.type || 'segment') }:${ primary }`;
    const timeAnchor = anchor?.startTime ?? anchor?.timestamp ?? fallback;
    return `${ String(anchor?.type || 'segment') }:${ String(timeAnchor) }`;
  };

  visibleWorkLogs.forEach(log => {
    if (isInternalStatusThought(log)) {
      const notice = getAgentRunNotice(log);
      if (!notice) return;
      if (currentThoughts.length > 0) {
        segments.push({ type: 'thoughts', logs: currentThoughts });
        currentThoughts = [];
      }
      segments.push({ type: 'status', log, notice });
    } else if (log.type === 'context_compaction') {
      // The sole successful lifecycle row belongs chronologically inside the
      // existing work sequence. It must not split one query into two separate
      // Working/Worked containers.
      currentThoughts.push(log);
    } else if (isAskUserInteractionLog(log)) {
      if (currentThoughts.length > 0) {
        segments.push({ type: 'thoughts', logs: currentThoughts });
        currentThoughts = [];
      }
      segments.push({ type: 'ask_user', log });
    } else {
      let isValid = true;
      if (log.type === 'work_note') {
        const text = String(log.text || '').trim();
        if (!text) isValid = false;
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

  const groupTerminalEndedAt = standardLogs.reduce((latest: number, log: any) => {
    if (!isTerminalWorkTrace(log)) return latest;
    const timestamp = normalizeWorkTimestamp(log?.endTime ?? log?.timestamp);
    return timestamp === null ? latest : Math.max(latest, timestamp);
  }, 0) || null;

  // A live empty phase must keep its mount when its first trace arrives, but
  // later phases should not be keyed only by their ordinal. A delayed status,
  // question or compaction event can be inserted earlier in the timeline;
  // ordinal-only keys then remount every later Worked section and make stable
  // rows appear to close/reopen. Anchor each later phase to the immutable
  // chronological separator that owns it.
  let precedingPhaseBoundary = 'root';
  let thoughtPhaseOrdinal = 0;
  segments.forEach((segment, index) => {
    if (segment.type === 'thoughts') {
      segment.phaseKey = thoughtPhaseOrdinal === 0
        ? 'root'
        : `after-${ precedingPhaseBoundary }`;
      thoughtPhaseOrdinal += 1;
      return;
    }
    precedingPhaseBoundary = segmentIdentity(segment, index);
  });

  // Helper-only groups (done markers, raw tool results, retry bookkeeping,
  // cancelled placeholders) have no visual row. Do not leave an empty
  // assistant container and its margin in the primary transcript.
  if (segments.length === 0 && tailRunNotices.length === 0 && !displayFinalAnswer) {
    return null;
  }

  return (
    <div
      data-chat-group-index={groupIdx}
      data-live={groupIsThinking ? 'true' : undefined}
      className="eterx-chat-message-group w-full flex flex-col mb-8 scroll-m-20 relative"
    >
      {segments.map((seg, segIdx) => {
        if (seg.type === 'status' && seg.notice) {
          return <AgentRunStatusNotice key={`status-${segmentIdentity(seg, segIdx)}`} notice={seg.notice} />;
        }
        if (seg.type === 'ask_user') {
          return (
            <AskUserPrompt
              key={`ask-${ segmentIdentity(seg, segIdx) }`}
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

        // The first live phase exists before its first event. Keep its ordinal
        // identity when that event arrives so React fills the existing Worked
        // container instead of replacing it with a newly keyed subtree.
        const thoughtPhaseKey = `thoughts-phase-${ seg.phaseKey || 'root' }`;
        const isLastThoughts = segIdx === segments.length - 1 || segments.slice(segIdx + 1).every(s => s.type !== 'thoughts');
        const stepCount = countVisibleWorkflowActions([
          ...(seg.logs || []),
          ...(isLastThoughts ? liveActionLogs : []),
        ]);
        const segmentTerminalEndedAt = [
          ...(seg.logs || []),
          ...(isLastThoughts ? liveActionLogs : []),
        ].reduce((latest: number, log: any) => {
          if (!isTerminalWorkTrace(log)) return latest;
          return Math.max(latest, Number(log?.endTime || log?.timestamp || 0));
        }, 0) || null;
        const terminalTurnEndedAt = isLastThoughts
          ? groupTerminalEndedAt ?? segmentTerminalEndedAt
          : segmentTerminalEndedAt;

        // A settled or streaming direct answer may have a provider narration
        // row but no actual workflow action. Keep that answer on the normal
        // answer surface instead of manufacturing a thought-sequence card.
        if (stepCount === 0 && (seg.logs || []).length === 0 && !(groupIsThinking && isLastThoughts)) return null;

        return (
          <ThoughtSequence
            key={thoughtPhaseKey}
            logs={seg.logs || []}
            liveLogs={isLastThoughts ? liveActionLogs : []}
            isThinking={groupIsThinking && isLastThoughts}
            isLast={isLastThoughts}
            hasAnswer={hasSettledAnswer && isLastThoughts}
            stepCount={stepCount}
            turnStartedAt={seg.phaseKey === 'root' ? turnStartedAt : undefined}
            turnEndedAt={hasSettledAnswer
              ? displayFinalAnswer?.endTime ?? displayFinalAnswer?.timestamp ?? terminalTurnEndedAt
              : terminalTurnEndedAt}
            onOpenAgentTeam={onOpenAgentTeam}
            subAgentAssetIndexes={subAgentAssetIndexes}
            isSubAgentTab={isSubAgentTab}
            isAgentBuilder={isAgentBuilder}
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
                  <div className="eterx-answer-footer mt-3 flex min-h-8 w-full items-center justify-start border-t border-white/[0.045] pt-2">
                    <div className={`flex items-center gap-0 transition-opacity duration-150 ${ isSubAgentTab ? 'opacity-70 hover:opacity-100 focus-within:opacity-100' : 'opacity-0 group-hover/thought:opacity-100 focus-within:opacity-100' }`}>
                      <NakedCopyButton content={displayFinalAnswer.text} />
                      {onEditUserMessage && (
                        <Tooltip text="Edit in composer">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onEditUserMessage(displayFinalAnswer.text);
                            }}
                            className="rounded-[8px] p-[6px] text-[#746F67] transition-colors hover:bg-white/[0.045] hover:text-[#DAD4CA]"
                            aria-label="Edit answer in composer"
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
                      {showTokenCount && (answerTokenUsage.input > 0 || answerTokenUsage.output > 0) && (
                        <span className="eterx-professional-number ml-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium leading-none text-[#746F67] select-none whitespace-nowrap" title="Provider-reported token usage across this run. Cached prompt tokens are included in input.">
                          <span>Input {formatProviderTokenCount(answerTokenUsage.input)}</span>
                          <span className="text-[#514D47]" aria-hidden="true">|</span>
                          <span>Output {formatProviderTokenCount(answerTokenUsage.output)}</span>
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

      {tailRunNotices.map((entry, index) => (
        <AgentRunStatusNotice
          key={`tail-status-${ segmentIdentity({ log: entry.log }, index) }`}
          notice={entry.notice}
        />
      ))}
    </div>
  );
}, (previous, next) => {
  if (previous.groupIdx !== next.groupIdx) return false;
  if (previous.turnStartedAt !== next.turnStartedAt) return false;
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
  // The selected chat ledger is already normalized and owner-stamped upstream.
  // Do not delete rows again at presentation time: a briefly stale owner field
  // used to make a query, Thought, or action vanish while the ledger repaired.
  const traceLogs = useMemo(
    () => normalizeInternalUserActionLogs(
      settleFeedTraceLifecycles(ensureStableFeedPresentationIds(
        recoverMissingUserTurnBoundaries(
          (Array.isArray(incomingTraceLogs) ? incomingTraceLogs : [])
            .filter(log => !isProviderBootstrapTrace(log)),
        ),
        chatId || undefined,
      )),
    ),
    [incomingTraceLogs, chatId]
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
  const orderedTraceLogs = useMemo(() => {
    // Ownership must be restored before semantic deduplication. Otherwise an
    // old unscoped/live delivery appended after a newer query can be compared
    // against that newer turn and either merge with it or render beneath it.
    const surfaceOwnedLogs = isSubAgentTab
      ? traceLogs
      : traceLogs.filter(log => !(
          log?.type === 'user_action' &&
          log?.directToSubAgent === true &&
          Boolean(log?.subAgentId || log?.subAgentChatId || log?.subAgent)
        ));
    const ownershipOrdered = orderFeedTimelineLogs(surfaceOwnedLogs);
    const boundaryReconciled = orderFeedTimelineLogs(dedupeFeedLogs(ownershipOrdered));
    return dedupeFeedLogs(boundaryReconciled);
  }, [isSubAgentTab, traceLogs]);
  const rawTransportActive = !isFeedActivityPaused && Boolean(
    isThinking || (
      !isSubAgentTab &&
      liveState !== undefined &&
      liveState !== 'idle' &&
      liveState !== 'error'
    )
  );
  const activeFeedBoundaryIndex = useMemo(() => {
    let latestBoundaryIndex = -1;
    for (let index = orderedTraceLogs.length - 1; index >= 0; index -= 1) {
      if (isFeedTurnBoundary(orderedTraceLogs[index])) {
        latestBoundaryIndex = index;
        break;
      }
    }
    if (!rawTransportActive || latestBoundaryIndex < 0 || orderedTraceLogs[latestBoundaryIndex]?._queuedFollowUp !== true) {
      return latestBoundaryIndex;
    }
    // A queued successor is visible but does not own the currently running
    // transport yet. Keep the active lifecycle on the newest non-queued,
    // non-terminal predecessor until the successor's canonical user_action
    // clears its queue marker.
    for (let index = latestBoundaryIndex - 1; index >= 0; index -= 1) {
      if (!isFeedTurnBoundary(orderedTraceLogs[index])) continue;
      if (orderedTraceLogs[index]?._queuedFollowUp === true) continue;
      const nextBoundaryIndex = orderedTraceLogs.findIndex((log, candidateIndex) =>
        candidateIndex > index && isFeedTurnBoundary(log)
      );
      const range = orderedTraceLogs.slice(index, nextBoundaryIndex >= 0 ? nextBoundaryIndex : orderedTraceLogs.length);
      const terminal = range.some(log => isTerminalWorkTrace(log) || (
        log?.type === 'answer' && isSettledAnswerTrace(log)
      ));
      if (!terminal) return index;
    }
    return latestBoundaryIndex;
  }, [orderedTraceLogs, rawTransportActive]);
  const activeFeedTurnLogs = useMemo(() => {
    const start = activeFeedBoundaryIndex >= 0 ? activeFeedBoundaryIndex : 0;
    const nextBoundaryIndex = orderedTraceLogs.findIndex((log, index) =>
      index > start && isFeedTurnBoundary(log)
    );
    return orderedTraceLogs.slice(start, nextBoundaryIndex >= 0 ? nextBoundaryIndex : orderedTraceLogs.length);
  }, [activeFeedBoundaryIndex, orderedTraceLogs]);
  const activeFeedRunLogs = useMemo(() => {
    const boundary = activeFeedTurnLogs.find(isFeedTurnBoundary);
    const boundaryTurnId = String(boundary?.turnId || '').trim();
    const boundaryRunId = String(boundary?.runId || '').trim();
    if (!boundaryTurnId && !boundaryRunId) return activeFeedTurnLogs;
    return activeFeedTurnLogs.filter(log => {
      const logTurnId = String(log?.turnId || '').trim();
      const logRunId = String(log?.runId || '').trim();
      if (boundaryTurnId && logTurnId) return boundaryTurnId === logTurnId;
      if (boundaryRunId && logRunId) return boundaryRunId === logRunId;
      return true;
    });
  }, [activeFeedTurnLogs]);
  const activeTurnHasTerminalTrace = useMemo(
    () => activeFeedRunLogs.some(isTerminalWorkTrace),
    [activeFeedRunLogs],
  );
  const activeTurnHasExplicitFinalAnswer = useMemo(
    () => activeFeedRunLogs.some(log =>
      log?.type === 'answer' &&
      isSettledAnswerTrace(log) &&
      (
        log?.final === true ||
        log?.done === true ||
        log?.mainTurnTerminal === true ||
        ['completed', 'complete', 'done', 'success'].includes(String(log?.status || '').trim().toLowerCase())
      )
    ),
    [activeFeedRunLogs],
  );
  const liveTransportActive = !isSubAgentTab && !isFeedActivityPaused &&
    liveState !== undefined && liveState !== 'idle' && liveState !== 'error';
  const transportWorkActive = rawTransportActive || liveTransportActive;
  const activeBoundary = activeFeedTurnLogs.find(isFeedTurnBoundary);
  const activityScope = `${ String(chatId || 'chat') }::${ String(
    activeBoundary?._feedBoundaryId || activeBoundary?.id || activeBoundary?.steeringId || activeBoundary?.turnId || activeBoundary?.runId || 'preamble'
  ) }::occurrence:${ activeFeedBoundaryIndex }`;
  const [transportHandoff, setTransportHandoff] = useState({ scope: '', active: false });
  useEffect(() => {
    if (activeTurnHasTerminalTrace || activeTurnHasExplicitFinalAnswer || isFeedActivityPaused) {
      setTransportHandoff({ scope: activityScope, active: false });
      return;
    }
    if (transportWorkActive) {
      setTransportHandoff({ scope: activityScope, active: true });
      return;
    }
    // A false transport frame is not a lifecycle boundary. Keep the current
    // turn latched until an explicit answer/terminal event proves it ended.
    setTransportHandoff(current => current.scope === activityScope
      ? current
      : { scope: activityScope, active: false });
  }, [activeTurnHasExplicitFinalAnswer, activeTurnHasTerminalTrace, activityScope, isFeedActivityPaused, transportWorkActive]);
  const transportHandoffActive = transportHandoff.scope === activityScope && transportHandoff.active;
  const feedWorkActive = !activeTurnHasTerminalTrace && !activeTurnHasExplicitFinalAnswer && (
    transportWorkActive || transportHandoffActive
  );

  const groups = useMemo(() => {
    const nextGroups: any[][] = [];
    let currentGroup: any[] = [];
    const isVisibleUserBoundary = isFeedTurnBoundary;

    orderedTraceLogs.forEach(log => {
      if (isVisibleUserBoundary(log)) {
        // Preserve orphaned/recovered preamble activity as its own historical
        // group. Dropping it here hid real rows; appending it later made old
        // work look as though it belonged to the next query.
        if (currentGroup.length > 0) nextGroups.push(currentGroup);
        nextGroups.push([log]);
        currentGroup = [];
      } else {
        // orderFeedTimelineLogs already placed every owned or timestamped
        // event immediately after its user boundary. Group sequentially so a
        // reused run ID cannot redirect an earlier query into a later group.
        currentGroup.push(log);
      }
    });
    if (currentGroup.length > 0) nextGroups.push(currentGroup);

    // Install the pending assistant group beside the boundary that owns the
    // active transport. A visible queued successor can be newer than that
    // boundary and must not steal or hide the predecessor's live lifecycle.
    if (feedWorkActive && activeBoundary) {
      // `activeBoundary` is an object from orderedTraceLogs, and therefore an
      // exact occurrence identity. A string boundary ID is not: malformed
      // providers can reuse it on a third query. Selecting by ID attached the
      // live placeholder/work stream to the first matching historical turn.
      const boundaryGroupIndex = nextGroups.findIndex(group => group[0] === activeBoundary);
      if (boundaryGroupIndex >= 0) {
        const nextGroup = nextGroups[boundaryGroupIndex + 1];
        if (!nextGroup || isVisibleUserBoundary(nextGroup[0])) {
          nextGroups.splice(boundaryGroupIndex + 1, 0, []);
        }
      }
    }

    return nextGroups;
  }, [activeBoundary, feedWorkActive, orderedTraceLogs]);
  const activeWorkGroupIndex = useMemo(() => {
    if (!feedWorkActive || !activeBoundary) return -1;
    const boundaryGroupIndex = groups.findIndex(group => group[0] === activeBoundary);
    return boundaryGroupIndex >= 0 ? boundaryGroupIndex + 1 : -1;
  }, [activeBoundary, feedWorkActive, groups]);

  const [activeTurnIdx, setActiveTurnIdx] = useState<number>(0);
  // A conversation's mount identity comes from its owner, never from a live
  // trace. Optimistic and persisted versions of the first event can carry
  // different IDs; deriving this key from that event remounted the full feed
  // during reconciliation and discarded scroll/expansion state.
  const conversationIdentity = String(chatId || 'new-chat');

  const userTurns = useMemo(() => {
    const ERROR_PATTERNS = ['agent stopped', 'execution failed', 'agent execution', '*agent', 'error:', 'failed:'];
    const isErrorText = (t: string) => ERROR_PATTERNS.some(p => t.toLowerCase().startsWith(p));
    return groups.map((g, idx) => {
      if (
        (g[0]?.type === 'user_action' || g[0]?.type === 'steering_received') &&
        !isHiddenRecoveredUserBoundary(g[0])
      ) {
        const nextGroup = groups[idx + 1] || [];
        const answerLog = [...nextGroup].reverse().find((l: any) => l.type === 'answer' && l.text && !isErrorText(l.text));
        const fallbackLog = [...nextGroup].reverse().find((l: any) => l.text && l.type !== 'user_action' && l.type !== 'steering_received' && !isErrorText(l.text));
        const firstAttachment = g[0]?.attachments?.[0];
        const attachmentName = firstAttachment?.name || firstAttachment?.file?.name || null;
        return {
          idx,
          userText: getVisibleUserBoundaryText(g[0]),
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
  const shouldAutoFollowRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const lastScrollTopRef = useRef<number | null>(null);
  const lastFaceTraceRef = useRef('');
  const lastFaceLiveNotifyAtRef = useRef(0);
  const scrollUpdateFrameRef = useRef<number | null>(null);
  const autoFollowFrameRef = useRef<number | null>(null);
  const scrollRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const autoFollowActivationRef = useRef({ identity: conversationIdentity, thinking: isThinking });
  const isHydratingConversation = previousConversationIdentityRef.current !== conversationIdentity;
  const AUTO_FOLLOW_THRESHOLD = 24;
  const traceActivitySignature = useMemo(() => getTraceActivitySignature(traceLogs), [traceLogs]);

  const pinLatestMessage = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !shouldAutoFollowRef.current) return;
    const nextScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    // Work panels and the floating composer can both shrink during a live
    // transition. Never issue an upward scroll for that temporary geometry;
    // the browser will clamp naturally if the document really became shorter.
    if (nextScrollTop <= container.scrollTop + 1) {
      lastScrollTopRef.current = container.scrollTop;
      return;
    }
    lastScrollTopRef.current = nextScrollTop;
    container.scrollTop = nextScrollTop;
  }, []);

  const scheduleAutoFollow = useCallback(() => {
    if (!shouldAutoFollowRef.current || autoFollowFrameRef.current !== null) return;
    autoFollowFrameRef.current = window.requestAnimationFrame(() => {
      autoFollowFrameRef.current = null;
      pinLatestMessage();
    });
  }, [pinLatestMessage]);

  const pauseAutoFollow = useCallback(() => {
    shouldAutoFollowRef.current = false;
    userScrollIntentUntilRef.current = performance.now() + 700;
    if (autoFollowFrameRef.current !== null) {
      window.cancelAnimationFrame(autoFollowFrameRef.current);
      autoFollowFrameRef.current = null;
    }
  }, []);

  React.useLayoutEffect(() => {
    const previous = autoFollowActivationRef.current;
    const openedRunningConversation = isThinking && previous.identity !== conversationIdentity;
    const recoveredRunningConversation = isThinking && !previous.thinking;
    autoFollowActivationRef.current = { identity: conversationIdentity, thinking: isThinking };
    if (!openedRunningConversation && !recoveredRunningConversation) return;

    // Switching to an active background run, or recovering one after app
    // startup, should reveal its live tail once. Manual upward scrolling after
    // that remains respected because an unchanged running state cannot
    // reactivate follow mode.
    shouldAutoFollowRef.current = true;
    scheduleAutoFollow();
  }, [conversationIdentity, isThinking, scheduleAutoFollow]);

  useEffect(() => {
    previousConversationIdentityRef.current = conversationIdentity;
    setPreviewUserMessage(null);
    shouldAutoFollowRef.current = false;
    userScrollIntentUntilRef.current = 0;
    lastScrollTopRef.current = null;
    if (autoFollowFrameRef.current !== null) {
      window.cancelAnimationFrame(autoFollowFrameRef.current);
      autoFollowFrameRef.current = null;
    }
    if (scrollRestoreTimerRef.current !== null) clearTimeout(scrollRestoreTimerRef.current);
    // The page restores each conversation's saved scroll position shortly
    // after mounting. Do not race that restore by forcing the new feed to the
    // bottom first; adopt bottom-follow only when the restored viewport is
    // actually at the live tail.
    scrollRestoreTimerRef.current = setTimeout(() => {
      scrollRestoreTimerRef.current = null;
      const container = scrollContainerRef.current;
      if (!container) return;
      lastScrollTopRef.current = container.scrollTop;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const openedWhileRunning = autoFollowActivationRef.current.identity === conversationIdentity &&
        autoFollowActivationRef.current.thinking;
      if (distanceFromBottom <= AUTO_FOLLOW_THRESHOLD || openedWhileRunning) {
        shouldAutoFollowRef.current = true;
        scheduleAutoFollow();
      }
    }, 90);
  }, [conversationIdentity, scheduleAutoFollow]);

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
    scheduleAutoFollow();
  }, [traceActivitySignature, isThinking, scheduleAutoFollow]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = feedContentRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    // Composer resizing, streamed content, images, and collapsing work panels
    // can all change geometry without adding a trace. Keep a bottom-following
    // reader pinned through those changes, but never move someone reading up.
    const observer = new ResizeObserver(() => {
      scheduleAutoFollow();
    });
    observer.observe(container);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [conversationIdentity, scheduleAutoFollow]);

  useEffect(() => {
    return () => {
      if (scrollUpdateFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollUpdateFrameRef.current);
      }
      if (autoFollowFrameRef.current !== null) {
        window.cancelAnimationFrame(autoFollowFrameRef.current);
      }
      if (scrollRestoreTimerRef.current !== null) {
        clearTimeout(scrollRestoreTimerRef.current);
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
    lastScrollTopRef.current = container.scrollTop;
    if (distanceFromBottom <= AUTO_FOLLOW_THRESHOLD) {
      shouldAutoFollowRef.current = true;
    } else if (performance.now() <= userScrollIntentUntilRef.current) {
      // Pointer, wheel, touch, and keyboard handlers establish intent before
      // scrolling. Geometry-only scroll events must not disable live follow.
      shouldAutoFollowRef.current = false;
      if (autoFollowFrameRef.current !== null) {
        window.cancelAnimationFrame(autoFollowFrameRef.current);
        autoFollowFrameRef.current = null;
      }
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
  const visibleGroupMountKeys = (() => {
    const ownerOccurrences = new Map<string, number>();
    let currentOwner = 'preamble';
    return visibleGroups.map((group, groupIndex) => {
      const boundary = isFeedTurnBoundary(group[0]) ? group[0] : null;
      if (boundary) {
        const ownerBase = String(
          // The boundary event ID survives optimistic-to-server enrichment.
          // turnId can be added or rewritten during that hand-off, and using it
          // first remounted the entire user/assistant pair mid-run.
          boundary._feedBoundaryId || boundary.id || boundary.steeringId || boundary.turnId || boundary.runId ||
          boundary._traceIdx || boundary.timestamp || `turn-${ groupIndex }`
        ).trim();
        const occurrence = ownerOccurrences.get(ownerBase) || 0;
        ownerOccurrences.set(ownerBase, occurrence + 1);
        currentOwner = `${ ownerBase }:${ occurrence }`;
        return `user:${ currentOwner }`;
      }
      // The pending empty group and the populated assistant group deliberately
      // share this key, so the first live trace fills the existing turn instead
      // of remounting it over the previous query.
      return `assistant:${ currentOwner }`;
    });
  })();
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
            className={`eterx-chat-feed-scroll relative h-full w-full flex flex-col overflow-y-auto overflow-x-hidden eterx-scrollbar [scrollbar-gutter:stable] ${ isCompressed ? 'px-4 sm:px-8' : 'px-4 sm:px-14'
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
                pauseAutoFollow();
              }
            }}
            onTouchMove={pauseAutoFollow}
            onKeyDownCapture={(event) => {
              if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
                pauseAutoFollow();
              }
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
              <div ref={feedContentRef} className={`eterx-chat-feed-content w-full mx-auto pb-4 relative ${ isAgentBuilderFeed ? 'eterx-agent-builder-feed-content' : '' } ${ isCompressed ? 'max-w-[460px] pt-14' : 'max-w-[var(--eterx-reference-composer-max)] pt-16' }`}>
                {visibleGroups.map((group, visibleGroupIdx) => {
                  const groupIdx = visibleGroupIdx;
                  let turnStartedAt: number | null = null;
                  for (let priorIndex = visibleGroupIdx - 1; priorIndex >= 0; priorIndex -= 1) {
                    const boundary = visibleGroups[priorIndex]?.[0];
                    if (!isFeedTurnBoundary(boundary)) continue;
                    turnStartedAt = normalizeWorkTimestamp(
                      boundary?.startTime ?? boundary?.timestamp ?? boundary?.endTime,
                    );
                    break;
                  }
                  // Unknown recovery boundaries exist only to keep orphaned
                  // work attached to the correct internal phase. They are not
                  // user messages and must never render an "Agent request" or
                  // "Recovered request" bubble. The following work group stays
                  // mounted, so genuine thoughts and actions remain visible.
                  if (isHiddenRecoveredUserBoundary(group[0])) return null;
                  const isThinkingTurn = feedWorkActive && groupIdx === activeWorkGroupIndex;
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
                  const showDateDivider = Boolean(thisDateKey && thisDateKey !== prevDateKey);
                  const dateLabel = showDateDivider ? formatDateLabel(thisDateKey) : '';

                  return (
                    <div
                      key={`group-${ conversationIdentity }-${ visibleGroupMountKeys[visibleGroupIdx] }`}
                    >
                      {showDateDivider && dateLabel && (
                        <ChatDateDivider label={dateLabel} />
                      )}
                      <ChatFeedMessageGroup
                        group={group}
                        groupIdx={groupIdx}
                        turnStartedAt={turnStartedAt}
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
