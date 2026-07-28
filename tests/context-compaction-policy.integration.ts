import assert from 'node:assert/strict';
import {
  deriveContextCompactionPolicy,
  type ContextCompactionUsage,
} from '../src/lib/agent/resilience/context-compaction';

const usage = (
  contextWindow: number,
  systemTokens: number,
  toolTokens: number,
  conversationTokens: number,
): ContextCompactionUsage => {
  const usedTokens = systemTokens + toolTokens + conversationTokens;
  return {
    usedTokens,
    contextWindow,
    utilizationPct: (usedTokens / contextWindow) * 100,
    systemTokens,
    toolTokens,
    conversationTokens,
  };
};

const standard64k = deriveContextCompactionPolicy({
  usage: usage(64_000, 8_000, 4_000, 30_000),
  averageGrowthTokens: 500,
});
assert.equal(standard64k.softTokens, 53_760, '64k normal chats should fill to 84% before compaction');
assert.equal(standard64k.hardTokens, 58_880, '64k hard boundary should remain at 92%');
assert.ok(standard64k.softTokens < standard64k.hardTokens, 'soft boundary must precede hard boundary');

const fixedHeavy = deriveContextCompactionPolicy({
  usage: usage(128_000, 58_000, 12_000, 30_000),
  averageGrowthTokens: 400,
});
assert.equal(fixedHeavy.profile, 'fixed_heavy');
assert.equal(fixedHeavy.softRatio, 0.88, 'fixed-heavy contexts should avoid premature ineffective compaction');

const historyHeavy = deriveContextCompactionPolicy({
  usage: usage(258_000, 15_000, 8_000, 178_000),
  averageGrowthTokens: 1_000,
});
assert.equal(historyHeavy.profile, 'history_heavy');
assert.equal(historyHeavy.softRatio, 0.86, 'slow large histories should use more of their selected budget');

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
assert.equal(weakReduction.softRatio, 0.88, 'weak prior reductions should receive extra hysteresis');

for (const contextWindow of [64_000, 128_000, 258_000, 512_000, 1_000_000]) {
  const policy = deriveContextCompactionPolicy({
    usage: usage(contextWindow, contextWindow * 0.1, contextWindow * 0.05, contextWindow * 0.55),
    averageGrowthTokens: 0,
  });
  assert.ok(policy.softTokens < policy.hardTokens, `threshold ordering must hold for ${contextWindow}`);
  assert.ok(policy.hardTokens <= contextWindow, `hard boundary must fit ${contextWindow}`);
}

console.log('Context compaction policy integration checks passed.');
