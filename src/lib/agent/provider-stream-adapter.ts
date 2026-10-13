import type OpenAI from 'openai';
import type { MainAgentProvider } from './model-routing';
import { applyOpenAIResponsesCachePolicy, withOpenAICacheFallback } from './provider-prompt-cache';
import { getProviderProtocol } from './provider-protocol';
import { streamMessagesBridge, streamGenerateContentBridge } from './provider-native-bridge';

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
  if (Object.keys(reasoning).length) body.reasoning = reasoning;
  const maxTokens = params.max_output_tokens ?? params.max_completion_tokens ?? params.max_tokens;
  if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
  for (const field of ['parallel_tool_calls', 'temperature', 'top_p', 'service_tier', 'user', 'metadata', 'prompt_cache_key', 'prompt_cache_retention']) {
    if (params[field] !== undefined) body[field] = params[field];
  }
  if (provider === 'openai' || (provider === 'opencode' && /^gpt-/i.test(params.model))) {
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

  for await (const event of events) {
    const type = String(event?.type || '');
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const key = `${event.item_id || event.output_index}:${event.content_index ?? 0}`;
      const delta = String(event.delta || '');
      textByItem.set(key, `${textByItem.get(key) || ''}${delta}`);
      if (delta) yield { choices: [{ delta: { content: delta } }] };
    } else if (type === 'response.output_text.done' || type === 'response.refusal.done') {
      const key = `${event.item_id || event.output_index}:${event.content_index ?? 0}`;
      const chunk = finishText(key, String(event.text ?? event.refusal ?? ''));
      if (chunk) yield chunk;
    } else if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && event.delta) {
      yield { choices: [{ delta: { reasoning: event.delta } }] };
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
        } else if (item.type === 'message') {
          for (const [contentIndex, part] of (item.content || []).entries()) {
            if (part.type !== 'output_text' && part.type !== 'refusal') continue;
            const chunk = finishText(`${item.id || index}:${contentIndex}`, String(part.text ?? part.refusal ?? ''));
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
  const send = (request: Record<string, any>) => client.chat.completions.create(request as any, signal ? { signal } : undefined) as any;
  const stream: AsyncIterable<any> = await (provider === 'openai' ? withOpenAICacheFallback(body, send) : send(body));
  yield* stream;
}

export function createProviderChatStream(
  client: OpenAI, provider: MainAgentProvider, params: Record<string, any>, signal?: AbortSignal, capabilities: string[] = [],
): AsyncIterable<any> {
  switch (getProviderProtocol(provider, String(params.model || ''), capabilities)) {
    case 'responses': return streamProviderResponses(client, provider, params, signal);
    case 'messages': return streamMessagesBridge(client, params, signal);
    case 'generateContent': return streamGenerateContentBridge(client, params, signal);
    default: return streamCompatibleChat(client, provider, params, signal);
  }
}
