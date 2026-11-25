import { Fragment } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, ChevronDown, ChevronRight, X } from 'lucide-react';
import { ProviderIconAsset } from '../ui/provider-icon';
import { dateOfDay, type ModelUsage, type ProviderUsage, type UsageDay, type UsageScope, type UsageTotals } from '../../lib/usage/summary';
import { Segments } from './usage-controls';
import { compactCount, exactCount, fullDate, metricMeasured, modelLabel, percent, pricedCount, providerLabel, sourceColors, sourceNames, usageValue, type UsageMetric } from './usage-format';
import styles from './usage-dashboard.module.css';

export type UsageGrouping = 'model' | 'provider' | 'day';
const groups = [['model', 'Model'], ['provider', 'Provider'], ['day', 'Day']] as const;
type SortKey = UsageMetric | 'calls' | 'input' | 'output' | 'day';
type Sort = { key: SortKey; descending: boolean };
export interface BreakdownPreferences {
  group?: UsageGrouping;
  expanded?: Record<string, boolean>;
  sorting?: { group: UsageGrouping; sort: Sort };
}
type BreakdownRow = ModelUsage | ProviderUsage | UsageDay;

function inspectKey(scope: UsageScope) {
  return JSON.stringify([scope.provider, scope.model]);
}

export function SelectedDay({ day, onClear }: { day: string; onClear: () => void }) {
  const label = fullDate.format(dateOfDay(day));
  return <button type="button" className={styles.dayChip} onClick={onClear} aria-label={'Clear day selection, ' + label}>
    <CalendarDays size={13} aria-hidden="true" />
    {label}
    <X size={13} aria-hidden="true" />
  </button>;
}

export function UsageBreakdown({ models, providers, days, totals, group, preferences, onPreferences, metric, day, onDay, onScope, detailed }: {
  models: ModelUsage[];
  providers: ProviderUsage[];
  days: UsageDay[];
  totals: UsageTotals;
  group: UsageGrouping;
  preferences: BreakdownPreferences;
  onPreferences: (preferences: BreakdownPreferences) => void;
  metric: UsageMetric;
  day: string | null;
  onDay: (day: string | null) => void;
  onScope: (scope: UsageScope, rowKey: string) => void;
  detailed: boolean;
}) {
  const { expanded = {}, sorting } = preferences;
  const sort: Sort = sorting?.group === group ? sorting.sort : { key: group === 'day' ? 'day' : metric, descending: true };
  const hasTokenColumns = detailed && group !== 'day';

  function compare(a: BreakdownRow, b: BreakdownRow) {
    let order: number;
    if (sort.key === 'day') order = 'day' in a && 'day' in b ? a.day.localeCompare(b.day) : 0;
    else {
      const left = sort.key === 'cost' ? pricedCount(a) : sort.key === 'tokens' ? a.measured
        : sort.key === 'input' ? a.inputReports : sort.key === 'output' ? a.outputReports : a.calls;
      const right = sort.key === 'cost' ? pricedCount(b) : sort.key === 'tokens' ? b.measured
        : sort.key === 'input' ? b.inputReports : sort.key === 'output' ? b.outputReports : b.calls;
      if (Boolean(left) !== Boolean(right)) return left ? -1 : 1;
      order = a[sort.key] - b[sort.key];
    }
    return (sort.descending ? -order : order) || b.calls - a.calls;
  }

  function sortHeader(key: SortKey, label: string) {
    const active = sort.key === key;
    return <th scope="col" aria-sort={active ? sort.descending ? 'descending' : 'ascending' : undefined}>
      <button type="button" className={styles.sortButton} onClick={() =>
        onPreferences({ sorting: { group, sort: { key, descending: !active || !sort.descending } } })}>
        {label}{active && (sort.descending ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)}
      </button>
    </th>;
  }

  function values(row: UsageTotals) {
    const priced = pricedCount(row);
    return <>
      <td className={styles.tableValue} title={row.unpriced ? exactCount(row.unpriced) + ' unpriced responses' : undefined}>
        {usageValue(row)}{priced > 0 && row.unpriced > 0 && <sup>*</sup>}
      </td>
      <td>{metricMeasured(row, metric) ? percent(row[metric], totals[metric]) : '—'}</td>
      <td title={row.measured ? exactCount(row.tokens) : undefined}>{row.measured ? compactCount(row.tokens) : '—'}</td>
      {hasTokenColumns && <>
        <td title={row.inputReports ? exactCount(row.input) : undefined}>{row.inputReports ? compactCount(row.input) : '—'}</td>
        <td title={row.outputReports ? exactCount(row.output) : undefined}>{row.outputReports ? compactCount(row.output) : '—'}</td>
      </>}
      <td>{exactCount(row.calls)}</td>
      <td className={styles.tableForward}><ChevronRight size={15} aria-hidden="true" /></td>
    </>;
  }

  function renderModel(row: ModelUsage, nested = false) {
    const scope = { provider: row.provider, model: row.model };
    const key = inspectKey(scope);
    const inspect = () => onScope(scope, key);
    return <tr key={key} className={styles.clickableRow} data-nested={nested || undefined} onClick={event => {
      if (!(event.target instanceof Element) || !event.target.closest('button')) inspect();
    }}>
      <th scope="row">
        <button type="button" className={styles.rowName} data-usage-row={key} onClick={inspect} title={row.model}>
          {nested
            ? <i className={styles.rowDot} style={{ background: sourceColors[row.source] }} />
            : <ProviderIconAsset provider={row.provider} />}
          <span><strong>{modelLabel(row.model)}</strong>
            {!nested && <small>{providerLabel(row.provider)} · {sourceNames[row.source]}</small>}</span>
        </button>
      </th>
      {values(row)}
    </tr>;
  }

  const recentDays = days.filter(row => row.calls).sort(compare);
  const sortedModels = [...models].sort(compare);
  const sortedProviders = [...providers].sort(compare);
  const modelsByProvider = new Map<string, ModelUsage[]>();
  for (const model of sortedModels) {
    const groupModels = modelsByProvider.get(model.provider);
    if (groupModels) groupModels.push(model);
    else modelsByProvider.set(model.provider, [model]);
  }
  const title = group === 'provider' ? 'Providers and models' : group === 'day' ? 'Daily breakdown' : 'Model activity';

  return <section className={styles.breakdown} aria-label={title}>
    <div className={styles.sectionHead}>
      <h2>{title}</h2>
      <Segments label="Group usage by" values={groups} selected={group} onSelect={group => onPreferences({ group })} />
    </div>
    {day && <div className={styles.activeFilter}><SelectedDay day={day} onClear={() => onDay(null)} /></div>}
    <div className={styles.tableScroll}>
      <table>
        <thead><tr>
          {group === 'day' ? sortHeader('day', 'Day') : <th scope="col">{group === 'provider' ? 'Provider / Model' : 'Model'}</th>}
          {sortHeader('cost', 'Value')}
          <th scope="col">{metric === 'cost' ? 'Cost share' : 'Token share'}</th>
          {sortHeader('tokens', 'Tokens')}
          {hasTokenColumns && <>{sortHeader('input', 'Input')}{sortHeader('output', 'Output')}</>}
          {sortHeader('calls', 'Responses')}
          <th scope="col"><span className={styles.srOnly}>Details</span></th>
        </tr></thead>
        <tbody>
          {group === 'model' && sortedModels.map(row => renderModel(row))}
          {group === 'provider' && sortedProviders.map((row, index) => {
            const models = modelsByProvider.get(row.provider) ?? [];
            const open = expanded[row.provider] ?? (detailed && index < 3);
            const scope = { provider: row.provider };
            const key = inspectKey(scope);
            const inspect = () => onScope(scope, key);
            return <Fragment key={key}>
              <tr className={styles.clickableRow} data-provider-row onClick={event => {
                if (!(event.target instanceof Element) || !event.target.closest('button')) inspect();
              }}>
                <th scope="row"><div className={styles.groupName}>
                  <button type="button" className={styles.disclose} aria-expanded={open}
                    aria-label={(open ? 'Hide' : 'Show') + ' models for ' + providerLabel(row.provider)}
                    onClick={() => onPreferences({ expanded: { ...expanded, [row.provider]: !open } })}>
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  <button type="button" className={styles.rowName} data-usage-row={key} onClick={inspect}>
                    <ProviderIconAsset provider={row.provider} />
                    <span><strong>{providerLabel(row.provider)}</strong><small>{models.length} {models.length === 1 ? 'model' : 'models'}</small></span>
                  </button>
                </div></th>
                {values(row)}
              </tr>
              {open && models.map(model => renderModel(model, true))}
            </Fragment>;
          })}
          {group === 'day' && recentDays.map(row => <tr key={row.day} className={styles.clickableRow} onClick={event => {
            if (!(event.target instanceof Element) || !event.target.closest('button')) onDay(day === row.day ? null : row.day);
          }}>
            <th scope="row"><button type="button" className={styles.rowName} aria-pressed={day === row.day}
              onClick={() => onDay(day === row.day ? null : row.day)}>
              <CalendarDays size={15} aria-hidden="true" /><strong>{fullDate.format(dateOfDay(row.day))}</strong>
            </button></th>
            {values(row)}
          </tr>)}
        </tbody>
      </table>
    </div>
    {!totals.calls && <p className={styles.emptyRows}>No responses match this selection.</p>}
    {totals.unpriced > 0 && pricedCount(totals) > 0 && <p className={styles.footnote}>* Value and cost share use priced responses.</p>}
  </section>;
}

export function RecentUsageDays({ days, day, onDay }: { days: UsageDay[]; day: string | null; onDay: (day: string | null) => void }) {
  const recent = days.filter(row => row.calls).slice(-5).reverse();
  return <section className={styles.subPanel} aria-label="Recent days">
    <div className={styles.sectionHead}><h2>Recent days</h2></div>
    {!!recent.length && <div className={styles.tableScroll}><table>
      <thead><tr><th scope="col">Day</th><th scope="col">Value</th><th scope="col">Responses</th></tr></thead>
      <tbody>{recent.map(row => <tr key={row.day}>
        <th scope="row"><button type="button" className={styles.rowName} aria-pressed={row.day === day} onClick={() => onDay(day === row.day ? null : row.day)}>
          {fullDate.format(dateOfDay(row.day))}</button></th>
        <td>{usageValue(row)}</td><td>{exactCount(row.calls)}</td>
      </tr>)}</tbody>
    </table></div>}
    {!recent.length && <p className={styles.emptyRows}>No recorded activity in this period.</p>}
  </section>;
}
