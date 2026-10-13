import assert from 'node:assert/strict';
import {
  applyOpenAIPromptCachePolicy, applyAnthropicPromptCachePolicy,
  buildProviderConversationCacheId, canUseExplicitGeminiSystemCache,
  withOpenAICacheFallback, resolveProviderPromptCacheMode,
} from '../src/lib/agent/provider-prompt-cache';
import { createProviderChatStream } from '../src/lib/agent/provider-stream-adapter';
import { isInterruptedProviderStream, isProviderFailoverError, withApiKeyRounds } from '../src/lib/agent/api-retry';
import { getGeminiThinkingConfig, getModelThinkingOptions, inferModelThinkingCapabilities } from '../src/lib/agent/model-routing';
import { applyCompatibleThinkingParameters } from '../src/lib/agent/provider-capabilities';
import { OPENAI_COMPATIBLE_PROVIDERS } from '../src/lib/agent/provider-runtime';

async function main() {
  assert.equal(isInterruptedProviderStream(new Error('Incomplete JSON segment at the end')), true);
  assert.equal(isInterruptedProviderStream(new Error('MODEL_STREAM_INCOMPLETE: provider closed the stream without a finish reason.')), true);
  assert.equal(isInterruptedProviderStream(new Error('MODEL_STREAM_INCOMPLETE: provider ended the stream with finish_reason=length.')), false);
  assert.equal(isInterruptedProviderStream(new Error('Invalid JSON payload')), false);
  assert.equal(isInterruptedProviderStream(new Error('CANCELLED_BY_USER')), false);
  const savedRetention = process.env.OPENAI_PROMPT_CACHE_RETENTION;
  try {
    delete process.env.OPENAI_PROMPT_CACHE_RETENTION;
    for (const model of ['gpt-4o', 'gpt-4.1', 'o3', 'o4-mini', 'gpt-5', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6', 'gpt-6', 'future-model']) {
      const body: any = { model };
      applyOpenAIPromptCachePolicy(body, { model, staticPrompt: 'stable', tools: [] });
      assert.equal(body.prompt_cache_retention, undefined);
      assert.ok(body.prompt_cache_key);
    }
    for (const retention of ['in-memory', 'in_memory', '24h', 'invalid']) {
      process.env.OPENAI_PROMPT_CACHE_RETENTION = retention;
      const body: any = {};
      applyOpenAIPromptCachePolicy(body, { model: 'gpt-4.1', staticPrompt: 'stable', tools: [] });
      assert.equal(body.prompt_cache_retention, retention === 'invalid' ? undefined : retention.replace('-', '_'));
    }
    process.env.OPENAI_PROMPT_CACHE_RETENTION = 'in-memory';
    for (const model of ['gpt-5.5', 'gpt-5.6', 'gpt-6.1-sol']) {
      const body: any = {};
      applyOpenAIPromptCachePolicy(body, { model, staticPrompt: 'stable', tools: [] });
      assert.equal(body.prompt_cache_retention, undefined);
    }
  } finally {
    if (savedRetention === undefined) delete process.env.OPENAI_PROMPT_CACHE_RETENTION;
    else process.env.OPENAI_PROMPT_CACHE_RETENTION = savedRetention;
  }

  const bodies: any[] = [];
  const params = { model: 'new-model', prompt_cache_key: 'key', prompt_cache_retention: '24h', tools: [{ name: 'tool' }], reasoning_effort: 'high' };
  const client: any = { chat: { completions: { create: async (body: any) => {
    bodies.push(body);
    if (bodies.length === 1) throw Object.assign(new Error('Unsupported parameter: prompt_cache_retention'), { status: 400 });
    return (async function* () { yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }; })();
  } } } };
  const stream = await createProviderChatStream(client, 'openai', params);
  for await (const chunk of stream) assert.equal(chunk.choices[0].delta.content, 'ok');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].prompt_cache_retention, undefined);
  assert.equal(bodies[1].prompt_cache_key, undefined);
  assert.deepEqual(bodies[1].tools, params.tools);
  assert.equal(bodies[1].reasoning_effort, 'high');
  assert.equal(params.prompt_cache_key, 'key', 'do not mutate the next request');
  for (const [status, message] of [[401, 'prompt_cache_key'], [400, 'Invalid value: reasoning_effort'], [429, 'prompt_cache_key']] as const) {
    let attempts = 0;
    await assert.rejects(withOpenAICacheFallback(params, async () => {
      attempts++;
      throw Object.assign(new Error(message), { status });
    }));
    assert.equal(attempts, 1);
  }
  let boundedAttempts = 0;
  await assert.rejects(withOpenAICacheFallback(params, async () => {
    boundedAttempts++;
    throw Object.assign(new Error('prompt_cache_key not supported'), { status: 400 });
  }));
  assert.equal(boundedAttempts, 2);

  const claude: any = {
    tools: [{ name: 'a', cache_control: {} }, { name: 'b', cache_control: {} }],
    system: [{ type: 'text', text: 'stable' }, { type: 'text', text: 'dynamic' }],
    messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: [
      { type: 'text', text: 'answer', cache_control: {} },
      { type: 'thinking', thinking: 'reasoning', cache_control: {} },
      { type: 'text', text: '', cache_control: {} },
    ] }],
  };
  applyAnthropicPromptCachePolicy(claude, true);
  assert.equal(JSON.stringify(claude).match(/cache_control/g)?.length, 4);
  assert.equal(claude.messages[1].content[1].cache_control, undefined);
  assert.equal(claude.messages[1].content[2].cache_control, undefined);
  assert.ok(claude.messages[1].content[0].cache_control);
  applyAnthropicPromptCachePolicy(claude, true);
  assert.equal(JSON.stringify(claude).match(/cache_control/g)?.length, 4);
  applyAnthropicPromptCachePolicy(claude, false);
  assert.equal(JSON.stringify(claude).includes('cache_control'), false);

  assert.equal(canUseExplicitGeminiSystemCache('dynamic system rules'), false);
  assert.equal(canUseExplicitGeminiSystemCache(''), true);
  assert.deepEqual(getGeminiThinkingConfig('medium', 'gemini-3-pro-preview', true), { thinkingLevel: 'high', includeThoughts: true });
  assert.deepEqual(getGeminiThinkingConfig('minimal', 'gemini-3.8-flash', true), { thinkingLevel: 'medium', includeThoughts: true });
  assert.equal(getGeminiThinkingConfig('off', 'gemini-2.5-pro', false)?.thinkingBudget, 8192);

  for (const [model, requested, expected] of [
    ['grok-3', 'medium', undefined], ['grok-4', 'medium', undefined],
    ['grok-4-fast-non-reasoning', 'high', undefined],
    ['grok-3-mini', 'medium', 'low'], ['grok-4.5', 'medium', 'medium'], ['grok-4.7', 'xhigh', 'xhigh'],
  ] as const) {
    const body: any = {};
    applyCompatibleThinkingParameters(body, 'grok', model, { level: requested, capabilities: inferModelThinkingCapabilities('grok', model) });
    assert.equal(body.reasoning_effort, expected, model);
  }
  assert.ok(getModelThinkingOptions('openai', 'gpt-5.4-mini').some(option => option.id === 'xhigh'));
  assert.equal(buildProviderConversationCacheId('openai', 'chat'), null);
  assert.notEqual(buildProviderConversationCacheId('grok', 'a'), buildProviderConversationCacheId('grok', 'b'));

  // Every compatible provider retains automatic prefix caching without receiving
  // another vendor's cache parameters, including newly configured model IDs.
  for (const provider of Object.keys(OPENAI_COMPATIBLE_PROVIDERS)) {
    assert.notEqual(resolveProviderPromptCacheMode(provider as any, true), 'disabled');
    assert.equal(resolveProviderPromptCacheMode(provider as any, false), 'disabled');
  }
  for (const status of [400, 404, 413, 422]) assert.equal(isProviderFailoverError({ status, message: 'rejected' }), false);
  for (const status of [401, 403, 429, 500, 503]) assert.equal(isProviderFailoverError({ status, message: 'unavailable' }), true);
  let invalidCalls = 0;
  await assert.rejects(withApiKeyRounds(['one', 'two'], { apiRetries: 3 }, async () => {
    invalidCalls++;
    throw Object.assign(new Error("400 Invalid value: 'in-memory'"), { status: 400 });
  }));
  assert.equal(invalidCalls, 1);
  console.log('provider cache/request contract tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
