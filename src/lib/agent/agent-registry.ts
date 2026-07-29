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
import { cancelAgent, cancelAllSubAgents, clearCancelState, globalSubAgentSpawner } from './roles/sub_agent';
import { normalizeAttachmentMime } from './attachment-pipeline';

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
const MAX_COMPLETED_EXECUTIONS = 30;
const TRACE_COMPACTION_GRACE_MS = 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Cleanup completed agents frequently
const TASK_STORE_CLEANUP_INTERVAL = 15 * 60 * 1000;
const MAX_COMPLETED_AGE = 2 * 60 * 60 * 1000; // 2 hours max retention for completed agents

class AgentRegistry {
  private executions: Map<string, AgentExecution> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private lastTaskStoreCleanupAt = 0;

  private findExecution(runtimeId: string): AgentExecution | undefined {
    const direct = this.executions.get(runtimeId);
    if (direct) return direct;
    for (const execution of this.executions.values()) {
      if (execution.orchestratorProjectId === runtimeId) return execution;
    }
    return undefined;
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
      const { output, ...rest } = data;
      const outputText = String(output || '');
      return {
        ...rest,
        output: outputText.length > 2500 ? `${ outputText.substring(0, 2500) }\n...[output compacted]` : outputText,
        _contentStripped: outputText.length > 2500,
      };
    }

    if ((data.type === 'thought_stream' || data.type === 'work_note') && typeof data.text === 'string' && data.text.length > 12000) {
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
    const entry: TraceEvent = {
      index: execution.traceCounter++,
      timestamp: now,
      data: traceEvent,
    };

    execution.traceBuffer.push(entry);
    if (now - execution.lastMemorySampleAt >= 1000) {
      execution.lastMemorySampleAt = now;
      execution.peakMemoryMB = Math.max(execution.peakMemoryMB || 0, this.getProcessMemoryMB());
    }

    if (traceEvent?.type === 'tool_call' || traceEvent?.type === 'action') {
      execution.toolCallCount++;
    }

    if (traceEvent?.complexity) {
      execution.complexity = traceEvent.complexity;
    }

    if (execution.traceBuffer.length > MAX_TRACE_BUFFER) {
      execution.traceBuffer = execution.traceBuffer.slice(-MAX_TRACE_BUFFER);
    }

    if (persistToTaskStore) {
      const compactTrace = this.compactTracePayload(traceEvent);
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
  ): { status: 'started' | 'already_running' | 'no_keys'; chatId: string; runId?: string; message: string } {

    // Check if this chat already has a running agent
    const existing = this.executions.get(chatId);
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

    const modelConfig = getMainAgentModelConfig(mode, runtimeSettings);
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
      // Execution metrics
      toolCallCount: 0,
      effectiveModel: pinnedContext?.strictModelSelection === true && typeof pinnedContext?.selectedModelName === 'string'
        ? pinnedContext.selectedModelName
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
      writeRuntimeTrace('agent_trace', {
        chatId,
        event: traceEvent,
      });
      // Check per-chat cancellation
      if (execution.cancelled) {
        return;
      }
      const currentExecution = this.executions.get(chatId);
      if (currentExecution && currentExecution !== execution) return;

      // Enrich custom agent traces
      if (pinnedContext?.agentRuntime === 'custom_agent' && pinnedContext?.customAgentId) {
        if (traceEvent && typeof traceEvent === 'object') {
          traceEvent.customAgentId = pinnedContext.customAgentId;
          traceEvent.agentName = 'Main';
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
        : prompt,
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

        const GEMINI_NATIVE_MIMES = new Set([
          'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
          'application/pdf', 'application/json',
          'text/plain', 'text/html', 'text/css', 'text/xml', 'text/csv', 'text/rtf', 'text/javascript',
          'audio/mp3', 'audio/wav', 'audio/mpeg', 'audio/ogg',
          'video/mp4', 'video/mpeg', 'video/webm', 'video/mov',
        ]);

        const workspaceTemp = path.resolve(process.cwd(), '.workspaces', 'temp');
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

        const safeChatTempName = (value: string) => {
          const cleaned = String(value || 'chat')
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 120);
          return cleaned || 'chat';
        };

        const mediaFiles: { path: string, mimeType: string, name: string, fileUri?: string }[] = [];
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
              mediaFiles.push({ path: destPath, mimeType, name: safeName });
            } else if (att.data || att.inlineData) {
              const b64 = att.data || (att.inlineData?.data) || att.inlineData;
              if (typeof b64 === 'string') {
                const safeName = getRunScopedMediaName(att, attachmentIndex);
                const destPath = resolveUnder(workspaceTemp, safeName);
                await fs.writeFile(destPath, Buffer.from(b64, 'base64'));
                mediaFiles.push({ path: destPath, mimeType, name: safeName });
              }
            } else if (att.fileUri) {
              const safeName = getRunScopedMediaName(att, attachmentIndex, att.path);
              const destPath = resolveUnder(workspaceTemp, safeName);
              if (att.path) {
                try { await fs.copyFile(att.path, destPath); } catch { }
              }
              const filePath = await fs.pathExists(destPath) ? destPath : (att.path || destPath);
              if (await fs.pathExists(filePath)) {
                mediaFiles.push({ path: filePath, mimeType, name: safeName });
              }
            }
          }
        }

        const preUploadedFiles = mediaFiles.filter(f => f.fileUri);
        const needsUploadFiles = mediaFiles.filter(f => !f.fileUri && GEMINI_NATIVE_MIMES.has(f.mimeType));
        const currentGeminiNativeFiles = [...preUploadedFiles, ...needsUploadFiles];
        const textFallbackFiles = mediaFiles.filter(file =>
          !file.fileUri && !GEMINI_NATIVE_MIMES.has(file.mimeType),
        );

        // Media attachments are current-turn only. Re-attaching earlier images
        // makes the model see stale screenshots/photos on unrelated later turns.
        const visualMemoryPath = resolveUnder(workspaceTemp, `${ safeChatTempName(chatId) }_visual_memory.json`);
        let geminiNativeFiles = [...currentGeminiNativeFiles];
        try {
          await fs.remove(visualMemoryPath);
        } catch (e: any) {
          console.warn(`[AgentRegistry] Could not clear stale visual memory: ${ e?.message || e }`);
        }
        if (currentGeminiNativeFiles.length > 0) {
          console.log(`[AgentRegistry] Media context: ${ currentGeminiNativeFiles.length } current attachment(s), 0 recalled`);
        }

        // ═══════════════════════════════════════════════════════════
        // Documents that require the Gemini Files API are uploaded with the
        // leased key. Images stay on their real local path and are attached
        // inline by Agent in the same generateContent request.
        // ═══════════════════════════════════════════════════════════
        const uploadedImageParts: { fileData: { fileUri: string, mimeType: string } }[] = [];
        if (!isExternalProvider) {
          const geminiAI = new (require('@google/genai').GoogleGenAI)({ apiKey: lease!.apiKey });
        for (const file of geminiNativeFiles) {
          try {
            const isImage = String(file.mimeType || '').startsWith('image/');
            if (isImage) continue;

            // If the file has a URI from VISUAL MEMORY (previously uploaded with this key ecosystem), reuse it
            if (file.fileUri && !currentGeminiNativeFiles.some(f => f.name === file.name)) {
              uploadedImageParts.push({ fileData: { fileUri: file.fileUri, mimeType: file.mimeType } });
              console.log(`[AgentRegistry] 👁️ Recalled from visual memory: ${ file.name }`);
              continue;
            }

            // ALWAYS fresh upload for NEW files using the LEASED key (prevents cross-key 403)
            if (!await fs.pathExists(file.path)) {
              console.warn(`[AgentRegistry] ⚠️ File not found for upload: ${ file.path }`);
              continue;
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
            }
          } catch (uploadErr: any) {
            console.warn(`[AgentRegistry] ⚠️ Upload failed for ${ file.name }: ${ uploadErr.message?.substring(0, 100) }`);
          }
        }
        }

        // Do not persist Files API media URIs between turns. Gemini file URIs are
        // key scoped, and automatic reuse pollutes future prompts with old images.

        // Build enriched prompt with file context
        let enrichedPrompt = '';
        if (geminiNativeFiles.length > 0) {
          const fileList = geminiNativeFiles.map(f => `  • ${ f.name } (${ f.mimeType })${ f.fileUri ? ' [UPLOADED ✓]' : '' }`).join('\n');
          enrichedPrompt += isExternalProvider
            ? `[USER ATTACHED FILES]\nThe following files are saved locally for this run:\n${ fileList }\n\nIMPORTANT: These files are available at their local paths in .workspaces/temp/. Use workspace tools to inspect/read them when needed. Do not claim direct visual access unless a tool result proves it.\n\n`
            : `[USER ATTACHED FILES]\nThe following files are loaded into your visual context:\n${ fileList }\n\nIMPORTANT: These files (especially images) are directly visible to you in this message. You can see and analyze them. Describe what you see when the user asks about them. Files also persist at .workspaces/temp/ for re-reading.\n\n`;
        }
        // If images are present, add explicit analysis instruction
        const attachedImageCount = geminiNativeFiles.filter(f => String(f.mimeType || '').startsWith('image/')).length;
        if (!isExternalProvider && (uploadedImageParts.length > 0 || attachedImageCount > 0)) {
          const imageCount = attachedImageCount || uploadedImageParts.length;
          enrichedPrompt += `[MULTIMODAL CONTEXT] ${ imageCount } image(s) are attached to this message. You CAN see them. When the user asks about an image, analyze it thoroughly — describe content, colors, text, layout, objects, people, code, UI elements, or anything visible. Do NOT say you cannot see images. You are a multimodal model with full vision capability.\n\n`;
        }

        for (const file of textFallbackFiles) {
          enrichedPrompt += `[Attached file: ${ file.name } (${ file.mimeType })] — real file available at ${ file.path }. Read it on demand with workspace file tools; do not inline or duplicate the entire file unless the user explicitly requests extraction.\n\n`;
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
          fallbackMode: mode,
          fallbackApiKey: isExternalProvider ? projectId : (proxyLease?.apiKey || lease?.apiKey || ''),
          fallbackRuntimeSettings: runtimeSettings,
          history,
          attachments: mediaAttachments,
          onTrace,
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
        const response = await orchestrator.executePipeline(
          userId,
          projectId,
          enrichedPrompt,
          history,
          onTrace,
          mode,
          { ...(pinnedContext || {}), abortSignal: execution.abortController.signal },
          geminiNativeFiles,
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

        // Update effective model with the model mode resolved by the orchestrator!
        const actualModelConfig = getMainAgentModelConfig(response.modelMode, runtimeSettings);
        execution.effectiveModel = pinnedContext?.strictModelSelection === true && typeof pinnedContext?.selectedModelName === 'string'
          ? pinnedContext.selectedModelName
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
          queueMicrotask(() => void this.startNextProxyTask(chatId));
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
      timestamp: trace.timestamp,
      ...trace.data,
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
    if (expectedRunId && execution?.runId !== expectedRunId) return false;
    const cancelledQueuedTasks = !metadata?._autonomyProxy
      ? cancelPendingProxyTasks(chatId)
      : 0;
    if (!execution) return cancelledQueuedTasks > 0;

    // Registry owns the whole run lifecycle. This must happen here (rather than
    // only in an HTTP route) so Proxy, Telegram, shutdown, and tests all stop the
    // same sub-agent tree.
    cancelAgent(execution.orchestratorProjectId || chatId);

    // Already stopped/completed/failed — idempotent, don't re-process
    if (execution.status !== 'running') {
      // Still set cancel flag in case sub-agents are lingering
      execution.cancelled = true;
      return cancelledQueuedTasks > 0;
    }

    execution.cancelled = true;
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
    const execution = this.findExecution(chatId);
    if (!execution || execution.status !== 'running') return false;
    if (expectedRunId && execution.runId !== expectedRunId) return false;

    const trimmedMessage = message.trim().substring(0, 8000);
    if (!trimmedMessage) return false;
    const resolvedId = steeringId || `steer_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`;
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
    const duplicate = execution.steeringQueue.find(item => item.id === resolvedId);
    if (duplicate) {
      duplicate.text = trimmedMessage;
      duplicate.updatedAt = Date.now();
      duplicate.metadata = normalizedMetadata;
      return true;
    }
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
    if (!execution || execution.steeringQueue.length === 0) return [];
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
    if (!execution || count <= 0) return;
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
    const visibleTypes = new Set(['task_plan', 'plan', 'work_note', 'tool_call', 'tool_result', 'file_preview', 'evidence', 'error', 'steering_received', 'steering_applied', 'autonomy_proxy_status', 'answer', 'done']);
    const activity = (execution?.traceBuffer || [])
      .map(entry => ({ ...entry.data, timestamp: entry.timestamp }))
      .filter(trace => visibleTypes.has(String(trace?.type || '')))
      .slice(-36)
      .map(trace => ({
        type: String(trace.type || ''),
        text: String(trace.text || trace.data || trace.output || trace.error || '').replace(/\s+/g, ' ').trim().slice(0, 1400),
        tool: String(trace.tool || trace.toolName || trace.name || '').slice(0, 120),
        success: trace.success,
        phase: trace.phase,
        timestamp: trace.timestamp,
      }));
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

    for (const [chatId, execution] of this.executions.entries()) {
      if (execution.status !== 'running' && execution.completedAt) {
        this.compactExecutionForRetention(execution);
        completedExecutions.push([chatId, execution]);

        if (now - execution.completedAt > MAX_COMPLETED_AGE) {
          this.executions.delete(chatId);
          cleaned++;
        }
      }
    }

    const retainedCompleted = completedExecutions
      .filter(([chatId]) => this.executions.has(chatId))
      .sort((a, b) => (a[1].completedAt || 0) - (b[1].completedAt || 0));

    while (retainedCompleted.length > MAX_COMPLETED_EXECUTIONS) {
      const [chatId] = retainedCompleted.shift()!;
      this.executions.delete(chatId);
      cleaned++;
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
    for (const [chatId, execution] of this.executions.entries()) {
      if (execution.status === 'running') {
        execution.cancelled = true;
        execution.abortController.abort(new Error('CANCELLED_BY_USER'));
        execution.status = 'stopped';
        execution.completedAt = Date.now();
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

export const agentRegistry =
  globalForAgentRegistry.__eterxAgentRegistry ||
  (globalForAgentRegistry.__eterxAgentRegistry = new AgentRegistry());
