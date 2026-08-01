import { WorkspaceManager } from './workspace/manager';
import { globalMemoryManager } from './memory/store';
import { memoryV2 } from './memory/v2';
import { getSynapseGraphForChat, flushSynapseGraph } from './memory/synapse-graph';
import { AgentResponse, AgentTask, ProjectContext } from './schemas';
import { createIsolatedClient } from './Agent';
import { globalSubAgentSpawner, resetCancelFlag } from './roles/sub_agent';
import { globalSessionManager } from './session';
// Critic removed — was causing false rejections on user-stopped outputs and wasting execution time
import fs from 'fs-extra';
import path from 'path';
import {
  getMainAgentModelConfig,
  normalizeModelThinkingCapabilities,
  normalizeThinkingLevelForModel,
  resolveModelName,
  type MainAgentMode,
  type MainAgentProvider,
  type MainAgentThinkingLevel,
} from './model-routing';
import type { ScopedRuntimeSettings } from './runtime-api-keys';
import { DEFAULT_MAIN_AGENT_ALLOWED_CAPABILITIES } from './tools/security/tool_policy';
import { AGENT_FLOW_RUNTIME, CUSTOM_AGENT_RUNTIME, loadCustomAgentProfile } from './builder-agent';
import { agentBuilderRunFlowTool } from './tools/automation/agent_builder';
import { isModelProvider } from './model-selector-store';

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
  disableOverdelivery?: boolean;
  disableTaskStore?: boolean;
  disableWorkspaceInit?: boolean;
  forceFastMode?: boolean;
  agentRuntime?: string;
  autonomy?: { enabled?: boolean; verification?: 'adaptive' | 'strict' | 'light'; initiative?: 'balanced' | 'high' | 'maximum'; maxRecoveryAttempts?: number; collaboration?: 'auto' | 'solo' | 'human_partner' | 'cognitive_team' };
  agentId?: string;
  selectedModelMode?: MainAgentMode;
  selectedModelName?: string;
  selectedModelProvider?: string;
  strictModelSelection?: boolean;
  contextCompaction?: {
    enabled?: boolean;
    model?: { provider?: string; modelId?: string } | null;
    customInstructions?: string;
    activeContextWindow?: number;
  };
  selectedThinkingLevel?: MainAgentThinkingLevel;
  terminalShell?: string;
  runtimeSettings?: ScopedRuntimeSettings | null;
  agentSessionId?: string;
  source?: string;
  telegram?: unknown;
  userId?: string;
  workspacePath?: string;
  workspaceRoot?: string;
  allowedPaths?: string[];
  paths?: string[];
  allowNetwork?: boolean;
  networkPolicy?: 'allow' | 'deny';
  allowAgentSpawning?: boolean;
  allowDynamicCode?: boolean;
  allowBrowserControl?: boolean;
  allowHostControl?: boolean;
  allowAutomation?: boolean;
  allowExternalCommunication?: boolean;
  allowSecretManagement?: boolean;
  allowVcs?: boolean;
  allowedCapabilities?: string[];
  toolPolicy?: { allowedCapabilities?: string[] };
  runLocation?: string;
  abortSignal?: AbortSignal;
  sandboxGuard?: any;
  allowRawCommand?: boolean;
  isFocusedWorkspace?: boolean;
};

export class AgentOrchestrator {
  private taskQueue: QueuedTask[] = [];
  private isProcessing = false;
  private currentTask: QueuedTask | null = null;
  // Cache for hydrateContext results — avoids 4 disk reads per message
  private _hydrateCache: Map<string, { context: any; ts: number }> = new Map();
  private static readonly HYDRATE_TTL_MS = 30_000; // 30 seconds
  private static readonly MAX_HYDRATE_CACHE_ENTRIES = 40;

  private pruneHydrateCache(): void {
    const now = Date.now();
    for (const [projectId, cached] of this._hydrateCache.entries()) {
      if (now - cached.ts > AgentOrchestrator.HYDRATE_TTL_MS * 4) {
        this._hydrateCache.delete(projectId);
      }
    }

    while (this._hydrateCache.size > AgentOrchestrator.MAX_HYDRATE_CACHE_ENTRIES) {
      let oldestProjectId: string | null = null;
      let oldestTs = Number.POSITIVE_INFINITY;
      for (const [projectId, cached] of this._hydrateCache.entries()) {
        if (cached.ts < oldestTs) {
          oldestTs = cached.ts;
          oldestProjectId = projectId;
        }
      }
      if (!oldestProjectId) break;
      this._hydrateCache.delete(oldestProjectId);
    }
  }

  private buildHydrateCachePayload(context: RuntimeProjectContext): Partial<RuntimeProjectContext> {
    return {
      userPreferences: context.userPreferences ? { ...context.userPreferences } : {},
      errorHistory: Array.isArray(context.errorHistory) ? [...context.errorHistory] : [],
      recentMemories: Array.isArray(context.recentMemories)
        ? context.recentMemories.slice(0, 5).map((memory: any) => ({ ...memory }))
        : [],
    };
  }


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

  private resolveOptimalMode(userMode: MainAgentMode, complexity: 'trivial' | 'standard' | 'complex' | 'critical'): MainAgentMode {
    if (userMode !== 'think' && userMode !== 'fast') {
      return userMode;
    }
    switch (complexity) {
      case 'trivial': return 'fast';   // Never waste big model on greetings
      case 'standard': return userMode; // Respect user preference
      case 'complex': return 'think';  // Complex tasks need max reasoning
      case 'critical': return 'think';  // Critical tasks ALWAYS get full power
      default: return userMode;
    }
  }

  /**
   * MEMORY HYDRATION — Load real data from disk into ProjectContext.
   * This is the key fix: the agent now actually READS its own memory.
   */
  private async hydrateContext(context: any, projectId: string): Promise<void> {
    this.pruneHydrateCache();

    // FAST PATH: Use cached hydration if it's fresh (< 30s old)
    const cached = this._hydrateCache.get(projectId);
    if (cached && (Date.now() - cached.ts) < AgentOrchestrator.HYDRATE_TTL_MS) {
      Object.assign(context, cached.context);
      this._hydrateCache.delete(projectId);
      this._hydrateCache.set(projectId, { ...cached, ts: Date.now() });
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
          `${ e.tool }: ${ (e.error || '').substring(0, 120) }`
        );
      }
    }

    // 3. Recent task results
    if (storeResult.status === 'fulfilled' && storeResult.value) {
      const projectMemories = Array.isArray(storeResult.value[projectId])
        ? [...storeResult.value[projectId]]
        : [];
      projectMemories.sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
      const recent = projectMemories.slice(0, 5);
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
      context: this.buildHydrateCachePayload(context),
      ts: Date.now()
    });
    this.pruneHydrateCache();
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
    leasedApiKey?: string,
    runtimeSettings?: ScopedRuntimeSettings | null
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
      effectiveRequest = `[CRITICAL PINNED CONTEXT]\nPinned workspace paths: ${ JSON.stringify(pinnedContext.paths) }\nKeep file, code, and terminal operations inside these paths unless the user explicitly provides another target path. External web/API lookups are allowed only when the current request asks for current factual information.\n\nMy Request:\n${ userRequest }`;
    }

    console.log(`[Orchestrator] ▶ "${ effectiveRequest.substring(0, 80) }" | User: ${ userId }`);

    resetCancelFlag(projectId);
    const workspace = new WorkspaceManager(userId, projectId);

    // PARALLEL INIT — all disk I/O runs concurrently instead of sequentially
    const synapseGraph = shouldHydrateMemory ? getSynapseGraphForChat(projectId) : null;
    await Promise.all([
      shouldInitializeMemory ? globalMemoryManager.initialize() : Promise.resolve(),
      shouldInitializeMemory ? memoryV2.initialize() : Promise.resolve(),
      shouldPersistSession ? globalSessionManager.loadForProject(projectId) : Promise.resolve(),
      shouldInitializeWorkspace ? workspace.initialize() : Promise.resolve(),
      synapseGraph ? synapseGraph.initialize(projectId, projectId) : Promise.resolve(),
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
    context.runtimeSettings = runtimeSettings || null;
    if (pinnedContext?.agentSessionId) {
      context.agentSessionId = String(pinnedContext.agentSessionId);
    }

    const runLocation = pinnedContext?.runLocation || 'local';
    context.runLocation = runLocation;
    context.terminalShell = String(pinnedContext?.terminalShell || 'auto');

    if (runLocation === 'sandbox') {
      let sandboxPath = workspace.getSandboxPath();
      const pinnedPaths = Array.isArray(pinnedContext?.paths) ? pinnedContext.paths.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0) : [];
      try {
        const { createSandboxSession, initializeSandbox, createSandboxGuard } = require('../sandbox');
        const sandboxSession = createSandboxSession({
          tenantId: 'local',
          userId,
          projectId,
          sessionId: projectId,
          workspaceRoot: sandboxPath,
          allowPaths: pinnedPaths,
          readOnlyPaths: pinnedPaths,
          network: 'deny',
        });
        await initializeSandbox(sandboxSession);
        sandboxPath = sandboxSession.root;

        // Create the enterprise SandboxGuard and attach to context
        const guard = createSandboxGuard(sandboxSession);
        context.sandboxGuard = guard;
        await guard.audit({ type: 'sandbox.guard.created', pinnedPaths, sandboxRoot: sandboxPath });
      } catch (e) {
        console.error('Failed to initialize real sandbox session:', e);
      }

      context.workspaceRoot = sandboxPath;
      context.workspacePath = sandboxPath;
      context.paths = [sandboxPath];
      context.allowedPaths = [
        sandboxPath,
        ...pinnedPaths,
      ];
      // Force security restrictions in sandbox mode
      context.networkPolicy = 'deny';
      context.allowNetwork = false;
      context.allowAgentSpawning = false;
      context.allowHostControl = false;
      context.allowBrowserControl = false;
      context.allowExternalCommunication = false;
      context.allowDynamicCode = false;
      context.allowRawCommand = false;
    } else {
      if (pinnedContext?.isFocusedWorkspace) {
        context.isFocusedWorkspace = true;
      }
      if (Array.isArray(pinnedContext?.paths) && pinnedContext.paths.length > 0) {
        const pinnedPaths = pinnedContext.paths.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0);
        context.paths = pinnedPaths;
        context.allowedPaths = pinnedPaths;
        const firstDirectory = pinnedPaths.find((p: string) => {
          try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
        });
        const firstPath = firstDirectory || pinnedPaths[0];
        if (firstPath) {
          context.workspaceRoot = firstDirectory || path.dirname(path.resolve(firstPath));
          context.workspacePath = context.workspaceRoot;
        }
      }
    }
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
      context.disableOverdelivery = !!pinnedContext.disableOverdelivery;
      context.disableTaskStore = !!pinnedContext.disableTaskStore;
      context.disableWorkspaceInit = !!pinnedContext.disableWorkspaceInit;
      context.forceFastMode = !!pinnedContext.forceFastMode;
      context.agentRuntime = pinnedContext.agentRuntime;
      context.autonomy = pinnedContext.autonomy;
      context.agentId = pinnedContext.agentId;
      context.source = pinnedContext.source;
      context.telegram = pinnedContext.telegram;
      context.selectedModelProvider = String(pinnedContext.selectedModelProvider || '').trim() || undefined;
      context.strictModelSelection = pinnedContext.strictModelSelection === true;
      context.contextCompaction = pinnedContext.contextCompaction;
      context.abortSignal = pinnedContext.abortSignal instanceof AbortSignal ? pinnedContext.abortSignal : undefined;
    }

    const isSandboxRun = runLocation === 'sandbox';
    const networkDenied = isSandboxRun || (pinnedContext?.networkPolicy === 'deny' && pinnedContext?.allowNetwork !== true);
    context.networkPolicy = networkDenied ? 'deny' : 'allow';
    context.allowNetwork = !networkDenied;
    context.allowAgentSpawning = isSandboxRun ? false : (!context.disableSubAgents && pinnedContext?.allowAgentSpawning !== false);
    context.allowDynamicCode = isSandboxRun ? false : pinnedContext?.allowDynamicCode !== false;
    context.allowBrowserControl = isSandboxRun ? false : pinnedContext?.allowBrowserControl !== false;
    context.allowHostControl = isSandboxRun ? false : pinnedContext?.allowHostControl === true;
    context.allowAutomation = isSandboxRun ? false : pinnedContext?.allowAutomation === true;
    context.allowExternalCommunication = isSandboxRun ? false : pinnedContext?.allowExternalCommunication === true;
    context.allowSecretManagement = isSandboxRun ? false : pinnedContext?.allowSecretManagement === true;
    context.allowVcs = isSandboxRun ? false : pinnedContext?.allowVcs === true;

    const inheritedCapabilities = Array.isArray(context.allowedCapabilities)
      ? context.allowedCapabilities.map(String)
      : [];
    const pinnedAllowedCapabilities = Array.isArray(pinnedContext?.allowedCapabilities)
      ? pinnedContext.allowedCapabilities.map(String)
      : [];
    context.allowedCapabilities = Array.from(new Set([
      ...DEFAULT_MAIN_AGENT_ALLOWED_CAPABILITIES,
      ...inheritedCapabilities,
      ...pinnedAllowedCapabilities,
    ])).filter(capability => {
      if (networkDenied && capability.startsWith('network.')) return false;
      if ((isSandboxRun || context.disableSubAgents) && capability === 'agent.spawn') return false;
      if (context.allowDynamicCode === false && capability === 'code.dynamic') return false;
      if (context.allowBrowserControl === false && capability === 'browser.control') return false;
      return true;
    });

    // ═══ CUSTOM AGENT PROFILE LOADING ═══
    // When a custom agent is selected, load its profile from disk
    // and attach to context so Agent.ts can inject the identity prompt.
    if (context.agentRuntime === CUSTOM_AGENT_RUNTIME && pinnedContext?.customAgentId) {
      try {
        const customProfile = await loadCustomAgentProfile(pinnedContext.customAgentId);
        if (customProfile) {
          (context as any).customAgentId = pinnedContext.customAgentId;
          (context as any).customAgentName = pinnedContext.customAgentName || customProfile.name || pinnedContext.customAgentId;
          (context as any)._customAgentProfile = customProfile;
          console.log(`[Orchestrator] 🤖 Custom agent loaded: "${customProfile.name || pinnedContext.customAgentId}" (${customProfile.directMainTools?.length || 0} tools, prompt: ${(customProfile.professionalPrompt?.length || 0)} chars)`);
        } else {
          console.warn(`[Orchestrator] ⚠️ Custom agent "${pinnedContext.customAgentId}" not found or not ready`);
        }
      } catch (err: any) {
        console.error(`[Orchestrator] ❌ Failed to load custom agent profile:`, err?.message);
      }
    }

    if (shouldHydrateMemory) {
      await this.hydrateContext(context, projectId);
    }

    const startTime = Date.now();
    const complexity = pinnedContext?.forceFastMode ? 'standard' : this.classifyComplexity(userRequest);
    const hasExplicitModel = String(pinnedContext?.selectedModelProvider || '').trim().length > 0
      && typeof pinnedContext?.selectedModelName === 'string'
      && pinnedContext.selectedModelName.trim().length > 0;
    const effectiveMode = pinnedContext?.forceFastMode
      ? 'fast'
      : hasExplicitModel
        ? mode
        : this.resolveOptimalMode(mode, complexity);
    const resolvedModelConfig = getMainAgentModelConfig(effectiveMode, runtimeSettings);
    const explicitProvider = String(pinnedContext?.selectedModelProvider || '').trim();
    const explicitModel = String(pinnedContext?.selectedModelName || '').trim();
    const validExplicitProvider = isModelProvider(explicitProvider);
    const modelConfig = hasExplicitModel && validExplicitProvider
      ? {
          ...resolvedModelConfig,
          provider: explicitProvider as MainAgentProvider,
          modelName: explicitModel,
        }
      : resolvedModelConfig;
    const routedMode: MainAgentMode =
      hasExplicitModel && validExplicitProvider && explicitProvider !== 'gemini'
        ? explicitProvider as MainAgentMode
        : effectiveMode;
    const modelThinkingCapability = normalizeModelThinkingCapabilities(pinnedContext?.modelThinkingCapability);
    const selectedThinkingLevel = normalizeThinkingLevelForModel(
      pinnedContext?.thinkingLevel,
      modelConfig.provider,
      modelConfig.modelName,
      modelThinkingCapability,
    );
    context.selectedModelMode = routedMode;
    context.selectedModelName = modelConfig.modelName;
    context.selectedModelProvider = modelConfig.provider;
    context.strictModelSelection = hasExplicitModel && validExplicitProvider && pinnedContext?.strictModelSelection === true;
    context.selectedThinkingLevel = selectedThinkingLevel;
    (context as any).modelThinkingCapability = modelThinkingCapability;

    // Auto-route to optimal model based on complexity
    if (effectiveMode !== mode) {
      console.log(`[Orchestrator] 🎯 Smart routing: user=${ mode } → effective=${ effectiveMode } (complexity: ${ complexity })`);
    }
    console.log(`[Orchestrator] 🧠 Task complexity: ${ complexity } | Model mode: ${ effectiveMode } | Model: ${ modelConfig.modelName }${ leasedApiKey ? ' [ISOLATED CLIENT]' : '' }`);

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

    // SYNAPSE GRAPH is now deeply integrated in Agent.ts runReActLoop.
    // Context injection + tool result tracking happen inside the model loop.
    // Orchestrator only handles init + flush.

    let finalAnswer = "";
    let effectiveApiKey = leasedApiKey || '';

    try {
      // ═══════════════════════════════════════════════════════
      // PHASE 1: PRIMARY EXECUTION (using isolated or global client)
      // Smart model routing applies the effective mode
      // ═══════════════════════════════════════════════════════
      if (context.agentRuntime === AGENT_FLOW_RUNTIME && pinnedContext?.flowId) {
        const flowTrace = (trace: any) => {
          const subAgent = trace?.agentName || pinnedContext?.flowName || 'Workflow';
          if (trace?.type === 'status' || trace?.type === 'progress') {
            onTrace?.({
              type: 'work_note',
              text: trace.text || 'Workflow is running',
              subAgent,
              noteId: `flow_${pinnedContext.flowId}_${Date.now()}`,
              isDelta: false,
              isStreaming: false,
              timestamp: Date.now(),
            });
            return;
          }
          onTrace?.({ ...trace, subAgent });
        };
        const flowResult = await agentBuilderRunFlowTool.execute(
          { flowId: String(pinnedContext.flowId), input: userRequest },
          {
            ...context,
            runtimeSettings,
            executionApiKey: leasedApiKey || '',
            _onTrace: flowTrace,
          },
        );
        if (!flowResult.success) throw new Error(flowResult.message || 'Workflow execution failed.');
        finalAnswer = flowResult.finalOutput || 'Workflow completed without a text response.';
      } else if (modelConfig.provider !== 'gemini') {
        const routedClient = createIsolatedClient(projectId, routedMode, runtimeSettings);
        finalAnswer = (await routedClient.executeMessageLoop(
          context,
          effectiveRequest,
          history,
          onTrace,
          mediaFiles,
          imageBackupParts
        )).text;
        effectiveApiKey = '';
      } else if (leasedApiKey || runtimeSettings) {
        // Isolated client — recreate with effective mode
        const routedClient = createIsolatedClient(leasedApiKey || '', routedMode, runtimeSettings);
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
        const routedClient = createIsolatedClient('', routedMode);
        finalAnswer = (await routedClient.executeMessageLoop(
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
        console.log(`[Orchestrator] 🛑 Agent cancelled by user for ${ projectId.substring(0, 8) }...`);
      } else {
        finalAnswer = `Agent Execution Failed: ${ error.message }`;
        console.error(`[Orchestrator] 💥 Fatal error:`, error.message);
        if (shouldPersistLongTermMemory) {
          globalMemoryManager.logError('orchestrator', error.message, `Task: ${ userRequest }`);
          memoryV2.remember({
            userId,
            projectId,
            chatId: projectId,
            scope: 'error',
            type: 'orchestrator_failure',
            content: `Task failed: ${ userRequest }\nError: ${ error.message }`,
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
      await globalSessionManager.saveForChat(projectId);
    }

    // Flush Synapse graph state to disk
    if (synapseGraph) {
      flushSynapseGraph(projectId).catch(() => {});
    }

    const artifactsGenerated: string[] = [];
    if (shouldExportTranscript) {
      const outputFilename = `result_${ Date.now() }.txt`;
      const outputPath = await workspace.exportOutput(outputFilename, finalAnswer);
      artifactsGenerated.push(outputPath);
    }

    const executionTime = Date.now() - startTime;
    const success = finalAnswer !== 'Stopped by user.' && !/^Agent Execution Failed:/i.test(finalAnswer);

    if (shouldPersistLongTermMemory) {
      globalMemoryManager.saveEpisodicMemory(
        projectId,
        `Executed task: ${ userRequest }`,
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

    console.log(`[Orchestrator] ✅ Pipeline complete in ${ executionTime }ms (complexity: ${ complexity }, mode: ${ effectiveMode })`);

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

      console.log(`[Orchestrator] Task queued: "${ request.substring(0, 50) }..." (priority: ${ priority }, queue size: ${ this.taskQueue.length })`);

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

    try {
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
    } finally {
      this.currentTask = null;
      this.isProcessing = false;
    }
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
