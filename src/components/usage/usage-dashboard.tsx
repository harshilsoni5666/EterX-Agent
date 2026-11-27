'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, ChevronRight, Download, Info, Layers, RefreshCw } from 'lucide-react';
import { ProviderIconAsset } from '../ui/provider-icon';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import { useAntigravity } from '../../lib/antigravity-client';
import { useNativeProviders } from '../../lib/native-provider-client';
import { dayKey, dateOfDay, daysEndingAt, selectUsageBuckets, summarizeRange, summarizeRates, type UsageReport, type UsageScope, type UsageTotals } from '../../lib/usage/summary';
import { RecentUsageDays, SelectedDay, UsageBreakdown, type BreakdownPreferences } from './usage-breakdown';
import { UsageChart } from './usage-chart';
import { Segments, UsageSelect } from './usage-controls';
import { UsageLimits } from './usage-limits';
import type { SubscriptionProvider } from '../../lib/agent/model-selector-store';
import { UsageLoadingContent } from './usage-loading';
import { UsageMix } from './usage-mix';
import { TokenCoverage, UsageTotalsBand, UsageValuePanel, ValueTitle, type ExplainUsage } from './usage-overview';
import { CostCoverage, CostTable, ModelPriceDetails, UsageCostDialog } from './usage-pricing';
import { buildUsageSeries } from './usage-series';
import { compactCount, dateRange, downloadUsageCsv, exactCount, formatUsageBucket, modelLabel, providerLabel, sourceNames, timeRange, usageMetricValue, usageViews, type UsageMetric, type UsageView } from './usage-format';
import styles from './usage-dashboard.module.css';

const filters = [['all', 'All'], ['api', 'API'], ['sub', 'Sub']] as const;
const ranges = [['24h', 'Past 24h'], [7, '7 days'], [30, '30 days'], [90, '90 days']] as const;
const allProviders = { label: 'All providers', icon: <Layers size={14} strokeWidth={1.75} /> };
const updateTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
type UsageRange = typeof ranges[number][0];
type VisibleFilter = typeof filters[number][0];
type Location = { scope: UsageScope | null; top: number; rowKey?: string };

function useUsageReport(active: boolean) {
  const antigravityRevision = useAntigravity()?.usageRevision ?? 0;
  const nativeRevision = useNativeProviders()?.usageRevision ?? 0;
  const usageRevision = antigravityRevision + ':' + nativeRevision;
  const seenUsageRevision = useRef(usageRevision);
  const queuedRefresh = useRef(false);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [lastDay, setLastDay] = useState(() => dayKey(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const refreshQueued = useRef<() => void>(() => undefined);
  const refresh = useCallback(async (): Promise<void> => {
    if (!active || inFlight.current || !isAppVisible()) return;
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
        setLastDay(dayKey(new Date(Number.isFinite(next.updatedAt) ? next.updatedAt : Date.now())));
        setError(false);
      }
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setBusy(false);
        if (queuedRefresh.current) {
          queuedRefresh.current = false;
          refreshQueued.current();
        }
      }
    }
  }, [active]);
  useEffect(() => { refreshQueued.current = () => { void refresh(); }; }, [refresh]);

  useEffect(() => {
    if (usageRevision === seenUsageRevision.current) return;
    seenUsageRevision.current = usageRevision;
    if (!active) return;
    if (inFlight.current) queuedRefresh.current = true;
    else void refresh();
  }, [active, refresh, usageRevision]);

  useEffect(() => {
    if (!active) {
      setBusy(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    const unsubscribe = subscribeAppVisibility(() => { if (isAppVisible()) void refresh(); });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      inFlight.current?.abort();
      inFlight.current = null;
      queuedRefresh.current = false;
    };
  }, [active, refresh]);

  return { report, lastDay, busy, error, refresh };
}

function ModelSummary({ totals, subscription, metric, onExplain }: {
  totals: UsageTotals;
  subscription: boolean;
  metric: UsageMetric;
  onExplain: ExplainUsage;
}) {
  const stats = [
    { label: 'Responses', count: totals.calls },
    { label: 'Input', count: totals.inputReports || !totals.calls ? totals.input : null },
    { label: 'Output', count: totals.outputReports || !totals.calls ? totals.output : null },
    { label: 'Cache reads', count: totals.cacheReports || !totals.calls ? totals.cached : null },
  ];
  const label = metric === 'tokens' ? 'Processed tokens'
    : totals.estimated && !totals.reported ? 'Estimated API rate equivalent'
    : totals.reported && !totals.estimated ? 'Provider-reported cost' : 'Usage value';
  return <div className={styles.modelSummary} data-subscription={subscription || undefined} aria-label="Model usage totals">
    <div>
      <ValueTitle label={label} onExplain={metric === 'cost' && totals.calls ? onExplain : undefined} />
      <strong className={styles.modelAmount} title={metric === 'tokens' && totals.measured ? exactCount(totals.tokens) : undefined}>
        {usageMetricValue(totals, metric)}
      </strong>
    </div>
    {stats.map(({ label, count }) => <div key={label}>
      <span className={styles.statLabel}>{label}</span>
      <strong title={count === null ? 'No measurement' : exactCount(count)}>
        {count === null ? '—' : label === 'Responses' ? exactCount(count) : compactCount(count)}
      </strong>
    </div>)}
  </div>;
}

export function UsageDashboard({ onManageSubscription }: { onManageSubscription: (provider: SubscriptionProvider) => void }) {
  const [view, setView] = useState<UsageView>('cost');
  const [filter, setFilter] = useState<VisibleFilter>('all');
  const [period, setPeriod] = useState<UsageRange>(30);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [scope, setScope] = useState<UsageScope | null>(null);
  const [preferences, setPreferences] = useState<Record<string, BreakdownPreferences>>({});
  const [explanation, setExplanation] = useState<'range' | 'selection' | null>(null);
  const historyVisible = view !== 'limits';
  const metric: UsageMetric = view === 'tokens' ? 'tokens' : 'cost';
  const { report, lastDay, busy, error, refresh } = useUsageReport(historyVisible);
  const dashboard = useRef<HTMLElement>(null);
  const scrollPane = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const history = useRef<Location[]>([]);
  const pendingLocation = useRef<Location | null>(null);
  const explanationTrigger = useRef<HTMLButtonElement | null>(null);

  const byHour = period === '24h';
  const recent = report?.recent;
  const days = useMemo(() => period === '24h' ? recent?.hours ?? [] : daysEndingAt(lastDay, period), [recent?.hours, lastDay, period]);
  const day = selectedDay && days.includes(selectedDay) ? selectedDay : null;
  const availableBuckets = useMemo(() => {
    const range = new Set(days);
    const buckets = byHour ? recent?.buckets : report?.buckets;
    return selectUsageBuckets(buckets ?? [], filter, null).filter(row => range.has(row.day));
  }, [report, recent, days, filter, byHour]);
  const providerOptions = useMemo(() => {
    const ids = new Set(availableBuckets.map(row => row.provider));
    if (scope?.provider) ids.add(scope.provider);
    return Array.from(ids, provider => ({
      value: provider,
      label: providerLabel(provider),
      icon: <ProviderIconAsset provider={provider} />,
    })).sort((a, b) => a.label.localeCompare(b.label));
  }, [availableBuckets, scope?.provider]);
  const rangeBuckets = useMemo(() => scope ? selectUsageBuckets(availableBuckets, 'all', scope) : availableBuckets, [availableBuckets, scope]);
  const range = useMemo(() => summarizeRange(rangeBuckets, days), [rangeBuckets, days]);
  const selectionBuckets = useMemo(() => day ? rangeBuckets.filter(row => row.day === day) : rangeBuckets, [day, rangeBuckets]);
  const selection = useMemo(() => day ? summarizeRange(selectionBuckets, [day]) : range, [day, selectionBuckets, range]);
  const byModel = Boolean(scope);
  const series = useMemo(() => buildUsageSeries(byModel ? range.models : range.providers, metric), [range, byModel, metric]);
  const selectionRates = useMemo(() => historyVisible && metric === 'cost' ? summarizeRates(selectionBuckets) : [], [historyVisible, metric, selectionBuckets]);
  const explanationTotals = explanation === 'range' ? range.totals : selection.totals;
  const explanationRates = useMemo(() => {
    if (!explanation) return [];
    return explanation === 'range' && day ? summarizeRates(rangeBuckets) : selectionRates;
  }, [explanation, day, rangeBuckets, selectionRates]);

  const dateLabel = byHour
    ? recent ? timeRange.formatRange(new Date(recent.startAt), new Date(recent.endAt)) : 'Past 24 hours'
    : dateRange.formatRange(dateOfDay(days[0]), dateOfDay(days[days.length - 1]));
  const dayLabel = day ? formatUsageBucket(day) : undefined;
  const overviewTitle = scope?.model ? modelLabel(scope.model) : scope ? providerLabel(scope.provider) : 'Usage';
  const parentScope = history.current.at(-1)?.scope;
  const viewKey = JSON.stringify([filter, scope?.provider]);
  const viewPreferences = preferences[viewKey] ?? {};
  const connectionLabel = filter === 'all' ? 'All connections' : sourceNames[filter];

  function changeView(next: UsageView) {
    if (next === view) return;
    setView(next);
    setExplanation(null);
    if (next === 'limits' || view === 'limits') scrollPane.current?.scrollTo({ top: 0 });
  }

  function changePeriod(next: UsageRange) {
    if (next === period) return;
    setPeriod(next);
    if (next === '24h' || byHour || (selectedDay && !daysEndingAt(lastDay, next).includes(selectedDay))) setSelectedDay(null);
  }

  function openScope(next: UsageScope, rowKey?: string) {
    if (scope && scope.provider === next.provider && scope.model === next.model) return;
    history.current.push({ scope, top: scrollPane.current?.scrollTop ?? 0, rowKey });
    pendingLocation.current = { scope: next, top: 0 };
    setScope(next);
  }

  function goBack(toOverview = false) {
    const location = (toOverview ? history.current.splice(0)[0] : history.current.pop()) ?? { scope: null, top: 0 };
    pendingLocation.current = location;
    setScope(location.scope);
  }

  function changeProvider(provider: string | null) {
    if (!provider) {
      if (scope) goBack(true);
      return;
    }
    if (!scope) {
      openScope({ provider });
      return;
    }
    const next = { provider };
    history.current.splice(1);
    pendingLocation.current = { scope: next, top: 0 };
    setScope(next);
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
  const explainSelection: ExplainUsage = trigger => explain('selection', trigger);
  const chartTitle = (byHour ? 'Hourly ' : 'Daily ') + (metric === 'cost' ? 'cost' : 'tokens')
    + (scope?.model ? '' : byModel ? ' by model' : ' by provider');
  const chart = <UsageChart title={chartTitle} days={range.days} buckets={rangeBuckets} series={series}
    byModel={byModel} byHour={byHour} metric={metric} day={day} onDay={setSelectedDay} hasActivity={range.totals.calls > 0} />;
  const mix = <UsageMix metric={metric} totals={selection.totals} sources={selection.sources} rates={selectionRates} />;

  return <section ref={dashboard} className={styles.dashboard} aria-labelledby="usage-heading" id="eterx-usage-dashboard">
    <div ref={scrollPane} className={styles.scrollPane}>
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <div className={styles.headingGroup}>
              {historyVisible && scope && <nav className={styles.breadcrumb} aria-label="Usage navigation">
                <button type="button" onClick={() => goBack(true)}><ArrowLeft size={13} aria-hidden="true" />Usage</button>
                {parentScope && <>
                  <ChevronRight size={13} aria-hidden="true" />
                  <button type="button" onClick={() => goBack()}>{providerLabel(parentScope.provider)}</button>
                </>}
              </nav>}
              <div className={styles.titleLine}>
                <h1 id="usage-heading" ref={heading} tabIndex={-1}>{historyVisible ? overviewTitle : 'Usage limits'}</h1>
                {historyVisible && scope?.model && <span className={styles.providerBadge}><ProviderIconAsset provider={scope.provider} />{providerLabel(scope.provider)}</span>}
              </div>
              {historyVisible && <p className={styles.range}><CalendarDays size={14} aria-hidden="true" />{dateLabel}
                {report?.updatedAt && <span className={styles.updated} title={'Calendar zone ' + report.timeZone}>Updated {updateTime.format(report.updatedAt)}</span>}
              </p>}
            </div>
            <div className={styles.viewSwitch}><Segments label="Usage view" values={usageViews} selected={view} onSelect={changeView} /></div>
          </div>
          {historyVisible && <div className={styles.toolbar}>
            <div className={styles.controls}>
              <Segments label="Connection type" values={filters} selected={filter} onSelect={setFilter} />
              <UsageSelect label="Provider" value={scope?.provider ?? null} all={allProviders} options={providerOptions}
                onSelect={changeProvider} className={styles.providerControl} />
            </div>
            <div className={styles.controls}>
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
          </div>}
        </header>

        {!historyVisible ? <UsageLimits onManageSubscription={onManageSubscription} /> : <>
          {error && <div role="status" className={styles.notice}>
            <span>{report ? 'Refresh failed. Showing the last loaded usage.' : 'Usage records could not be loaded.'}</span>
            <button type="button" className={styles.inlineAction} onClick={refresh} disabled={busy}>Retry</button>
          </div>}
          {report && !report.savedUsageAvailable && <p role="status" className={styles.notice}>Saved chat usage is temporarily unavailable.</p>}
          {!report && (!error || busy) && <UsageLoadingContent />}
          {report && (scope?.model ? <>
            {day && <div className={styles.activeFilter}><SelectedDay day={day} onClear={() => setSelectedDay(null)} /></div>}
            <ModelSummary totals={selection.totals} subscription={range.providers[0]?.source === 'sub'} metric={metric} onExplain={explainSelection} />
            <div className={styles.details}>
              <div className={styles.detailColumn}>
                {chart}
                {metric === 'cost' ? <section className={styles.subPanel} aria-label="Cost calculation">
                  <div className={styles.sectionHead}>
                    <h2>Cost calculation</h2>
                    {!!selection.totals.calls && <button type="button" className={styles.inlineAction} aria-haspopup="dialog"
                      onClick={event => explainSelection(event.currentTarget)}>
                      <Info size={14} aria-hidden="true" />About these rates
                    </button>}
                  </div>
                  <CostTable totals={selection.totals} rates={selectionRates} />
                </section> : mix}
              </div>
              <aside className={styles.detailColumn}>
                {metric === 'cost'
                  ? <ModelPriceDetails provider={providerLabel(scope.provider)} model={scope.model} totals={selection.totals} asOf={report.asOf} />
                  : <TokenCoverage totals={selection.totals} scopeLabel={dayLabel} />}
                <RecentUsageDays days={range.days} day={day} onDay={setSelectedDay} metric={metric} byHour={byHour} />
              </aside>
            </div>
          </> : <>
            <div className={styles.overview}>
              <UsageValuePanel totals={range.totals} series={series} filter={filter} metric={metric} byModel={byModel}
                onScope={openScope} onExplain={trigger => explain('range', trigger)} />
              {chart}
            </div>
            <UsageTotalsBand totals={range.totals} period={period} />
            {day && <div className={styles.activeFilter}><SelectedDay day={day} onClear={() => setSelectedDay(null)} /></div>}
            {mix}
            <div className={styles.details}>
              <UsageBreakdown models={selection.models} providers={selection.providers} days={selection.days} totals={selection.totals}
                group={viewPreferences.group ?? (filter === 'api' && !scope ? 'provider' : 'model')} preferences={viewPreferences}
                onPreferences={patch => setPreferences(previous => ({ ...previous, [viewKey]: { ...previous[viewKey], ...patch } }))}
                metric={metric} byHour={byHour} day={day} onDay={setSelectedDay} onScope={openScope} detailed={filter === 'api' || Boolean(scope)} />
              {metric === 'cost'
                ? <CostCoverage totals={selection.totals} asOf={report.asOf} scopeLabel={dayLabel} timeZone={report.timeZone} onExplain={explainSelection} />
                : <TokenCoverage totals={selection.totals} scopeLabel={dayLabel} />}
            </div>
          </>)}
        </>}
      </div>
    </div>
    {historyVisible && report && <UsageCostDialog open={Boolean(explanation)} container={dashboard.current} totals={explanationTotals}
      rates={explanationRates} scopeLabel={(scope ? overviewTitle + ' · ' : '') + connectionLabel + ' · ' + (explanation === 'selection' && dayLabel ? dayLabel : dateLabel)}
      asOf={report.asOf} onClose={() => setExplanation(null)}
      onRestoreFocus={() => (explanationTrigger.current?.isConnected ? explanationTrigger.current : heading.current)?.focus({ preventScroll: true })} />}
  </section>;
}
