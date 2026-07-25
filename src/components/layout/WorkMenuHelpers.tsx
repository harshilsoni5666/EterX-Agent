import React from 'react';
import { ChevronDown } from 'lucide-react';

export const WorkMenuSectionButton = ({
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
    <span className="min-w-0 truncate">{title}</span>
    <span className="flex shrink-0 items-center gap-2">
      {meta !== undefined && meta !== '' && (
        <span className="eterx-work-menu-section-badge">{meta}</span>
      )}
      <ChevronDown className={`h-3.5 w-3.5 text-white/34 transition duration-150 group-hover:text-white/64 ${ open ? '' : '-rotate-90' }`} />
    </span>
  </button>
);

export const WorkMenuEmptyState = ({ label, detail }: { label: string; detail?: string }) => (
  <div className="eterx-work-menu-empty">
    <span className="min-w-0 flex-1 truncate text-[#A39B91] font-normal">{label}</span>
    {detail && <span className="hidden shrink-0 text-[#A39B91]/60 sm:inline">{detail}</span>}
  </div>
);

export const WorkMenuStatusIndicator = ({ status }: { status?: string }) => {
  switch (status) {
    case 'working':
    case 'spawning':
      return (
        <svg className="animate-spin h-3.5 w-3.5 text-white/80 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-label="Working">
          <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );
    case 'paused':
      return (
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-amber-400" aria-label="Paused">
          <svg viewBox="0 0 10 10" fill="currentColor" className="h-2.5 w-2.5">
            <rect x="1" y="1" width="3" height="8" rx="0.5" />
            <rect x="6" y="1" width="3" height="8" rx="0.5" />
          </svg>
        </span>
      );
    case 'completed':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400/80" aria-label="Completed" />;
    case 'error':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-red-400/80" aria-label="Error" />;
    case 'closed':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-white/15" aria-label="Closed" />;
    default:
      return <span className="h-2 w-2 shrink-0 rounded-full bg-white/20" aria-label="Idle" />;
  }
};
