import { setRuntimePlanMode } from './plan-mode';
import { requestManualCompaction, isManualCompactionActive } from './manual-compaction';
import { compactSavedWorkingContext } from './working-context-checkpoint';
import { compactContextAtBoundary } from './resilience/context-compaction';
import { GoogleGenAI } from '@google/genai';
import { isPastedText, pastedTextManifest } from '../pasted-text';
import { randomUUID } from 'crypto';
import { AgentOrchestrator } from './orchestrator';
import { apiKeyPool, type KeyLease } from './api-key-pool';
import { taskStore } from './task-store';
import { writeRuntimeTrace } from './runtime-trace';
import { getMainAgentModelConfig, type MainAgentMode, type MainAgentProvider } from './model-routing';
import { MODEL_PROVIDER_MODE, isModelProvider } from './model-selector-store';
import { buildScopedRuntimeSettings, getScopedRuntimeApiKey, type ScopedRuntimeSettings } from './runtime-api-keys';
import { flushLedgerForChat } from './memory/conversation-ledger';
import { globalToolRegistry } from './tools/registry';
import { observeUserProxy, startUserProxyRuntime, stopUserProxyRuntime, pauseUserProxyRuntime, resumeUserProxyRuntime, setUserProxyIntervention, setUserProxyModel, getUserProxyManagerSnapshot, deliverUserProxyManagerDirective, type ProxyInterventionLevel, type ProxyManagerDirective } from './autonomy/user-proxy-runtime';
import { cancelPendingProxyTasks, claimDormantProxyDirectives, claimNextProxyTask, completeProxyTask, enqueueProxyTasks, getPendingProxyTaskCount, readProxyControl, saveDormantProxyDirective, settleProxyTask, updateProxyControl, type ProxyTaskInput } from './autonomy/proxy-control-plane';
import { agentMessageBus, cancelAgent, cancelAllSubAgents, clearCancelState, clearPendingResults, globalSubAgentSpawner } from './roles/sub_agent';
import { interAgentMailbox } from './roles/inter_agent_comm';
import { normalizeAttachmentMime } from './attachment-pipeline';
import { normalizeStreamTimestamp } from '../streaming-lifecycle';
import { getEterxWorkspaceDir } from './storage-paths';
import { delegationTelemetryFromTrace } from './delegation-evidence';
import { filterLiveUserVisibleTraces, isLiveUserVisibleTrace } from './trace-visibility';
import { areLikelySameFeedActionLifecycle, createStoppedRunTrace, getFeedActionSingletonIdentity, haveConflictingFeedActionInvocations, isFeedTraceExplicitlySettled, isFeedTraceOpen, isFeedTurnBoundary } from '../chat-feed-lifecycle';
import { getContextFabricForChat } from './context-fabric';
import { formatUnknownError } from './error-format';
import { contextMeasurementTime, contextUsageScopeKey } from '../context-usage-snapshot';
import { getCodingMode } from '../code/coding-modes';
import { sameUserAdmission, normalizeAdmissionId } from '../steering-delivery';

// Ensure tools are bootstrapped
import './tools/index';

/**
 * AgentRegistry — Per-Chat Agent Execution with Full Independence
 * 
 * This is the core of agent independence. Every chat gets its own:
 * - Dedicated API key (via APIKeyPool lease)
 * - Independent execution thread (fire-and-forget Promise)
 * - In-memory trace buffer (for UI polling/reconnection)
 * - Per-chat cancel flag (stopping one chat doesn't affect others)
 * - Per-chat status tracking
 * 
 * The UI is completely decoupled:
 * - POST /api/agent/start → fires agent, returns immediately
 * - GET /api/agent/poll → reads from the trace buffer
 * - POST /api/agent/stop → sets per-chat cancel flag
 * 
 * Even if the browser closes, the agent keeps running on the server.
 * When the browser reopens, it polls and gets all buffered traces.
 */

interface TraceEvent {
  index: number;        // Sequential index for incremental polling
  timestamp: number;
  data: any;            // The raw trace event
}

interface SteeringMessage {
  id: string;
  text: string;
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, any>;
}

interface AgentExecution {
  chatId: string;
  /** Stable client/server run identity. Prevents an old poll response from being applied to a newer run. */
  runId: string;
  /** Visible query boundary currently receiving events inside this long-lived run. */
  activeTurnId: string;
  /** Each worker conversation has an independent visible query boundary. */
  activeAuxiliaryTurnIds: Map<string, string>;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  completedAt?: number;
  traceBuffer: TraceEvent[];   // In-memory circular buffer
  traceCounter: number;        // Monotonic counter — NEVER resets, survives buffer trimming
  /** Locks tool children/results to the turn where their owning action began. */
  traceOwnerTurns: Map<string, string>;
  /** Same lifecycle lock projected inside each worker conversation. */
  traceOwnerAuxiliaryTurns: Map<string, string>;
  finalAnswer: string;
  error?: string;
  cancelled: boolean;          // Per-chat cancel flag
  abortController: AbortController; // Per-run cancellation; later runs cannot reset it
  settled: boolean;            // Persistence and resource cleanup have finished
  promise: Promise<void>;      // The running execution
  keyLeaseId: string;          // API key lease identifier
  steeringQueue: SteeringMessage[]; // Live steering messages from user mid-run
  /** IDs accepted by this run, including messages already drained/applied. */
  acceptedSteeringIds: Set<string>;
  mode: MainAgentMode;
  // === EXECUTION METRICS (new) ===
  toolCallCount: number;       // Total tool calls in this execution
  effectiveModel: string;      // Actual model used (may differ from mode due to smart routing)
  complexity: string;          // Task complexity classification
  peakMemoryMB: number;        // Peak memory usage during execution
  lastMemorySampleAt: number;
  retentionCompacted?: boolean;
  orchestratorProjectId?: string;
  launchSpec: {
    history: any[];
    mode: MainAgentMode;
    userId: string;
    pinnedContext: any;
    mediaAttachments: any[];
    userName: string;
    runtimeSettings?: ScopedRuntimeSettings | null;
  };
}

const QUERY_OWNED_ACTION_TYPES = new Set([
  'command', 'tool_call', 'exploration', 'file_edit', 'browser',
  'communication', 'sub_agent_action', 'task_plan',
]);

/**
 * Provider adapters do not agree on one lifecycle ID field. Normalize every
 * supported correlation field so starts, progress snapshots, previews, and
 * settlements all resolve to the immutable query that created the action.
 */
function actionCorrelationContent(trace: any): string {
  const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const tool = normalize(trace?.tool || trace?.toolName || trace?.name);
  const operation = [
    trace?.command,
    trace?.filepath || trace?.filename,
    trace?.query || trace?.searchQuery,
  ].map(normalize).filter(Boolean);
  return (operation.length > 0
    ? [tool, ...operation]
    : [tool, normalize(trace?.secondary)])
    .filter(Boolean)
    .join('|')
    .slice(0, 640);
}

/** IDs that identify exactly one action lifecycle. */
function actionStrongOwnerKeys(trace: any, fallbackTurnId = ''): string[] {
  const singletonIdentity = getFeedActionSingletonIdentity(trace);
  const singletonTurnId = String(trace?.turnId || fallbackTurnId || '').trim();
  const values: Array<[string, unknown]> = [
    ['origin', trace?._originTraceIdx],
    // A decomposer is a singleton only inside one visible query. Scoping this
    // key prevents a still-open plan from the previous guidance phase from
    // claiming the next query's real decomposer lifecycle.
    ['singleton', singletonIdentity && singletonTurnId ? `${ singletonTurnId }:${ singletonIdentity }` : ''],
    ['trace', trace?.ownerTraceId],
    ['trace', trace?.traceId],
    ['tool', trace?.toolCallId],
    ['response', trace?.responseKey],
    ['event', trace?.id],
  ];
  return [...new Set(values
    .map(([kind, value]) => {
      const identity = String(value ?? '').trim();
      return identity ? `${ kind }:${ identity }` : '';
    })
    .filter(Boolean))];
}

/**
 * streamId/taskId identify a transport or background process, not necessarily
 * one UI action. Scope them by the real command/tool/file content so two calls
 * sharing a process cannot replace one another or steal query ownership.
 */
function actionTransportOwnerKeys(trace: any): string[] {
  const content = actionCorrelationContent(trace);
  if (!content) return [];
  const values: Array<[string, unknown]> = [
    ['stream', trace?.streamId],
    ['task', trace?.taskId || trace?.backgroundTaskId],
  ];
  return [...new Set(values
    .map(([kind, value]) => {
      const identity = String(value ?? '').trim();
      return identity ? `${ kind }:${ identity }:${ content }` : '';
    })
    .filter(Boolean))];
}

function actionOwnerKeys(trace: any, fallbackTurnId = ''): string[] {
  return [...new Set([
    ...actionStrongOwnerKeys(trace, fallbackTurnId),
    ...actionTransportOwnerKeys(trace),
  ])];
}

interface QueuedUserFollowUp {
  id: string;
  runId: string;
  chatId: string;
  prompt: string;
  mediaAttachments: any[];
  createdAt: number;
  steeringMessages?: Array<{ id: string; text: string; attachments?: any[]; createdAt?: number }>;
  runtimeOverride?: {
    mode: MainAgentMode;
    selectedModelProvider: string;
    selectedModelName: string;
    thinkingLevel?: string;
    modelThinkingCapability?: any;
    modelWireCapabilities?: string[];
    runtimeSettings?: ScopedRuntimeSettings;
  };
}

export interface QueuedUserFollowUpSummary {
  id: string;
  runId: string;
  chatId: string;
  text: string;
  createdAt: number;
  attachmentCount: number;
  attachments?: any[];
  steeringIds?: string[];
  modelSelection?: string;
  thinkingLevel?: string;
}

const AGENT_BUILDER_INTERNAL_REQUEST_PATTERN = /^\[AGENT BUILDER REQUEST\]\s*\r?\nTarget agent ID:[^\r\n]*\r?\n\s*\r?\n\[USER REQUEST\]\s*\r?\n?([\s\S]*)$/i;

const getVisibleRunPrompt = (prompt: string): string => {
  const match = String(prompt || '').match(AGENT_BUILDER_INTERNAL_REQUEST_PATTERN);
  return match ? String(match[1] || '').trim() : String(prompt || '');
};

export const buildProxyTaskHistory = (
  baseHistory: any[],
  previousPrompt: string,
  previousAnswer: string,
  hasDependency: boolean,
): any[] => {
  const history = Array.isArray(baseHistory) ? [...baseHistory] : [];
  if (!hasDependency) return history;

  history.push({ role: 'user', parts: [{ text: previousPrompt }] });
  if (previousAnswer) history.push({ role: 'model', parts: [{ text: previousAnswer }] });
  return history;
};

const MAX_TRACE_BUFFER = 2000;          // Max traces kept in memory per chat
// Completion must not make already-rendered activity disappear. Keep the same
// event budget after settlement; payload-heavy traces are compacted separately.
const MAX_COMPLETED_TRACE_BUFFER = MAX_TRACE_BUFFER;
const MAX_STEERING_QUEUE = 25;
const MAX_USER_FOLLOW_UP_QUEUE = 50;
const MAX_COMPLETED_EXECUTIONS = 30;
const TRACE_COMPACTION_GRACE_MS = 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Cleanup completed agents frequently
const TASK_STORE_CLEANUP_INTERVAL = 15 * 60 * 1000;
const MAX_COMPLETED_AGE = 2 * 60 * 60 * 1000; // 2 hours max retention for completed agents
const LIVE_STREAM_WAKE_WINDOW_MS = 16;
const COALESCIBLE_LIVE_TRACE_TYPES = new Set([
  'answer',
  'work_note',
  'thought_stream',
  'console_output',
  'file_preview',
]);

const trimTraceBufferWithBoundary = (traceBuffer: TraceEvent[], limit: number): TraceEvent[] => {
  if (!Array.isArray(traceBuffer) || traceBuffer.length <= limit) return traceBuffer;
  const firstUserBoundaryIndex = traceBuffer.findIndex(entry => entry?.data?.type === 'user_action');
  const retainedIndexes = new Set<number>();
  if (firstUserBoundaryIndex >= 0) retainedIndexes.add(firstUserBoundaryIndex);

  let remaining = Math.max(0, limit - retainedIndexes.size);
  let segmentEnd = traceBuffer.length - 1;
  while (segmentEnd >= 0 && remaining > 0) {
    let boundaryIndex = -1;
    for (let index = segmentEnd; index >= 0; index -= 1) {
      if (isFeedTurnBoundary(traceBuffer[index]?.data)) {
        boundaryIndex = index;
        break;
      }
    }

    const contentStart = boundaryIndex >= 0 ? boundaryIndex + 1 : 0;
    if (boundaryIndex >= 0 && !retainedIndexes.has(boundaryIndex)) {
      retainedIndexes.add(boundaryIndex);
      remaining -= 1;
      if (remaining <= 0) break;
    }

    const availableContent = Math.max(0, segmentEnd - contentStart + 1);
    const contentToKeep = Math.min(remaining, availableContent);
    const retainedContentStart = segmentEnd - contentToKeep + 1;
    for (let index = retainedContentStart; index <= segmentEnd; index += 1) {
      retainedIndexes.add(index);
    }
    remaining -= contentToKeep;
    segmentEnd = boundaryIndex >= 0 ? boundaryIndex - 1 : -1;
  }

  return [...retainedIndexes]
    .sort((left, right) => left - right)
    .map(index => traceBuffer[index]);
};

class AgentRegistry {
  private executions: Map<string, AgentExecution> = new Map();
  private archivedExecutions: Map<string, AgentExecution[]> = new Map();
  private traceWaiters: Map<string, Set<() => void>> = new Map();
  /** One frame-sized wake reservation per chat for cumulative live snapshots. */
  private traceWakeTimers: Map<string, NodeJS.Timeout> = new Map();
  private traceChangeVersions: Map<string, number> = new Map();
  private lastProcessMemorySampleAt = 0;
  private lastProcessMemoryMB = 0;
  private desktopClosePolicy: { keepScheduled?: boolean; keepChannels?: boolean } | null = null;
  private desktopAdmissionEpoch = 0;
  private userFollowUpQueues: Map<string, QueuedUserFollowUp[]> = new Map();
  private userFollowUpReceipts: Map<string, Map<string, QueuedUserFollowUpSummary>> = new Map();
  private cancelledFollowUpAdmissions: Map<string, Set<string>> = new Map();
  private pendingRunCancellations: Map<string, { runId?: string; expiresAt: number }> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private lastTaskStoreCleanupAt = 0;

  public getLifecycleVersion(): number {
    return 4;
  }

  private findExecution(runtimeId: string): AgentExecution | undefined {
    const direct = this.executions.get(runtimeId);
    if (direct) return direct;
    const aliases = Array.from(this.executions.values())
      .filter(execution => execution.orchestratorProjectId === runtimeId);
    // An alias collision is ambiguous. Failing closed is safer than steering
    // whichever chat happened to be inserted first.
    return aliases.length === 1 ? aliases[0] : undefined;
  }

  private archiveExecution(execution: AgentExecution): void {
    if (!execution?.runId || !execution.settled) return;
    const archives = this.archivedExecutions.get(execution.chatId) || [];
    const withoutDuplicate = archives.filter(candidate => candidate.runId !== execution.runId);
    withoutDuplicate.push(execution);
    // Queue handoffs only need a short predecessor window, but retain a few
    // runs so multiple fast follow-ups can still reconcile in exact order.
    this.archivedExecutions.set(execution.chatId, withoutDuplicate.slice(-4));
  }

  private getArchivedExecution(chatId: string, runId: string): AgentExecution | undefined {
    if (!runId) return undefined;
    return this.archivedExecutions.get(chatId)?.find(execution => execution.runId === runId);
  }

  constructor() {
    // Any persisted `running` task belongs to a previous process after a
    // desktop restart. Convert it before the UI can rehydrate it as live.
    taskStore.recoverOrphanedRunningTasks().catch(() => {});
    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
    this.cleanupTimer.unref?.();
  }

  private getProcessMemoryMB(): number {
    const now = Date.now();
    if (this.lastProcessMemorySampleAt && now - this.lastProcessMemorySampleAt < 1000) {
      return this.lastProcessMemoryMB;
    }
    try {
      this.lastProcessMemorySampleAt = now;
      this.lastProcessMemoryMB = Math.round(process.memoryUsage.rss() / 1024 / 1024);
      return this.lastProcessMemoryMB;
    } catch {
      return 0;
    }
  }

  private compactTracePayload(data: any): any {
    if (!data || typeof data !== 'object') return data;

    if (data.type === 'file_preview') {
      const { content, diffLines, ...rest } = data;
      const compact: any = { ...rest };
      if (typeof content === 'string') {
        compact.contentPreview = content.substring(0, 2000);
        compact._contentStripped = content.length > compact.contentPreview.length;
      }
      if (Array.isArray(diffLines)) {
        compact.diffLines = diffLines.slice(-80);
        compact._diffLinesStripped = diffLines.length > compact.diffLines.length;
      }
      return compact;
    }

    if (data.type === 'console_output') {
      const { output, content, outputPreview, ...rest } = data;
      const outputText = String(output ?? content ?? outputPreview ?? '');
      const maxChars = 6_000;
      const isDelta = data.isDelta === true;
      const compactOutput = outputText.length <= maxChars
        ? outputText
        : isDelta
          ? outputText.slice(-maxChars)
          : `${ outputText.slice(0, 1_500) }\n...[terminal output compacted]...\n${ outputText.slice(-(maxChars - 1_500)) }`;
      const outputEnd = Number(data.outputEnd);
      return {
        ...rest,
        output: compactOutput,
        ...(isDelta && outputText.length > maxChars && Number.isFinite(outputEnd)
          ? { outputStart: Math.max(0, outputEnd - compactOutput.length) }
          : {}),
        _contentStripped: data._contentStripped === true || outputText.length > compactOutput.length,
      };
    }

    // Thought streams are cumulative snapshots. Truncating one snapshot makes
    // the next merge treat the compacted marker as real model output and can
    // permanently lose the remainder of the reasoning in the UI. Keep the
    // complete thought stream; work notes remain bounded because they are
    // user-facing summaries rather than the model's full stream.
    if (data.type === 'work_note' && typeof data.text === 'string' && data.text.length > 12000) {
      return {
        ...data,
        text: `${ data.text.substring(0, 12000) }\n...[trace compacted]`,
        _contentStripped: true,
      };
    }

    return data;
  }

  private compactExecutionForRetention(execution: AgentExecution): void {
    if (execution.status === 'running') return;
    if (execution.retentionCompacted) return;
    if (execution.completedAt && Date.now() - execution.completedAt < TRACE_COMPACTION_GRACE_MS) return;

    execution.prompt = execution.prompt.substring(0, 2000);
    execution.steeringQueue = [];
    execution.traceBuffer = trimTraceBufferWithBoundary(
      execution.traceBuffer,
      MAX_COMPLETED_TRACE_BUFFER,
    )
      .map(entry => ({
        ...entry,
        data: this.compactTracePayload(entry.data),
      }));
    execution.retentionCompacted = true;
  }

  public appendTrace(execution: AgentExecution, traceEvent: any, persistToTaskStore = true): TraceEvent {
    if (traceEvent?.type === 'steering_applied') {
      const admission = normalizeAdmissionId(String(traceEvent.admissionId || traceEvent.steeringId || '').trim());
      const owner = String(traceEvent.subAgentChatId || traceEvent.subAgentId || traceEvent.subAgent || 'main');
      const applied = admission ? execution.traceBuffer.find(entry => {
        const previous = entry.data;
        return previous?.type === 'steering_applied' &&
          normalizeAdmissionId(String(previous.admissionId || previous.steeringId || '').trim()) === admission &&
          String(previous.subAgentChatId || previous.subAgentId || previous.subAgent || 'main') === owner;
      }) : undefined;
      // Replaying an acknowledgement must not reactivate an older guidance
      // turn after a second correction has already entered model context.
      if (applied) return applied;
    }
    if (isFeedTurnBoundary(traceEvent)) {
      const admitted = execution.traceBuffer.find(entry => sameUserAdmission(entry.data, {
        ...traceEvent, ownerChatId: traceEvent.ownerChatId || execution.chatId,
      }));
      // A repeated receipt is not another query and must not move activeTurnId
      // back to old work or allocate an artificial occurrence boundary.
      if (admitted) return admitted;
    }
    if (traceEvent && typeof traceEvent === 'object') {
      const eventType = String(traceEvent.type || '');
      const reportedTurnId = String(traceEvent.turnId || '').trim();
      const reportedRootTurnId = String(traceEvent.rootTurnId || '').trim();
      const isAuxiliaryMailboxBoundary = eventType === 'inter_agent_message' &&
        String(traceEvent.agentName || traceEvent.to || '').trim().toLowerCase() !== 'main' &&
        Boolean(traceEvent.subAgentId || traceEvent.subAgentChatId);
      const auxiliaryIdentity = String(
        traceEvent.subAgentId || traceEvent.subAgentChatId || '',
      ).trim();
      const auxiliaryOwner = (!/^sub_agent_|^inter_agent_/.test(eventType) || isAuxiliaryMailboxBoundary)
        ? auxiliaryIdentity
        : '';
      let auxiliaryTurnId = auxiliaryIdentity
        ? String(execution.activeAuxiliaryTurnIds.get(auxiliaryIdentity) || '').trim()
        : '';
      if (auxiliaryIdentity && !auxiliaryTurnId) {
        auxiliaryTurnId = `subagent-task:${ auxiliaryIdentity }`;
        execution.activeAuxiliaryTurnIds.set(auxiliaryIdentity, auxiliaryTurnId);
      }
      let currentRootTurnId = String(execution.activeTurnId || execution.runId).trim();
      const rootActionScope = auxiliaryOwner
        ? reportedRootTurnId || currentRootTurnId
        : reportedTurnId || currentRootTurnId || execution.runId;
      const auxiliaryActionScope = auxiliaryTurnId || reportedTurnId || `subagent-task:${ auxiliaryIdentity }`;
      const incomingRootActionOwnerKeys = actionOwnerKeys(
        { ...traceEvent, turnId: rootActionScope },
        rootActionScope,
      );
      const incomingAuxiliaryActionOwnerKeys = auxiliaryIdentity
        ? actionOwnerKeys(
          { ...traceEvent, turnId: auxiliaryActionScope },
          auxiliaryActionScope,
        )
        : [];
      const streamIdentity = eventType === 'answer' || eventType === 'answer_cancel'
        ? String(traceEvent.answerId || '').trim()
        : eventType === 'work_note' || eventType === 'work_note_cancel'
          ? String(traceEvent.noteId || '').trim()
          : eventType === 'thought_stream'
            ? String(traceEvent.thoughtId || '').trim()
            : '';
      const rootStreamTurnScope = String(rootActionScope || execution.runId).trim();
      const auxiliaryStreamTurnScope = String(auxiliaryActionScope || '').trim();
      const streamType = eventType.replace('_cancel', '');
      const streamAgentScope = String(
        traceEvent.subAgentChatId || traceEvent.subAgentId || traceEvent.subAgent || 'main',
      ).trim();
      const rootStreamOwnerKeys = streamIdentity
        ? [
          `${ rootStreamTurnScope }:${ streamType }:${ streamIdentity }`,
          `stream:${ streamAgentScope }:${ streamType }:${ streamIdentity }`,
        ]
        : [];
      const auxiliaryStreamOwnerKeys = streamIdentity && auxiliaryIdentity
        ? [
          `${ auxiliaryStreamTurnScope }:${ streamType }:${ streamIdentity }`,
          `stream:${ streamAgentScope }:${ streamType }:${ streamIdentity }`,
        ]
        : [];
      // Turn ownership is established when the action/stream first appears.
      // A guidance event can advance activeTurnId while an older provider or
      // tool callback is still in flight, so callback arrival time must never
      // be used to move that existing row into the new query.
      const mappedRootTurnId = String(
        incomingRootActionOwnerKeys
          .map(key => execution.traceOwnerTurns.get(key))
          .find(Boolean)
        || rootStreamOwnerKeys.map(key => execution.traceOwnerTurns.get(key)).find(Boolean)
        || '',
      ).trim();
      const mappedAuxiliaryTurnId = String(
        incomingAuxiliaryActionOwnerKeys
          .map(key => execution.traceOwnerAuxiliaryTurns.get(key))
          .find(Boolean)
        || auxiliaryStreamOwnerKeys
          .map(key => execution.traceOwnerAuxiliaryTurns.get(key))
          .find(Boolean)
        || '',
      ).trim();
      const mappedLifecycleEntry = mappedRootTurnId || mappedAuxiliaryTurnId
        ? [...execution.traceBuffer].reverse().find(entry => {
          const existing = entry?.data;
          if (!existing || isFeedTurnBoundary(existing)) return false;
          const existingRootActionKeys = new Set(actionOwnerKeys(
            { ...existing, turnId: String(existing?.turnId || existing?.runId || '').trim() },
            String(existing?.turnId || existing?.runId || '').trim(),
          ));
          const existingAuxiliaryActionKeys = new Set(actionOwnerKeys(
            { ...existing, turnId: String(existing?.subAgentTurnId || '').trim() },
            String(existing?.subAgentTurnId || '').trim(),
          ));
          const sharesActionIdentity = incomingRootActionOwnerKeys.some(identity => existingRootActionKeys.has(identity)) ||
            incomingAuxiliaryActionOwnerKeys.some(identity => existingAuxiliaryActionKeys.has(identity));
          // A generic adapter event id can be reused by a later or parallel
          // invocation. It may locate a candidate, but explicit provider call
          // identities decide whether that candidate is allowed to keep its
          // old query owner.
          const sameAction = sharesActionIdentity &&
            !haveConflictingFeedActionInvocations(existing, traceEvent);
          const existingType = String(existing.type || '').replace('_cancel', '');
          const incomingType = eventType.replace('_cancel', '');
          const existingStreamIdentity = existingType === 'answer'
            ? String(existing.answerId || '').trim()
            : existingType === 'work_note'
              ? String(existing.noteId || '').trim()
              : existingType === 'thought_stream'
                ? String(existing.thoughtId || '').trim()
                : '';
          const sameStream = Boolean(
            streamIdentity &&
            existingType === incomingType &&
            existingStreamIdentity === streamIdentity &&
            String(existing.subAgentChatId || existing.subAgentId || existing.subAgent || 'main').trim() === streamAgentScope
          );
          return sameAction || sameStream;
        })
        : undefined;
      const mappedLifecycleStillOpen = Boolean(
        mappedLifecycleEntry && isFeedTraceOpen(mappedLifecycleEntry.data),
      );
      // Provider-local IDs can restart after a message boundary. An open
      // lifecycle or an explicitly addressed snapshot retains its old owner;
      // an unscoped reused ID can start a new row in the current query.
      const ownerRootTurnId = mappedRootTurnId && (
        mappedRootTurnId === currentRootTurnId || mappedLifecycleStillOpen ||
        (Boolean(streamIdentity) && reportedTurnId === mappedRootTurnId)
      )
        ? mappedRootTurnId
        : '';
      const ownerAuxiliaryTurnId = mappedAuxiliaryTurnId && (
        mappedAuxiliaryTurnId === auxiliaryTurnId || mappedLifecycleStillOpen ||
        (Boolean(streamIdentity) && String(traceEvent.subAgentTurnId || reportedTurnId) === mappedAuxiliaryTurnId)
      )
        ? mappedAuxiliaryTurnId
        : '';
      const isTurnBoundary = eventType === 'user_action' || eventType === 'steering_received' || isAuxiliaryMailboxBoundary;
      // Acknowledging guidance creates its visible boundary immediately, but
      // the execution owner changes only when Main actually consumes it. This
      // closes the receive->apply gap where late progress from the preceding
      // phase used to be stamped onto the new query.
      const activatesAuxiliaryTurn = Boolean(
        auxiliaryOwner && (eventType === 'user_action' || isAuxiliaryMailboxBoundary)
      );
      const activatesRootTurn = Boolean(
        !auxiliaryOwner && (eventType === 'user_action' || eventType === 'steering_applied')
      );
      if (activatesAuxiliaryTurn || activatesRootTurn) {
        let boundaryTurnId = reportedTurnId
          || String(traceEvent.id || traceEvent.steeringId || traceEvent.messageId || '').trim()
          || (activatesAuxiliaryTurn ? auxiliaryTurnId : currentRootTurnId)
          || execution.runId;
        if (eventType === 'steering_applied') {
          const steeringId = String(traceEvent.steeringId || '').trim();
          const admittedProxyBoundary = steeringId
            ? [...execution.traceBuffer].reverse().find((entry) => {
              const existing = entry?.data;
              return existing?.type === 'user_action' &&
                String(existing.steeringId || '').trim() === steeringId;
            })?.data
            : undefined;
          // Proxy guidance is first admitted as a visible user boundary and
          // then reported as steering_applied. If its provider turn ID was
          // repaired for reuse, the apply event must retain that canonical
          // owner rather than resetting activeTurnId to the stale provider ID.
          boundaryTurnId = String(admittedProxyBoundary?.turnId || boundaryTurnId).trim();
        }
        if (eventType === 'user_action') {
          const boundaryOwner = auxiliaryOwner || 'main';
          const hasEarlierBoundaryWithSameOwner = execution.traceBuffer.some((entry) => {
            const existing = entry?.data;
            if (existing?.type !== 'user_action') return false;
            const existingOwner = String(
              existing.subAgentChatId || existing.subAgentId || existing.subAgent || 'main',
            ).trim();
            return existingOwner === boundaryOwner &&
              String(existing.turnId || existing.runId || '').trim() === boundaryTurnId;
          });
          if (hasEarlierBoundaryWithSameOwner) {
            // Provider-local turn/message IDs may restart inside a long-lived
            // Proxy execution. A user Send is nevertheless a new immutable
            // ownership boundary. Give the repeated transport ID a monotonic
            // internal occurrence so subsequent notes/actions cannot inherit
            // the preceding query merely because their provider IDs repeat.
            boundaryTurnId = `${ boundaryTurnId }:occurrence:${ execution.traceCounter + 1 }`;
          }
        }
        if (activatesAuxiliaryTurn && auxiliaryOwner) {
          execution.activeAuxiliaryTurnIds.set(auxiliaryOwner, boundaryTurnId);
          auxiliaryTurnId = boundaryTurnId;
        }
        if (activatesRootTurn) {
          execution.activeTurnId = boundaryTurnId;
          currentRootTurnId = boundaryTurnId;
        }
      }
      // The first action/stream event establishes immutable ownership. A late
      // callback may be stamped with the currently active guidance turn by an
      // adapter, but that transport-time value cannot move an existing row.
      // Conversely, provider context can lag by one or more guidance messages.
      // A brand-new row always belongs to activeTurnId; reported transport IDs
      // are fallback metadata only when no active visible query exists.
      const resolvedRootTurnId = auxiliaryOwner
        ? ownerRootTurnId || reportedRootTurnId || currentRootTurnId || execution.runId
        : eventType === 'user_action' || eventType === 'steering_applied'
          ? currentRootTurnId || reportedTurnId || execution.runId
          : eventType === 'steering_received'
            ? reportedTurnId || (
              String(traceEvent.steeringId || '').trim()
                ? `steering-turn-${ String(traceEvent.steeringId).trim() }`
                : currentRootTurnId || execution.runId
            )
          : isTurnBoundary
            ? reportedTurnId || currentRootTurnId || execution.runId
            : ownerRootTurnId || currentRootTurnId || reportedTurnId || execution.runId;
      const resolvedAuxiliaryTurnId = auxiliaryIdentity
        ? activatesAuxiliaryTurn
          ? auxiliaryTurnId
          : ownerAuxiliaryTurnId || auxiliaryTurnId || `subagent-task:${ auxiliaryIdentity }`
        : '';
      traceEvent = {
        ...traceEvent,
        ownerChatId: traceEvent.ownerChatId || execution.chatId,
        runId: traceEvent.runId || execution.runId,
        turnId: resolvedRootTurnId,
        ...(auxiliaryIdentity ? {
          // Main and a worker surface can legitimately project the same
          // lifecycle event under different query boundaries. Keep the root
          // owner in turnId and the worker-conversation owner alongside it.
          subAgentTurnId: resolvedAuxiliaryTurnId,
        } : {}),
      };
      if (QUERY_OWNED_ACTION_TYPES.has(eventType)) {
        incomingRootActionOwnerKeys.forEach(key => execution.traceOwnerTurns.set(key, resolvedRootTurnId));
        if (resolvedAuxiliaryTurnId) {
          incomingAuxiliaryActionOwnerKeys.forEach(key =>
            execution.traceOwnerAuxiliaryTurns.set(key, resolvedAuxiliaryTurnId)
          );
        }
      }
      rootStreamOwnerKeys.forEach(key => execution.traceOwnerTurns.set(key, resolvedRootTurnId));
      if (resolvedAuxiliaryTurnId) {
        auxiliaryStreamOwnerKeys.forEach(key =>
          execution.traceOwnerAuxiliaryTurns.set(key, resolvedAuxiliaryTurnId)
        );
      }
      if (eventType === 'answer_cancel') {
        const replacementNoteId = String(traceEvent.replacementNoteId || '').trim();
        if (replacementNoteId) {
          execution.traceOwnerTurns.set(`${ resolvedRootTurnId }:work_note:${ replacementNoteId }`, resolvedRootTurnId);
          execution.traceOwnerTurns.set(
            `stream:${ streamAgentScope }:work_note:${ replacementNoteId }`,
            resolvedRootTurnId,
          );
          if (resolvedAuxiliaryTurnId) {
            execution.traceOwnerAuxiliaryTurns.set(
              `${ resolvedAuxiliaryTurnId }:work_note:${ replacementNoteId }`,
              resolvedAuxiliaryTurnId,
            );
            execution.traceOwnerAuxiliaryTurns.set(
              `stream:${ streamAgentScope }:work_note:${ replacementNoteId }`,
              resolvedAuxiliaryTurnId,
            );
          }
        }
      }
    }
    if (traceEvent?.type === 'error') {
      const errorScope = String(traceEvent.turnId || traceEvent.runId || execution.activeTurnId || execution.runId).trim();
      const isChildError = Boolean(
        traceEvent.subAgentId || traceEvent.subAgentChatId || traceEvent.subAgent ||
        traceEvent.isSubAgent === true || String(traceEvent.agentRole || '').toLowerCase() === 'sub_agent',
      );
      if (!isChildError && !String(traceEvent.id || '').trim()) {
        traceEvent = {
          ...traceEvent,
          id: `run-terminal:${ execution.runId }:${ errorScope || execution.runId }:error`,
        };
      }

      const incomingId = String(traceEvent.id || '').trim();
      if (incomingId) {
        for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
          const existingEntry = execution.traceBuffer[index];
          const existing = existingEntry?.data;
          if (!existing || existing.type !== 'error' || String(existing.id || '').trim() !== incomingId) continue;
          const existingScope = String(existing.turnId || existing.runId || '').trim();
          if (errorScope && existingScope && errorScope !== existingScope) continue;
          execution.traceBuffer.splice(index, 1);
          traceEvent = {
            ...existing,
            ...traceEvent,
            id: incomingId,
            text: formatUnknownError(
              traceEvent.text ?? traceEvent.detail,
              formatUnknownError(existing.text ?? existing.detail, ''),
            ),
            detail: formatUnknownError(
              traceEvent.detail,
              formatUnknownError(existing.detail, ''),
            ) || undefined,
            _originTraceIdx: Number.isFinite(Number(existing._originTraceIdx))
              ? Number(existing._originTraceIdx)
              : existingEntry.index,
            startTime: existing.startTime || existing.timestamp || traceEvent.startTime || traceEvent.timestamp,
          };
          break;
        }
      }
    }
    if (traceEvent?.type === 'context_compaction' && String(traceEvent.compactionId || '').trim()) {
      const incomingCompactionId = String(traceEvent.compactionId).trim();
      const incomingChatId = String(traceEvent.chatId || traceEvent.ownerChatId || execution.chatId).trim();
      // Compaction is a transaction lifecycle, not four independent feed
      // events. Replace its prior phase and append the enriched snapshot with
      // a fresh monotonic delivery cursor. A client that already rendered the
      // active phase receives the retry/terminal update, while a reconnect
      // sees one canonical row for the transaction.
      for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
        const existingEntry = execution.traceBuffer[index];
        const existing = existingEntry?.data;
        if (existing?.type !== 'context_compaction') continue;
        if (String(existing.compactionId || '').trim() !== incomingCompactionId) continue;
        const existingChatId = String(existing.chatId || existing.ownerChatId || execution.chatId).trim();
        if (incomingChatId && existingChatId && incomingChatId !== existingChatId) continue;
        const phaseRank = (phase: unknown) => {
          const normalized = String(phase || '').trim().toLowerCase();
          if (normalized === 'compacted' || normalized === 'failed') return 2;
          if (normalized === 'retrying') return 1;
          return 0;
        };
        const preserveNewerPhase = phaseRank(existing.phase) > phaseRank(traceEvent.phase);
        if (preserveNewerPhase) return existingEntry;
        if (phaseRank(existing.phase) === phaseRank(traceEvent.phase)
          && contextMeasurementTime(traceEvent) < contextMeasurementTime(existing)) return existingEntry;
        if (phaseRank(existing.phase) === 2 && phaseRank(traceEvent.phase) === 2
          && existing.phase !== traceEvent.phase) return existingEntry;
        execution.traceBuffer.splice(index, 1);
        traceEvent = {
          ...existing,
          ...traceEvent,
          id: existing.id || traceEvent.id || `context-compaction:${ incomingCompactionId }`,
          _feedPresentationId: existing._feedPresentationId || traceEvent._feedPresentationId,
          _feedBoundaryId: existing._feedBoundaryId || traceEvent._feedBoundaryId,
          _originTraceIdx: Number.isFinite(Number(existing._originTraceIdx))
            ? Number(existing._originTraceIdx)
            : existingEntry.index,
          startTime: existing.startTime || existing.timestamp || traceEvent.startTime || traceEvent.timestamp,
        };
        break;
      }
      if (!String(traceEvent.id || '').trim()) {
        traceEvent = {
          ...traceEvent,
          id: `context-compaction:${ incomingCompactionId }`,
        };
      }
    }
    if (traceEvent?.type === 'context_usage') {
      const usageKey = contextUsageScopeKey(traceEvent);
      // Context usage is a point-in-time measurement, not an event ledger.
      // A ReAct/tool loop can measure the same query many times; retaining all
      // of those snapshots consumes the trace budget and makes reconnect work
      // grow with provider iterations. Keep only the newest measurement for
      // each query + agent owner, at its newest chronological cursor.
      for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
        const existingEntry = execution.traceBuffer[index];
        const existing = existingEntry?.data;
        if (existing?.type !== 'context_usage') continue;
        if (!usageKey || contextUsageScopeKey(existing) !== usageKey) continue;
        // Producer-local counters (e.g. direct chat / a worker) are not this
        // registry's sequence yet. Compare event time before assigning ours.
        if (contextMeasurementTime(traceEvent) < contextMeasurementTime(existing)) return existingEntry;
        execution.traceBuffer.splice(index, 1);
        traceEvent = {
          ...traceEvent,
          id: existing.id || traceEvent.id || `context-usage:${usageKey}`,
          _originTraceIdx: Number.isFinite(Number(existing._originTraceIdx))
            ? Number(existing._originTraceIdx)
            : existingEntry.index,
        };
        break;
      }
      if (!String(traceEvent.id || '').trim()) {
        traceEvent = {
          ...traceEvent,
          id: `context-usage:${usageKey || `${execution.runId}:${execution.traceCounter}`}`,
        };
      }
    }
    if (traceEvent?.type === 'answer_cancel') {
      const answerId = String(traceEvent.answerId || '').trim();
      const replacementNoteId = String(traceEvent.replacementNoteId || '').trim();
      for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
        const existingEntry = execution.traceBuffer[index];
        const existing = existingEntry?.data;
        // An exact answer identity may be cancelled after a new guidance
        // boundary was already acknowledged. Continue across that boundary so
        // the original visible row is converted in place. Id-less cancellation
        // remains local to the current phase.
        if (isFeedTurnBoundary(existing)) {
          if (answerId) continue;
          break;
        }
        if (existing?.type !== 'answer') continue;
        const existingScope = String(existing.turnId || existing.runId || '').trim();
        const cancelScope = String(traceEvent.turnId || traceEvent.runId || '').trim();
        if (existingScope && cancelScope && existingScope !== cancelScope) continue;
        const sameAnswer = answerId
          ? String(existing.answerId || '').trim() === answerId
          : existing.isStreaming === true || existing.isLiveTyping === true || existing.streamState === 'open';
        if (!sameAnswer) continue;
        if (replacementNoteId && String(existing.text || '').trim()) {
          // Carry the visible text on the transition event too. Incremental
          // clients may have joined after the answer snapshot's cursor; the
          // cancel event must still be sufficient to materialize the durable
          // work note without waiting for a later duplicate publication.
          traceEvent = {
            ...traceEvent,
            replacementText: String(existing.text),
            replacementStartTime: existing.startTime || existing.timestamp,
          };
          // The text was already visible before the provider disclosed its
          // tool call. Keep the original ledger index and presentation row;
          // answer_cancel itself carries the newer cursor to live clients.
          existingEntry.data = {
            ...existing,
            type: 'work_note',
            noteId: replacementNoteId,
            isLive: false,
            isStreaming: false,
            isLiveTyping: false,
            isDelta: false,
            streamState: 'closed',
            status: 'completed',
            _answerTransitionPending: true,
            _streamingCancelled: true,
            _cancelTraceIdx: execution.traceCounter,
            _cancelledAt: traceEvent.timestamp || traceEvent.endTime || Date.now(),
          };
        } else {
          // Retry/steering cancellations do not represent user-facing work and
          // intentionally retract their provisional response.
          execution.traceBuffer.splice(index, 1);
        }
        break;
      }
    }
    if (['answer', 'work_note', 'thought_stream'].includes(String(traceEvent?.type || ''))) {
      const type = String(traceEvent.type);
      const identity = String(
        (type === 'answer'
          ? traceEvent.answerId
          : type === 'work_note'
            ? traceEvent.noteId
            : traceEvent.thoughtId) || '',
      ).trim();
      if (identity) {
        const incomingScope = String(traceEvent.turnId || traceEvent.runId || '').trim();
        const incomingOwner = String(
          traceEvent.subAgentChatId || traceEvent.subAgentId || traceEvent.subAgent || 'main',
        ).trim();
        // Cumulative provider snapshots are updates to one visible row, not
        // separate transcript events. Keep only the newest transport copy in
        // the live buffer. The replacement is appended with a fresh monotonic
        // cursor, so clients that already consumed the prior snapshot still
        // receive the update while reconnects see one canonical row.
        for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
          const existingEntry = execution.traceBuffer[index];
          const existing = existingEntry?.data;
          // Strong stream identities are run-unique and retain an immutable
          // turnId. A late cumulative snapshot may legitimately cross a newer
          // guidance boundary to update its original row.
          if (isFeedTurnBoundary(existing)) continue;
          if (String(existing?.type || '') !== type) continue;
          const existingIdentity = String(
            (type === 'answer'
              ? existing.answerId
              : type === 'work_note'
                ? existing.noteId
                : existing.thoughtId) || '',
          ).trim();
          if (existingIdentity !== identity) continue;
          const existingScope = String(existing.turnId || existing.runId || '').trim();
          const existingOwner = String(
            existing.subAgentChatId || existing.subAgentId || existing.subAgent || 'main',
          ).trim();
          if (incomingScope && existingScope && incomingScope !== existingScope) continue;
          if (incomingOwner !== existingOwner) continue;
          // A delayed streaming callback cannot reopen an answer already
          // finalized for this same turn. Keep the canonical closed snapshot
          // in the buffer so reconnects see the same settled state as live UI.
          if (isFeedTraceExplicitlySettled(existing) && isFeedTraceOpen(traceEvent)) return existingEntry;
          traceEvent = {
            ...traceEvent,
            _originTraceIdx: Number.isFinite(Number(existing?._originTraceIdx))
              ? Number(existing._originTraceIdx)
              : existingEntry.index,
            id: existing?.id || traceEvent.id,
            startTime: existing?.startTime || existing?.timestamp || traceEvent.startTime || traceEvent.timestamp,
          };
          execution.traceBuffer.splice(index, 1);
          break;
        }
      }
    }
    if (traceEvent?.type === 'work_note' && String(traceEvent.text || '').trim()) {
      const incomingText = String(traceEvent.text).replace(/\s+/g, ' ').trim();
      const incomingScope = String(traceEvent.turnId || traceEvent.runId || '').trim();
      const incomingOwner = String(
        traceEvent.subAgentChatId || traceEvent.subAgentId || traceEvent.subAgent || 'main',
      ).trim();
      const incomingAt = Number(traceEvent.startTime || traceEvent.timestamp || Date.now());
      for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
        const existingEntry = execution.traceBuffer[index];
        const existing = existingEntry?.data;
        if (isFeedTurnBoundary(existing)) break;
        if (['model_usage', 'context_usage'].includes(String(existing?.type || ''))) continue;
        if (existing?.type !== 'work_note') break;

        const existingScope = String(existing.turnId || existing.runId || '').trim();
        const existingOwner = String(
          existing.subAgentChatId || existing.subAgentId || existing.subAgent || 'main',
        ).trim();
        const existingText = String(existing.text || '').replace(/\s+/g, ' ').trim();
        if (
          (incomingScope && existingScope && incomingScope !== existingScope) ||
          incomingOwner !== existingOwner ||
          incomingText !== existingText
        ) break;

        const existingAt = Number(existing.endTime || existing.timestamp || existing.startTime || 0);
        if (existingAt > 0 && incomingAt > 0 && Math.abs(incomingAt - existingAt) > 10_000) break;
        const preserveSettled = isFeedTraceExplicitlySettled(existing) && isFeedTraceOpen(traceEvent);
        execution.traceBuffer.splice(index, 1);
        traceEvent = {
          ...existing,
          ...traceEvent,
          id: existing.id || traceEvent.id,
          _feedPresentationId: existing._feedPresentationId || traceEvent._feedPresentationId,
          _feedBoundaryId: existing._feedBoundaryId || traceEvent._feedBoundaryId,
          _originTraceIdx: Number.isFinite(Number(existing._originTraceIdx))
            ? Number(existing._originTraceIdx)
            : existingEntry.index,
          startTime: existing.startTime || existing.timestamp || traceEvent.startTime || traceEvent.timestamp,
          ...(preserveSettled ? {
            isLive: false,
            isStreaming: false,
            isLiveTyping: false,
            isDelta: false,
            streamState: 'closed',
            status: existing.status,
            endTime: existing.endTime,
          } : {}),
        };
        break;
      }
    }
    if (QUERY_OWNED_ACTION_TYPES.has(String(traceEvent?.type || ''))) {
      const incomingScope = String(traceEvent.turnId || traceEvent.runId || '').trim();
      const incomingType = String(traceEvent.type || '').trim().toLowerCase() === 'tool_call'
        ? 'command'
        : String(traceEvent.type || '').trim().toLowerCase();
      const incomingStrongKeys = new Set(actionStrongOwnerKeys(traceEvent, incomingScope));
      for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
        const existingEntry = execution.traceBuffer[index];
        const existing = existingEntry?.data;
        if (!existing || isFeedTurnBoundary(existing)) continue;
        if (!QUERY_OWNED_ACTION_TYPES.has(String(existing.type || ''))) continue;
        const existingType = String(existing.type || '').trim().toLowerCase() === 'tool_call'
          ? 'command'
          : String(existing.type || '').trim().toLowerCase();
        if (existingType !== incomingType) continue;
        const existingScope = String(existing.turnId || existing.runId || '').trim();
        if (incomingScope && existingScope && incomingScope !== existingScope) continue;
        const existingStrongKeys = new Set(actionStrongOwnerKeys(existing, existingScope));
        const sameStrongLifecycle = !haveConflictingFeedActionInvocations(existing, traceEvent) &&
          [...incomingStrongKeys].some(key => existingStrongKeys.has(key));
        if (!sameStrongLifecycle && !areLikelySameFeedActionLifecycle(existing, traceEvent)) continue;

        // Replace the producer snapshot and append the enriched state with a
        // fresh monotonic cursor. Incremental clients receive the settlement,
        // while reconnect/full snapshots contain only one action row.
        execution.traceBuffer.splice(index, 1);
        traceEvent = {
          ...existing,
          ...traceEvent,
          id: existing.id || traceEvent.id,
          traceId: existing.traceId || traceEvent.traceId,
          toolCallId: existing.toolCallId || traceEvent.toolCallId,
          ownerTraceId: existing.ownerTraceId || traceEvent.ownerTraceId,
          _originTraceIdx: Number.isFinite(Number(existing._originTraceIdx))
            ? Number(existing._originTraceIdx)
            : existingEntry.index,
          startTime: existing.startTime || existing.timestamp || traceEvent.startTime || traceEvent.timestamp,
        };
        break;
      }
    }
    if (traceEvent?.type === 'progress' && String(traceEvent.id || '').trim()) {
      const incomingId = String(traceEvent.id).trim();
      const incomingScope = String(traceEvent.turnId || traceEvent.runId || '').trim();
      for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
        const existingEntry = execution.traceBuffer[index];
        const existing = existingEntry?.data;
        if (!existing || existing.type !== 'progress') continue;
        if (String(existing.id || '').trim() !== incomingId) continue;
        const existingScope = String(existing.turnId || existing.runId || '').trim();
        if (incomingScope && existingScope && incomingScope !== existingScope) continue;
        execution.traceBuffer.splice(index, 1);
        traceEvent = {
          ...existing,
          ...traceEvent,
          id: existing.id || traceEvent.id,
          _originTraceIdx: Number.isFinite(Number(existing._originTraceIdx))
            ? Number(existing._originTraceIdx)
            : existingEntry.index,
          startTime: existing.startTime || existing.timestamp || traceEvent.startTime || traceEvent.timestamp,
        };
        break;
      }
    }
    if (traceEvent?.type === 'task_plan') {
      const incomingScope = String(traceEvent.turnId || traceEvent.runId || '').trim();
      const incomingPlanId = String(traceEvent.planId || traceEvent.ownerTraceId || '').trim();
      // A visible query has one plan lifecycle. Decomposer, checkpoint, and
      // automatic progress updates are producer snapshots of that same row,
      // even when an older adapter omitted planId. Scope is authoritative and
      // prevents a later query from inheriting the preceding query's plan.
      for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
        const existingEntry = execution.traceBuffer[index];
        const existing = existingEntry?.data;
        if (!existing || existing.type !== 'task_plan') continue;
        const existingScope = String(existing.turnId || existing.runId || '').trim();
        if (incomingScope && existingScope && incomingScope !== existingScope) continue;
        const existingPlanId = String(existing.planId || existing.ownerTraceId || '').trim();
        if (!incomingScope && incomingPlanId && existingPlanId && existingPlanId !== incomingPlanId) continue;
        execution.traceBuffer.splice(index, 1);
        traceEvent = {
          ...existing,
          ...traceEvent,
          id: existing.id || traceEvent.id,
          planId: existing.planId || traceEvent.planId,
          ownerTraceId: existing.ownerTraceId || traceEvent.ownerTraceId,
          _originTraceIdx: Number.isFinite(Number(existing._originTraceIdx))
            ? Number(existing._originTraceIdx)
            : existingEntry.index,
          startTime: existing.startTime || existing.timestamp || traceEvent.startTime || traceEvent.timestamp,
        };
        break;
      }
    }
    if (traceEvent?.type === 'file_preview') {
      let existingIdx = -1;
      const incomingId = String(traceEvent.id || traceEvent.traceId || '').trim();
      const incomingOwner = String(traceEvent.ownerTraceId || '').trim();
      const incomingPath = String(traceEvent.filepath || traceEvent.filename || '').replace(/\\/g, '/').toLowerCase();
      const incomingScope = String(traceEvent.turnId || traceEvent.runId || '').trim();
      for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
        const existingEntry = execution.traceBuffer[index];
        const existing = existingEntry?.data;
        if (isFeedTurnBoundary(existing)) {
          if (incomingId || incomingOwner) continue;
          break;
        }
        if (existing?.type !== 'file_preview') continue;
        const existingScope = String(existing.turnId || existing.runId || '').trim();
        if (incomingScope && existingScope && incomingScope !== existingScope) continue;
        const existingId = String(existing.id || existing.traceId || '').trim();
        const existingOwner = String(existing.ownerTraceId || '').trim();
        const existingPath = String(existing.filepath || existing.filename || '').replace(/\\/g, '/').toLowerCase();
        const sameIdentity = Boolean(incomingId && existingId === incomingId);
        // One tool call can mutate many files. Ownership alone is not enough:
        // each owner+path pair is an independent progressive preview row.
        const sameOwnerPath = Boolean(
          incomingOwner &&
          existingOwner === incomingOwner &&
          ((!incomingPath && !existingPath) || (incomingPath && existingPath === incomingPath))
        );
        const samePath =
          !incomingOwner &&
          incomingPath &&
          traceEvent.dedupe !== false &&
          existingPath === incomingPath &&
          existing.dedupe !== false;
        if (sameIdentity || sameOwnerPath || samePath) {
          existingIdx = index;
          traceEvent = {
            ...traceEvent,
            _originTraceIdx: Number.isFinite(Number(existing?._originTraceIdx))
              ? Number(existing._originTraceIdx)
              : existingEntry.index,
            startTime: existing?.startTime || existing?.timestamp || traceEvent.startTime || traceEvent.timestamp,
          };
          break;
        }
      }
      if (existingIdx >= 0) execution.traceBuffer.splice(existingIdx, 1);
    }

    const now = Date.now();
    const nextTraceIndex = execution.traceCounter;
    const normalizedTrace = traceEvent && typeof traceEvent === 'object'
      ? {
        ...traceEvent,
        ...(['context_usage', 'context_compaction', 'model_usage'].includes(String(traceEvent.type || ''))
          ? { _contextMeasurementIdx: nextTraceIndex }
          : {}),
        _originTraceIdx: Number.isFinite(Number(traceEvent._originTraceIdx))
          ? Number(traceEvent._originTraceIdx)
          : nextTraceIndex,
        timestamp: normalizeStreamTimestamp(traceEvent.timestamp, now),
        ...(traceEvent.startTime !== undefined
          ? { startTime: normalizeStreamTimestamp(traceEvent.startTime, normalizeStreamTimestamp(traceEvent.timestamp, now)) }
          : {}),
        ...(traceEvent.endTime !== undefined
          ? { endTime: normalizeStreamTimestamp(traceEvent.endTime, normalizeStreamTimestamp(traceEvent.timestamp, now)) }
          : {}),
      }
      : traceEvent;
    const bufferedTrace = normalizedTrace?.type === 'console_output'
      ? this.compactTracePayload(normalizedTrace)
      : normalizedTrace;
    const entry: TraceEvent = {
      index: execution.traceCounter++,
      timestamp: now,
      data: bufferedTrace,
    };

    execution.traceBuffer.push(entry);
    // Mutable stream snapshots are visible live, including real provider
    // thought text. Coalesce only their wake signal into one render frame per
    // chat; the buffer still keeps the newest cumulative snapshot immediately.
    // Boundaries, actions, errors, and terminal snapshots always wake now.
    if (
      !bufferedTrace ||
      typeof bufferedTrace !== 'object' ||
      isLiveUserVisibleTrace(bufferedTrace)
    ) {
      const traceType = String(bufferedTrace?.type || '');
      const canCoalesceWake = COALESCIBLE_LIVE_TRACE_TYPES.has(traceType) &&
        isFeedTraceOpen(bufferedTrace) &&
        Number(bufferedTrace._originTraceIdx) < entry.index;
      this.notifyTraceWaiters(
        execution.chatId,
        canCoalesceWake ? LIVE_STREAM_WAKE_WINDOW_MS : 0,
      );
    }
    if (now - execution.lastMemorySampleAt >= 1000) {
      execution.lastMemorySampleAt = now;
      execution.peakMemoryMB = Math.max(execution.peakMemoryMB || 0, this.getProcessMemoryMB());
    }

    if (normalizedTrace?.type === 'tool_call' || normalizedTrace?.type === 'action') {
      execution.toolCallCount++;
    }

    if (normalizedTrace?.complexity) {
      execution.complexity = normalizedTrace.complexity;
    }

    if (execution.traceBuffer.length > MAX_TRACE_BUFFER) {
      execution.traceBuffer = trimTraceBufferWithBoundary(execution.traceBuffer, MAX_TRACE_BUFFER);
    }

    if (persistToTaskStore) {
      const compactTrace = bufferedTrace;
      taskStore.addTrace(
        execution.chatId,
        compactTrace && typeof compactTrace === 'object'
          ? { ...compactTrace, _traceIdx: entry.index }
          : compactTrace,
        execution.runId,
      );
    }

    return entry;
  }

  private notifyTraceWaiters(chatId: string, delayMs = 0): void {
    // A development reload refreshes this singleton's prototype while live
    // executions stay in place; initialize newly added state lazily as well.
    this.traceChangeVersions ??= new Map();
    this.traceChangeVersions.set(chatId, this.getTraceChangeVersion(chatId) + 1);
    const pendingWake = this.traceWakeTimers.get(chatId);
    if (delayMs > 0) {
      // A poll that subscribes after this append always performs a second
      // cursor/status check, so an idle chat needs neither a timer nor a wake.
      if (!this.traceWaiters.get(chatId)?.size) return;
      // The first token in a frame reserves the wake. Later tokens merely
      // replace the cumulative row, avoiding a request per provider chunk.
      if (pendingWake) return;
      const timer = setTimeout(() => {
        this.traceWakeTimers.delete(chatId);
        this.resolveTraceWaiters(chatId);
      }, delayMs);
      timer.unref?.();
      this.traceWakeTimers.set(chatId, timer);
      return;
    }

    // A semantic event must not wait behind a pending text-frame wake.
    if (pendingWake) {
      clearTimeout(pendingWake);
      this.traceWakeTimers.delete(chatId);
    }
    this.resolveTraceWaiters(chatId);
  }

  private resolveTraceWaiters(chatId: string): void {
    const waiters = this.traceWaiters.get(chatId);
    if (!waiters?.size) return;
    this.traceWaiters.delete(chatId);
    for (const resolve of waiters) resolve();
  }

  public getTraceChangeVersion(chatId: string): number {
    return this.traceChangeVersions?.get(chatId) || 0;
  }

  /**
   * Wait until a trace/status transition may be available without spinning.
   * Poll routes use this to keep every chat live with zero idle polling CPU.
   */
  public waitForTraceChange(
    chatId: string,
    afterIndex: number,
    timeoutMs: number,
    signal?: AbortSignal,
    requestedRunId?: string,
    observedStatus = 'running',
    observedSuccessorRunId?: string,
    observedVersion?: number,
  ): Promise<void> {
    // The waiter is event-driven: appendTrace wakes it immediately. Matching
    // the route's full long-poll window reduces idle request churn across many
    // simultaneous chats without adding any latency to real activity.
    const boundedTimeout = Math.max(0, Math.min(7000, Math.floor(timeoutMs)));
    if (boundedTimeout === 0 || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        const waiters = this.traceWaiters.get(chatId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.traceWaiters.delete(chatId);
        resolve();
      };
      const timer = setTimeout(finish, boundedTimeout);
      timer.unref?.();
      const waiters = this.traceWaiters.get(chatId) || new Set<() => void>();
      waiters.add(finish);
      this.traceWaiters.set(chatId, waiters);
      signal?.addEventListener('abort', finish, { once: true });

      // Close the subscribe-after-read race. A trace can be appended between
      // the route's initial getTraces() call and waiter registration. Recheck
      // only after registration so either this snapshot or appendTrace's
      // notification always wakes the request immediately.
      if (observedVersion !== undefined) {
        // Stream subscriptions compare a cheap event revision, including
        // queue-only changes. This also covers disk-backed recovery whose
        // status legitimately differs from the live registry's idle state.
        if (signal?.aborted || this.getTraceChangeVersion(chatId) !== observedVersion) finish();
      } else {
        const latest = this.getTraces(chatId, afterIndex, requestedRunId);
        if (signal?.aborted || latest.status !== observedStatus || latest.traces.length > 0 ||
          String(latest.successorRunId || '') !== String(observedSuccessorRunId || '')) finish();
      }
    });
  }

  /**
   * Start an agent for a specific chat. Fire-and-forget — returns immediately.
   * The agent runs in the background. UI polls via getTraces().
   */
  public startAgent(
    chatId: string,
    prompt: string,
    history: any[] = [],
    mode: MainAgentMode = 'think',
    userId: string = 'default',
    pinnedContext: any = null,
    mediaAttachments: any[] = [],
    userName: string = 'Developer',
    _preferredGeminiApiKey?: string,
    runtimeSettings?: ScopedRuntimeSettings | null,
    requestedRunId?: string,
    desktopAdmissionEpoch?: number,
  ): { status: 'started' | 'already_running' | 'no_keys' | 'cancelled'; chatId: string; runId?: string; message: string } {

    if (isManualCompactionActive(chatId) && !this.isRunning(chatId)) {
      return { status: 'cancelled', chatId, message: 'Context is compacting. Please send your message again when it finishes.' };
    }
    const source = String(pinnedContext?.triggerSource || '').trim();
    const allowedBackgroundStart = Boolean(this.desktopClosePolicy && (
      (this.desktopClosePolicy.keepScheduled && (source === 'scheduled_task' || pinnedContext?.scheduledTaskId)) ||
      (this.desktopClosePolicy.keepChannels && source === 'gateway')
    ));
    if (!allowedBackgroundStart && (this.desktopClosePolicy ||
      (desktopAdmissionEpoch !== undefined && desktopAdmissionEpoch !== this.getDesktopAdmissionEpoch()))) {
      return { status: 'cancelled', chatId, runId: requestedRunId, message: 'This request was stopped when the app window closed.' };
    }

    if (typeof pinnedContext?.planMode === 'boolean') setRuntimePlanMode(chatId, pinnedContext.planMode);

    // Check if this chat already has a running agent
    const existing = this.executions.get(chatId);
    // The caller-provided run ID is an idempotency key. A retried start request
    // must reconnect to the original run instead of duplicating the task or
    // accidentally converting the same prompt into live steering.
    if (existing && requestedRunId && existing.runId === requestedRunId) {
      return {
        status: 'started',
        chatId,
        runId: existing.runId,
        message: existing.status === 'running'
          ? 'Agent run already accepted'
          : 'Agent run already finished',
      };
    }
    const archivedRequestedExecution = requestedRunId
      ? this.getArchivedExecution(chatId, requestedRunId)
      : undefined;
    if (archivedRequestedExecution) {
      return {
        status: 'started',
        chatId,
        runId: archivedRequestedExecution.runId,
        message: 'Agent run already finished',
      };
    }
    const pendingCancellation = this.pendingRunCancellations.get(chatId);
    if (pendingCancellation && pendingCancellation.expiresAt <= Date.now()) {
      this.pendingRunCancellations.delete(chatId);
    } else if (
      pendingCancellation &&
      (!pendingCancellation.runId || pendingCancellation.runId === requestedRunId)
    ) {
      this.pendingRunCancellations.delete(chatId);
      return {
        status: 'cancelled',
        chatId,
        runId: requestedRunId,
        message: 'This run was stopped before it finished starting.',
      };
    }
    if (existing && !existing.settled) {
      return {
        status: 'already_running',
        chatId,
        runId: existing.runId,
        message: existing.status === 'running'
          ? 'Agent is already running for this chat'
          : 'The previous run is still shutting down. Try again in a moment.',
      };
    }

    // A turn-scoped provider/model selection is authoritative for admission as
    // well as execution.  Using only `mode` here can lease a Gemini key and
    // reject an otherwise valid OpenAI-compatible run before the orchestrator
    // ever gets a chance to select the requested provider.
    const pinnedProvider = typeof pinnedContext?.selectedModelProvider === 'string'
      && isModelProvider(pinnedContext.selectedModelProvider)
      ? pinnedContext.selectedModelProvider
      : '';
    const admissionMode = pinnedProvider
      ? MODEL_PROVIDER_MODE[pinnedProvider as keyof typeof MODEL_PROVIDER_MODE]
      : mode;
    const modelConfig = getMainAgentModelConfig(admissionMode, runtimeSettings);
    const isExternalProvider = modelConfig.provider !== 'gemini';
    const scopedGeminiKeys = runtimeSettings?.apiKeys?.gemini || [];
    const preferredGeminiApiKey = _preferredGeminiApiKey || runtimeSettings?.preferredGeminiApiKey || scopedGeminiKeys[0] || '';

    // Try to lease a Gemini API key only for Gemini runs. External providers use their own
    // keys and should not be blocked by the Gemini key pool.
    let lease: KeyLease | null = null;
    if (!isExternalProvider) {
      if (preferredGeminiApiKey) {
        lease = apiKeyPool.leaseSpecificKey(chatId, preferredGeminiApiKey, 'main_agent');
      }

      if (!lease) {
        for (const key of scopedGeminiKeys) {
          lease = apiKeyPool.leaseSpecificKey(chatId, key, 'main_agent');
          if (lease) break;
        }
      }

      if (!lease) {
        lease = apiKeyPool.leaseKey(chatId, 'main_agent');
      }
    }
    if (!isExternalProvider && !lease) {
      return { status: 'no_keys', chatId, message: 'All API keys are currently in use. Try again in a moment.' };
    }

    // Create the execution record
    const hasExactPinnedModel = typeof pinnedContext?.selectedModelName === 'string'
      && pinnedContext.selectedModelName.trim().length > 0
      && isModelProvider(pinnedContext?.selectedModelProvider);
    const execution: AgentExecution = {
      chatId,
      runId: requestedRunId || randomUUID(),
      activeTurnId: '',
      activeAuxiliaryTurnIds: new Map(),
      prompt,
      status: 'running',
      startedAt: Date.now(),
      traceBuffer: [],
      traceCounter: 0,
      traceOwnerTurns: new Map<string, string>(),
      traceOwnerAuxiliaryTurns: new Map<string, string>(),
      finalAnswer: '',
      cancelled: false,
      abortController: new AbortController(),
      settled: false,
      keyLeaseId: isExternalProvider ? modelConfig.provider : chatId,
      mode,
      promise: Promise.resolve(), // Placeholder, replaced below
      steeringQueue: [],
      acceptedSteeringIds: new Set<string>(),
      // Execution metrics
      toolCallCount: 0,
      effectiveModel: hasExactPinnedModel
        ? pinnedContext.selectedModelName.trim()
        : modelConfig.modelName,
      complexity: 'unknown',
      peakMemoryMB: 0,
      lastMemorySampleAt: 0,
      launchSpec: {
        history,
        mode,
        userId,
        pinnedContext,
        mediaAttachments,
        userName,
        runtimeSettings,
      },
    };
    execution.activeTurnId = execution.runId;

    // Make the new run authoritative before emitting its first trace. A
    // completed predecessor remains in the map until this replacement; if
    // registration happens later, onTrace correctly treats the successor's
    // opening user_action as stale and drops it from the live feed.
    if (existing?.settled) this.archiveExecution(existing);
    this.executions.set(chatId, execution);

    // Build the trace callback that writes to the buffer
    const onTrace = (traceEvent: any) => {
      if (traceEvent && typeof traceEvent === 'object') {
        const reportedRunId = String(traceEvent.runId || '').trim();
        const reportedTurnId = String(traceEvent.turnId || '').trim();
        traceEvent = {
          ...traceEvent,
          ...(reportedRunId && reportedRunId !== execution.runId
            ? { originRunId: reportedRunId }
            : {}),
          ownerChatId: chatId,
          runId: execution.runId,
          // appendTrace resolves absent turn ownership, including locking a
          // late tool result to the turn where its owner action started.
          ...(reportedTurnId ? { turnId: reportedTurnId } : { turnId: undefined }),
        };
      }
      const isConsoleTrace = traceEvent?.type === 'console_output';
      if (!isConsoleTrace || traceEvent?.isStreaming === false) {
        const runtimeTraceEvent = isConsoleTrace
          ? (() => {
            const { output: _output, content: _content, outputPreview: _outputPreview, ...metadata } = traceEvent;
            return metadata;
          })()
          : traceEvent;
        writeRuntimeTrace('agent_trace', {
          chatId,
          event: runtimeTraceEvent,
        });
      }
      // Check per-chat cancellation
      if (execution.cancelled) {
        return;
      }
      const currentExecution = this.executions.get(chatId);
      if (currentExecution && currentExecution !== execution) return;

      // Enrich custom agent traces
      if (pinnedContext?.agentRuntime === 'custom_agent' && pinnedContext?.customAgentId) {
        if (traceEvent && typeof traceEvent === 'object') {
          const customAgentName = String(
            pinnedContext.customAgentName
            || pinnedContext.agentName
            || pinnedContext.customAgentId,
          ).trim();
          const traceType = String(traceEvent.type || '');
          const isRealChildTrace = Boolean(
            traceEvent.subAgentId
            || traceEvent.subAgentChatId
            || traceEvent.auxiliaryRuntime
            || /^sub_agent_/.test(traceType)
            || ['inter_agent_comm', 'inter_agent_message'].includes(traceType),
          );
          const { subAgent: _ownedSubAgent, ...customTrace } = traceEvent;
          traceEvent = {
            ...(isRealChildTrace ? traceEvent : customTrace),
            customAgentId: pinnedContext.customAgentId,
            agentRuntime: 'custom_agent',
            agentName: isRealChildTrace
              ? String(traceEvent.agentName || traceEvent.subAgent || customAgentName)
              : customAgentName,
          };
        }
      }

      this.appendTrace(execution, traceEvent, !pinnedContext?.disableTaskStore);
      if (execution.orchestratorProjectId) {
        observeUserProxy(execution.orchestratorProjectId, traceEvent);
      }
    };

    const preserveUndrainedHumanSteering = () => {
      const pending = execution.steeringQueue.splice(0);
      const humanMessages = pending.filter(item => item.metadata?._autonomyProxy !== true);
      if (humanMessages.length > 0) {
        const last = humanMessages[humanMessages.length - 1];
        const admission = this.queueUserFollowUp(
          chatId, humanMessages.map(item => item.text).join('\n\n'),
          humanMessages.flatMap(item => item.metadata?.attachments || []),
          `steering-turn-${last.id}`, humanMessages[0].createdAt,
          undefined, humanMessages.map(item => ({
            id: item.id, text: item.text, attachments: item.metadata?.attachments || [], createdAt: item.createdAt,
          })),
        );
        if (!admission.accepted) execution.steeringQueue.push(...humanMessages);
      }
      for (const item of pending) {
        if (item.metadata?._autonomyProxy === true) {
          // Proxy guidance accepted after Main's last safe model boundary is
          // still real work. Preserve it as an explicitly Proxy-owned
          // successor instead of silently reporting it as delivered and then
          // discarding it during completion cleanup.
          this.queueProxyTask(
            chatId,
            item.text,
            String(item.metadata?.proxyReason || 'Proxy guidance arrived after the current run completed.'),
          );
          continue;
        }
      }
    };

    const proxyOrigin = pinnedContext?.autonomy?.origin === 'proxy_manager';
    const triggerSource = String(pinnedContext?.triggerSource || '').trim();
    const triggerDelegatedBy = String(pinnedContext?.triggerDelegatedBy || '').trim();
    // Every Main run begins with the same canonical user boundary. Human runs
    // may already have an optimistic local bubble; the client upserts this
    // server-owned trace by run ID. Proxy-started work therefore follows the
    // exact same transcript route instead of relying on a special feed path.
    const runUserEvent = {
      type: 'user_action',
      admissionId: execution.runId,
      _queuedFollowUp: false,
      id: proxyOrigin
        ? `proxy-task-${pinnedContext?.autonomy?.proxyTaskId || execution.runId}`
        : `user-turn-${execution.runId}`,
      text: proxyOrigin
        ? String(pinnedContext?.autonomy?.proxyTaskPrompt || prompt)
        : getVisibleRunPrompt(prompt),
      source: proxyOrigin ? 'proxy_manager' : triggerSource || 'human',
      delegatedBy: proxyOrigin ? 'Side Proxy-Agent' : triggerDelegatedBy || undefined,
      proxyTaskId: proxyOrigin ? pinnedContext?.autonomy?.proxyTaskId : undefined,
      scheduledTaskId: pinnedContext?.scheduledTaskId || undefined,
      modelSelection: pinnedContext?.selectedModelProvider && pinnedContext?.selectedModelName
        ? `${ String(pinnedContext.selectedModelProvider) }:${ String(pinnedContext.selectedModelName) }`
        : undefined,
      selectedModelProvider: pinnedContext?.selectedModelProvider || undefined,
      selectedModelName: pinnedContext?.selectedModelName || undefined,
      thinkingLevel: pinnedContext?.thinkingLevel || undefined,
      selectedAgentId: getCodingMode(pinnedContext?.agentProfile)?.id || pinnedContext?.customAgentId || pinnedContext?.agentId || null,
      selectedAgentName: getCodingMode(pinnedContext?.agentProfile)?.label || pinnedContext?.customAgentName || pinnedContext?.agentName || 'General',
      agentProfile: getCodingMode(pinnedContext?.agentProfile)?.profile,
      chatMode: false,
      attachments: mediaAttachments,
      runId: execution.runId,
      turnId: execution.runId,
      ...(Array.isArray(pinnedContext?.steeringMessages) && pinnedContext.steeringMessages.length > 0 ? {
        steeringMessages: pinnedContext.steeringMessages,
        steeringIds: pinnedContext.steeringMessages.map((item: { id: string }) => item.id),
        deliveryState: 'applied',
      } : {}),
      startTime: execution.startedAt,
      endTime: execution.startedAt,
      timestamp: execution.startedAt,
    };
    onTrace(runUserEvent);

    // Fire-and-forget execution
    execution.promise = (async () => {
      let terminalStatus: AgentExecution['status'] = 'failed';
      const persistTerminalContext = async () => {
        try {
          const fabric = await getContextFabricForChat(chatId);
          fabric.recordAssistantResponse(
            execution.finalAnswer,
            terminalStatus === 'completed'
              ? 'completed'
              : terminalStatus === 'stopped'
                ? 'stopped'
                : 'failed',
            execution.runId,
          );
          await fabric.flush();
        } catch {
          // Chat persistence and the provider result remain authoritative if
          // the continuity index is temporarily unavailable.
        }
      };
      try {
        // Create a dedicated orchestrator for this chat
        const orchestrator = new AgentOrchestrator();

        // Pre-process media (same logic as chat route)
        const fs = require('fs-extra');
        const path = require('path');
        const { randomUUID } = require('crypto');

        const workspaceTemp = getEterxWorkspaceDir('temp');
        const hasMediaAttachments = !!(mediaAttachments && mediaAttachments.length > 0);
        if (hasMediaAttachments) await fs.ensureDir(workspaceTemp);

        const resolveUnder = (rootPath: string, ...segments: string[]) => {
          const root = path.resolve(rootPath);
          const resolved = path.resolve(root, ...segments);
          const relative = path.relative(root, resolved);
          if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
            throw new Error(`Blocked temp path traversal: ${resolved}`);
          }
          return resolved;
        };

        const mediaFiles: { id?: string, path: string, mimeType: string, name: string, fileUri?: string }[] = [];
        const usedMediaNames = new Set<string>();

        const normalizeMediaName = (value: any) => {
          const rawName = String(value || '').trim() || `upload_${ Date.now() }`;
          const safeName = rawName
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/\s+/g, ' ')
            .trim() || `upload_${ Date.now() }`;
          const ext = path.extname(safeName);
          const stem = path.basename(safeName, ext).slice(0, 140) || 'upload';
          return `${ stem }${ ext }`;
        };

        const reserveMediaName = (candidateName: string) => {
          const safeName = normalizeMediaName(candidateName);
          if (!usedMediaNames.has(safeName)) {
            usedMediaNames.add(safeName);
            return safeName;
          }

          const ext = path.extname(safeName);
          const stem = path.basename(safeName, ext);
          let counter = 2;
          let uniqueName = `${ stem }_${ counter }${ ext }`;
          while (usedMediaNames.has(uniqueName)) {
            counter++;
            uniqueName = `${ stem }_${ counter }${ ext }`;
          }
          usedMediaNames.add(uniqueName);
          return uniqueName;
        };

        const isInsideWorkspaceTemp = (candidatePath: string) => {
          try {
            const resolvedPath = path.resolve(candidatePath);
            const resolvedTemp = path.resolve(workspaceTemp);
            return resolvedPath === resolvedTemp || resolvedPath.startsWith(`${ resolvedTemp }${ path.sep }`);
          } catch {
            return false;
          }
        };

        const getRunScopedMediaName = (att: any, index: number, sourcePath?: string) => {
          if (sourcePath && isInsideWorkspaceTemp(sourcePath)) {
            return reserveMediaName(path.basename(sourcePath));
          }

          const baseName = normalizeMediaName(att?.name || (sourcePath ? path.basename(sourcePath) : '') || `upload_${ index }`);
          const uniquePrefix = `${ Date.now() }_${ index }_${ randomUUID().slice(0, 8) }`;
          return reserveMediaName(`${ uniquePrefix }_${ baseName }`);
        };

        if (hasMediaAttachments) {
          for (let attachmentIndex = 0; attachmentIndex < mediaAttachments.length; attachmentIndex++) {
            const att = mediaAttachments[attachmentIndex];
            const mimeType = normalizeAttachmentMime(
              att.name || att.path || `attachment_${attachmentIndex}`,
              att.mimeType,
            );

            if (att.path && await fs.pathExists(att.path)) {
              const sourcePath = path.resolve(att.path);
              const safeName = getRunScopedMediaName(att, attachmentIndex, sourcePath);
              const destPath = isInsideWorkspaceTemp(sourcePath) ? sourcePath : resolveUnder(workspaceTemp, safeName);

              if (sourcePath !== destPath) {
                await fs.copyFile(sourcePath, destPath);
              }
              mediaFiles.push({ id: String(att?.id || ''), path: destPath, mimeType, name: safeName });
            } else if (att.data || att.inlineData) {
              const b64 = att.data || (att.inlineData?.data) || att.inlineData;
              if (typeof b64 === 'string') {
                const safeName = getRunScopedMediaName(att, attachmentIndex);
                const destPath = resolveUnder(workspaceTemp, safeName);
                await fs.writeFile(destPath, Buffer.from(b64, 'base64'));
                mediaFiles.push({ id: String(att?.id || ''), path: destPath, mimeType, name: safeName });
              }
            } else if (att.fileUri) {
              const safeName = getRunScopedMediaName(att, attachmentIndex, att.path);
              const destPath = resolveUnder(workspaceTemp, safeName);
              if (att.path) {
                try { await fs.copyFile(att.path, destPath); } catch { }
              }
              const filePath = await fs.pathExists(destPath) ? destPath : (att.path || destPath);
              if (await fs.pathExists(filePath)) {
                mediaFiles.push({ id: String(att?.id || ''), path: filePath, mimeType, name: safeName });
              }
            }
          }
        }

        // Keep every attachment as the original file. Provider adapters below
        // decide how to upload it; nothing is downgraded to extracted text or
        // a path-only fallback here.
        const pastedReferences = mediaFiles.filter(isPastedText);
        // Large clipboard text is explicitly read on demand. Keep its bytes
        // out of every provider's native upload and initial prompt content.
        for (let index = mediaFiles.length - 1; index >= 0; index--) {
          if (isPastedText(mediaFiles[index])) mediaFiles.splice(index, 1);
        }
        const currentGeminiNativeFiles = [...mediaFiles];

        // The chat-media store resolves current and explicitly referenced prior
        // assets into this list. Keep the original files available to the
        // provider for the complete selected media context.
        const geminiNativeFiles = [...currentGeminiNativeFiles];
        if (currentGeminiNativeFiles.length > 0) {
          console.log(`[AgentRegistry] Media context: ${ currentGeminiNativeFiles.length } current attachment(s), 0 recalled`);
        }

        // ═══════════════════════════════════════════════════════════
        // Upload every file through the leased provider key. This keeps image
        // attachments and office documents on the provider's native Files API
        // path instead of converting them in the renderer or extracting text.
        // ═══════════════════════════════════════════════════════════
        const uploadedImageParts: { fileData: { fileUri: string, mimeType: string } }[] = [];
        if (!isExternalProvider) {
          const geminiAI = new (require('@google/genai').GoogleGenAI)({ apiKey: lease!.apiKey });
        for (const file of geminiNativeFiles) {
          try {
            if (!await fs.pathExists(file.path)) {
              throw new Error(`Attachment file not found: ${ file.path }`);
            }

            console.log(`[AgentRegistry] Preparing media via Files API: ${ file.name } (${ file.mimeType })`);
            const uploadResult = await geminiAI.files.upload({
              file: file.path,
              config: { mimeType: file.mimeType }
            });

            if (uploadResult && uploadResult.uri) {
              file.fileUri = uploadResult.uri; // Save URI back to the object
              uploadedImageParts.push({ fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType || file.mimeType } });
              console.log(`[AgentRegistry] ✅ Uploaded: ${ uploadResult.name } → ${ uploadResult.uri }`);
            } else {
              throw new Error(`Provider did not return a file URI for ${ file.name }`);
            }
          } catch (uploadErr: any) {
            const message = uploadErr?.message || String(uploadErr);
            console.error(`[AgentRegistry] Attachment upload failed for ${ file.name }: ${ message }`);
            throw new Error(`ATTACHMENT_PREPARATION_FAILED: ${ file.name } could not be uploaded through the selected provider.`);
          }
        }
        }

        // The vault persists original bytes, never provider file URIs. A fresh
        // provider URI is created above for each run's leased key.

        // Build enriched prompt with file context
        let enrichedPrompt = pastedTextManifest(pastedReferences);
        if (geminiNativeFiles.length > 0) {
          const fileList = geminiNativeFiles.map(f => `  • ${ f.name } (${ f.mimeType })${ f.fileUri ? ' [UPLOADED ✓]' : '' }`).join('\n');
          enrichedPrompt += `[USER ATTACHED FILES]\nThe following original files are attached through the selected provider's native file/media input:\n${ fileList }\n\nDo not replace these attachments with extracted text or a local-path fallback. Analyze the native file/media inputs when the user asks about them.\n\n`;
          enrichedPrompt += `[ATTACHMENT ORDER]\n${ geminiNativeFiles.map((file, index) => `Attachment ${ index + 1 }: ${ file.name }${ (file as any).id ? ` [${ (file as any).id }]` : '' }`).join('\n') }\nUse this order and stable ID when the user refers to a specific earlier asset.\n\n`;
        }
        // If images are present, add explicit analysis instruction
        const attachedImageCount = geminiNativeFiles.filter(f => String(f.mimeType || '').startsWith('image/')).length;
        if (!isExternalProvider && (uploadedImageParts.length > 0 || attachedImageCount > 0)) {
          const imageCount = attachedImageCount || uploadedImageParts.length;
          enrichedPrompt += `[MULTIMODAL CONTEXT] ${ imageCount } image(s) are attached to this message. You CAN see them. When the user asks about an image, analyze it thoroughly — describe content, colors, text, layout, objects, people, code, UI elements, or anything visible. Do NOT say you cannot see images. You are a multimodal model with full vision capability.\n\n`;
        }

        enrichedPrompt += `[USER REQUEST]\n${ prompt }`;

        // Create TaskStore entry
        if (!pinnedContext?.disableTaskStore) {
          await taskStore.createTask(chatId, prompt, execution.runId);
          taskStore.addTrace(chatId, { ...runUserEvent, _traceIdx: 0 }, execution.runId);
        }

        // Execute the pipeline with per-chat API key
        // Pass uploadedImageParts as the media payload (replaces old imageBackupParts)
        const projectId = pinnedContext?.telegram?.chatId
          ? `telegram-${ pinnedContext.telegram.chatId }`
          : chatId;
        execution.orchestratorProjectId = projectId;
        // Controls can change while Main is preparing its model and attachments.
        // Start the supervisor with the latest controls, not the admission snapshot.
        const latestProxyControl = readProxyControl(chatId);
        const proxyContext = {
          ...(pinnedContext || {}),
          autonomy: {
            ...(pinnedContext?.autonomy || {}),
            enabled: latestProxyControl.enabled,
            paused: latestProxyControl.paused,
            intervention: latestProxyControl.intervention,
            proxyModelSelection: latestProxyControl.modelSelection,
          },
        };
        const autonomyEnabled = latestProxyControl.enabled;
        const proxyLease = autonomyEnabled && !isExternalProvider
          ? apiKeyPool.leaseSubAgentKey(chatId, 'user_proxy')
          : null;
        const selectedProxyModel = latestProxyControl.modelSelection;
        const proxyModelEntry = typeof selectedProxyModel === 'string' && selectedProxyModel.includes(':')
          ? (() => {
            const [provider, ...modelParts] = selectedProxyModel.split(':');
            return isModelProvider(provider) && modelParts.join(':').trim()
              ? { provider, modelId: modelParts.join(':').trim() }
              : null;
          })()
          : null;
        const proxyRuntimeSettings: ScopedRuntimeSettings | null | undefined = proxyModelEntry && runtimeSettings
          ? { ...runtimeSettings, modelOverrides: { ...runtimeSettings.modelOverrides, [proxyModelEntry.provider]: proxyModelEntry.modelId } }
          : runtimeSettings;
        const proxyRuntimeMode = proxyModelEntry ? MODEL_PROVIDER_MODE[proxyModelEntry.provider] : mode;
        const selectedProxyApiKey = proxyModelEntry
          ? getScopedRuntimeApiKey(proxyRuntimeSettings || buildScopedRuntimeSettings(), proxyModelEntry.provider)
          : '';
        const userProxyRuntime = startUserProxyRuntime({
          context: {
            ...proxyContext,
            projectId,
            selectedModelMode: mode,
          } as any,
          objective: prompt,
          mode: proxyRuntimeMode,
          apiKey: proxyModelEntry ? selectedProxyApiKey : (isExternalProvider
            ? getScopedRuntimeApiKey(proxyRuntimeSettings || buildScopedRuntimeSettings(), modelConfig.provider)
            : proxyLease?.apiKey || lease?.apiKey || ''),
          runtimeSettings: proxyRuntimeSettings,
          history,
          attachments: mediaAttachments,
          onTrace: trace => onTrace(trace && typeof trace === 'object'
            ? { ...trace, auxiliaryRuntime: true, contextOwner: 'user_proxy' }
            : trace),
          steer: (message, metadata) => this.addSteeringMessage(chatId, message, undefined, metadata),
          stopMain: (reason, metadata) => this.stopAgent(chatId, reason, metadata),
          queueNext: (message, rationale) => this.queueProxyTask(chatId, message, rationale).accepted,
        });
        if (userProxyRuntime) {
          for (const dormant of claimDormantProxyDirectives(chatId)) {
            userProxyRuntime.receiveManagerDirective({
              message: dormant.message,
              target: dormant.target,
              timing: dormant.scope === 'next_task' ? 'now' : dormant.timing,
              intent: dormant.intent,
              rationale: dormant.rationale,
              requestedAction: dormant.requestedAction,
              urgency: dormant.urgency,
              expiresAt: dormant.expiresAt,
              activationCondition: dormant.activationCondition,
              scope: dormant.scope,
              supersedesDirectiveId: dormant.supersedesDirectiveId,
            });
          }
        }
        const providerMediaFiles = isExternalProvider ? mediaFiles : geminiNativeFiles;
        const response = await orchestrator.executePipeline(
          userId,
          projectId,
          enrichedPrompt,
          history,
          onTrace,
          mode,
          {
            ...(pinnedContext || {}),
            // Preserve the original user text separately from file/routing
            // envelopes. This is assigned here, not accepted from the client.
            visibleUserRequest: prompt,
            ownerChatId: chatId,
            runId: execution.runId,
            turnId: execution.activeTurnId || execution.runId,
            // Long-lived workers can outlast a steering boundary. Resolve the
            // owner when an event is produced instead of freezing the first
            // turn in the pipeline context.
            getActiveTurnId: () => execution.activeTurnId || execution.runId,
            getActiveAuxiliaryTurnId: (identity: string) => {
              const normalizedIdentity = String(identity || '').trim();
              if (!normalizedIdentity) return '';
              const direct = execution.activeAuxiliaryTurnIds.get(normalizedIdentity);
              if (direct) return direct;
              for (const [knownIdentity, activeTurnId] of execution.activeAuxiliaryTurnIds.entries()) {
                if (
                  knownIdentity === normalizedIdentity ||
                  knownIdentity.endsWith(`::${ normalizedIdentity }`) ||
                  normalizedIdentity.endsWith(`::${ knownIdentity }`)
                ) return activeTurnId;
              }
              return '';
            },
            abortSignal: execution.abortController.signal,
          },
          providerMediaFiles,
          uploadedImageParts, // Files API parts instead of base64
          userName,
          isExternalProvider ? undefined : lease!.apiKey,
          runtimeSettings
        );

        const responseText = response.finalAnswer || '';
        const wasCancelledByResponse = execution.cancelled || responseText === 'Stopped by user.';
        const responseFailed = response.success === false || /^Agent (Execution Failed|Error):/i.test(responseText);

        terminalStatus = wasCancelledByResponse ? 'stopped' : responseFailed ? 'failed' : 'completed';
        execution.finalAnswer = responseText;
        if (responseFailed) execution.error = responseText;
        preserveUndrainedHumanSteering();
        // Publish the terminal state before task/key/sub-agent cleanup. A new
        // user follow-up must never be steered into a run that has already
        // produced its final response and is only unwinding resources.
        execution.status = terminalStatus;
        execution.completedAt = execution.completedAt || Date.now();
        this.notifyTraceWaiters(chatId);
        const completedProxyTaskId = execution.launchSpec.pinnedContext?.autonomy?.proxyTaskId;
        if (completedProxyTaskId) {
          try { completeProxyTask(chatId, completedProxyTaskId, execution.runId, execution.status === 'completed' ? 'completed' : execution.status === 'stopped' ? 'stopped' : 'failed', execution.finalAnswer); }
          catch (error) { console.warn('[AgentRegistry] Could not save the delegated task result.', error); }
        }

        // Update effective model with the model mode resolved by the orchestrator!
        const actualModelConfig = getMainAgentModelConfig(response.modelMode, runtimeSettings);
        execution.effectiveModel = typeof pinnedContext?.selectedModelName === 'string'
          && pinnedContext.selectedModelName.trim().length > 0
          && isModelProvider(pinnedContext?.selectedModelProvider)
          ? pinnedContext.selectedModelName.trim()
          : actualModelConfig.modelName;

        // Emit one canonical terminal lifecycle. A failed custom/builder
        // runtime can report its provider error before the orchestrator
        // returns; publishing a second `done(status=failed)` produced two
        // failure notices for one query. Failed completion enriches the same
        // stable error row, while successful/stopped completion remains done.
        if (!execution.cancelled) {
          const terminalTraceType = terminalStatus === 'failed' ? 'error' : 'done';
          const terminalDetail = terminalStatus === 'failed'
            ? responseText.replace(/^Agent (?:Execution Failed|Builder failed)\s*:\s*/i, '').trim()
            : '';
          onTrace({
            id: `run-terminal:${ execution.runId }:${ execution.activeTurnId || execution.runId }:${ terminalTraceType }`,
            type: terminalTraceType,
            ...(terminalDetail ? { text: terminalDetail, detail: terminalDetail } : {}),
            data: response,
            status: terminalStatus,
            mainTurnTerminal: true,
            timestamp: execution.completedAt,
            endTime: execution.completedAt,
          });
        }

        // Store the exact terminal assistant page before any task-local state
        // is cleaned up. Agent paths that already recorded it are idempotent by
        // run ID; early-return and custom-agent paths are covered here.
        await persistTerminalContext();

        // Persist to TaskStore
        if (!pinnedContext?.disableTaskStore) {
          await taskStore.completeTask(chatId, execution.finalAnswer, terminalStatus === 'completed', terminalStatus, execution.runId);
        }

        // Report success to key pool
        if (!isExternalProvider && terminalStatus === 'completed') {
          apiKeyPool.reportSuccess(chatId, (response as any).effectiveApiKey);
        }

        console.log(`[AgentRegistry] ${ terminalStatus === 'completed' ? '✅ Agent completed' : terminalStatus === 'stopped' ? '🛑 Agent stopped' : '❌ Agent failed' } for chat ${ chatId.substring(0, 8) }... in ${ ((Date.now() - execution.startedAt) / 1000).toFixed(1) }s`);

      } catch (error: any) {
        const errorMessage = formatUnknownError(error, 'Unknown agent error');
        const wasCancelled = errorMessage === 'CANCELLED_BY_USER' || execution.cancelled;

        terminalStatus = wasCancelled ? 'stopped' : 'failed';
        execution.error = errorMessage;
        execution.finalAnswer = wasCancelled ? 'Stopped by user.' : `Agent Error: ${ errorMessage }`;
        if (wasCancelled) execution.steeringQueue = [];
        else preserveUndrainedHumanSteering();
        // API failures (including exhausted/rate-limited keys) are terminal
        // immediately. Cleanup still runs below, but the registry must stop
        // advertising this execution as steerable while it is unwinding.
        execution.status = terminalStatus;
        execution.completedAt = execution.completedAt || Date.now();
        this.notifyTraceWaiters(chatId);

        if (!wasCancelled) {
          // Check if it's an API key error — auto-failover
          const errorType = isExternalProvider ? 'unknown' : apiKeyPool.classifyError(errorMessage);
          if (errorType !== 'unknown') {
            console.warn(`[AgentRegistry] 🔄 API key failure (${ errorType }) for chat ${ chatId.substring(0, 8) }...`);
            apiKeyPool.reportFailure(chatId, errorType, errorMessage);
          }

          // Emit error to trace buffer.
          try {
            this.appendTrace(execution, {
              id: `run-terminal:${ execution.runId }:${ execution.activeTurnId || execution.runId }:error`,
              type: 'error',
              text: errorMessage,
              detail: errorMessage,
              data: errorMessage,
              ownerChatId: chatId,
              runId: execution.runId,
              turnId: execution.activeTurnId || execution.runId,
              status: 'failed',
              mainTurnTerminal: true,
              timestamp: execution.completedAt,
              endTime: execution.completedAt,
            }, !pinnedContext?.disableTaskStore);
          } catch { /* buffer push failed, ignore */ }

          console.error(`[AgentRegistry] ❌ Agent failed for chat ${ chatId.substring(0, 8) }...: ${ errorMessage.substring(0, 100) }`);
        } else {
          console.log(`[AgentRegistry] 🛑 Agent stopped for chat ${ chatId.substring(0, 8) }...`);
        }

        if (!pinnedContext?.disableTaskStore) {
          if (terminalStatus === 'stopped') {
            await taskStore.stopTask(chatId, execution.finalAnswer, execution.runId).catch(() => { });
          } else {
            await taskStore.completeTask(chatId, execution.finalAnswer, false, terminalStatus, execution.runId).catch(() => { });
          }
        }

        await persistTerminalContext();

      } finally {
        if (execution.orchestratorProjectId) {
          try { stopUserProxyRuntime(execution.orchestratorProjectId); } catch { }
        }
        // No background worker may outlive its owning main run. Cancel first and
        // give workers a bounded window to observe the signal before releasing
        // their leases; otherwise a successor can reuse a key still in flight.
        const subAgentProjectId = execution.orchestratorProjectId || chatId;
        if (!execution.abortController.signal.aborted) {
          execution.abortController.abort(new Error('MAIN_RUN_SETTLED'));
        }
        try { cancelAgent(subAgentProjectId); } catch { }
        try {
          await Promise.race([
            globalSubAgentSpawner.waitForAll(subAgentProjectId),
            new Promise<void>(resolve => setTimeout(resolve, 3000)),
          ]);
        } catch { }
        if (globalSubAgentSpawner.getBackgroundCount(subAgentProjectId) === 0) {
          clearCancelState(subAgentProjectId);
        }

        // ALWAYS release ALL keys associated with this chat after bounded drain.
        if (!isExternalProvider) {
          try { apiKeyPool.releaseKey(chatId); } catch { }
        }
        // Never make an in-flight key available to a successor. Responsive
        // workers release their own lease in spawnAgent.finally; this sweep is
        // only safe once the background registry confirms the run is drained.
        if (globalSubAgentSpawner.getBackgroundCount(subAgentProjectId) === 0) {
          try { apiKeyPool.releaseLeasesWithPrefix(`${ chatId }_sub_`); } catch { }
        } else {
          console.warn(`[AgentRegistry] Sub-agent drain timed out for ${chatId.substring(0, 8)}...; retaining worker leases until their owners exit.`);
        }

        // Flush ledger so no pending writes are lost when the agent finishes,
        // crashes, or is stopped. Non-blocking — errors are swallowed.
        await flushLedgerForChat(chatId).catch(() => {});
        execution.settled = true;
        if (execution.status === 'running') execution.status = terminalStatus;
        execution.completedAt = execution.completedAt || Date.now();
        this.notifyTraceWaiters(chatId);
        // Stop clears everything that was queued before cancellation. A fresh
        // message accepted while the stopped run is still unwinding is a real
        // successor and must start as soon as cleanup releases this execution.
        queueMicrotask(() => void this.startNextQueuedWork(chatId));
      }
    })();

    const poolStatus = isExternalProvider ? null : apiKeyPool.getPoolStatus();
    console.log(`[AgentRegistry] Agent started for chat ${ chatId.substring(0, 8) }... | Model: ${ modelConfig.modelName }${ lease ? ` | Key: #${ lease.keyIndex } | Pool: ${ poolStatus?.healthySummary }` : '' }`);

    return { status: 'started', chatId, runId: execution.runId, message: lease ? `Agent started with key #${ lease.keyIndex }` : `Agent started with ${ modelConfig.label }` };
  }

  /**
   * Get traces for a chat, optionally after a specific index (incremental polling).
   */
  public getTraces(chatId: string, afterIndex: number = -1, requestedRunId?: string): {
    status: 'running' | 'completed' | 'failed' | 'stopped' | 'idle';
    traces: any[];
    totalTraces: number;
    maxIndex: number;
    finalAnswer: string;
    runId?: string;
    startedAt?: number;
    completedAt?: number;
    error?: string;
    successorRunId?: string;
    successorStartedAt?: number;
    terminalTurnId?: string;
    pendingProxyTaskCount: number;
    pendingFollowUpCount: number;
    queuedFollowUps: QueuedUserFollowUpSummary[];
  } {
    const currentExecution = this.executions.get(chatId);
    const requestedOwner = String(requestedRunId || '').trim();
    const currentMatchesRequest = Boolean(
      requestedOwner
      && currentExecution?.runId === requestedOwner,
    );
    const archivedExecution = requestedOwner && !currentMatchesRequest
      ? this.getArchivedExecution(chatId, requestedOwner)
      : undefined;
    // Once the renderer owns a run ID, polling is exact. Never fall through to
    // a newer current execution when the requested predecessor is unavailable;
    // trace indices restart per run and that fallback corrupts both ordering
    // and ownership in the visible feed.
    const execution = requestedOwner
      ? (currentMatchesRequest ? currentExecution : archivedExecution)
      : currentExecution;

    if (!execution) {
      return {
        status: 'idle',
        traces: [],
        totalTraces: 0,
        maxIndex: -1,
        finalAnswer: '',
        // The predecessor may exist only on disk after retention/restart.
        // Preserve its successor pointer so poll recovery can settle the old
        // transcript and promptly attach to the current run.
        ...(requestedOwner && currentExecution && currentExecution.runId !== requestedOwner
          ? { successorRunId: currentExecution.runId, successorStartedAt: currentExecution.startedAt }
          : {}),
        pendingProxyTaskCount: getPendingProxyTaskCount(chatId),
        pendingFollowUpCount: this.getQueuedFollowUps(chatId).length,
        queuedFollowUps: this.getQueuedFollowUps(chatId),
      };
    }
    this.compactExecutionForRetention(execution);

    // Get traces after the given index — indices are monotonic, never re-indexed
    // The buffer is index-ordered even after old entries are compacted. Binary
    // search avoids rescanning up to 2,000 entries on every high-frequency poll
    // for every running chat.
    let start = 0;
    if (afterIndex >= 0) {
      let low = 0;
      let high = execution.traceBuffer.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (execution.traceBuffer[middle].index <= afterIndex) low = middle + 1;
        else high = middle;
      }
      start = low;
    }
    const bufferedTraces = filterLiveUserVisibleTraces(execution.traceBuffer.slice(start).map(trace => ({
      ...trace.data,
      timestamp: normalizeStreamTimestamp(trace.data?.timestamp, trace.timestamp),
      _traceIdx: trace.index,
    })));
    const proxyRecovery = execution.launchSpec.pinnedContext?.autonomy?.origin === 'proxy_manager';
    const recoveredPrompt = getVisibleRunPrompt(
      proxyRecovery
        ? String(execution.launchSpec.pinnedContext?.autonomy?.proxyTaskPrompt || execution.prompt)
        : execution.prompt,
    ).trim();
    const queryWasCompacted = afterIndex < 0 &&
      recoveredPrompt.length > 0 &&
      !execution.traceBuffer.some(entry => entry?.data?.type === 'user_action');
    // This reconstructs the opening request, not the newest visible phase.
    // After compaction the first retained event may belong to steering; using
    // that event's turn ID cloned the original prompt into every later phase.
    const recoveredTurnId = String(
      execution.runId ||
      execution.traceBuffer.find(entry => String(entry?.data?.turnId || '').trim())?.data?.turnId ||
      execution.activeTurnId,
    ).trim();
    const newTraces = queryWasCompacted
      ? [
        {
          id: proxyRecovery
            ? `proxy-task-${ execution.launchSpec.pinnedContext?.autonomy?.proxyTaskId || execution.runId }`
            : `user-turn-${ execution.runId }`,
          type: 'user_action',
          admissionId: execution.runId,
          _queuedFollowUp: false,
          text: recoveredPrompt,
          source: proxyRecovery ? 'proxy_manager' : 'human',
          ...(proxyRecovery ? { delegatedBy: 'Side Proxy-Agent' } : {}),
          ownerChatId: execution.chatId,
          runId: execution.runId,
          turnId: recoveredTurnId,
          timestamp: execution.startedAt,
          startTime: execution.startedAt,
          endTime: execution.startedAt,
          modelSelection: execution.launchSpec.pinnedContext?.selectedModelProvider && execution.launchSpec.pinnedContext?.selectedModelName
            ? `${ String(execution.launchSpec.pinnedContext.selectedModelProvider) }:${ String(execution.launchSpec.pinnedContext.selectedModelName) }`
            : undefined,
          selectedModelProvider: execution.launchSpec.pinnedContext?.selectedModelProvider || undefined,
          selectedModelName: execution.launchSpec.pinnedContext?.selectedModelName || undefined,
          thinkingLevel: execution.launchSpec.pinnedContext?.thinkingLevel || undefined,
          _traceIdx: -1,
          _recoveredExactText: true,
        },
        ...bufferedTraces,
      ]
      : bufferedTraces;

    // maxIndex = the highest monotonic index we've ever issued for this chat
    const maxIndex = execution.traceBuffer.length > 0
      ? execution.traceBuffer[execution.traceBuffer.length - 1].index
      : -1;

    return {
      status: execution.status,
      traces: newTraces,
      totalTraces: execution.traceBuffer.length,
      maxIndex,
      finalAnswer: execution.finalAnswer,
      runId: execution.runId,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      error: execution.error,
      ...(execution.status !== 'running' && execution.activeTurnId
        ? { terminalTurnId: execution.activeTurnId }
        : {}),
      ...(archivedExecution && currentExecution && currentExecution.runId !== archivedExecution.runId
        ? {
          successorRunId: currentExecution.runId,
          successorStartedAt: currentExecution.startedAt,
        }
        : {}),
      pendingProxyTaskCount: getPendingProxyTaskCount(chatId),
      pendingFollowUpCount: this.getQueuedFollowUps(chatId).length,
      queuedFollowUps: this.getQueuedFollowUps(chatId),
    };
  }

  /**
   * Stop a specific chat's agent. Per-chat — doesn't affect other chats.
   * IDEMPOTENT: Calling this multiple times for the same chat is safe.
   */
  public stopAgent(
    chatId: string,
    reason = 'Stopped by user.',
    metadata?: Record<string, any>,
    expectedRunId?: string,
    queuedAdmissionCutoff = Number.POSITIVE_INFINITY,
  ): boolean {
    const execution = this.executions.get(chatId);
    if (expectedRunId && !execution) {
      // Stop can beat a slow start request to the registry. Keep a short-lived
      // run-scoped tombstone so that delayed request cannot create a zombie run
      // after the UI has already confirmed cancellation.
      this.pendingRunCancellations.set(chatId, {
        runId: expectedRunId,
        expiresAt: Date.now() + 15 * 60 * 1000,
      });
    } else if (expectedRunId && execution && execution.runId !== expectedRunId) {
      return false;
    }
    const cancelledQueuedFollowUps = !metadata?._autonomyProxy
      ? this.clearQueuedFollowUps(chatId, queuedAdmissionCutoff)
      : 0;
    const cancelledQueuedTasks = !metadata?._autonomyProxy
      ? cancelPendingProxyTasks(chatId, 'Cancelled after Main was stopped by the user.', queuedAdmissionCutoff)
      : 0;
    if (!execution) return Boolean(expectedRunId) || cancelledQueuedTasks > 0 || cancelledQueuedFollowUps > 0;

    // Registry owns the whole run lifecycle. This must happen here (rather than
    // only in an HTTP route) so Proxy, Telegram, shutdown, and tests all stop the
    // same sub-agent tree.
    cancelAgent(execution.orchestratorProjectId || chatId);

    const cancelledSteering = execution.steeringQueue.splice(0);
    if (cancelledSteering.length > 0) {
      this.appendTrace(execution, {
        type: 'steering_cancelled',
        steeringIds: cancelledSteering.map(item => item.id),
        runId: execution.runId,
        turnId: execution.activeTurnId || execution.runId,
        timestamp: Date.now(),
      });
    }

    // Already stopped/completed/failed — idempotent, don't re-process
    if (execution.status !== 'running') {
      // Still set cancel flag in case sub-agents are lingering
      execution.cancelled = true;
      execution.steeringQueue = [];
      return true;
    }

    execution.cancelled = true;
    execution.steeringQueue = [];
    execution.abortController.abort(new Error('CANCELLED_BY_USER'));
    execution.status = 'stopped';
    execution.completedAt = Date.now();

    this.appendTrace(execution, {
      ...createStoppedRunTrace({
        ownerChatId: chatId,
        runId: execution.runId,
        turnId: execution.activeTurnId || execution.runId,
      }, execution.completedAt),
      ...(metadata?._autonomyProxy ? {
        type: 'autonomy_proxy_status',
        phase: 'main_stopped',
        text: `Proxy-Agent stopped Main: ${reason}`,
        detail: `Proxy-Agent stopped Main: ${reason}`,
      } : {}),
      ...(metadata || {}),
    });

    taskStore.stopTask(chatId, reason, execution.runId).catch(() => { });

    // Flush the ledger so the last tool calls are not lost on stop.
    flushLedgerForChat(chatId).catch(() => {});

    console.log(`[AgentRegistry] 🛑 Stopped agent for chat ${ chatId.substring(0, 8) }...`);
    return true;
  }

  /**
   * Enqueue a live steering message for a running agent.
   * Returns true if the agent is running and the message was queued.
   * Admission is not delivery: queued messages float outside the active turn
   * until Main inserts their complete batch into its model context.
   */
  public addSteeringMessage(
    chatId: string,
    message: string,
    steeringId?: string,
    metadata?: Record<string, any>,
    expectedRunId?: string,
  ): boolean {
    // API callers address the registry by the authoritative chat key. Do not
    // resolve the orchestrator's runtime alias here: Telegram and other
    // runtimes may use a different project ID, and alias lookup could steer a
    // different chat when IDs happen to overlap. Runtime aliases are resolved
    // only by the execution loop when it drains its own queue.
    const execution = this.executions.get(chatId);
    if (
      !execution ||
      execution.status !== 'running' ||
      execution.settled ||
      Boolean(execution.completedAt) ||
      execution.abortController.signal.aborted
    ) return false;
    if (expectedRunId && execution.runId !== expectedRunId) return false;

    const trimmedMessage = String(message || '').replace(/\u0000/g, '').trim();
    if (!trimmedMessage) return false;
    const resolvedId = steeringId || `steer_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`;
    if (this.hasCancelledFollowUp(chatId, resolvedId)) return false;
    // Treat retries with the same client ID as idempotent. In particular, do
    // not rewrite a queued message after it has already been acknowledged and
    // do not emit a second received event after the original was applied.
    if (execution.acceptedSteeringIds.has(resolvedId)) return true;
    // Provenance is derived from the trusted proxy flags, never from a
    // caller-provided display source. Normal typing-bar guidance therefore
    // cannot accidentally inherit a Proxy-Agent label.
    const isAutonomyProxy = metadata?._autonomyProxy === true;
    const steeringSource = isAutonomyProxy
      ? (metadata?._proxyManager === true ? 'proxy_manager' : 'user_proxy')
      : 'human';
    const normalizedMetadata: Record<string, any> = {
      ...(metadata || {}),
      ...(Array.isArray(metadata?.attachments) ? {
        attachments: metadata.attachments.map((attachment: any) => ({
          ...attachment,
          localPath: attachment.localPath || attachment.path,
        })),
      } : {}),
      _autonomyProxy: isAutonomyProxy,
      source: steeringSource,
      steeringSource,
      ownerChatId: execution.chatId,
      runId: execution.runId,
      turnId: `steering-turn-${ resolvedId }`,
    };
    if (execution.steeringQueue.length >= MAX_STEERING_QUEUE) {
      console.warn(`[AgentRegistry] Steering queue full for chat ${ chatId.substring(0, 8) }...; rejecting new guidance so the client can retain it.`);
      return false;
    }
    const requestedCreatedAt = Number(metadata?.createdAt);
    const steeringCreatedAt = Number.isFinite(requestedCreatedAt) && requestedCreatedAt > 0
      ? requestedCreatedAt
      : Date.now();
    const queuedMessage: SteeringMessage = {
      id: resolvedId,
      text: trimmedMessage,
      createdAt: steeringCreatedAt,
      metadata: normalizedMetadata,
    };
    execution.acceptedSteeringIds.add(resolvedId);
    execution.steeringQueue.push(queuedMessage);
    // Stable sort preserves admission order for equal timestamps. Random IDs
    // must never reverse a correction and the message it corrects.
    execution.steeringQueue.sort((left, right) => left.createdAt - right.createdAt);
    // Completion-boundary Proxy guidance is revealed when it is applied on
    // the next loop boundary. Emitting it here would place the Proxy message
    // before the fully generated answer checkpoint and make that answer appear
    // to vanish. Human guidance is acknowledged here; Proxy guidance becomes
    // a real user turn only when it is actually injected into Main.
    if (normalizedMetadata.completionReview !== true && !isAutonomyProxy) {
      this.appendTrace(execution, {
        type: 'steering_queued',
        deliveryState: 'queued',
        text: trimmedMessage,
        steeringId: queuedMessage.id,
        steeringIds: [queuedMessage.id],
        timestamp: steeringCreatedAt,
        ...normalizedMetadata,
        turnId: execution.activeTurnId || execution.runId,
      });
    }

    console.log(`[AgentRegistry] 🧭 Steering message queued for chat ${ chatId.substring(0, 8) }...: "${ trimmedMessage.substring(0, 60) }"`);
    return true;
  }

  /**
   * Dequeue all pending steering messages for a chat (clears the queue).
   * Called by the ReAct loop at the start of each iteration.
   */
  public getAndClearSteeringQueue(chatId: string): SteeringMessage[] {
    const execution = this.findExecution(chatId);
    // A stop/finish can race with the next model-boundary callback. Never
    // release guidance from a run that is no longer eligible to execute it.
    if (
      !execution ||
      execution.status !== 'running' ||
      execution.settled ||
      Boolean(execution.completedAt) ||
      execution.abortController.signal.aborted ||
      execution.steeringQueue.length === 0
    ) return [];
    const control = readProxyControl(chatId);
    if (!control.enabled || control.paused) {
      const human = execution.steeringQueue.filter(item => !item.metadata?._autonomyProxy);
      execution.steeringQueue = execution.steeringQueue.filter(item => item.metadata?._autonomyProxy);
      return human;
    }
    return execution.steeringQueue.splice(0);
  }

  /** Atomically drains all pending guidance at a safe model boundary. */
  public drainSteeringQueue(chatId: string): SteeringMessage[] {
    return this.getAndClearSteeringQueue(chatId);
  }

  /** Snapshot a boundary without losing messages if context insertion fails. */
  public readSteeringBatch(chatId: string): SteeringMessage[] {
    const execution = this.findExecution(chatId);
    if (!execution || execution.status !== 'running' || execution.settled ||
      execution.completedAt || execution.abortController.signal.aborted) return [];
    const control = readProxyControl(chatId);
    return execution.steeringQueue.filter(item => !item.metadata?._autonomyProxy || (control.enabled && !control.paused));
  }

  /** Acknowledge only the snapshot actually inserted, never later arrivals. */
  public acknowledgeSteeringBatch(chatId: string, ids: string[]): void {
    const execution = this.findExecution(chatId);
    if (!execution) return;
    const delivered = new Set(ids);
    execution.steeringQueue = execution.steeringQueue.filter(item => !delivered.has(item.id));
  }

  /** Retry receipts survive completion and a successor taking over this chat. */
  public hasAcceptedSteering(chatId: string, id: string, runId?: string): boolean {
    if ((this.userFollowUpQueues.get(chatId) || []).some(item =>
      item.steeringMessages?.some(message => message.id === id))) return true;
    const executions = [this.executions.get(chatId), ...(this.archivedExecutions.get(chatId) || [])];
    return executions.some(execution => execution && (!runId || execution.runId === runId) &&
      execution.acceptedSteeringIds.has(id));
  }

  /**
   * Peek at the pending steering messages without dequeuing them.
   */
  public peekSteeringQueue(chatId: string): SteeringMessage[] {
    const execution = this.findExecution(chatId);
    if (!execution) return [];
    return [...execution.steeringQueue];
  }

  /**
   * Remove the first N messages from the steering queue.
   */
  public consumeSteeringQueue(chatId: string, count: number): void {
    const execution = this.findExecution(chatId);
    if (
      !execution ||
      execution.status !== 'running' ||
      execution.settled ||
      Boolean(execution.completedAt) ||
      execution.abortController.signal.aborted ||
      count <= 0
    ) return;
    execution.steeringQueue.splice(0, count);
  }

  /**
   * Check if a specific chat has a running agent.
   */
  public compactChat(chatId: string, rawSettings?: unknown): Promise<void> {
    return requestManualCompaction(chatId, () => this.isRunning(chatId), async () => {
      const execution = this.executions.get(chatId);
      // A stopped worker may still be committing its last checkpoint.
      if (execution && !execution.settled) await execution.promise.catch(() => undefined);
      await compactSavedWorkingContext(chatId, async checkpoint => {
        const fabric = await getContextFabricForChat(chatId);
        const result = await compactContextAtBoundary({
          chatId, kind: checkpoint.kind === 'gemini' ? 'gemini' : 'provider',
          contents: checkpoint.contents,
          activeModel: { provider: checkpoint.provider as any, modelId: checkpoint.model },
          rawSettings: rawSettings || execution?.launchSpec.pinnedContext?.contextCompaction,
          runtimeSettings: execution?.launchSpec.runtimeSettings || buildScopedRuntimeSettings(),
          forceCompaction: true, semanticBoundary: 'safe',
          continuityManifestFactory: () => fabric.buildContinuityManifest(),
          onEvent: event => {
            if (execution) this.appendTrace(execution, event);
            else taskStore.addTrace(chatId, event);
          },
        });
        if (result.failed) throw new Error('Context compaction failed. The original context was preserved.');
        return result.contents;
      });
    });
  }

  public isRunning(chatId: string): boolean {
    const execution = this.executions.get(chatId);
    return execution?.status === 'running';
  }

  /** Wait briefly for a stopped run's cleanup before admitting its successor. */
  public async waitForStoppedRunToSettle(chatId: string, timeoutMs = 5000): Promise<boolean> {
    const execution = this.executions.get(chatId);
    if (!execution || execution.settled) return true;
    if (execution.status === 'running') return false;
    await Promise.race([
      execution.promise.catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, Math.max(1, timeoutMs))),
    ]);
    return execution.settled;
  }

  public controlUserProxy(
    chatId: string,
    action: 'enable' | 'disable' | 'pause' | 'resume' | 'intervention' | 'model',
    value?: ProxyInterventionLevel | string,
  ): boolean {
    const execution = this.findExecution(chatId);
    const projectId = execution?.orchestratorProjectId || chatId;
    if (action === 'pause' || action === 'disable') {
      const control = updateProxyControl(chatId, action === 'disable' ? { enabled: false, paused: false } : { paused: true });
      if (execution) {
        const pinned = execution.launchSpec.pinnedContext || {};
        execution.launchSpec.pinnedContext = { ...pinned, autonomy: { ...pinned.autonomy, enabled: control.enabled, paused: control.paused } };
      }
      pauseUserProxyRuntime(projectId);
      return true;
    }
    if (action === 'resume' || action === 'enable') {
      if (action === 'resume' && !readProxyControl(chatId).enabled) return false;
      const control = updateProxyControl(chatId, { enabled: true, paused: false });
      if (execution?.status === 'running' && !execution.settled) {
        const pinned = execution.launchSpec.pinnedContext || {};
        pinned.autonomy = { ...pinned.autonomy, enabled: true, paused: false, intervention: control.intervention, proxyModelSelection: control.modelSelection };
        execution.launchSpec.pinnedContext = pinned;
        if (!resumeUserProxyRuntime(projectId)) {
          const runtimeSettings = execution.launchSpec.runtimeSettings || buildScopedRuntimeSettings();
          const configured = getMainAgentModelConfig(execution.mode, runtimeSettings);
          const [selectedProvider, ...selectedModel] = control.modelSelection.split(':');
          const provider: MainAgentProvider = isModelProvider(selectedProvider) ? selectedProvider
            : isModelProvider(pinned.selectedModelProvider) ? pinned.selectedModelProvider : configured.provider;
          const modelId = isModelProvider(selectedProvider) ? selectedModel.join(':') : pinned.selectedModelName || configured.modelName;
          const settings = { ...runtimeSettings, modelOverrides: { ...runtimeSettings.modelOverrides, [provider]: modelId } };
          const runtime = startUserProxyRuntime({
            context: { ...pinned, projectId, selectedModelProvider: pinned.selectedModelProvider || configured.provider, selectedModelName: pinned.selectedModelName || configured.modelName, strictModelSelection: true } as any,
            objective: execution.prompt,
            mode: MODEL_PROVIDER_MODE[provider],
            apiKey: getScopedRuntimeApiKey(settings, provider),
            runtimeSettings: settings,
            history: execution.launchSpec.history,
            attachments: execution.launchSpec.mediaAttachments,
            onTrace: trace => this.appendTrace(execution, { ...trace, auxiliaryRuntime: true, contextOwner: 'user_proxy' }, !pinned.disableTaskStore),
            steer: (message, metadata) => this.addSteeringMessage(chatId, message, undefined, metadata),
            stopMain: (reason, metadata) => this.stopAgent(chatId, reason, metadata),
            queueNext: (message, rationale) => this.queueProxyTask(chatId, message, rationale).accepted,
          });
          if (runtime) {
            for (const directive of claimDormantProxyDirectives(chatId)) runtime.receiveManagerDirective(directive);
            for (const entry of execution.traceBuffer.slice(-36)) runtime.observe(entry.data);
          }
        }
      }
      if (!execution || execution.settled) void this.startNextQueuedWork(chatId);
      return true;
    }
    if (action === 'intervention') {
      const level = value as ProxyInterventionLevel;
      updateProxyControl(chatId, { intervention: level });
      const appliedToLiveRuntime = setUserProxyIntervention(projectId, level);
      return appliedToLiveRuntime || readProxyControl(chatId).intervention === level;
    }

    const selection = String(value || 'auto').trim();
    const requestedParts = selection.split(':');
    if (selection !== 'auto' && (!isModelProvider(requestedParts[0]) || !requestedParts.slice(1).join(':').trim())) return false;
    updateProxyControl(chatId, { modelSelection: selection });
    if (!execution) return true;
    const runtimeSettings = execution.launchSpec.runtimeSettings || buildScopedRuntimeSettings();
    const parts = selection.includes(':') ? selection.split(':') : [];
    const activeProvider = execution.launchSpec.pinnedContext?.selectedModelProvider;
    const provider = isModelProvider(parts[0]) ? parts[0] : isModelProvider(activeProvider)
      ? activeProvider : getMainAgentModelConfig(execution.mode, runtimeSettings).provider;
    const modelId = selection === 'auto'
      ? String(execution.launchSpec.pinnedContext?.selectedModelName || '').trim()
      : parts.slice(1).join(':').trim();
    const settings = modelId
      ? { ...runtimeSettings, modelOverrides: { ...runtimeSettings.modelOverrides, [provider]: modelId } }
      : runtimeSettings;
    setUserProxyModel(projectId, {
      mode: MODEL_PROVIDER_MODE[provider],
      apiKey: getScopedRuntimeApiKey(settings, provider),
      runtimeSettings: settings,
      modelSelection: selection === 'auto' ? 'auto' : `${provider}:${modelId}`,
    });
    return true;
  }

  private queueSnapshotClock = 0;

  public getQueuedFollowUpSnapshot(chatId: string) {
    const items = this.getQueuedFollowUps(chatId);
    this.queueSnapshotClock = Math.max(Date.now() * 1000, (this.queueSnapshotClock || 0) + 1);
    return { items, queueRevision: this.queueSnapshotClock };
  }

  public getQueuedFollowUps(chatId: string): QueuedUserFollowUpSummary[] {
    return (this.userFollowUpQueues.get(chatId) || []).map(item => ({
      id: item.id,
      runId: item.runId,
      chatId: item.chatId,
      text: item.prompt,
      createdAt: item.createdAt,
      attachmentCount: item.mediaAttachments.length,
      attachments: item.mediaAttachments.map(attachment => ({
        id: attachment.id, name: attachment.name, path: attachment.path || attachment.localPath,
        localPath: attachment.path || attachment.localPath, mimeType: attachment.mimeType,
        originalPath: attachment.originalPath,
        previewUrl: attachment.id
          ? `/api/chat/media?chatId=${encodeURIComponent(chatId)}&id=${encodeURIComponent(attachment.id)}`
          : undefined,
        size: attachment.size,
      })),
      ...(item.steeringMessages?.length ? { steeringIds: item.steeringMessages.map(message => message.id) } : {}),
      ...(item.runtimeOverride ? {
        modelSelection: `${ item.runtimeOverride.selectedModelProvider }:${ item.runtimeOverride.selectedModelName }`,
        thinkingLevel: item.runtimeOverride.thinkingLevel,
      } : {}),
    }));
  }

  public queueUserFollowUp(
    chatId: string,
    prompt: string,
    mediaAttachments: any[] = [],
    requestedId?: string,
    requestedCreatedAt?: number,
    runtimeOverride?: QueuedUserFollowUp['runtimeOverride'],
    steeringMessages?: QueuedUserFollowUp['steeringMessages'],
    desktopAdmissionEpoch?: number,
  ): {
    accepted: boolean;
    status: 'queued' | 'starting' | 'not_found' | 'queue_full' | 'cancelled';
    item?: QueuedUserFollowUpSummary;
    handoffPending?: boolean;
    message: string;
  } {
    this.cancelledFollowUpAdmissions ??= new Map();
    if (requestedId && this.hasCancelledFollowUp(chatId, requestedId)) {
      return { accepted: false, status: 'cancelled', message: 'This queued admission was cancelled.' };
    }
    const priorReceipt = this.userFollowUpReceipts.get(chatId)?.get(requestedId || '');
    if (priorReceipt) {
      const currentExecution = this.executions.get(chatId);
      const receiptStillQueued = Boolean(
        this.userFollowUpQueues.get(chatId)?.some(item => item.id === priorReceipt.id)
      );
      const receiptRunIsCurrent = Boolean(
        currentExecution &&
        currentExecution.runId === priorReceipt.runId
      );
      return {
        accepted: true,
        status: receiptStillQueued ? 'queued' : 'starting',
        item: priorReceipt,
        // An idempotent retry can arrive after the original queue response was
        // lost and after the item was promoted out of the visible queue. Tell
        // the renderer to attach even when that run has already completed; a
        // cursor -1 poll then recovers its full durable transcript.
        handoffPending: (!receiptStillQueued && receiptRunIsCurrent) || Boolean(
          currentExecution &&
          (currentExecution.status === 'stopped' || currentExecution.cancelled)
        ),
        message: 'Follow-up was already accepted.',
      };
    }
    if (this.isDesktopHumanAdmissionBlocked(desktopAdmissionEpoch)) {
      if (requestedId) this.removeQueuedFollowUp(chatId, requestedId);
      return { accepted: false, status: 'cancelled', message: 'This queued request was stopped when the app window closed.' };
    }
    const execution = this.executions.get(chatId);
    if (!execution) {
      return { accepted: false, status: 'not_found', message: 'No agent run exists for this chat.' };
    }
    const queue = this.userFollowUpQueues.get(chatId) || [];
    const id = requestedId || randomUUID();
    const duplicate = queue.find(item => item.id === id);
    if (duplicate) {
      const item = this.getQueuedFollowUps(chatId).find(entry => entry.id === duplicate.id);
      return { accepted: true, status: 'queued', item, message: 'Follow-up was already queued.' };
    }
    // Already-admitted steering needs one handoff slot even if ordinary
    // follow-ups filled their queue while the current response was ending.
    if (queue.length >= MAX_USER_FOLLOW_UP_QUEUE && !steeringMessages?.length) {
      return { accepted: false, status: 'queue_full', message: 'The follow-up queue is full.' };
    }

    const item: QueuedUserFollowUp = {
      id,
      // When the renderer already committed an optimistic user boundary, its
      // requested ID is also the successor run identity. The eventual server
      // user_action then upserts that same bubble instead of creating a second
      // copy or making the query disappear while shutdown finishes.
      runId: requestedId || `queued_${randomUUID()}`,
      chatId,
      prompt: String(prompt || '').trim(),
      mediaAttachments: Array.isArray(mediaAttachments) ? [...mediaAttachments] : [],
      createdAt: Number.isFinite(requestedCreatedAt) && Number(requestedCreatedAt) > 0
        ? Number(requestedCreatedAt)
        : Date.now(),
      ...(runtimeOverride ? { runtimeOverride } : {}),
      ...(steeringMessages ? { steeringMessages } : {}),
    };
    queue.push(item);
    // Network completion order is not user intent. Preserve the client-side
    // admission sequence across concurrent repeated sends.
    queue.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    this.userFollowUpQueues.set(chatId, queue);
    this.notifyTraceWaiters(chatId);

    const summary = this.getQueuedFollowUps(chatId).find(entry => entry.id === id);
    if (summary) {
      const receipts = this.userFollowUpReceipts.get(chatId) || new Map<string, QueuedUserFollowUpSummary>();
      receipts.set(id, summary);
      while (receipts.size > 200) receipts.delete(receipts.keys().next().value!);
      this.userFollowUpReceipts.set(chatId, receipts);
    }
    if (execution.settled) queueMicrotask(() => void this.startNextQueuedWork(chatId));
    return {
      accepted: true,
      status: execution.settled ? 'starting' : 'queued',
      item: summary,
      handoffPending: execution.status === 'stopped' || execution.cancelled,
      message: execution.settled ? 'Follow-up is starting.' : 'Follow-up queued after the active run.',
    };
  }

  public hasCancelledFollowUp(chatId: string, id: string): boolean {
    const admissionId = normalizeAdmissionId(id);
    const cancelled = this.cancelledFollowUpAdmissions?.get(chatId);
    return Boolean(cancelled?.has(admissionId) || cancelled?.has(id) || cancelled?.has(`steering-turn-${admissionId}`));
  }

  public removeQueuedFollowUp(chatId: string, id: string): boolean {
    if (this.hasCancelledFollowUp(chatId, id)) return true;
    const admissionId = normalizeAdmissionId(id);
    const queue = this.userFollowUpQueues.get(chatId) || [];
    const receipt = this.userFollowUpReceipts.get(chatId)?.get(id);
    const execution = this.executions.get(chatId);
    const matches = (value: string) => normalizeAdmissionId(value) === admissionId;
    const pendingSteering = execution?.steeringQueue.some(item => matches(item.id));
    const pendingFollowUp = queue.some(item => item.steeringMessages?.length
      ? item.steeringMessages.some(message => matches(message.id)) : matches(item.id));
    // Removing pending work is not permission to stop an already admitted run.
    if (receipt && !pendingFollowUp && !pendingSteering) return false;
    this.cancelledFollowUpAdmissions ??= new Map();
    const cancelled = this.cancelledFollowUpAdmissions.get(chatId) || new Set<string>();
    cancelled.add(admissionId);
    while (cancelled.size > 200) cancelled.delete(cancelled.values().next().value!);
    this.cancelledFollowUpAdmissions.set(chatId, cancelled);
    while (this.cancelledFollowUpAdmissions.size > 200) {
      this.cancelledFollowUpAdmissions.delete(this.cancelledFollowUpAdmissions.keys().next().value!);
    }
    const next = queue.flatMap(item => {
      if (!item.steeringMessages?.length) return matches(item.id) ? [] : [item];
      const remaining = item.steeringMessages.filter(message => !matches(message.id));
      if (remaining.length === item.steeringMessages.length) return [item];
      if (!remaining.length) return [];
      // Removing one message during the completion handoff must leave the
      // other messages and their attachments available to the successor.
      return [{
        ...item, steeringMessages: remaining,
        prompt: remaining.map(message => message.text).join('\n\n'),
        mediaAttachments: remaining.every(message => Array.isArray(message.attachments))
          ? remaining.flatMap(message => message.attachments || []) : item.mediaAttachments,
        createdAt: remaining[0].createdAt || item.createdAt,
      }];
    });
    if (next.length > 0) this.userFollowUpQueues.set(chatId, next);
    else this.userFollowUpQueues.delete(chatId);
    if (execution) {
      execution.steeringQueue = execution.steeringQueue.filter(item => !matches(item.id));
      this.appendTrace(execution, {
        id: `queue-cancelled:${chatId}:${admissionId}`,
        type: 'steering_cancelled', admissionId, steeringId: admissionId,
        steeringIds: [admissionId, id], ownerChatId: chatId, timestamp: Date.now(),
      });
    }
    this.notifyTraceWaiters(chatId);
    return true;
  }

  public prioritizeQueuedFollowUp(chatId: string, id: string): boolean {
    const queue = this.userFollowUpQueues.get(chatId);
    if (!queue) return false;
    const index = queue.findIndex(item => item.id === id);
    if (index < 0) return false;
    if (index > 0) {
      const [item] = queue.splice(index, 1);
      queue.unshift(item);
      this.notifyTraceWaiters(chatId);
    }
    const execution = this.executions.get(chatId);
    if (!execution || execution.settled) queueMicrotask(() => void this.startNextQueuedWork(chatId));
    return true;
  }

  /** Transfer ownership atomically; never remove a message before admission. */
  public steerQueuedFollowUp(chatId: string, id: string): boolean {
    if (this.hasCancelledFollowUp(chatId, id)) return false;
    if (this.hasAcceptedSteering(chatId, id)) return true;
    const queue = this.userFollowUpQueues.get(chatId) || [];
    const item = queue.find(entry => entry.id === id);
    if (!item) return Boolean(this.userFollowUpReceipts.get(chatId)?.has(id));
    const execution = this.executions.get(chatId);
    if (!execution || execution.status !== 'running' || execution.settled || execution.completedAt) {
      return this.prioritizeQueuedFollowUp(chatId, id);
    }
    if (!this.addSteeringMessage(chatId,
      item.prompt || 'Please review the attached files.', id,
      { createdAt: item.createdAt, attachments: item.mediaAttachments }, execution.runId)) return false;
    const remaining = queue.filter(entry => entry.id !== id);
    if (remaining.length) this.userFollowUpQueues.set(chatId, remaining);
    else this.userFollowUpQueues.delete(chatId);
    this.notifyTraceWaiters(chatId);
    return true;
  }

  public clearQueuedFollowUps(
    chatId: string,
    admittedAtOrBefore = Number.POSITIVE_INFINITY,
  ): number {
    const queue = this.userFollowUpQueues.get(chatId) || [];
    const retained = queue.filter(item => item.createdAt > admittedAtOrBefore);
    const count = queue.length - retained.length;
    // Remember Stop's removals just like an individual queue cancellation.
    // A late retry of a lost enqueue reply must not resurrect stopped work.
    for (const item of queue) {
      if (item.createdAt <= admittedAtOrBefore) {
        const ids = item.steeringMessages?.length ? item.steeringMessages.map(message => message.id) : [item.id];
        for (const id of ids) this.removeQueuedFollowUp(chatId, id);
      }
    }
    if (retained.length > 0) this.userFollowUpQueues.set(chatId, retained);
    else this.userFollowUpQueues.delete(chatId);
    return count;
  }

  private async startNextQueuedWork(chatId: string): Promise<void> {
    const current = this.executions.get(chatId);
    if (current && (current.status === 'running' || !current.settled)) return;

    const queue = this.userFollowUpQueues.get(chatId);
    const next = queue?.[0];
    if (next) {
      const runtimeSettings = next.runtimeOverride?.runtimeSettings
        || current?.launchSpec.runtimeSettings
        || buildScopedRuntimeSettings();
      const history = current ? [...current.launchSpec.history] : [];
      if (current) {
        history.push({ role: 'user', parts: [{ text: getVisibleRunPrompt(current.prompt) }], contextTurnId: `user-turn-${current.runId}` });
        if (current.finalAnswer && current.status !== 'stopped') {
          history.push({ role: 'model', parts: [{ text: current.finalAnswer }] });
        }
      }

      const queuedPinnedContext = next.runtimeOverride
        ? {
            ...(current?.launchSpec.pinnedContext || {}),
            selectedModelProvider: next.runtimeOverride.selectedModelProvider,
            selectedModelName: next.runtimeOverride.selectedModelName,
            strictModelSelection: true,
            thinkingLevel: next.runtimeOverride.thinkingLevel
              || current?.launchSpec.pinnedContext?.thinkingLevel,
            ...(next.runtimeOverride.modelThinkingCapability
              ? { modelThinkingCapability: next.runtimeOverride.modelThinkingCapability }
              : {}),
            ...(Array.isArray(next.runtimeOverride.modelWireCapabilities) && next.runtimeOverride.modelWireCapabilities.length > 0
              ? { modelWireCapabilities: next.runtimeOverride.modelWireCapabilities }
              : {}),
          }
        : current?.launchSpec.pinnedContext || {};
      const result = this.startAgent(
        chatId,
        next.prompt || 'Please review the attached file or media and help me with it.',
        history,
        next.runtimeOverride?.mode || current?.launchSpec.mode || 'think',
        current?.launchSpec.userId || 'default_user',
        { ...queuedPinnedContext, autonomy: { ...queuedPinnedContext.autonomy, origin: undefined, proxyTaskId: undefined, proxyTaskPrompt: undefined }, steeringMessages: next.steeringMessages || [] },
        next.mediaAttachments,
        current?.launchSpec.userName || 'Developer',
        runtimeSettings.preferredGeminiApiKey,
        runtimeSettings,
        next.runId,
      );
      if (result.status === 'started') {
        queue!.shift();
        if (queue!.length === 0) this.userFollowUpQueues.delete(chatId);
        this.notifyTraceWaiters(chatId);
        return;
      }

      console.warn(`[AgentRegistry] Queued follow-up could not start for ${chatId.substring(0, 8)}...: ${result.message}`);
      return;
    }

    await this.startNextProxyTask(chatId);
  }

  public queueProxyTask(
    chatId: string,
    prompt: string,
    rationale = '',
    options: { dependency?: string; supersedesTaskId?: string; mediaAttachments?: ProxyTaskInput['mediaAttachments']; model?: ProxyTaskInput['model'] } = {},
  ): {
    accepted: boolean;
    status: 'pending' | 'starting' | 'failed';
    id: string;
    error?: string;
  } {
    return this.queueProxyWorkflow(chatId, [{ prompt, rationale, dependency: options.dependency, mediaAttachments: options.mediaAttachments, model: options.model }], options.supersedesTaskId);
  }

  public queueProxyWorkflow(
    chatId: string,
    tasks: ProxyTaskInput[],
    supersedesTaskId?: string,
  ): { accepted: boolean; status: 'pending' | 'starting' | 'failed'; id: string; error?: string } {
    let task;
    try {
      [task] = enqueueProxyTasks(chatId, tasks, supersedesTaskId);
    } catch (error: any) {
      return { accepted: false, status: 'failed', id: '', error: error?.message || 'The tasks could not be queued.' };
    }
    const execution = this.findExecution(chatId);
    const running = execution?.status === 'running' || (execution && !execution.settled);
    // Start the handoff in the current event-loop turn. An unref'ed timer can
    // be abandoned when the route/request scope goes idle, leaving a task
    // permanently marked pending even though Proxy Manager reported "starting".
    if (!running && !this.userFollowUpQueues.get(chatId)?.length) {
      void this.startNextProxyTask(chatId);
      const settledTask = readProxyControl(chatId).taskQueue.find(item => item.id === task.id);
      if (settledTask?.status === 'failed') {
        return {
          accepted: false,
          status: 'failed',
          id: task.id,
          error: settledTask.error || 'Main could not start the delegated task.',
        };
      }
    }
    const admittedTask = readProxyControl(chatId).taskQueue.find(item => item.id === task.id);
    return { accepted: true, status: admittedTask?.status === 'started' || admittedTask?.status === 'starting' ? 'starting' : 'pending', id: task.id };
  }

  private async startNextProxyTask(chatId: string): Promise<void> {
    const admissionControl = readProxyControl(chatId);
    if (!admissionControl.enabled || admissionControl.paused) return;
    const current = this.findExecution(chatId);
    if (current && (current.status === 'running' || !current.settled)) return;
    const task = claimNextProxyTask(chatId);
    if (!task) return;

    try {
    const control = readProxyControl(chatId);
    const baseRuntimeSettings = current?.launchSpec.runtimeSettings || buildScopedRuntimeSettings();
    const requestedTaskModel = task.model;
    const taskProvider = requestedTaskModel && isModelProvider(requestedTaskModel.provider) ? requestedTaskModel.provider : undefined;
    const taskModel = taskProvider && task.model?.modelId?.trim() ? task.model.modelId.trim() : undefined;
    const runtimeSettings = taskProvider && taskModel
      ? { ...baseRuntimeSettings, modelOverrides: { ...baseRuntimeSettings.modelOverrides, [taskProvider]: taskModel } }
      : baseRuntimeSettings;
    const predecessor = task.dependsOnTaskId ? control.taskQueue.find(item => item.id === task.dependsOnTaskId) : undefined;
    const priorHistory = predecessor
      ? buildProxyTaskHistory([], predecessor.prompt,
        predecessor.result || predecessor.error || (current?.runId === predecessor.runId ? current?.finalAnswer : '') || `The prerequisite has no saved result. Its last recorded status is ${predecessor.status}; do not assume it succeeded.`, true)
      : current
      ? buildProxyTaskHistory(
        current.launchSpec.history,
        String(current.launchSpec.pinnedContext?.autonomy?.proxyTaskPrompt || current.prompt),
        current.finalAnswer,
        Boolean(task.dependency),
      )
      : [];
    const basePinned = current?.launchSpec.pinnedContext || {};
    const pinnedContext = {
      ...basePinned,
      ...(taskProvider && taskModel ? { selectedModelProvider: taskProvider, selectedModelName: taskModel, strictModelSelection: true } : {}),
      agentRuntime: 'autonomy_v1',
      autonomy: {
        ...(basePinned.autonomy || {}),
        enabled: control.enabled,
        paused: control.paused,
        collaboration: 'user_proxy',
        initiative: 'high',
        verification: 'adaptive',
        intervention: control.intervention,
        proxyModelSelection: control.modelSelection,
        origin: 'proxy_manager',
        proxyTaskId: task.id,
        proxyTaskPrompt: task.prompt,
      },
    };
    const result = this.startAgent(
      chatId,
      task.dependency
        ? `${task.prompt}\n\nDependency: ${task.dependency}. Use the immediately preceding result in conversation history as evidence. If that run failed, recover from its visible partial result or explain the unresolved dependency; do not silently skip this task. Do not repeat completed work unless a correction is required.`
        : task.prompt,
      priorHistory,
      taskProvider ? MODEL_PROVIDER_MODE[taskProvider] : current?.launchSpec.mode || 'think',
      current?.launchSpec.userId || 'default_user',
      pinnedContext,
      task.mediaAttachments || [],
      current?.launchSpec.userName || 'Developer',
      runtimeSettings.preferredGeminiApiKey,
      runtimeSettings,
    );
    settleProxyTask(chatId, task.id, result.status === 'started'
      ? { status: 'started', runId: result.runId }
      : { status: 'failed', error: result.message });
    } catch (error: any) {
      settleProxyTask(chatId, task.id, { status: 'failed', error: error?.message || 'Main could not start the delegated task.' });
    }
  }

  public getProxyManagerContext(chatId: string): Record<string, any> {
    const execution = this.findExecution(chatId);
    const projectId = execution?.orchestratorProjectId || chatId;
    const proxyControl = readProxyControl(chatId);
    const proxySnapshot = getUserProxyManagerSnapshot(projectId);
    if (proxySnapshot) proxySnapshot.interventionLevel = proxyControl.intervention;
    const visibleTypes = new Set(['task_plan', 'plan', 'work_note', 'tool_call', 'tool_result', 'tool_result_preview', 'file_preview', 'evidence', 'error', 'steering_received', 'steering_applied', 'autonomy_proxy_status', 'sub_agent_spawn', 'sub_agent_complete', 'sub_agent_error', 'inter_agent_message', 'answer', 'done']);
    const internalProxyControlPhases = new Set(['independent_supervision', 'watching', 'policy_changed', 'model_changed']);
    const activity = (execution?.traceBuffer || [])
      .map(entry => ({ ...entry.data, timestamp: entry.timestamp }))
      .filter(trace =>
        visibleTypes.has(String(trace?.type || '')) &&
        !(
          trace?.type === 'autonomy_proxy_status' &&
          internalProxyControlPhases.has(String(trace?.phase || '').trim().toLowerCase())
        )
      )
      .slice(-36)
      .map(trace => {
        const delegation = delegationTelemetryFromTrace(trace);
        return {
          type: String(trace.type || ''),
          text: formatUnknownError(
            delegation?.summary ?? trace.text ?? trace.data ?? trace.output ?? trace.result ?? trace.error,
            '',
            2400,
          ),
          tool: String(trace.tool || trace.toolName || trace.name || '').slice(0, 120),
          success: trace.success,
          phase: trace.phase,
          delegation: delegation || undefined,
          timestamp: trace.timestamp,
        };
      });
    return {
      chatId,
      run: execution ? {
        status: execution.status,
        settling: !execution.settled && execution.status !== 'running',
        runId: execution.runId,
        objective: execution.prompt.slice(0, 6000),
        startedAt: execution.startedAt,
        mode: execution.mode,
        effectiveModel: execution.effectiveModel,
        finalAnswer: execution.status === 'running' ? '' : execution.finalAnswer.slice(0, 5000),
      } : { status: 'idle', objective: '' },
      activity,
      workspace: {
        path: execution?.launchSpec.pinnedContext?.workspacePath || '',
        pinnedPaths: Array.isArray(execution?.launchSpec.pinnedContext?.paths)
          ? execution.launchSpec.pinnedContext.paths.slice(0, 20)
          : [],
      },
      capabilities: this.getMainCapabilitySummary(activity, execution?.prompt || ''),
      proxy: proxySnapshot,
      proxyControl: {
        ...proxyControl,
        taskQueue: proxyControl.taskQueue.map(task => ({ ...task, result: task.result?.slice(-2400) })),
        pendingTaskCount: getPendingProxyTaskCount(chatId),
      },
      sideAgent: {
        role: 'coordination',
        access: 'read_only',
        capabilities: [
          'Live run context',
          'Workspace inspection',
          'Web research',
          'Document reading',
          'Calculation',
          'Workflow scheduling',
        ],
      },
    };
  }

  private getMainCapabilitySummary(activity: Array<Record<string, any>>, objective: string): Record<string, any> {
    const recentlyUsed = new Set(activity.map(item => String(item.tool || '')).filter(Boolean));
    const objectiveTerms = new Set((objective.toLowerCase().match(/[a-z0-9]{4,}/g) || []).slice(0, 80));
    const groups = new Map<string, string[]>();
    const relevant: Array<{ name: string; category: string; capability: string; recentlyUsed: boolean }> = [];
    for (const tool of globalToolRegistry.getAllTools()) {
      const category = String(tool.category || 'support');
      const items = groups.get(category) || [];
      items.push(tool.name);
      groups.set(category, items);
      const description = String(tool.description || '').replace(/\s+/g, ' ').trim();
      const haystack = `${tool.name} ${description}`.toLowerCase();
      const isRelevant = recentlyUsed.has(tool.name) || Array.from(objectiveTerms).some(term => haystack.includes(term));
      if (isRelevant) relevant.push({ name: tool.name, category, capability: description.slice(0, 180), recentlyUsed: recentlyUsed.has(tool.name) });
    }
    return {
      note: 'Every registered Main capability name is grouped below. Detailed descriptions are included only for task-relevant or recently used tools to save side-agent tokens. Presence does not authorize Proxy Manager to execute tools.',
      total: Array.from(groups.values()).reduce((sum, items) => sum + items.length, 0),
      groups: Object.fromEntries(groups),
      relevant: relevant.slice(0, 36),
    };
  }

  public deliverProxyManagerDirective(chatId: string, directive: Omit<ProxyManagerDirective, 'id' | 'createdAt' | 'status'>) {
    const execution = this.findExecution(chatId);
    const projectId = execution?.orchestratorProjectId || chatId;
    if (directive.requestedAction === 'stop_main' && directive.timing === 'now') {
      // An explicit stop also cancels successors; never save it to stop an unrelated future run.
      const stopped = this.stopAgent(chatId, directive.message);
      return { accepted: stopped, status: stopped ? 'delivered' as const : 'rejected' as const };
    }
    if (directive.requestedAction === 'interrupt_main' && execution?.status !== 'running') {
      return { accepted: false, status: 'rejected' as const };
    }
    const delivered = deliverUserProxyManagerDirective(projectId, directive);
    if (delivered.accepted) return delivered;
    const saved = saveDormantProxyDirective(chatId, directive);
    return { accepted: true, status: saved.status, id: saved.id };
  }

  /**
   * Get status of all active executions.
   */
  public getAllStatus(): Array<{
    chatId: string;
    status: string;
    startedAt: number;
    traceCount: number;
    traceCounter: number;
    durationSec: number;
    toolCallCount: number;
    effectiveModel?: string;
    complexity?: string;
    peakMemoryMB: number;
    steeringQueueLength: number;
    completedAt?: number;
  }> {
    const now = Date.now();
    return Array.from(this.executions.entries())
      .filter(([_, e]) => e.status === 'running' || (now - (e.completedAt || now)) < 300_000) // Show running + recently completed (5 min)
      .map(([chatId, e]) => ({
        chatId,
        status: e.status,
        startedAt: e.startedAt,
        traceCount: e.traceBuffer.length,
        traceCounter: e.traceCounter,
        durationSec: Math.round(((e.completedAt || now) - e.startedAt) / 1000),
        toolCallCount: e.toolCallCount,
        effectiveModel: e.effectiveModel,
        complexity: e.complexity,
        peakMemoryMB: e.peakMemoryMB,
        steeringQueueLength: e.steeringQueue.length,
        completedAt: e.completedAt,
      }));
  }

  /**
   * Get the per-chat cancel flag. Used by the execution loop.
   */
  public isCancelled(chatId: string): boolean {
    const execution = this.executions.get(chatId);
    return execution?.cancelled ?? false;
  }

  /**
   * Cleanup old completed executions to free memory.
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    const completedExecutions: Array<[string, AgentExecution]> = [];
    const cleanedProjectIds = new Set<string>();

    for (const [chatId, cancellation] of this.pendingRunCancellations.entries()) {
      if (cancellation.expiresAt <= now) this.pendingRunCancellations.delete(chatId);
    }

    for (const [chatId, archives] of this.archivedExecutions.entries()) {
      const retained = archives.filter(execution =>
        now - Number(execution.completedAt || execution.startedAt || now) <= MAX_COMPLETED_AGE
      ).slice(-4);
      // Archives exist for transcript reconciliation, not to retain the full
      // live runtime indefinitely. Compact them after the normal grace window
      // even when no client happens to poll that predecessor again.
      retained.forEach(execution => this.compactExecutionForRetention(execution));
      if (retained.length > 0) this.archivedExecutions.set(chatId, retained);
      else this.archivedExecutions.delete(chatId);
    }

    for (const [chatId, execution] of this.executions.entries()) {
      if (execution.status !== 'running' && execution.completedAt) {
        if ((this.userFollowUpQueues.get(chatId)?.length || 0) > 0) {
          // A queued user turn is live work, not retention data. Retry its
          // handoff instead of compacting/deleting the predecessor it needs for
          // history and runtime settings.
          void this.startNextQueuedWork(chatId);
          continue;
        }
        this.compactExecutionForRetention(execution);
        completedExecutions.push([chatId, execution]);

        if (now - execution.completedAt > MAX_COMPLETED_AGE) {
          this.executions.delete(chatId);
          this.userFollowUpReceipts.delete(chatId);
          const pendingWake = this.traceWakeTimers.get(chatId);
          if (pendingWake) clearTimeout(pendingWake);
          this.traceWakeTimers.delete(chatId);
          this.traceChangeVersions?.delete(chatId);
          cleaned++;
          cleanedProjectIds.add(chatId);
          if (execution.orchestratorProjectId) cleanedProjectIds.add(execution.orchestratorProjectId);
        }
      }
    }

    const retainedCompleted = completedExecutions
      .filter(([chatId]) => this.executions.has(chatId))
      .sort((a, b) => (a[1].completedAt || 0) - (b[1].completedAt || 0));

    while (retainedCompleted.length > MAX_COMPLETED_EXECUTIONS) {
      const [chatId] = retainedCompleted.shift()!;
      const execution = this.executions.get(chatId);
      this.executions.delete(chatId);
      this.userFollowUpReceipts.delete(chatId);
      const pendingWake = this.traceWakeTimers.get(chatId);
      if (pendingWake) clearTimeout(pendingWake);
      this.traceWakeTimers.delete(chatId);
      this.traceChangeVersions?.delete(chatId);
      cleaned++;
      cleanedProjectIds.add(chatId);
      if (execution?.orchestratorProjectId) cleanedProjectIds.add(execution.orchestratorProjectId);
    }

    for (const projectId of cleanedProjectIds) {
      interAgentMailbox.clearProject(projectId).catch(() => { });
      clearPendingResults(projectId);
      void agentMessageBus.clearAll(projectId).catch(() => { });
    }

    if (now - this.lastTaskStoreCleanupAt > TASK_STORE_CLEANUP_INTERVAL) {
      this.lastTaskStoreCleanupAt = now;
      taskStore.cleanup().catch((error: any) => {
        console.warn(`[AgentRegistry] Task store cleanup failed: ${ error?.message || error }`);
      });
    }

    if (cleaned > 0) {
      console.log(`[AgentRegistry] 🧹 Cleaned up ${ cleaned } old executions. Active: ${ this.executions.size }`);
    }
  }

  /**
   * Emergency stop all agents (app shutdown).
   */
  public getDesktopAdmissionEpoch(): number { return this.desktopAdmissionEpoch || 0; }

  public isDesktopHumanAdmissionBlocked(epoch?: number): boolean {
    return Boolean(this.desktopClosePolicy || (epoch !== undefined && epoch !== this.getDesktopAdmissionEpoch()));
  }

  public resumeDesktopRuns(): void {
    if (!this.desktopClosePolicy) return;
    this.desktopClosePolicy = null;
    this.desktopAdmissionEpoch = this.getDesktopAdmissionEpoch() + 1;
  }

  public stopForDesktopClose(options: { keepScheduled?: boolean; keepChannels?: boolean } = {}): string[] {
    this.desktopClosePolicy = options;
    this.desktopAdmissionEpoch = this.getDesktopAdmissionEpoch() + 1;
    const chatIds: string[] = [];
    for (const [chatId, execution] of this.executions) {
      const context = execution.launchSpec?.pinnedContext;
      const source = String(context?.triggerSource || '').trim();
      if (options.keepScheduled && (source === 'scheduled_task' || context?.scheduledTaskId)) continue;
      if (options.keepChannels && source === 'gateway') continue;
      chatIds.push(chatId);
      // Stop owns queue cancellation and child/proxy cleanup, while retaining
      // an already completed answer if completion won the close race.
      this.stopAgent(chatId, 'Stopped when the app window closed.', undefined, execution.runId);
    }
    return chatIds;
  }

  public stopAll(): void {
    cancelAllSubAgents();
    for (const chatId of this.userFollowUpQueues.keys()) this.clearQueuedFollowUps(chatId);
    this.pendingRunCancellations.clear();
    for (const [chatId, execution] of this.executions.entries()) {
      if (execution.status === 'running') {
        execution.cancelled = true;
        execution.abortController.abort(new Error('CANCELLED_BY_USER'));
        execution.status = 'stopped';
        execution.completedAt = Date.now();
        execution.steeringQueue = [];
        this.appendTrace(execution, createStoppedRunTrace({
          ownerChatId: chatId,
          runId: execution.runId,
          turnId: execution.activeTurnId || execution.runId,
        }, execution.completedAt));
        taskStore.stopTask(chatId, 'Stopped by user.', execution.runId).catch(() => { });
        if (execution.orchestratorProjectId) {
          try { stopUserProxyRuntime(execution.orchestratorProjectId); } catch { }
        }
      }
    }
    console.log(`[AgentRegistry] 🛑 Emergency stop — all agents stopped`);
  }
}

// ═══════════════════════════════════════════
// PROCESS-GLOBAL SINGLETON
// ═══════════════════════════════════════════
// Next.js can evaluate API route bundles independently in dev. Store the registry
// on globalThis so /api/chat, /api/agent/start, /api/agent/poll, and /api/agent/stop
// all observe the same running executions.
const globalForAgentRegistry = globalThis as typeof globalThis & {
  __eterxAgentRegistry?: AgentRegistry;
};

const existingAgentRegistry = globalForAgentRegistry.__eterxAgentRegistry;
export const agentRegistry =
  existingAgentRegistry &&
  typeof existingAgentRegistry.getQueuedFollowUps === 'function' &&
  typeof existingAgentRegistry.getLifecycleVersion === 'function' &&
  existingAgentRegistry.getLifecycleVersion() === 4
    // Refresh methods on hot reload without replacing live queues, receipts,
    // cancellation flags, or the executions already held by other routes.
    ? Object.setPrototypeOf(existingAgentRegistry, AgentRegistry.prototype) as AgentRegistry
    : (globalForAgentRegistry.__eterxAgentRegistry = new AgentRegistry());
