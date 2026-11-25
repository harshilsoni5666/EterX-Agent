import type { UsageRateLine, UsageSource } from './accounting';

export type UsageFilter = 'all' | UsageSource;
export interface UsageTotals {
  calls: number;
  measured: number;
  inputReports: number;
  outputReports: number;
  cacheReports: number;
  tokens: number;
  input: number;
  output: number;
  cached: number;
  written: number;
  reasoning: number;
  observedCacheInput: number;
  reported: number;
  estimated: number;
  unpriced: number;
  missingUsage: number;
  missingRate: number;
  incompletePricing: number;
  reportedCost: number;
  estimatedCost: number;
  cost: number;
  saving: number;
}
export interface UsageScope {
  provider: string;
  model?: string;
}
export interface ModelUsage extends UsageTotals {
  provider: string;
  model: string;
  source: UsageSource;
}
export interface ProviderUsage extends UsageTotals {
  provider: string;
  source: UsageSource;
}
export interface UsageBucket extends ModelUsage {
  day: string;
  rates: UsageRateLine[];
}
export interface UsageDay extends UsageTotals {
  day: string;
  api: UsageTotals;
  sub: UsageTotals;
  unknown: UsageTotals;
}
export interface UsageReport {
  buckets: UsageBucket[];
  asOf: string;
  updatedAt: number;
  timeZone: string;
  savedUsageAvailable: boolean;
}
export function emptyTotals(): UsageTotals {
  return { calls: 0, measured: 0, inputReports: 0, outputReports: 0, cacheReports: 0, tokens: 0, input: 0, output: 0, cached: 0, written: 0, reasoning: 0,
    observedCacheInput: 0, reported: 0, estimated: 0, unpriced: 0, missingUsage: 0, missingRate: 0, incompletePricing: 0,
    reportedCost: 0, estimatedCost: 0, cost: 0, saving: 0 };
}
const totalKeys = Object.keys(emptyTotals()) as Array<keyof UsageTotals>;
function addTotals(target: UsageTotals, value: UsageTotals) {
  for (const key of totalKeys) target[key] += value[key];
}
export const dayKey = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0')].join('-');
export const dateOfDay = (day: string) => new Date(day + 'T12:00:00');
export function daysEndingAt(lastDay: string, length: number) {
  const date = dateOfDay(lastDay);
  date.setDate(date.getDate() - length + 1);
  return Array.from({ length }, () => {
    const day = dayKey(date);
    date.setDate(date.getDate() + 1);
    return day;
  });
}

export function selectUsageBuckets(buckets: UsageBucket[], filter: UsageFilter, scope: UsageScope | null) {
  return buckets.filter(row =>
    (filter === 'all' || row.source === filter)
    && (!scope || (row.provider === scope.provider && (!scope.model || row.model === scope.model))));
}

export function summarizeRange(buckets: UsageBucket[], days: string[]) {
  const totals = emptyTotals();
  const dayRows = new Map<string, UsageDay>(days.map(day =>
    [day, { ...emptyTotals(), day, api: emptyTotals(), sub: emptyTotals(), unknown: emptyTotals() }] as const));
  const models = new Map<string, ModelUsage>();
  const providers = new Map<string, ProviderUsage>();
  const sources = { api: emptyTotals(), sub: emptyTotals(), unknown: emptyTotals() };
  for (const row of buckets) {
    const daily = dayRows.get(row.day);
    if (!daily) continue;
    addTotals(totals, row);
    addTotals(daily, row);
    addTotals(daily[row.source], row);
    addTotals(sources[row.source], row);
    const { provider, model, source } = row;
    const key = JSON.stringify([provider, model]);
    const modelTotals = models.get(key) ?? { ...emptyTotals(), provider, model, source };
    addTotals(modelTotals, row);
    models.set(key, modelTotals);
    const providerTotals = providers.get(provider) ?? { ...emptyTotals(), provider, source };
    addTotals(providerTotals, row);
    providers.set(provider, providerTotals);
  }
  return { totals, days: Array.from(dayRows.values()), models: Array.from(models.values()), providers: Array.from(providers.values()), sources };
}

export function addRateLines(target: Map<string, UsageRateLine>, lines: UsageRateLine[]) {
  for (const line of lines) {
    const key = JSON.stringify([line.kind, line.unit, line.rate]);
    const existing = target.get(key);
    if (existing) {
      existing.quantity += line.quantity;
      existing.cost += line.cost;
    } else target.set(key, { ...line });
  }
}

export function summarizeRates(buckets: UsageBucket[]) {
  const rates = new Map<string, UsageRateLine>();
  for (const bucket of buckets) addRateLines(rates, bucket.rates);
  return Array.from(rates.values());
}
