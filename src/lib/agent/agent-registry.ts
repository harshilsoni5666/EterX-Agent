import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'crypto';
import { AgentOrchestrator } from './orchestrator';
import { apiKeyPool, type KeyLease } from './api-key-pool';
import { taskStore } from './task-store';
import { getMainAgentModelConfig, type MainAgentMode } from './model-routing';
import type { ScopedRuntimeSettings } from './runtime-api-keys';
import { flushLedgerForChat } from './memory/conversation-ledger';
import { observeUserProxy, startUserProxyRuntime, stopUserProxyRuntime, pauseUserProxyRuntime, resumeUserProxyRuntime, setUserProxyIntervention, type ProxyInterventionLevel } from './autonomy/user-proxy-runtime';

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
  promise: Promise<void>;      // The running execution
  keyLeaseId: string;          // API key lease identifier
  steeringQueue: SteeringMessage[]; // Live steering messages from user mid-run
  mode: MainAgentMode;
  // === EXECUTION METRICS (new) ===
  toolCallCount: number;       // Total tool calls in this execution
  effectiveModel: string;      // Actual model used (may differ from mode due to smart routing)
  complexity: string;          // Task complexity classification
  peakMemoryMB: number;        // Peak memory usage during execution
  retentionCompacted?: boolean;
  orchestratorProjectId?: string;
}

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
      const existingIdx = traceEvent.ownerTraceId
        ? execution.traceBuffer.findIndex(entry =>
          entry.data?.type === 'file_preview' &&
          entry.data?.ownerTraceId === traceEvent.ownerTraceId
        )
        : traceEvent.filepath && traceEvent.dedupe !== false
          ? execution.traceBuffer.findIndex(entry =>
            entry.data?.type === 'file_preview' &&
            entry.data?.filepath === traceEvent.filepath &&
            entry.data?.dedupe !== false
          )
          : -1;
      if (existingIdx >= 0) execution.traceBuffer.splice(existingIdx, 1);
    }

    const entry: TraceEvent = {
      index: execution.traceCounter++,
      timestamp: Date.now(),
      data: traceEvent,
    };

    execution.traceBuffer.push(entry);
    execution.peakMemoryMB = Math.max(execution.peakMemoryMB || 0, this.getProcessMemoryMB());

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
          : compactTrace
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
    if (existing && existing.status === 'running') {
      return { status: 'already_running', chatId, runId: existing.runId, message: 'Agent is already running for this chat' };
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
      keyLeaseId: isExternalProvider ? modelConfig.provider : chatId,
      mode,
      promise: Promise.resolve(), // Placeholder, replaced below
      steeringQueue: [],
      // Execution metrics
      toolCallCount: 0,
      effectiveModel: modelConfig.modelName,
      complexity: 'unknown',
      peakMemoryMB: 0,
    };

    // Build the trace callback that writes to the buffer
    const onTrace = (traceEvent: any) => {
      // Check per-chat cancellation
      if (execution.cancelled) {
        return;
      }

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
      try {
        // Create a dedicated orchestrator for this chat
        const orchestrator = new AgentOrchestrator();

        // Pre-process media (same logic as chat route)
        const fs = require('fs');
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
        if (hasMediaAttachments && !fs.existsSync(workspaceTemp)) fs.mkdirSync(workspaceTemp, { recursive: true });

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
            const mimeType = att.mimeType || 'application/octet-stream';

            if (att.path && fs.existsSync(att.path)) {
              const sourcePath = path.resolve(att.path);
              const safeName = getRunScopedMediaName(att, attachmentIndex, sourcePath);
              const destPath = isInsideWorkspaceTemp(sourcePath) ? sourcePath : resolveUnder(workspaceTemp, safeName);

              if (sourcePath !== destPath) {
                fs.copyFileSync(sourcePath, destPath);
              }
              mediaFiles.push({ path: destPath, mimeType, name: safeName });
            } else if (att.data || att.inlineData) {
              const b64 = att.data || (att.inlineData?.data) || att.inlineData;
              if (typeof b64 === 'string') {
                const safeName = getRunScopedMediaName(att, attachmentIndex);
                const destPath = resolveUnder(workspaceTemp, safeName);
                fs.writeFileSync(destPath, Buffer.from(b64, 'base64'));
                mediaFiles.push({ path: destPath, mimeType, name: safeName });
              }
            } else if (att.fileUri) {
              const safeName = getRunScopedMediaName(att, attachmentIndex, att.path);
              const destPath = resolveUnder(workspaceTemp, safeName);
              if (att.path) {
                try { fs.copyFileSync(att.path, destPath); } catch { }
              }
              const filePath = fs.existsSync(destPath) ? destPath : (att.path || destPath);
              if (fs.existsSync(filePath)) {
                mediaFiles.push({ path: filePath, mimeType, name: safeName });
              }
            }
          }
        }

        const preUploadedFiles = mediaFiles.filter(f => f.fileUri);
        const needsUploadFiles = mediaFiles.filter(f => !f.fileUri && GEMINI_NATIVE_MIMES.has(f.mimeType));
        const currentGeminiNativeFiles = [...preUploadedFiles, ...needsUploadFiles];
        const textFallbackFiles = mediaFiles.filter(f => !f.fileUri && !GEMINI_NATIVE_MIMES.has(f.mimeType));

        // Media attachments are current-turn only. Re-attaching earlier images
        // makes the model see stale screenshots/photos on unrelated later turns.
        const visualMemoryPath = resolveUnder(workspaceTemp, `${ safeChatTempName(chatId) }_visual_memory.json`);
        let geminiNativeFiles = [...currentGeminiNativeFiles];
        try {
          if (fs.existsSync(visualMemoryPath)) fs.unlinkSync(visualMemoryPath);
        } catch (e: any) {
          console.warn(`[AgentRegistry] Could not clear stale visual memory: ${ e?.message || e }`);
        }
        if (currentGeminiNativeFiles.length > 0) {
          console.log(`[AgentRegistry] Media context: ${ currentGeminiNativeFiles.length } current attachment(s), 0 recalled`);
        }

        // ═══════════════════════════════════════════════════════════
        // Upload Gemini-native media with the same leased key used by the model call.
        // This keeps the renderer fast and avoids base64 payloads in the chat input.
        // ═══════════════════════════════════════════════════════════
        const uploadedImageParts: { fileData: { fileUri: string, mimeType: string } }[] = [];
        let hasNewImages = false;

        if (!isExternalProvider) {
          const geminiAI = new (require('@google/genai').GoogleGenAI)({ apiKey: lease!.apiKey });
        for (const file of geminiNativeFiles) {
          try {
            const isImage = String(file.mimeType || '').startsWith('image/');

            // If the file has a URI from VISUAL MEMORY (previously uploaded with this key ecosystem), reuse it
            if (file.fileUri && !currentGeminiNativeFiles.some(f => f.name === file.name)) {
              uploadedImageParts.push({ fileData: { fileUri: file.fileUri, mimeType: file.mimeType } });
              console.log(`[AgentRegistry] 👁️ Recalled from visual memory: ${ file.name }`);
              continue;
            }

            // ALWAYS fresh upload for NEW files using the LEASED key (prevents cross-key 403)
            if (!fs.existsSync(file.path)) {
              console.warn(`[AgentRegistry] ⚠️ File not found for upload: ${ file.path }`);
              continue;
            }

            console.log(`[AgentRegistry] Preparing media via Files API: ${ file.name } (${ file.mimeType })`);
            onTrace({ type: 'progress', text: `Preparing ${ isImage ? 'image' : 'file' }`, percent: 8 });
            const uploadResult = await geminiAI.files.upload({
              file: file.path,
              config: { mimeType: file.mimeType }
            });

            if (uploadResult && uploadResult.uri) {
              file.fileUri = uploadResult.uri; // Save URI back to the object
              uploadedImageParts.push({ fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType || file.mimeType } });
              hasNewImages = file.mimeType.startsWith('image/') || hasNewImages;
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

        const TEXT_EXTS = new Set([
          '.txt', '.md', '.json', '.csv', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h',
          '.html', '.css', '.xml', '.yaml', '.yml', '.env', '.log', '.ini', '.cfg', '.sh', '.bat', '.ps1',
          '.sql', '.rb', '.go', '.rs', '.php', '.swift', '.kt', '.r', '.m', '.lua', '.toml', '.conf',
          '.gitignore', '.dockerignore', '.editorconfig', '.prettierrc', '.eslintrc',
        ]);

        for (const file of textFallbackFiles) {
          try {
            const ext = path.extname(file.name).toLowerCase();
            if (ext === '.pdf') {
              try {
                const pdfParse = require('pdf-parse');
                const dataBuffer = fs.readFileSync(file.path);
                const data = await pdfParse(dataBuffer);
                enrichedPrompt += `[Attached PDF: ${ file.name }]\n\`\`\`\n${ (data.text || '').slice(0, 50000) }\n\`\`\`\n\n`;
              } catch { enrichedPrompt += `[Attached PDF: ${ file.name }] — use parse_pdf tool\n\n`; }
            } else if (ext === '.docx') {
              try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(file.path);
                const entry = zip.getEntry('word/document.xml');
                const xml = entry ? entry.getData().toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50000) : '[Could not read]';
                enrichedPrompt += `[Attached DOCX: ${ file.name }]\n\`\`\`\n${ xml }\n\`\`\`\n\n`;
              } catch { enrichedPrompt += `[Attached DOCX: ${ file.name }] — saved at ${ file.path }\n\n`; }
            } else if (TEXT_EXTS.has(ext) || file.mimeType.startsWith('text/')) {
              const content = fs.readFileSync(file.path, 'utf-8').slice(0, 50000);
              enrichedPrompt += `[Attached File: ${ file.name }]\n\`\`\`\n${ content }\n\`\`\`\n\n`;
            } else {
              enrichedPrompt += `[Attached File: ${ file.name }] — saved at ${ file.path }\n\n`;
            }
          } catch {
            enrichedPrompt += `[Attached File: ${ file.name }] — saved at ${ file.path }\n\n`;
          }
        }

        enrichedPrompt += `[USER REQUEST]\n${ prompt }`;

        // Create TaskStore entry
        if (!pinnedContext?.disableTaskStore) {
          await taskStore.createTask(chatId, prompt, execution.runId);
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
        startUserProxyRuntime({
          context: {
            ...(pinnedContext || {}),
            projectId,
            selectedModelMode: mode,
          } as any,
          objective: prompt,
          mode,
          apiKey: isExternalProvider ? projectId : (proxyLease?.apiKey || lease?.apiKey || ''),
          runtimeSettings,
          history,
          attachments: mediaAttachments,
          onTrace,
          steer: (message, metadata) => this.addSteeringMessage(chatId, message, undefined, metadata),
        });
        const response = await orchestrator.executePipeline(
          userId,
          projectId,
          enrichedPrompt,
          history,
          onTrace,
          mode,
          pinnedContext,
          geminiNativeFiles,
          uploadedImageParts, // Files API parts instead of base64
          userName,
          isExternalProvider ? undefined : lease!.apiKey,
          runtimeSettings
        );

        const responseText = response.finalAnswer || '';
        const wasCancelledByResponse = execution.cancelled || responseText === 'Stopped by user.';
        const responseFailed = response.success === false || /^Agent (Execution Failed|Error):/i.test(responseText);

        execution.status = wasCancelledByResponse ? 'stopped' : responseFailed ? 'failed' : 'completed';
        execution.completedAt = Date.now();
        execution.finalAnswer = responseText;
        if (responseFailed) execution.error = responseText;

        // Update effective model with the model mode resolved by the orchestrator!
        const actualModelConfig = getMainAgentModelConfig(response.modelMode, runtimeSettings);
        execution.effectiveModel = actualModelConfig.modelName;

        // Emit done event to trace buffer
        if (!execution.cancelled) {
          onTrace({ type: 'done', data: response });
        }

        // Persist to TaskStore
        if (!pinnedContext?.disableTaskStore) {
          await taskStore.completeTask(chatId, execution.finalAnswer, execution.status === 'completed', execution.status);
        }

        // Report success to key pool
        if (!isExternalProvider && execution.status === 'completed') {
          apiKeyPool.reportSuccess(chatId, (response as any).effectiveApiKey);
        }

        console.log(`[AgentRegistry] ${ execution.status === 'completed' ? '✅ Agent completed' : execution.status === 'stopped' ? '🛑 Agent stopped' : '❌ Agent failed' } for chat ${ chatId.substring(0, 8) }... in ${ ((Date.now() - execution.startedAt) / 1000).toFixed(1) }s`);

      } catch (error: any) {
        const wasCancelled = error.message === 'CANCELLED_BY_USER' || execution.cancelled;

        execution.status = wasCancelled ? 'stopped' : 'failed';
        execution.completedAt = Date.now();
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
          if (execution.status === 'stopped') {
            await taskStore.stopTask(chatId, execution.finalAnswer).catch(() => { });
          } else {
            await taskStore.completeTask(chatId, execution.finalAnswer, false, execution.status).catch(() => { });
          }
        }

      } finally {
        if (execution.orchestratorProjectId) stopUserProxyRuntime(execution.orchestratorProjectId);
        // ALWAYS release ALL keys associated with this chat (main agent + ANY dynamically named sub-agents)
        if (!isExternalProvider) apiKeyPool.releaseKey(chatId);
        apiKeyPool.releaseLeasesWithPrefix(`${ chatId }_sub_`);

        // Flush ledger so no pending writes are lost when the agent finishes,
        // crashes, or is stopped. Non-blocking — errors are swallowed.
        flushLedgerForChat(chatId).catch(() => {});
      }
    })();

    this.executions.set(chatId, execution);

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
  } {
    const execution = this.executions.get(chatId);

    if (!execution) {
      return { status: 'idle', traces: [], totalTraces: 0, maxIndex: -1, finalAnswer: '' };
    }
    this.compactExecutionForRetention(execution);

    // Get traces after the given index — indices are monotonic, never re-indexed
    const newTraces: any[] = [];
    for (const trace of execution.traceBuffer) {
      if (afterIndex >= 0 && trace.index <= afterIndex) continue;
      newTraces.push({ timestamp: trace.timestamp, ...trace.data, _traceIdx: trace.index });
    }

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
    };
  }

  /**
   * Stop a specific chat's agent. Per-chat — doesn't affect other chats.
   * IDEMPOTENT: Calling this multiple times for the same chat is safe.
   */
  public stopAgent(chatId: string): boolean {
    const execution = this.executions.get(chatId);
    if (!execution) return false;

    // Already stopped/completed/failed — idempotent, don't re-process
    if (execution.status !== 'running') {
      // Still set cancel flag in case sub-agents are lingering
      execution.cancelled = true;
      return false;
    }

    execution.cancelled = true;
    execution.status = 'stopped';
    execution.completedAt = Date.now();

    this.appendTrace(execution, { type: 'thought', text: '\n\n*Generation stopped by user.*' });

    taskStore.stopTask(chatId).catch(() => { });
    apiKeyPool.releaseKey(chatId);
    apiKeyPool.releaseLeasesWithPrefix(`${ chatId }_sub_`);

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
  public addSteeringMessage(chatId: string, message: string, steeringId?: string, metadata?: Record<string, any>): boolean {
    const execution = this.findExecution(chatId);
    if (!execution || execution.status !== 'running') return false;

    const trimmedMessage = message.trim().substring(0, 8000);
    if (!trimmedMessage) return false;
    const queuedMessage: SteeringMessage = {
      id: steeringId || `steer_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`,
      text: trimmedMessage,
      createdAt: Date.now(),
      metadata,
    };
    execution.steeringQueue.push(queuedMessage);
    if (execution.steeringQueue.length > MAX_STEERING_QUEUE) {
      const toDrop = execution.steeringQueue.length - MAX_STEERING_QUEUE;
      console.warn(`[AgentRegistry] ⚠️ Steering queue full — dropping ${ toDrop } oldest message(s) for chat ${ chatId.substring(0, 8) }...`);
      execution.steeringQueue.splice(0, toDrop);
    }

    // Immediately emit a trace so the UI shows the steering card right away
    this.appendTrace(execution, {
      type: 'steering_received',
      text: trimmedMessage,
      steeringId: queuedMessage.id,
      steeringIds: [queuedMessage.id],
      timestamp: Date.now(),
      ...(metadata || {}),
    });

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

  public controlUserProxy(chatId: string, action: 'pause' | 'resume' | 'intervention', level?: ProxyInterventionLevel): boolean {
    const execution = this.findExecution(chatId);
    const projectId = execution?.orchestratorProjectId || chatId;
    if (action === 'pause') return pauseUserProxyRuntime(projectId);
    if (action === 'resume') return resumeUserProxyRuntime(projectId);
    return level ? setUserProxyIntervention(projectId, level) : false;
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
    for (const [chatId, execution] of this.executions.entries()) {
      if (execution.status === 'running') {
        execution.cancelled = true;
        execution.status = 'stopped';
        execution.completedAt = Date.now();
        taskStore.stopTask(chatId).catch(() => { });
        apiKeyPool.releaseKey(chatId);
        apiKeyPool.releaseLeasesWithPrefix(`${ chatId }_sub_`);
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
