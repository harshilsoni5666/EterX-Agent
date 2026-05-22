import { GoogleGenAI } from '@google/genai';
import { AgentOrchestrator } from './orchestrator';
import { apiKeyPool, type KeyLease } from './api-key-pool';
import { taskStore } from './task-store';
import { getMainAgentModelConfig, type MainAgentMode } from './model-routing';

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

interface AgentExecution {
  chatId: string;
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
  steeringQueue: string[];     // Live steering messages from user mid-run
  mode: MainAgentMode;
  // === EXECUTION METRICS (new) ===
  toolCallCount: number;       // Total tool calls in this execution
  effectiveModel: string;      // Actual model used (may differ from mode due to smart routing)
  complexity: string;          // Task complexity classification
  peakMemoryMB: number;        // Peak memory usage during execution
}

const MAX_TRACE_BUFFER = 2000;          // Max traces kept in memory per chat
const CLEANUP_INTERVAL = 60 * 60 * 1000; // Cleanup completed agents after 1 hour
const MAX_COMPLETED_AGE = 2 * 60 * 60 * 1000; // 2 hours max retention for completed agents

class AgentRegistry {
  private executions: Map<string, AgentExecution> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
    this.cleanupTimer.unref?.();
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
    userName: string = 'Developer'
  ): { status: 'started' | 'already_running' | 'no_keys'; chatId: string; message: string } {

    // Check if this chat already has a running agent
    const existing = this.executions.get(chatId);
    if (existing && existing.status === 'running') {
      return { status: 'already_running', chatId, message: 'Agent is already running for this chat' };
    }

    const modelConfig = getMainAgentModelConfig(mode);
    const isMistralMode = modelConfig.provider === 'mistral';

    // Try to lease a Gemini API key only for Gemini runs. Mistral uses its own
    // MISTRAL_API_KEY and should not be blocked by the Gemini key pool.
    const lease: KeyLease | null = isMistralMode ? null : apiKeyPool.leaseKey(chatId, 'main_agent');
    if (!isMistralMode && !lease) {
      return { status: 'no_keys', chatId, message: 'All API keys are currently in use. Try again in a moment.' };
    }

    // Create the execution record
    const execution: AgentExecution = {
      chatId,
      prompt,
      status: 'running',
      startedAt: Date.now(),
      traceBuffer: [],
      traceCounter: 0,
      finalAnswer: '',
      cancelled: false,
      keyLeaseId: isMistralMode ? 'mistral' : chatId,
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
        throw new Error('CANCELLED_BY_USER');
      }

      // Use monotonic counter — NEVER re-index, prevents stale cursor re-delivery
      const traceIdx = execution.traceCounter++;

      const entry: TraceEvent = {
        index: traceIdx,
        timestamp: Date.now(),
        data: traceEvent,
      };

      execution.traceBuffer.push(entry);

      // Track tool call count for metrics
      if (traceEvent?.type === 'tool_call' || traceEvent?.type === 'action') {
        execution.toolCallCount++;
      }

      // Track complexity if reported
      if (traceEvent?.complexity) {
        execution.complexity = traceEvent.complexity;
      }

      // Cap buffer size — trim old entries but DON'T re-index
      if (execution.traceBuffer.length > MAX_TRACE_BUFFER) {
        execution.traceBuffer = execution.traceBuffer.slice(-MAX_TRACE_BUFFER + 200);
        // Indices are monotonic and stable — no re-indexing needed
      }

      if (!pinnedContext?.disableTaskStore) {
        taskStore.addTrace(chatId, traceEvent);
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

        const mediaFiles: { path: string, mimeType: string, name: string, fileUri?: string }[] = [];

        if (hasMediaAttachments) {
          for (const att of mediaAttachments) {
            const safeName = (att.name || `upload_${ Date.now() }`).replace(/[<>:"/\\|?*]/g, '_');
            const destPath = path.join(workspaceTemp, safeName);

            if (att.path && fs.existsSync(att.path)) {
              // File exists on disk (Electron path or pre-upload localPath)
              if (!fs.existsSync(destPath) || att.path !== destPath) {
                fs.copyFileSync(att.path, destPath);
              }
              // IMPORTANT: Do NOT pass pre-uploaded fileUri — we will re-upload with the leased key
              mediaFiles.push({ path: destPath, mimeType: att.mimeType || 'application/octet-stream', name: safeName });
            } else if (att.data || att.inlineData) {
              // Base64 data (clipboard paste or fallback) — handle BOTH field names
              const b64 = att.data || (att.inlineData?.data) || att.inlineData;
              if (typeof b64 === 'string') {
                fs.writeFileSync(destPath, Buffer.from(b64, 'base64'));
                mediaFiles.push({ path: destPath, mimeType: att.mimeType || 'application/octet-stream', name: safeName });
              }
            } else if (att.fileUri) {
              // Only fileUri without local file — still copy if original path exists
              if (att.path) {
                try { fs.copyFileSync(att.path, destPath); } catch { }
              }
              // Don't trust pre-uploaded fileUri (different API key) — re-upload below
              const filePath = fs.existsSync(destPath) ? destPath : (att.path || destPath);
              if (fs.existsSync(filePath)) {
                mediaFiles.push({ path: filePath, mimeType: att.mimeType || 'application/octet-stream', name: safeName });
              }
            }
          }
        }

        const preUploadedFiles = mediaFiles.filter(f => f.fileUri);
        const needsUploadFiles = mediaFiles.filter(f => !f.fileUri && GEMINI_NATIVE_MIMES.has(f.mimeType));
        const currentGeminiNativeFiles = [...preUploadedFiles, ...needsUploadFiles];
        const textFallbackFiles = mediaFiles.filter(f => !f.fileUri && !GEMINI_NATIVE_MIMES.has(f.mimeType));

        // ═══════════════════════════════════════════════════════════
        // PERSISTENT VISUAL MEMORY — Per-Conversation File Index
        // Stores uploaded file URIs so the AI remembers images across turns.
        // ═══════════════════════════════════════════════════════════
        const visualMemoryDisabled = !!pinnedContext?.disableVisualMemory || !!pinnedContext?.disableMemoryHydration;
        let geminiNativeFiles = [...currentGeminiNativeFiles];
        const visualMemoryPath = path.join(workspaceTemp, `${ chatId }_visual_memory.json`);
        try {
          let historicalFiles: any[] = [];
          if (!visualMemoryDisabled && fs.existsSync(visualMemoryPath)) {
            historicalFiles = JSON.parse(fs.readFileSync(visualMemoryPath, 'utf8'));
          }
          // Merge historical files not already in current batch
          for (const hFile of historicalFiles) {
            if (hFile.fileUri && !geminiNativeFiles.some(f => f.name === hFile.name)) {
              if (hFile.path && fs.existsSync(hFile.path)) {
                geminiNativeFiles.push({
                  path: hFile.path,
                  mimeType: hFile.mimeType || 'application/octet-stream',
                  name: hFile.name || path.basename(hFile.path),
                });
              } else {
                console.warn(`[AgentRegistry] Skipping stale visual memory URI for ${ hFile.name || 'file' }`);
              }
            } else if (!hFile.fileUri && hFile.path && fs.existsSync(hFile.path) && !geminiNativeFiles.some(f => f.name === hFile.name)) {
              geminiNativeFiles.push({
                path: hFile.path,
                mimeType: hFile.mimeType || 'application/octet-stream',
                name: hFile.name || path.basename(hFile.path),
              });
            }
          }
          if (!visualMemoryDisabled || currentGeminiNativeFiles.length > 0) {
            console.log(`[AgentRegistry] Visual memory: ${ currentGeminiNativeFiles.length } new + ${ historicalFiles.length } recalled = ${ geminiNativeFiles.length } total files`);
          }
        } catch (e) {
          console.warn('[AgentRegistry] ⚠️ Visual memory load failed', e);
        }

        // ═══════════════════════════════════════════════════════════
        // Upload Gemini-native media with the same leased key used by the model call.
        // This keeps the renderer fast and avoids base64 payloads in the chat input.
        // ═══════════════════════════════════════════════════════════
        const uploadedImageParts: { fileData: { fileUri: string, mimeType: string } }[] = [];
        let hasNewImages = false;

        if (!isMistralMode) {
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

        // Save visual memory AFTER uploads so fileUris are persisted
        if (!visualMemoryDisabled) {
          try {
            const filesToSave = geminiNativeFiles
              .filter(f => f.fileUri || (f.path && fs.existsSync(f.path)))
              .map(f => ({ path: f.path, mimeType: f.mimeType, name: f.name, fileUri: f.fileUri || null }));
            fs.writeFileSync(visualMemoryPath, JSON.stringify(filesToSave, null, 2));
            console.log(`[AgentRegistry] 💾 Visual memory saved: ${ filesToSave.length } files indexed`);
          } catch { /* silent */ }
        }

        // Build enriched prompt with file context
        let enrichedPrompt = '';
        if (geminiNativeFiles.length > 0) {
          const fileList = geminiNativeFiles.map(f => `  • ${ f.name } (${ f.mimeType })${ f.fileUri ? ' [UPLOADED ✓]' : '' }`).join('\n');
          enrichedPrompt += isMistralMode
            ? `[USER ATTACHED FILES]\nThe following files are saved locally for this run:\n${ fileList }\n\nIMPORTANT: These files are available at their local paths in .workspaces/temp/. Use workspace tools to inspect/read them when needed. Do not claim direct visual access unless a tool result proves it.\n\n`
            : `[USER ATTACHED FILES]\nThe following files are loaded into your visual context:\n${ fileList }\n\nIMPORTANT: These files (especially images) are directly visible to you in this message. You can see and analyze them. Describe what you see when the user asks about them. Files also persist at .workspaces/temp/ for re-reading.\n\n`;
        }
        // If images are present, add explicit analysis instruction
        const attachedImageCount = geminiNativeFiles.filter(f => String(f.mimeType || '').startsWith('image/')).length;
        if (!isMistralMode && (uploadedImageParts.length > 0 || attachedImageCount > 0)) {
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
          await taskStore.createTask(chatId, prompt);
        }

        // Execute the pipeline with per-chat API key
        // Pass uploadedImageParts as the media payload (replaces old imageBackupParts)
        const projectId = pinnedContext?.telegram?.chatId
          ? `telegram-${ pinnedContext.telegram.chatId }`
          : chatId;
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
          isMistralMode ? undefined : lease!.apiKey
        );

        const responseText = response.finalAnswer || '';
        const wasCancelledByResponse = execution.cancelled || responseText === 'Stopped by user.';
        const responseFailed = response.success === false || /^Agent (Execution Failed|Error):/i.test(responseText);

        execution.status = wasCancelledByResponse ? 'stopped' : responseFailed ? 'failed' : 'completed';
        execution.completedAt = Date.now();
        execution.finalAnswer = responseText;
        if (responseFailed) execution.error = responseText;

        // Emit done event to trace buffer
        if (!execution.cancelled) {
          onTrace({ type: 'done', data: response });
        }

        // Persist to TaskStore
        if (!pinnedContext?.disableTaskStore) {
          await taskStore.completeTask(chatId, execution.finalAnswer, execution.status === 'completed', execution.status);
        }

        // Report success to key pool
        if (!isMistralMode && execution.status === 'completed') {
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
          const errorType = isMistralMode ? 'unknown' : apiKeyPool.classifyError(error.message);
          if (errorType !== 'unknown') {
            console.warn(`[AgentRegistry] 🔄 API key failure (${ errorType }) for chat ${ chatId.substring(0, 8) }...`);
            apiKeyPool.reportFailure(chatId, errorType, error.message);
          }

          // Emit error to trace buffer — use monotonic counter
          try {
            const entry: TraceEvent = {
              index: execution.traceCounter++,
              timestamp: Date.now(),
              data: { type: 'error', data: error.message },
            };
            execution.traceBuffer.push(entry);
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
        // ALWAYS release ALL keys associated with this chat (main agent + ANY dynamically named sub-agents)
        // apiKeyPool tracks leases by id, so we release the main chat ID
        if (!isMistralMode) apiKeyPool.releaseKey(chatId);

        apiKeyPool.releaseLeasesWithPrefix(`${ chatId }_sub_`);
      }
    })();

    this.executions.set(chatId, execution);

    const poolStatus = isMistralMode ? null : apiKeyPool.getPoolStatus();
    console.log(`[AgentRegistry] Agent started for chat ${ chatId.substring(0, 8) }... | Model: ${ modelConfig.modelName }${ lease ? ` | Key: #${ lease.keyIndex } | Pool: ${ poolStatus?.healthySummary }` : '' }`);

    return { status: 'started', chatId, message: lease ? `Agent started with key #${ lease.keyIndex }` : `Agent started with ${ modelConfig.label }` };
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
    startedAt?: number;
    completedAt?: number;
    error?: string;
  } {
    const execution = this.executions.get(chatId);

    if (!execution) {
      return { status: 'idle', traces: [], totalTraces: 0, maxIndex: -1, finalAnswer: '' };
    }

    // Get traces after the given index — indices are monotonic, never re-indexed
    const filteredTraces = afterIndex >= 0
      ? execution.traceBuffer.filter(t => t.index > afterIndex)
      : execution.traceBuffer;

    // Include _traceIdx in each trace so the client can deduplicate
    const newTraces = filteredTraces.map(t => ({ ...t.data, _traceIdx: t.index }));

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

    // Also add a trace event — use monotonic counter
    const entry: TraceEvent = {
      index: execution.traceCounter++,
      timestamp: Date.now(),
      data: { type: 'thought', text: '\n\n*Generation stopped by user.*' },
    };
    execution.traceBuffer.push(entry);

    taskStore.stopTask(chatId).catch(() => { });
    apiKeyPool.releaseKey(chatId);

    apiKeyPool.releaseLeasesWithPrefix(`${ chatId }_sub_`);

    console.log(`[AgentRegistry] 🛑 Stopped agent for chat ${ chatId.substring(0, 8) }...`);
    return true;
  }

  /**
   * Enqueue a live steering message for a running agent.
   * Returns true if the agent is running and the message was queued.
   * Also immediately emits a steering_received trace to the buffer so the UI
   * can show the user that their steering was acknowledged instantly.
   */
  public addSteeringMessage(chatId: string, message: string): boolean {
    const execution = this.executions.get(chatId);
    if (!execution || execution.status !== 'running') return false;

    execution.steeringQueue.push(message);

    // Immediately emit a trace so the UI shows the steering card right away
    const entry: TraceEvent = {
      index: execution.traceCounter++,
      timestamp: Date.now(),
      data: {
        type: 'steering_received',
        text: message,
        timestamp: Date.now(),
      },
    };
    execution.traceBuffer.push(entry);

    console.log(`[AgentRegistry] 🧭 Steering message queued for chat ${ chatId.substring(0, 8) }...: "${ message.substring(0, 60) }"`);
    return true;
  }

  /**
   * Dequeue all pending steering messages for a chat (clears the queue).
   * Called by the ReAct loop at the start of each iteration.
   */
  public getAndClearSteeringQueue(chatId: string): string[] {
    const execution = this.executions.get(chatId);
    if (!execution || execution.steeringQueue.length === 0) return [];
    const messages = [...execution.steeringQueue];
    execution.steeringQueue = [];
    return messages;
  }

  /**
   * Check if a specific chat has a running agent.
   */
  public isRunning(chatId: string): boolean {
    const execution = this.executions.get(chatId);
    return execution?.status === 'running';
  }

  /**
   * Get status of all active executions.
   */
  public getAllStatus(): Array<{
    chatId: string;
    status: string;
    startedAt: number;
    traceCount: number;
    durationSec: number;
  }> {
    const now = Date.now();
    return Array.from(this.executions.entries())
      .filter(([_, e]) => e.status === 'running' || (now - (e.completedAt || now)) < 300_000) // Show running + recently completed (5 min)
      .map(([chatId, e]) => ({
        chatId,
        status: e.status,
        startedAt: e.startedAt,
        traceCount: e.traceBuffer.length,
        durationSec: Math.round(((e.completedAt || now) - e.startedAt) / 1000),
        toolCallCount: e.toolCallCount,
        effectiveModel: e.effectiveModel,
        complexity: e.complexity,
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

    for (const [chatId, execution] of this.executions.entries()) {
      if (execution.status !== 'running' && execution.completedAt) {
        if (now - execution.completedAt > MAX_COMPLETED_AGE) {
          this.executions.delete(chatId);
          cleaned++;
        }
      }
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
