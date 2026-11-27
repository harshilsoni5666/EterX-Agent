import { Activity, ArrowDownLeft, ArrowUpRight, ChevronRight, Database, Info, Layers3, PiggyBank } from 'lucide-react';
import { ProviderIconAsset } from '../ui/provider-icon';
import type { UsageFilter, UsageScope, UsageTotals } from '../../lib/usage/summary';
import { compactCount, exactCount, metricMeasured, percent, usageMetricValue, usageScopeKey, usd, type UsageMetric } from './usage-format';
import type { UsageSeries } from './usage-series';
import styles from './usage-dashboard.module.css';

export type ExplainUsage = (trigger: HTMLButtonElement) => void;

export function ValueTitle({ label, onExplain }: { label: string; onExplain?: ExplainUsage }) {
  if (!onExplain) return <div className={styles.valueTitle}>{label}</div>;
  return <button type="button" className={styles.valueTitle} aria-haspopup="dialog"
    aria-label={'How ' + label.toLowerCase() + ' is calculated'} onClick={event => onExplain(event.currentTarget)}>
    {label}<Info size={14} aria-hidden="true" />
  </button>;
}

export function UsageValuePanel({ totals, series, filter, metric, byModel, onScope, onExplain }: {
  totals: UsageTotals;
  series: UsageSeries[];
  filter: UsageFilter;
  metric: UsageMetric;
  byModel: boolean;
  onScope: (scope: UsageScope, rowKey: string) => void;
  onExplain: ExplainUsage;
}) {
  const isCost = metric === 'cost';
  const heading = isCost ? 'Usage value' : 'Processed tokens';
  const measured = metricMeasured(totals, metric);
  const amount = usageMetricValue(totals, metric);
  const coverage = totals.calls
    ? exactCount(measured) + ' of ' + exactCount(totals.calls) + (isCost ? ' responses priced' : ' responses measured')
    : 'No responses in this period';
  const basis = filter === 'sub' ? 'Equivalent at public API rates'
    : totals.estimated && totals.reported ? 'Reported costs and public rate estimates'
    : totals.reported ? 'Provider-reported costs' : 'Estimated at public API rates';

  return <section className={styles.valuePanel} aria-label={heading}>
    <div className={styles.valueHeading}>
      <ValueTitle label={heading} onExplain={isCost && totals.calls ? onExplain : undefined} />
      {isCost && <span className={styles.currency}>USD</span>}
    </div>
    <div className={styles.amount} title={!isCost && totals.measured ? exactCount(totals.tokens) + ' tokens' : undefined}>{amount}</div>
    <p className={styles.note}>{coverage}</p>
    {isCost && measured > 0 && <p className={styles.valueBasis}>{basis}</p>}

    {!!series.length && <ul className={styles.seriesList} aria-label={byModel ? 'Models by ' + metric : 'Providers by ' + metric}>
      {series.map(({ id, name, color, scope, totals: row }) => {
        const rowKey = scope && 'overview:' + usageScopeKey(scope);
        const share = metricMeasured(row, metric) > 0 && totals[metric] > 0
          ? percent(row[metric], totals[metric]) + ' of ' + metric + ' · ' : '';
        const responses = exactCount(row.calls) + (row.calls === 1 ? ' response' : ' responses');
        const content = <>
          <span className={styles.seriesIdentity}>
            <i className={styles.rowDot} aria-hidden="true" style={{ background: color }} />
            {scope && <ProviderIconAsset provider={scope.provider} />}
            <strong>{name}</strong>
          </span>
          <span className={styles.seriesAmount}>{usageMetricValue(row, metric)}</span>
          <span className={styles.seriesMeta}>
            {share}{responses}{isCost && row.measured > 0 ? ' · ' + compactCount(row.tokens) + ' tokens' : ''}
          </span>
        </>;
        return <li key={id}>{scope && rowKey
          ? <button type="button" className={styles.seriesRow} data-usage-row={rowKey} title={scope.model}
            onClick={() => onScope(scope, rowKey)}>
            {content}<ChevronRight size={14} aria-hidden="true" className={styles.seriesChevron} />
          </button>
          : <div className={styles.seriesRow}>{content}</div>}
        </li>;
      })}
    </ul>}
  </section>;
}

export function TokenCoverage({ totals, scopeLabel }: { totals: UsageTotals; scopeLabel?: string }) {
  const { calls, measured, inputReports, outputReports, cacheReports } = totals;
  return <aside className={styles.coverage} aria-label="Token coverage">
    <div className={styles.sectionHead}><h2>Token coverage</h2><Database size={16} aria-hidden="true" /></div>
    {scopeLabel && <p className={styles.coverageScope}>{scopeLabel}</p>}
    <strong className={styles.coverageValue}>{percent(measured, calls)}</strong>
    <p className={styles.note}>{exactCount(measured)} of {exactCount(calls)} responses reported token counts</p>
    <div className={styles.coverageBar} aria-hidden="true">
      <span style={{ width: (calls ? measured / calls * 100 : 0) + '%' }} />
    </div>
    <dl className={styles.definitionList}>
      <div><dt>Input counts reported</dt><dd>{exactCount(inputReports)}</dd></div>
      <div><dt>Output counts reported</dt><dd>{exactCount(outputReports)}</dd></div>
      <div><dt>Cache detail reported</dt><dd>{exactCount(cacheReports)}</dd></div>
    </dl>
  </aside>;
}

export function UsageTotalsBand({ totals, period }: { totals: UsageTotals; period: number | '24h' }) {
  const { calls, cacheReports, outputReports, measured, observedCacheInput, cached, input, written, output, reasoning, tokens, saving } = totals;
  const missingCacheInput = Math.max(0, input - observedCacheInput);
  const items = [
    { Icon: Layers3, label: 'Processed tokens', count: measured || !calls ? tokens : null, hint: period === '24h' ? 'Past 24 hours' : compactCount(tokens / period) + ' daily average' },
    { Icon: Database, label: 'Cached input', count: cacheReports || !calls ? cached : null,
      hint: observedCacheInput ? percent(cached, observedCacheInput) + ' of input with cache detail' : 'Provider-reported cache reads' },
    { Icon: ArrowDownLeft, label: 'Uncached input', count: cacheReports || !calls ? Math.max(0, observedCacheInput - cached) : null,
      hint: missingCacheInput ? compactCount(missingCacheInput) + ' input without cache detail' : compactCount(written) + ' cache writes included' },
    { Icon: ArrowUpRight, label: 'Output', count: outputReports || !calls ? output : null,
      hint: reasoning ? compactCount(reasoning) + ' reasoning tokens included' : 'Generated tokens' },
    { Icon: Activity, label: 'Responses', count: calls, hint: exactCount(measured) + ' with token counts' },
  ];
  return <section className={styles.stats} aria-label="Usage totals">
    {items.map(({ Icon, label, count, hint }) => <div key={label}>
      <span className={styles.statLabel}><Icon size={14} strokeWidth={1.65} aria-hidden="true" />{label}</span>
      <strong title={count === null ? 'No measurement' : exactCount(count)}>
        {count === null ? '—' : label === 'Responses' ? exactCount(count) : compactCount(count)}
      </strong>
      <small>{hint}</small>
    </div>)}
    <div>
      <span className={styles.statLabel}><PiggyBank size={14} strokeWidth={1.65} aria-hidden="true" />Cache savings</span>
      <strong>{saving > 0 ? usd(saving) : '—'}</strong>
      <small>Estimated at public rates</small>
    </div>
  </section>;
}
