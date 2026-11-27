import { useId, useMemo } from 'react';
import { Activity, ChevronDown } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { UsageBucket, UsageDay } from '../../lib/usage/summary';
import { compactCount, exactCount, formatUsageBucket, metricMeasured, usageScopeKey, usd, type UsageMetric } from './usage-format';
import type { UsageSeries } from './usage-series';
import styles from './usage-dashboard.module.css';

interface ChartValue {
  value: number;
  calls: number;
  measured: number;
}

function chartDays(days: UsageDay[], buckets: UsageBucket[], series: UsageSeries[], byModel: boolean, metric: UsageMetric) {
  const seriesByScope = new Map<string, number>();
  let otherIndex = -1;
  series.forEach((entry, index) => {
    if (entry.scope) seriesByScope.set(usageScopeKey(entry.scope), index);
    else otherIndex = index;
  });
  const points = days.map(row => ({
    day: row.day, row,
    values: series.map((): ChartValue => ({ value: 0, calls: 0, measured: 0 })),
  }));
  const byDay = new Map(points.map(point => [point.day, point]));
  for (const bucket of buckets) {
    const key = usageScopeKey({ provider: bucket.provider, model: byModel ? bucket.model : undefined });
    const index = seriesByScope.get(key) ?? otherIndex;
    const value = byDay.get(bucket.day)?.values[index];
    if (!value) continue;
    value.value += bucket[metric];
    value.calls += bucket.calls;
    value.measured += metricMeasured(bucket, metric);
  }

  const plotData = points.map(point => ({
    day: point.day,
    ...Object.fromEntries(series.map((entry, index) => {
      const value = point.values[index];
      return [entry.id, value.calls > 0 && !value.measured ? null : value.value];
    })),
  }));
  return { plotData, byDay };
}

export function UsageChart({ title, days, buckets, series, byModel, byHour, metric, day, onDay, hasActivity }: {
  title: string;
  days: UsageDay[];
  buckets: UsageBucket[];
  series: UsageSeries[];
  byModel: boolean;
  byHour: boolean;
  metric: UsageMetric;
  day: string | null;
  onDay: (day: string | null) => void;
  hasActivity: boolean;
}) {
  const id = useId();
  const gradientId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const { byDay, plotData } = useMemo(
    () => chartDays(days, buckets, series, byModel, metric),
    [days, buckets, series, byModel, metric],
  );
  const isCost = metric === 'cost';
  const hasMetric = days.some(row => metricMeasured(row, metric) > 0);
  const ticks = days.length ? [0, .25, .5, .75, 1].map(fraction => days[Math.round((days.length - 1) * fraction)].day) : [];
  const interval = byHour ? 'hour' : 'day';
  const axis = (value: number) => isCost ? (value >= 1000 ? '$' + compactCount(value) : usd(value)) : compactCount(value);
  const tooltipValue = isCost ? usd : exactCount;

  return <section className={styles.chartPanel} aria-labelledby={id + '-title'}>
    <div className={styles.sectionHead}>
      <h2 id={id + '-title'}>{title}</h2>
      {hasActivity && <label className={styles.daySelect}>
        <span>Inspect {interval}</span>
        <span className={styles.selectControl}>
          <select value={day ?? ''} onChange={event => onDay(event.target.value || null)}>
            <option value="">All {interval}s</option>
            {[...days].reverse().map(row => <option value={row.day} key={row.day}>{formatUsageBucket(row.day)}</option>)}
          </select>
          <ChevronDown size={12} aria-hidden="true" />
        </span>
      </label>}
    </div>
    {hasMetric ? <div className={styles.plot} role="group" aria-label={title}>
      <ResponsiveContainer width="100%" height="100%" minWidth={1}>
        <AreaChart
          accessibilityLayer
          data={plotData}
          margin={{ top: 14, left: 0, right: 16, bottom: 0 }}
          onClick={({ activeLabel }) => {
            if (typeof activeLabel === 'string' && byDay.has(activeLabel)) onDay(day === activeLabel ? null : activeLabel);
          }}
        >
          <defs>{series.map(entry => <linearGradient id={gradientId + '-' + entry.id} key={entry.id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={entry.color} stopOpacity={.24} />
            <stop offset="100%" stopColor={entry.color} stopOpacity={.035} />
          </linearGradient>)}</defs>
          <CartesianGrid vertical={false} stroke="var(--usage-line)" />
          <XAxis dataKey="day" ticks={ticks} interval="preserveStartEnd" minTickGap={21} padding={{ left: 8, right: 8 }}
            tickFormatter={value => formatUsageBucket(value, true)} height={32}
            tick={{ fill: 'var(--usage-muted)', fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={9} />
          <YAxis width={65} tickCount={5} tickFormatter={axis} allowDecimals={isCost}
            tick={{ fill: 'var(--usage-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip filterNull={false} isAnimationActive={false} wrapperStyle={{ pointerEvents: 'none' }}
            cursor={{ stroke: 'var(--usage-muted)', strokeDasharray: '3 4' }}
            content={({ active, label }) => {
              const point = byDay.get(String(label));
              if (!active || !point) return null;
              const row = point.row;
              const unmeasured = isCost ? row.unpriced : row.calls - row.measured;
              return <div className={styles.tooltip}>
                <div className={styles.tooltipTotal}>
                  <strong>{formatUsageBucket(point.day)}</strong>
                  {!!row.calls && <b>{metricMeasured(row, metric) ? tooltipValue(row[metric]) : '—'}</b>}
                </div>
                {!row.calls && <small>No recorded responses</small>}
                {series.map((entry, index) => {
                  const value = point.values[index];
                  return !value.calls ? null : <div key={entry.id}>
                    <span><i style={{ background: entry.color }} />{entry.name}</span>
                    <b>{value.measured ? tooltipValue(value.value) : '—'}</b>
                  </div>;
                })}
                {!!unmeasured && <small>{exactCount(unmeasured)} {isCost ? 'unpriced' : 'without token counts'}</small>}
              </div>;
            }} />
          {!!day && <ReferenceLine x={day} stroke="var(--usage-text)" strokeOpacity={.6} strokeDasharray="3 4" />}
          {[...series].reverse().map(entry => <Area key={entry.id} dataKey={entry.id}
            name={entry.name} type="monotone" stroke={entry.color} strokeWidth={2}
            fill={'url(#' + gradientId + '-' + entry.id + ')'} fillOpacity={1} activeDot={{ r: 4, strokeWidth: 1.5 }}
            isAnimationActive={false} />)}
        </AreaChart>
      </ResponsiveContainer>
    </div> : <div className={styles.emptyChart}>
      <Activity aria-hidden="true" size={24} strokeWidth={1.4} />
      <strong>{hasActivity ? isCost ? 'No priced responses' : 'No token counts reported' : 'No activity in this period'}</strong>
      <span>{hasActivity ? 'Response counts are available in the breakdown.' : 'Recorded model activity appears here.'}</span>
    </div>}
    {hasMetric && <div className={styles.chartFooter}>
      <div className={styles.legend} aria-label="Chart legend">
        {series.map(entry => <span key={entry.id}><i style={{ background: entry.color }} />{entry.name}</span>)}
      </div>
    </div>}
  </section>;
}
