/**
 * Agent Runner — Runtime for executing custom-built agents
 * 
 * Loads a finalized AgentBuilderProfile for custom-agent runs, or a draft
 * target profile for Agent Builder runs:
 * 1. Constructs system prompt from professionalPrompt + resolved tools
 * 2. Creates a Gemini chat session with function declarations
 * 3. Runs a ReAct loop with the agent's own tools
 * 4. Streams events back for UI consumption
 * 
 * Completely separate from the main agent in Agent.ts.
 * Uses the same apiKeyPool for API key management.
 */
import path from 'path';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { apiKeyPool } from './api-key-pool';
import {
  AGENT_BUILDER_RUNTIME,
  buildAgentBuilderRuntimePrompt,
  isBuilderLiveConnectorToolName,
  isBuilderOnlyToolName,
  readAgentBuilderProfile,
  type AgentBuilderProfile,
  readAgentFlowProfile,
} from './builder-agent';
import { agentBuilderRunFlowTool } from './tools/automation/agent_builder';
import { resolveAgentTools, type ResolvedTool } from './tool-injector';
import { globalToolRegistry, normalizeRegistryToolName } from './tools/registry';
import { normalizeRegistryToolArgs, validateRegistryToolArgs } from './tools/tool-args';
import { DEFAULT_MAIN_AGENT_ALLOWED_CAPABILITIES, enforceToolCapability } from './tools/security/tool_policy';
import { getPathResolverInfo } from './workspace/path_resolver';
import { buildRuntimePlatformPrompt } from './runtime/platform-context';
import { createToolExecutionContext, isToolCancellationError } from './cancellation';
import { normalizeProviderCacheUsage } from './provider-prompt-cache';
import { getOrCreateAgentCache, handleAgentCacheNotFound } from './agent-cache';
import { compactStaleGeminiHistory, rollGeminiHistory } from './context-hot-path';
import { toolResultCompactor } from './memory/tool-result-compactor';
import { estimateRequestTokenBudget } from './request-token-budget';
import { writeRuntimeTrace } from './runtime-trace';
import type { ScopedRuntimeSettings } from './runtime-api-keys';
import {
  GEMINI_FAST_FALLBACK_CHAIN,
  GEMINI_THINK_FALLBACK_CHAIN,
  resolveModelName,
  type MainAgentMode,
} from './model-routing';
import { mergeStreamingText } from '../streaming-lifecycle';
import { adaptiveExperience, resolveSelfImprovementEnabled } from './self-improvement/engine';
import { isUserInitiatedCommunicationRequest } from './tools/communication/outbound_approval';
import { splitLeadingParallelToolCalls } from './parallel-tool-calls';
import { buildLineDiffPreview } from './tool-trace';
import { compactContextAtBoundary } from './resilience/context-compaction';
import { getSearchRouteBrief } from '../search/search-runtime';
import { getImageGenerationRouteBrief } from '../image/image-generation-runtime';
import { getVideoGenerationRouteBrief } from '../video/video-generation-runtime';
import { getApiRetries, isProviderFailoverError, waitForApiRetry } from './api-retry';

// The standalone builder endpoint can import this runner without importing
// AgentRegistry first, so ensure the complete builder tool surface is present.
import './tools/index';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface AgentRunnerEvent {
  type: 'text' | 'thought_stream' | 'work_note' | 'tool_call' | 'tool_result' | 'console_output' | 'status' | 'error' | 'done' | 'ask_user' | 'model_usage' | 'context_compaction' | 'context_usage';
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  agentId?: string;
  agentName?: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface AgentRunnerConfig {
  agentId: string;
  runtime?: 'custom_agent' | 'agent_builder';
  maxIterations?: number;
  temperature?: number;
  mode?: MainAgentMode;
  model?: string;
  preferredGeminiApiKey?: string;
  /** A key already leased by AgentRegistry. The runner must not lease it again. */
  apiKey?: string;
  runtimeSettings?: ScopedRuntimeSettings | null;
  chatId?: string;
  agentSessionId?: string;
  runLocation?: string;
  pinnedContext?: any;
}

type AsyncSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: any };

/**
 * Returns true only for Gemini models that support thinkingBudget.
 * Only gemini-2.5-pro and gemini-2.5-flash (non-lite) variants support it.
 * Sending thinkingBudget to any other model causes a 400 INVALID_ARGUMENT.
 */
function modelSupportsThinking(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  if (lower.includes('lite')) return false;
  // gemini-2.5, gemini-3, gemini-3.1, gemini-3.5 models support thinking
  return (
    lower.includes('gemini-2.5') ||
    lower.includes('gemini-3.') ||
    lower.includes('gemini-3-')
  );
}

function isGoogleGenAIModelName(modelName: string): boolean {
  return /^(?:models\/)?gemini[-_]/i.test(modelName.trim());
}

function normalizeGeminiRunnerMode(mode?: MainAgentMode): 'think' | 'fast' {
  return mode === 'fast' ? 'fast' : 'think';
}

function resolveGeminiRunnerModel(config: AgentRunnerConfig): string {
  const requestedModel = String(config.model || '').trim();
  if (requestedModel && isGoogleGenAIModelName(requestedModel)) return requestedModel;

  const runnerMode = normalizeGeminiRunnerMode(config.mode);
  const resolved = resolveModelName(runnerMode, config.runtimeSettings);
  if (isGoogleGenAIModelName(resolved)) return resolved;

  return runnerMode === 'fast'
    ? GEMINI_FAST_FALLBACK_CHAIN[0]
    : GEMINI_THINK_FALLBACK_CHAIN[0];
}

function serializeToolResult(result: unknown, maxLength: number): string {
  if (typeof result === 'string') return result.substring(0, maxLength);
  try {
    return JSON.stringify(result ?? {}).substring(0, maxLength);
  } catch {
    return String(result ?? '').substring(0, maxLength);
  }
}

function normalizeConversationTurns(contents: any[]): any[] {
  const normalized: any[] = [];
  for (const turn of contents) {
    if (!turn || !Array.isArray(turn.parts) || turn.parts.length === 0) continue;
    const previous = normalized[normalized.length - 1];
    if (previous?.role === turn.role) {
      previous.parts.push(...turn.parts);
    } else {
      normalized.push({ ...turn, parts: [...turn.parts] });
    }
  }
  return normalized;
}

// ═══════════════════════════════════════════════════════════════
// Agent Runner Class
// ═══════════════════════════════════════════════════════════════

export class AgentRunner {
  private profile: AgentBuilderProfile | null = null;
  private loadedAgentId: string | null = null;
  private resolvedTools: ResolvedTool[] = [];
  private toolPrompt = '';
  private runtimeKind: 'custom_agent' | 'agent_builder' = 'custom_agent';
  private userInitiatedCommunication = false;
  private cancelled = false;
  private cancelController: AbortController | null = null;

  /** Load an agent profile from disk */
  async loadAgent(agentId: string): Promise<AgentBuilderProfile> {
    const profile = await readAgentBuilderProfile(agentId);
    if (profile.status !== 'ready') {
      throw new Error(`Agent "${agentId}" is not finalized. Status: ${profile.status}`);
    }
    if (!profile.professionalPrompt || profile.professionalPrompt.length < 100) {
      throw new Error(`Agent "${agentId}" has no professional prompt.`);
    }

    this.profile = profile;
    this.loadedAgentId = agentId;
    this.runtimeKind = 'custom_agent';
    const { tools, toolPrompt } = resolveAgentTools(profile);
    this.resolvedTools = tools;
    this.toolPrompt = toolPrompt;

    return profile;
  }

  /**
   * Load the draft target used by Agent Builder. Draft profiles are valid
   * here because the builder is the process that creates and finalizes them.
   * The builder control surface and the two live connector bridges are
   * exposed in this runtime; target-agent tools are attached to the draft
   * through builder tool calls.
   */
  async loadBuilderAgent(agentId: string, agentName?: string): Promise<AgentBuilderProfile> {
    const profile = await readAgentBuilderProfile(agentId);
    this.profile = {
      ...profile,
      name: String(agentName || profile.name || agentId).trim() || agentId,
    };
    this.loadedAgentId = agentId;
    this.runtimeKind = 'agent_builder';
    this.resolvedTools = globalToolRegistry
      .getAllTools()
      .filter(tool => isBuilderOnlyToolName(tool.name) || isBuilderLiveConnectorToolName(tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        declaration: {
          name: tool.name,
          description: tool.description.substring(0, 420),
        },
        promptGuidance: `Builder control tool: ${tool.name}`,
      }));
    this.toolPrompt = this.resolvedTools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n');
    return this.profile;
  }

  private resolveToolsForTask(taskText = ''): ResolvedTool[] {
    void taskText;
    return this.resolvedTools;
  }

  /** Build the complete system instruction for this agent */
  private buildSystemInstruction(taskText = ''): string {
    if (!this.profile) throw new Error('Agent not loaded');

    if (this.runtimeKind === 'agent_builder') {
      const persistedSnapshot = JSON.stringify({
        status: this.profile.status,
        name: this.profile.name,
        mission: this.profile.mission,
        professionalPrompt: this.profile.professionalPrompt,
        responseStyle: this.profile.responseStyle,
        behaviorRules: this.profile.behaviorRules,
        safetyRules: this.profile.safetyRules,
        skills: this.profile.skills,
        toolUsePolicy: this.profile.toolUsePolicy,
        completionCriteria: this.profile.completionCriteria,
        directMainTools: this.profile.directMainTools,
        customTools: this.profile.customTools,
        notes: this.profile.notes,
      }, null, 2);
      return `${buildAgentBuilderRuntimePrompt(
        this.profile.agentId,
        this.profile.name,
      )}

## Current persisted target profile
This snapshot is the authoritative configuration at the start of this turn. Chat history explains user intent; this persisted state identifies what currently exists. A ready profile remains fully editable.
${persistedSnapshot}

## Builder execution protocol
- Use the builder function tools to persist every profile change; do not merely describe changes in text.
- This is a persistent multi-turn editing room. Treat each follow-up as a revision to the same target, use agent_builder_get_profile whenever the latest state needs confirmation, preserve all unspecified fields, and never imply that finalization closed the conversation.
- For an explicit replacement of rules, skills, or notes, use agent_builder_save_profile with replaceCollections=true. For a tool removal, use agent_builder_remove_tool. Do not simulate removal by changing prose only.
- Start with agent_builder_save_profile when the target profile needs identity, mission, or instructions.
- Use agent_builder_attach_main_tool or agent_builder_attach_all_main_tools for target capabilities.
- Use agent_builder_attach_connector_tools for any target that must operate connected services; it attaches the on-demand channel_agent layer and the required Gateway/REST/MCP bridges with explicit live-discovery guidance.
- When connector setup or verification is part of the request, use gateway_bridge or connector_mcp directly to inspect the live runtime. Do not report a connector as ready from the UI catalog alone.
- Use agent_builder_define_tool for target-scoped custom tools. After a material revision, run the quality check and finalize again only when the updated profile is complete.
- Use agent_tool_load and agent_tool_unload only when the builder itself needs a temporary registered capability.
- Report the result of each builder operation clearly, and continue until the requested setup is complete.`;
    }

    const parts: string[] = [];

    // Professional prompt (the core identity — written by the builder)
    parts.push(this.profile.professionalPrompt!);
    parts.push(`\n${buildRuntimePlatformPrompt('auto')}`);

    // Mission
    if (this.profile.mission) {
      parts.push(`\n## Mission\n${this.profile.mission}`);
    }

    // Behavior rules
    if (this.profile.behaviorRules.length > 0) {
      parts.push(`\n## Operating Rules\n${this.profile.behaviorRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
    }

    // Safety rules
    if (this.profile.safetyRules.length > 0) {
      parts.push(`\n## Safety Rules\n${this.profile.safetyRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
    }

    // Response style
    if (this.profile.responseStyle) {
      parts.push(`\n## Response Style\n${this.profile.responseStyle}`);
    }

    // Function declarations are authoritative. Repeating every description in
    // the prompt duplicated the largest part of the tool-schema payload.
    const activeTools = this.resolveToolsForTask(taskText);
    const availableToolNames = new Set(activeTools.map(tool => tool.name));
    if (availableToolNames.has('channel_agent') || availableToolNames.has('connector_mcp') || availableToolNames.has('gateway_bridge')) {
      parts.push(`
## Connected-service behavior
- Treat a named external app as connector intent. Use channel_agent first for inbox/sales/support/reply work; use connector_mcp action=guide first for REST/MCP work.
- Discover live state before claims. Ready connections and explicitly requested sends need no duplicate approval; draft-only never sends. Configure supplied values without echoing secrets, otherwise report the exact missing authorization and Channels path.`);
    } else {
      parts.push(`
## Connected-service boundary
- If a request requires an external app, do not pretend connector access exists. Explain that this agent has no connector tool attached and direct the user to Agents → open this agent → Agent Builder to attach Channels, Connectors, or All integration scope.`);
    }

    parts.push(`
## UI Trace Protocol

Your tool calls are rendered in the same professional work timeline as the main EterX agent.

Before non-trivial tool work, write one brief user-facing progress note, normally 3-4 plain words describing the live action. It is never private reasoning, a request restatement, a raw tool name, an approval question, or a miniature final answer. A trivial immediate action may rely on its action card; use ask_user only when input truly blocks progress.

Every tool call must include:
- uiActionText: a precise 2-4 word action label for the timeline. No step numbers, no brackets, no punctuation-heavy text, no code dumps. Examples: "Reading fetch script", "Finding dataset URL", "Running CSV inspection", "Verifying generated file".
- uiIcon: exactly one of computer, agent, terminal, image, file_read, file_create, file_edit, folder_read, folder_create, search, web_search, verification, connector. Use connector for a connected external service and keep connector_id, platform, or channel in the tool arguments when available.

Use file_read for reading files, file_create for creating files, file_edit for editing files, terminal for commands, folder_read for directory listing, search for local/code searches, web_search for web lookup, and verification for checks/tests.`);

    parts.push(`
## Final response format

- Lead with the outcome or key finding. Use concise prose and only the structure the result needs; no decorative titles, emojis, filler, automatic report sections, or generic closing offer.
- Use tables only for short repeated fields and Mermaid only when relationships are materially clearer visually. Do not duplicate prose in either.
- Link a known local deliverable once as [filename](#eterx-local-file:<URL-encoded-absolute-path>); never expose or repeat a raw path.
- Mention verification, limits, and residual risk only when relevant.`);

    parts.push(`
## Parallel tool execution

- Minimize model round trips: emit every currently-ready function call in the same model turn.
- The runtime executes independent reads concurrently and preserves provider order for writes, edits, installs, and process control. Include ordered state changes together when later arguments do not depend on earlier results.
- Keep browser interactions one at a time. Never batch ask_user, and wait when a later call genuinely depends on an earlier result.
- Parallel tool calls are different from spawning sub-agents: use the normal attached tools and preserve the evidence from every result.`);

    // Completion criteria
    if (this.profile.completionCriteria) {
      parts.push(`\n## Completion Criteria\n${this.profile.completionCriteria}`);
    }

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME SAFETY GUARDRAILS (auto-injected, never skipped)
    // These complement the builder-written soul rules in the prompt.
    // ═══════════════════════════════════════════════════════════════
    parts.push(`
## Runtime safety
- Stay inside the workspace and the mission of "${this.profile.name || this.profile.agentId}". Never escape paths, expose secrets, or perform destructive system/database actions.
- Retry transient failures at most three times with backoff. Verify writes, command exit status, and time-sensitive research before claiming success.
- Keep the user informed at meaningful work boundaries.`);

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME EFFICIENCY (auto-injected)
    // ═══════════════════════════════════════════════════════════════
    parts.push(`
## Efficiency Guidelines

- Use the ${this.resolvedTools.length} attached tools purposefully. Do not repeat unchanged reads/searches; keep exact fresh evidence and summarize already-consumed bulk.
- Answer stable facts directly and use current evidence when facts may have changed.`);

    // Keep the cacheable identity free of clocks and per-request evidence.
    // Those values are attached to the latest user turn in run().
    parts.push(`
## Environment Context
Workspace: ${getPathResolverInfo().desktopPath}
Declared tools: ${activeTools.length}. Their schemas are authoritative.
Current date/time and per-run evidence are supplied with the latest request.`);

    return parts.join('\n');
  }

  /** Build Gemini function declarations from resolved tools */
  private buildFunctionDeclarations(taskText = ''): any[] {
    const declarations: any[] = [];

    for (const tool of this.resolveToolsForTask(taskText)) {
      // Get the actual tool from registry for its schema
      const registryTool = globalToolRegistry.getTool(tool.name);

      try {
        const decl: any = {
          name: tool.name,
          description: (tool.description || '').substring(0, 420),
        };

        // Priority 1: Registry tool with Zod inputSchema → convert via zodToJsonSchema
        if (registryTool?.inputSchema) {
          try {
            const { zodToJsonSchema } = require('zod-to-json-schema');
            const rawSchema = zodToJsonSchema(registryTool.inputSchema);
            if (rawSchema && typeof rawSchema === 'object') {
              const cleaned = cleanSchemaForGemini(rawSchema);
              if (cleaned && cleaned.properties && Object.keys(cleaned.properties).length > 0) {
                decl.parameters = cleaned;
              }
            }
          } catch {
            // Schema conversion failed — tool works without params
          }
        }
        // Priority 2: Custom tool declaration with parameters already set
        else if (tool.declaration?.parameters) {
          const rawParams = tool.declaration.parameters;
          const cleaned = cleanSchemaForGemini(rawParams);
          if (cleaned && cleaned.properties && Object.keys(cleaned.properties).length > 0) {
            decl.parameters = cleaned;
          }
        }

        decl.parameters = addUiTraceFieldsToSchema(decl.parameters);
        declarations.push(decl);
      } catch {
        // Skip tools that fail entirely
      }
    }

    return declarations;
  }

  /** Cancel the running agent */
  cancel(): void {
    this.cancelled = true;
    this.cancelController?.abort();
  }

  /**
   * Run the agent with a user message.
   * Yields events as they happen for streaming to the UI.
   *
   * Advanced features:
   * - Thinking/reasoning trace extraction
   * - Per-tool execution timeout (30s)
   * - Exponential backoff for transient errors
   * - Debug logging of function declarations
   * - Schema validation error reporting
   */
  async *run(
    messages: Array<{ role: 'user' | 'model'; content: string }>,
    config: AgentRunnerConfig
  ): AsyncGenerator<AgentRunnerEvent> {
    const isBuilderRuntime = config.runtime === 'agent_builder';
    this.userInitiatedCommunication = isUserInitiatedCommunicationRequest(
      messages.filter(message => message.role === 'user').at(-1)?.content || '',
    );

    // 1. Try to load as a Flow first!
    let isFlow = false;
    if (!isBuilderRuntime) {
      try {
        const flow = await readAgentFlowProfile(config.agentId);
        if (flow?.status === 'ready' && flow.steps && flow.steps.length > 0) {
          isFlow = true;
        }
      } catch {}
    }

    if (isFlow) {
      this.cancelled = false;
      const flowAbortController = new AbortController();
      this.cancelController = flowAbortController;
      const userMessage = messages[messages.length - 1]?.content || '';
      const agentName = config.agentId;
      yield {
        type: 'status',
        text: `Initializing multi-agent flow "${config.agentId}"...`,
        agentId: config.agentId,
        agentName,
        timestamp: Date.now()
      };

      const eventQueue: AgentRunnerEvent[] = [];
      const onTrace = (trace: any) => {
        if (trace?.type === 'status') {
          eventQueue.push({
            type: 'status',
            text: trace.text,
            agentId: config.agentId,
            agentName: trace.agentName || agentName,
            timestamp: Date.now()
          });
        } else if (trace?.type === 'tool_call') {
          eventQueue.push({
            type: 'tool_call',
            toolName: trace.toolName,
            toolArgs: trace.toolArgs,
            agentName: trace.agentName || agentName,
            timestamp: Date.now()
          });
        } else if (trace?.type === 'tool_result' || trace?.type === 'tool_result_preview') {
          eventQueue.push({
            type: 'tool_result',
            toolName: trace.toolName || trace.tool,
            toolResult: trace.toolResult ?? trace.result,
            agentName: trace.agentName || agentName,
            timestamp: Date.now(),
          });
        } else if (trace?.type === 'console_output') {
          eventQueue.push({
            ...trace,
            type: 'console_output',
            agentName: trace.agentName || agentName,
            timestamp: Number(trace.timestamp || Date.now()),
          });
        } else if (['command', 'exploration', 'file_edit', 'communication', 'browser'].includes(trace?.type)) {
          // The main agent emits rich action traces rather than a literal
          // `tool_call` event. Normalize them so flows get the same cards in
          // the custom-agent chat timeline.
          eventQueue.push({
            type: 'tool_call',
            toolName: trace.tool || trace.name || 'workflow_action',
            toolArgs: {
              ...(trace.toolArgs || {}),
              uiActionText: trace.text,
              uiIcon: trace.icon || trace.iconCategory,
              filename: trace.filename,
              command: trace.command,
              secondary: trace.secondary,
            },
            agentName: trace.agentName || agentName,
            timestamp: Date.now(),
          });
        } else if (trace?.type === 'work_note' || trace?.type === 'progress') {
          eventQueue.push({
            type: 'work_note',
            text: trace.text || 'Working on the flow',
            agentName: trace.agentName || agentName,
            timestamp: Date.now(),
          });
        }
      };

      try {
        let flowSettled: AsyncSettlement<any> | null = null;
        void agentBuilderRunFlowTool.execute(
          { flowId: config.agentId, input: userMessage },
          {
            projectId: config.chatId || `flow-${config.agentId}`,
            runtimeSettings: config.runtimeSettings,
            pinnedContext: config.pinnedContext,
            runLocation: config.runLocation,
            abortSignal: flowAbortController.signal,
            signal: flowAbortController.signal,
            _onTrace: onTrace
          }
        ).then(
          value => { flowSettled = { status: 'fulfilled', value }; },
          error => { flowSettled = { status: 'rejected', error }; },
        );

        while (!flowSettled) {
          const pendingEvents = eventQueue.splice(0, eventQueue.length);
          for (const event of pendingEvents) yield event;
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        const pendingEvents = eventQueue.splice(0, eventQueue.length);
        for (const event of pendingEvents) yield event;

        const settledFlow = flowSettled as AsyncSettlement<any>;
        if (settledFlow.status === 'rejected') throw settledFlow.error;

        const flowResult = settledFlow.value;
        if (flowResult.success) {
          yield {
            type: 'text',
            text: flowResult.finalOutput,
            agentName,
            timestamp: Date.now()
          };
        } else {
          yield {
            type: 'error',
            text: flowResult.message || 'Flow execution failed.',
            timestamp: Date.now()
          };
        }
        return;
      } finally {
        if (this.cancelController === flowAbortController) this.cancelController = null;
      }
    }

    if (!this.profile || this.loadedAgentId !== config.agentId || this.runtimeKind !== (isBuilderRuntime ? 'agent_builder' : 'custom_agent')) {
      if (isBuilderRuntime) {
        await this.loadBuilderAgent(config.agentId, config.pinnedContext?.agentName);
      } else {
        await this.loadAgent(config.agentId);
      }
    }

    this.cancelled = false;
    const runAbortController = new AbortController();
    this.cancelController = runAbortController;
    const upstreamAbortSignal = config.pinnedContext?.abortSignal as AbortSignal | undefined;
    const abortFromUpstream = () => runAbortController.abort();
    if (upstreamAbortSignal?.aborted) runAbortController.abort();
    else upstreamAbortSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    const requestedMaxIterations = Number(config.maxIterations);
    const maxIter = Number.isFinite(requestedMaxIterations) && requestedMaxIterations > 0
      ? Math.floor(requestedMaxIterations)
      : Number.POSITIVE_INFINITY;
    const agentName = this.profile?.name || config.pinnedContext?.agentName || config.agentId;

    // Lease an API key
    apiKeyPool.initialize();
    const sessionId = `custom_agent_${config.agentId}_${Date.now()}`;
    const scopedGeminiKeys = config.runtimeSettings?.apiKeys?.gemini || [];
    let lease = config.apiKey ? null : (config.preferredGeminiApiKey
      ? apiKeyPool.leaseSpecificKey(sessionId, config.preferredGeminiApiKey, 'main_agent')
      : null);
    if (!config.apiKey && !lease) {
      for (const key of scopedGeminiKeys) {
        lease = apiKeyPool.leaseSpecificKey(sessionId, key, 'main_agent');
        if (lease) break;
      }
    }
    if (!config.apiKey && !lease) {
      lease = apiKeyPool.leaseKey(sessionId, 'main_agent');
    }
    if (!config.apiKey && !lease) {
      yield { type: 'error', text: 'No API keys available. Please check your API key configuration.', timestamp: Date.now() };
      return;
    }
    const initialApiKey = config.apiKey || lease!.apiKey;
    const geminiKeyPool = Array.from(new Set([
      initialApiKey,
      ...scopedGeminiKeys,
    ].map(key => String(key || '').trim()).filter(Boolean)));
    let effectiveApiKey = initialApiKey;
    const ownsLease = !config.apiKey;

    try {
      let ai = new GoogleGenAI({ apiKey: effectiveApiKey });
      const currentRequest = [...messages].reverse().find(item => item.role === 'user')?.content || '';
      let systemInstruction = this.buildSystemInstruction(currentRequest);
      let funcDecls = this.buildFunctionDeclarations(currentRequest);
      let resolvedToolSurfaceSignature = this.resolvedTools.map(tool => tool.name).join('\0');
      const runtimeNow = new Date();
      const dynamicRunContextParts = [
        '[SYSTEM-PROVIDED CURRENT RUNTIME CONTEXT]',
        `Date/time: ${runtimeNow.toISOString()}`,
        `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        `Workspace: ${String(config.pinnedContext?.workspacePath || config.pinnedContext?.paths?.[0] || getPathResolverInfo().desktopPath)}`,
      ];
      const resolvedModel = resolveGeminiRunnerModel(config);
      dynamicRunContextParts.push(
        '--- LIVE EXTERNAL SERVICE ROUTES ---',
        getSearchRouteBrief({
          selectedModelProvider: 'gemini',
          selectedModelName: resolvedModel,
          runtimeSettings: config.runtimeSettings,
        }),
        getImageGenerationRouteBrief(),
        getVideoGenerationRouteBrief(),
        'Use web_search, image_generator, or video_generator for the real task and treat the actual result as route evidence. Do not claim success without source-backed results or a validated local media artifact.',
        '--- END LIVE EXTERNAL SERVICE ROUTES ---',
      );
      const explicitConversationScope = String(
        config.pinnedContext?.memoryScopeId || config.pinnedContext?.conversationScopeId || '',
      ).trim();
      const compactionScopeId = explicitConversationScope || [
        'agent-runner',
        config.chatId || 'standalone',
        isBuilderRuntime ? 'builder' : 'custom',
        config.agentId,
      ].join(':');
      const selfImprovementEnabled = this.runtimeKind !== 'agent_builder'
        && resolveSelfImprovementEnabled(config.pinnedContext?.selfImprovementEnabled);
      if (selfImprovementEnabled) {
        try {
          const learnedContext = await adaptiveExperience.getExecutionContext({
            enabled: true,
            userId: 'user',
            projectId: config.chatId || config.agentId,
            workspaceKey: String(config.pinnedContext?.workspacePath || config.pinnedContext?.paths?.[0] || ''),
            agentRuntime: this.runtimeKind === 'agent_builder' ? 'agent_builder' : `custom_agent:${config.agentId}`,
            role: 'custom',
            request: currentRequest,
            mode: config.mode,
            selectedModel: { provider: 'gemini', modelId: resolvedModel },
            runtimeSettings: config.runtimeSettings || null,
          });
          if (learnedContext) dynamicRunContextParts.push(learnedContext);
        } catch { /* learned experience is advisory */ }
      }

      let customAgentCachedContent = await getOrCreateAgentCache(
        ai,
        effectiveApiKey,
        resolvedModel,
        systemInstruction,
        funcDecls,
      ).catch(() => null);

      // Format conversation history
      let contents = normalizeConversationTurns(messages.map(m => ({
        role: m.role === 'user' ? 'user' as const : 'model' as const,
        parts: [{ text: m.content }],
      })));
      const currentUserTurnIndex = contents.map(turn => turn.role).lastIndexOf('user');
      if (currentUserTurnIndex >= 0) {
        contents[currentUserTurnIndex] = {
          ...contents[currentUserTurnIndex],
          parts: [
            ...(contents[currentUserTurnIndex].parts || []),
            { text: `${dynamicRunContextParts.join('\n')}\n[END CURRENT RUNTIME CONTEXT]` },
          ],
        };
      }

      // ═══════════════════════════════════════════════════════════════
      // CONTEXT COMPACTION — keep the agent fast on long conversations
      // Trim old tool result payloads while keeping first + last turns
      // ═══════════════════════════════════════════════════════════════
      const MAX_CONTEXT_TURNS = 40;
      // Legacy lossy trimming is disabled. Durable compaction below owns all
      // history reduction and always emits a restorable continuation capsule.
      if (false && contents.length > MAX_CONTEXT_TURNS) {
        const keepFirst = 4; // Keep first 4 turns (original request context)
        const keepLast = 20; // Keep last 20 turns (recent context)
        const trimStart = keepFirst;
        const trimEnd = contents.length - keepLast;
        if (trimEnd > trimStart) {
          // Compact middle turns — keep role/structure but trim large payloads
          const omittedTurns = trimEnd - trimStart;
          contents = normalizeConversationTurns([
            ...contents.slice(0, keepFirst),
            {
              role: 'user',
              parts: [{
                text: `[SYSTEM - EARLIER CONVERSATION COMPACTED]\n${omittedTurns} older turns were omitted to keep this run responsive. Use the retained original and recent turns as the authoritative context.`,
              }],
            },
            ...contents.slice(trimEnd),
          ]);
          console.log(`[AgentRunner] Compacted ${trimEnd - trimStart} middle turns (${contents.length} total)`);
        }
      }

      yield {
        type: 'status',
        text: `${agentName} is thinking...`,
        agentId: config.agentId,
        agentName,
        timestamp: Date.now(),
      };

      let providerAttempts = 0;
      let totalToolCalls = 0;
      let generateConfig: any = null; // Hoisted so catch block can inspect/modify it
      let thinkingConfigDisabled = false;
      let cacheRecoveryAttempts = 0;
      let hadSuccessfulModelResponse = false;
      let completedNaturally = false;
      let iterationsStarted = 0;
      let modelRequestStarted = false;
      const configuredRetries = getApiRetries(config.runtimeSettings || {
        apiRetries: config.pinnedContext?.maxRetries,
      });
      const maxProviderAttempts = Math.max(1, geminiKeyPool.length) * (configuredRetries + 1);
      let lastObservedContextInputTokens = 0;

      // ReAct loop
      for (let iteration = 0; iteration < maxIter; iteration++) {
        iterationsStarted++;
        modelRequestStarted = false;
        if (this.cancelled) {
          yield { type: 'status', text: 'Cancelled by user.', timestamp: Date.now() };
          break;
        }

        try {
          const supportsThinking = modelSupportsThinking(resolvedModel);
          // Builder tools are intentionally mutable. Finalized custom agents
          // are normally stable, but may explicitly attach agent_tool_load;
          // when that changes the real surface, move to the matching
          // content-addressed cache variant before the next model turn.
          if (this.runtimeKind === 'agent_builder') {
            const nextSystemInstruction = this.buildSystemInstruction(currentRequest);
            const nextFuncDecls = this.buildFunctionDeclarations(currentRequest);
            const nextSurfaceSignature = `${nextSystemInstruction}\0${nextFuncDecls.map(tool => tool.name).join('\0')}`;
            const currentSurfaceSignature = `${systemInstruction}\0${funcDecls.map(tool => tool.name).join('\0')}`;
            if (nextSurfaceSignature !== currentSurfaceSignature) {
              systemInstruction = nextSystemInstruction;
              funcDecls = nextFuncDecls;
              customAgentCachedContent = await getOrCreateAgentCache(
                ai,
                effectiveApiKey,
                resolvedModel,
                systemInstruction,
                funcDecls,
              ).catch(() => null);
            }
          } else {
            const nextSurfaceSignature = this.resolvedTools.map(tool => tool.name).join('\0');
            if (nextSurfaceSignature !== resolvedToolSurfaceSignature) {
              systemInstruction = this.buildSystemInstruction(currentRequest);
              funcDecls = this.buildFunctionDeclarations(currentRequest);
              resolvedToolSurfaceSignature = nextSurfaceSignature;
              customAgentCachedContent = await getOrCreateAgentCache(
                ai,
                effectiveApiKey,
                resolvedModel,
                systemInstruction,
                funcDecls,
              ).catch(() => null);
            }
          }
          contents = compactStaleGeminiHistory(contents, currentRequest);
          contents = rollGeminiHistory(contents, '');

          const contextEvents: any[] = [];
          try {
            const compacted = await compactContextAtBoundary({
              chatId: compactionScopeId,
              kind: 'gemini',
              contents,
              systemInstruction,
              tools: funcDecls,
              activeModel: { provider: 'gemini', modelId: resolvedModel },
              rawSettings: config.pinnedContext?.contextCompaction,
              contextWindowOverride: config.pinnedContext?.contextCompaction?.activeContextWindow,
              runtimeSettings: config.runtimeSettings,
              providerReportedInputTokens: lastObservedContextInputTokens,
              abortSignal: runAbortController.signal,
              semanticBoundary: 'safe',
              onEvent: event => contextEvents.push(event),
            });
            if (compacted.compacted) {
              contents = normalizeConversationTurns(compacted.contents);
              lastObservedContextInputTokens = compacted.usage.usedTokens;
            }
          } catch {
            // The request can continue with the original history. The durable
            // compactor already retains recovery archives for failed attempts.
          }
          for (const event of contextEvents) {
            yield { ...event, agentId: config.agentId, agentName } as AgentRunnerEvent;
          }

          generateConfig = {
            model: resolvedModel,
            contents,
            config: {
              ...(customAgentCachedContent
                ? { cachedContent: customAgentCachedContent }
                : { systemInstruction }),
              temperature: config.temperature ?? 0.4,
              abortSignal: runAbortController.signal,
            },
          };

          // Only add thinkingConfig for models that support it
          if (supportsThinking && !thinkingConfigDisabled) {
            const level = config.pinnedContext?.thinkingLevel || config.pinnedContext?.selectedThinkingLevel || 'medium';
            let budget = 2048;
            if (level === 'low') budget = 1024;
            else if (level === 'high') budget = 4096;
            else if (level === 'max') budget = 8192;
            generateConfig.config.thinkingConfig = { thinkingBudget: budget };
          }

          // Add tools if we have any
          if (funcDecls.length > 0 && !customAgentCachedContent) {
            generateConfig.config.tools = [{ functionDeclarations: funcDecls }];
          }

          writeRuntimeTrace('request_token_budget', {
            provider: 'gemini',
            model: resolvedModel,
            runtime: this.runtimeKind,
            cacheActive: Boolean(customAgentCachedContent),
            ...estimateRequestTokenBudget({
              system: systemInstruction,
              tools: funcDecls,
              messages: contents,
            }),
          });

          modelRequestStarted = true;
          const responseStream = await ai.models.generateContentStream(generateConfig);
          const streamedParts: any[] = [];
          let latestCandidate: any = null;
          let latestUsageMetadata: any = null;
          let streamedThought = false;
          let accumulatedThought = '';
          let thoughtStartTime = 0;
          const thoughtId = `thought_${ config.agentId }_${ iteration + 1 }`;
          let bufferedVisibleText = '';
          for await (const chunk of responseStream as any) {
            latestCandidate = chunk?.candidates?.[0] || latestCandidate;
            latestUsageMetadata = chunk?.usageMetadata || latestUsageMetadata;
            const parts = latestCandidate?.content?.parts || [];
            for (const part of parts) {
              streamedParts.push(part);
              if (part.thought && part.text) {
                streamedThought = true;
                if (!thoughtStartTime) thoughtStartTime = Date.now();
                accumulatedThought = mergeStreamingText(accumulatedThought, String(part.text), true);
                yield {
                  type: 'thought_stream',
                  text: accumulatedThought,
                  isDelta: false,
                  isStreaming: true,
                  thoughtId,
                  startTime: thoughtStartTime,
                  endTime: Date.now(),
                  agentName,
                  timestamp: Date.now(),
                };
              } else if (part.text && !part.thought) {
                // Buffer visible text until the response boundary is known.
                // Text accompanying a function call is a work note, not a
                // final answer, and cannot be retracted by this event protocol.
                bufferedVisibleText = mergeStreamingText(bufferedVisibleText, String(part.text), true);
              }
            }
          }
          // From this point onward the provider request has completed. Any
          // error while executing tools or assembling the next turn must not
          // spend another API-key route or replay work.
          modelRequestStarted = false;
          if (accumulatedThought) {
            const endedAt = Date.now();
            yield {
              type: 'thought_stream',
              text: accumulatedThought,
              isDelta: false,
              isStreaming: false,
              streamState: 'closed',
              final: true,
              thoughtId,
              startTime: thoughtStartTime,
              endTime: endedAt,
              agentName,
              timestamp: endedAt,
            };
          }
          const response: any = {
            candidates: [{
              ...(latestCandidate || {}),
              content: { ...(latestCandidate?.content || {}), parts: streamedParts },
            }],
          };
          if (latestUsageMetadata) {
            const normalizedUsage = normalizeProviderCacheUsage('gemini', latestUsageMetadata);
            lastObservedContextInputTokens = Number(
              normalizedUsage.inputTokens || latestUsageMetadata.promptTokenCount || lastObservedContextInputTokens,
            );
            if (Number(normalizedUsage.totalTokens || 0) > 0) {
              yield {
                type: 'model_usage',
                usageId: `usage_gemini_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                source: 'provider',
                provider: 'gemini',
                model: resolvedModel,
                ...normalizedUsage,
                interaction: iteration + 1,
                agentName,
                timestamp: Date.now(),
              } as any;
            }
          }
          const candidate = response?.candidates?.[0];
          if (!Array.isArray(candidate?.content?.parts) || candidate.content.parts.length === 0) {
            // Check for safety/blocking reasons
            const finishReason = candidate?.finishReason;
            if (finishReason === 'SAFETY') {
              yield { type: 'error', text: 'Response was blocked by safety filters. Try rephrasing your request.', timestamp: Date.now() };
            } else {
              yield {
                type: 'error',
                text: finishReason
                  ? `The model returned no content (finish reason: ${String(finishReason)}).`
                  : 'The model returned an empty response before Agent Builder could run a tool.',
                timestamp: Date.now(),
              };
            }
            break;
          }

          hadSuccessfulModelResponse = true;
          // Retry budgets belong to one model request. Once a response is
          // accepted, the next tool/agent turn gets a fresh full key round.
          providerAttempts = 0;
          let hasToolCalls = false;
          const toolResultParts: any[] = [];
          type FunctionCallRecord = {
            part: any;
            name: string;
            args: Record<string, unknown>;
            providerCallId?: string;
            uiToolCallId: string;
          };
          const functionCalls: FunctionCallRecord[] = [];
          const responseHasToolCalls = candidate.content.parts.some((part: any) => !!part.functionCall);
          let visibleTextEmitted = false;
          if (bufferedVisibleText) {
            visibleTextEmitted = true;
            yield responseHasToolCalls
              ? {
                  type: 'work_note',
                  text: bufferedVisibleText.substring(0, 500),
                  agentName,
                  timestamp: Date.now(),
                }
              : {
                  type: 'text',
                  text: bufferedVisibleText,
                  agentName,
                  timestamp: Date.now(),
                };
          }

          if (responseHasToolCalls && !bufferedVisibleText.trim()) {
            const calls = candidate.content.parts.filter((part: any) => part?.functionCall).map((part: any) => part.functionCall);
            const labels = calls.map((call: any) => String(call?.args?.uiActionText || '').trim()).filter(Boolean);
            const fallback = labels.length > 0
              ? `I’m ${labels.slice(0, 2).map((label: string) => label.charAt(0).toLowerCase() + label.slice(1)).join(labels.length > 1 ? ' and ' : '')}.`
              : 'I’m moving into the next concrete action now and will check the result before continuing.';
            yield {
              type: 'work_note',
              text: fallback,
              agentName,
              timestamp: Date.now(),
            };
          }

          for (const part of candidate.content.parts) {
            // Native thought parts stay private. In particular, never recast a
            // non-streamed provider thought as a user-visible status message.

            // Text response
            if (part.text && !part.thought && !visibleTextEmitted) {
              yield { type: 'text', text: part.text, agentName, timestamp: Date.now() };
            }

            // Function call
            if (part.functionCall) {
              hasToolCalls = true;
              totalToolCalls++;
              const { name, args } = part.functionCall;
              const toolCallId = String(
                part.functionCall.id
                || `tool_call_${config.agentId}_${iteration + 1}_${totalToolCalls}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              );

              functionCalls.push({
                part,
                name: String(name || ''),
                args: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
                providerCallId: part.functionCall.id ? String(part.functionCall.id) : undefined,
                uiToolCallId: toolCallId,
              });
            }
          }

          if (functionCalls.length > 0) {
            // Publish the complete action group before execution starts so
            // concurrent calls are visible together in the timeline.
            for (const call of functionCalls) {
              yield {
                type: 'tool_call',
                toolName: call.name,
                toolCallId: call.uiToolCallId,
                toolArgs: call.args,
                agentName,
                timestamp: Date.now(),
              };
            }

            type RunningToolCall = {
              call: FunctionCallRecord;
              sideEvents: AgentRunnerEvent[];
              promise: Promise<void>;
              isSettled: () => boolean;
              getResult: () => unknown;
            };
            const callResults = new Map<FunctionCallRecord, unknown>();

            const startToolCall = (call: FunctionCallRecord): RunningToolCall => {
              const sideEvents: AgentRunnerEvent[] = [];
              let settled = false;
              let result: unknown;
              const promise = (async () => {
                const pushSideEvent = (trace: any) => {
                  if (!trace || typeof trace !== 'object') return;
                  sideEvents.push({
                    ...trace,
                    type: trace.type || 'status',
                    ownerTraceId: trace.ownerTraceId || call.uiToolCallId,
                    agentId: config.agentId,
                    agentName,
                    timestamp: Number(trace.timestamp || Date.now()),
                  } as AgentRunnerEvent);
                };
                const toolAbortController = new AbortController();
                const abortTool = () => toolAbortController.abort();
                runAbortController.signal.addEventListener('abort', abortTool, { once: true });
                const toolTimeoutMs = this.resolveToolTimeoutMs(call.name, call.args);
                let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                try {
                  const execPromise = this.executeToolSafe(
                    call.name,
                    call.args,
                    config,
                    pushSideEvent,
                    toolAbortController.signal,
                  );
                  if (toolTimeoutMs === null) {
                    result = await execPromise;
                  } else {
                    const timeoutPromise = new Promise<never>((_, reject) => {
                      timeoutHandle = setTimeout(() => {
                        toolAbortController.abort();
                        reject(new Error(`Tool "${call.name}" timed out after ${toolTimeoutMs / 1000}s`));
                      }, toolTimeoutMs);
                    });
                    result = await Promise.race([execPromise, timeoutPromise]);
                  }
                } catch (err: any) {
                  result = { error: err?.message || 'Tool execution failed' };
                } finally {
                  if (timeoutHandle) clearTimeout(timeoutHandle);
                  runAbortController.signal.removeEventListener('abort', abortTool);
                  settled = true;
                }
              })();

              return {
                call,
                sideEvents,
                promise,
                isSettled: () => settled,
                getResult: () => result,
              };
            };

            const runBatch = async function* (calls: FunctionCallRecord[]): AsyncGenerator<AgentRunnerEvent> {
              const running = calls.map(startToolCall);
              const pending = new Set(running);

              while (pending.size > 0) {
                for (const run of running) {
                  for (const event of run.sideEvents.splice(0, run.sideEvents.length)) yield event;
                }

                await Promise.race([
                  Promise.race(Array.from(pending, run => run.promise)),
                  new Promise(resolve => setTimeout(resolve, 50)),
                ]);
                for (const run of Array.from(pending)) {
                  if (run.isSettled()) pending.delete(run);
                }
              }

              for (const run of running) {
                for (const event of run.sideEvents.splice(0, run.sideEvents.length)) yield event;
                callResults.set(run.call, run.getResult());
              }
            };

            const askUserCall = functionCalls.find(call => call.name === 'ask_user');
            if (askUserCall) {
              // ask_user is blocking and exclusive; defer siblings until the
              // next model turn has the user's answer.
              for (const call of functionCalls) {
                if (call !== askUserCall) {
                  callResults.set(call, {
                    success: false,
                    deferred: true,
                    error: 'Deferred because ask_user is a blocking user question. Use the user answer before deciding the next tool call.',
                  });
                }
              }
              for await (const event of runBatch([askUserCall])) yield event;
            } else {
              const { parallel, ordered } = splitLeadingParallelToolCalls(functionCalls);
              if (parallel.length > 1) {
                console.log(`[AgentRunner] Executing ${parallel.length} independent tools in parallel: ${parallel.map(call => call.name).join(', ')}`);
              }
              if (parallel.length > 0) {
                for await (const event of runBatch(parallel)) yield event;
              }
              for (const call of ordered) {
                for await (const event of runBatch([call])) yield event;
              }
            }

            // Keep provider responses in call order even when executions finish
            // out of order, which preserves Gemini's function-call contract.
              const individuallyBoundedResults = functionCalls.map(call =>
                toolResultCompactor.compact(call.name, call.args, callResults.get(call))
              );
              const providerToolResults = toolResultCompactor.compactBatch(
                functionCalls.map(call => call.name),
                functionCalls.map(call => call.args),
                individuallyBoundedResults,
              );
              for (let callIndex = 0; callIndex < functionCalls.length; callIndex++) {
                const call = functionCalls[callIndex];
                const result = callResults.get(call);
              yield {
                type: 'tool_result',
                toolName: call.name,
                toolCallId: call.uiToolCallId,
                toolResult: result,
                agentName,
                timestamp: Date.now(),
              };
              toolResultParts.push({
                functionResponse: {
                  name: call.name,
                  response: { result: serializeToolResult(providerToolResults[callIndex], 14000) },
                  ...(call.providerCallId ? { id: call.providerCallId } : {}),
                },
              });
            }
          }

          // If there were tool calls, add the assistant turn + tool results and continue
          if (hasToolCalls && toolResultParts.length > 0) {
            contents.push({ role: 'model', parts: candidate.content.parts as any });
            contents.push({ role: 'user' as any, parts: toolResultParts as any });

            yield {
              type: 'status',
              text: `${agentName} processed ${totalToolCalls} tool call${totalToolCalls > 1 ? 's' : ''} (iteration ${iteration + 1}${Number.isFinite(maxIter) ? `/${maxIter}` : ''})`,
              agentName,
              timestamp: Date.now(),
            };
            continue; // Next iteration
          }

          // No tool calls — agent is done
          completedNaturally = true;
          break;

        } catch (err: any) {
          const errMsg = String(err.message || err);
          const lowerErrMsg = errMsg.toLowerCase();

          const cachedContentRejected = Boolean(customAgentCachedContent)
            && (lowerErrMsg.includes('cachedcontent') || lowerErrMsg.includes('cached_content'))
            && (
              lowerErrMsg.includes('not found')
              || lowerErrMsg.includes('404')
              || lowerErrMsg.includes('permission')
              || lowerErrMsg.includes('forbidden')
              || lowerErrMsg.includes('invalid')
            );
          if (cachedContentRejected) {
            const cacheNotFound = lowerErrMsg.includes('not found') || lowerErrMsg.includes('404');
            customAgentCachedContent = cacheNotFound && cacheRecoveryAttempts < 1
              ? await handleAgentCacheNotFound(
                  ai,
                  effectiveApiKey,
                  resolvedModel,
                  systemInstruction,
                  funcDecls,
                ).catch(() => null)
              : null;
            cacheRecoveryAttempts++;
            continue;
          }

          // If the model doesn't support thinkingBudget, strip it and retry immediately
          if (
            errMsg.toLowerCase().includes('thinking budget is not supported') ||
            errMsg.toLowerCase().includes('thinkingconfig') ||
            (errMsg.includes('400') && errMsg.toLowerCase().includes('thinking'))
          ) {
            if (generateConfig?.config?.thinkingConfig) {
              delete generateConfig.config.thinkingConfig;
              thinkingConfigDisabled = true;
              console.warn(`[AgentRunner] thinkingConfig not supported by model "${generateConfig.model}" — retrying without it`);
              continue;
            }
          }

          // Detect schema/declaration errors specifically
          if (errMsg.includes('Invalid JSON payload') || errMsg.includes('function_declarations')) {
            yield {
              type: 'error',
              text: `Tool schema error: ${errMsg.substring(0, 300)}. This usually means a tool parameter type is not supported by the Gemini API.`,
              timestamp: Date.now(),
            };
            console.error(`[AgentRunner] Schema error for ${agentName}:`, errMsg);
            // Log the problematic declarations for debugging
            console.error(`[AgentRunner] Declarations:`, JSON.stringify(funcDecls.map((d: any) => ({
              name: d.name,
              hasParams: !!d.parameters,
              paramKeys: d.parameters ? Object.keys(d.parameters.properties || {}) : [],
            }))));
            break; // Schema errors are not transient
          }

          // Transient errors — exponential backoff
          if (!modelRequestStarted || !isProviderFailoverError(err)) {
            yield { type: 'error', text: `Iteration ${iteration}: ${errMsg.substring(0, 300)}`, timestamp: Date.now() };
            break;
          }

          providerAttempts++;
          if (providerAttempts >= maxProviderAttempts) {
            yield {
              type: 'error',
              text: `All ${maxProviderAttempts} configured API route attempts failed. Last error: ${errMsg.substring(0, 240)}`,
              timestamp: Date.now(),
            };
            break;
          }

          const keyCount = Math.max(1, geminiKeyPool.length);
          const nextKeyIndex = providerAttempts % keyCount;
          const previousKey = effectiveApiKey;
          effectiveApiKey = geminiKeyPool[nextKeyIndex] || previousKey;
          if (effectiveApiKey !== previousKey) {
            ai = new GoogleGenAI({ apiKey: effectiveApiKey });
            customAgentCachedContent = null;
            cacheRecoveryAttempts = 0;
          }

          const completedRound = providerAttempts % keyCount === 0;
          yield {
            type: 'status',
            text: completedRound
              ? `All configured API routes failed; starting retry round ${Math.floor(providerAttempts / keyCount) + 1}.`
              : `API route ${providerAttempts + 1} of ${maxProviderAttempts} failed; trying the next configured route.`,
            timestamp: Date.now(),
          };
          if (completedRound) {
            await waitForApiRetry(Math.floor(providerAttempts / keyCount), runAbortController.signal);
          }
          continue;
        }
      }

      if (
        Number.isFinite(maxIter) &&
        iterationsStarted >= maxIter &&
        !completedNaturally &&
        totalToolCalls > 0 &&
        !this.cancelled
      ) {
        yield {
          type: 'error',
          text: `${agentName} reached the ${maxIter}-iteration safety limit before producing a final response.`,
          agentName,
          timestamp: Date.now(),
        };
      }
      if (ownsLease && hadSuccessfulModelResponse) apiKeyPool.reportSuccess(sessionId);
      yield { type: 'done', agentName, agentId: config.agentId, timestamp: Date.now() };

    } finally {
      upstreamAbortSignal?.removeEventListener('abort', abortFromUpstream);
      if (ownsLease) apiKeyPool.releaseKey(sessionId);
      if (this.cancelController === runAbortController) this.cancelController = null;
    }
  }

  /**
   * Execute a tool safely — resolves from local tools first, then global registry.
   * Catches all errors and returns structured results.
   */
  private resolveToolTimeoutMs(toolName: string, args: any): number | null {
    const requestedValue = args?.toolTimeoutSeconds
      ?? args?.timeoutSeconds
      ?? (toolName === 'wait_timer' ? args?.seconds : undefined);
    if (requestedValue === undefined || requestedValue === null || requestedValue === '') return null;
    const requestedSeconds = Number(requestedValue);
    if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) return null;
    return requestedSeconds * 1000 + 30_000;
  }

  private async executeToolSafe(
    toolName: string,
    args: any,
    config: AgentRunnerConfig,
    onTrace?: (trace: any) => void,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    const agentId = config.agentId;
    const chatId = config.chatId || `custom-agent-${agentId}`;

    let workspaceRoot = getPathResolverInfo().desktopPath;
    let paths = [workspaceRoot];
    let allowedPaths = [workspaceRoot];
    let sandboxGuard: any = null;
    let isFocusedWorkspace = false;

    if (config.runLocation === 'sandbox') {
      try {
        const { WorkspaceManager } = require('./workspace/manager');
        const workspace = new WorkspaceManager('user', chatId);
        await workspace.initialize();
        const baseSandboxPath = workspace.getSandboxPath();

        const { createSandboxSession, initializeSandbox, createSandboxGuard } = require('../sandbox');
        const sandboxSession = createSandboxSession({
          tenantId: 'local',
          userId: 'user',
          projectId: chatId,
          sessionId: chatId,
          workspaceRoot: baseSandboxPath,
          network: 'deny',
        });
        await initializeSandbox(sandboxSession);
        workspaceRoot = sandboxSession.root;
        paths = [workspaceRoot];
        allowedPaths = [workspaceRoot];

        // Create the enterprise SandboxGuard and attach later to context
        sandboxGuard = createSandboxGuard(sandboxSession);
        await sandboxGuard.audit({ type: 'sandbox.guard.created', agentId, sandboxRoot: workspaceRoot });
      } catch (e) {
        console.error('Failed to initialize sandbox workspace for agent runner:', e);
      }
    } else {
      const customWorkspace = config.pinnedContext?.workspacePath || config.pinnedContext?.paths?.[0];
      if (customWorkspace) {
        const resolvedCustom = path.resolve(customWorkspace);
        try {
          const customStat = fs.existsSync(resolvedCustom) ? fs.statSync(resolvedCustom) : null;
          // A pinned path can be a file or a folder. Terminal cwd must
          // always be the containing directory for file pins. Preserve a
          // missing explicit path too, so a stale chat fails in its own
          // workspace instead of silently executing on the desktop.
          workspaceRoot = customStat && !customStat.isDirectory() ? path.dirname(resolvedCustom) : resolvedCustom;
          paths = [workspaceRoot];
          allowedPaths = [workspaceRoot];
          isFocusedWorkspace = !!config.pinnedContext?.isFocusedWorkspace;
        } catch {}
      }
    }

    const isSandboxRun = config.runLocation === 'sandbox';
    const networkDenied = isSandboxRun || (config.pinnedContext?.networkPolicy === 'deny' && config.pinnedContext?.allowNetwork !== true);
    const localAllowedCapabilities = Array.from(new Set([
      ...DEFAULT_MAIN_AGENT_ALLOWED_CAPABILITIES,
      'command.raw',
      'vcs.local',
    ])).filter(capability => {
      if (networkDenied && capability.startsWith('network.')) return false;
      if (config.pinnedContext?.allowBrowserControl === false && capability === 'browser.control') return false;
      if (config.pinnedContext?.allowDynamicCode === false && capability === 'code.dynamic') return false;
      if (config.pinnedContext?.allowAgentSpawning === false && capability === 'agent.spawn') return false;
      if (config.pinnedContext?.allowRawCommand === false && capability === 'command.raw') return false;
      if (config.pinnedContext?.allowVcs === false && capability === 'vcs.local') return false;
      return true;
    });

    const context = {
      agentId,
      agentRuntime: this.runtimeKind === 'agent_builder'
        ? AGENT_BUILDER_RUNTIME
        : ('custom_agent' as const),
      agentName: config.pinnedContext?.agentName || this.profile?.name || agentId,
      agentRunner: this,
      projectId: chatId,
      chatId,
      conversationScopeId: chatId,
      agentSessionId: config.agentSessionId || '',
      workspaceRoot,
      workspacePath: workspaceRoot,
      paths,
      allowedPaths,
      isFocusedWorkspace,
      runLocation: isSandboxRun ? 'sandbox' : 'local',
      terminalShell: config.pinnedContext?.terminalShell || 'auto',
      sandboxGuard: sandboxGuard || undefined,
      allowedCapabilities: isSandboxRun
        ? ['command.workspace', 'filesystem.read', 'filesystem.write', 'tool.utility', 'memory.manage']
        : localAllowedCapabilities,
      allowBrowserControl: isSandboxRun ? false : config.pinnedContext?.allowBrowserControl !== false,
      networkPolicy: networkDenied ? 'deny' : 'allow',
      allowNetwork: !networkDenied,
      allowAgentSpawning: isSandboxRun ? false : config.pinnedContext?.allowAgentSpawning !== false,
      allowHostControl: isSandboxRun
        ? false
        : config.pinnedContext?.allowHostControl === true && config.pinnedContext?.computerUseEnabled !== false,
      allowExternalCommunication: isSandboxRun ? false : config.pinnedContext?.allowExternalCommunication === true,
      userInitiatedCommunication: this.userInitiatedCommunication,
      userId: 'user',
      selfImprovementEnabled: resolveSelfImprovementEnabled(config.pinnedContext?.selfImprovementEnabled),
      allowDynamicCode: isSandboxRun ? false : config.pinnedContext?.allowDynamicCode !== false,
      allowRawCommand: isSandboxRun ? false : config.pinnedContext?.allowRawCommand !== false,
      allowVcs: isSandboxRun ? false : config.pinnedContext?.allowVcs !== false,
      maxSubAgents: config.pinnedContext?.maxSubAgents,
      maxRetries: config.pinnedContext?.maxRetries,
      _onTrace: onTrace,
      abortSignal: abortSignal || this.cancelController?.signal,
      signal: abortSignal || this.cancelController?.signal,
      isCancelled: () => this.cancelled || abortSignal?.aborted === true || this.cancelController?.signal.aborted === true,
    };
    const canonicalToolName = normalizeRegistryToolName(toolName);
    const registryTool = globalToolRegistry.getTool(canonicalToolName);
    let effectiveArgs = normalizeRegistryToolArgs(canonicalToolName, args);

    if (registryTool) {
      const validation = validateRegistryToolArgs(registryTool, effectiveArgs);
      if (!validation.success) return { error: validation.error };
      effectiveArgs = validation.args;

      const capabilityDecision = enforceToolCapability(canonicalToolName, effectiveArgs, context);
      if (!capabilityDecision.allowed) {
        return { error: capabilityDecision.reason || `Tool ${canonicalToolName} is not allowed` };
      }
    }

    const editTargets = canonicalToolName === 'workspace_edit_file'
      ? (Array.isArray(effectiveArgs?.files) ? effectiveArgs.files : effectiveArgs?.filename ? [effectiveArgs] : [])
        .map((target: any) => {
          const requestedPath = String(target?.filename || '').trim();
          if (!requestedPath) return null;
          return {
            requestedPath,
            filePath: path.isAbsolute(requestedPath) ? path.normalize(requestedPath) : path.resolve(workspaceRoot, requestedPath),
          };
        })
        .filter(Boolean) as Array<{ requestedPath: string; filePath: string }>
      : [];
    const preEditSnapshots = new Map<string, { existed: boolean; content?: string }>();
    for (const target of editTargets) {
      try {
        const existed = fs.existsSync(target.filePath);
        const stat = existed ? fs.statSync(target.filePath) : null;
        const content = stat?.isFile() && stat.size <= 5_000_000 ? fs.readFileSync(target.filePath, 'utf8') : undefined;
        preEditSnapshots.set(target.filePath, { existed, content });
      } catch {
        preEditSnapshots.set(target.filePath, { existed: false });
      }
    }

    const emitEditPreviews = async (result: any) => {
      if (canonicalToolName !== 'workspace_edit_file' || !result) return;
      const created = new Set((Array.isArray(result.filesCreated) ? result.filesCreated : []).map((value: unknown) => path.normalize(String(value)).toLowerCase()));
      const deleted = new Set((Array.isArray(result.filesDeleted) ? result.filesDeleted : []).map((value: unknown) => path.normalize(String(value)).toLowerCase()));
      const fileOperationResult = {
        filesModified: Array.isArray(result.filesModified) ? result.filesModified : [],
        filesCreated: Array.isArray(result.filesCreated) ? result.filesCreated : [],
        filesDeleted: Array.isArray(result.filesDeleted) ? result.filesDeleted : [],
        errors: Array.isArray(result.errors) ? result.errors : [],
        changes: Array.isArray(result.changes) ? result.changes : [],
        rolledBack: Boolean(result.rolledBack),
        operation: result.operation,
      };

      for (const target of editTargets) {
        const normalizedPath = path.normalize(target.filePath).toLowerCase();
        const snapshot = preEditSnapshots.get(target.filePath);
        const wasCreated = created.has(normalizedPath) || snapshot?.existed === false;
        const wasDeleted = deleted.has(normalizedPath);
        let afterContent = '';
        if (!wasDeleted) {
          try {
            const stat = fs.existsSync(target.filePath) ? fs.statSync(target.filePath) : null;
            if (stat?.isFile() && stat.size <= 5_000_000) afterContent = fs.readFileSync(target.filePath, 'utf8');
          } catch {}
        }

        const rawDiff = snapshot?.content !== undefined
          ? buildLineDiffPreview(snapshot.content, wasDeleted ? '' : afterContent)
          : null;
        const diffLines = wasDeleted && rawDiff
          ? rawDiff.diffLines.filter(line => line.type !== 'added')
          : wasCreated && afterContent
            ? afterContent.split(/\r?\n/).slice(0, 2_000).map((line, index) => ({ type: 'added' as const, content: line, newLine: index + 1 }))
            : rawDiff?.diffLines || [];
        const linesAdded = wasCreated
          ? (afterContent ? afterContent.split(/\r?\n/).length : 0)
          : diffLines.filter(line => line.type === 'added').length;
        const linesRemoved = diffLines.filter(line => line.type === 'removed').length;

        onTrace?.({
          type: 'file_preview',
          filename: path.basename(target.requestedPath),
          filepath: target.filePath,
          content: afterContent.length <= 500_000 ? afterContent : '',
          lineCount: afterContent ? afterContent.split(/\r?\n/).length : 0,
          totalLines: afterContent ? afterContent.split(/\r?\n/).length : 0,
          truncated: afterContent.length > 500_000,
          linesAdded,
          linesRemoved,
          diffLines,
          isEdit: !wasCreated && !wasDeleted,
          operation: wasDeleted ? 'deleted' : wasCreated ? 'created' : 'edited',
          fileOperationResult,
          dedupe: false,
          timestamp: Date.now(),
        });
      }
    };

    const toolExec = createToolExecutionContext(context, onTrace);
    // Priority 1: Resolved tool from agent profile
    try {
      toolExec.throwIfCancelled();
      const resolvedTool = this.resolvedTools.find(t => t.name === canonicalToolName);
      if (resolvedTool?.execute) {
        const result = await resolvedTool.execute(effectiveArgs, toolExec.context);
        toolExec.throwIfCancelled();
        await emitEditPreviews(result);
        return result;
      }

      // Priority 2: Global tool registry
      const regTool = registryTool || globalToolRegistry.getTool(toolName);
      if (regTool?.execute) {
        const result = await regTool.execute(effectiveArgs, toolExec.context);
        toolExec.throwIfCancelled();
        await emitEditPreviews(result);
        return result;
      }

      return { error: `Tool "${toolName}" not found. Available tools: ${this.resolvedTools.map(t => t.name).join(', ')}` };
    } catch (error: any) {
      if (isToolCancellationError(error) || toolExec.signal.aborted) {
        return { error: 'CANCELLED_BY_USER', cancelled: true };
      }
      throw error;
    } finally {
      toolExec.dispose();
    }
  }
}

/**
 * Deep-clean a JSON schema for strict Gemini API compatibility.
 *
 * Gemini function declarations only support a narrow subset of JSON Schema:
 *   - type: STRING | NUMBER | INTEGER | BOOLEAN | OBJECT | ARRAY
 *   - properties (for OBJECT)
 *   - items (for ARRAY)
 *   - description
 *   - enum
 *   - required
 *   - nullable
 *
 * Everything else — $schema, additionalProperties, default, format, examples,
 * $ref, items, required, anyOf, oneOf, allOf, patternProperties, minItems,
 * maxItems, minimum, maximum, pattern — must be stripped or the API returns 400.
 *
 * Arrays retain their item schema so generated arguments match runtime
 * validation.
 */
const GEMINI_BLOCKED_KEYS = new Set([
  '$schema', '$ref', '$id', '$comment', '$defs', 'definitions',
  'additionalProperties', 'additionalItems', 'patternProperties',
  'default', 'format', 'examples', 'example',
  'prefixItems',
  'anyOf', 'oneOf', 'allOf', 'if', 'then', 'else', 'not',
  'minItems', 'maxItems', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'pattern', 'const',
  'contentMediaType', 'contentEncoding',
  'readOnly', 'writeOnly', 'deprecated',
  'title', // Gemini uses description, not title
]);

function cleanSchemaForGemini(schema: any, depth = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 8) {
    return schema;
  }

  // Handle array type → downgrade to STRING with hint
  if (schema.type === 'array') {
    return {
      type: 'ARRAY',
      items: cleanSchemaForGemini(schema.items || { type: 'string' }, depth + 1),
      ...(schema.description ? { description: String(schema.description).substring(0, 400) } : {}),
      ...(schema.nullable ? { nullable: true } : {}),
    };
  }

  // Handle union types (anyOf/oneOf) → pick the first non-null type
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const union: any[] = schema.anyOf || schema.oneOf;
    const nonNull = union.find((s: any) => s?.type !== 'null' && s?.type);
    if (nonNull) return cleanSchemaForGemini(nonNull, depth + 1);
    return { type: 'STRING', description: schema.description || '' };
  }

  const cleaned: any = {};

  for (const [key, value] of Object.entries(schema)) {
    // Skip blocked keys
    if (GEMINI_BLOCKED_KEYS.has(key)) continue;

    // Normalize type names to Gemini format
    if (key === 'type') {
      const t = String(value).toUpperCase();
      const TYPE_MAP: Record<string, string> = {
        STRING: 'STRING', NUMBER: 'NUMBER', INTEGER: 'INTEGER',
        BOOLEAN: 'BOOLEAN', OBJECT: 'OBJECT', ARRAY: 'ARRAY',
        NULL: 'STRING',
      };
      cleaned.type = TYPE_MAP[t] || 'STRING';
      continue;
    }

    // Recurse into properties
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      cleaned.properties = {};
      for (const [pk, pv] of Object.entries(value as Record<string, any>)) {
        // Skip property names that are pure numbers (invalid for Gemini)
        if (/^\d+$/.test(pk)) continue;
        cleaned.properties[pk] = cleanSchemaForGemini(pv, depth + 1);
      }
      // If properties is now empty, remove it
      if (Object.keys(cleaned.properties).length === 0) {
        delete cleaned.properties;
      }
      continue;
    }

    // Keep description and enum as-is (primitives)
    if (key === 'description' && typeof value === 'string') {
      cleaned.description = value.substring(0, 400);
      continue;
    }
    if (key === 'enum' && Array.isArray(value)) {
      cleaned.enum = value.filter(v => typeof v === 'string' || typeof v === 'number');
      continue;
    }
    if (key === 'required' && Array.isArray(value)) {
      cleaned.required = value.filter(v => typeof v === 'string');
      continue;
    }
    if (key === 'items' && typeof value === 'object' && value !== null) {
      cleaned.items = cleanSchemaForGemini(value, depth + 1);
      continue;
    }
    if (key === 'nullable' && typeof value === 'boolean') {
      cleaned.nullable = value;
      continue;
    }

    // Recurse into nested objects (but not arrays)
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      cleaned[key] = cleanSchemaForGemini(value, depth + 1);
    }
    // Primitive values that aren't in blocked keys — keep them
    else if (typeof value !== 'object') {
      // Only keep known safe keys
      if (['type', 'description', 'nullable'].includes(key)) {
        cleaned[key] = value;
      }
    }
  }

  if (Array.isArray(cleaned.required) && cleaned.properties) {
    cleaned.required = cleaned.required.filter((name: string) =>
      Object.prototype.hasOwnProperty.call(cleaned.properties, name)
    );
    if (cleaned.required.length === 0) delete cleaned.required;
  }

  return cleaned;
}

function addUiTraceFieldsToSchema(schema: any): any {
  const next = schema && typeof schema === 'object'
    ? { ...schema, properties: { ...(schema.properties || {}) } }
    : { type: 'OBJECT', properties: {} };

  if (!next.type) next.type = 'OBJECT';
  next.properties.uiActionText = {
    type: 'STRING',
    description: 'Professional 2-4 word timeline action label. No step numbers, brackets, code fragments, or generic filler.',
  };
  next.properties.uiIcon = {
    type: 'STRING',
    enum: ['computer', 'agent', 'terminal', 'image', 'file_read', 'file_create', 'file_edit', 'folder_read', 'folder_create', 'search', 'web_search', 'verification', 'connector'],
    description: 'Timeline icon category: computer, agent, terminal, image, file_read, file_create, file_edit, folder_read, folder_create, search, web_search, verification, or connector.',
  };
  next.required = Array.from(new Set([
    ...(Array.isArray(next.required) ? next.required : []),
    'uiActionText',
    'uiIcon',
  ]));

  return next;
}

/** Singleton for convenience */
const globalForAgentRunner = globalThis as typeof globalThis & {
  __eterxAgentRunner?: AgentRunner;
};

export const agentRunner =
  globalForAgentRunner.__eterxAgentRunner ||
  (globalForAgentRunner.__eterxAgentRunner = new AgentRunner());
