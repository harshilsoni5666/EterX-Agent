import assert from 'node:assert/strict';
import { getOrCreateAgentCache, invalidateAgentCacheForKey } from '../src/lib/agent/agent-cache';
import { IntelligentCache } from '../src/lib/agent/next_gen';
import {
  applyOpenAIPromptCachePolicy,
  buildOpenAISystemPromptContent,
  buildProviderConversationCacheId,
  buildPromptCacheIdentity,
  normalizeProviderCacheUsage,
  removeOpenAIPromptCachePolicy,
  resolveProviderPromptCacheMode,
} from '../src/lib/agent/provider-prompt-cache';

async function testScopedToolCache(): Promise<void> {
  const cache = new IntelligentCache();
  const argsA = { expression: '2 + 2', nested: { b: 2, a: 1 } };
  const argsB = { nested: { a: 1, b: 2 }, expression: '2 + 2' };

  cache.set('web_search', argsA, { value: 4 }, 'project-a|workspace-a');
  assert.deepEqual(
    cache.get('web_search', argsB, 'project-a|workspace-a'),
    { value: 4 },
    'nested argument ordering should not create avoidable cache misses',
  );
  assert.equal(
    cache.get('web_search', argsB, 'project-b|workspace-b'),
    null,
    'tool results must not leak across project/workspace scopes',
  );

  const first = cache.get('web_search', argsA, 'project-a|workspace-a');
  first.value = 99;
  assert.deepEqual(
    cache.get('web_search', argsA, 'project-a|workspace-a'),
    { value: 4 },
    'callers must not mutate the cached value',
  );

  cache.set('workspace_run_command', { command: 'Get-Content agent.ts' }, { content: 'old' }, 'project-a|workspace-a');
  cache.set('workspace_edit_file', { filename: 'agent.ts' }, { success: true }, 'project-a|workspace-a');
  assert.equal(
    cache.get('workspace_run_command', { command: 'Get-Content agent.ts' }, 'project-a|workspace-a'),
    null,
    'workspace tools must never be served from the result cache',
  );
}

async function testRemoteContextCache(): Promise<void> {
  const calls = { create: 0, delete: 0 };
  const ai = {
    caches: {
      create: async () => {
        calls.create++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { name: `cachedContents/${calls.create}` };
      },
      delete: async () => {
        calls.delete++;
      },
      update: async () => undefined,
    },
  };
  const apiKey = 'cache-test-key-with-a-unique-value';
  const model = 'gemini-2.5-flash';
  const sharedPrefix = 'x'.repeat(800);
  const declarationsA = [{ name: 'tool', description: sharedPrefix, parameters: { marker: 'a' } }];
  const declarationsB = [{ name: 'tool', description: sharedPrefix, parameters: { marker: 'b' } }];

  const [first, second] = await Promise.all([
    getOrCreateAgentCache(ai, apiKey, model, 'system', declarationsA),
    getOrCreateAgentCache(ai, apiKey, model, 'system', declarationsA),
  ]);
  assert.equal(first, second, 'concurrent identical requests should share one remote cache creation');
  assert.equal(calls.create, 1);

  const changed = await getOrCreateAgentCache(ai, apiKey, model, 'system', declarationsB);
  assert.notEqual(changed, first, 'changes after the old 600-character sample boundary must invalidate cache');
  assert.equal(calls.create, 2);
  assert.equal(calls.delete, 0, 'content-addressed variants must not evict one another');
  assert.equal(
    await getOrCreateAgentCache(ai, apiKey, model, 'system', declarationsA),
    first,
    'returning to a previous stable tool surface should reuse its remote cache',
  );

  invalidateAgentCacheForKey(apiKey);
}

function testProviderPromptCachePolicy(): void {
  const common = {
    provider: 'openai' as const,
    model: 'gpt-test',
    staticPrompt: 'stable system prefix',
    tools: [{ name: 'workspace_read_file', parameters: { type: 'object' } }],
  };
  const identity = buildPromptCacheIdentity(common);
  assert.notEqual(
    identity,
    buildPromptCacheIdentity({ ...common, model: 'gpt-other' }),
    'different models must not share prompt-cache routing identity',
  );
  assert.notEqual(
    identity,
    buildPromptCacheIdentity({ ...common, tools: [{ name: 'different_tool' }] }),
    'tool-surface changes must invalidate prompt-cache identity',
  );
  assert.equal(
    buildPromptCacheIdentity({
      ...common,
      tools: [{ name: 'tool', parameters: { b: 2, a: 1 } }],
    }),
    buildPromptCacheIdentity({
      ...common,
      tools: [{ parameters: { a: 1, b: 2 }, name: 'tool' }],
    }),
    'object key ordering must not create avoidable prompt-cache misses',
  );

  const params: Record<string, any> = {};
  assert.equal(
    applyOpenAIPromptCachePolicy(params, {
      model: common.model,
      staticPrompt: common.staticPrompt,
      tools: common.tools,
    }),
    identity,
  );
  assert.equal(params.stream_options.include_usage, true);
  assert.equal(params.prompt_cache_retention, 'in_memory');
  removeOpenAIPromptCachePolicy(params);
  assert.equal(params.prompt_cache_key, undefined);

  const explicitParams: Record<string, any> = { messages: [] };
  applyOpenAIPromptCachePolicy(explicitParams, {
    model: 'gpt-5.6',
    staticPrompt: common.staticPrompt,
    tools: common.tools,
  });
  assert.deepEqual(explicitParams.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
  assert.equal(explicitParams.prompt_cache_retention, undefined);
  assert.deepEqual(
    buildOpenAISystemPromptContent('gpt-5.6', 'stable', 'dynamic', true),
    [
      { type: 'text', text: 'stable', prompt_cache_breakpoint: { mode: 'explicit' } },
      { type: 'text', text: 'dynamic' },
    ],
  );
  assert.equal(
    buildProviderConversationCacheId('grok', 'chat-a'),
    buildProviderConversationCacheId('grok', 'chat-a'),
  );
  assert.notEqual(
    buildProviderConversationCacheId('grok', 'chat-a'),
    buildProviderConversationCacheId('grok', 'chat-b'),
  );

  assert.equal(resolveProviderPromptCacheMode('gemini', true, true), 'explicit-remote');
  assert.equal(resolveProviderPromptCacheMode('anthropic', true), 'explicit-ephemeral');
  assert.equal(resolveProviderPromptCacheMode('mistral', true), 'implicit-prefix');
  assert.deepEqual(
    normalizeProviderCacheUsage('openai', {
      prompt_tokens: 1200,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 1024 },
    }),
    {
      promptTokens: 1200,
      inputTokens: 1200,
      completionTokens: 40,
      outputTokens: 40,
      totalTokens: 1240,
      cachedTokens: 1024,
      uncachedPromptTokens: 176,
      cacheHitRatio: 1024 / 1200,
    },
  );
}

async function main(): Promise<void> {
  await testScopedToolCache();
  await testRemoteContextCache();
  testProviderPromptCachePolicy();
  console.log('Agent cache integration checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
