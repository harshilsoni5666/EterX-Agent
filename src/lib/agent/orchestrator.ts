import { WorkspaceManager } from './workspace/manager';
import { initializeChatWorkspace } from './workspace/runtime-context';
import { managedWorkspaces } from './workspace/managed';
import { globalMemoryManager } from './memory/store';
import { memoryV2 } from './memory/v2';
import { getSynapseGraphForChat, flushSynapseGraph } from './memory/synapse-graph';
import { AgentResponse, AgentTask, ProjectContext } from './schemas';
import { createIsolatedClient } from './Agent';
import { AgentRunner } from './agent-runner';
import { globalSubAgentSpawner, resetCancelFlag } from './roles/sub_agent';
import { globalSessionManager } from './session';
// Critic removed — was causing false rejections on user-stopped outputs and wasting execution time
import fs from 'fs-extra';
import path from 'path';
import {
  getMainAgentModelConfig,
  normalizeModelThinkingCapabilities,
  normalizeThinkingLevelForModel,
  type MainAgentMode,
  type MainAgentProvider,
  type MainAgentThinkingLevel,
} from './model-routing';
import type { ScopedRuntimeSettings } from './runtime-api-keys';
import { DEFAULT_MAIN_AGENT_ALLOWED_CAPABILITIES } from './tools/security/tool_policy';
import { MAX_SUB_AGENTS } from './sub-agent-settings';
import { hasExplicitSubAgentRequest } from './roles/sub_agent_strategy';
import { isRuntimeSwarmMode } from './swarm-mode';
import { AGENT_BUILDER_RUNTIME, AGENT_FLOW_RUNTIME, CUSTOM_AGENT_RUNTIME, loadCustomAgentProfile, summarizeAgentBuilderProfile } from './builder-agent';
import { agentBuilderRunFlowTool } from './tools/automation/agent_builder';
import { getToolDisplayLabel, normalizeToolTraceName, summarizeTraceValue } from './tool-trace';
import { isModelProvider } from './model-selector-store';
import { getEterxWorkspaceDir } from './storage-paths';
import { isUserInitiatedCommunicationRequest } from './tools/communication/outbound_approval';
import { adaptiveExperience, resolveSelfImprovementEnabled } from './self-improvement/engine';
import { formatUnknownError } from './error-format';

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
  workingContextRequest?: { visibleText: string; runtimeText: string };
  disableSubAgents?: boolean;
  disableMemoryHydration?: boolean;
  disableLongTermMemory?: boolean;
  synapseGraphEnabled?: boolean;
  selfImprovementEnabled?: boolean;
  disableSessionPersistence?: boolean;
  disableSharedCache?: boolean;
  disableWorkspaceContext?: boolean;
  disablePlannerTools?: boolean;
  disableOverdelivery?: boolean;
  disableTaskStore?: boolean;
  disableWorkspaceInit?: boolean;
  forceFastMode?: boolean;
  agentRuntime?: string;
  agentProfile?: string;
  agentName?: string;
  autonomy?: { enabled?: boolean; verification?: 'adaptive' | 'strict' | 'light'; initiative?: 'balanced' | 'high' | 'maximum'; maxRecoveryAttempts?: number; collaboration?: 'auto' | 'solo' | 'human_partner' | 'cognitive_team' };
  agentId?: string;
  selectedModelMode?: MainAgentMode;
  selectedModelName?: string;
  selectedModelProvider?: string;
  strictModelSelection?: boolean;
  contextCompaction?: {
    enabled?: boolean;
    model?: { provider?: string; modelId?: string; contextWindow?: number } | null;
    customInstructions?: string;
    activeContextWindow?: number;
    activeModelContextWindow?: number;
    activeContextWindowUsesModelMaximum?: boolean;
    requestedContextWindow?: number;
    activeContextModelProvider?: string;
    activeContextModelId?: string;
    modelContextWindows?: Record<string, number>;
    contextBudgetChatId?: string;
    contextBudgetRevision?: number;
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
  /** Per-project location for drafts, scripts, and other intermediate work. */
  scratchRoot?: string;
  allowedPaths?: string[];
  paths?: string[];
  allowNetwork?: boolean;
  networkPolicy?: 'allow' | 'deny';
  allowAgentSpawning?: boolean;
  allowDynamicCode?: boolean;
  allowBrowserControl?: boolean;
  allowHostControl?: boolean;
  computerUseEnabled?: boolean;
  allowAutomation?: boolean;
  allowExternalCommunication?: boolean;
  allowSecretManagement?: boolean;
  allowVcs?: boolean;
  allowedCapabilities?: string[];
  toolPolicy?: { allowedCapabilities?: string[] };
  runLocation?: string;
  abortSignal?: AbortSignal;
  allowRawCommand?: boolean;
  isFocusedWorkspace?: boolean;
  userInitiatedCommunication?: boolean;
  getActiveTurnId?: () => string;
  getActiveAuxiliaryTurnId?: (identity: string) => string;
};

const BUILDER_TRACE_ICONS: Record<string, string> = {
  agent_builder_get_profile: 'agent',
  agent_builder_list_capabilities: 'search',
  agent_builder_save_profile: 'agent',
  agent_builder_attach_main_tool: 'agent',
  agent_builder_remove_tool: 'agent',
  agent_builder_attach_all_main_tools: 'agent',
  agent_builder_attach_connector_tools: 'connector',
  agent_builder_define_tool: 'agent',
  agent_builder_run_quality_check: 'verification',
  agent_builder_finalize: 'verification',
  agent_builder_save_flow: 'agent',
  agent_builder_list_flows: 'search',
  agent_builder_delete_flow: 'agent',
  agent_builder_run_flow: 'agent',
  agent_tool_load: 'agent',
  agent_tool_unload: 'agent',
  gateway_bridge: 'connector',
  connector_mcp: 'connector',
};

function compactBuilderTraceArgs(toolName: string, args: any): Record<string, unknown> {
  const source = args && typeof args === 'object' ? args : {};
  const keep = [
    'agentId', 'name', 'changeSummary', 'toolName', 'tool_name', 'scope', 'mode', 'query', 'category',
    'connectorId', 'connector_id', 'server_id', 'platform', 'action', 'channelProfileId',
    'readinessNotes', 'flowId', 'description',
  ];
  const compact = Object.fromEntries(keep
    .filter(key => source[key] !== undefined)
    .map(key => [key, source[key]]));
  if (toolName === 'agent_builder_save_profile') {
    const profileFields = [
      'name', 'mission', 'professionalPrompt', 'responseStyle', 'behaviorRules', 'safetyRules',
      'skills', 'toolUsePolicy', 'completionCriteria', 'uiDescription', 'uiCategory',
      'uiAccentColor', 'starterPrompts', 'notes',
    ].filter(key => source[key] !== undefined);
    return {
      ...compact,
      changedFields: profileFields,
      ...(typeof source.professionalPrompt === 'string' ? { promptCharacters: source.professionalPrompt.length } : {}),
      ...(source.replaceCollections === true ? { replaceCollections: true } : {}),
    };
  }
  if (Array.isArray(source.excludeToolNames)) compact.excludeToolNames = source.excludeToolNames.slice(0, 20);
  return compact;
}

function builderTraceSecondary(toolName: string, args: Record<string, unknown>, agentName: string): string {
  const candidates: Record<string, unknown[]> = {
    agent_builder_get_profile: [agentName],
    agent_builder_list_capabilities: [args.query, args.category, 'Capability catalog'],
    agent_builder_save_profile: [args.changeSummary, args.name, agentName],
    agent_builder_attach_main_tool: [args.toolName],
    agent_builder_remove_tool: [args.toolName],
    agent_builder_attach_all_main_tools: ['Full capability catalog'],
    agent_builder_attach_connector_tools: [args.platform, args.connectorId, args.mode],
    agent_builder_define_tool: [args.toolName],
    agent_builder_run_quality_check: [agentName],
    agent_builder_finalize: [agentName],
    agent_builder_save_flow: [args.flowId],
    agent_builder_list_flows: ['Saved workflows'],
    agent_builder_delete_flow: [args.flowId],
    agent_builder_run_flow: [args.flowId],
    agent_tool_load: [args.toolName, args.tool_name],
    agent_tool_unload: [args.toolName, args.tool_name],
    gateway_bridge: [args.platform, args.action],
    connector_mcp: [args.connectorId, args.connector_id, args.server_id, args.action],
  };
  return summarizeTraceValue((candidates[toolName] || [agentName]).find(Boolean), 140);
}

function compactBuilderTraceResult(result: any): any {
  if (!result || typeof result !== 'object') return result;
  const { profile, ...rest } = result;
  if (!profile || typeof profile !== 'object') return rest;
  return {
    ...rest,
    profileSummary: rest.profileSummary || summarizeAgentBuilderProfile(profile),
  };
}

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
  private async hydrateContext(context: any, projectId: string, userId: string): Promise<void> {
    this.pruneHydrateCache();
    const cacheKey = JSON.stringify([userId, projectId]);

    // FAST PATH: Use cached hydration if it's fresh (< 30s old)
    const cached = this._hydrateCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < AgentOrchestrator.HYDRATE_TTL_MS) {
      Object.assign(context, this.buildHydrateCachePayload(cached.context as RuntimeProjectContext));
      // LRU access must not extend the freshness of the data itself.
      this._hydrateCache.delete(cacheKey);
      this._hydrateCache.set(cacheKey, cached);
      return;
    }

    const memoryDir = getEterxWorkspaceDir('.memory');

    // ALL reads in parallel — no sequential I/O blocking
    const [prefsResult, errorsResult, storeResult] = await Promise.allSettled([
      fs.pathExists(path.join(memoryDir, 'user_preferences.json')).then(exists =>
        exists ? fs.readJson(path.join(memoryDir, 'user_preferences.json')) : null
      ),
      fs.pathExists(path.join(memoryDir, 'error_log.json')).then(exists =>
        exists ? fs.readJson(path.join(memoryDir, 'error_log.json')) : null
      ),
      fs.pathExists(path.join(memoryDir, 'memory_store.json')).then(exists =>
        exists ? fs.readJson(path.join(memoryDir, 'memory_store.json')) : null
      ),
    ]);

    // 1. User preferences
    context.userPreferences = {};
    if (prefsResult.status === 'fulfilled' && prefsResult.value) {
      for (const [key, val] of Object.entries(prefsResult.value)) {
        const owner = (val as any)?.userId;
        const scopedKey = key.startsWith(`${userId}:`) || key.startsWith(`${projectId}:`);
        if (owner ? owner !== userId : !scopedKey && !(userId === 'user' && key.startsWith('global:'))) continue;
        if (key.endsWith('last_successful_task')) continue;
        context.userPreferences[key] = val && typeof val === 'object' && Object.prototype.hasOwnProperty.call(val, 'value')
          ? (val as any).value : val;
      }
    }

    // 2. Recent errors (last 5)
    if (errorsResult.status === 'fulfilled' && errorsResult.value) {
      const errors = errorsResult.value;
      if (Array.isArray(errors) && errors.length > 0) {
        context.errorHistory = errors.filter((e: any) => String(e.context || '').includes(projectId)).slice(-5).map((e: any) =>
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

    // Cache the result for this project
    this._hydrateCache.set(cacheKey, {
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
    const workspace = await initializeChatWorkspace(projectId, userId, pinnedContext);
    const release = managedWorkspaces.acquireWorkspaceLease(workspace.workspacePath);
    try {
      return await this.executePipelineInWorkspace(userId, projectId, userRequest, history, onTrace, mode,
        { ...pinnedContext, workspacePath: workspace.workspacePath, runLocation: workspace.runLocation },
        mediaFiles, imageBackupParts, userName, leasedApiKey, runtimeSettings);
    } finally { release(); }
  }

  private async executePipelineInWorkspace(
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
    const selfImprovementEnabled = shouldPersistLongTermMemory
      && resolveSelfImprovementEnabled(pinnedContext?.selfImprovementEnabled);
    const shouldPersistSession = pinnedContext?.persistSession !== false;
    const shouldExportTranscript = pinnedContext?.exportTranscript !== false;
    const shouldInitializeMemory = shouldHydrateMemory || shouldPersistLongTermMemory;
    const shouldInitializeWorkspace = shouldExportTranscript || !pinnedContext?.disableWorkspaceInit;
    const experienceTrace: any[] = [];
    const persistenceWarnings: string[] = [];
    const upstreamTrace = onTrace;
    onTrace = (trace: any) => {
      if (experienceTrace.length < 600) experienceTrace.push(trace);
      upstreamTrace?.(trace);
    };

    // Inject pinned context into standard prompt if it exists
    let effectiveRequest = userRequest;
    if (pinnedContext && pinnedContext.paths) {
      effectiveRequest = `[CRITICAL PINNED CONTEXT]\nPinned workspace paths: ${ JSON.stringify(pinnedContext.paths) }\nUse the selected workspace for relative paths. Honor other explicit user paths using host OS permissions. Pinned files are task context, not a filesystem boundary.\n\nMy Request:\n${ userRequest }`;
    }

    console.log(`[Orchestrator] ▶ "${ effectiveRequest.substring(0, 80) }" | User: ${ userId }`);

    resetCancelFlag(projectId);
    const workspace = new WorkspaceManager(userId, projectId);

    // PARALLEL INIT — all disk I/O runs concurrently instead of sequentially
    const shouldUseSynapseGraph = shouldHydrateMemory && shouldPersistLongTermMemory && pinnedContext?.synapseGraphEnabled === true;
    const synapseGraph = shouldUseSynapseGraph ? getSynapseGraphForChat(projectId) : null;
    await Promise.all([
      shouldInitializeMemory ? globalMemoryManager.initialize() : Promise.resolve(),
      shouldInitializeMemory ? memoryV2.initialize().catch(error => {
        persistenceWarnings.push('Durable memory was unavailable at the start of this turn.');
        console.warn('[Orchestrator] Durable memory initialization unavailable:', formatUnknownError(error));
      }) : Promise.resolve(),
      shouldPersistSession ? globalSessionManager.loadForProject(projectId) : Promise.resolve(),
      shouldInitializeWorkspace ? workspace.initialize() : Promise.resolve(),
      synapseGraph ? synapseGraph.initialize(projectId, projectId) : Promise.resolve(),
    ]);

    if (shouldPersistLongTermMemory) {
      // Finish explicit preference admission before any provider recalls it.
      // Learn only from the human message, never runtime-added instructions.
      await Promise.all([
      memoryV2.recordRawEvent({
        userId,
        projectId,
        chatId: projectId,
        eventType: 'user_message',
        text: userRequest,
        metadata: { source: pinnedContext?.source || 'desktop' },
      }).catch(error => console.warn('[Orchestrator] Could not record user memory:', formatUnknownError(error))),
      memoryV2.learnFromUserMessage({
        userId,
        projectId,
        chatId: projectId,
        message: userRequest,
      }).catch(error => console.warn('[Orchestrator] Could not learn user preferences:', formatUnknownError(error))),
      ]);
    }
    const context: RuntimeProjectContext = shouldHydrateMemory && shouldPersistLongTermMemory
      ? globalMemoryManager.getProjectContext(projectId)
      : {
        projectId,
        conversationSummary: 'Current request only.',
        uploadedFiles: [],
        recentMemories: [],
        userPreferences: {},
        errorHistory: []
      };
    // Keep the operational project/chat id and the conversation identity
    // explicit. Child agents replace only memoryScopeId; main-agent routing
    // still uses projectId for cancellation and live steering.
    context.conversationScopeId = projectId;
    context.workingContextRequest = {
      visibleText: typeof pinnedContext?.visibleUserRequest === 'string' ? pinnedContext.visibleUserRequest : userRequest,
      runtimeText: effectiveRequest,
    };
    // Keep the main runtime's scratch work in the isolated per-project
    // workspace. The app checkout is infrastructure and must never become the
    // implicit place for drafts or helper scripts.
    context.scratchRoot = workspace.getSandboxPath();
    if (userName) context.userName = userName;
    context.userId = userId;
    context.userInitiatedCommunication = isUserInitiatedCommunicationRequest(userRequest);
    context.selfImprovementEnabled = selfImprovementEnabled;
    context.runtimeSettings = runtimeSettings || null;
    context.ownerChatId = String(pinnedContext?.ownerChatId || projectId);
    // Runtime selection is per admission, never inherited from chat memory.
    context.agentProfile = pinnedContext?.agentProfile;
    context.runId = String(pinnedContext?.runId || '').trim() || undefined;
    context.turnId = String(pinnedContext?.turnId || context.runId || '').trim() || undefined;
    context.subAgentTurnId = String(pinnedContext?.subAgentTurnId || '').trim() || undefined;
    context.getActiveTurnId = typeof pinnedContext?.getActiveTurnId === 'function'
      ? pinnedContext.getActiveTurnId
      : undefined;
    context.getActiveAuxiliaryTurnId = typeof pinnedContext?.getActiveAuxiliaryTurnId === 'function'
      ? pinnedContext.getActiveAuxiliaryTurnId
      : undefined;
    if (pinnedContext?.agentSessionId) {
      context.agentSessionId = String(pinnedContext.agentSessionId);
    }

    const runLocation = pinnedContext?.runLocation || 'local';
    context.runLocation = runLocation;
    context.terminalShell = String(pinnedContext?.terminalShell || 'auto');

    Object.assign(context, await initializeChatWorkspace(projectId, userId, pinnedContext));
    // Spawning authority is opt-in per run. Treat omitted/stale pinned fields
    // as disabled instead of silently inheriting the broad Main capability.
    (context as any).rootUserRequest = context.workingContextRequest?.visibleText || userRequest;
    context.planMode = pinnedContext?.planMode === true;
    context.swarmMode = isRuntimeSwarmMode(projectId, pinnedContext?.swarmMode === true);
    context.swarmRunId = context.runId || context.turnId || projectId;
    context.agentDepth = 0;
    const explicitlyRequestedDelegation = context.swarmMode || hasExplicitSubAgentRequest(userRequest);
    const agentSpawningEnabled = (pinnedContext?.allowAgentSpawning === true || explicitlyRequestedDelegation)
      && (pinnedContext?.disableSubAgents !== true || explicitlyRequestedDelegation);
    context.disableSubAgents = !agentSpawningEnabled;
    (context as any)._baseDelegation = {
      allowed: (pinnedContext?.allowAgentSpawning === true && pinnedContext?.disableSubAgents !== true) || hasExplicitSubAgentRequest(userRequest),
      disabled: !((pinnedContext?.allowAgentSpawning === true && pinnedContext?.disableSubAgents !== true) || hasExplicitSubAgentRequest(userRequest)),
    };
    if (pinnedContext) {
      context.disableMemoryHydration = !!pinnedContext.disableMemoryHydration;
      context.disableLongTermMemory = !!pinnedContext.disableLongTermMemory;
      context.synapseGraphEnabled = shouldPersistLongTermMemory && pinnedContext.synapseGraphEnabled === true;
      context.disableSessionPersistence = pinnedContext.persistSession === false;
      context.disableSharedCache = !!pinnedContext.disableSharedCache;
      context.disableWorkspaceContext = !!pinnedContext.disableWorkspaceContext;
      context.disablePlannerTools = !!pinnedContext.disablePlannerTools;
      context.disableOverdelivery = !!pinnedContext.disableOverdelivery;
      context.disableTaskStore = !!pinnedContext.disableTaskStore;
      context.disableWorkspaceInit = !!pinnedContext.disableWorkspaceInit;
      context.forceFastMode = !!pinnedContext.forceFastMode;
      context.agentRuntime = pinnedContext.agentRuntime;
      // Profile is a run snapshot, never inferred from a previous chat turn.
      context.agentProfile = pinnedContext.agentProfile;
      context.autonomy = pinnedContext.autonomy;
      context.agentId = pinnedContext.agentId;
      context.agentName = pinnedContext.agentName;
      context.source = pinnedContext.source;
      context.telegram = pinnedContext.telegram;
      (context as any).telegramBot = pinnedContext.telegramBot;
      context.selectedModelProvider = String(pinnedContext.selectedModelProvider || '').trim() || undefined;
      context.strictModelSelection = pinnedContext.strictModelSelection === true;
      context.contextCompaction = pinnedContext.contextCompaction;
      const configuredMaxSubAgents = Number(pinnedContext.maxSubAgents);
      if (Number.isFinite(configuredMaxSubAgents)) {
        context.maxSubAgents = Math.min(MAX_SUB_AGENTS, Math.max(1, Math.floor(configuredMaxSubAgents)));
      }
      const configuredMaxRetries = Number(pinnedContext.maxRetries);
      if (Number.isFinite(configuredMaxRetries)) {
        context.maxRetries = Math.max(0, Math.min(5, Math.floor(configuredMaxRetries)));
      }
      context.abortSignal = pinnedContext.abortSignal instanceof AbortSignal ? pinnedContext.abortSignal : undefined;
    }

    const networkDenied = (pinnedContext?.networkPolicy === 'deny' && pinnedContext?.allowNetwork !== true);
    context.networkPolicy = networkDenied ? 'deny' : 'allow';
    context.allowNetwork = !networkDenied;
    context.allowAgentSpawning = agentSpawningEnabled;
    context.allowDynamicCode = pinnedContext?.allowDynamicCode !== false;
    context.allowBrowserControl = pinnedContext?.allowBrowserControl !== false;
    context.allowHostControl = pinnedContext?.allowHostControl === true && pinnedContext?.computerUseEnabled !== false;
    context.allowAutomation = pinnedContext?.allowAutomation === true;
    context.allowExternalCommunication = pinnedContext?.allowExternalCommunication === true;
    context.allowSecretManagement = pinnedContext?.allowSecretManagement === true;
    context.allowVcs = pinnedContext?.allowVcs === true;

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
      if (!context.allowAgentSpawning && capability === 'agent.spawn') return false;
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

    if (shouldHydrateMemory && shouldPersistLongTermMemory) {
      await this.hydrateContext(context, projectId, userId);
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
    // An exact provider/model pair is authoritative regardless of whether an
    // older caller omitted the strict flag. Auto-routing is the only path
    // allowed to use the fallback chain.
    context.strictModelSelection = hasExplicitModel && validExplicitProvider;
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
      if (
        context.agentRuntime === AGENT_BUILDER_RUNTIME &&
        context.agentId &&
        modelConfig.provider === 'gemini'
      ) {
        // Gemini keeps the dedicated draft-aware runner. Other providers use
        // the universal Agent runtime below, which already recognizes the
        // Builder context and exposes only the Builder control surface.
        const builderRunner = new AgentRunner();
        const builderAnswerParts: string[] = [];
        const builderToolStarts = new Map<string, {
          toolName: string;
          toolArgs: any;
          agentName: string;
          startedAt: number;
        }>();
        let builderEventSequence = 0;
        let builderError = '';
        const builderAgentName = String(context.agentName || context.agentId);
        const builderModelName = String(context.selectedModelName || '').trim();
        const builderTurnId = String(context.agentSessionId || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        const builderMessages = [
          ...history
            .filter((turn: any) => turn && typeof turn === 'object')
            .map((turn: any) => ({
              role: turn.role === 'model' || turn.role === 'assistant' ? 'model' as const : 'user' as const,
              content: String(turn.content || turn.text || (Array.isArray(turn.parts)
                ? turn.parts.map((part: any) => String(part?.text || '')).join('\n') : '')),
              ...(turn.contextTurnId ? { contextTurnId: turn.contextTurnId } : {}),
            }))
            .filter((turn: any) => turn.content.trim()),
          { role: 'user' as const, content: userRequest },
        ];

        for await (const event of builderRunner.run(builderMessages, {
          agentId: String(context.agentId),
          runtime: 'agent_builder',
          mode: 'think',
          model: builderModelName,
          apiKey: modelConfig.provider === 'gemini' ? leasedApiKey || undefined : undefined,
          preferredGeminiApiKey: modelConfig.provider === 'gemini' ? leasedApiKey || undefined : undefined,
          runtimeSettings,
          chatId: projectId,
          agentSessionId: context.agentSessionId,
          runLocation,
          pinnedContext: {
            ...(pinnedContext || {}),
            workingContextRequest: {
              visibleText: context.workingContextRequest!.visibleText,
              runtimeText: userRequest,
            },
            agentRuntime: AGENT_BUILDER_RUNTIME,
            agentId: String(context.agentId),
            agentName: builderAgentName,
            abortSignal: context.abortSignal,
          },
        })) {
          const eventAgentName = String(event.agentName || builderAgentName);
          const eventType = String(event.type || '');
          const hasRealChildIdentity = Boolean(
            event.subAgentId
            || event.subAgentChatId
            || event.auxiliaryRuntime
            || /^sub_agent_/.test(eventType)
            || ['inter_agent_comm', 'inter_agent_message'].includes(eventType),
          );
          const { subAgent: _ownedSubAgent, ...builderEvent } = event as any;
          const traceIdentity = hasRealChildIdentity
            ? String(event.agentName || event.subAgent || eventAgentName)
            : eventAgentName;
          if (event.type === 'text') {
            const text = String(event.text || '').trim();
            if (!text) continue;
            builderAnswerParts.push(text);
            onTrace?.({
              type: 'answer',
              text,
              agentName: traceIdentity,
              agentRuntime: AGENT_BUILDER_RUNTIME,
              agentId: String(context.agentId),
              answerId: `builder_answer_${projectId}_${builderTurnId}`,
              isDelta: false,
              isStreaming: false,
              timestamp: Date.now(),
            });
          } else if (event.type === 'thought_stream') {
            onTrace?.({
              ...(hasRealChildIdentity ? event : builderEvent),
              type: 'thought_stream',
              agentName: traceIdentity,
              agentRuntime: AGENT_BUILDER_RUNTIME,
              agentId: String(context.agentId),
              timestamp: Date.now(),
            });
          } else if (event.type === 'status' || event.type === 'work_note') {
            const text = String(event.text || '').trim();
            if (!text) continue;
            if (event.type === 'status' && (
              /\bis (?:starting|thinking)\b/i.test(text)
              || /processed\s+\d+\s+tool call/i.test(text)
              || /^completed\.?$/i.test(text)
            )) continue;
            const eventSequence = ++builderEventSequence;
            const sourceEventId = String(
              event.noteId
              || event.progressId
              || event.id
              || event.traceId
              || `builder_${event.type}_${builderTurnId}_${event.timestamp || Date.now()}_${eventSequence}`
            );
            onTrace?.({
              ...(hasRealChildIdentity ? event : builderEvent),
              // Runner status is infrastructure telemetry (API routing,
              // retries, and recovery), not prose authored by Agent Builder.
              // Keep it on the same compact progress surface as Main while
              // preserving genuine model-authored work notes as narrative.
              type: event.type === 'status' ? 'progress' : 'work_note',
              text,
              agentName: traceIdentity,
              agentRuntime: AGENT_BUILDER_RUNTIME,
              agentId: String(context.agentId),
              ...(event.type === 'work_note'
                ? { id: sourceEventId, noteId: sourceEventId }
                : { id: sourceEventId, progressId: sourceEventId }),
              isDelta: false,
              isStreaming: false,
              timestamp: Number(event.timestamp || Date.now()),
            });
          } else if (event.type === 'tool_call') {
            const toolName = normalizeToolTraceName(event.toolName);
            const toolArgs = compactBuilderTraceArgs(toolName, event.toolArgs);
            const toolCallId = String(event.toolCallId || `builder_tool_${projectId}_${Date.now()}`);
            const at = Number(event.timestamp || Date.now());
            const incomingStatus = String(event.status || '').toLowerCase();
            const settled = Boolean(
              ['completed', 'complete', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled', 'stopped'].includes(incomingStatus)
              || event.final === true
              || event.done === true
              || event.isLive === false
              || event.streamState === 'closed'
              || Number(event.endTime || event.completedAt || 0) > 0
            );
            const failed = ['failed', 'error'].includes(incomingStatus) || Boolean(event.error);
            const existingStart = builderToolStarts.get(toolCallId);
            const actionStartedAt = Number(
              existingStart?.startedAt
              || event.startTime
              || event.startedAt
              || at
            );
            if (!existingStart) {
              builderToolStarts.set(toolCallId, {
                toolName,
                toolArgs,
                agentName: traceIdentity,
                startedAt: actionStartedAt,
              });
            }
            onTrace?.({
              ...(hasRealChildIdentity ? event : builderEvent),
              type: 'tool_call',
              id: toolCallId,
              toolCallId,
              toolName,
              tool: toolName,
              name: toolName,
              text: getToolDisplayLabel(toolName),
              secondary: builderTraceSecondary(toolName, toolArgs, eventAgentName),
              icon: BUILDER_TRACE_ICONS[toolName] || 'agent',
              iconCategory: BUILDER_TRACE_ICONS[toolName] || 'agent',
              toolArgs,
              agentName: traceIdentity,
              agentRuntime: AGENT_BUILDER_RUNTIME,
              agentId: String(context.agentId),
              ...(settled ? {
                status: failed ? 'failed' : (incomingStatus || 'completed'),
                isLive: false,
                isStreaming: false,
                isLiveTyping: false,
                streamState: 'closed',
                final: true,
                done: true,
                endTime: Number(event.endTime || event.completedAt || at),
                durationMs: Number.isFinite(Number(event.durationMs))
                  ? Math.max(0, Number(event.durationMs))
                  : Math.max(0, at - actionStartedAt),
              } : {}),
              startTime: actionStartedAt,
              timestamp: at,
            });
          } else if (event.type === 'tool_result') {
            const toolName = normalizeToolTraceName(event.toolName);
            const toolCallId = String(event.toolCallId || `builder_tool_${projectId}_${toolName}`);
            const at = Number(event.timestamp || Date.now());
            const started = builderToolStarts.get(toolCallId);
            const toolArgs = compactBuilderTraceArgs(toolName, event.toolArgs || started?.toolArgs);
            const toolResult = compactBuilderTraceResult(event.toolResult);
            // AgentRunnerEvent intentionally keeps toolResult provider-neutral
            // (it may be a string, object, or structured payload). Narrow it at
            // this boundary before inspecting optional diagnostic fields.
            const rawToolResult: any = event.toolResult;
            const reportsFailure = Boolean(
              rawToolResult?.error ||
              rawToolResult?.success === false ||
              rawToolResult?.passed === false ||
              Number(rawToolResult?.exitCode) > 0
            );
            const resultError = reportsFailure
              ? formatUnknownError(
                rawToolResult?.error ?? rawToolResult?.message,
                `${ getToolDisplayLabel(toolName) } failed`,
              )
              : '';
            const failed = Boolean(
              reportsFailure
            );
            const actionStartedAt = Number(started?.startedAt || at);
            // Close the exact action row before publishing its expandable
            // result. Builder used to emit only a preview here, leaving the
            // original tool_call live until the whole run ended.
            onTrace?.({
              type: 'tool_call',
              id: toolCallId,
              toolCallId,
              toolName,
              tool: toolName,
              name: toolName,
              text: getToolDisplayLabel(toolName),
              secondary: builderTraceSecondary(toolName, toolArgs, started?.agentName || eventAgentName),
              icon: BUILDER_TRACE_ICONS[toolName] || 'agent',
              iconCategory: BUILDER_TRACE_ICONS[toolName] || 'agent',
              toolArgs,
              agentName: started?.agentName || traceIdentity,
              agentRuntime: AGENT_BUILDER_RUNTIME,
              agentId: String(context.agentId),
              status: failed ? 'failed' : 'completed',
              isLive: false,
              isStreaming: false,
              isLiveTyping: false,
              streamState: 'closed',
              final: true,
              done: true,
              ...(resultError ? { error: resultError } : {}),
              startTime: actionStartedAt,
              endTime: at,
              durationMs: Math.max(0, at - actionStartedAt),
              timestamp: at,
            });
            builderToolStarts.delete(toolCallId);
            onTrace?.({
              id: `builder_result_${toolCallId}`,
              type: 'tool_result_preview',
              ownerTraceId: toolCallId,
              toolCallId,
              toolName,
              toolArgs,
              result: toolResult,
              agentName: traceIdentity,
              agentRuntime: AGENT_BUILDER_RUNTIME,
              agentId: String(context.agentId),
              startTime: at,
              endTime: at,
              timestamp: at,
            });
          } else if (
            event.type === 'model_usage'
            || event.type === 'context_usage'
            || event.type === 'context_compaction'
            || event.type === 'ask_user'
            || event.type === 'file_preview'
            || event.type === 'evidence'
            || event.type === 'sub_agent_spawn'
            || event.type === 'sub_agent_complete'
            || event.type === 'sub_agent_error'
            || event.type === 'inter_agent_message'
          ) {
            onTrace?.({
              ...event,
              agentName: traceIdentity,
              agentRuntime: AGENT_BUILDER_RUNTIME,
              agentId: String(context.agentId),
              timestamp: Date.now(),
            });
          } else if (event.type === 'error') {
            builderError = formatUnknownError(event.text ?? event.error, 'Agent Builder failed.');
            onTrace?.({
              type: 'error',
              text: builderError,
              agentName: traceIdentity,
              agentRuntime: AGENT_BUILDER_RUNTIME,
              agentId: String(context.agentId),
              timestamp: Date.now(),
            });
          }
        }

        finalAnswer = builderAnswerParts.join('\n\n').trim()
          || (builderError ? `Agent Builder failed: ${builderError}` : 'Agent Builder returned no response.');
        effectiveApiKey = leasedApiKey || '';
      } else if (context.agentRuntime === AGENT_FLOW_RUNTIME && pinnedContext?.flowId) {
        let flowTraceSequence = 0;
        const flowTrace = (trace: any) => {
          // A selected workflow runs in this chat. A step's display name is
          // not a delegated child identity: inventing subAgent here hides its
          // thought stream from Main even though no worker tab owns it.
          const agentName = trace?.agentName || pinnedContext?.flowName || 'Workflow';
          if (trace?.type === 'status' || trace?.type === 'progress') {
            const at = Number(trace.timestamp || Date.now());
            const sourceEventId = String(
              trace.noteId
              || trace.progressId
              || trace.id
              || trace.traceId
              || `flow_${pinnedContext.flowId}_${at}_${++flowTraceSequence}`
            );
            onTrace?.({
              ...trace,
              type: 'work_note',
              text: trace.text || 'Workflow is running',
              agentName,
              id: sourceEventId,
              noteId: sourceEventId,
              isDelta: false,
              isStreaming: false,
              timestamp: at,
            });
            return;
          }
          onTrace?.({ ...trace, agentName });
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
      const errMsg = formatUnknownError(error, 'Unknown agent execution failure');
      if (errMsg === 'CANCELLED_BY_USER' || errMsg.toLowerCase().includes('cancelled_by_user')) {
        // Clean stop — not an error
        finalAnswer = 'Stopped by user.';
        console.log(`[Orchestrator] 🛑 Agent cancelled by user for ${ projectId.substring(0, 8) }...`);
      } else {
        finalAnswer = `Agent Execution Failed: ${ errMsg }`;
        console.error(`[Orchestrator] 💥 Fatal error:`, errMsg);
        if (shouldPersistLongTermMemory) {
          globalMemoryManager.logError('orchestrator', errMsg, `Task: ${ userRequest }`);
          memoryV2.remember({
            userId,
            projectId,
            chatId: projectId,
            scope: 'error',
            type: 'orchestrator_failure',
            content: `Task failed: ${ userRequest }\nError: ${ errMsg }`,
            tags: ['orchestrator', 'failure'],
            confidence: 0.86,
            importance: 9,
            source: 'system',
          }).catch(() => undefined);
        }

      }
    }


    if (shouldPersistSession) {
      await globalSessionManager.saveForChat(projectId).catch(error => {
        persistenceWarnings.push('The response is available, but session state could not be saved.');
        console.warn('[Orchestrator] Could not persist session after response:', formatUnknownError(error));
      });
    }

    // Flush Synapse graph state to disk
    if (synapseGraph) {
      flushSynapseGraph(projectId).catch(() => {});
    }

    const artifactsGenerated: string[] = [];
    if (shouldExportTranscript) {
      const outputFilename = `result_${ Date.now() }.txt`;
      try {
        const outputPath = await workspace.exportOutput(outputFilename, finalAnswer);
        artifactsGenerated.push(outputPath);
      } catch (error) {
        persistenceWarnings.push('The response is available, but its transcript could not be exported.');
        console.warn('[Orchestrator] Could not export response transcript:', formatUnknownError(error));
      }
    }

    const executionTime = Date.now() - startTime;
    const success = finalAnswer !== 'Stopped by user.'
      && !/^Agent Execution Failed:/i.test(finalAnswer)
      && !/^Agent Builder failed:/i.test(finalAnswer)
      && !/^Agent Builder returned no response\.?$/i.test(finalAnswer.trim());

    if (shouldPersistLongTermMemory) {
      globalMemoryManager.saveEpisodicMemory(
        projectId,
        `User request: ${ userRequest }\nAgent response (${success ? 'returned, completion unverified' : 'failed or stopped'}): ${finalAnswer.substring(0, 600)}`,
        'task_result',
        success ? 7 : 5,
        ['task', success ? 'success' : 'failed']
      );

      await memoryV2.saveSessionSnapshot({
        userId,
        projectId,
        chatId: projectId,
        userMessage: userRequest,
        agentOutput: finalAnswer,
        success,
        durationMs: executionTime,
        artifactsGenerated,
      }).catch(error => {
        persistenceWarnings.push('This turn could not be added to durable memory.');
        console.warn('[Orchestrator] Could not save session memory:', formatUnknownError(error));
      });
      const persistence = await Promise.allSettled([memoryV2.flush(), globalMemoryManager.flush()]);
      for (const result of persistence) {
        if (result.status === 'rejected') {
          persistenceWarnings.push('Some memory changes remain unsaved.');
          console.warn('[Orchestrator] Memory flush failed:', formatUnknownError(result.reason));
        }
      }
      this._hydrateCache.delete(JSON.stringify([userId, projectId]));
    }

    if (selfImprovementEnabled && finalAnswer !== 'Stopped by user.') {
      try {
        await adaptiveExperience.queueReflection({
          enabled: true,
          userId,
          projectId,
          chatId: projectId,
          workspacePath: context.workspacePath || context.workspaceRoot,
          agentRuntime: context.agentRuntime || 'main',
          task: userRequest,
          history,
          finalAnswer,
          success,
          durationMs: executionTime,
          artifacts: artifactsGenerated,
          trace: experienceTrace,
          mode: routedMode,
          selectedModel: { provider: modelConfig.provider, modelId: modelConfig.modelName },
          runtimeSettings,
        });
        const proxyExperienceTrace = experienceTrace.filter(event => {
          const type = String(event?.type || '').toLowerCase();
          return type.includes('proxy')
            || type.includes('steering')
            || type.includes('completion_review')
            || type.includes('intervention');
        });
        if (proxyExperienceTrace.length > 0) {
          await adaptiveExperience.queueReflection({
            enabled: true,
            userId,
            projectId,
            chatId: projectId,
            workspacePath: context.workspacePath || context.workspaceRoot,
            agentRuntime: 'user_proxy',
            task: userRequest,
            history,
            finalAnswer,
            success,
            durationMs: executionTime,
            artifacts: artifactsGenerated,
            trace: proxyExperienceTrace,
            mode: routedMode,
            selectedModel: { provider: modelConfig.provider, modelId: modelConfig.modelName },
            runtimeSettings,
          });
        }
      } catch (error) {
        console.warn('[SelfImprovement] Could not queue experience review:', error instanceof Error ? error.message : error);
      }
    }

    console.log(`[Orchestrator] ✅ Pipeline complete in ${ executionTime }ms (complexity: ${ complexity }, mode: ${ effectiveMode })`);

    return {
      taskId: crypto.randomUUID(),
      success,
      finalAnswer,
      artifactsGenerated,
      executionTimeMs: executionTime,
      complexity,
      modelMode: effectiveMode,
      effectiveApiKey,
      ...(persistenceWarnings.length ? { warnings: [...new Set(persistenceWarnings)] } : {}),
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
