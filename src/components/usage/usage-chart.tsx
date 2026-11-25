import { useId, useMemo } from 'react';
import { Activity, ChevronDown } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dateOfDay, type UsageBucket, type UsageDay, type UsageFilter, type ProviderUsage } from '../../lib/usage/summary';
import { Segments } from './usage-controls';
import { compactCount, exactCount, fullDate, metricMeasured, metricOptions, providerLabel, shortDate, sourceColors, sourceNames, usd, usageSources, type UsageMetric } from './usage-format';
import styles from './usage-dashboard.module.css';

interface ChartSeries {
  id: string;
  name: string;
  color: string;
}
interface ChartValue {
  value: number;
  calls: number;
  measured: number;
}

function chartDays(days: UsageDay[], buckets: UsageBucket[], providers: ProviderUsage[], filter: UsageFilter, byProvider: boolean, metric: UsageMetric) {
  const top = [...providers].sort((a, b) => b[metric] - a[metric] || b.calls - a.calls || a.provider.localeCompare(b.provider)).slice(0, 3);
  const providerIndices = new Map(top.map((provider, index) => [provider.provider, index]));
  const otherIndex = top.length;
  const providerSeries = top.map((provider, index) =>
    ({ id: 'provider' + index, name: providerLabel(provider.provider), color: 'var(--usage-series-' + index + ')' }));
  if (providers.length > top.length) providerSeries.push({ id: 'other', name: 'Other providers', color: 'var(--usage-series-3)' });

  const sources = usageSources.filter(source => filter === 'all'
    ? source !== 'unknown' || days.some(day => day.unknown.calls > 0)
    : source === filter);
  const series: ChartSeries[] = byProvider
    ? providerSeries
    : sources.map(id => ({ id, color: sourceColors[id], name: sourceNames[id] }));
  const points = days.map(row => ({
    day: row.day, row,
    values: series.map((): ChartValue => ({ value: 0, calls: 0, measured: 0 })),
  }));
  const byDay = new Map(points.map(point => [point.day, point]));
  if (byProvider) {
    for (const bucket of buckets) {
      const value = byDay.get(bucket.day)?.values[providerIndices.get(bucket.provider) ?? otherIndex];
      if (!value) continue;
      value.value += bucket[metric];
      value.calls += bucket.calls;
      value.measured += metricMeasured(bucket, metric);
    }
  } else {
    for (const point of points) {
      for (const [index, id] of sources.entries()) {
        const row = point.row[id];
        point.values[index] = { value: row[metric], calls: row.calls, measured: metricMeasured(row, metric) };
      }
    }
  }
  const plotData = points.map(point => ({
    day: point.day,
    ...Object.fromEntries(series.map((entry, index) => {
      const value = point.values[index];
      return [entry.id, value.calls > 0 && !value.measured ? null : value.value];
    })),
  }));
  return { plotData, byDay, series };
}

export function UsageChart({ title, days, buckets, providers, byProvider, filter, metric, onMetric, day, onDay, hasActivity }: {
  title: string;
  days: UsageDay[];
  buckets: UsageBucket[];
  providers: ProviderUsage[];
  byProvider: boolean;
  filter: UsageFilter;
  metric: UsageMetric;
  onMetric: (metric: UsageMetric) => void;
  day: string | null;
  onDay: (day: string | null) => void;
  hasActivity: boolean;
}) {
  const id = useId();
  const gradientId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const { byDay, plotData, series } = useMemo(
    () => chartDays(days, buckets, providers, filter, byProvider, metric),
    [days, buckets, providers, filter, byProvider, metric],
  );
  const hasMetric = days.some(row => metricMeasured(row, metric) > 0);
  const ticks = [0, .25, .5, .75, 1].map(fraction => days[Math.round((days.length - 1) * fraction)].day);
  const axis = (value: number) => metric === 'cost' ? (value >= 1000 ? '$' + compactCount(value) : usd(value)) : compactCount(value);

  return <section className={styles.chartPanel} aria-labelledby={id + '-title'}>
    <div className={styles.sectionHead}>
      <h2 id={id + '-title'}>{title}</h2>
      <Segments label="Chart metric" values={metricOptions} selected={metric} onSelect={onMetric} />
    </div>
    {hasMetric ? <div className={styles.plot} role="group" aria-label={metric === 'cost' ? 'Daily usage value in USD' : 'Daily processed tokens'}>
      <ResponsiveContainer width="100%" height="100%" minWidth={1}>
        <AreaChart
          accessibilityLayer
          data={plotData}
          margin={{ top: 12, left: 0, right: 15, bottom: 0 }}
          onClick={({ activeLabel }) => {
            if (typeof activeLabel === 'string' && byDay.has(activeLabel)) onDay(day === activeLabel ? null : activeLabel);
          }}
        >
          <defs>{series.map((entry, index) => <linearGradient id={gradientId + '-' + index} key={entry.id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={entry.color} stopOpacity={.4} />
            <stop offset="100%" stopColor={entry.color} stopOpacity={.09} />
          </linearGradient>)}</defs>
          <CartesianGrid vertical={false} stroke="var(--usage-line)" strokeDasharray="3 5" />
          <XAxis dataKey="day" ticks={ticks} interval="preserveStartEnd" minTickGap={20} padding={{ left: 12, right: 10 }}
            tickFormatter={value => shortDate.format(dateOfDay(value))} height={32}
            tick={{ fill: 'var(--usage-muted)', fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={9} />
          <YAxis width={61} tickCount={4} tickFormatter={axis} allowDecimals={metric === 'cost'}
            tick={{ fill: 'var(--usage-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip filterNull={false} isAnimationActive={false} wrapperStyle={{ pointerEvents: 'none' }}
            cursor={{ stroke: 'var(--usage-muted)', strokeDasharray: '3 4' }}
            content={({ active, label }) => {
              const point = byDay.get(String(label));
              if (!active || !point) return null;
              const unmeasured = metric === 'cost' ? point.row.unpriced : point.row.calls - point.row.measured;
              return <div className={styles.tooltip}>
                <strong>{fullDate.format(dateOfDay(point.day))}</strong>
                {series.map((entry, index) => {
                  const value = point.values[index];
                  return <div key={entry.id}><span><i style={{ background: entry.color }} />{entry.name}</span>
                    <b>{value.calls && !value.measured ? '—' : metric === 'cost' ? usd(value.value) : exactCount(value.value)}</b></div>;
                })}
                {!!unmeasured && <small>{exactCount(unmeasured)} {metric === 'cost' ? 'unpriced' : 'without token counts'}</small>}
              </div>;
            }} />
          {!!day && <ReferenceLine x={day} stroke="var(--usage-text)" strokeOpacity={.6} strokeDasharray="3 4" />}
          {series.map((entry, index) => <Area key={entry.id} dataKey={entry.id}
            name={entry.name} stackId="usage" type="linear" stroke={entry.color} strokeWidth={1.9}
            fill={'url(#' + gradientId + '-' + index + ')'} fillOpacity={1} activeDot={{ r: 4, strokeWidth: 1.5 }}
            isAnimationActive={false} />)}
        </AreaChart>
      </ResponsiveContainer>
    </div> : <div className={styles.emptyChart}>
      <Activity aria-hidden="true" size={24} strokeWidth={1.4} />
      <strong>{hasActivity ? metric === 'cost' ? 'No priced responses' : 'No token counts reported' : 'No activity in this period'}</strong>
      <span>{hasActivity ? 'Response counts are available in the breakdown.' : 'Recorded model activity appears here.'}</span>
    </div>}
    {(hasMetric || hasActivity) && <div className={styles.chartFooter}>
      {hasActivity && <label className={styles.daySelect}>
        <span>Inspect day</span>
        <span className={styles.selectControl}>
          <select value={day ?? ''} onChange={event => onDay(event.target.value || null)}>
            <option value="">All days</option>
            {[...days].reverse().map(row => <option value={row.day} key={row.day}>{fullDate.format(dateOfDay(row.day))}</option>)}
          </select>
          <ChevronDown size={12} aria-hidden="true" />
        </span>
      </label>}
      {hasMetric && <div className={styles.legend}>
        {series.map(entry => <span key={entry.id}><i style={{ background: entry.color }} />{entry.name}</span>)}
      </div>}
    </div>}
  </section>;
}
