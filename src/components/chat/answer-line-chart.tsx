import React, { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatVisualNumber, visualFraction, type AnswerVisualData } from '../../lib/markdown/answer-visual';

type LineData = Extract<AnswerVisualData, { type: 'line' }>;
const axisText = { fill: 'var(--eterx-answer-chart-label)', fontSize: 11 };
const accent = 'var(--eterx-answer-chart-accent)';
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 4 });
const axisNumber = (value: number) => Math.abs(value) >= 1e15 || (value !== 0 && Math.abs(value) < 0.001)
  ? value.toExponential(2) : compact.format(value);

export default function AnswerLineChart({ items, title }: Pick<LineData, 'items' | 'title'>) {
  const { points, ticks, tickLabels, axisWidth } = useMemo(() => {
    const values = items.flatMap(item => item.value === null ? [] : [item.value]);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const points = items.map((item, index) => ({ index, value: item.value === null ? null : visualFraction(item.value, low, high) }));
    const ticks = low === high ? [0.5] : [0, 0.25, 0.5, 0.75, 1];
    const tickValues = ticks.map(fraction => low * (1 - fraction) + high * fraction);
    const labels = tickValues.map(axisNumber);
    // Closely spaced points can round to the same compact axis label.
    const exact = new Set(labels).size !== labels.length;
    const tickLabels = new Map(ticks.map((tick, index) => [tick, exact ? formatVisualNumber(tickValues[index]) : labels[index]]));
    const axisWidth = Math.min(130, Math.max(33, ...Array.from(tickLabels.values(), label => label.length * 6 + 12)));
    return { points, ticks, tickLabels, axisWidth };
  }, [items]);

  return <div className="eterx-answer-visual-plot">
    <ResponsiveContainer width="100%" height="100%" minWidth={1}>
      <LineChart accessibilityLayer aria-label={title} data={points} margin={{ top: 12, right: 20, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--eterx-md-border-strong)" />
        <XAxis dataKey="index" tickFormatter={index => {
          const label = items[index]?.label ?? '';
          return label.length > 16 ? `${label.slice(0, 15)}…` : label;
        }} interval="preserveStartEnd" minTickGap={18} tick={axisText} tickLine={false}
          axisLine={false} padding={{ left: 8, right: 8 }} />
        <YAxis width={axisWidth} domain={[0, 1]} ticks={ticks} tickFormatter={tick => tickLabels.get(tick) ?? ''}
          tick={axisText} tickLine={false} axisLine={false} />
        <Tooltip filterNull={false} isAnimationActive={false} wrapperStyle={{ pointerEvents: 'none' }}
          cursor={{ stroke: 'var(--eterx-md-border-strong)' }}
          content={({ active, label }) => {
            const item = items[Number(label)];
            if (!active || !item) return null;
            return <div className="eterx-answer-visual-tooltip" role="status">
              <strong>{item.label}</strong>
              <span>{item.value === null ? 'No data' : item.display ?? formatVisualNumber(item.value)}</span>
              {item.detail && <small>{item.detail}</small>}
            </div>;
          }} />
        <Line type="linear" dataKey="value" stroke={accent} strokeWidth={2} isAnimationActive={false}
          dot={{ r: items.length > 24 ? 1.5 : 2.5, fill: accent, strokeWidth: 0 }} activeDot={{ r: 4 }} />
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
