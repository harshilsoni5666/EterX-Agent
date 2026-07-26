import { NextRequest } from 'next/server';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { globalToolRegistry, normalizeRegistryToolName } from '@/lib/agent/tools/registry';
import '@/lib/agent/tools/index';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CODE_AGENT_TOOLS, partitionCodingToolCalls } from '@/lib/code/code-agent-tools';
import {
  buildCodingChatSystemPrompt,
  formatCodingToolFailure,
  getCodingAgentToolNames,
  compressCodingContext,
  buildIterationContext,
} from '@/lib/code/code-agent-runtime';
import { editTracker } from '@/lib/code/edit-tracker';
import { ensureCodeIndex } from '@/lib/agent/workspace/code-index';
import { resolveModelName } from '@/lib/agent/model-routing';
import { normalizeRegistryToolArgs, validateRegistryToolArgs } from '@/lib/agent/tools/tool-args';
import { enforceToolCapability } from '@/lib/agent/tools/security/tool_policy';
import { shouldExposeToolToRuntime } from '@/lib/agent/builder-agent';
import {
  buildScopedRuntimeSettings,
  getScopedRuntimeApiKeyValues,
  type ScopedRuntimeSettings,
} from '@/lib/agent/runtime-api-keys';
import { rejectCrossOrigin } from '../../agent/_shared';
import path from 'path';

function createAIClient(runtimeSettings?: ScopedRuntimeSettings | null): GoogleGenAI {
  const preferredGeminiApiKey = runtimeSettings?.preferredGeminiApiKey;
  if (preferredGeminiApiKey) {
    return new GoogleGenAI({ apiKey: preferredGeminiApiKey });
  }

  const keys = getScopedRuntimeApiKeyValues(runtimeSettings, 'gemini');
  if (keys.length === 0) {
    throw new Error('Missing Gemini API key. Add one in Settings > Connections.');
  }

  const apiKey = keys[Math.floor(Math.random() * keys.length)] || '';
  console.log(`[CodeChat] Using API key: ${apiKey.slice(0, 8)}... (${keys.length} keys found)`);
  return new GoogleGenAI({ apiKey });
}

const _cachedToolDeclarations = new Map<string, any[]>();
function buildToolDeclarations(loadedToolNames: string[] = [...CODE_AGENT_TOOLS]) {
  const cacheKey = loadedToolNames.slice().sort().join('|');
  const cached = _cachedToolDeclarations.get(cacheKey);
  if (cached) return cached;

  const tools = globalToolRegistry.getAllTools();
  const loaded = new Set(loadedToolNames.map(name => normalizeRegistryToolName(name)));
  const selectedTools = tools.filter(t => loaded.has(t.name));
  const finalTools = selectedTools.length > 0 ? selectedTools : tools.filter(t => CODE_AGENT_TOOLS.includes(t.name as any));

  const declarations = finalTools.map(tool => {
    let params: any = { type: 'object', properties: {}, required: [] };
    try {
      if (tool.inputSchema) {
        const jsonSchema = zodToJsonSchema(tool.inputSchema) as any;
        params = cleanSchemaForGemini({
          type: 'object',
          properties: jsonSchema.properties || {},
          required: jsonSchema.required || [],
        });
      }
    } catch { /* ignore */ }

    return {
      name: tool.name,
      description: tool.description.slice(0, 160),
      parameters: params,
    };
  });

  _cachedToolDeclarations.set(cacheKey, declarations);
  return declarations;
}

function expandLoadedToolsFromFinder(args: any, outputText: string, loadedToolNames: string[]): string[] {
  let output: any = null;
  try {
    output = JSON.parse(outputText);
  } catch {
    output = null;
  }

  const loaded = new Set(loadedToolNames.map(name => normalizeRegistryToolName(name)));
  const requested: string[] = [];
  const addRequested = (value: unknown) => {
    const name = normalizeRegistryToolName(String(value || '').trim());
    if (name) requested.push(name);
  };

  if (Array.isArray(output?.matches)) {
    for (const match of output.matches.slice(0, 10)) addRequested(match?.name);
  }
  if (Array.isArray(output?.recommendedChains)) {
    for (const chain of output.recommendedChains.slice(0, 3)) {
      if (Array.isArray(chain?.tools)) {
        for (const toolName of chain.tools) addRequested(toolName);
      }
    }
  }

  const text = `${args?.query || ''} ${output?.query || ''}`.toLowerCase();
  if (/\b(how|where|what handles|architecture|flow|explore|understand)\b/.test(text)) {
    addRequested('workspace_semantic_search');
    addRequested('workspace_symbol_lookup');
    addRequested('code_intelligence');
  }
  if (/\b(symbol|definition|reference|usage|where is .* defined)\b/.test(text)) {
    addRequested('workspace_symbol_lookup');
    addRequested('workspace_search_text');
  }
  if (/\b(outline|structure|imports|exports|functions in)\b/.test(text)) {
    addRequested('workspace_file_outline');
    addRequested('code_intelligence');
  }
  if (/\b(create|write|generate|make|new file|scaffold|artifact|build)\b/.test(text)) {
    addRequested('workspace_write_file');
    addRequested('workspace_execute_script');
  }
  if (/\b(edit|modify|change|replace|refactor|fix|patch|bug|broken|not working)\b/.test(text)) {
    addRequested('workspace_str_replace');
    addRequested('workspace_apply_patch');
    addRequested('workspace_edit_file');
    addRequested('workspace_edit_many_files');
  }
  if (/\b(folder|directory|tree|list files|dir\b|ls\b|find files|project files?)\b/.test(text)) {
    addRequested('workspace_find_files');
    addRequested('workspace_search_text');
    addRequested('workspace_read_many_files');
  }
  if (/\b(run (?:tests?|build|lint|typecheck)|npm|pnpm|yarn|pytest|cargo|go|npx|tsc)\b/.test(text)) {
    addRequested('workspace_run_command');
    addRequested('workspace_verify_code');
  }
  if (/\b(browser|ui|localhost|screenshot|visual)\b/.test(text)) {
    addRequested('browser_control');
    addRequested('screenshot_capture');
  }
  if (/\b(web|latest|research|internet)\b/.test(text)) {
    addRequested('web_search');
    addRequested('deep_research');
  }

  const added: string[] = [];
  for (const toolName of requested) {
    const tool = globalToolRegistry.getTool(toolName);
    if (!tool || !shouldExposeToolToRuntime(tool.name, false)) continue;
    if (!loaded.has(tool.name)) {
      loaded.add(tool.name);
      loadedToolNames.push(tool.name);
      added.push(tool.name);
    }
  }

  return added;
}

function cleanSchemaForGemini(schema: any, depth = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 8) return schema;
  if (Array.isArray(schema)) return schema.map(item => cleanSchemaForGemini(item, depth + 1));

  if (schema.type === 'array' || schema.type === 'ARRAY') {
    const cleanedItems = cleanSchemaForGemini(schema.items || { type: 'string' }, depth + 1);
    return {
      type: 'array',
      items: cleanedItems && typeof cleanedItems === 'object' ? cleanedItems : { type: 'string' },
      ...(schema.description ? { description: String(schema.description).slice(0, 70) } : {}),
      ...(schema.nullable ? { nullable: true } : {}),
    };
  }

  const union = schema.anyOf || schema.oneOf || schema.allOf;
  if (Array.isArray(union) && union.length > 0) {
    const objectVariants = union.filter((item: any) => item?.type === 'object' && item.properties);
    if (objectVariants.length > 0) {
      return cleanSchemaForGemini({
        type: 'object',
        properties: Object.assign({}, ...objectVariants.map((item: any) => item.properties || {})),
        description: schema.description,
      }, depth + 1);
    }
    const firstConcrete = union.find((item: any) => item?.type && item.type !== 'null') || union[0];
    return cleanSchemaForGemini({ ...firstConcrete, description: schema.description || firstConcrete?.description }, depth + 1);
  }

  const blocked = new Set([
    '$schema', '$ref', '$id', '$defs', 'definitions', 'additionalProperties',
    'additionalItems', 'patternProperties', 'default', 'format', 'examples',
    'example', 'prefixItems', 'anyOf', 'oneOf', 'allOf', 'if', 'then',
    'else', 'not', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum',
    'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'pattern',
    'const', 'title',
  ]);

  const cleaned: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (blocked.has(key)) continue;
    if (key === 'description' && typeof value === 'string') {
      cleaned.description = value.slice(0, depth === 0 ? 120 : 70);
      continue;
    }
    if (key === 'type') {
      cleaned.type = String(value).toLowerCase();
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned.properties = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, any>)) {
        if (/^\d+$/.test(propName)) continue;
        cleaned.properties[propName] = cleanSchemaForGemini(propSchema, depth + 1);
      }
      continue;
    }
    if (key === 'required' && Array.isArray(value)) {
      cleaned.required = value.filter(item => typeof item === 'string');
      continue;
    }
    if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned.items = cleanSchemaForGemini(value, depth + 1);
      continue;
    }
    if (key === 'enum' && Array.isArray(value)) {
      cleaned.enum = value.filter(item => ['string', 'number', 'boolean'].includes(typeof item));
      continue;
    }
    if (key === 'nullable' && typeof value === 'boolean') {
      cleaned.nullable = value;
      continue;
    }
  }

  if (!cleaned.type) cleaned.type = cleaned.properties ? 'object' : 'string';
  if (cleaned.type === 'object' && (!cleaned.properties || Object.keys(cleaned.properties).length === 0)) {
    return {
      type: 'string',
      description: `${cleaned.description || 'Structured JSON object.'} JSON string.`.slice(0, 110),
    };
  }

  return cleaned;
}

function didToolReturnFailure(result: any): boolean {
  if (!result || typeof result !== 'object') return false;
  if (result.success === false) return true;
  if (result.passed === false) return true;
  if (typeof result.CRITICAL_ERROR === 'string' && result.CRITICAL_ERROR.trim().length > 0) return true;
  if (typeof result.exitCode === 'number' && result.exitCode !== 0 && !result.stillRunning) return true;
  return typeof result.error === 'string' && result.error.trim().length > 0;
}

async function executeRegistryTool(
  toolName: string,
  args: any,
  workspacePath: string,
  loadedToolNames: string[] = [...CODE_AGENT_TOOLS],
  terminalShell: string = 'auto',
): Promise<{ success: boolean; output: string }> {
  const canonicalToolName = normalizeRegistryToolName(toolName);
  const loaded = new Set(loadedToolNames.map(name => normalizeRegistryToolName(name)));
  if (!loaded.has(canonicalToolName)) {
    return { success: false, output: `Tool ${canonicalToolName} is not loaded. Call tool_finder for this capability first.` };
  }
  if (!shouldExposeToolToRuntime(canonicalToolName, false)) {
    return { success: false, output: `Tool ${canonicalToolName} is disabled. Use the current workspace tool surface instead.` };
  }
  const tool = globalToolRegistry.getTool(canonicalToolName);
  if (!tool) {
    return { success: false, output: `Unknown tool: ${toolName}` };
  }

  try {
    args = normalizeRegistryToolArgs(canonicalToolName, args);
    const resolvedWorkspacePath = workspacePath ? path.resolve(workspacePath) : '';
    const appRoot = path.resolve(process.cwd());
    const isInternalEterXWorkspace = Boolean(
      resolvedWorkspacePath &&
      (resolvedWorkspacePath === appRoot || resolvedWorkspacePath.startsWith(`${appRoot}${path.sep}`))
    );

    if (canonicalToolName.startsWith('workspace_') && workspacePath) {
      if (args.filename && !path.isAbsolute(args.filename)) {
        args.filename = path.resolve(workspacePath, args.filename);
      }
      if (args.directory && !path.isAbsolute(args.directory)) {
        args.directory = path.resolve(workspacePath, args.directory);
      }
      if (args.file_path && !path.isAbsolute(args.file_path)) {
        args.file_path = path.resolve(workspacePath, args.file_path);
      }
      if (args.cwd && !path.isAbsolute(args.cwd)) {
        args.cwd = path.resolve(workspacePath, args.cwd);
      }
      if ((canonicalToolName === 'workspace_run_command' || canonicalToolName === 'workspace_verify_code' || canonicalToolName === 'workspace_execute_script') && !args.cwd) {
        args.cwd = workspacePath;
      }
      if ((canonicalToolName === 'workspace_list_directory' || canonicalToolName === 'workspace_search_text' || canonicalToolName === 'workspace_semantic_search' || canonicalToolName === 'workspace_find_files') && !args.directory) {
        args.directory = workspacePath;
      }
      if (canonicalToolName === 'workspace_read_many_files' && Array.isArray(args.files)) {
        args.files = args.files.map((spec: any) => ({
          ...spec,
          filename: spec?.filename && !path.isAbsolute(spec.filename)
            ? path.resolve(workspacePath, spec.filename)
            : spec?.filename,
        }));
      }
    }

    const validation = validateRegistryToolArgs(tool, args);
    if (!validation.success) {
      return { success: false, output: validation.error };
    }
    args = validation.args;

    const toolContext = {
      workspacePath,
      workspaceRoot: workspacePath,
      projectId: workspacePath || 'code-chat',
      chatId: workspacePath || 'code-chat',
      paths: workspacePath ? [workspacePath] : [],
      allowedPaths: workspacePath ? [workspacePath] : [],
      allowEterXSource: isInternalEterXWorkspace,
      agentRuntime: isInternalEterXWorkspace ? 'eterx_internal_dev' : undefined,
      source: isInternalEterXWorkspace ? 'eterx_internal_dev' : undefined,
      allowedCapabilities: ['command.workspace', 'filesystem.read', 'filesystem.write', 'tool.utility', 'memory.manage'],
      networkPolicy: 'deny',
      terminalShell,
    };
    const capabilityDecision = enforceToolCapability(canonicalToolName, args, toolContext);
    if (!capabilityDecision.allowed) {
      return { success: false, output: capabilityDecision.reason || `Tool ${canonicalToolName} is not allowed` };
    }

    const result = await tool.execute(args, toolContext);
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { success: !didToolReturnFailure(result), output: output.slice(0, 30000) };
  } catch (err: any) {
    return { success: false, output: `Tool error: ${err.message}` };
  }
}

async function executeToolCallsParallel(
  toolCalls: Array<{ name?: string; args?: any }>,
  workspacePath: string,
  loadedToolNames: string[],
  send: (data: any) => void,
  terminalShell: string = 'auto',
): Promise<any[]> {
  const indexedCalls = toolCalls.map((call, index) => ({
    index,
    name: call.name || '',
    args: call.args || {},
  }));
  const { stateless, stateful } = partitionCodingToolCalls(indexedCalls);
  const results: any[] = new Array(toolCalls.length);

  const runOne = async (call: { index: number; name: string; args: any }) => {
    const index = call.index;
    const canonicalToolName = normalizeRegistryToolName(call.name);
    send({
      type: 'trace',
      data: {
        type: 'tool_start',
        tool: canonicalToolName,
        requestedTool: call.name,
        args: call.args,
        uiActionText: `Executing ${canonicalToolName}...`,
      },
    });

    let result = await executeRegistryTool(call.name, call.args, workspacePath, loadedToolNames, terminalShell);
    if (canonicalToolName === 'tool_finder' && result.success) {
      const addedTools = expandLoadedToolsFromFinder(call.args, result.output, loadedToolNames);
      if (addedTools.length > 0) {
        result = {
          ...result,
          output: `${result.output}\n\nNewly loaded tools: ${addedTools.join(', ')}`,
        };
      }
    }

    const output = result.success ? result.output : formatCodingToolFailure(canonicalToolName, result.output);
    if (result.success) {
      send({ type: 'trace', data: { type: 'tool_result', tool: canonicalToolName, requestedTool: call.name, result: output } });
    } else {
      send({ type: 'trace', data: { type: 'tool_error', tool: canonicalToolName, requestedTool: call.name, error: output } });
      result = { ...result, output };
    }

    results[index] = {
      functionResponse: {
        name: call.name,
        response: result.success
          ? { success: true, result: result.output }
          : { success: false, error: result.output },
      },
    };
  };

  if (stateless.length > 1) {
    console.log(`[CodeChat] Parallel stateless tools: ${stateless.map(c => c.name).join(', ')}`);
    await Promise.all(stateless.map(call => runOne(call)));
  } else if (stateless.length === 1) {
    await runOne(stateless[0]);
  }

  for (const call of stateful) {
    await runOne(call);
  }

  return results;
}

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;

  // ─── Input Validation ───
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { prompt, history, workspacePath, terminalShell = 'auto' } = body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return new Response(JSON.stringify({ error: 'Prompt is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const runtimeSettings = buildScopedRuntimeSettings();

  const loadedToolNames = getCodingAgentToolNames();
  if (workspacePath) {
    ensureCodeIndex(workspacePath).catch(err => {
      console.warn('[CodeChat] Index warmup failed:', err?.message || err);
    });
  }

  // ─── History Sanitization ───
  // Filter out empty/garbage messages that cause context contamination
  const geminiHistory = (Array.isArray(history) ? history : [])
    .map((m: any) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: String(m.parts?.[0]?.text || m.content || '').trim() }],
    }))
    .filter((m: any) => {
      const text = m.parts?.[0]?.text || '';
      // Drop empty messages — these cause context pollution
      if (!text) return false;
      // Drop messages that are just whitespace
      if (!text.trim()) return false;
      return true;
    });

  // Validate alternation: Gemini requires strict user/model alternation
  const sanitizedHistory: any[] = [];
  let lastRole = '';
  for (const msg of geminiHistory) {
    // Skip consecutive same-role messages (merge or drop)
    if (msg.role === lastRole) {
      // Merge into last message
      if (sanitizedHistory.length > 0) {
        const last = sanitizedHistory[sanitizedHistory.length - 1];
        const existingText = last.parts?.[0]?.text || '';
        const newText = msg.parts?.[0]?.text || '';
        last.parts = [{ text: existingText + '\n' + newText }];
      }
      continue;
    }
    sanitizedHistory.push(msg);
    lastRole = msg.role;
  }

  const encoder = new TextEncoder();
  let streamAlive = true;

  const stream = new ReadableStream({
    async start(controller) {
      // ─── Safe Send (no crash on client disconnect) ───
      const send = (data: any) => {
        if (!streamAlive) return;
        try {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(data) + '\n\n'));
        } catch {
          streamAlive = false;
        }
      };

      // ─── Client Disconnect Detection ───
      req.signal.addEventListener('abort', () => {
        streamAlive = false;
        console.log('[CodeChat] Client disconnected — stopping generation');
        try { controller.close(); } catch { /* already closed */ }
      });

      try {
        let messages = [
          ...sanitizedHistory,
          { role: 'user', parts: [{ text: prompt.trim() }] },
        ];
        let iterations = 0;
        const MAX_ITERATIONS = 500;
        let accumulatedAnswer = '';
        let totalToolCalls = 0;

        let requestAiClient: GoogleGenAI;
        try {
          requestAiClient = createAIClient(runtimeSettings);
        } catch (keyErr: any) {
          send({ type: 'trace', data: { type: 'answer', text: `API Key Error: ${keyErr.message}` } });
          return;
        }
        const requestModelName = resolveModelName('fast', runtimeSettings);

        while (iterations < MAX_ITERATIONS && streamAlive) {
          iterations++;

          // ─── Smart Context Compression ───
          const compression = compressCodingContext(messages, iterations);
          if (compression.compressed) {
            messages = compression.messages;
            if (iterations % 20 === 0) {
              send({
                type: 'trace',
                data: {
                  type: 'context_compressed',
                  iteration: iterations,
                  originalTokens: compression.originalTokenEstimate,
                  compressedTokens: compression.compressedTokenEstimate,
                  savings: Math.round((1 - compression.compressedTokenEstimate / Math.max(1, compression.originalTokenEstimate)) * 100),
                },
              });
            }
          }

          // ─── Progress / Budget Awareness ───
          const iterationCtx = iterations > 1 ? buildIterationContext({
            iteration: iterations,
            totalToolCalls,
            editCount: editTracker.editCount,
            fileCount: editTracker.fileCount,
            compressed: compression.compressed,
          }) : undefined;

          const systemPrompt = buildCodingChatSystemPrompt(workspacePath || '', loadedToolNames, iterationCtx);
          const toolDeclarations = buildToolDeclarations(loadedToolNames);
          const iterationAnswerBase = accumulatedAnswer;

          // ─── API Call with Retry ───
          let response: any = null;
          let liveStreamed = false;
          let lastApiError: any = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const responseStream = await requestAiClient.models.generateContentStream({
                model: requestModelName,
                contents: messages,
                config: {
                  systemInstruction: systemPrompt,
                  tools: [{ functionDeclarations: toolDeclarations }],
                  thinkingConfig: {
                    thinkingLevel: ThinkingLevel.LOW,
                    includeThoughts: false,
                  },
                  maxOutputTokens: 16384,
                },
              });
              const streamedParts: any[] = [];
              let usageMetadata: any = null;
              for await (const chunk of responseStream as any) {
                usageMetadata = chunk?.usageMetadata || usageMetadata;
                const parts = chunk?.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                  streamedParts.push(part);
                  if (part.thought && part.text) {
                    liveStreamed = true;
                    send({ type: 'trace', data: { type: 'thought_stream', text: part.text } });
                  } else if (part.text && !part.thought) {
                    liveStreamed = true;
                    accumulatedAnswer += part.text;
                    send({ type: 'trace', data: { type: 'answer', text: accumulatedAnswer } });
                  }
                }
              }
              response = { candidates: [{ content: { parts: streamedParts } }], usageMetadata };
              lastApiError = null;
              if (response?.usageMetadata) {
                const promptTokens = response.usageMetadata.promptTokenCount ?? response.usageMetadata.inputTokenCount ?? 0;
                const completionTokens = response.usageMetadata.candidatesTokenCount ?? response.usageMetadata.outputTokenCount ?? 0;
                const totalTokens = response.usageMetadata.totalTokenCount ?? (promptTokens + completionTokens);
                console.log(`[CodeChat] 📊 Token Usage: Input: ${promptTokens} | Output: ${completionTokens} | Total: ${totalTokens}`);
              }
              break; // Success
            } catch (apiErr: any) {
              accumulatedAnswer = iterationAnswerBase;
              send({ type: 'trace', data: { type: 'answer_cancel', text: iterationAnswerBase } });
              lastApiError = apiErr;
              const status = apiErr?.status || apiErr?.httpStatusCode || 0;
              const msg = String(apiErr?.message || '');

              // Retryable: 429 rate limit, 503 overloaded, 500 internal
              if (status === 429 || status === 503 || status === 500 || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('overloaded')) {
                const backoff = Math.min(1000 * Math.pow(2, attempt), 8000);
                console.warn(`[CodeChat] API ${status || 'error'} on attempt ${attempt + 1}, retrying in ${backoff}ms...`);
                send({ type: 'trace', data: { type: 'thought_stream', text: `API busy, retrying... (attempt ${attempt + 2})` } });
                await new Promise(r => setTimeout(r, backoff));
                continue;
              }

              // Non-retryable — break immediately
              break;
            }
          }

          if (lastApiError) {
            const errMsg = String(lastApiError?.message || lastApiError || 'Unknown API error');
            console.error('[CodeChat] API error after retries:', errMsg);
            send({ type: 'trace', data: { type: 'answer', text: accumulatedAnswer + `\n\nAPI Error: ${errMsg}` } });
            break;
          }

          if (!streamAlive) break;

          const candidate = response?.candidates?.[0];
          if (!candidate?.content?.parts) break;

          let hasToolCalls = false;
          const toolCalls: Array<{ name?: string; args?: any }> = [];

          for (const part of candidate.content.parts) {
            if (part.thought && part.text && !liveStreamed) {
              send({ type: 'trace', data: { type: 'thought_stream', text: part.text } });
            } else if (part.text && !part.thought && !liveStreamed) {
              accumulatedAnswer += part.text;
              send({ type: 'trace', data: { type: 'answer', text: accumulatedAnswer } });
            } else if (part.functionCall) {
              hasToolCalls = true;
              toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
            }
          }

          if (hasToolCalls && toolCalls.length > 0 && streamAlive) {
            accumulatedAnswer = iterationAnswerBase;
            send({ type: 'trace', data: { type: 'answer_cancel', text: iterationAnswerBase } });
            totalToolCalls += toolCalls.length;
            const toolResults = await executeToolCallsParallel(toolCalls, workspacePath || '', loadedToolNames, send, terminalShell);
            messages.push({ role: 'model', parts: candidate.content.parts });
            messages.push({ role: 'user', parts: toolResults });
            continue;
          }

          break;
        }

        if (iterations >= MAX_ITERATIONS && streamAlive) {
          send({ type: 'trace', data: { type: 'answer', text: accumulatedAnswer + '\n\nReached maximum iteration limit.' } });
        }
      } catch (err: any) {
        console.error('[CodeChat] Unhandled error:', err);
        if (streamAlive) {
          send({ type: 'trace', data: { type: 'answer', text: `Error: ${err.message || 'Unknown error'}` } });
        }
      } finally {
        if (streamAlive) {
          try { controller.close(); } catch { /* already closed */ }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

