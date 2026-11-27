import { formatModelName } from '../../lib/agent/model-presentation';
import type { ChargeKind, RateUnit, UsageSource } from '../../lib/usage/accounting';
import { SUBSCRIPTION_PROVIDER_NAMES } from '../../lib/native-provider-contract';
import { dateOfDay, type UsageBucket, type UsageScope, type UsageTotals } from '../../lib/usage/summary';

export type UsageMetric = 'cost' | 'tokens';
export type UsageView = UsageMetric | 'limits';
export const usageViews = [['cost', 'Cost'], ['tokens', 'Tokens'], ['limits', 'Limits']] as const;
export const exactCount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format;
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const smallCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 3 });
const rateCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 10 });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const shortHour = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullHour = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
export const dateRange = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const timeRange = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const isUsageHour = (date: string) => date.includes('T');
export function formatUsageBucket(bucket: string, compact = false) {
  if (isUsageHour(bucket)) return (compact ? shortHour : fullHour).format(new Date(bucket));
  return (compact ? shortDate : fullDate).format(dateOfDay(bucket));
}

export const usd = (amount: number) => amount > 0 && amount < 0.01 ? smallCurrency.format(amount) : currency.format(amount);
export const usdRate = (amount: number) => amount > 0 && amount < 1e-9 ? smallCurrency.format(amount) : rateCurrency.format(amount);
export const compactCount = (amount: number) => amount < 1000 ? exactCount(amount) : compact.format(amount);
export function percent(part: number, whole: number) {
  if (!whole) return '—';
  const share = 100 * part / whole;
  return share > 0 && share < .1 ? '<0.1%' : share.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%';
}
export const pricedCount = (row: UsageTotals) => row.reported + row.estimated;
export const usageValue = (row: UsageTotals) => row.calls && !pricedCount(row) ? '—' : usd(row.cost);
export const metricMeasured = (row: UsageTotals, metric: UsageMetric) => metric === 'cost' ? pricedCount(row) : row.measured;
export const usageMetricValue = (row: UsageTotals, metric: UsageMetric) => metric === 'cost' ? usageValue(row)
  : row.calls && !row.measured ? '—' : compactCount(row.tokens);
export const usageScopeKey = (scope: UsageScope) => JSON.stringify([scope.provider, scope.model]);

export const sourceNames: Record<UsageSource, string> = { api: 'API', sub: 'Subscription', unknown: 'Unknown connection' };
export const sourceColors: Record<UsageSource, string> = { api: 'var(--usage-api)', sub: 'var(--usage-sub)', unknown: 'var(--usage-neutral)' };
const providerNames: Record<string, string> = {
  gemini: 'Google Gemini', openai: 'OpenAI', anthropic: 'Anthropic',
  ...SUBSCRIPTION_PROVIDER_NAMES,
  grok: 'xAI', openrouter: 'OpenRouter', deepseek: 'DeepSeek', deepinfra: 'DeepInfra', lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp', vllm: 'vLLM', bedrock: 'Amazon Bedrock', opencode: 'OpenCode',
  ollamacloud: 'Ollama Cloud', elevenlabs: 'ElevenLabs', deepgram: 'Deepgram', minimax: 'MiniMax',
  unknown: 'Unknown provider',
};
export const providerLabel = (id: string) => Object.hasOwn(providerNames, id)
  ? providerNames[id] : id.charAt(0).toUpperCase() + id.slice(1);
export const modelLabel = (id: string) => formatModelName(id.replace(/(claude-(?:sonnet|opus|haiku)-\d)-(\d)(?=$|[-:])/i, '$1.$2'));

export const chargeLabels: Record<ChargeKind, string> = {
  input: 'Uncached text input', cacheRead: 'Cached text input', cacheWrite: 'Cache writes',
  longCacheWrite: 'Extended cache writes', output: 'Text output', reasoning: 'Reasoning tokens',
  audioInput: 'Audio input', audioCacheRead: 'Cached audio input', audioOutput: 'Audio output',
  imageInput: 'Image input', imageCacheRead: 'Cached image input', imageOutput: 'Image output',
  transcription: 'Transcription', imageGeneration: 'Image generation', videoGeneration: 'Video generation',
};
export const chargeUnitLabel = (unit: RateUnit) => ({ millionTokens: '/ 1M tokens', image: '/ image', second: '/ sec' })[unit];
export const chargeQuantity = (amount: number, unit: RateUnit) => unit === 'millionTokens' ? decimal.format(amount)
  : decimal.format(amount) + (unit === 'second' ? ' sec' : amount === 1 ? ' image' : ' images');

export const catalogLinks = [
  ['Models.dev', 'https://models.dev/'],
  ['OpenRouter', 'https://openrouter.ai/models'],
  ['LiteLLM', 'https://models.litellm.ai/'],
] as const;

function csvCell(value: string | number | undefined) {
  if (typeof value === 'number') return String(value);
  if (!value) return '';
  const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function downloadUsageCsv(buckets: UsageBucket[], timeZone: string, from: string, to: string) {
  const columns = [
    isUsageHour(from) ? 'Hour bucket start (UTC)' : 'Date', 'Time zone', 'Connection', 'Provider', 'Model', 'Responses', 'Responses with token counts',
    'Processed tokens', 'Input tokens', 'Cached input tokens', 'Output tokens', 'Cache writes', 'Reasoning tokens',
    'Reported responses', 'Estimated responses', 'Unpriced responses', 'Provider-reported USD', 'Estimated USD', 'Usage value USD',
  ];
  const rows = [...buckets].sort((a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const csv = [columns.map(csvCell).join(','), ...rows.map(row => [
    row.day, timeZone, sourceNames[row.source], row.provider, row.model, row.calls, row.measured,
    row.measured ? row.tokens : undefined, row.inputReports ? row.input : undefined, row.cacheReports ? row.cached : undefined,
    row.outputReports ? row.output : undefined, row.written || undefined,
    row.reasoning || undefined, row.reported, row.estimated, row.unpriced,
    row.reported ? row.reportedCost : undefined, row.estimated ? row.estimatedCost : undefined,
    pricedCount(row) ? row.cost : undefined,
  ].map(csvCell).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'eterx-usage-' + (from + (to === from ? '' : '-to-' + to)).replaceAll(':', '-') + '.csv';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
