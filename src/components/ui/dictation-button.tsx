'use client';

import { PremiumMic } from './premium-icons';
import { Tooltip } from './tooltip';
import type { DictationPhase } from '../../lib/microphone';

export function DictationButton({ phase, onClick, compact = false }: {
  phase: DictationPhase;
  onClick: () => void;
  compact?: boolean;
}) {
  const active = phase === 'starting' || phase === 'listening';
  const finishing = phase === 'finishing';
  const label = finishing ? 'Finishing transcription'
    : phase === 'starting' ? 'Preparing microphone — click to cancel'
    : active ? 'Stop voice dictation' : 'Start voice dictation';

  return (
    <Tooltip text={label} side="top">
      <button
        type="button"
        onClick={onClick}
        disabled={finishing}
        aria-label={label}
        aria-pressed={active}
        aria-busy={finishing}
        data-active={active ? 'true' : undefined}
        data-dictation-phase={phase}
        className={`eterx-control-button eterx-composer-dictation-button shrink-0 flex items-center justify-center rounded-full border border-transparent transition-colors duration-150 relative group text-current hover:bg-white/[0.065] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-wait ${compact ? 'h-7 w-7' : 'h-[38px] w-[38px]'}`}
        style={active ? { backgroundColor: 'var(--muted, rgba(128,128,128,0.16))' } : undefined}
      >
        {finishing ? (
          <span
            aria-hidden="true"
            className={`${compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'} animate-spin rounded-full border-2 border-current border-r-transparent`}
          />
        ) : (
          <PremiumMic aria-hidden="true" className={`eterx-composer-control-icon ${compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'} transition-transform duration-150 group-hover:scale-[1.04] ${active ? 'scale-[1.04]' : ''}`} strokeWidth={1.85} />
        )}
      </button>
    </Tooltip>
  );
}
