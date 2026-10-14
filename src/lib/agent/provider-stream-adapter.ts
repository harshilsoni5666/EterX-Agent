import type OpenAI from 'openai';
import type { MainAgentProvider } from './model-routing';
import { applyOpenAIResponsesCachePolicy, mergeProviderUsageSnapshots, withOpenAICacheFallback } from './provider-prompt-cache';
import { beginPromptCacheDiagnostics } from './prompt-cache-diagnostics';
import { getProviderProtocol } from './provider-protocol';
import { streamMessagesBridge, streamGenerateContentBridge } from './provider-native-bridge';
import { getDocumentedThinkingCapabilities } from './model-thinking-contracts';
import { extractCompatibleReasoningText, extractProviderReasoningText, reasoningContinuationFields } from './provider-capabilities';

const toResponsesTools = (tools: any[] = []) => tools.map(tool => ({
  type: 'function',
  name: tool?.function?.name,
  description: tool?.function?.description,
  parameters: tool?.function?.parameters || { type: 'object', properties: {} },
  // Preserve real optional fields instead of implicitly requiring them all.
  strict: tool?.function?.strict ?? false,
}));

function toResponsesContent(content: any): any {
  if (!Array.isArray(content)) return content ?? '';
  return content.map(part => {
    if (typeof part === 'string' || part?.type === 'text') {
      // Constructed history uses input content parts even for an assistant
      // role. Native output_text items are replayed via responses_output.
      return { type: 'input_text', text: typeof part === 'string' ? part : part.text };
    }
    if (part?.type === 'image_url') {
      return { type: 'input_image', image_url: part.image_url?.url ?? part.image_url, detail: part.image_url?.detail || 'auto' };
    }
    if (part?.type === 'file') {
      const file = part.file || {};
      return { type: 'input_file', ...(file.file_id
        ? { file_id: file.file_id }
        : { file_data: file.file_data, filename: file.filename }) };
    }
    return part;
  });
}

const toResponsesInput = (messages: any[] = []) => {
  const input: any[] = [];
  for (const message of messages) {
    if (message?.role === 'assistant' && message.responses_output?.length) {
      input.push(...message.responses_output);
      continue;
    }
    if (message?.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null) });
      continue;
    }
    const role = message?.role || 'user';
    if (role === 'assistant' && message.tool_calls?.length) {
      if (message.content) input.push({ role, content: toResponsesContent(message.content) });
      for (const call of message.tool_calls) {
        input.push({ type: 'function_call', call_id: call.id, name: call?.function?.name,
          arguments: typeof call?.function?.arguments === 'string'
            ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? {}) });
      }
      continue;
    }
    input.push({ role, content: toResponsesContent(message?.content) });
  }
  return input;
};

function responsesRequest(params: Record<string, any>, provider: MainAgentProvider): Record<string, any> {
  const body: Record<string, any> = { model: params.model, input: toResponsesInput(params.messages), stream: true };
  if (params.tools?.length) body.tools = toResponsesTools(params.tools);
  if (params.tool_choice !== undefined) {
    body.tool_choice = params.tool_choice?.type === 'function'
      ? { type: 'function', name: params.tool_choice.function?.name ?? params.tool_choice.name } : params.tool_choice;
  }
  const reasoning = { ...params.reasoning };
  if (params.reasoning_effort !== undefined) reasoning.effort = params.reasoning_effort;
  delete reasoning.exclude;
  const nativeOpenAI = provider === 'openai' || (provider === 'opencode' && /^gpt-/i.test(params.model));
  const modelId = String(params.model || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const supportsSummary = (getDocumentedThinkingCapabilities('openai', modelId)?.levels.length
    && !/^(?:o1|o3-mini)(?:-|$)/i.test(modelId))
    || ['o3-pro', 'o3-deep-research', 'o4-mini-deep-research', 'codex-mini-latest', 'computer-use-preview'].includes(modelId);
  if (nativeOpenAI && supportsSummary && reasoning.effort !== 'none') {
    // Thinking effort alone does not return readable reasoning. Opt in to
    // summaries on the models whose documented contract supports them.
    reasoning.summary ??= 'auto';
  }
  if (Object.keys(reasoning).length) body.reasoning = reasoning;
  const maxTokens = params.max_output_tokens ?? params.max_completion_tokens ?? params.max_tokens;
  if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
  for (const field of ['parallel_tool_calls', 'temperature', 'top_p', 'service_tier', 'user', 'metadata', 'prompt_cache_key', 'prompt_cache_retention']) {
    if (params[field] !== undefined) body[field] = params[field];
  }
  if (nativeOpenAI) {
    // Tool continuations need the complete reasoning items even when account
    // policy disables storage. A reasoning summary cannot replace them.
    body.store = false;
    body.include = ['reasoning.encrypted_content'];
  }
  return body;
}

async function* streamProviderResponses(
  client: OpenAI, provider: MainAgentProvider, params: Record<string, any>, signal?: AbortSignal,
): AsyncGenerator<any> {
  const body = responsesRequest(params, provider);
  if (provider === 'openai') applyOpenAIResponsesCachePolicy(body, params.messages || []);
  const send = (request: Record<string, any>) => (client.responses.create as any)(request, signal ? { signal } : undefined);
  const events: any = await (provider === 'openai' ? withOpenAICacheFallback(body, send) : send(body));
  type Call = { index: number; id: string; name: string; arguments: string; emitted: boolean };
  const calls: Call[] = [];
  const callKeys = new Map<string, Call>();
  const textByItem = new Map<string, string>();
  const reasoningByPart = new Map<string, string>();
  const outputIndexes = new Map<string, number>();
  let lastReasoningPart = '';

  const itemKey = (id: unknown, index: unknown): string => {
    const itemId = String(id || '');
    if (Number.isInteger(index)) {
      if (itemId) outputIndexes.set(itemId, index as number);
      return `output:${index}`;
    }
    const knownIndex = outputIndexes.get(itemId);
    return knownIndex !== undefined ? `output:${knownIndex}` : itemId;
  };

  const registerCall = (item: any = {}, event: any = {}): Call => {
    const keys = [item.id, item.call_id, event.item_id, event.call_id,
      Number.isInteger(event.output_index) ? `output:${event.output_index}` : ''].filter(Boolean).map(String);
    let call = keys.map(key => callKeys.get(key)).find(Boolean);
    if (!call) {
      call = { index: calls.length, id: '', name: '', arguments: '', emitted: false };
      calls.push(call);
    }
    if (item.call_id) call.id = item.call_id;
    if (item.name) call.name = item.name;
    for (const key of keys) callKeys.set(key, call);
    return call;
  };
  const finishCall = (item: any, event: any): any | null => {
    const call = registerCall(item, event);
    if (call.emitted) return null;
    if (typeof item.arguments === 'string') call.arguments = item.arguments;
    if (!call.id || !call.name) throw new Error(`MODEL_STREAM_INCOMPLETE: ${provider} returned a tool call without its identity.`);
    call.emitted = true;
    return { choices: [{ delta: { tool_calls: [{ index: call.index, id: call.id, type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' } }] } }] };
  };
  const finishText = (key: string, full: string): any | null => {
    const streamed = textByItem.get(key) || '';
    const remaining = full.startsWith(streamed) ? full.slice(streamed.length) : '';
    textByItem.set(key, full);
    return remaining ? { choices: [{ delta: { content: remaining } }] } : null;
  };
  const appendReasoning = (key: string, delta: string): any | null => {
    if (!delta) return null;
    const previous = reasoningByPart.get(key) || '';
    reasoningByPart.set(key, previous + delta);
    // Summary parts have independent deltas. Preserve a paragraph boundary
    // so a new provider heading cannot run into the preceding summary text.
    const separator = !previous && lastReasoningPart && lastReasoningPart !== key ? '\n\n' : '';
    lastReasoningPart = key;
    return { choices: [{ delta: { reasoning: separator + delta } }] };
  };
  const finishReasoning = (key: string, full: string): any | null => {
    const streamed = reasoningByPart.get(key) || '';
    return full.startsWith(streamed) ? appendReasoning(key, full.slice(streamed.length)) : null;
  };
  const reasoningKey = (event: any, summary: boolean) =>
    `${summary ? 'summary' : 'content'}:${itemKey(event.item_id, event.output_index)}:${summary ? event.summary_index ?? 0 : event.content_index ?? 0}`;
  function* finishReasoningItem(item: any, index: number): Generator<any> {
    const key = itemKey(item.id, index);
    for (const [partIndex, part] of (Array.isArray(item.summary) ? item.summary : []).entries()) {
      const chunk = finishReasoning(`summary:${key}:${partIndex}`, extractProviderReasoningText(part));
      if (chunk) yield chunk;
    }
    for (const [partIndex, part] of (Array.isArray(item.content) ? item.content : []).entries()) {
      if (part.type !== 'reasoning_text') continue;
      const chunk = finishReasoning(`content:${key}:${partIndex}`, extractProviderReasoningText(part));
      if (chunk) yield chunk;
    }
  }

  for await (const event of events) {
    const type = String(event?.type || '');
    // A gateway may omit item_id on deltas but include it in the final item.
    // Use the stable output position for both so snapshots do not duplicate
    // a streamed heading or open a second thought card for the same summary.
    itemKey(event.item?.id || event.item_id, event.output_index);
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const key = `${itemKey(event.item_id, event.output_index)}:${event.content_index ?? 0}`;
      const delta = String(event.delta || '');
      textByItem.set(key, `${textByItem.get(key) || ''}${delta}`);
      if (delta) yield { choices: [{ delta: { content: delta } }] };
    } else if (type === 'response.output_text.done' || type === 'response.refusal.done') {
      const key = `${itemKey(event.item_id, event.output_index)}:${event.content_index ?? 0}`;
      const chunk = finishText(key, String(event.text ?? event.refusal ?? ''));
      if (chunk) yield chunk;
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const chunk = appendReasoning(reasoningKey(event, type === 'response.reasoning_summary_text.delta'), String(event.delta || ''));
      if (chunk) yield chunk;
    } else if (type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_text.done') {
      const chunk = finishReasoning(reasoningKey(event, type === 'response.reasoning_summary_text.done'), String(event.text || ''));
      if (chunk) yield chunk;
    } else if (type === 'response.reasoning_summary_part.added' || type === 'response.reasoning_summary_part.done') {
      const chunk = finishReasoning(reasoningKey(event, true), extractProviderReasoningText(event.part));
      if (chunk) yield chunk;
    } else if ((type === 'response.content_part.added' || type === 'response.content_part.done') && event.part?.type === 'reasoning_text') {
      const chunk = finishReasoning(reasoningKey(event, false), extractProviderReasoningText(event.part));
      if (chunk) yield chunk;
    } else if ((type === 'response.output_item.added' || type === 'response.output_item.done') && event.item?.type === 'reasoning') {
      yield* finishReasoningItem(event.item, event.output_index);
      if (type === 'response.output_item.done') yield { choices: [{ delta: { reasoning_boundary: true } }] };
    } else if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const call = registerCall(event.item, event);
      call.arguments = String(event.item.arguments || '');
    } else if (type === 'response.function_call_arguments.delta') {
      registerCall({}, event).arguments += String(event.delta || '');
    } else if (type === 'response.function_call_arguments.done') {
      const call = registerCall({}, event);
      if (typeof event.arguments === 'string') call.arguments = event.arguments;
    } else if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const chunk = finishCall(event.item, event);
      if (chunk) yield chunk;
    } else if (type === 'response.completed') {
      const output = event.response?.output;
      // Some compatible endpoints omit item-done/delta events. Reconcile the
      // authoritative snapshot without appending full JSON to partial JSON.
      for (const [index, item] of (Array.isArray(output) ? output : []).entries()) {
        if (item.type === 'function_call') {
          const chunk = finishCall(item, { output_index: index });
          if (chunk) yield chunk;
        } else if (item.type === 'reasoning') {
          yield* finishReasoningItem(item, index);
          yield { choices: [{ delta: { reasoning_boundary: true } }] };
        } else if (item.type === 'message') {
          for (const [contentIndex, part] of (item.content || []).entries()) {
            if (part.type !== 'output_text' && part.type !== 'refusal') continue;
            const chunk = finishText(`${itemKey(item.id, index)}:${contentIndex}`, String(part.text ?? part.refusal ?? ''));
            if (chunk) yield chunk;
          }
        }
      }
      if (calls.some(call => !call.emitted)) throw new Error(`MODEL_STREAM_INCOMPLETE: ${provider} did not finish its tool arguments.`);
      yield { choices: [{ finish_reason: calls.length > 0 ? 'tool_calls' : 'stop', delta: {} }],
        usage: event.response?.usage, responses_output: output };
      return;
    } else if (type === 'response.incomplete' || type === 'response.failed' || type === 'error') {
      const detail = event?.response?.incomplete_details?.reason || event?.response?.error?.message || event?.error?.message || event?.message || type;
      throw Object.assign(new Error(`MODEL_STREAM_INCOMPLETE: ${provider} Responses API returned ${detail}.`), {
        cause: event?.response?.error || event?.error,
      });
    }
  }
  throw new Error(`MODEL_STREAM_INCOMPLETE: ${provider} Responses stream closed before completion.`);
}

async function* streamCompatibleChat(
  client: OpenAI, provider: MainAgentProvider, params: Record<string, any>, signal?: AbortSignal,
): AsyncGenerator<any> {
  const body: Record<string, any> = { ...params, stream: true };
  // Responses metadata can remain in a checkpoint after switching models.
  body.messages = (params.messages || []).map(({ responses_output: _output, anthropic_content: _anthropic, gemini_content: _gemini, ...message }: any) => message);
  if (provider === 'minimax') body.reasoning_split = true;
  if (provider === 'openrouter' && body.reasoning && body.reasoning.enabled !== false && body.reasoning.effort !== 'none') {
    body.reasoning = { ...body.reasoning, exclude: false };
  }
  const send = (request: Record<string, any>) => client.chat.completions.create(request as any, signal ? { signal } : undefined) as any;
  const stream: AsyncIterable<any> = await (provider === 'openai' ? withOpenAICacheFallback(body, send) : send(body));
  const textByChoice = new Map<number, string>();
  const reasoningByChoice = new Map<number, string>();
  for await (const chunk of stream) {
    if (!Array.isArray(chunk?.choices)) { yield chunk; continue; }
    let snapshotFields: Record<string, unknown> | undefined;
    const choices = chunk.choices.map((choice: any, position: number) => {
      const index = choice.index ?? position;
      const delta = { ...choice.delta };
      const reasoningDelta = extractCompatibleReasoningText(delta);
      if (reasoningDelta) {
        reasoningByChoice.set(index, (reasoningByChoice.get(index) || '') + reasoningDelta);
      } else {
        const snapshot = extractCompatibleReasoningText(choice.message);
        const previous = reasoningByChoice.get(index) || '';
        if (snapshot && snapshot.startsWith(previous)) {
          const remaining = snapshot.slice(previous.length);
          const field = typeof choice.message?.reasoning_content === 'string' ? 'reasoning_content' : 'reasoning';
          if (remaining) delta[field] = remaining;
          reasoningByChoice.set(index, snapshot);
          if (position === 0) snapshotFields = reasoningContinuationFields(provider, snapshot, choice.message?.reasoning_details, choice.message);
        }
      }
      // Local gateways sometimes stream cumulative message objects. Convert
      // explicit snapshots into deltas before the Agent's tagged parser sees
      // them, keeping reasoning and the visible answer on the same UI path.
      if (typeof delta.content === 'string' && delta.content) {
        textByChoice.set(index, (textByChoice.get(index) || '') + delta.content);
      } else if (typeof choice.message?.content === 'string') {
        const previous = textByChoice.get(index) || '';
        if (choice.message.content.startsWith(previous)) {
          delta.content = choice.message.content.slice(previous.length);
          textByChoice.set(index, choice.message.content);
        }
      }
      return { ...choice, delta };
    });
    yield { ...chunk, choices, ...(snapshotFields ? { provider_message: { ...chunk.provider_message, ...snapshotFields } } : {}) };
  }
}

export function createProviderChatStream(
  client: OpenAI, provider: MainAgentProvider, params: Record<string, any>, signal?: AbortSignal, capabilities: string[] = [],
  conversationScope?: string,
): AsyncIterable<any> {
  const protocol = getProviderProtocol(provider, String(params.model || ''), capabilities);
  let stream: AsyncIterable<any>;
  switch (protocol) {
    case 'responses': stream = streamProviderResponses(client, provider, params, signal); break;
    case 'messages': return streamMessagesBridge(client, params, signal, conversationScope);
    case 'generateContent': return streamGenerateContentBridge(client, params, signal, conversationScope);
    default: stream = streamCompatibleChat(client, provider, params, signal);
  }
  const observation = beginPromptCacheDiagnostics({
    provider, model: String(params.model || ''), scope: conversationScope,
    endpoint: client.baseURL, apiKey: client.apiKey,
    request: protocol === 'responses' ? responsesRequest(params, provider) : params,
  });
  if (!observation) return stream;
  return (async function* () {
    let usage: any;
    for await (const chunk of stream) {
      if (chunk?.usage) usage = mergeProviderUsageSnapshots(usage, chunk.usage);
      yield chunk?.usage ? { ...chunk, prompt_cache_diagnostics: observation.report } : chunk;
    }
    // Failed or cancelled streams never replace a successful request baseline.
    if (usage) observation.complete(usage);
  })();
}
