/**
 * Agent Runner — Runtime for executing custom-built agents
 * 
 * Loads a finalized AgentBuilderProfile and runs it as an autonomous agent:
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
import { readAgentBuilderProfile, type AgentBuilderProfile, readAgentFlowProfile } from './builder-agent';
import { agentBuilderRunFlowTool } from './tools/automation/agent_builder';
import { resolveAgentTools, type ResolvedTool } from './tool-injector';
import { globalToolRegistry, normalizeRegistryToolName } from './tools/registry';
import { normalizeRegistryToolArgs, validateRegistryToolArgs } from './tools/tool-args';
import { DEFAULT_MAIN_AGENT_ALLOWED_CAPABILITIES, enforceToolCapability } from './tools/security/tool_policy';
import { getPathResolverInfo } from './workspace/path_resolver';
import { createToolExecutionContext, isToolCancellationError } from './cancellation';
import type { ScopedRuntimeSettings } from './runtime-api-keys';
import {
  GEMINI_FAST_FALLBACK_CHAIN,
  GEMINI_THINK_FALLBACK_CHAIN,
  resolveModelName,
  type MainAgentMode,
} from './model-routing';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface AgentRunnerEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'status' | 'error' | 'done' | 'ask_user';
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  agentId?: string;
  agentName?: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface AgentRunnerConfig {
  agentId: string;
  maxIterations?: number;
  temperature?: number;
  mode?: MainAgentMode;
  model?: string;
  preferredGeminiApiKey?: string;
  runtimeSettings?: ScopedRuntimeSettings | null;
  chatId?: string;
  agentSessionId?: string;
  runLocation?: string;
  pinnedContext?: any;
}

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

// ═══════════════════════════════════════════════════════════════
// Agent Runner Class
// ═══════════════════════════════════════════════════════════════

export class AgentRunner {
  private profile: AgentBuilderProfile | null = null;
  private resolvedTools: ResolvedTool[] = [];
  private toolPrompt = '';
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
    const { tools, toolPrompt } = resolveAgentTools(profile);
    this.resolvedTools = tools;
    this.toolPrompt = toolPrompt;

    return profile;
  }

  /** Build the complete system instruction for this agent */
  private buildSystemInstruction(): string {
    if (!this.profile) throw new Error('Agent not loaded');

    const parts: string[] = [];

    // Professional prompt (the core identity — written by the builder)
    parts.push(this.profile.professionalPrompt!);

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

    // Tool prompt (resolved tools + usage policy)
    if (this.toolPrompt) {
      parts.push(`\n${this.toolPrompt}`);
    }

    parts.push(`
## UI Trace Protocol

Your tool calls are rendered in the same professional work timeline as the main EterX agent.

Before a tool call, write a short visible work note only when it explains the next action or a finding. Use natural first-person phrasing such as "I found...", "I am checking...", "Now I will verify...", or "This failed, so I will...". Do not write raw tool names as notes.

Every tool call must include:
- uiActionText: a precise 2-6 word action label for the timeline. No step numbers, no brackets, no punctuation-heavy text, no code dumps. Examples: "Reading data fetch script", "Locating raw dataset URL", "Executing CSV inspection", "Verifying generated file".
- uiIcon: exactly one of computer, agent, terminal, image, file_read, file_create, file_edit, folder_read, folder_create, search, web_search, verification.

Use file_read for reading files, file_create for creating files, file_edit for editing files, terminal for commands, folder_read for directory listing, search for local/code searches, web_search for web lookup, and verification for checks/tests.`);

    // Completion criteria
    if (this.profile.completionCriteria) {
      parts.push(`\n## Completion Criteria\n${this.profile.completionCriteria}`);
    }

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME SAFETY GUARDRAILS (auto-injected, never skipped)
    // These complement the builder-written soul rules in the prompt.
    // ═══════════════════════════════════════════════════════════════
    parts.push(`
## ⚠️ Runtime Safety Guardrails (enforced by system)

These rules are enforced at runtime and cannot be overridden:

1. FILE PATHS: Only access files within the current workspace. Never use '..' to escape. Never access system directories.
2. DESTRUCTIVE COMMANDS: Never execute: rm -rf, del /f /s /q, format, drop database, shutdown, reboot, registry edits, mkfs.
3. CREDENTIALS: Never output API keys, passwords, tokens, or secrets. If a tool returns them, redact before showing to user.
4. SCOPE: You are "${this.profile.name || this.profile.agentId}". Stay within your defined mission. Politely decline out-of-scope requests.
5. RATE LIMITS: If a tool fails with rate limit or timeout, wait before retrying. Max 3 retries per operation.
6. VERIFICATION: After file writes, verify the file was created. After commands, check the exit code. After searches, validate recency.
7. COMMUNICATION: Always tell the user what you're doing before you do it. Report results after each step. Never go silent.`);

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME EFFICIENCY (auto-injected)
    // ═══════════════════════════════════════════════════════════════
    parts.push(`
## Efficiency Guidelines

- You have ${this.resolvedTools.length} tools available. Use them purposefully — don't make unnecessary calls.
- Track your context: don't re-read files or re-search queries you've already processed in this conversation.
- For large outputs, summarize key findings instead of dumping raw content.
- If you can answer confidently from your training knowledge, do so — only search when you need to verify or find latest info.`);

    // Temporal + environment context
    const now = new Date();
    parts.push(`
## Environment Context
Current date/time: ${now.toLocaleString()}
Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}
Operating System: ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}
Workspace: ${getPathResolverInfo().desktopPath}
Available tools: ${this.resolvedTools.length} (${this.resolvedTools.map(t => t.name).join(', ')})`);

    return parts.join('\n');
  }

  /** Build Gemini function declarations from resolved tools */
  private buildFunctionDeclarations(): any[] {
    const declarations: any[] = [];

    for (const tool of this.resolvedTools) {
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
    // 1. Try to load as a Flow first!
    let isFlow = false;
    try {
      const flow = await readAgentFlowProfile(config.agentId);
      if (flow?.status === 'ready' && flow.steps && flow.steps.length > 0) {
        isFlow = true;
      }
    } catch {}

    if (isFlow) {
      this.cancelled = false;
      this.cancelController = new AbortController();
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
            type: 'status',
            text: trace.text || 'Working on the flow',
            agentName: trace.agentName || agentName,
            timestamp: Date.now(),
          });
        }
      };

      const runPromise = agentBuilderRunFlowTool.execute(
        { flowId: config.agentId, input: userMessage },
        {
          projectId: config.chatId || `flow-${config.agentId}`,
          runtimeSettings: config.runtimeSettings,
          pinnedContext: config.pinnedContext,
          runLocation: config.runLocation,
          abortSignal: this.cancelController?.signal,
          signal: this.cancelController?.signal,
          _onTrace: onTrace
        }
      );

      while (true) {
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        const settled = await Promise.race([
          runPromise.then(
            value => ({ status: 'fulfilled' as const, value }),
            error => ({ status: 'rejected' as const, error }),
          ),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 100)),
        ]);

        if (settled) {
          while (eventQueue.length > 0) {
            yield eventQueue.shift()!;
          }

          if (settled.status === 'rejected') {
            throw settled.error;
          }

          const flowResult = settled.value;
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
          break;
        }
      }
      return;
    }

    if (!this.profile) {
      await this.loadAgent(config.agentId);
    }

    this.cancelled = false;
    this.cancelController = new AbortController();
    const maxIter = config.maxIterations || 20;
    const agentName = this.profile?.name || config.agentId;
    const TOOL_TIMEOUT_MS = 45_000; // Default non-terminal tool guard

    // Lease an API key
    apiKeyPool.initialize();
    const sessionId = `custom_agent_${config.agentId}_${Date.now()}`;
    const scopedGeminiKeys = config.runtimeSettings?.apiKeys?.gemini || [];
    let lease = config.preferredGeminiApiKey
      ? apiKeyPool.leaseSpecificKey(sessionId, config.preferredGeminiApiKey, 'main_agent')
      : null;
    if (!lease) {
      for (const key of scopedGeminiKeys) {
        lease = apiKeyPool.leaseSpecificKey(sessionId, key, 'main_agent');
        if (lease) break;
      }
    }
    if (!lease) {
      lease = apiKeyPool.leaseKey(sessionId, 'main_agent');
    }
    if (!lease) {
      yield { type: 'error', text: 'No API keys available. Please check your API key configuration.', timestamp: Date.now() };
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: lease.apiKey });
      let systemInstruction = '';
      let funcDecls: any[] = [];

      // Format conversation history
      const contents = messages.map(m => ({
        role: m.role === 'user' ? 'user' as const : 'model' as const,
        parts: [{ text: m.content }],
      }));

      // ═══════════════════════════════════════════════════════════════
      // CONTEXT COMPACTION — keep the agent fast on long conversations
      // Trim old tool result payloads while keeping first + last turns
      // ═══════════════════════════════════════════════════════════════
      const MAX_CONTEXT_TURNS = 40;
      if (contents.length > MAX_CONTEXT_TURNS) {
        const keepFirst = 4; // Keep first 4 turns (original request context)
        const keepLast = 20; // Keep last 20 turns (recent context)
        const trimStart = keepFirst;
        const trimEnd = contents.length - keepLast;
        if (trimEnd > trimStart) {
          // Compact middle turns — keep role/structure but trim large payloads
          for (let i = trimStart; i < trimEnd; i++) {
            const turn = contents[i];
            if (turn.parts && Array.isArray(turn.parts)) {
              for (let j = 0; j < turn.parts.length; j++) {
                const part = turn.parts[j] as any;
                if (part.text && part.text.length > 500) {
                  turn.parts[j] = { text: part.text.substring(0, 200) + '\n...[earlier context compacted]' } as any;
                }
                if (part.functionResponse) {
                  part.functionResponse.response = { result: '[compacted]' };
                }
              }
            }
          }
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

      let consecutiveErrors = 0;
      let totalToolCalls = 0;
      let generateConfig: any = null; // Hoisted so catch block can inspect/modify it

      // ReAct loop
      for (let iteration = 0; iteration < maxIter; iteration++) {
        if (this.cancelled) {
          yield { type: 'status', text: 'Cancelled by user.', timestamp: Date.now() };
          break;
        }

        systemInstruction = this.buildSystemInstruction();
        funcDecls = this.buildFunctionDeclarations();

        try {
          const resolvedModel = resolveGeminiRunnerModel(config);
          const supportsThinking = modelSupportsThinking(resolvedModel);

          generateConfig = {
            model: resolvedModel,
            contents,
            config: {
              systemInstruction,
              temperature: config.temperature ?? 0.4,
            },
          };

          // Only add thinkingConfig for models that support it
          if (supportsThinking) {
            const level = config.pinnedContext?.thinkingLevel || config.pinnedContext?.selectedThinkingLevel || 'medium';
            let budget = 2048;
            if (level === 'low') budget = 1024;
            else if (level === 'high') budget = 4096;
            else if (level === 'max') budget = 8192;
            generateConfig.config.thinkingConfig = { thinkingBudget: budget };
          }

          // Add tools if we have any
          if (funcDecls.length > 0) {
            generateConfig.config.tools = [{ functionDeclarations: funcDecls }];
          }

          const response = await ai.models.generateContent(generateConfig);
          const candidate = response?.candidates?.[0];
          if (!candidate?.content?.parts) {
            // Check for safety/blocking reasons
            const finishReason = candidate?.finishReason;
            if (finishReason === 'SAFETY') {
              yield { type: 'error', text: 'Response was blocked by safety filters. Try rephrasing your request.', timestamp: Date.now() };
            } else {
              yield { type: 'text', text: 'Agent completed with no output.', timestamp: Date.now() };
            }
            break;
          }

          consecutiveErrors = 0; // Reset on success
          let hasToolCalls = false;
          const toolResultParts: any[] = [];

          for (const part of candidate.content.parts) {
            // Extract thinking/reasoning trace
            if ((part as any).thought) {
              yield {
                type: 'status',
                text: String((part as any).thought).substring(0, 500),
                agentName,
                timestamp: Date.now(),
              };
            }

            // Text response
            if (part.text) {
              yield { type: 'text', text: part.text, agentName, timestamp: Date.now() };
            }

            // Function call
            if (part.functionCall) {
              hasToolCalls = true;
              totalToolCalls++;
              const { name, args } = part.functionCall;

              yield {
                type: 'tool_call',
                toolName: name,
                toolArgs: args as Record<string, unknown>,
                agentName,
                timestamp: Date.now(),
              };

              // Execute the tool with timeout protection
              let result: unknown;
              try {
                const sideEvents: AgentRunnerEvent[] = [];
                const pushSideEvent = (trace: any) => {
                  if (!trace || typeof trace !== 'object') return;
                  sideEvents.push({
                    ...trace,
                    type: trace.type || 'status',
                    agentId: config.agentId,
                    agentName,
                    timestamp: Number(trace.timestamp || Date.now()),
                  } as AgentRunnerEvent);
                };
                const execPromise = this.executeToolSafe(name || '', args || {}, config, pushSideEvent);
                const toolTimeoutMs = this.resolveToolTimeoutMs(name || '', args || {}, TOOL_TIMEOUT_MS);
                const timeoutPromise = new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${toolTimeoutMs / 1000}s`)), toolTimeoutMs)
                );
                const resultPromise = Promise.race([execPromise, timeoutPromise]);

                while (true) {
                  const settled = await Promise.race([
                    resultPromise.then(
                      value => ({ status: 'fulfilled' as const, value }),
                      error => ({ status: 'rejected' as const, error }),
                    ),
                    new Promise<null>(resolve => setTimeout(() => resolve(null), 100)),
                  ]);

                  while (sideEvents.length > 0) {
                    yield sideEvents.shift()!;
                  }

                  if (!settled) continue;
                  if (settled.status === 'rejected') throw settled.error;
                  result = settled.value;
                  break;
                }
              } catch (err: any) {
                result = { error: err.message || 'Tool execution failed' };
              }

              yield {
                type: 'tool_result',
                toolName: name,
                toolResult: result,
                agentName,
                timestamp: Date.now(),
              };

              // Build function response for next turn
              const resultStr = typeof result === 'string'
                ? result
                : JSON.stringify(result || {}).substring(0, 16000);
              toolResultParts.push({
                functionResponse: {
                  name,
                  response: { result: resultStr },
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
              text: `${agentName} processed ${totalToolCalls} tool call${totalToolCalls > 1 ? 's' : ''} (iteration ${iteration + 1}/${maxIter})`,
              agentName,
              timestamp: Date.now(),
            };
            continue; // Next iteration
          }

          // No tool calls — agent is done
          break;

        } catch (err: any) {
          consecutiveErrors++;
          const errMsg = String(err.message || err);

          // If the model doesn't support thinkingBudget, strip it and retry immediately
          if (
            errMsg.toLowerCase().includes('thinking budget is not supported') ||
            errMsg.toLowerCase().includes('thinkingconfig') ||
            (errMsg.includes('400') && errMsg.toLowerCase().includes('thinking'))
          ) {
            if (generateConfig?.config?.thinkingConfig) {
              delete generateConfig.config.thinkingConfig;
              consecutiveErrors = 0;
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
          if (errMsg.includes('429') || errMsg.includes('503') || errMsg.includes('RESOURCE_EXHAUSTED')) {
            const backoffMs = Math.min(2000 * Math.pow(2, consecutiveErrors - 1), 30000);
            yield {
              type: 'status',
              text: `Rate limited. Retrying in ${Math.round(backoffMs / 1000)}s... (attempt ${consecutiveErrors})`,
              timestamp: Date.now(),
            };
            await new Promise(r => setTimeout(r, backoffMs));
            continue;
          }

          // Non-transient errors
          yield { type: 'error', text: `Iteration ${iteration}: ${errMsg.substring(0, 300)}`, timestamp: Date.now() };

          if (consecutiveErrors >= 3) {
            yield { type: 'error', text: `Stopping after ${consecutiveErrors} consecutive errors.`, timestamp: Date.now() };
            break;
          }
          break;
        }
      }

      apiKeyPool.reportSuccess(sessionId);
      yield { type: 'done', agentName, agentId: config.agentId, timestamp: Date.now() };

    } finally {
      apiKeyPool.releaseKey(sessionId);
      this.cancelController = null;
    }
  }

  /**
   * Execute a tool safely — resolves from local tools first, then global registry.
   * Catches all errors and returns structured results.
   */
  private resolveToolTimeoutMs(toolName: string, args: any, defaultMs: number): number {
    const terminalTools = new Set([
      'system_shell',
      'workspace_run_command',
      'workspace_verify_code',
      'background_task',
      'process_manager',
      'wait_timer'
    ]);

    if (!terminalTools.has(toolName)) return defaultMs;

    const requested = Number(args?.checkInSeconds ?? args?.timeoutSeconds ?? args?.seconds ?? 15);
    const requestedMs = Number.isFinite(requested) && requested > 0
      ? (requested <= 120 ? requested * 1000 : requested)
      : 15_000;

    return Math.min(Math.max(requestedMs + 30_000, 90_000), 5 * 60_000);
  }

  private async executeToolSafe(
    toolName: string,
    args: any,
    config: AgentRunnerConfig,
    onTrace?: (trace: any) => void
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
          if (fs.existsSync(resolvedCustom)) {
            workspaceRoot = resolvedCustom;
            paths = [workspaceRoot];
            allowedPaths = [workspaceRoot];
            isFocusedWorkspace = !!config.pinnedContext?.isFocusedWorkspace;
          }
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
      agentRuntime: 'custom_agent' as const,
      projectId: chatId,
      chatId,
      agentSessionId: config.agentSessionId || '',
      workspaceRoot,
      workspacePath: workspaceRoot,
      paths,
      allowedPaths,
      isFocusedWorkspace,
      runLocation: isSandboxRun ? 'sandbox' : 'local',
      sandboxGuard: sandboxGuard || undefined,
      allowedCapabilities: isSandboxRun
        ? ['command.workspace', 'filesystem.read', 'filesystem.write', 'tool.utility', 'memory.manage']
        : localAllowedCapabilities,
      allowBrowserControl: isSandboxRun ? false : config.pinnedContext?.allowBrowserControl !== false,
      networkPolicy: networkDenied ? 'deny' : 'allow',
      allowNetwork: !networkDenied,
      allowAgentSpawning: isSandboxRun ? false : config.pinnedContext?.allowAgentSpawning !== false,
      allowHostControl: isSandboxRun ? false : config.pinnedContext?.allowHostControl === true,
      allowExternalCommunication: isSandboxRun ? false : config.pinnedContext?.allowExternalCommunication === true,
      allowDynamicCode: isSandboxRun ? false : config.pinnedContext?.allowDynamicCode !== false,
      allowRawCommand: isSandboxRun ? false : config.pinnedContext?.allowRawCommand !== false,
      allowVcs: isSandboxRun ? false : config.pinnedContext?.allowVcs !== false,
      _onTrace: onTrace,
      abortSignal: this.cancelController?.signal,
      signal: this.cancelController?.signal,
      isCancelled: () => this.cancelled || this.cancelController?.signal.aborted === true,
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

    const toolExec = createToolExecutionContext(context, onTrace);
    // Priority 1: Resolved tool from agent profile
    try {
      toolExec.throwIfCancelled();
      const resolvedTool = this.resolvedTools.find(t => t.name === toolName);
      if (resolvedTool?.execute) {
        const result = await resolvedTool.execute(effectiveArgs, toolExec.context);
        toolExec.throwIfCancelled();
        return result;
      }

      // Priority 2: Global tool registry
      const regTool = registryTool || globalToolRegistry.getTool(toolName);
      if (regTool?.execute) {
        const result = await regTool.execute(effectiveArgs, toolExec.context);
        toolExec.throwIfCancelled();
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
 *   - type: STRING | NUMBER | INTEGER | BOOLEAN | OBJECT
 *   - properties (for OBJECT)
 *   - description
 *   - enum
 *   - nullable
 *
 * Everything else — $schema, additionalProperties, default, format, examples,
 * $ref, items, required, anyOf, oneOf, allOf, patternProperties, minItems,
 * maxItems, minimum, maximum, pattern — must be stripped or the API returns 400.
 *
 * Array parameters are downgraded to STRING with a note in the description,
 * because Gemini function calling doesn't support ARRAY type natively.
 */
const GEMINI_BLOCKED_KEYS = new Set([
  '$schema', '$ref', '$id', '$comment', '$defs', 'definitions',
  'additionalProperties', 'additionalItems', 'patternProperties',
  'default', 'format', 'examples', 'example',
  'required', 'items', 'prefixItems',
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
    const itemDesc = schema.items?.description || schema.items?.type || 'items';
    return {
      type: 'STRING',
      description: `${schema.description || ''} (JSON array of ${itemDesc})`.trim(),
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
        BOOLEAN: 'BOOLEAN', OBJECT: 'OBJECT', ARRAY: 'STRING',
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

  return cleaned;
}

function addUiTraceFieldsToSchema(schema: any): any {
  const next = schema && typeof schema === 'object'
    ? { ...schema, properties: { ...(schema.properties || {}) } }
    : { type: 'OBJECT', properties: {} };

  if (!next.type) next.type = 'OBJECT';
  next.properties.uiActionText = {
    type: 'STRING',
    description: 'Professional 2-6 word timeline action label. No step numbers, brackets, code fragments, or generic filler.',
  };
  next.properties.uiIcon = {
    type: 'STRING',
    enum: ['computer', 'agent', 'terminal', 'image', 'file_read', 'file_create', 'file_edit', 'folder_read', 'folder_create', 'search', 'web_search', 'verification'],
    description: 'Timeline icon category: computer, agent, terminal, image, file_read, file_create, file_edit, folder_read, folder_create, search, web_search, or verification.',
  };

  return next;
}

/** Singleton for convenience */
const globalForAgentRunner = globalThis as typeof globalThis & {
  __eterxAgentRunner?: AgentRunner;
};

export const agentRunner =
  globalForAgentRunner.__eterxAgentRunner ||
  (globalForAgentRunner.__eterxAgentRunner = new AgentRunner());
