import React, { lazy, Suspense, useId } from 'react';
import { formatVisualNumber, visualFraction, type AnswerVisualData } from '../../lib/markdown/answer-visual';

const AnswerLineChart = lazy(() => import('./answer-line-chart').catch(() => ({
  default: () => <p className="eterx-answer-visual-caption">Chart unavailable. View the data below.</p>,
})));

type BarData = Extract<AnswerVisualData, { type: 'bar' }>;
type TimelineData = Extract<AnswerVisualData, { type: 'timeline' }>;
type LineData = Extract<AnswerVisualData, { type: 'line' }>;

const percent = (fraction: number) => `${fraction * 100}%`;

function VisualRow({ label, detail, value, children }: {
  label: string;
  detail?: string;
  value: string;
  children: React.ReactNode;
}) {
  return <li className="eterx-answer-visual-row">
    <div>{label}{detail && <small>{detail}</small>}</div>
    <div className="eterx-answer-visual-track" aria-hidden="true">{children}</div>
    <div className="eterx-answer-visual-value">{value}</div>
  </li>;
}

function Bars({ items }: BarData) {
  const values = items.map(item => item.value);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const zero = visualFraction(0, low, high);
  return <ul className="eterx-answer-visual-rows" role="list">
    {items.map((item, index) => {
      const point = visualFraction(item.value, low, high);
      return <VisualRow key={index} label={item.label} detail={item.detail}
        value={item.display ?? formatVisualNumber(item.value)}>
        {low < 0 && high > 0 && <span className="eterx-answer-visual-zero" style={{ insetInlineStart: percent(zero) }} />}
        <span className="eterx-answer-visual-fill" style={{
          insetInlineStart: percent(Math.min(point, zero)), inlineSize: percent(Math.abs(point - zero)),
        }} />
      </VisualRow>;
    })}
  </ul>;
}

function Timeline({ items, domain }: TimelineData) {
  const [low, high] = domain ?? [Math.min(...items.map(item => item.start)), Math.max(...items.map(item => item.end ?? item.start))];
  return <div className="eterx-answer-visual-timeline">
    {low !== high && <div className="eterx-answer-visual-scale" aria-hidden="true">
      <div><span>{formatVisualNumber(low)}</span><span>{formatVisualNumber(high)}</span></div>
    </div>}
    <ul className="eterx-answer-visual-rows" role="list">
      {items.map((item, index) => {
        const end = item.end ?? item.start;
        const startPosition = visualFraction(item.start, low, high);
        const endPosition = visualFraction(end, low, high);
        const time = end === item.start ? formatVisualNumber(item.start)
          : `${formatVisualNumber(item.start)}–${formatVisualNumber(end)}`;
        return <VisualRow key={index} label={item.label} detail={item.detail} value={item.display ?? time}>
          {item.start === end ? <span className="eterx-answer-visual-milestone" style={{ insetInlineStart: percent(startPosition) }} />
            : <span className="eterx-answer-visual-fill" style={{ insetInlineStart: percent(startPosition), inlineSize: percent(endPosition - startPosition) }} />}
        </VisualRow>;
      })}
    </ul>
  </div>;
}

function Line({ items, unit, title }: LineData) {
  return <>
    <Suspense fallback={<div className="eterx-answer-visual-plot" aria-hidden="true" />}>
      <AnswerLineChart items={items} title={title} />
    </Suspense>
    <details className="eterx-answer-details eterx-answer-visual-data">
      <summary>View data</summary>
      <table aria-label={title}>
        <thead><tr><th scope="col">Label</th><th scope="col">{unit || 'Value'}</th></tr></thead>
        <tbody>{items.map((item, index) => <tr key={index}>
          <th scope="row">{item.label}{item.detail && <small>{item.detail}</small>}</th>
          <td>{item.value === null ? 'No data' : item.display ?? formatVisualNumber(item.value)}</td>
        </tr>)}</tbody>
      </table>
    </details>
  </>;
}

export function AnswerVisual({ data }: { data: AnswerVisualData }) {
  const titleId = useId();
  const unit = 'unit' in data ? data.unit : undefined;
  const descriptionId = data.caption ? `${titleId}-description` : undefined;
  return <figure className="eterx-answer-visual" data-visual-type={data.type}
    aria-labelledby={titleId} aria-describedby={descriptionId}>
    <figcaption>
      <span id={titleId}>{data.title}</span>
      {unit && <small>{unit}</small>}
    </figcaption>
    {data.type === 'metrics' && <dl className="eterx-answer-visual-metrics">
      {data.items.map((item, index) => <div key={index}>
        <dt>{item.label}</dt>
        <dd className="eterx-answer-visual-metric">{typeof item.value === 'number' ? formatVisualNumber(item.value) : item.value}</dd>
        {item.detail && <dd className="eterx-answer-visual-metric-detail">{item.detail}</dd>}
      </div>)}
    </dl>}
    {data.type === 'bar' && <Bars {...data} />}
    {data.type === 'timeline' && <Timeline {...data} />}
    {data.type === 'line' && <Line {...data} />}
    {data.caption && <p className="eterx-answer-visual-caption" id={descriptionId}>{data.caption}</p>}
  </figure>;
}
