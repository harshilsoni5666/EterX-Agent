'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowLeft, ArrowUpRight, CalendarDays, ChevronRight, Database, Download, Info, Layers3, RefreshCw } from 'lucide-react';
import { ProviderIconAsset } from '../ui/provider-icon';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import { dayKey, dateOfDay, daysEndingAt, selectUsageBuckets, summarizeRange, summarizeRates, type UsageFilter, type UsageReport, type UsageScope, type UsageTotals } from '../../lib/usage/summary';
import { RecentUsageDays, SelectedDay, UsageBreakdown, type BreakdownPreferences } from './usage-breakdown';
import { UsageChart } from './usage-chart';
import { Segments } from './usage-controls';
import { UsageLoadingContent } from './usage-loading';
import { CostCoverage, CostTable, ModelPriceDetails, UsageCostDialog } from './usage-pricing';
import { compactCount, dateRange, downloadUsageCsv, exactCount, fullDate, modelLabel, percent, pricedCount, providerLabel, sourceColors, sourceNames, usageSources, usageValue, type UsageMetric } from './usage-format';
import styles from './usage-dashboard.module.css';

const filters = [['all', 'All'], ['api', 'API'], ['sub', 'Sub']] as const;
const ranges = [[7, '7 days'], [30, '30 days'], [90, '90 days']] as const;
const updateTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
type UsageRange = typeof ranges[number][0];
type VisibleFilter = typeof filters[number][0];
type UsageSummary = ReturnType<typeof summarizeRange>;
type Location = { scope: UsageScope | null; top: number; rowKey?: string };
type Explain = (trigger: HTMLButtonElement) => void;

function useUsageReport() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [lastDay, setLastDay] = useState(() => dayKey(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (inFlight.current || !isAppVisible()) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 89).getTime();
    const params = new URLSearchParams({ start: String(start), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    try {
      const response = await fetch('/api/usage?' + params, {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) throw new Error('Usage unavailable');
      const next: UsageReport = await response.json();
      if (!Array.isArray(next.buckets)) throw new Error('Invalid usage report');
      if (!controller.signal.aborted) {
        setReport(next);
        setLastDay(dayKey(today));
        setError(false);
      }
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    const unsubscribe = subscribeAppVisibility(() => { if (isAppVisible()) void refresh(); });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [refresh]);

  return { report, lastDay, busy, error, refresh };
}

function ValueTitle({ label, enabled, onExplain }: { label: string; enabled: boolean; onExplain: Explain }) {
  if (!enabled) return <div className={styles.valueTitle}>{label}</div>;
  return <button type="button" className={styles.valueTitle} aria-haspopup="dialog"
    aria-label={'How ' + label.toLowerCase() + ' is calculated'} onClick={event => onExplain(event.currentTarget)}>
    {label}<Info size={15} aria-hidden="true" />
  </button>;
}

function UsageValuePanel({ data, filter, onExplain }: { data: UsageSummary; filter: UsageFilter; onExplain: Explain }) {
  const { totals, sources } = data;
  const label = filter === 'sub' ? 'Subscription value' : filter === 'api' ? 'API value' : 'Usage value';
  const singleSource = filter !== 'all';
  const basis = filter === 'sub' ? 'Equivalent value at public API rates'
    : totals.reported && totals.estimated ? 'Provider costs and public rate estimates'
    : totals.reported ? 'Costs reported by providers' : 'Estimated at public API rates';

  return <section className={styles.valuePanel} aria-label={label} data-source={filter}>
    <div className={styles.valueHeading}>
      <ValueTitle label={label} enabled={totals.calls > 0} onExplain={onExplain} />
      <span className={styles.currency}>USD</span>
    </div>
    <div className={styles.amount}>{usageValue(totals)}</div>
    <p className={styles.note}>{basis}</p>
    {singleSource ? <div className={styles.singleSource}>
      <strong>{exactCount(pricedCount(totals))} priced</strong>
      <span>{exactCount(totals.unpriced)} unpriced</span>
    </div> : <div className={styles.sourceList}>
      {usageSources.filter(source => source !== 'unknown' || sources.unknown.calls > 0).map(source => {
        const row = sources[source];
        return <div key={source}>
          <div className={styles.sourceLabel}>
            <span><i style={{ background: sourceColors[source] }} />{sourceNames[source]}</span>
            <b>{usageValue(row)}</b>
          </div>
          <div className={styles.track} aria-hidden="true">
            <span style={{ background: sourceColors[source], width: (totals.cost ? row.cost / totals.cost * 100 : 0) + '%' }} />
          </div>
          <p className={styles.sourceHint}>{totals.cost && pricedCount(row)
            ? percent(row.cost, totals.cost) + ' of priced usage'
            : source === 'sub' ? 'Valued at API rates' : source === 'api' ? 'Usage through API connections' : 'Provider connection unavailable'}</p>
        </div>;
      })}
    </div>}
    {!singleSource && !!sources.sub.calls && <p className={styles.valueDisclosure}>Subscription activity is valued at API rates.</p>}
  </section>;
}

function UsageStats({ totals, period }: { totals: UsageTotals; period: number }) {
  const { calls, cacheReports, outputReports, measured, observedCacheInput, cached, input, written, output, reasoning, tokens } = totals;
  const missingCacheInput = Math.max(0, input - observedCacheInput);
  const stats = [
    { Icon: Layers3, label: 'Processed tokens', count: measured || !calls ? tokens : null, help: compactCount(tokens / period) + ' daily average' },
    { Icon: Database, label: 'Cached input', count: cacheReports || !calls ? cached : null,
      help: observedCacheInput ? percent(cached, observedCacheInput) + ' of input with cache detail' : 'Provider-reported cache reads' },
    { Icon: ArrowDownLeft, label: 'Uncached input', count: cacheReports || !calls ? Math.max(0, observedCacheInput - cached) : null,
      help: missingCacheInput ? compactCount(missingCacheInput) + ' input without cache detail' : compactCount(written) + ' cache writes included' },
    { Icon: ArrowUpRight, label: 'Output', count: outputReports || !calls ? output : null,
      help: reasoning ? compactCount(reasoning) + ' reasoning tokens included' : 'Generated tokens' },
    { Icon: Activity, label: 'Responses', count: calls, help: exactCount(measured) + ' with token counts' },
  ];
  return <div className={styles.stats} aria-label="Usage totals">
    {stats.map(({ Icon, label, count, help }) => <div key={label}>
      <span className={styles.statLabel}><Icon size={14} strokeWidth={1.7} aria-hidden="true" />{label}</span>
      <strong title={count === null ? 'No measurement' : exactCount(count)}>
        {count === null ? '—' : label === 'Responses' ? exactCount(count) : compactCount(count)}
      </strong>
      <small>{help}</small>
    </div>)}
  </div>;
}

function ModelSummary({ totals, subscription, onExplain }: { totals: UsageTotals; subscription: boolean; onExplain: Explain }) {
  const stats = [
    { label: 'Responses', count: totals.calls },
    { label: 'Input', count: totals.inputReports || !totals.calls ? totals.input : null },
    { label: 'Output', count: totals.outputReports || !totals.calls ? totals.output : null },
    { label: 'Cache reads', count: totals.cacheReports || !totals.calls ? totals.cached : null },
  ];
  const costLabel = totals.estimated && !totals.reported ? 'Estimated API rate equivalent'
    : totals.reported && !totals.estimated ? 'Provider-reported cost' : 'Usage value';
  return <div className={styles.modelSummary} data-subscription={subscription || undefined} aria-label="Model usage totals">
    <div>
      <ValueTitle label={costLabel} enabled={totals.calls > 0} onExplain={onExplain} />
      <strong className={styles.modelAmount}>{usageValue(totals)}</strong>
    </div>
    {stats.map(({ label, count }) => <div key={label}>
      <span className={styles.statLabel}>{label}</span>
      <strong title={count === null ? 'No measurement' : exactCount(count)}>
        {count === null ? '—' : label === 'Responses' ? exactCount(count) : compactCount(count)}
      </strong>
    </div>)}
  </div>;
}

export function UsageDashboard() {
  const [filter, setFilter] = useState<VisibleFilter>('all');
  const [period, setPeriod] = useState<UsageRange>(30);
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [scope, setScope] = useState<UsageScope | null>(null);
  const [preferences, setPreferences] = useState<Record<string, BreakdownPreferences>>({});
  const [explanation, setExplanation] = useState<'range' | 'selection' | null>(null);
  const { report, lastDay, busy, error, refresh } = useUsageReport();
  const dashboard = useRef<HTMLElement>(null);
  const scrollPane = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const history = useRef<Location[]>([]);
  const pendingLocation = useRef<Location | null>(null);
  const explanationTrigger = useRef<HTMLButtonElement | null>(null);

  const days = useMemo(() => daysEndingAt(lastDay, period), [lastDay, period]);
  const day = selectedDay && days.includes(selectedDay) ? selectedDay : null;
  const rangeBuckets = useMemo(() => {
    const range = new Set(days);
    return selectUsageBuckets(report?.buckets ?? [], filter, scope).filter(row => range.has(row.day));
  }, [report, filter, scope, days]);
  const range = useMemo(() => summarizeRange(rangeBuckets, days), [rangeBuckets, days]);
  const selectionBuckets = useMemo(() => day ? rangeBuckets.filter(row => row.day === day) : rangeBuckets, [day, rangeBuckets]);
  const selection = useMemo(() => day ? summarizeRange(selectionBuckets, [day]) : range, [day, selectionBuckets, range]);
  const modelRates = useMemo(() => scope?.model ? summarizeRates(selectionBuckets) : [], [scope, selectionBuckets]);
  const explanationTotals = explanation === 'range' ? range.totals : selection.totals;
  const explanationRates = useMemo(() => {
    if (!explanation) return [];
    if (explanation === 'range') return summarizeRates(rangeBuckets);
    return scope?.model ? modelRates : summarizeRates(selectionBuckets);
  }, [explanation, scope, rangeBuckets, selectionBuckets, modelRates]);

  const dateLabel = dateRange.formatRange(dateOfDay(days[0]), dateOfDay(days[days.length - 1]));
  const dayLabel = day ? fullDate.format(dateOfDay(day)) : undefined;
  const apiOverview = filter === 'api' && !scope;
  const scopeTitle = scope?.model ? modelLabel(scope.model) : scope ? providerLabel(scope.provider)
    : filter === 'api' ? 'API usage' : filter === 'sub' ? 'Subscription usage' : 'Usage';
  const viewKey = JSON.stringify([filter, scope?.provider]);
  const viewPreferences = preferences[viewKey] ?? {};

  function changePeriod(next: UsageRange) {
    setPeriod(next);
    if (selectedDay && !daysEndingAt(lastDay, next).includes(selectedDay)) setSelectedDay(null);
  }

  function openScope(next: UsageScope, rowKey: string) {
    history.current.push({ scope, top: scrollPane.current?.scrollTop ?? 0, rowKey });
    pendingLocation.current = { scope: next, top: 0 };
    setScope(next);
  }

  function goBack(toOverview = false) {
    const location = (toOverview ? history.current.splice(0)[0] : history.current.pop()) ?? { scope: null, top: 0 };
    pendingLocation.current = location;
    setScope(location.scope);
  }

  useLayoutEffect(() => {
    const location = pendingLocation.current;
    if (!location || !scrollPane.current) return;
    pendingLocation.current = null;
    const pane = scrollPane.current;
    pane.scrollTop = location.top;
    const row = location.rowKey && Array.from(pane.querySelectorAll<HTMLButtonElement>('[data-usage-row]'))
      .find(button => button.dataset.usageRow === location.rowKey);
    (row || heading.current)?.focus({ preventScroll: true });
  }, [scope]);

  function explain(kind: 'range' | 'selection', trigger: HTMLButtonElement) {
    explanationTrigger.current = trigger;
    setExplanation(kind);
  }
  const explainSelection: Explain = trigger => explain('selection', trigger);
  const chartTitle = scope?.model ? 'Daily model activity' : apiOverview ? (metric === 'cost' ? 'Provider cost by day' : 'Provider tokens by day') : 'Daily activity';

  const chartFilter = scope && filter === 'all' ? range.providers[0]?.source ?? filter : filter;
  const chart = <UsageChart title={chartTitle} days={range.days} buckets={rangeBuckets} providers={range.providers}
    filter={chartFilter} metric={metric} onMetric={setMetric} day={day} onDay={setSelectedDay}
    byProvider={apiOverview} hasActivity={range.totals.calls > 0} />;

  return <section ref={dashboard} className={styles.dashboard} aria-labelledby="usage-heading" id="eterx-usage-dashboard">
    <div ref={scrollPane} className={styles.scrollPane}>
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.headingGroup}>
            {scope && <nav className={styles.breadcrumb} aria-label="Usage navigation">
              <button type="button" onClick={() => goBack(true)}><ArrowLeft size={13} aria-hidden="true" />Usage</button>
              {history.current.at(-1)?.scope && <>
                <ChevronRight size={13} aria-hidden="true" />
                <button type="button" onClick={() => goBack()}>{providerLabel(scope.provider)}</button>
              </>}
            </nav>}
            <div className={styles.titleLine}>
              <h1 id="usage-heading" ref={heading} tabIndex={-1}>{scopeTitle}</h1>
              {scope?.model && <span className={styles.providerBadge}><ProviderIconAsset provider={scope.provider} />{providerLabel(scope.provider)}</span>}
            </div>
            <p className={styles.range}><CalendarDays size={14} aria-hidden="true" />{dateLabel}
              {report?.updatedAt && <span className={styles.updated} title={'Calendar zone ' + report.timeZone}>Updated {updateTime.format(report.updatedAt)}</span>}
            </p>
          </div>
          <div className={styles.controls}>
            <Segments label="Connection type" values={filters} selected={filter} onSelect={setFilter} />
            <Segments label="Date range" values={ranges} selected={period} onSelect={changePeriod} />
            <button type="button" className={styles.iconButton} title="Refresh usage" aria-label="Refresh usage" disabled={busy} onClick={refresh}>
              <RefreshCw size={15} aria-hidden="true" className={busy ? styles.spinning : undefined} />
            </button>
            <button type="button" className={styles.actionButton} disabled={!report || !selectionBuckets.length}
              onClick={() => {
                if (report) downloadUsageCsv(selectionBuckets, report.timeZone, day ?? days[0], day ?? days[days.length - 1]);
              }}>
              <Download size={14} aria-hidden="true" />Download CSV
            </button>
          </div>
        </header>

        {error && <div role="status" className={styles.notice}>
          <span>{report ? 'Refresh failed. Showing the last loaded usage.' : 'Usage records could not be loaded.'}</span>
          <button type="button" className={styles.inlineAction} onClick={refresh} disabled={busy}>Retry</button>
        </div>}
        {report && !report.savedUsageAvailable && <p role="status" className={styles.notice}>Saved usage is unavailable. Showing activity from the usage ledger.</p>}
        {!report && (!error || busy) && <UsageLoadingContent filter={filter} />}
        {report && (scope?.model ? <>
          {day && <div className={styles.activeFilter}><SelectedDay day={day} onClear={() => setSelectedDay(null)} /></div>}
          <ModelSummary totals={selection.totals} subscription={chartFilter === 'sub'} onExplain={explainSelection} />
          <div className={styles.details} data-model-detail>
            <div className={styles.detailColumn}>
              {chart}
              <section className={styles.subPanel} aria-label="Cost calculation">
                <div className={styles.sectionHead}>
                  <h2>Cost calculation</h2>
                  {!!selection.totals.calls && <button type="button" className={styles.inlineAction} aria-haspopup="dialog"
                    onClick={event => explainSelection(event.currentTarget)}>
                    <Info size={14} aria-hidden="true" />About these rates
                  </button>}
                </div>
                <CostTable totals={selection.totals} rates={modelRates} />
              </section>
            </div>
            <aside className={styles.detailColumn}>
              <ModelPriceDetails provider={providerLabel(scope.provider)} model={scope.model} totals={selection.totals} asOf={report.asOf} />
              <RecentUsageDays days={range.days} day={day} onDay={setSelectedDay} />
            </aside>
          </div>
        </> : <>
          <div className={styles.overview} data-api={apiOverview || undefined}>
            <UsageValuePanel data={range} filter={filter} onExplain={trigger => explain('range', trigger)} />
            {chart}
          </div>
          <UsageStats totals={range.totals} period={period} />
          <div className={styles.details}>
            <UsageBreakdown models={selection.models} providers={selection.providers} days={selection.days} totals={selection.totals}
              group={viewPreferences.group ?? (apiOverview ? 'provider' : 'model')} preferences={viewPreferences}
              onPreferences={patch => setPreferences(previous => ({ ...previous, [viewKey]: { ...previous[viewKey], ...patch } }))}
              metric={metric} day={day} onDay={setSelectedDay} onScope={openScope} detailed={apiOverview || Boolean(scope)} />
            <CostCoverage totals={selection.totals} asOf={report.asOf} scopeLabel={dayLabel} timeZone={report.timeZone} onExplain={explainSelection} />
          </div>
        </>)}
      </div>
    </div>
    {report && <UsageCostDialog open={Boolean(explanation)} container={dashboard.current} totals={explanationTotals}
      rates={explanationRates} scopeLabel={(scope ? scopeTitle + ' · ' : '') + sourceFilterLabel(filter) + ' · ' + (explanation === 'selection' && dayLabel ? dayLabel : dateLabel)}
      asOf={report.asOf} onClose={() => setExplanation(null)}
      onRestoreFocus={() => (explanationTrigger.current?.isConnected ? explanationTrigger.current : heading.current)?.focus({ preventScroll: true })} />}
  </section>;
}

function sourceFilterLabel(filter: VisibleFilter) {
  return filter === 'all' ? 'All connections' : sourceNames[filter];
}
