import { MODEL_REQUEST_TIMEOUT_MS } from './model-request-policy';
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
import { WORK_NOTE_POLICY } from './work-note';
import { buildTelegramBotContext } from './telegram-bot-context';
import { buildTelegramWorkNoteCue } from './telegram-bot-behavior';
import { cleanText } from './gateways/telegram-presentation.cjs';
import { buildToolAvailabilityPrompt } from './tool-availability-prompt';
import { SOURCE_READING_POLICY } from './source-read-policy';
import { schemaUsageDescription } from './tools/registry';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { apiKeyPool } from './api-key-pool';
import {
  AGENT_BUILDER_RUNTIME,
  buildAgentBuilderRuntimePrompt,
  isBuilderLiveConnectorToolName,
  isBuilderOnlyToolName,
  readAgentBuilderProfile,
  summarizeAgentBuilderProfile,
  type AgentBuilderProfile,
  readAgentFlowProfile,
} from './builder-agent';
import { agentBuilderRunFlowTool } from './tools/automation/agent_builder';
import { resolveAgentTools, type ResolvedTool } from './tool-injector';
import { globalToolRegistry, normalizeRegistryToolName } from './tools/registry';
import { normalizeRegistryToolArgs, validateRegistryToolArgs } from './tools/tool-args';
import { DEFAULT_MAIN_AGENT_ALLOWED_CAPABILITIES, enforceToolCapability } from './tools/security/tool_policy';
import { resolveWorkspacePathForContext } from './workspace/path_resolver';
import { initializeChatWorkspace, resolveChatWorkspaceContext } from './workspace/runtime-context';
import { buildRuntimePlatformPrompt } from './runtime/platform-context';
import { getRuntimeEnvironment } from './runtime/environment';
import { AGENT_EXECUTION_POLICY } from './execution-operating-policy';
import { createToolExecutionContext, isToolCancellationError } from './cancellation';
import { normalizeProviderCacheUsage, resolveProviderPromptCacheMode } from './provider-prompt-cache';
import { getOrCreateAgentCache, handleAgentCacheNotFound } from './agent-cache';
import { sanitizeGeminiHistory } from './context-hot-path';
import { toolResultCompactor } from './memory/tool-result-compactor';
import { estimateRequestTokenBudget } from './request-token-budget';
import { writeRuntimeTrace } from './runtime-trace';
import type { ScopedRuntimeSettings } from './runtime-api-keys';
import {
  getGeminiThinkingConfig,
  normalizeModelThinkingCapabilities,
  normalizeThinkingLevelForModel,
  type MainAgentMode,
} from './model-routing';
import { mergeStreamingText } from '../streaming-lifecycle';
import { adaptiveExperience, resolveSelfImprovementEnabled } from './self-improvement/engine';
import { isUserInitiatedCommunicationRequest } from './tools/communication/outbound_approval';
import { executeParallelToolCalls } from './parallel-tool-calls';
import { buildFilePreviewTraceId, buildLineDiffPreview, languageFromFilename } from './tool-trace';
import { compactContextAtBoundary } from './resilience/context-compaction';
import { openWorkingContextCheckpoint, resolveWorkingContextRequest } from './working-context-checkpoint';
import { getSearchRouteBrief } from '../search/search-runtime';
import { formatUnknownError } from './error-format';
import { getImageGenerationRouteBrief } from '../image/image-generation-runtime';
import { getVideoGenerationRouteBrief } from '../video/video-generation-runtime';
import { getApiRetries, isInterruptedProviderStream, isProviderContextLimitError, isProviderFailoverError, waitForApiRetry } from './api-retry';
import { assertSuccessfulCompatibleFinish } from './provider-capabilities';
import { getContextFabricForChat } from './context-fabric';
import { hydratePersistedConversationContext } from './conversation-context';
import { detectChatBoundaryFromHistory } from './chat-boundary';
import { CONTEXT_CONTINUITY_OPERATING_POLICY } from './context-operating-policy';

// The standalone builder endpoint can import this runner without importing
// AgentRegistry first, so ensure the complete builder tool surface is present.
import './tools/index';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface AgentRunnerEvent {
  type: 'text' | 'thought_stream' | 'work_note' | 'tool_call' | 'tool_result' | 'console_output' | 'status' | 'error' | 'done' | 'ask_user' | 'model_usage' | 'context_compaction' | 'context_usage' | 'file_preview' | 'evidence' | 'sub_agent_spawn' | 'sub_agent_complete' | 'sub_agent_error' | 'inter_agent_message';
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

function isGoogleGenAIModelName(modelName: string): boolean {
  return /^(?:models\/)?gemini[-_]/i.test(modelName.trim());
}

function resolveGeminiRunnerModel(config: AgentRunnerConfig): string {
  const requestedModel = String(config.model || '').trim();
  if (requestedModel && isGoogleGenAIModelName(requestedModel)) return requestedModel;
  throw new Error('MODEL_SELECTION_REQUIRED: select an added Gemini model before running this agent.');
}

const withContextMemoryTool = (tools: ResolvedTool[]): ResolvedTool[] => {
  if (tools.some(tool => tool.name === 'context_memory')) return tools;
  const tool = globalToolRegistry.getTool('context_memory');
  if (!tool) return tools;
  return [...tools, {
    name: tool.name,
    description: tool.description,
    declaration: { name: tool.name, description: tool.description.substring(0, 420) },
    promptGuidance: 'Read-only exact recall for older context in this same chat.',
  }];
};

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result ?? {});
  } catch {
    return String(result ?? '');
  }
}

function normalizeConversationTurns(contents: any[]): any[] {
  return sanitizeGeminiHistory(contents);
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
    this.resolvedTools = withContextMemoryTool(tools);
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
    this.resolvedTools = withContextMemoryTool(globalToolRegistry
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
      })));
    this.toolPrompt = this.resolvedTools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n');
    return this.profile;
  }

  private resolveToolsForTask(taskText = ''): ResolvedTool[] {
    void taskText;
    return this.resolvedTools;
  }

  /** Build the complete system instruction for this agent */
  private buildSystemInstruction(taskText = '', config?: AgentRunnerConfig): string {
    if (!this.profile) throw new Error('Agent not loaded');

    if (this.runtimeKind === 'agent_builder') {
      const profileSummary = summarizeAgentBuilderProfile(this.profile);
      const persistedSnapshot = JSON.stringify({
        ...profileSummary,
        professionalPrompt: this.profile.professionalPrompt,
        responseStyle: this.profile.responseStyle,
        behaviorRules: this.profile.behaviorRules,
        safetyRules: this.profile.safetyRules,
        skills: this.profile.skills,
        toolUsePolicy: this.profile.toolUsePolicy,
        completionCriteria: this.profile.completionCriteria,
        customTools: this.profile.customTools.map(tool => ({
          toolName: tool.toolName,
          description: tool.description,
          implementationType: tool.implementationType,
          safetyStatus: tool.safetyStatus,
        })),
        notes: this.profile.notes,
      }, null, 2);
      return `${buildAgentBuilderRuntimePrompt(
        this.profile.agentId,
        this.profile.name,
      )}

${buildRuntimePlatformPrompt(config?.pinnedContext?.terminalShell || 'auto')}

${CONTEXT_CONTINUITY_OPERATING_POLICY}

## Execution contract
${AGENT_EXECUTION_POLICY}

## Current persisted target profile
This snapshot is the latest authoritative configuration. Chat history explains user intent; this persisted state identifies what currently exists. A ready profile remains fully editable.
${persistedSnapshot}

## Builder execution protocol
- Persist requested profile changes through Builder tools; do not merely describe them.
- Treat each follow-up as a patch to this same target. Preserve unspecified fields and never imply finalization closed the room.
- Use agent_builder_save_profile for identity, instructions, presentation, or policy changes. Use replaceCollections only for supplied collections the user explicitly wants replaced.
- Discover relevant capabilities with agent_builder_list_capabilities, then attach only those the mission needs. Reserve agent_builder_attach_all_main_tools for an explicitly requested universal surface.
- Use agent_builder_remove_tool for actual removal; do not simulate capability changes in prose.
- Use agent_builder_attach_connector_tools for any target that must operate connected services; it attaches the on-demand channel_agent layer and the required Gateway/REST/MCP bridges with explicit live-discovery guidance.
- When connector setup or verification is part of the request, use gateway_bridge or connector_mcp directly to inspect the live runtime. Do not report a connector as ready from the UI catalog alone.
- Use agent_builder_define_tool only for a real missing capability. After a material revision, run the quality check and finalize again when the profile is complete.
- Use agent_tool_load and agent_tool_unload only when the builder itself needs a temporary registered capability.
- Report the result of each builder operation clearly, and continue until the requested setup is complete.`;
    }

    const parts: string[] = [];

    // Professional prompt (the core identity — written by the builder)
    parts.push(this.profile.professionalPrompt!);
    parts.push(`\n${buildRuntimePlatformPrompt(config?.pinnedContext?.terminalShell || 'auto')}`);
    parts.push(`\n${CONTEXT_CONTINUITY_OPERATING_POLICY}`);

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

${WORK_NOTE_POLICY}
${SOURCE_READING_POLICY}

Every tool call must include:
- uiActionText: a precise 2-4 word action label for the timeline. No step numbers, no brackets, no punctuation-heavy text, no code dumps. Examples: "Reading fetch script", "Finding dataset URL", "Running CSV inspection", "Verifying generated file".
- uiIcon: exactly one of computer, agent, terminal, image, file_read, file_create, file_edit, folder_read, folder_create, search, web_search, verification, connector. Use connector for a connected external service and keep connector_id, platform, or channel in the tool arguments when available.

Use file_read for reading files, file_create for creating files, file_edit for editing files, terminal for commands, folder_read for directory listing, search for local/code searches, web_search for web lookup, and verification for checks/tests.`);

    parts.push(`
## Final response judgment

- Adapt to the user's intent, audience, context, and requested depth. Preserve this agent's specialist deliverable requirements; these principles guide ordinary replies without imposing a template.
- Answer the current request, using history to resolve references and retain constraints. Do not repeat earlier completed work as a new accomplishment or treat every question, example, or correction as a completion report.
- Lead with the answer or useful result, then explain what the user needs to understand or use it. Prefer connected paragraphs in plain language; be brief for a simple result and thorough when the explanation requires it.
- Use bullets for parallel points, numbering when order matters, and short sentence-case headings only when substantial separate topics need navigation. Do not repeat the request as a large title or force Summary, Changes, Verification, Next Steps, or Conclusion sections.
- Use a table only when items share attributes that are easier to compare in rows and columns, or when requested. Keep cells concise and leave explanations, procedures, code, and derivations outside tables. A few facts or file changes do not need a table.
- Use diagrams when they clarify relationships or flow, or when requested. Write Mermaid in a mermaid-tagged fence with valid syntax, quoted complex labels, and a readable layout. Do not rely on renderer repairs or duplicate the diagram in a table or prose.
- Use bold sparingly, inline code for literal code or commands, and language-tagged fences for code blocks. Keep Markdown spacing valid. Avoid decorative formatting, filler, repeated summaries, and generic closing offers.
- Keep ordinary replies professional: do not add emojis, emoji bullets, decorative icons, ornamental Unicode, or celebratory badges unless explicitly requested or faithfully quoting supplied content. Use plain words for status and emphasis.
- Ground claims in evidence; distinguish findings from assumptions and preserve material uncertainty. Explain what changed and why, with verification or limitations only when relevant. Do not invent actions or results.
- Link a known local deliverable once as [filename](#eterx-local-file:<URL-encoded-absolute-path>); never expose or repeat a raw path.
- Use the exact local path returned by a successful tool result. Never invent sandbox:/mnt/data links, download URLs, or web addresses for local files. If the output path is unknown, say so instead of fabricating a link.
- End when the answer is complete. Include a next action only when it helps the user use the result or resolve an actual blocker.`);

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
    parts.push(`\n## Execution contract\n${AGENT_EXECUTION_POLICY}\nKeep the mission of "${this.profile.name || this.profile.agentId}" and preserve the user's authority over consequential actions.`);

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
Workspace: ${resolveChatWorkspaceContext(config?.chatId || 'custom-agent-' + (config?.agentId || 'agent'), 'default', config?.pinnedContext).workspacePath}
Declared tools: ${activeTools.length}. Their schemas are authoritative.
Current date/time and per-run evidence are supplied with the latest request.`);

    parts.push(buildToolAvailabilityPrompt(activeTools.map(tool => tool.name), true));
    const telegramContext = buildTelegramBotContext(config?.pinnedContext);
    if (telegramContext) parts.push(telegramContext);
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
          description: registryTool?.modelDescription || (tool.description || '').substring(0, 420),
        };

        // Priority 1: Registry tool with Zod inputSchema → convert via zodToJsonSchema
        if (registryTool?.inputSchema) {
          try {
            const { getToolInputJsonSchema } = require('./tools/registry');
            const rawSchema = getToolInputJsonSchema(registryTool);
            if (rawSchema && typeof rawSchema === 'object') {
              const cleaned = cleanSchemaForGemini(rawSchema);
              if (cleaned && cleaned.properties && Object.keys(cleaned.properties).length > 0) {
                decl.parameters = cleaned;
              }
            }
          } catch (error) {
            // Never publish a parameterless version of an argument-taking tool.
            console.warn(`[AgentRunner] Cannot expose ${tool.name}:`, error);
            continue;
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

        // Builder actions have deterministic, runtime-owned presentation.
        // Keeping UI-only arguments out of this schema saves tokens and avoids
        // raw or inconsistent labels from weaker models.
        if (this.runtimeKind !== 'agent_builder') {
          decl.parameters = addUiTraceFieldsToSchema(decl.parameters);
        }
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
   * - Tool cancellation and explicitly requested execution deadlines
   * - Exponential backoff for transient errors
   * - Debug logging of function declarations
   * - Schema validation error reporting
   */
  async *run(
    messages: Array<{ role: 'user' | 'model'; content: string; contextTurnId?: string }>,
    config: AgentRunnerConfig
  ): AsyncGenerator<AgentRunnerEvent> {
    // A browser session spans many queries; it is never a dialogue identity.
    // Give standalone callers a fresh run ID while retaining one explicit ID
    // throughout provider retries, flow execution and terminal persistence.
    config = {
      ...config,
      pinnedContext: {
        ...config.pinnedContext,
        runId: String(config.pinnedContext?.runId || '').trim() || `custom-run-${randomUUID()}`,
      },
    };
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
      let wakeFlowEvent: (() => void) | null = null;
      const notifyFlowEvent = () => {
        const wake = wakeFlowEvent;
        wakeFlowEvent = null;
        wake?.();
      };
      const upstreamFlowSignal = config.pinnedContext?.abortSignal as AbortSignal | undefined;
      const abortFlow = () => flowAbortController.abort();
      flowAbortController.signal.addEventListener('abort', notifyFlowEvent);
      if (upstreamFlowSignal?.aborted) abortFlow();
      else upstreamFlowSignal?.addEventListener('abort', abortFlow, { once: true });
      const onTrace = (trace: any) => {
        if (flowAbortController.signal.aborted) return;
        const traceTimestamp = Number(trace?.timestamp || Date.now());
        const traceAgentName = trace?.agentName || agentName;
        if (trace?.type === 'status') {
          eventQueue.push({
            ...trace,
            type: 'status',
            text: trace.text,
            agentId: trace.agentId || config.agentId,
            agentName: traceAgentName,
            timestamp: traceTimestamp,
          });
        } else if (trace?.type === 'tool_call') {
          eventQueue.push({
            ...trace,
            type: 'tool_call',
            toolName: trace.toolName,
            toolCallId: trace.toolCallId || trace.ownerTraceId || trace.traceId || trace.id,
            toolArgs: trace.toolArgs,
            agentId: trace.agentId || config.agentId,
            agentName: traceAgentName,
            timestamp: traceTimestamp,
          });
        } else if (trace?.type === 'tool_result' || trace?.type === 'tool_result_preview') {
          eventQueue.push({
            ...trace,
            type: 'tool_result',
            toolName: trace.toolName || trace.tool,
            toolCallId: trace.toolCallId || trace.ownerTraceId || trace.traceId || trace.id,
            toolResult: trace.toolResult ?? trace.result,
            agentId: trace.agentId || config.agentId,
            agentName: traceAgentName,
            timestamp: traceTimestamp,
          });
        } else if (trace?.type === 'console_output') {
          eventQueue.push({
            ...trace,
            type: 'console_output',
            agentId: trace.agentId || config.agentId,
            agentName: traceAgentName,
            timestamp: traceTimestamp,
          });
        } else if (['command', 'exploration', 'file_edit', 'communication', 'browser'].includes(trace?.type)) {
          // The main agent emits rich action traces rather than a literal
          // `tool_call` event. Normalize them so flows get the same cards in
          // the custom-agent chat timeline.
          eventQueue.push({
            ...trace,
            type: 'tool_call',
            toolName: trace.tool || trace.name || 'workflow_action',
            // Tool-side rich traces are children of the runner's generic
            // call. ownerTraceId is that immutable invocation identity; using
            // the child's presentation id created a second action card.
            toolCallId: trace.toolCallId || trace.ownerTraceId || trace.traceId || trace.id,
            toolArgs: {
              ...(trace.toolArgs || {}),
              uiActionText: trace.text,
              uiIcon: trace.icon || trace.iconCategory,
              filename: trace.filename,
              command: trace.command,
              secondary: trace.secondary,
            },
            agentId: trace.agentId || config.agentId,
            agentName: traceAgentName,
            timestamp: traceTimestamp,
          });
        } else if (trace?.type === 'work_note' || trace?.type === 'progress') {
          eventQueue.push({
            ...trace,
            type: 'work_note',
            text: trace.text || 'Working on the flow',
            agentId: trace.agentId || config.agentId,
            agentName: traceAgentName,
            timestamp: traceTimestamp,
          });
        } else if ([
          'thought_stream',
          'file_preview',
          'evidence',
          'ask_user',
          'model_usage',
          'context_usage',
          'context_compaction',
          'sub_agent_spawn',
          'sub_agent_complete',
          'sub_agent_error',
          'inter_agent_message',
        ].includes(String(trace?.type || ''))) {
          // Preserve already-normalized visible events verbatim. The former
          // bridge silently discarded edit previews, delegation lifecycle,
          // and usage events produced inside a flow.
          eventQueue.push({
            ...trace,
            agentId: trace.agentId || config.agentId,
            agentName: traceAgentName,
            timestamp: traceTimestamp,
          } as AgentRunnerEvent);
        }
        if (eventQueue.length) notifyFlowEvent();
      };

      try {
        if (flowAbortController.signal.aborted) throw new Error('CANCELLED_BY_USER');
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
          value => { flowSettled = { status: 'fulfilled', value }; notifyFlowEvent(); },
          error => { flowSettled = { status: 'rejected', error }; notifyFlowEvent(); },
        );

        while (!flowSettled || eventQueue.length > 0) {
          if (flowAbortController.signal.aborted) throw new Error('CANCELLED_BY_USER');
          const pendingEvents = eventQueue.splice(0, eventQueue.length);
          for (const event of pendingEvents) yield event;
          if (!flowSettled && eventQueue.length === 0) {
            await new Promise<void>(resolve => {
              wakeFlowEvent = resolve;
              if (flowSettled || eventQueue.length > 0 || flowAbortController.signal.aborted) notifyFlowEvent();
            });
          }
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
        upstreamFlowSignal?.removeEventListener('abort', abortFlow);
        flowAbortController.signal.removeEventListener('abort', notifyFlowEvent);
        flowAbortController.abort();
        wakeFlowEvent = null;
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
      : isBuilderRuntime ? 24 : 128;
    let agentName = this.profile?.name || config.pinnedContext?.agentName || config.agentId;
    const telegramBehaviorEvents: any[] = [];
    const recordTelegramBehavior = (event: any) => {
      if (!config.pinnedContext?.telegramBot) return;
      telegramBehaviorEvents.push(event);
      if (telegramBehaviorEvents.length > 256) telegramBehaviorEvents.splice(0, telegramBehaviorEvents.length - 256);
    };

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
      let ai = new GoogleGenAI({ apiKey: effectiveApiKey, httpOptions: { timeout: MODEL_REQUEST_TIMEOUT_MS } });
      const runtimeCurrentRequest = [...messages].reverse().find(item => item.role === 'user')?.content || '';
      const currentRequest = resolveWorkingContextRequest(config.pinnedContext, runtimeCurrentRequest);
      let systemInstruction = this.buildSystemInstruction(currentRequest, config);
      let funcDecls = this.buildFunctionDeclarations(currentRequest);
      let resolvedToolSurfaceSignature = this.resolvedTools.map(tool => tool.name).join('\0');
      const runtimeNow = new Date();
      const dynamicRunContextParts = [
        '[SYSTEM-PROVIDED CURRENT RUNTIME CONTEXT]',
        `Date/time: ${runtimeNow.toISOString()}`,
        `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        `Workspace: ${String(resolveChatWorkspaceContext(config.chatId || 'custom-agent-' + config.agentId, 'default', config.pinnedContext).workspacePath)}`,
        `Current host environment (supplied automatically; no setup call needed): ${JSON.stringify(getRuntimeEnvironment({
          ...resolveChatWorkspaceContext(config.chatId || 'custom-agent-' + config.agentId, 'default', config.pinnedContext),
          chatId: config.chatId || 'custom-agent-' + config.agentId,
          terminalShell: config.pinnedContext?.terminalShell,
        }))}`,
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
      // Compaction is a property of the visible conversation, not of whichever
      // custom-agent implementation happens to answer the current turn. Using
      // an internal agent key here split the journal from the UI meter and made
      // switching agents inside one chat silently restart context pressure.
      const compactionScopeId = String(config.chatId || explicitConversationScope || [
        'agent-runner',
        isBuilderRuntime ? 'builder' : 'custom',
        config.agentId,
      ].join(':')).trim();
      const continuityScopeId = compactionScopeId;
      const contextFabric = await getContextFabricForChat(continuityScopeId, {
        durable: config.pinnedContext?.disableSessionPersistence !== true
          || config.pinnedContext?.durableContextPersistence === true,
      });
      await hydratePersistedConversationContext(
        contextFabric,
        String(config.chatId || continuityScopeId),
        currentRequest,
      );
      const hasHistoricalObjective = contextFabric.hasFactKind('objective');
      let requestMode: 'new' | 'continuation' = hasHistoricalObjective ? 'continuation' : 'new';
      if (hasHistoricalObjective) {
        const boundary = detectChatBoundaryFromHistory({
          newMessage: currentRequest,
          history: messages,
          hasActiveTask: contextFabric.hasUnsettledUserRequest()
            || contextFabric.hasActiveFactKind('next_action'),
        });
        if (boundary.decision === 'new_task' && boundary.shouldResetSession) {
          contextFabric.beginTaskBoundary('Custom-agent runtime confidently detected a new objective.');
          requestMode = 'new';
        }
      }
      contextFabric.observeUserRequest(
        currentRequest,
        requestMode,
        String(config.pinnedContext.runId),
      );
      const selfImprovementEnabled = this.runtimeKind !== 'agent_builder'
        && resolveSelfImprovementEnabled(config.pinnedContext?.selfImprovementEnabled);
      if (selfImprovementEnabled) {
        try {
          const learnedContext = await adaptiveExperience.getExecutionContext({
            enabled: true,
            userId: 'default',
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

      // The last user entry owns this request; earlier turns remain the
      // checkpoint's visible lineage, not a substitute for its tool records.
      const currentMessageIndex = messages.map(item => item.role).lastIndexOf('user');
      const priorMessages = currentMessageIndex >= 0 ? messages.slice(0, currentMessageIndex) : messages;
      const checkpointWarnings: string[] = [];
      const workingCheckpoint = await openWorkingContextCheckpoint({
        chatId: compactionScopeId, provider: 'gemini', model: resolvedModel, kind: 'gemini',
        history: priorMessages, currentRequest,
        fabric: contextFabric,
        runId: String(config.pinnedContext?.runId || ''),
        enabled: config.pinnedContext?.disableSessionPersistence !== true || config.pinnedContext?.durableContextPersistence === true,
        onWarning: text => checkpointWarnings.push(text),
      });
      let contents = normalizeConversationTurns([
        ...workingCheckpoint.contents,
        ...[...workingCheckpoint.remainingHistory, ...(!workingCheckpoint.currentRequestIncluded && currentMessageIndex >= 0 ? messages.slice(currentMessageIndex) : [])].map(m => ({
        role: m.role === 'user' ? 'user' as const : 'model' as const,
        parts: [{ text: m.content }],
        })),
      ]);
      const currentUserTurnIndex = contents.map(turn => turn.role).lastIndexOf('user');
      if (currentUserTurnIndex >= 0 && !workingCheckpoint.currentRequestIncluded) {
        contents[currentUserTurnIndex] = {
          ...contents[currentUserTurnIndex],
          parts: [
            ...(contents[currentUserTurnIndex].parts || []),
            { text: `${dynamicRunContextParts.join('\n')}\n[END CURRENT RUNTIME CONTEXT]` },
          ],
        };
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
      let cacheRecoveryAttempts = 0;
      let interruptedStreamRecoveries = 0;
      let hadSuccessfulModelResponse = false;
      let completedNaturally = false;
      let finalAnswerText = '';
      let terminalFailureText = '';
      let iterationsStarted = 0;
      let modelRequestStarted = false;
      const configuredRetries = getApiRetries(config.runtimeSettings || {
        apiRetries: config.pinnedContext?.maxRetries,
      });
      const maxProviderAttempts = Math.max(1, geminiKeyPool.length) * (configuredRetries + 1);
      let lastObservedContextInputTokens = workingCheckpoint.calibration?.inputTokens || 0;
      let lastObservedContextLocalTokens = workingCheckpoint.calibration?.localTokens || 0;
      let requestContextLocalTokens = 0;
      let activeContextRequestId = '';
      let forceContextCompaction = false;
      let contextOverflowRecoveryAttempts = 0;

      // ReAct loop
      for (let iteration = 0; iteration < maxIter; iteration++) {
        iterationsStarted++;
        modelRequestStarted = false;
        if (this.cancelled) {
          yield { type: 'status', text: 'Cancelled by user.', timestamp: Date.now() };
          break;
        }

        let accumulatedThought = '';
        let thoughtStartTime = 0;
        let thoughtId = '';
        let thoughtClosed = false;
        const closeThoughtEvent = () => {
          if (thoughtClosed || !thoughtId || !thoughtStartTime) return null;
          thoughtClosed = true;
          // Providers are allowed to return only visible text. Do not mint a
          // closed empty Thought row in that case; it advances cursors and can
          // briefly mount a blank container during snapshot reconciliation.
          if (!accumulatedThought.trim()) return null;
          const endedAt = Date.now();
          return {
            type: 'thought_stream',
            text: accumulatedThought,
            isLive: false,
            isDelta: false,
            uiOnly: true,
            isStreaming: false,
            isLiveTyping: false,
            streamState: 'closed',
            final: true,
            thoughtId,
            startTime: thoughtStartTime,
            endTime: endedAt,
            agentName,
            timestamp: endedAt,
          } as AgentRunnerEvent;
        };

        try {
          // Builder tools are intentionally mutable. Finalized custom agents
          // are normally stable, but may explicitly attach agent_tool_load;
          // when that changes the real surface, move to the matching
          // content-addressed cache variant before the next model turn.
          if (this.runtimeKind === 'agent_builder') {
            const refreshedProfile = await readAgentBuilderProfile(config.agentId);
            this.profile = {
              ...refreshedProfile,
              name: refreshedProfile.name || this.profile?.name || config.pinnedContext?.agentName || config.agentId,
            };
            agentName = this.profile.name || agentName;
            const nextSystemInstruction = this.buildSystemInstruction(currentRequest, config);
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
              systemInstruction = this.buildSystemInstruction(currentRequest, config);
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
          // Refresh after every completed tool cycle, outside the reusable
          // static prompt/tool cache and without adding synthetic user turns.
          customAgentCachedContent = await getOrCreateAgentCache(
            ai, effectiveApiKey, resolvedModel, systemInstruction, funcDecls,
          ).catch(() => null);
          const workingSet = contextFabric.compileWorkingSet(currentRequest, 8_000);
          const workingSetCue = workingSet
            ? `[CURRENT RUNTIME CONTINUITY - REFERENCE DATA]\n${workingSet}\n[END CURRENT RUNTIME CONTINUITY]`
            : '';
          const iterationContextCue = [workingSetCue, buildTelegramWorkNoteCue(config.pinnedContext, telegramBehaviorEvents)].filter(Boolean).join('\n');
          const iterationSystemInstruction = [systemInstruction, iterationContextCue].filter(Boolean).join('\n');
          const contextEvents: any[] = [];
          let wakeContextEvent: (() => void) | null = null;
          let contextBoundarySettled = false;
          let contextBoundaryError: unknown = null;
          const publishContextEvent = (event: any) => {
            activeContextRequestId = String(event.contextRequestId || activeContextRequestId);
            contextEvents.push(event);
            const wake = wakeContextEvent;
            wakeContextEvent = null;
            wake?.();
          };
          const contextBoundary = (async () => {
            // The exact transcript archive is the compaction commit boundary.
            // A transient Context Fabric disk flush must not skip context
            // measurement and let the provider payload grow without control.
            await contextFabric.flushLedger().catch(() => undefined);
            const compacted = await compactContextAtBoundary({
              chatId: compactionScopeId,
              kind: 'gemini',
              contents,
              systemInstruction: iterationSystemInstruction,
              tools: funcDecls,
              activeModel: { provider: 'gemini', modelId: resolvedModel },
              rawSettings: config.pinnedContext?.contextCompaction,
              contextWindowOverride: config.pinnedContext?.contextCompaction?.activeContextWindow,
              modelContextWindowOverride: config.pinnedContext?.contextCompaction?.activeModelContextWindow,
              runtimeSettings: config.runtimeSettings,
              providerReportedInputTokens: lastObservedContextInputTokens,
              providerReportedLocalEstimatedTokens: lastObservedContextLocalTokens,
              abortSignal: runAbortController.signal,
              continuityManifestFactory: () => contextFabric.buildContinuityManifest(),
              semanticBoundary: 'safe',
              forceCompaction: forceContextCompaction,
              onEvent: publishContextEvent,
            });
            return compacted;
          })().catch((error: unknown) => {
            contextBoundaryError = error;
            return null;
          }).finally(() => {
            contextBoundarySettled = true;
            const wake = wakeContextEvent;
            wakeContextEvent = null;
            wake?.();
          });

          // Yield lifecycle events while the summary request is running. The
          // transcript itself is still replaced only after the compactor's
          // archive, capsule validation, and journal commit all succeed.
          while (!contextBoundarySettled || contextEvents.length > 0) {
            while (contextEvents.length > 0) {
              const event = contextEvents.shift();
              yield { ...event, agentId: config.agentId, agentName } as AgentRunnerEvent;
            }
            if (!contextBoundarySettled) {
              await new Promise<void>(resolve => {
                wakeContextEvent = resolve;
                if (contextBoundarySettled || contextEvents.length > 0) {
                  wakeContextEvent = null;
                  resolve();
                }
              });
            }
          }

          const contextBoundaryResult = await contextBoundary;
          requestContextLocalTokens = Number(contextBoundaryResult?.usage.localEstimatedTokens || 0);
          if (
            runAbortController.signal.aborted
            || isToolCancellationError(contextBoundaryError)
            || String((contextBoundaryError as any)?.message || contextBoundaryError || '') === 'CANCELLED_BY_USER'
          ) {
            throw new Error('CANCELLED_BY_USER');
          }
          if (contextBoundaryResult?.compacted) {
            const compacted = contextBoundaryResult;
            contents = normalizeConversationTurns(compacted.contents);
            lastObservedContextInputTokens = 0;
            lastObservedContextLocalTokens = 0;
            if (compacted.capsule && compacted.continuityManifest) {
              const continuityManifest = compacted.continuityManifest;
              forceContextCompaction = false;
              const restoredFactIds = compacted.capsule.restoredContinuityFactIds || [];
              if (restoredFactIds.length > 0) contextFabric.recordCompactionFeedback({
                coveredFactIds: continuityManifest.facts.map(fact => fact.id).filter(id => !restoredFactIds.includes(id)),
                missingFactIds: restoredFactIds,
                coverageRatio: (continuityManifest.facts.length - restoredFactIds.length) / Math.max(1, continuityManifest.facts.length),
              }, continuityManifest);
              contextFabric.recordCompactionCheckpoint(
                compacted.capsule.compactionId,
                continuityManifest.manifestHash,
                compacted.capsule.summary,
              );
            }
          }
          await workingCheckpoint.save(contents, resolvedModel, 'gemini', {
            inputTokens: lastObservedContextInputTokens, localTokens: lastObservedContextLocalTokens,
          });
          for (const text of checkpointWarnings.splice(0)) yield { type: 'status', text, timestamp: Date.now() };

          // Final provider boundary: retain Gemini's original signed model
          // parts and remove only responses whose authentic call was compacted
          // away. This must run even when no compaction was needed.
          contents = sanitizeGeminiHistory(contents);

          generateConfig = {
            model: resolvedModel,
            contents,
            config: {
              ...(customAgentCachedContent && !iterationContextCue
                ? { cachedContent: customAgentCachedContent }
                : { systemInstruction: iterationSystemInstruction }),
              temperature: config.temperature ?? 0.4,
              abortSignal: runAbortController.signal,
            },
          };

          const thinkingCapabilities = normalizeModelThinkingCapabilities(
            config.pinnedContext?.modelThinkingCapability,
          );
          const thinkingLevel = normalizeThinkingLevelForModel(
            config.pinnedContext?.thinkingLevel || config.pinnedContext?.selectedThinkingLevel,
            'gemini',
            resolvedModel,
            thinkingCapabilities,
          );
          const thinkingConfig = getGeminiThinkingConfig(
            thinkingLevel,
            resolvedModel,
            true,
            thinkingCapabilities,
          );
          if (thinkingConfig) generateConfig.config.thinkingConfig = thinkingConfig;

          // Add tools if we have any
          if (funcDecls.length > 0 && !generateConfig.config.cachedContent) {
            generateConfig.config.tools = [{ functionDeclarations: funcDecls }];
          }

          writeRuntimeTrace('request_token_budget', {
            provider: 'gemini',
            model: resolvedModel,
            runtime: this.runtimeKind,
            cacheActive: Boolean(generateConfig.config.cachedContent),
            ...estimateRequestTokenBudget({
              system: iterationSystemInstruction,
              tools: funcDecls,
              messages: contents,
            }),
          });

          modelRequestStarted = true;
          const thoughtRequestIdentityAt = Date.now();
          thoughtStartTime = 0;
          thoughtId = `thought_${ config.agentId }_${ iteration + 1 }_${ thoughtRequestIdentityAt }_${ Math.random().toString(36).slice(2, 8) }`;
          // The first native reasoning chunk opens the visible Thought row.
          // An empty preflight shell caused a blank poll/update and could be
          // stranded when a provider returned only normal text.
          const responseStream = await ai.models.generateContentStream(generateConfig);
          const streamedParts: any[] = [];
          let latestCandidate: any = null;
          let latestUsageMetadata: any = null;
          let bufferedVisibleText = '';
          for await (const chunk of responseStream as any) {
            latestCandidate = chunk?.candidates?.[0] || latestCandidate;
            latestUsageMetadata = chunk?.usageMetadata || latestUsageMetadata;
            const parts = chunk?.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              streamedParts.push(part);
              if (part.thought && part.text && !thoughtClosed) {
                if (!thoughtStartTime) thoughtStartTime = Date.now();
                accumulatedThought = mergeStreamingText(accumulatedThought, String(part.text), true);
                yield {
                  type: 'thought_stream',
                  text: accumulatedThought,
                  isDelta: false,
                  uiOnly: true,
                  isStreaming: true,
                  isLiveTyping: true,
                  streamState: 'open',
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
          // No function call may run until the provider confirms a complete turn.
          assertSuccessfulCompatibleFinish(latestCandidate?.finishReason, streamedParts.some(part => part?.functionCall));
          // From this point onward the provider request has completed. Any
          // error while executing tools or assembling the next turn must not
          // spend another API-key route or replay work.
          modelRequestStarted = false;
          const completedThought = closeThoughtEvent();
          if (completedThought) yield completedThought;
          const response: any = {
            candidates: [{
              ...(latestCandidate || {}),
              content: { ...(latestCandidate?.content || {}), parts: streamedParts },
            }],
          };
          if (latestUsageMetadata) {
            const normalizedUsage = normalizeProviderCacheUsage('gemini', latestUsageMetadata);
            const reportedInputTokens = Number(
              normalizedUsage.inputTokens || latestUsageMetadata.promptTokenCount || 0,
            );
            if (Number.isFinite(reportedInputTokens) && reportedInputTokens > 0) {
              lastObservedContextInputTokens = reportedInputTokens;
              lastObservedContextLocalTokens = requestContextLocalTokens;
            }
            if (Number(normalizedUsage.totalTokens || 0) > 0) {
              yield {
                type: 'model_usage',
                contextRequestId: activeContextRequestId,
                usageId: `usage_gemini_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                source: 'provider',
                provider: 'gemini',
                model: resolvedModel,
                cacheMode: resolveProviderPromptCacheMode('gemini', process.env.ETERX_DISABLE_CONTEXT_CACHE !== '1', !!generateConfig.config.cachedContent),
                ...normalizedUsage,
                interaction: iteration + 1,
                agentId: config.agentId,
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
              terminalFailureText = 'Response was blocked by safety filters. Try rephrasing your request.';
              yield { type: 'error', text: terminalFailureText, timestamp: Date.now() };
            } else {
              terminalFailureText = finishReason
                ? `The model returned no content (finish reason: ${String(finishReason)}).`
                : 'The model returned an empty response before Agent Builder could run a tool.';
              yield {
                type: 'error',
                text: terminalFailureText,
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
          if (!responseHasToolCalls) {
            finalAnswerText = bufferedVisibleText || candidate.content.parts
              .filter((part: any) => part?.text && !part?.thought)
              .map((part: any) => String(part.text))
              .join('');
          }
          let visibleTextEmitted = false;
          if (config.pinnedContext?.telegramBot && responseHasToolCalls) {
            // Classify the entire visible response at the action boundary,
            // including non-streamed fallbacks. Never truncate a bot update or
            // accidentally promote tool-accompanying text to a final answer.
            visibleTextEmitted = true;
            const noteText = cleanText(bufferedVisibleText || candidate.content.parts
              .filter((part: any) => part?.text && !part?.thought)
              .map((part: any) => String(part.text)).join('')).trim();
            if (noteText) {
              const note = { type: 'work_note' as const, text: noteText, noteId: `${sessionId}:work:${iteration + 1}`, isStreaming: false, agentName, timestamp: Date.now() };
              recordTelegramBehavior(note);
              yield note;
            }
          } else if (bufferedVisibleText) {
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

            const startToolCall = (
              call: FunctionCallRecord,
              notifyActivity: () => void,
            ): RunningToolCall => {
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
                  // Wake the batch generator on the exact output event. A
                  // fixed sampling timer adds visible latency and burns work
                  // for every concurrently running command while idle.
                  notifyActivity();
                };
                const toolAbortController = new AbortController();
                const abortTool = () => toolAbortController.abort();
                if (runAbortController.signal.aborted) abortTool();
                else runAbortController.signal.addEventListener('abort', abortTool, { once: true });
                const toolTimeoutMs = this.resolveToolTimeoutMs(call.name, call.args);
                let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                try {
                  const execPromise = this.executeToolSafe(
                    call.name,
                    call.args,
                    config,
                    pushSideEvent,
                    toolAbortController.signal,
                    call.uiToolCallId,
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
                  result = { error: formatUnknownError(err, 'Tool execution failed') };
                } finally {
                  if (timeoutHandle) clearTimeout(timeoutHandle);
                  runAbortController.signal.removeEventListener('abort', abortTool);
                  settled = true;
                  notifyActivity();
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
              let activityVersion = 0;
              const activityWaiters = new Set<() => void>();
              const notifyActivity = () => {
                activityVersion += 1;
                const waiters = Array.from(activityWaiters);
                activityWaiters.clear();
                waiters.forEach(resolve => resolve());
              };
              const waitForActivityAfter = (observedVersion: number) => {
                if (activityVersion !== observedVersion) return Promise.resolve();
                return new Promise<void>(resolve => activityWaiters.add(resolve));
              };
              const running = new Set<RunningToolCall>();
              const skipped = new Set<FunctionCallRecord>();
              let finished = false;
              let schedulerError: { reason: unknown } | undefined;
              const execution = executeParallelToolCalls(calls, async call => {
                const run = startToolCall(call, notifyActivity);
                running.add(run);
                await run.promise;
                const result = run.getResult();
                callResults.set(call, result);
                return result;
              }, {
                shouldStop: () => runAbortController.signal.aborted,
                onSkipped: call => {
                  const result = { success: false, cancelled: true, error: 'CANCELLED_BY_USER: tool was not started.' };
                  skipped.add(call);
                  callResults.set(call, result);
                  return result;
                },
              }).catch(reason => {
                schedulerError = { reason };
              }).finally(() => {
                finished = true;
                notifyActivity();
              });

              try {
                while (!finished || running.size > 0) {
                  const observedVersion = activityVersion;
                  for (const run of Array.from(running)) {
                    for (const event of run.sideEvents.splice(0, run.sideEvents.length)) yield event;
                    if (run.isSettled() && run.sideEvents.length === 0) {
                      running.delete(run);
                      yield {
                        type: 'tool_result',
                        toolName: run.call.name,
                        toolCallId: run.call.uiToolCallId,
                        toolResult: run.getResult(),
                        agentName,
                        timestamp: Date.now(),
                      };
                    }
                  }
                  if (!finished) await waitForActivityAfter(observedVersion);
                }
                if (schedulerError) throw schedulerError.reason;
                // Queued actions were published before scheduling. Settle their
                // UI cards as cancelled without ever invoking their tools.
                for (const call of skipped) {
                  yield {
                    type: 'tool_result', toolName: call.name,
                    toolCallId: call.uiToolCallId, toolResult: callResults.get(call),
                    agentName, timestamp: Date.now(),
                  };
                }
              } finally {
                // Closing a streaming consumer must not leave queued work free
                // to start or overlap a retry of this custom-agent run.
                if (!finished) runAbortController.abort();
                await execution;
                activityWaiters.clear();
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
                  yield {
                    type: 'tool_result', toolName: call.name,
                    toolCallId: call.uiToolCallId, toolResult: callResults.get(call),
                    agentName, timestamp: Date.now(),
                  };
                }
              }
              for await (const event of runBatch([askUserCall])) yield event;
            } else {
              for await (const event of runBatch(functionCalls)) yield event;
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
              recordTelegramBehavior({ type: 'tool_result', toolName: call.name, toolCallId: call.uiToolCallId, toolResult: { success: !(result as any)?.error && (result as any)?.success !== false }, timestamp: Date.now() });
              if (normalizeRegistryToolName(call.name) !== 'context_memory') {
                const exactPageRef = contextFabric.recordTool(call.name, call.args, providerToolResults[callIndex], result);
                providerToolResults[callIndex] = toolResultCompactor.withExactPageRef(
                  providerToolResults[callIndex],
                  exactPageRef,
                );
              }
              toolResultParts.push({
                functionResponse: {
                  name: call.name,
                  response: { result: serializeToolResult(providerToolResults[callIndex]) },
                  ...(call.providerCallId ? { id: call.providerCallId } : {}),
                },
              });
            }
          }

          // If there were tool calls, add the assistant turn + tool results and continue
          if (hasToolCalls && toolResultParts.length > 0) {
            contents.push({ role: 'model', parts: candidate.content.parts as any });
            contents.push({ role: 'user' as any, parts: toolResultParts as any });
            await workingCheckpoint.save(contents, resolvedModel, 'gemini', {
              inputTokens: lastObservedContextInputTokens, localTokens: lastObservedContextLocalTokens,
            });
            for (const text of checkpointWarnings.splice(0)) yield { type: 'status', text, timestamp: Date.now() };

            yield {
              type: 'status',
              text: `${agentName} processed ${totalToolCalls} tool call${totalToolCalls > 1 ? 's' : ''} (iteration ${iteration + 1}${Number.isFinite(maxIter) ? `/${maxIter}` : ''})`,
              agentName,
              timestamp: Date.now(),
            };
            continue; // Next iteration
          }

          // No tool calls — agent is done
          await workingCheckpoint.save(contents, resolvedModel, 'gemini', {
            inputTokens: lastObservedContextInputTokens, localTokens: lastObservedContextLocalTokens,
          });
          for (const text of checkpointWarnings.splice(0)) yield { type: 'status', text, timestamp: Date.now() };
          completedNaturally = true;
          break;

        } catch (err: any) {
          const interruptedThought = closeThoughtEvent();
          if (interruptedThought) yield interruptedThought;
          const errMsg = formatUnknownError(err, 'Agent Builder execution failed');
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

          if (
            modelRequestStarted
            && isProviderContextLimitError(err)
            && contextOverflowRecoveryAttempts < 2
          ) {
            // The provider's real limit overrides catalog/local estimates.
            // Repeat this exact iteration only after the normal durable
            // compactor has had a chance to archive and reduce the transcript.
            contextOverflowRecoveryAttempts += 1;
            forceContextCompaction = true;
            iteration -= 1;
            iterationsStarted = Math.max(0, iterationsStarted - 1);
            continue;
          }

          if (modelRequestStarted && isInterruptedProviderStream(err) && interruptedStreamRecoveries < 1) {
            interruptedStreamRecoveries++;
            iteration -= 1;
            iterationsStarted = Math.max(0, iterationsStarted - 1);
            yield { type: 'status', text: 'Gemini stream was interrupted; retrying the incomplete response.', timestamp: Date.now() };
            continue;
          }

          // Detect schema/declaration errors specifically
          if (errMsg.includes('Invalid JSON payload') || errMsg.includes('function_declarations')) {
            terminalFailureText = `Tool schema error: ${errMsg.substring(0, 300)}.`;
            yield {
              type: 'error',
              text: `${terminalFailureText} This usually means a tool parameter type is not supported by the Gemini API.`,
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
            terminalFailureText = `Iteration ${iteration}: ${errMsg.substring(0, 300)}`;
            yield { type: 'error', text: terminalFailureText, timestamp: Date.now() };
            break;
          }

          providerAttempts++;
          if (providerAttempts >= maxProviderAttempts) {
            terminalFailureText = `All ${maxProviderAttempts} configured API route attempts failed. Last error: ${errMsg.substring(0, 240)}`;
            yield {
              type: 'error',
              text: terminalFailureText,
              timestamp: Date.now(),
            };
            break;
          }

          const keyCount = Math.max(1, geminiKeyPool.length);
          const nextKeyIndex = providerAttempts % keyCount;
          const previousKey = effectiveApiKey;
          effectiveApiKey = geminiKeyPool[nextKeyIndex] || previousKey;
          if (effectiveApiKey !== previousKey) {
            ai = new GoogleGenAI({ apiKey: effectiveApiKey, httpOptions: { timeout: MODEL_REQUEST_TIMEOUT_MS } });
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
            await waitForApiRetry(Math.floor(providerAttempts / keyCount), runAbortController.signal, err);
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
        terminalFailureText = `${agentName} reached the ${maxIter}-iteration safety limit before producing a final response.`;
        yield {
          type: 'error',
          text: terminalFailureText,
          agentName,
          timestamp: Date.now(),
        };
      }
      if (completedNaturally && finalAnswerText.trim()) {
        contextFabric.recordAssistantResponse(
          finalAnswerText,
          'completed',
          String(config.pinnedContext.runId),
        );
      } else if (this.cancelled) {
        contextFabric.recordAssistantResponse(
          'The custom-agent run was stopped before it produced a final response.',
          'stopped',
          String(config.pinnedContext.runId),
        );
      } else if (terminalFailureText) {
        contextFabric.recordAssistantResponse(
          terminalFailureText,
          'failed',
          String(config.pinnedContext.runId),
        );
      }
      await contextFabric.flush().catch(() => undefined);
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
    // A terminal foreground check-in or wait duration is not permission to
    // abort the tool. Only an explicit outer tool deadline is enforced here.
    const requestedValue = args?.toolTimeoutSeconds;
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
    ownerTraceId?: string,
  ): Promise<unknown> {
    const agentId = config.agentId;
    const chatId = config.chatId || `custom-agent-${agentId}`;

    const routing = await initializeChatWorkspace(chatId, 'default', { ...config.pinnedContext, runLocation: config.runLocation });
    const { workspaceRoot, paths, allowedPaths, isFocusedWorkspace, scratchRoot } = routing;

    const isSandboxRun = config.runLocation === 'sandbox';
    const networkDenied = (config.pinnedContext?.networkPolicy === 'deny' && config.pinnedContext?.allowNetwork !== true);
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
      telegramBot: config.pinnedContext?.telegramBot,
      ownerChatId: config.pinnedContext?.ownerChatId,
      workspaceRoot,
      workspacePath: workspaceRoot,
      scratchRoot,
      paths,
      allowedPaths,
      isFocusedWorkspace,
      runLocation: isSandboxRun ? 'sandbox' : 'local',
      terminalShell: config.pinnedContext?.terminalShell || 'auto',
      allowedCapabilities: localAllowedCapabilities,
      allowBrowserControl: config.pinnedContext?.allowBrowserControl !== false,
      networkPolicy: networkDenied ? 'deny' : 'allow',
      allowNetwork: !networkDenied,
      allowAgentSpawning: config.pinnedContext?.allowAgentSpawning !== false,
      allowHostControl: config.pinnedContext?.allowHostControl === true && config.pinnedContext?.computerUseEnabled !== false,
      allowExternalCommunication: config.pinnedContext?.allowExternalCommunication === true,
      userInitiatedCommunication: this.userInitiatedCommunication,
      userId: 'default',
      selfImprovementEnabled: resolveSelfImprovementEnabled(config.pinnedContext?.selfImprovementEnabled),
      allowDynamicCode: config.pinnedContext?.allowDynamicCode !== false,
      allowRawCommand: config.pinnedContext?.allowRawCommand !== false,
      allowVcs: config.pinnedContext?.allowVcs !== false,
      maxSubAgents: config.pinnedContext?.maxSubAgents,
      maxRetries: config.pinnedContext?.maxRetries,
      _onTrace: onTrace,
      ownerTraceId,
      abortSignal: abortSignal || this.cancelController?.signal,
      signal: abortSignal || this.cancelController?.signal,
      isCancelled: () => this.cancelled || abortSignal?.aborted === true || this.cancelController?.signal.aborted === true,
    };
    const canonicalToolName = normalizeRegistryToolName(toolName);
    const registryTool = globalToolRegistry.getTool(canonicalToolName);
    let effectiveArgs = normalizeRegistryToolArgs(canonicalToolName, args);

    if (registryTool) {
      const validation = validateRegistryToolArgs(registryTool, effectiveArgs);
      if (!validation.success) {
        if (Array.isArray(validation.missing) && validation.missing.length > 0) {
          return {
            success: true,
            needsArguments: true,
            toolName: canonicalToolName,
            requiredArguments: validation.missing,
            message: `Supply ${validation.missing.join(', ')} and call ${canonicalToolName} again.`,
          };
        }
        return { error: validation.error };
      }
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
          let filePath: string;
          try {
            filePath = resolveWorkspacePathForContext(requestedPath, context);
          } catch {
            filePath = path.isAbsolute(requestedPath) ? path.normalize(requestedPath) : path.resolve(workspaceRoot, requestedPath);
          }
          return {
            requestedPath,
            filePath,
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
          id: buildFilePreviewTraceId(ownerTraceId, target.filePath),
          type: 'file_preview',
          filename: path.basename(target.requestedPath),
          filepath: target.filePath,
          language: languageFromFilename(target.requestedPath || target.filePath),
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
          ownerTraceId,
          staged: false,
          isLive: false,
          isStreaming: false,
          isLiveTyping: false,
          streamState: 'closed',
          status: result?.success === false || result?.error ? 'error' : 'completed',
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
  if (Array.isArray(schema.type)) {
    schema = { ...schema, type: schema.type.find((type: string) => type !== 'null') || 'string',
      ...(schema.type.includes('null') ? { nullable: true } : {}) };
  }
  if (schema.const !== undefined) schema = { ...schema, enum: [schema.const] };

  // Handle array type → downgrade to STRING with hint
  if (schema.type === 'array') {
    return {
      type: 'ARRAY',
      items: cleanSchemaForGemini(schema.items || { type: 'string' }, depth + 1),
      ...(schemaUsageDescription(schema) ? { description: schemaUsageDescription(schema) } : {}),
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
      cleaned.description = value.replace(/\s+/g, ' ').trim();
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

  const usageDescription = schemaUsageDescription(schema);
  if (usageDescription) cleaned.description = usageDescription;
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
