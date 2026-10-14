import type OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { Anthropic } from './model-clients';
import { MODEL_REQUEST_TIMEOUT_MS } from './model-request-policy';
import { applyAnthropicPromptCachePolicy, normalizeProviderCacheUsage } from './provider-prompt-cache';
import { applyAnthropicThinkingDisplay, createAnthropicContentStreamReader } from './provider-capabilities';
import { getAnthropicThinkingBudget } from './model-routing';
import { beginPromptCacheDiagnostics } from './prompt-cache-diagnostics';

const textContent = (content: any): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => part?.text || '').join('\n') : '';

function anthropicContent(content: any): any[] {
  if (!Array.isArray(content)) return content ? [{ type: 'text', text: String(content) }] : [];
  return content.map(part => {
    if (part.type === 'image_url') {
      const url = String(part.image_url?.url || part.image_url || '');
      const data = /^data:([^;]+);base64,(.+)$/s.exec(url);
      return { type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url } };
    }
    if (part.type === 'file') {
      const data = /^data:([^;]+);base64,(.+)$/s.exec(String(part.file?.file_data || ''));
      if (!data) throw new Error('This Messages endpoint requires an inline document, not an OpenAI file ID.');
      return { type: 'document', source: { type: 'base64', media_type: data[1], data: data[2] } };
    }
    return part;
  });
}

export async function* streamMessagesBridge(client: OpenAI, params: Record<string, any>, signal?: AbortSignal, conversationScope?: string): AsyncGenerator<any> {
  const native = new Anthropic({ apiKey: client.apiKey, baseURL: client.baseURL.replace(/\/v1\/?$/, ''), timeout: MODEL_REQUEST_TIMEOUT_MS, maxRetries: 0 });
  const messages: any[] = [];
  const system: string[] = [];
  for (const message of params.messages || []) {
    if (message.role === 'system' || message.role === 'developer') { system.push(textContent(message.content)); continue; }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: textContent(message.content) }]
      : message.role === 'assistant' && Array.isArray(message.anthropic_content)
        ? [...message.anthropic_content]
        : [...anthropicContent(message.content), ...(message.tool_calls || []).map((call: any) => ({
          type: 'tool_use', id: call.id, name: call.function.name,
          input: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments || {},
        }))];
    if (!content.length) continue;
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  }
  // Compatible transcripts carry runtime observations in separate user
  // blocks. Keep these inside the preceding native tool result, consistently
  // on every replay, so older Claude/Haiku tool continuations retain thinking.
  for (const message of messages) {
    if (message.role !== 'user') continue;
    let lastResult = message.content.length - 1;
    while (lastResult >= 0 && message.content[lastResult]?.type !== 'tool_result') lastResult--;
    if (lastResult < 0) continue;
    const updates = message.content.slice(lastResult + 1).filter((block: any) => block?.type === 'text'
      && /^\[RUNTIME CONTEXT UPDATE: [^\n]+ - REFERENCE DATA\]\n/.test(block.text)
      && /\n\[END RUNTIME CONTEXT UPDATE: [^\n]+\]$/.test(block.text));
    if (!updates.length) continue;
    const result = message.content[lastResult];
    const content = typeof result.content === 'string' ? [{ type: 'text', text: result.content }]
      : Array.isArray(result.content) ? result.content : [];
    message.content = message.content.filter((block: any) => !updates.includes(block));
    message.content[lastResult] = { ...result, content: [...content, ...updates] };
  }
  const body: any = { model: params.model, messages, max_tokens: params.max_completion_tokens ?? params.max_tokens ?? 32768 };
  if (system.length) body.system = system.map(text => ({ type: 'text', text }));
  if (params.tools?.length) body.tools = params.tools.map((tool: any) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }));
  if (params.thinking) body.thinking = params.thinking;
  if (params.output_config) {
    body.output_config = params.output_config;
    if (/^claude-opus-4[.-]5(?:-|$)/.test(params.model)) {
      body.thinking ??= { type: 'enabled', budget_tokens: getAnthropicThinkingBudget(params.output_config.effort) };
    } else if (body.thinking?.type !== 'disabled') {
      body.thinking = { ...body.thinking, type: 'adaptive' };
    }
  }
  if (/(?:^|\/)claude-/i.test(params.model)) applyAnthropicThinkingDisplay(body);
  if (body.thinking?.type === 'enabled') body.max_tokens = Math.max(body.max_tokens, Number(body.thinking.budget_tokens || 0) + 2048);
  if (!body.thinking && params.temperature !== undefined) body.temperature = params.temperature;
  if (params.tool_choice === 'required') body.tool_choice = { type: 'any' };
  else if (params.tool_choice?.type === 'function') body.tool_choice = { type: 'tool', name: params.tool_choice.function.name };
  else if (body.tools) body.tool_choice = { type: 'auto' };
  // Claude models reached through a compatible gateway need native cache
  // breakpoints too. Other Messages implementations keep their own defaults.
  if (/(?:^|\/)claude-/i.test(params.model)) applyAnthropicPromptCachePolicy(body, undefined, params.messages);
  const cacheObservation = beginPromptCacheDiagnostics({
    provider: 'anthropic', model: params.model, scope: conversationScope,
    endpoint: native.baseURL, apiKey: client.apiKey ?? '', request: body,
  });
  const stream = native.messages.stream(body, signal ? { signal } : undefined);
  const readContent = createAnthropicContentStreamReader();
  for await (const event of stream) {
    const content = readContent(event);
    if (content.reasoning) yield { choices: [{ delta: { reasoning: content.reasoning } }] };
    if (content.reasoningBoundary) yield { choices: [{ delta: { reasoning_boundary: true } }] };
    if (content.text) yield { choices: [{ delta: { content: content.text } }] };
  }
  const message = await stream.finalMessage();
  for (const reasoning of readContent.remainingReasoning(message.content)) {
    yield { choices: [{ delta: { reasoning } }] };
    yield { choices: [{ delta: { reasoning_boundary: true } }] };
  }
  if (!['end_turn', 'tool_use', 'stop_sequence'].includes(String(message.stop_reason))) throw new Error(`MODEL_STREAM_INCOMPLETE: Messages endpoint ended with ${message.stop_reason}.`);
  cacheObservation?.complete(message.usage);
  const calls = message.content.filter((part: any) => part.type === 'tool_use').map((part: any, index: number) => ({ index, id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } }));
  yield { choices: [{ delta: { tool_calls: calls }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: normalizeProviderCacheUsage('anthropic', message.usage), prompt_cache_diagnostics: cacheObservation?.report, provider_message: { anthropic_content: message.content } };
}

function geminiParts(content: any): any[] {
  if (!Array.isArray(content)) return content ? [{ text: String(content) }] : [];
  return content.map(part => {
    if (part.type === 'text') return { text: part.text };
    const url = part.type === 'image_url' ? part.image_url?.url || part.image_url : part.file?.file_data;
    const data = /^data:([^;]+);base64,(.+)$/s.exec(String(url || ''));
    if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
    throw new Error('This GenerateContent endpoint requires inline attachments.');
  });
}

export async function* streamGenerateContentBridge(client: OpenAI, params: Record<string, any>, signal?: AbortSignal, conversationScope?: string): AsyncGenerator<any> {
  const native = new GoogleGenAI({ apiKey: client.apiKey ?? '', httpOptions: { baseUrl: client.baseURL.replace(/\/v1\/?$/, ''), apiVersion: 'v1', timeout: MODEL_REQUEST_TIMEOUT_MS } });
  const contents: any[] = [];
  const system: string[] = [];
  const callNames = new Map<string, { name: string; id?: string }>();
  for (const message of params.messages || []) {
    if (message.role === 'system' || message.role === 'developer') { system.push(textContent(message.content)); continue; }
    for (const [index, call] of (message.tool_calls || []).entries()) {
      const nativeCall = message.gemini_content?.filter((part: any) => part.functionCall)[index]?.functionCall;
      callNames.set(call.id, { name: call.function.name, id: nativeCall ? nativeCall.id : call.id });
    }
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = message.role === 'tool'
      ? [{ functionResponse: { ...callNames.get(message.tool_call_id), response: { result: message.content } } }]
      : message.role === 'assistant' && Array.isArray(message.gemini_content) ? [...message.gemini_content]
        : [...geminiParts(message.content), ...(message.tool_calls || []).map((call: any) => ({ functionCall: { id: call.id, name: call.function.name, args: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments || {} } }))];
    if (!parts.length) continue;
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  }
  const config: any = { systemInstruction: system.join('\n\n'), abortSignal: signal };
  if (params.tools?.length) config.tools = [{ functionDeclarations: params.tools.map((tool: any) => ({ name: tool.function.name, description: tool.function.description, parametersJsonSchema: tool.function.parameters })) }];
  if (params.thinkingLevel !== undefined) config.thinkingConfig = { thinkingLevel: params.thinkingLevel, includeThoughts: true };
  if (params.thinkingBudget !== undefined) config.thinkingConfig = { thinkingBudget: params.thinkingBudget, includeThoughts: true };
  if (params.max_completion_tokens ?? params.max_tokens) config.maxOutputTokens = params.max_completion_tokens ?? params.max_tokens;
  if (params.temperature !== undefined) config.temperature = params.temperature;
  const cacheObservation = beginPromptCacheDiagnostics({
    provider: 'gemini', model: params.model, scope: conversationScope,
    endpoint: client.baseURL, apiKey: client.apiKey ?? '', request: { ...config, contents },
  });
  const stream = await native.models.generateContentStream({ model: params.model, contents, config });
  const parts: any[] = [];
  const calls: any[] = [];
  let usage: any;
  let finishReason = '';
  for await (const chunk of stream) {
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (chunk.usageMetadata) usage = normalizeProviderCacheUsage('gemini', chunk.usageMetadata);
    for (const part of candidate?.content?.parts || []) {
      // Retain signatures and every native block for tool continuation.
      parts.push(part);
      if (part.text) yield { choices: [{ delta: part.thought ? { reasoning: part.text } : { content: part.text } }] };
      if (part.functionCall) {
        const call = part.functionCall;
        const id = call.id || `call_${randomUUID()}`;
        calls.push({ index: calls.length, id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args || {}) } });
      }
    }
  }
  if (finishReason !== 'STOP') throw new Error(`MODEL_STREAM_INCOMPLETE: GenerateContent endpoint ended with ${finishReason || 'no finish reason'}.`);
  if (usage) cacheObservation?.complete(usage);
  yield { choices: [{ delta: { tool_calls: calls }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage, prompt_cache_diagnostics: cacheObservation?.report, provider_message: { gemini_content: parts } };
}
