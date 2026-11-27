import type { ChargeKind, UsageRateLine, UsageSource } from '../../lib/usage/accounting';
import type { UsageTotals } from '../../lib/usage/summary';
import { compactCount, exactCount, percent, pricedCount, usd, type UsageMetric } from './usage-format';
import styles from './usage-dashboard.module.css';

const typeLabels = { input: 'Uncached input', cacheRead: 'Cache reads', cacheWrite: 'Cache writes',
  output: 'Output', media: 'Media', reported: 'Reported total' };
type CostType = keyof typeof typeLabels;

const costTypes: Record<ChargeKind, CostType> = {
  input: 'input', audioInput: 'input', imageInput: 'input',
  cacheRead: 'cacheRead', audioCacheRead: 'cacheRead', imageCacheRead: 'cacheRead',
  cacheWrite: 'cacheWrite', longCacheWrite: 'cacheWrite',
  output: 'output', audioOutput: 'output', imageOutput: 'output', reasoning: 'output',
  transcription: 'media', imageGeneration: 'media', videoGeneration: 'media',
};
const palette = ['var(--usage-series-0)', 'var(--usage-series-1)', 'var(--usage-sub)', 'var(--usage-series-3)', 'var(--usage-series-4)', 'var(--usage-neutral)'];
interface MixEntry { label: string; value: number; color: string }

function Distribution({ title, entries, format, detail, empty }: {
  title: string;
  entries: MixEntry[];
  format: (value: number) => string;
  detail: string;
  empty: string;
}) {
  const present = entries.filter(entry => entry.value > 0);
  const whole = present.reduce((total, entry) => total + entry.value, 0);
  return <section className={styles.mixPanel} aria-label={title}>
    <div className={styles.sectionHead}><h2>{title}</h2></div>
    {present.length > 0 ? <>
      <div className={styles.mixTrack} aria-hidden="true">
        {present.map(entry => <span key={entry.label} style={{ flexGrow: entry.value / whole, background: entry.color }} />)}
      </div>
      <dl className={styles.mixLegend}>
        {present.map(entry => <div key={entry.label}>
          <dt><i className={styles.rowDot} style={{ background: entry.color }} />{entry.label}</dt>
          <dd title={percent(entry.value, whole) + ' of shown total'}>{format(entry.value)}</dd>
        </div>)}
      </dl>
    </> : <p className={styles.mixEmpty}>{empty}</p>}
    {detail && <p className={styles.footnote}>{detail}</p>}
  </section>;
}

export function UsageMix({ metric, totals, sources, rates }: {
  metric: UsageMetric;
  totals: UsageTotals;
  sources: Record<UsageSource, UsageTotals>;
  rates: UsageRateLine[];
}) {
  if (metric === 'tokens') {
    const knownCache = totals.observedCacheInput;
    const unclassified = Math.max(0, totals.input - knownCache);
    return <div className={styles.mix}>
      <Distribution
        title="Token mix"
        format={compactCount}
        entries={[
          { label: 'Cached input', value: totals.cached, color: palette[1] },
          { label: 'Uncached input', value: Math.max(0, knownCache - totals.cached), color: palette[0] },
          { label: 'Input without cache detail', value: unclassified, color: palette[5] },
          { label: 'Output', value: totals.output, color: palette[3] },
          { label: 'Other reported tokens', value: Math.max(0, totals.tokens - totals.input - totals.output), color: palette[4] },
        ]}
        empty="No measured tokens in this selection."
        detail={totals.reasoning > 0 ? compactCount(totals.reasoning) + ' reasoning tokens are included in output.' : ''}
      />
      <Distribution
        title="Cache activity"
        format={compactCount}
        entries={[
          { label: 'Cache reads', value: totals.cached, color: palette[1] },
          { label: 'Cache writes', value: totals.written, color: palette[2] },
        ]}
        empty={totals.cacheReports ? 'No cache reads or writes recorded.' : 'No cache detail reported.'}
        detail={totals.cacheReports > 0 ? exactCount(totals.cacheReports) + ' responses included cache-read detail.' : ''}
      />
    </div>;
  }

  const amounts: Record<CostType, number> = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, media: 0, reported: totals.reportedCost };
  for (const line of rates) amounts[costTypes[line.kind]] += line.cost;
  const entries = (Object.keys(typeLabels) as CostType[]).map((type, index) =>
    ({ label: typeLabels[type], value: amounts[type], color: palette[index] }));
  const costEmpty = pricedCount(totals) ? 'Recorded usage value is $0.00.' : 'No priced activity in this selection.';

  return <div className={styles.mix}>
    <Distribution
      title="Cost by type"
      format={usd}
      entries={entries}
      empty={costEmpty}
      detail={totals.reportedCost > 0 ? 'Reported charges are shown as provided when their components are unavailable.' : ''}
    />
    <Distribution
      title="Pricing basis"
      format={usd}
      entries={[
        { label: 'Provider reported', value: totals.reportedCost, color: palette[0] },
        { label: 'Public rate estimate', value: sources.api.estimatedCost + sources.unknown.estimatedCost, color: palette[1] },
        { label: 'Subscription equivalent', value: sources.sub.estimatedCost, color: palette[2] },
      ]}
      empty={costEmpty}
      detail={totals.unpriced > 0 ? exactCount(totals.unpriced) + ' unpriced ' + (totals.unpriced === 1 ? 'response' : 'responses') + '.'
        : sources.sub.estimated > 0 ? 'Plan activity is valued at public API rates.' : ''}
    />
  </div>;
}
