'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatModelName } from '../../lib/agent/model-presentation';
import {
  activityDate, activityDayDistance, activityDayKey, mostUsedActivityValue,
  type ProfileActivityStats,
} from '../../lib/profile-activity';
import styles from './settings-profile.module.css';

type ActivityMode = 'daily' | 'weekly' | 'cumulative';
type ActivityCell = { key: string; date: Date; end: Date; value: number; available: boolean };
const MODES: ActivityMode[] = ['daily', 'weekly', 'cumulative'];
const REASONING_LABELS: Record<string, string> = {
  off: 'Off', none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra',
};
const displayDate = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const compactTokens = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const monthIndex = (date: Date) => date.getFullYear() * 12 + date.getMonth();

function useCalendarToday() {
  const [today, setToday] = useState(() => activityDayKey(new Date()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      const now = new Date();
      setToday(activityDayKey(now));
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(refresh, Math.max(1000, tomorrow.getTime() - now.getTime() + 100));
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return today;
}

export function SettingsProfile({ name, onNameChange, stats, loading, error }: {
  name: string;
  onNameChange: (name: string) => void;
  stats: ProfileActivityStats;
  loading: boolean;
  error: string;
}) {
  const todayKey = useCalendarToday();
  const today = useMemo(() => activityDate(todayKey), [todayKey]);
  const currentMonth = monthIndex(today);
  const [mode, setMode] = useState<ActivityMode>('daily');
  // Null follows the live month; browsing history stays on the selected month.
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [monthCount, setMonthCount] = useState(12);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusedKey, setFocusedKey] = useState('');
  const [tooltip, setTooltip] = useState<{ cell: ActivityCell; x: number; y: number; below: boolean } | null>(null);
  const tooltipId = useId();
  const headingId = useId();
  const modeDescriptionId = useId();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const resize = () => setMonthCount(root.clientWidth >= 720 ? 12 : root.clientWidth >= 460 ? 6 : 3);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const history = useMemo(() => Object.keys(stats.daily).filter(key => stats.daily[key] > 0 && key <= todayKey).sort(), [stats.daily, todayKey]);
  const earliestMonth = history.length ? monthIndex(activityDate(history[0])) : currentMonth;
  const minimumEndMonth = Math.min(currentMonth, earliestMonth + monthCount - 1);
  const endMonth = Math.max(minimumEndMonth, Math.min(currentMonth, selectedMonth ?? currentMonth));
  const startMonth = endMonth - monthCount + 1;
  const canGoBack = endMonth > minimumEndMonth;
  const canGoForward = endMonth < currentMonth;

  const calendar = useMemo(() => {
    const start = new Date(Math.floor(startMonth / 12), startMonth % 12, 1);
    const end = endMonth === currentMonth ? today : new Date(Math.floor(endMonth / 12), endMonth % 12 + 1, 0);
    const firstSunday = new Date(start);
    firstSunday.setDate(start.getDate() - start.getDay());
    const columns = Math.ceil((activityDayDistance(firstSunday, end) + 1) / 7);
    const startKey = activityDayKey(start);
    const endKey = activityDayKey(end);
    let runningTotal = Object.entries(stats.daily).reduce((sum, [key, value]) => key < startKey ? sum + value : sum, 0);
    let periodTotal = 0;
    const daily: ActivityCell[] = Array.from({ length: columns * 7 }, (_, index) => {
      const date = new Date(firstSunday);
      date.setDate(firstSunday.getDate() + index);
      const key = activityDayKey(date);
      const available = key >= startKey && key <= endKey;
      const value = available ? stats.daily[key] || 0 : 0;
      if (available) { runningTotal += value; periodTotal += value; }
      return { key, date, end: date, value: mode === 'cumulative' ? runningTotal : value, available };
    });
    const weekly: ActivityCell[] = Array.from({ length: columns }, (_, column) => {
      const date = new Date(firstSunday);
      date.setDate(firstSunday.getDate() + column * 7);
      const weekEnd = new Date(date);
      weekEnd.setDate(date.getDate() + 6);
      const visibleStart = date < start ? start : date;
      const visibleEnd = weekEnd > end ? end : weekEnd;
      const value = daily.slice(column * 7, column * 7 + 7).reduce((sum, cell) => sum + (cell.available ? cell.value : 0), 0);
      return { key: activityDayKey(date), date: visibleStart, end: visibleEnd, value, available: true };
    });
    const months = Array.from({ length: monthCount }, (_, index) => {
      const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
      return { key: activityDayKey(date), date, column: Math.floor(activityDayDistance(firstSunday, date) / 7) };
    });
    return { start, end, columns, months, cells: mode === 'weekly' ? weekly : daily, periodTotal };
  }, [currentMonth, endMonth, mode, monthCount, startMonth, stats.daily, today]);

  const maximum = Math.max(1, ...calendar.cells.filter(cell => cell.available).map(cell => cell.value));
  const availableCells = calendar.cells.filter(cell => cell.available);
  const activeKey = availableCells.some(cell => cell.key === focusedKey) ? focusedKey : availableCells[availableCells.length - 1]?.key;
  const topModel = useMemo(() => mostUsedActivityValue(stats.models), [stats.models]);
  const topReasoning = useMemo(() => mostUsedActivityValue(stats.reasoning), [stats.reasoning]);
  const periodLabel = `${calendar.start.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })} – ${calendar.end.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;

  useEffect(() => { setTooltip(null); }, [mode, endMonth, monthCount, todayKey]);
  useEffect(() => {
    // Keep the hovered receipt current without closing the popup on a live refresh.
    setTooltip(previous => {
      if (!previous) return null;
      const cell = calendar.cells.find(item => item.available && item.key === previous.cell.key);
      return cell ? { ...previous, cell } : null;
    });
  }, [calendar.cells]);
  useEffect(() => {
    const dismiss = () => setTooltip(null);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, []);

  const describeCell = (cell: ActivityCell) => mode === 'weekly'
    ? `${cell.value.toLocaleString()} tokens, ${displayDate(cell.date)} – ${displayDate(cell.end)}`
    : `${cell.value.toLocaleString()} ${mode === 'cumulative' ? 'total tokens through' : 'tokens on'} ${displayDate(cell.date)}`;

  const tooltipDate = (date: Date) => date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });

  const showTooltip = (element: HTMLElement, cell: ActivityCell) => {
    const rect = element.getBoundingClientRect();
    const below = rect.top < 90;
    setTooltip({ cell, x: Math.max(128, Math.min(window.innerWidth - 128, rect.left + rect.width / 2)), y: below ? rect.bottom + 10 : rect.top - 10, below });
  };

  const handleCellKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, cell: ActivityCell) => {
    if (event.key === 'Escape') { setTooltip(null); event.stopPropagation(); return; }
    const index = availableCells.findIndex(item => item.key === cell.key);
    const columnStep = mode === 'weekly' ? 1 : 7;
    const offsets: Record<string, number> = { ArrowLeft: -columnStep, ArrowRight: columnStep, ArrowUp: -1, ArrowDown: 1 };
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? availableCells.length - 1
      : event.key in offsets ? Math.max(0, Math.min(availableCells.length - 1, index + offsets[event.key])) : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextKey = availableCells[nextIndex]?.key;
    if (nextKey) {
      setFocusedKey(nextKey);
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${nextKey}"]`)?.focus();
    }
  };

  return <div ref={rootRef} className={styles.root}>
    <div className={styles.identity}>
      <div className={styles.avatar} aria-hidden="true">{name.trim().charAt(0).toUpperCase() || 'U'}</div>
      <div className={styles.identityText}>
        <input aria-label="Profile name" autoComplete="name" placeholder="Your name" value={name} onChange={event => onNameChange(event.target.value)} className={styles.name} />
        <span className={styles.identityCaption}>Your activity, at a glance</span>
      </div>
    </div>

    <section className={styles.activity} aria-labelledby={headingId} aria-busy={loading}>
      <div className={styles.headingRow}>
        <h3 id={headingId}>Token activity</h3>
        <div className={styles.controls}>
          <div className={styles.modes} role="group" aria-label="Token activity view">
            {MODES.map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}
          </div>
          {(canGoBack || canGoForward) && <div className={styles.navigation} role="group" aria-label="Activity history">
            <button type="button" aria-label="Show previous month" title="Previous month" disabled={!canGoBack} onClick={() => setSelectedMonth(endMonth - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
            <button type="button" aria-label="Show next month" title="Next month" disabled={!canGoForward} onClick={() => setSelectedMonth(endMonth + 1 >= currentMonth ? null : endMonth + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
          </div>}
        </div>
      </div>
      <div className={styles.periodRow}>
        <span aria-live="polite">{periodLabel}</span>
        {canGoForward && <button type="button" onClick={() => setSelectedMonth(null)}>Back to today</button>}
      </div>
      <p id={modeDescriptionId} className={styles.srOnly}>{mode === 'weekly' ? 'Each bar shows tokens in one calendar week within the displayed period.' : mode === 'cumulative' ? 'Each square shows all recorded tokens through that date, including earlier months.' : 'Each square shows tokens used that day. Columns are weeks, from Sunday to Saturday.'} Use arrow keys to explore dates.</p>
      <div ref={gridRef} role="group" aria-label={`${mode} token activity, ${periodLabel}`} aria-describedby={modeDescriptionId}
        className={`${styles.grid} ${mode === 'weekly' ? styles.weekly : ''}`} style={{ '--activity-columns': calendar.columns } as React.CSSProperties}
        onMouseLeave={() => setTooltip(null)}>
        {calendar.cells.map(cell => {
          if (!cell.available) return <span key={cell.key} className={styles.placeholder} aria-hidden="true" />;
          const level = cell.value <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(cell.value / maximum * 4)));
          return <button key={cell.key} type="button" data-day={cell.key} data-level={level} tabIndex={cell.key === activeKey ? 0 : -1}
            className={styles.cell} aria-label={describeCell(cell)} aria-describedby={tooltip?.cell.key === cell.key ? tooltipId : undefined}
            style={mode === 'weekly' ? { '--bar-height': `${cell.value > 0 ? Math.max(5, cell.value / maximum * 100) : 0}%` } as React.CSSProperties : undefined}
            onMouseEnter={event => showTooltip(event.currentTarget, cell)} onFocus={event => { setFocusedKey(cell.key); showTooltip(event.currentTarget, cell); }}
            onBlur={() => setTooltip(null)} onClick={event => showTooltip(event.currentTarget, cell)} onKeyDown={event => handleCellKeyDown(event, cell)} />;
        })}
      </div>
      <div className={styles.months} style={{ '--activity-columns': calendar.columns } as React.CSSProperties} aria-hidden="true">
        {calendar.months.map((month, index) => <span key={month.key} title={month.date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          style={{ gridColumn: `${month.column + 1} / ${calendar.months[index + 1] ? calendar.months[index + 1].column + 1 : -1}` }}>
          {month.date.toLocaleDateString(undefined, { month: 'short' })}
        </span>)}
      </div>
      <div className={styles.chartFooter}>
        <span role="status">{loading ? 'Loading activity…' : error ? error : history.length ? `${compactTokens(calendar.periodTotal)} tokens in this period` : 'Your activity will appear here after your first model response.'}</span>
        <div className={styles.legend} aria-label="Color intensity from fewer to more tokens"><span>Less</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} aria-hidden="true" />)}<span>More</span></div>
      </div>
    </section>

    <section className={styles.insights} aria-label="Activity insights" aria-busy={loading}>
      <div className={styles.headingRow}><h3>Insights</h3><span className={styles.allTime}>All time</span></div>
      <dl>
        <div><dt title="Share of recorded model calls, excluding background titles">Most used model</dt><dd title={topModel?.name}>{loading ? 'Loading…' : topModel ? <>{formatModelName(topModel.name)}<span className={styles.share}> · {topModel.percent}%</span></> : 'No recorded usage'}</dd></div>
        <div><dt title="Share of model calls with a recorded reasoning level">Most used reasoning</dt><dd>{loading ? 'Loading…' : topReasoning ? <>{REASONING_LABELS[topReasoning.name] || topReasoning.name}<span className={styles.share}> · {topReasoning.percent}%</span></> : 'Not recorded yet'}</dd></div>
        <div><dt title="Distinct skills successfully loaded">Skills explored</dt><dd>{loading ? '—' : stats.skillsExplored.toLocaleString()}</dd></div>
        <div><dt title="Successful skill loads across saved chats">Total skills used</dt><dd>{loading ? '—' : stats.totalSkillsUsed.toLocaleString()}</dd></div>
      </dl>
    </section>

    {tooltip && createPortal(<div id={tooltipId} role="tooltip" className={`${styles.root} ${styles.tooltip}`}
      style={{ left: tooltip.x, top: tooltip.y, transform: `translate(-50%, ${tooltip.below ? '0' : '-100%'})` }}>
      <span>{mode === 'weekly' ? `${tooltipDate(tooltip.cell.date)} – ${tooltipDate(tooltip.cell.end)}` : `${mode === 'cumulative' ? 'Through ' : ''}${tooltipDate(tooltip.cell.date)}`}</span>
      <strong>{new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tooltip.cell.value)} {mode === 'cumulative' ? 'total tokens' : 'tokens'}</strong>
    </div>, document.body)}
  </div>;
}
