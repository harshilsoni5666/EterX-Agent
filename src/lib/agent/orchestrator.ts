import { WorkspaceManager } from './workspace/manager';
import { globalMemoryManager } from './memory/store';
import { memoryV2 } from './memory/v2';
import { AgentResponse, AgentTask, ProjectContext } from './schemas';
import { globalGeminiClient, createIsolatedClient } from './gemini';
import { globalSubAgentSpawner, resetCancelFlag } from './roles/sub_agent';
import { globalSessionManager } from './session';
// Critic removed — was causing false rejections on user-stopped outputs and wasting execution time
import fs from 'fs-extra';
import path from 'path';
import {
  getMainAgentModelConfig,
  normalizeMainAgentThinkingLevel,
  type MainAgentMode,
  type MainAgentThinkingLevel,
} from './model-routing';

/**
 * The Enhanced Orchestrator v2
 * 
 * Coordinates the agent task lifecycle with:
 * - Gemini 3 ReAct loop (unlimited iterations)
 * - Task queue with priority ordering
 * - Progress tracking with stage reporting
 * - MEMORY HYDRATION from disk (preferences, errors, recent memories)
 * - Session continuity via SessionStateManager
 * - Multi-agent coordination
 */

interface QueuedTask {
  id: string;
  userId: string;
  projectId: string;
  request: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: number;
  onTrace?: (trace: any) => void;
  resolve?: (value: AgentResponse) => void;
  reject?: (reason: any) => void;
}

type RuntimeProjectContext = ProjectContext & {
  disableSubAgents?: boolean;
  disableMemoryHydration?: boolean;
  disableLongTermMemory?: boolean;
  disableSessionPersistence?: boolean;
  disableSharedCache?: boolean;
  disableWorkspaceContext?: boolean;
  disablePlannerTools?: boolean;
  disableSkillAutoLoad?: boolean;
  disableOverdelivery?: boolean;
  disableTaskStore?: boolean;
  disableWorkspaceInit?: boolean;
  forceFastMode?: boolean;
  selectedModelMode?: MainAgentMode;
  selectedModelName?: string;
  selectedThinkingLevel?: MainAgentThinkingLevel;
  source?: string;
  telegram?: unknown;
  userId?: string;
};

export class AgentOrchestrator {
  private taskQueue: QueuedTask[] = [];
  private isProcessing = false;
  private currentTask: QueuedTask | null = null;
  // Cache for hydrateContext results — avoids 4 disk reads per message
  private _hydrateCache: Map<string, { context: any; ts: number }> = new Map();
  private static readonly HYDRATE_TTL_MS = 30_000; // 30 seconds


  /**
   * Classify task complexity to decide if auto-parallel or critic loop is needed.
   * Returns: 'trivial' | 'standard' | 'complex' | 'critical'
   */
  private classifyComplexity(request: string): 'trivial' | 'standard' | 'complex' | 'critical' {
    const normalizedRequest = this.getComplexityRequestText(request);
    const words = normalizedRequest.trim().split(/\s+/).filter(Boolean).length;
    const lower = normalizedRequest.toLowerCase();

    // Trivial: short acknowledgments, greetings, simple questions
    if (words < 8 && /\b(thanks|ok|cool|hi|hello|hey|good|nice|yes|no|ty|thx)\b/i.test(lower)) return 'trivial';

    // Critical: explicit high-stakes keywords
    if (/\b(deploy|production|publish|release|security audit|penetration|financial|legal|compliance)\b/i.test(lower)) return 'critical';

    // Complex: multi-part tasks, long requests, project-level work
    if (words > 60) return 'complex';
    if (/\b(report|research|analysis|analyze|market|industry|competitor|competitive|benchmark|trends?|forecast|outlook|case study|whitepaper|brief|document|docx|pdf|pptx|slides?|spreadsheet|xlsx|top\s+\d+|companies|company|startup|business plan)\b/i.test(lower)) return 'complex';
    if (/\b(build.*app|create.*system|full.*stack|entire|complete|comprehensive|compare.*vs|analyze.*and.*analyze)\b/i.test(lower)) return 'complex';
    if ((lower.match(/\band\b/g) || []).length >= 3) return 'complex'; // 3+ "and" = multi-part

    return 'standard';
  }

  private getComplexityRequestText(request: string): string {
    const telegramUserMessage = request.match(/\[USER MESSAGE\]\s*([\s\S]*)$/);
    if (telegramUserMessage?.[1]) {
      return telegramUserMessage[1].trim();
    }
    return request;
  }

  /**
   * SMART MODEL ROUTING — Auto-select optimal model based on task complexity.
   * Overrides user-selected mode when the task demands it.
   * Trivial tasks always use fast mode; critical tasks always use think mode.
   */
  private resolveOptimalMode(userMode: MainAgentMode, complexity: 'trivial' | 'standard' | 'complex' | 'critical'): MainAgentMode {
    if (userMode === 'mistral') return 'mistral';
    switch (complexity) {
      case 'trivial':  return 'fast';   // Never waste big model on greetings
      case 'standard': return userMode; // Respect user preference
      case 'complex':  return 'think';  // Complex tasks need max reasoning
      case 'critical': return 'think';  // Critical tasks ALWAYS get full power
      default:         return userMode;
    }
  }

  /**
   * MEMORY HYDRATION — Load real data from disk into ProjectContext.
   * This is the key fix: the agent now actually READS its own memory.
   */
  private async hydrateContext(context: any, projectId: string): Promise<void> {
    // FAST PATH: Use cached hydration if it's fresh (< 30s old)
    const cached = this._hydrateCache.get(projectId);
    if (cached && (Date.now() - cached.ts) < AgentOrchestrator.HYDRATE_TTL_MS) {
      Object.assign(context, cached.context);
      return;
    }

    const memoryDir = path.resolve(process.cwd(), '.workspaces', '.memory');
    const adaptivePath = path.resolve(process.cwd(), '.workspaces', 'learning', 'adaptive_data.json');

    // ALL reads in parallel — no sequential I/O blocking
    const [prefsResult, errorsResult, storeResult, adaptiveResult] = await Promise.allSettled([
      fs.pathExists(path.join(memoryDir, 'user_preferences.json')).then(exists =>
        exists ? fs.readJson(path.join(memoryDir, 'user_preferences.json')) : null
      ),
      fs.pathExists(path.join(memoryDir, 'error_log.json')).then(exists =>
        exists ? fs.readJson(path.join(memoryDir, 'error_log.json')) : null
      ),
      fs.pathExists(path.join(memoryDir, 'memory_store.json')).then(exists =>
        exists ? fs.readJson(path.join(memoryDir, 'memory_store.json')) : null
      ),
      fs.pathExists(adaptivePath).then(exists =>
        exists ? fs.readJson(adaptivePath) : null
      ),
    ]);

    // 1. User preferences
    if (prefsResult.status === 'fulfilled' && prefsResult.value) {
      context.userPreferences = context.userPreferences || {};
      for (const [key, val] of Object.entries(prefsResult.value)) {
        context.userPreferences[key] = (val as any)?.value || val;
      }
    }

    // 2. Recent errors (last 5)
    if (errorsResult.status === 'fulfilled' && errorsResult.value) {
      const errors = errorsResult.value;
      if (Array.isArray(errors) && errors.length > 0) {
        context.errorHistory = errors.slice(-5).map((e: any) =>
          `${e.tool}: ${(e.error || '').substring(0, 120)}`
        );
      }
    }

    // 3. Recent task results
    if (storeResult.status === 'fulfilled' && storeResult.value) {
      const allMemories: any[] = [];
      for (const projectMemories of Object.values(storeResult.value)) {
        if (Array.isArray(projectMemories)) {
          allMemories.push(...projectMemories);
        }
      }
      allMemories.sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
      const recent = allMemories.slice(0, 5);
      if (recent.length > 0) {
        context.recentMemories = recent;
      }
    }

    // 4. Adaptive learning tool patterns
    if (adaptiveResult.status === 'fulfilled' && adaptiveResult.value) {
      const data = adaptiveResult.value;
      if (data.records && Array.isArray(data.records)) {
        const successfulRecords = data.records
          .filter((r: any) => r.success && r.toolSequence?.length > 0)
          .slice(-3);
        if (successfulRecords.length > 0) {
          context.userPreferences = context.userPreferences || {};
          context.userPreferences['_adaptive_tool_patterns'] = successfulRecords.map((r: any) => ({
            task: r.taskSignature?.substring(0, 80),
            tools: r.toolSequence,
            duration: r.duration,
          }));
        }
      }
    }
    // Cache the result for this project
    this._hydrateCache.set(projectId, {
      context: { ...context },
      ts: Date.now()
    });
  }

  /**
   * Execute the full pipeline for a user request via Gemini 3 API.
   */
  public async executePipeline(
    userId: string, 
    projectId: string, 
    userRequest: string,
    history: any[] = [],
    onTrace?: (trace: any) => void,
    mode: MainAgentMode = 'think',
    pinnedContext: any = null,
    mediaFiles: any[] = [],
    imageBackupParts: any[] = [],
    userName?: string,
    leasedApiKey?: string
  ): Promise<AgentResponse> {
    const shouldHydrateMemory = !pinnedContext?.disableMemoryHydration;
    const shouldPersistLongTermMemory = !pinnedContext?.disableLongTermMemory;
    const shouldPersistSession = pinnedContext?.persistSession !== false;
    const shouldExportTranscript = pinnedContext?.exportTranscript !== false;
    const shouldInitializeMemory = shouldHydrateMemory || shouldPersistLongTermMemory;
    const shouldInitializeWorkspace = shouldExportTranscript || !pinnedContext?.disableWorkspaceInit;
    
    // Inject pinned context into standard prompt if it exists
    let effectiveRequest = userRequest;
    if (pinnedContext && pinnedContext.paths) {
      effectiveRequest = `[CRITICAL PINNED CONTEXT]\nPinned workspace paths: ${JSON.stringify(pinnedContext.paths)}\nKeep file, code, and terminal operations inside these paths unless the user explicitly provides another target path. External web/API lookups are allowed only when the current request asks for current factual information.\n\nMy Request:\n${userRequest}`;
    }

    console.log(`[Orchestrator] ▶ "${effectiveRequest.substring(0, 80)}" | User: ${userId}`);
    
    resetCancelFlag(projectId);
    const workspace = new WorkspaceManager(userId, projectId);

    // PARALLEL INIT — all disk I/O runs concurrently instead of sequentially
    await Promise.all([
      shouldInitializeMemory ? globalMemoryManager.initialize() : Promise.resolve(),
      shouldInitializeMemory ? memoryV2.initialize() : Promise.resolve(),
      shouldPersistSession ? globalSessionManager.loadForProject(projectId) : Promise.resolve(),
      shouldInitializeWorkspace ? workspace.initialize() : Promise.resolve(),
    ]);
    
    if (shouldPersistLongTermMemory) {
      memoryV2.recordRawEvent({
        userId,
        projectId,
        chatId: projectId,
        eventType: 'user_message',
        text: effectiveRequest,
        metadata: { source: pinnedContext?.source || 'desktop' },
      }).catch(() => undefined);
      memoryV2.learnFromUserMessage({
        userId,
        projectId,
        chatId: projectId,
        message: effectiveRequest,
      }).catch(() => undefined);
    }
    const context: RuntimeProjectContext = shouldPersistLongTermMemory
      ? globalMemoryManager.getProjectContext(projectId)
      : {
          projectId,
          conversationSummary: 'Current request only.',
          uploadedFiles: [],
          recentMemories: [],
          userPreferences: {},
          errorHistory: []
        };
    if (userName) context.userName = userName;
    context.userId = userId;
    if (pinnedContext?.disableSubAgents) {
      context.disableSubAgents = true;
    }
    if (pinnedContext) {
      context.disableMemoryHydration = !!pinnedContext.disableMemoryHydration;
      context.disableLongTermMemory = !!pinnedContext.disableLongTermMemory;
      context.disableSessionPersistence = pinnedContext.persistSession === false;
      context.disableSharedCache = !!pinnedContext.disableSharedCache;
      context.disableWorkspaceContext = !!pinnedContext.disableWorkspaceContext;
      context.disablePlannerTools = !!pinnedContext.disablePlannerTools;
      context.disableSkillAutoLoad = !!pinnedContext.disableSkillAutoLoad;
      context.disableOverdelivery = !!pinnedContext.disableOverdelivery;
      context.disableTaskStore = !!pinnedContext.disableTaskStore;
      context.disableWorkspaceInit = !!pinnedContext.disableWorkspaceInit;
      context.forceFastMode = !!pinnedContext.forceFastMode;
      context.source = pinnedContext.source;
      context.telegram = pinnedContext.telegram;
    }
    if (shouldHydrateMemory) {
      await this.hydrateContext(context, projectId);
    }

    const startTime = Date.now();
    const complexity = pinnedContext?.forceFastMode ? 'standard' : this.classifyComplexity(userRequest);
    const effectiveMode = pinnedContext?.forceFastMode ? 'fast' : this.resolveOptimalMode(mode, complexity);
    const modelConfig = getMainAgentModelConfig(effectiveMode);
    const selectedThinkingLevel = normalizeMainAgentThinkingLevel(pinnedContext?.thinkingLevel);
    context.selectedModelMode = effectiveMode;
    context.selectedModelName = modelConfig.modelName;
    context.selectedThinkingLevel = selectedThinkingLevel;
    
    // Auto-route to optimal model based on complexity
    if (effectiveMode !== mode) {
      console.log(`[Orchestrator] 🎯 Smart routing: user=${mode} → effective=${effectiveMode} (complexity: ${complexity})`);
    }
    console.log(`[Orchestrator] 🧠 Task complexity: ${complexity} | Model mode: ${effectiveMode} | Model: ${modelConfig.modelName}${leasedApiKey ? ' [ISOLATED CLIENT]' : ''}`);
    
    // ═══════════════════════════════════════════════════════
    // PREDICTIVE BACKGROUND INTELLIGENCE (AGI Feature)
    // TEMPORARILY DISABLED: While powerful, spawning 4 parallel 
    // background agents immediately exhausts API concurrency limits
    // on most tiers, causing massive 1+ minute API throttling delays
    // for the main agent. 
    // ═══════════════════════════════════════════════════════
    /*
    if (complexity === 'complex' || complexity === 'critical') {
      console.log(`[Orchestrator] 🔮 Task is ${complexity}. Spawning predictive background intelligence...`);
      // ... background spawning logic ...
    }
    */
    
    let finalAnswer = "";
    let effectiveApiKey = leasedApiKey || '';
    
    try {
      // ═══════════════════════════════════════════════════════
      // PHASE 1: PRIMARY EXECUTION (using isolated or global client)
      // Smart model routing applies the effective mode
      // ═══════════════════════════════════════════════════════
      if (effectiveMode === 'mistral') {
        const routedClient = createIsolatedClient(projectId, effectiveMode);
        finalAnswer = (await routedClient.executeMessageLoop(
          context,
          effectiveRequest,
          history,
          onTrace,
          mediaFiles,
          imageBackupParts
        )).text;
        effectiveApiKey = '';
      } else if (leasedApiKey) {
        // Isolated client — recreate with effective mode
        const routedClient = createIsolatedClient(leasedApiKey, effectiveMode);
        finalAnswer = (await routedClient.executeMessageLoop(
          context,
          effectiveRequest,
          history,
          onTrace,
          mediaFiles,
          imageBackupParts
        )).text;
        effectiveApiKey = routedClient.getCurrentApiKey();
      } else {
        globalGeminiClient.setMode(effectiveMode);
        finalAnswer = (await globalGeminiClient.executeMessageLoop(
          context,
          effectiveRequest,
          history,
          onTrace,
          mediaFiles,
          imageBackupParts
        )).text;
      }
      
    } catch (error: any) {
      const errMsg = error.message || '';
      if (errMsg === 'CANCELLED_BY_USER' || errMsg.toLowerCase().includes('cancelled_by_user')) {
        // Clean stop — not an error
        finalAnswer = 'Stopped by user.';
        console.log(`[Orchestrator] 🛑 Agent cancelled by user for ${projectId.substring(0, 8)}...`);
      } else {
        finalAnswer = `Agent Execution Failed: ${error.message}`;
        console.error(`[Orchestrator] 💥 Fatal error:`, error.message);
        if (shouldPersistLongTermMemory) {
          globalMemoryManager.logError('orchestrator', error.message, `Task: ${userRequest}`);
          memoryV2.remember({
            userId,
            projectId,
            chatId: projectId,
            scope: 'error',
            type: 'orchestrator_failure',
            content: `Task failed: ${userRequest}\nError: ${error.message}`,
            tags: ['orchestrator', 'failure'],
            confidence: 0.86,
            importance: 9,
            source: 'system',
          }).catch(() => undefined);
        }
        
        // TRIGGER NEURAL PLASTICITY (AGI Feature)
        // Synthesize a permanent rule to avoid this error in the future
        if (shouldPersistLongTermMemory) {
          try {
            const { neuralPlasticity } = require('./adaptive');
            await neuralPlasticity.synthesizeNewRule(userRequest, error.message);
          } catch { /* silent */ }
        }
      }
    }


    if (shouldPersistSession) {
      await globalSessionManager.save();
    }

    const artifactsGenerated: string[] = [];
    if (shouldExportTranscript) {
      const outputFilename = `result_${Date.now()}.txt`;
      const outputPath = await workspace.exportOutput(outputFilename, finalAnswer);
      artifactsGenerated.push(outputPath);
    }

    const executionTime = Date.now() - startTime;
    const success = finalAnswer !== 'Stopped by user.' && !/^Agent Execution Failed:/i.test(finalAnswer);

    if (shouldPersistLongTermMemory) {
      globalMemoryManager.saveEpisodicMemory(
        projectId, 
        `Executed task: ${userRequest}`, 
        'task_result',
        success ? 7 : 5,
        ['task', success ? 'success' : 'failed']
      );

      if (success) {
        globalMemoryManager.learnPreference(userId, 'interaction', 'last_successful_task', {
          task: userRequest.substring(0, 200),
          timestamp: Date.now()
        });
      }
      await memoryV2.saveSessionSnapshot({
        userId,
        projectId,
        chatId: projectId,
        userMessage: userRequest,
        agentOutput: finalAnswer,
        success,
        durationMs: executionTime,
        artifactsGenerated,
      });
      await memoryV2.flush();
      await globalMemoryManager.flush();
    }

    console.log(`[Orchestrator] ✅ Pipeline complete in ${executionTime}ms (complexity: ${complexity}, mode: ${effectiveMode})`);

    // Record performance for adaptive learning
    if (shouldPersistLongTermMemory) {
      try {
        const { adaptiveLearning } = require('./adaptive');
        adaptiveLearning.recordExecution({
          taskSignature: userRequest.substring(0, 100),
          complexity,
          mode: effectiveMode,
          duration: executionTime,
          success,
        });
      } catch { /* adaptive learning is optional */ }
    }

    return {
      taskId: crypto.randomUUID(),
      success,
      finalAnswer,
      artifactsGenerated,
      executionTimeMs: executionTime,
      complexity,
      modelMode: effectiveMode,
      effectiveApiKey,
    } as AgentResponse;
  }

  /**
   * Add a task to the priority queue.
   */
  public async queueTask(
    userId: string,
    projectId: string,
    request: string,
    priority: 'low' | 'medium' | 'high' | 'urgent' = 'medium',
    onTrace?: (trace: any) => void
  ): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      const task: QueuedTask = {
        id: crypto.randomUUID(),
        userId,
        projectId,
        request,
        priority,
        status: 'queued',
        createdAt: Date.now(),
        onTrace,
        resolve,
        reject
      };

      // Insert by priority
      const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
      const insertIdx = this.taskQueue.findIndex(
        t => priorityOrder[t.priority] > priorityOrder[priority]
      );
      
      if (insertIdx === -1) {
        this.taskQueue.push(task);
      } else {
        this.taskQueue.splice(insertIdx, 0, task);
      }

      console.log(`[Orchestrator] Task queued: "${request.substring(0, 50)}..." (priority: ${priority}, queue size: ${this.taskQueue.length})`);

      // Start processing if not already running
      this.processQueue();
    });
  }

  /**
   * Process tasks from the queue sequentially.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift()!;
      this.currentTask = task;
      task.status = 'running';

      try {
        const result = await this.executePipeline(
          task.userId,
          task.projectId,
          task.request,
          [],
          task.onTrace
        );
        task.status = 'completed';
        task.resolve?.(result);
      } catch (error: any) {
        task.status = 'failed';
        task.reject?.(error);
      }
    }

    this.currentTask = null;
    this.isProcessing = false;
  }

  /**
   * Get current queue status.
   */
  public getQueueStatus(): { 
    currentTask: string | null, 
    queueLength: number, 
    tasks: Array<{ id: string, request: string, priority: string, status: string }> 
  } {
    return {
      currentTask: this.currentTask?.request || null,
      queueLength: this.taskQueue.length,
      tasks: this.taskQueue.map(t => ({
        id: t.id,
        request: t.request.substring(0, 80),
        priority: t.priority,
        status: t.status
      }))
    };
  }
}
