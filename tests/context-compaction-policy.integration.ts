import assert from 'node:assert/strict';
import {
  deriveContextCompactionPolicy,
  normalizeContextCompactionSettings,
  resolveModelContextWindow,
  shouldDeferContextCompaction,
  type ContextCompactionUsage,
} from '../src/lib/agent/resilience/context-compaction';

assert.equal(shouldDeferContextCompaction({
  isHardBlocked: false,
  forecastRequiresCompaction: false,
  semanticBoundary: 'unsafe',
}), true, 'mid-derivation soft compaction must be deferred');
assert.equal(shouldDeferContextCompaction({
  isHardBlocked: false,
  forecastRequiresCompaction: false,
  semanticBoundary: 'neutral',
}), true, 'ordinary soft compaction waits for a resolved semantic boundary');
assert.equal(shouldDeferContextCompaction({
  isHardBlocked: false,
  forecastRequiresCompaction: true,
  semanticBoundary: 'neutral',
}), false, 'forecast overflow may compact at a neutral boundary');
assert.equal(shouldDeferContextCompaction({
  isHardBlocked: true,
  forecastRequiresCompaction: false,
  semanticBoundary: 'unsafe',
}), false, 'hard context recovery remains available');

const usage = (
  contextWindow: number,
  systemTokens: number,
  toolTokens: number,
  conversationTokens: number,
): ContextCompactionUsage => {
  const usedTokens = systemTokens + toolTokens + conversationTokens;
  return {
    breakdownVersion: 3,
    usedTokens,
    contextWindow,
    utilizationPct: (usedTokens / contextWindow) * 100,
    systemTokens,
    toolTokens,
    conversationTokens,
  };
};

const activeModel = { provider: 'openai' as const, modelId: 'gpt-active' };
assert.deepEqual(
  normalizeContextCompactionSettings({ enabled: true }, activeModel).model,
  activeModel,
  'untouched/Auto compaction settings must follow the exact active chat model',
);
assert.equal(
  normalizeContextCompactionSettings({ enabled: true }, activeModel).modelSource,
  'active',
);
assert.deepEqual(
  normalizeContextCompactionSettings({
    enabled: true,
    model: { provider: 'anthropic', modelId: 'claude-explicit' },
  }, activeModel).model,
  { provider: 'anthropic', modelId: 'claude-explicit' },
  'an explicit compaction model must remain explicit until its bounded failover is needed',
);

assert.equal(resolveModelContextWindow('openai', 'gpt-5.6-sol'), 1_050_000);
assert.equal(resolveModelContextWindow('openai', 'gpt-5.4-mini'), 400_000);
assert.equal(resolveModelContextWindow('openai', 'gpt-4.1'), 1_047_576);
assert.equal(resolveModelContextWindow('openai', 'o4-mini'), 200_000);
assert.equal(resolveModelContextWindow('mistral', 'codestral-latest'), 128_000);
assert.equal(resolveModelContextWindow('mistral', 'devstral-2'), 256_000);

const standard64k = deriveContextCompactionPolicy({
  usage: usage(64_000, 8_000, 4_000, 30_000),
  averageGrowthTokens: 500,
});
assert.equal(standard64k.softTokens, 32_000, '64k normal chats should compact at the halfway boundary');
assert.equal(standard64k.hardTokens, 46_080, '64k hard recovery should preserve room for another provider cycle');
assert.ok(standard64k.softTokens < standard64k.hardTokens, 'soft boundary must precede hard boundary');

const fixedHeavy = deriveContextCompactionPolicy({
  usage: usage(128_000, 58_000, 12_000, 30_000),
  averageGrowthTokens: 400,
});
assert.equal(fixedHeavy.profile, 'fixed_heavy');
assert.equal(fixedHeavy.softRatio, 0.50, 'fixed-heavy contexts must not silently move beyond the halfway boundary');

const historyHeavy = deriveContextCompactionPolicy({
  usage: usage(258_000, 15_000, 8_000, 178_000),
  averageGrowthTokens: 1_000,
});
assert.equal(historyHeavy.profile, 'standard');
assert.equal(historyHeavy.softRatio, 0.50, 'large histories should not silently move beyond the halfway boundary');

const fastGrowth = deriveContextCompactionPolicy({
  usage: usage(258_000, 20_000, 8_000, 170_000),
  averageGrowthTokens: 24_000,
});
assert.equal(fastGrowth.profile, 'fast_growth');
assert.equal(fastGrowth.forecastEnabled, true);
assert.ok(
  fastGrowth.forecastTriggerTokens < fastGrowth.softTokens,
  'fast-growing runs should forecast overflow before the ordinary soft boundary',
);

const weakReduction = deriveContextCompactionPolicy({
  usage: usage(258_000, 20_000, 10_000, 180_000),
  averageGrowthTokens: 1_000,
  previousReductionRatio: 0.05,
});
assert.equal(weakReduction.profile, 'weak_reduction');
assert.equal(weakReduction.softRatio, 0.50, 'weak prior reductions keep hysteresis in next-attempt state, not the base boundary');

for (const contextWindow of [64_000, 128_000, 258_000, 512_000, 1_000_000]) {
  const policy = deriveContextCompactionPolicy({
    usage: usage(contextWindow, contextWindow * 0.1, contextWindow * 0.05, contextWindow * 0.55),
    averageGrowthTokens: 0,
  });
  assert.ok(policy.softTokens < policy.hardTokens, `threshold ordering must hold for ${contextWindow}`);
  assert.ok(policy.hardTokens <= contextWindow, `hard boundary must fit ${contextWindow}`);
}

console.log('Context compaction policy integration checks passed.');
