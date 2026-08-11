import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'crypto';
import { AgentOrchestrator } from './orchestrator';
import { apiKeyPool, type KeyLease } from './api-key-pool';
import { taskStore } from './task-store';
import { writeRuntimeTrace } from './runtime-trace';
import { getMainAgentModelConfig, type MainAgentMode } from './model-routing';
import { MODEL_PROVIDER_MODE, isModelProvider } from './model-selector-store';
import { buildScopedRuntimeSettings, getScopedRuntimeApiKey, type ScopedRuntimeSettings } from './runtime-api-keys';
import { flushLedgerForChat } from './memory/conversation-ledger';
import { globalToolRegistry } from './tools/registry';
import { observeUserProxy, startUserProxyRuntime, stopUserProxyRuntime, pauseUserProxyRuntime, resumeUserProxyRuntime, setUserProxyIntervention, setUserProxyModel, getUserProxyManagerSnapshot, deliverUserProxyManagerDirective, type ProxyInterventionLevel, type ProxyManagerDirective } from './autonomy/user-proxy-runtime';
import { cancelPendingProxyTasks, claimDormantProxyDirectives, claimNextProxyTask, enqueueProxyTask, getPendingProxyTaskCount, readProxyControl, saveDormantProxyDirective, settleProxyTask, updateProxyControl } from './autonomy/proxy-control-plane';
import { agentMessageBus, cancelAgent, cancelAllSubAgents, clearCancelState, clearPendingResults, globalSubAgentSpawner } from './roles/sub_agent';
import { interAgentMailbox } from './roles/inter_agent_comm';
import { normalizeAttachmentMime } from './attachment-pipeline';
import { normalizeStreamTimestamp } from '../streaming-lifecycle';
import { getEterxWorkspaceDir } from './storage-paths';
import { delegationTelemetryFromTrace } from './delegation-evidence';

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
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  completedAt?: number;
  traceBuffer: TraceEvent[];   // In-memory circular buffer
  traceCounter: number;        // Monotonic counter — NEVER resets, survives buffer trimming
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

interface QueuedUserFollowUp {
  id: string;
  runId: string;
  chatId: string;
  prompt: string;
  mediaAttachments: any[];
  createdAt: number;
}

export interface QueuedUserFollowUpSummary {
  id: string;
  runId: string;
  chatId: string;
  text: string;
  createdAt: number;
  attachmentCount: number;
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
  if (!hasDependency) return history.slice(-24);

  history.push({ role: 'user', parts: [{ text: previousPrompt }] });
  if (previousAnswer) history.push({ role: 'model', parts: [{ text: previousAnswer }] });
  return history.slice(-24);
};

const MAX_TRACE_BUFFER = 2000;          // Max traces kept in memory per chat
const MAX_COMPLETED_TRACE_BUFFER = 350;
const MAX_STEERING_QUEUE = 25;
const MAX_USER_FOLLOW_UP_QUEUE = 50;
const MAX_COMPLETED_EXECUTIONS = 30;
const TRACE_COMPACTION_GRACE_MS = 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Cleanup completed agents frequently
const TASK_STORE_CLEANUP_INTERVAL = 15 * 60 * 1000;
const MAX_COMPLETED_AGE = 2 * 60 * 60 * 1000; // 2 hours max retention for completed agents

class AgentRegistry {
  private executions: Map<string, AgentExecution> = new Map();
  private userFollowUpQueues: Map<string, QueuedUserFollowUp[]> = new Map();
  private userFollowUpReceipts: Map<string, Map<string, QueuedUserFollowUpSummary>> = new Map();
  private pendingRunCancellations: Map<string, { runId?: string; expiresAt: number }> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private lastTaskStoreCleanupAt = 0;

  public getLifecycleVersion(): number {
    return 3;
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

  constructor() {
    // Any persisted `running` task belongs to a previous process after a
    // desktop restart. Convert it before the UI can rehydrate it as live.
    taskStore.recoverOrphanedRunningTasks().catch(() => {});
    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
    this.cleanupTimer.unref?.();
  }

  private getProcessMemoryMB(): number {
    try {
      return Math.round(process.memoryUsage().rss / 1024 / 1024);
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
    execution.traceBuffer = execution.traceBuffer
      .slice(-MAX_COMPLETED_TRACE_BUFFER)
      .map(entry => ({
        ...entry,
        data: this.compactTracePayload(entry.data),
      }));
    execution.retentionCompacted = true;
  }

  public appendTrace(execution: AgentExecution, traceEvent: any, persistToTaskStore = true): TraceEvent {
    if (traceEvent?.type === 'file_preview') {
      let existingIdx = -1;
      for (let index = execution.traceBuffer.length - 1; index >= 0; index -= 1) {
        const existing = execution.traceBuffer[index]?.data;
        if (existing?.type === 'user_action') break;
        if (existing?.type !== 'file_preview') continue;
        const sameOwner = traceEvent.ownerTraceId && existing.ownerTraceId === traceEvent.ownerTraceId;
        const samePath =
          !traceEvent.ownerTraceId &&
          traceEvent.filepath &&
          traceEvent.dedupe !== false &&
          existing.filepath === traceEvent.filepath &&
          existing.dedupe !== false;
        if (sameOwner || samePath) {
          existingIdx = index;
          break;
        }
      }
      if (existingIdx >= 0) execution.traceBuffer.splice(existingIdx, 1);
    }

    const now = Date.now();
    const normalizedTrace = traceEvent && typeof traceEvent === 'object'
      ? {
        ...traceEvent,
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
      execution.traceBuffer = execution.traceBuffer.slice(-MAX_TRACE_BUFFER);
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
  ): { status: 'started' | 'already_running' | 'no_keys' | 'cancelled'; chatId: string; runId?: string; message: string } {

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
      prompt,
      status: 'running',
      startedAt: Date.now(),
      traceBuffer: [],
      traceCounter: 0,
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

    // Make the new run authoritative before emitting its first trace. A
    // completed predecessor remains in the map until this replacement; if
    // registration happens later, onTrace correctly treats the successor's
    // opening user_action as stale and drops it from the live feed.
    this.executions.set(chatId, execution);

    // Build the trace callback that writes to the buffer
    const onTrace = (traceEvent: any) => {
      if (traceEvent && typeof traceEvent === 'object') {
        const reportedRunId = String(traceEvent.runId || traceEvent.turnId || '').trim();
        traceEvent = {
          ...traceEvent,
          ...(reportedRunId && reportedRunId !== execution.runId
            ? { originRunId: reportedRunId }
            : {}),
          ownerChatId: chatId,
          runId: execution.runId,
          turnId: execution.runId,
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

    const proxyOrigin = pinnedContext?.autonomy?.origin === 'proxy_manager';
    // Every Main run begins with the same canonical user boundary. Human runs
    // may already have an optimistic local bubble; the client upserts this
    // server-owned trace by run ID. Proxy-started work therefore follows the
    // exact same transcript route instead of relying on a special feed path.
    const runUserEvent = {
      type: 'user_action',
      id: proxyOrigin
        ? `proxy-task-${pinnedContext?.autonomy?.proxyTaskId || execution.runId}`
        : `user-turn-${execution.runId}`,
      text: proxyOrigin
        ? String(pinnedContext?.autonomy?.proxyTaskPrompt || prompt)
        : getVisibleRunPrompt(prompt),
      source: proxyOrigin ? 'proxy_manager' : 'human',
      delegatedBy: proxyOrigin ? 'Side Proxy-Agent' : undefined,
      proxyTaskId: proxyOrigin ? pinnedContext?.autonomy?.proxyTaskId : undefined,
      runId: execution.runId,
      turnId: execution.runId,
      startTime: execution.startedAt,
      endTime: execution.startedAt,
      timestamp: execution.startedAt,
    };
    onTrace(runUserEvent);

    onTrace({
      type: 'work_note',
      text: `${ modelConfig.label } is starting`,
      noteId: 'eterx-agent-connection',
      isDelta: false,
      isStreaming: false,
      _connection: true,
    });

    // Fire-and-forget execution
    execution.promise = (async () => {
      let terminalStatus: AgentExecution['status'] = 'failed';
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

        const imageCount = geminiNativeFiles.filter(file => String(file.mimeType || '').startsWith('image/')).length;
        const videoCount = geminiNativeFiles.filter(file => String(file.mimeType || '').startsWith('video/')).length;
        const viewedText = imageCount === 1 && videoCount === 0 && geminiNativeFiles.length === 1
          ? 'Viewed an image'
          : videoCount === 1 && imageCount === 0 && geminiNativeFiles.length === 1
            ? 'Viewed a video'
            : imageCount > 0 && videoCount === 0
              ? `Viewed ${ imageCount } image${ imageCount === 1 ? '' : 's' }`
              : `Viewed ${ geminiNativeFiles.length } attachment${ geminiNativeFiles.length === 1 ? '' : 's' }`;
        if (geminiNativeFiles.length > 0) {
          const now = Date.now();
          onTrace({
            id: `attachment-view-${ execution.runId }`,
            type: 'tool_call',
            toolName: 'attachment_view',
            name: 'attachment_view',
            text: viewedText,
            action: viewedText,
            uiActionText: viewedText,
            uiIcon: 'image',
            iconCategory: 'image',
            toolArgs: {
              chatId,
              attachments: geminiNativeFiles.map(file => ({ id: (file as any).id, name: file.name, mimeType: file.mimeType })),
            },
            attachments: geminiNativeFiles.map(file => ({
              id: (file as any).id,
              name: file.name,
              mimeType: file.mimeType,
            })),
            timestamp: now,
            startTime: now,
            endTime: now,
          });
        }

        // Build enriched prompt with file context
        let enrichedPrompt = '';
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
        const autonomyEnabled = pinnedContext?.agentRuntime === 'autonomy_v1' || pinnedContext?.autonomy?.enabled === true;
        const proxyLease = autonomyEnabled && !isExternalProvider
          ? apiKeyPool.leaseSubAgentKey(chatId, 'user_proxy')
          : null;
        const selectedProxyModel = (pinnedContext as any)?.autonomy?.proxyModelSelection;
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
        const selectedProxyApiKey = proxyModelEntry && proxyRuntimeSettings
          ? getScopedRuntimeApiKey(proxyRuntimeSettings, proxyModelEntry.provider)
          : '';
        const userProxyRuntime = startUserProxyRuntime({
          context: {
            ...(pinnedContext || {}),
            projectId,
            selectedModelMode: mode,
          } as any,
          objective: prompt,
          mode: proxyRuntimeMode,
          apiKey: isExternalProvider ? projectId : (selectedProxyApiKey || proxyLease?.apiKey || lease?.apiKey || ''),
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
          { ...(pinnedContext || {}), abortSignal: execution.abortController.signal },
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
        // Guidance that was not drained before the terminal response belongs
        // to this run and must not survive into a later turn.
        execution.steeringQueue = [];
        // Publish the terminal state before task/key/sub-agent cleanup. A new
        // user follow-up must never be steered into a run that has already
        // produced its final response and is only unwinding resources.
        execution.status = terminalStatus;
        execution.completedAt = execution.completedAt || Date.now();

        // Update effective model with the model mode resolved by the orchestrator!
        const actualModelConfig = getMainAgentModelConfig(response.modelMode, runtimeSettings);
        execution.effectiveModel = typeof pinnedContext?.selectedModelName === 'string'
          && pinnedContext.selectedModelName.trim().length > 0
          && isModelProvider(pinnedContext?.selectedModelProvider)
          ? pinnedContext.selectedModelName.trim()
          : actualModelConfig.modelName;

        // Emit done event to trace buffer
        if (!execution.cancelled) {
          onTrace({ type: 'done', data: response });
        }

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
        const wasCancelled = error.message === 'CANCELLED_BY_USER' || execution.cancelled;

        terminalStatus = wasCancelled ? 'stopped' : 'failed';
        execution.error = error.message;
        execution.finalAnswer = wasCancelled ? 'Stopped by user.' : `Agent Error: ${ error.message }`;
        execution.steeringQueue = [];
        // API failures (including exhausted/rate-limited keys) are terminal
        // immediately. Cleanup still runs below, but the registry must stop
        // advertising this execution as steerable while it is unwinding.
        execution.status = terminalStatus;
        execution.completedAt = execution.completedAt || Date.now();

        if (!wasCancelled) {
          // Check if it's an API key error — auto-failover
          const errorType = isExternalProvider ? 'unknown' : apiKeyPool.classifyError(error.message);
          if (errorType !== 'unknown') {
            console.warn(`[AgentRegistry] 🔄 API key failure (${ errorType }) for chat ${ chatId.substring(0, 8) }...`);
            apiKeyPool.reportFailure(chatId, errorType, error.message);
          }

          // Emit error to trace buffer.
          try {
            this.appendTrace(execution, { type: 'error', data: error.message }, !pinnedContext?.disableTaskStore);
          } catch { /* buffer push failed, ignore */ }

          console.error(`[AgentRegistry] ❌ Agent failed for chat ${ chatId.substring(0, 8) }...: ${ error.message.substring(0, 100) }`);
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
        if (terminalStatus !== 'stopped') {
          queueMicrotask(() => void this.startNextQueuedWork(chatId));
        }
      }
    })();

    const poolStatus = isExternalProvider ? null : apiKeyPool.getPoolStatus();
    console.log(`[AgentRegistry] Agent started for chat ${ chatId.substring(0, 8) }... | Model: ${ modelConfig.modelName }${ lease ? ` | Key: #${ lease.keyIndex } | Pool: ${ poolStatus?.healthySummary }` : '' }`);

    return { status: 'started', chatId, runId: execution.runId, message: lease ? `Agent started with key #${ lease.keyIndex }` : `Agent started with ${ modelConfig.label }` };
  }

  /**
   * Get traces for a chat, optionally after a specific index (incremental polling).
   */
  public getTraces(chatId: string, afterIndex: number = -1): {
    status: 'running' | 'completed' | 'failed' | 'stopped' | 'idle';
    traces: any[];
    totalTraces: number;
    maxIndex: number;
    finalAnswer: string;
    runId?: string;
    startedAt?: number;
    completedAt?: number;
    error?: string;
    pendingProxyTaskCount: number;
    pendingFollowUpCount: number;
    queuedFollowUps: QueuedUserFollowUpSummary[];
  } {
    const execution = this.executions.get(chatId);

    if (!execution) {
      return {
        status: 'idle',
        traces: [],
        totalTraces: 0,
        maxIndex: -1,
        finalAnswer: '',
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
    const newTraces = execution.traceBuffer.slice(start).map(trace => ({
      ...trace.data,
      timestamp: normalizeStreamTimestamp(trace.data?.timestamp, trace.timestamp),
      _traceIdx: trace.index,
    }));

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
      ? this.clearQueuedFollowUps(chatId)
      : 0;
    const cancelledQueuedTasks = !metadata?._autonomyProxy
      ? cancelPendingProxyTasks(chatId)
      : 0;
    if (!execution) return Boolean(expectedRunId) || cancelledQueuedTasks > 0 || cancelledQueuedFollowUps > 0;

    // Registry owns the whole run lifecycle. This must happen here (rather than
    // only in an HTTP route) so Proxy, Telegram, shutdown, and tests all stop the
    // same sub-agent tree.
    cancelAgent(execution.orchestratorProjectId || chatId);

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
      type: metadata?._autonomyProxy ? 'autonomy_proxy_status' : 'thought',
      phase: metadata?._autonomyProxy ? 'main_stopped' : undefined,
      text: metadata?._autonomyProxy ? `Proxy-Agent stopped Main: ${reason}` : '\n\n*Generation stopped by user.*',
      timestamp: Date.now(),
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
   * Also immediately emits a steering_received trace to the buffer so the UI
   * can show the user that their steering was acknowledged instantly.
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

    const trimmedMessage = message.trim().substring(0, 8000);
    if (!trimmedMessage) return false;
    const resolvedId = steeringId || `steer_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`;
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
      _autonomyProxy: isAutonomyProxy,
      source: steeringSource,
      steeringSource,
      ownerChatId: execution.chatId,
      runId: execution.runId,
      turnId: execution.runId,
    };
    if (execution.steeringQueue.length >= MAX_STEERING_QUEUE) {
      console.warn(`[AgentRegistry] Steering queue full for chat ${ chatId.substring(0, 8) }...; rejecting new guidance so the client can retain it.`);
      return false;
    }
    const queuedMessage: SteeringMessage = {
      id: resolvedId,
      text: trimmedMessage,
      createdAt: Date.now(),
      metadata: normalizedMetadata,
    };
    execution.acceptedSteeringIds.add(resolvedId);
    execution.steeringQueue.push(queuedMessage);
    // Completion-boundary Proxy guidance is revealed when it is applied on
    // the next loop boundary. Emitting it here would place the Proxy message
    // before the fully generated answer checkpoint and make that answer appear
    // to vanish. Human guidance is acknowledged here; Proxy guidance becomes
    // a real user turn only when it is actually injected into Main.
    if (normalizedMetadata.completionReview !== true && !isAutonomyProxy) {
      this.appendTrace(execution, {
        type: 'steering_received',
        text: trimmedMessage,
        steeringId: queuedMessage.id,
        steeringIds: [queuedMessage.id],
        timestamp: Date.now(),
        ...normalizedMetadata,
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
    const messages = [...execution.steeringQueue];
    execution.steeringQueue = [];
    return messages;
  }

  /** Atomically drains all pending guidance at a safe model boundary. */
  public drainSteeringQueue(chatId: string): SteeringMessage[] {
    return this.getAndClearSteeringQueue(chatId);
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
    action: 'pause' | 'resume' | 'intervention' | 'model',
    value?: ProxyInterventionLevel | string,
  ): boolean {
    const execution = this.findExecution(chatId);
    const projectId = execution?.orchestratorProjectId || chatId;
    if (action === 'pause') {
      updateProxyControl(chatId, { enabled: false });
      pauseUserProxyRuntime(projectId);
      return true;
    }
    if (action === 'resume') {
      updateProxyControl(chatId, { enabled: true });
      resumeUserProxyRuntime(projectId);
      return true;
    }
    if (action === 'intervention') {
      const level = value as ProxyInterventionLevel;
      updateProxyControl(chatId, { intervention: level });
      const appliedToLiveRuntime = setUserProxyIntervention(projectId, level);
      return execution?.status === 'running' ? appliedToLiveRuntime : true;
    }

    const selection = String(value || 'auto');
    updateProxyControl(chatId, { modelSelection: selection });
    if (!execution) return true;
    const runtimeSettings = execution.launchSpec.runtimeSettings || buildScopedRuntimeSettings();
    const parts = selection.includes(':') ? selection.split(':') : [];
    const provider = isModelProvider(parts[0]) ? parts[0] : getMainAgentModelConfig(execution.mode, runtimeSettings).provider;
    const modelId = parts.slice(1).join(':').trim();
    const settings = modelId
      ? { ...runtimeSettings, modelOverrides: { ...runtimeSettings.modelOverrides, [provider]: modelId } }
      : runtimeSettings;
    setUserProxyModel(projectId, {
      mode: MODEL_PROVIDER_MODE[provider],
      apiKey: getScopedRuntimeApiKey(settings, provider),
      runtimeSettings: settings,
    });
    return true;
  }

  public getQueuedFollowUps(chatId: string): QueuedUserFollowUpSummary[] {
    return (this.userFollowUpQueues.get(chatId) || []).map(item => ({
      id: item.id,
      runId: item.runId,
      chatId: item.chatId,
      text: item.prompt,
      createdAt: item.createdAt,
      attachmentCount: item.mediaAttachments.length,
    }));
  }

  public queueUserFollowUp(
    chatId: string,
    prompt: string,
    mediaAttachments: any[] = [],
    requestedId?: string,
  ): {
    accepted: boolean;
    status: 'queued' | 'starting' | 'not_found' | 'queue_full';
    item?: QueuedUserFollowUpSummary;
    message: string;
  } {
    const priorReceipt = this.userFollowUpReceipts.get(chatId)?.get(requestedId || '');
    if (priorReceipt) {
      return {
        accepted: true,
        status: 'queued',
        item: priorReceipt,
        message: 'Follow-up was already accepted.',
      };
    }
    const execution = this.executions.get(chatId);
    if (!execution) {
      return { accepted: false, status: 'not_found', message: 'No agent run exists for this chat.' };
    }
    if (execution.status === 'stopped' || execution.cancelled) {
      return { accepted: false, status: 'not_found', message: 'The run was stopped, so the follow-up was not queued.' };
    }

    const queue = this.userFollowUpQueues.get(chatId) || [];
    const id = requestedId || randomUUID();
    const duplicate = queue.find(item => item.id === id);
    if (duplicate) {
      const item = this.getQueuedFollowUps(chatId).find(entry => entry.id === duplicate.id);
      return { accepted: true, status: 'queued', item, message: 'Follow-up was already queued.' };
    }
    if (queue.length >= MAX_USER_FOLLOW_UP_QUEUE) {
      return { accepted: false, status: 'queue_full', message: 'The follow-up queue is full.' };
    }

    const item: QueuedUserFollowUp = {
      id,
      runId: `queued_${randomUUID()}`,
      chatId,
      prompt: String(prompt || '').trim().substring(0, 50_000),
      mediaAttachments: Array.isArray(mediaAttachments) ? [...mediaAttachments] : [],
      createdAt: Date.now(),
    };
    queue.push(item);
    this.userFollowUpQueues.set(chatId, queue);

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
      message: execution.settled ? 'Follow-up is starting.' : 'Follow-up queued after the active run.',
    };
  }

  public removeQueuedFollowUp(chatId: string, id: string): boolean {
    const queue = this.userFollowUpQueues.get(chatId);
    if (!queue) return false;
    const next = queue.filter(item => item.id !== id);
    if (next.length === queue.length) return false;
    if (next.length > 0) this.userFollowUpQueues.set(chatId, next);
    else this.userFollowUpQueues.delete(chatId);
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
    }
    const execution = this.executions.get(chatId);
    if (!execution || execution.settled) queueMicrotask(() => void this.startNextQueuedWork(chatId));
    return true;
  }

  public clearQueuedFollowUps(chatId: string): number {
    const count = this.userFollowUpQueues.get(chatId)?.length || 0;
    this.userFollowUpQueues.delete(chatId);
    return count;
  }

  private async startNextQueuedWork(chatId: string): Promise<void> {
    const current = this.executions.get(chatId);
    if (current && (current.status === 'running' || !current.settled)) return;

    const queue = this.userFollowUpQueues.get(chatId);
    const next = queue?.[0];
    if (next) {
      const runtimeSettings = current?.launchSpec.runtimeSettings || buildScopedRuntimeSettings();
      const history = current ? [...current.launchSpec.history] : [];
      if (current) {
        history.push({ role: 'user', parts: [{ text: getVisibleRunPrompt(current.prompt) }] });
        if (current.finalAnswer) history.push({ role: 'model', parts: [{ text: current.finalAnswer }] });
      }

      const result = this.startAgent(
        chatId,
        next.prompt || 'Please review the attached file or media and help me with it.',
        history.slice(-24),
        current?.launchSpec.mode || 'think',
        current?.launchSpec.userId || 'default_user',
        current?.launchSpec.pinnedContext || {},
        next.mediaAttachments,
        current?.launchSpec.userName || 'Developer',
        runtimeSettings.preferredGeminiApiKey,
        runtimeSettings,
        next.runId,
      );
      if (result.status === 'started') {
        queue!.shift();
        if (queue!.length === 0) this.userFollowUpQueues.delete(chatId);
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
    options: { dependency?: string; supersedesTaskId?: string } = {},
  ): {
    accepted: boolean;
    status: 'pending' | 'starting' | 'failed';
    id: string;
    error?: string;
  } {
    const task = enqueueProxyTask(chatId, prompt, rationale, options);
    const execution = this.findExecution(chatId);
    const running = execution?.status === 'running' || (execution && !execution.settled);
    // Start the handoff in the current event-loop turn. An unref'ed timer can
    // be abandoned when the route/request scope goes idle, leaving a task
    // permanently marked pending even though Proxy Manager reported "starting".
    if (!running) {
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
    return { accepted: true, status: running ? 'pending' : 'starting', id: task.id };
  }

  private async startNextProxyTask(chatId: string): Promise<void> {
    const current = this.findExecution(chatId);
    if (current && (current.status === 'running' || !current.settled)) return;
    const task = claimNextProxyTask(chatId);
    if (!task) return;

    const control = readProxyControl(chatId);
    const runtimeSettings = current?.launchSpec.runtimeSettings || buildScopedRuntimeSettings();
    const priorHistory = current
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
      agentRuntime: 'autonomy_v1',
      autonomy: {
        ...(basePinned.autonomy || {}),
        enabled: control.enabled,
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
      current?.launchSpec.mode || 'think',
      current?.launchSpec.userId || 'default_user',
      pinnedContext,
      [],
      current?.launchSpec.userName || 'Developer',
      runtimeSettings.preferredGeminiApiKey,
      runtimeSettings,
    );
    settleProxyTask(chatId, task.id, result.status === 'started'
      ? { status: 'started', runId: result.runId }
      : { status: 'failed', error: result.message });
  }

  public getProxyManagerContext(chatId: string): Record<string, any> {
    const execution = this.findExecution(chatId);
    const projectId = execution?.orchestratorProjectId || chatId;
    const proxyControl = readProxyControl(chatId);
    const proxySnapshot = getUserProxyManagerSnapshot(projectId);
    if (proxySnapshot) proxySnapshot.interventionLevel = proxyControl.intervention;
    const visibleTypes = new Set(['task_plan', 'plan', 'work_note', 'tool_call', 'tool_result', 'tool_result_preview', 'file_preview', 'evidence', 'error', 'steering_received', 'steering_applied', 'autonomy_proxy_status', 'sub_agent_spawn', 'sub_agent_complete', 'sub_agent_error', 'inter_agent_message', 'answer', 'done']);
    const activity = (execution?.traceBuffer || [])
      .map(entry => ({ ...entry.data, timestamp: entry.timestamp }))
      .filter(trace => visibleTypes.has(String(trace?.type || '')))
      .slice(-36)
      .map(trace => {
        const delegation = delegationTelemetryFromTrace(trace);
        return {
          type: String(trace.type || ''),
          text: String(delegation?.summary || trace.text || trace.data || trace.output || trace.result || trace.error || '').replace(/\s+/g, ' ').trim().slice(0, 2400),
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
      if (tool.name === 'experience_signal') continue;
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
  public stopAll(): void {
    cancelAllSubAgents();
    this.userFollowUpQueues.clear();
    this.pendingRunCancellations.clear();
    for (const [chatId, execution] of this.executions.entries()) {
      if (execution.status === 'running') {
        execution.cancelled = true;
        execution.abortController.abort(new Error('CANCELLED_BY_USER'));
        execution.status = 'stopped';
        execution.completedAt = Date.now();
        execution.steeringQueue = [];
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
  existingAgentRegistry.getLifecycleVersion() === 3
    ? existingAgentRegistry
    : (globalForAgentRegistry.__eterxAgentRegistry = new AgentRegistry());
