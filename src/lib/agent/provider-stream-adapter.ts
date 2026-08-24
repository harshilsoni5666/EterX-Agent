import type OpenAI from 'openai';
import type { MainAgentProvider } from './model-routing';

const toResponsesTools = (tools: any[] = []) => tools.map(tool => ({
  type: 'function',
  name: tool?.function?.name,
  description: tool?.function?.description,
  parameters: tool?.function?.parameters || { type: 'object', properties: {} },
}));

const toResponsesInput = (messages: any[] = []) => {
  const input: any[] = [];
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.responses_output)) {
      input.push(...message.responses_output);
      continue;
    }
    if (message?.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      });
      continue;
    }
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call?.function?.name,
          arguments: String(call?.function?.arguments || '{}'),
        });
      }
      continue;
    }
    input.push({ role: message?.role || 'user', content: message?.content || '' });
  }
  return input;
};

async function* streamPerplexityResponses(
  client: OpenAI,
  params: Record<string, any>,
  signal?: AbortSignal,
): AsyncGenerator<any> {
  const body: any = {
    model: params.model,
    input: toResponsesInput(params.messages),
    stream: true,
    ...(Array.isArray(params.tools) && params.tools.length > 0 ? { tools: toResponsesTools(params.tools) } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    ...(params.max_completion_tokens || params.max_tokens
      ? { max_output_tokens: params.max_completion_tokens || params.max_tokens }
      : {}),
  };
  const events: any = await (client.responses.create as any)(body, signal ? { signal } : undefined);
  const callIndexes = new Map<string, number>();
  const callArguments = new Map<string, string>();
  let nextCallIndex = 0;

  for await (const event of events) {
    const type = String(event?.type || '');
    if (type === 'response.output_text.delta' && event.delta) {
      yield { choices: [{ delta: { content: event.delta } }] };
    } else if (
      (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta')
      && event.delta
    ) {
      yield { choices: [{ delta: { reasoning: event.delta } }] };
    } else if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const key = String(event.item.id || event.item.call_id || `call-${nextCallIndex}`);
      const index = nextCallIndex++;
      callIndexes.set(key, index);
      callArguments.set(key, '');
      yield {
        choices: [{ delta: { tool_calls: [{
          index,
          id: event.item.call_id || event.item.id,
          type: 'function',
          function: { name: event.item.name || '', arguments: '' },
        }] } }],
      };
    } else if (type === 'response.function_call_arguments.delta') {
      const key = String(event.item_id || event.call_id || '');
      const index = callIndexes.get(key);
      if (index !== undefined) {
        const delta = String(event.delta || '');
        callArguments.set(key, `${callArguments.get(key) || ''}${delta}`);
        yield { choices: [{ delta: { tool_calls: [{ index, function: { arguments: delta } }] } }] };
      }
    } else if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const key = String(event.item.id || event.item.call_id || '');
      let index = callIndexes.get(key);
      if (index === undefined) {
        index = nextCallIndex++;
        callIndexes.set(key, index);
        yield {
          choices: [{ delta: { tool_calls: [{
            index,
            id: event.item.call_id || event.item.id,
            type: 'function',
            function: { name: event.item.name || '', arguments: String(event.item.arguments || '{}') },
          }] } }],
        };
      } else {
        const completeArguments = String(event.item.arguments || '');
        const streamedArguments = callArguments.get(key) || '';
        if (completeArguments && completeArguments !== streamedArguments) {
          const remaining = completeArguments.startsWith(streamedArguments)
            ? completeArguments.slice(streamedArguments.length)
            : completeArguments;
          callArguments.set(key, completeArguments);
          if (remaining) {
            yield { choices: [{ delta: { tool_calls: [{ index, function: { arguments: remaining } }] } }] };
          }
        }
      }
    } else if (type === 'response.completed') {
      yield {
        choices: [{ finish_reason: callIndexes.size > 0 ? 'tool_calls' : 'stop', delta: {} }],
        usage: event.response?.usage,
        responses_output: event.response?.output,
      };
    } else if (type === 'response.incomplete' || type === 'response.failed' || type === 'error') {
      const detail = event?.response?.incomplete_details?.reason || event?.response?.error?.message || event?.error?.message || type;
      throw new Error(`MODEL_STREAM_INCOMPLETE: Perplexity Agent API returned ${detail}.`);
    }
  }
}

export function createProviderChatStream(
  client: OpenAI,
  provider: MainAgentProvider,
  params: Record<string, any>,
  signal?: AbortSignal,
): Promise<AsyncIterable<any>> | AsyncIterable<any> {
  if (provider === 'perplexity') {
    return streamPerplexityResponses(client, params, signal);
  }
  return client.chat.completions.create(
    { ...params, stream: true } as any,
    signal ? { signal } : undefined,
  ) as any;
}
