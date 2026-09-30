import React from 'react';
import { ChevronDown } from 'lucide-react';

export const WorkMenuSectionButton = React.memo(({
  title,
  meta,
  open,
  onClick,
  onMouseEnter,
}: {
  title: string;
  meta?: string | number;
  open: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: () => void;
}) => (
  <button
    type="button"
    aria-expanded={open}
    onMouseEnter={onMouseEnter}
    onClick={onClick}
    className="eterx-work-menu-section-button group"
  >
    <span className="min-w-0 truncate text-[12.5px] font-semibold text-neutral-800 dark:text-white/90 group-hover:text-neutral-950 dark:group-hover:text-white transition-colors">
      {title}
    </span>
    <span className="flex shrink-0 items-center gap-1.5">
      {meta !== undefined && meta !== '' && (
        <span className="eterx-work-menu-section-badge">{meta}</span>
      )}
      <ChevronDown className={`h-3.5 w-3.5 opacity-40 group-hover:opacity-80 transition-transform duration-200 ${ open ? '' : '-rotate-90' }`} />
    </span>
  </button>
));

WorkMenuSectionButton.displayName = 'WorkMenuSectionButton';

export const WorkMenuEmptyState = React.memo(({ label, detail }: { label: string; detail?: string }) => (
  <div className="eterx-work-menu-empty">
    <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400 font-normal">{label}</span>
    {detail && <span className="hidden shrink-0 text-neutral-400 dark:text-neutral-500 sm:inline">{detail}</span>}
  </div>
));

WorkMenuEmptyState.displayName = 'WorkMenuEmptyState';

export const WorkMenuStatusBadge = React.memo(({ status }: { status?: string }) => {
  const s = String(status || 'idle').toLowerCase();
  if (['working', 'running', 'spawning'].includes(s)) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
        <svg className="animate-spin h-2.5 w-2.5 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span className="capitalize">{status}</span>
      </span>
    );
  }
  if (['error', 'failed'].includes(s)) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0" />
        <span>Error</span>
      </span>
    );
  }
  if (['paused', 'waiting', 'planned', 'pending'].includes(s)) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
        <span className="capitalize">{status}</span>
      </span>
    );
  }
  if (['completed', 'done'].includes(s)) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
        <span>Done</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-black/[0.04] dark:bg-white/[0.06] text-neutral-500 dark:text-neutral-400 border border-black/[0.06] dark:border-white/[0.08]">
      <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 dark:bg-neutral-500 shrink-0" />
      <span className="capitalize">{status || 'Idle'}</span>
    </span>
  );
});

WorkMenuStatusBadge.displayName = 'WorkMenuStatusBadge';

export const WorkMenuStatusIndicator = React.memo(({ status }: { status?: string }) => {
  switch (status) {
    case 'working':
    case 'running':
    case 'spawning':
      return (
        <svg className="animate-spin h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-label="Working">
          <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );
    case 'paused':
    case 'waiting':
    case 'planned':
    case 'pending':
      return (
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-amber-500" aria-label="Paused">
          <svg viewBox="0 0 10 10" fill="currentColor" className="h-2.5 w-2.5">
            <rect x="1" y="1" width="3" height="8" rx="0.5" />
            <rect x="6" y="1" width="3" height="8" rx="0.5" />
          </svg>
        </span>
      );
    case 'completed':
    case 'done':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-label="Completed" />;
    case 'error':
    case 'failed':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-label="Error" />;
    case 'closed':
    case 'cancelled':
    case 'stopped':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-black/15 dark:bg-white/15" aria-label="Closed" />;
    default:
      return <span className="h-2 w-2 shrink-0 rounded-full bg-black/20 dark:bg-white/20" aria-label="Idle" />;
  }
});

WorkMenuStatusIndicator.displayName = 'WorkMenuStatusIndicator';
