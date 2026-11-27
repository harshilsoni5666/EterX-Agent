import { combineUsageTotals, type ModelUsage, type ProviderUsage, type UsageScope, type UsageTotals } from '../../lib/usage/summary';
import { metricMeasured, modelLabel, providerLabel, type UsageMetric } from './usage-format';

export interface UsageSeries {
  id: string;
  name: string;
  color: string;
  scope: UsageScope | null;
  totals: UsageTotals;
}

const seriesColors = [
  'var(--usage-series-0)', 'var(--usage-series-1)', 'var(--usage-series-2)', 'var(--usage-series-3)', 'var(--usage-series-4)',
];

export function buildUsageSeries(rows: readonly (ModelUsage | ProviderUsage)[], metric: UsageMetric): UsageSeries[] {
  const ordered = [...rows].sort((a, b) =>
    Number(Boolean(metricMeasured(b, metric))) - Number(Boolean(metricMeasured(a, metric)))
    || b[metric] - a[metric] || b.calls - a.calls || a.provider.localeCompare(b.provider));
  const leading = ordered.slice(0, seriesColors.length);
  const colorOrder = leading.filter(row => 'model' in row || row.source !== 'sub').sort((a, b) =>
    a.provider.localeCompare(b.provider) || ('model' in a && 'model' in b ? a.model.localeCompare(b.model) : 0));
  const visible = leading.map((row, index): UsageSeries => {
    const model = 'model' in row ? row.model : undefined;
    return {
      id: 'series' + index,
      name: model ? modelLabel(model) : providerLabel(row.provider),
      color: !model && row.source === 'sub' ? 'var(--usage-sub)' : seriesColors[colorOrder.indexOf(row)],
      scope: { provider: row.provider, model },
      totals: row,
    };
  });
  const other = ordered.slice(seriesColors.length);
  if (other.length) visible.push({
    id: 'other', name: 'Other ' + ('model' in other[0] ? 'models' : 'providers'),
    color: 'var(--usage-neutral)', scope: null, totals: combineUsageTotals(other),
  });
  return visible;
}
