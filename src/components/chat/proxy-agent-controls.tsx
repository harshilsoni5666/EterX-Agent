'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, MessageSquare, Pause, Play, X } from 'lucide-react';
import type { ProxyControlSettings } from '../../lib/proxy-chat-client';
import type { ModelSelectorEntry } from '../../lib/agent/model-selector-store';
import { ProxyRuntimeModelLabel } from '../layout/proxy-runtime-model-picker';

export type ProxyAgentControlState = {
  enabled: boolean;
  paused: boolean;
  intervention: ProxyControlSettings['intervention'];
  modelSelection: string;
  modelEntries: ModelSelectorEntry[];
  onPauseToggle: () => Promise<void>;
  onInterventionChange: (level: ProxyControlSettings['intervention']) => Promise<void>;
  onModelSelectionChange: (selection: string) => Promise<void>;
};

export function ProxyAgentControls({ paused, intervention, modelSelection, modelEntries, onPauseToggle, onInterventionChange, onTalk, chatOpen, children }: Omit<ProxyAgentControlState, 'enabled' | 'onModelSelectionChange'> & {
  onTalk: () => void;
  chatOpen: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [interventionOpen, setInterventionOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const dock = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const levelsId = useId();
  const requestPending = useRef(false);

  useEffect(() => {
    if (!open && !interventionOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !dock.current?.contains(event.target)) {
        setOpen(false);
        setInterventionOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, interventionOpen]);

  const change = async (action: () => Promise<void>) => {
    if (requestPending.current) return;
    requestPending.current = true;
    setPending(true);
    setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not update Proxy. Please try again.'); setOpen(true); }
    finally { requestPending.current = false; setPending(false); }
  };
  const talk = () => { setOpen(false); setInterventionOpen(false); onTalk(); };

  return <div ref={dock} className="eterx-proxy-dock" data-controls-open={open ? 'true' : 'false'} onKeyDown={event => {
    if (event.key !== 'Escape' || (!open && !interventionOpen)) return;
    event.stopPropagation();
    if (interventionOpen) setInterventionOpen(false);
    else { setOpen(false); trigger.current?.focus(); }
  }}>
    <div className="eterx-proxy-compact-bar">
      <button ref={trigger} type="button" className="eterx-proxy-compact-title" aria-label="Proxy settings" aria-expanded={open} aria-controls={cardId} onClick={() => { setOpen(value => !value); setInterventionOpen(false); }}>
        <span className={`eterx-proxy-status-dot ${paused ? 'is-paused' : ''}`} />
        <span>Proxy settings</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      <button type="button" disabled={pending} aria-label={paused ? 'Resume Proxy' : 'Pause Proxy'} title={paused ? 'Resume Proxy' : 'Pause Proxy'} onClick={() => void change(onPauseToggle)}>
        {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
      </button>
      <button type="button" aria-label="Talk with Proxy" title="Talk with Proxy" aria-pressed={chatOpen} onClick={talk}><MessageSquare className="h-3.5 w-3.5" /></button>
    </div>
    <div id={cardId} className="eterx-proxy-card pointer-events-auto flex h-fit flex-col gap-2 rounded-[20px] border border-white/[0.10] bg-[#252525]/95 px-3 pb-3 pt-3 shadow-none backdrop-blur-xl select-none eterx-scrollbar">
      <div className="pt-1 pb-1 shrink-0 flex items-center justify-center w-full"><span className="eterx-proxy-title text-[14px] font-semibold tracking-[0.02em] text-white/95 text-center">Proxy-Agent</span></div>
      <div className="eterx-proxy-group-block w-full min-w-0 flex flex-col rounded-2xl border border-white/[0.08] bg-white/[0.03] shrink-0">
        <button type="button" disabled={pending} aria-pressed={paused} title={paused ? 'Resume supervision from current progress' : 'Pause supervision; Autonomous mode stays on'} onClick={() => void change(onPauseToggle)} className="eterx-proxy-group-item w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-t-2xl text-[12px] font-medium text-white/85 hover:bg-white/[0.06] hover:text-white transition-colors shrink-0">
          {paused ? <Play className="h-3.5 w-3.5 shrink-0" /> : <Pause className="h-3.5 w-3.5 shrink-0" />}<span>{paused ? 'Resume Proxy' : 'Pause Proxy'}</span>
        </button>
        <div className="h-px w-full eterx-proxy-group-divider" />
        <ProxyRuntimeModelLabel chatSelection={modelSelection} entries={modelEntries} />
        <div className="h-px w-full eterx-proxy-group-divider" />
        <div className="min-w-0">
          <button type="button" aria-expanded={interventionOpen} aria-controls={levelsId} aria-label={`Intervention level: ${intervention}`} onClick={() => setInterventionOpen(value => !value)} className="eterx-proxy-group-item w-full min-w-0 flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-[12px] font-medium text-white/85 hover:bg-white/[0.06] transition-colors">
            <span className="opacity-60">Intervention</span><span className="flex items-center gap-1.5 capitalize">{intervention}<ChevronRight className={`h-3.5 w-3.5 shrink-0 ${interventionOpen ? 'rotate-90' : ''}`} /></span>
          </button>
          <div id={levelsId} hidden={!interventionOpen} className="px-1.5 pb-1.5">
            <div className="eterx-proxy-popout rounded-2xl border border-white/[0.08] bg-[#252525] p-1.5 flex flex-col gap-1 w-full">
              {(['minimal', 'normal', 'high'] as const).map(level => <button key={level} type="button" disabled={pending} aria-pressed={intervention === level} onClick={() => { setInterventionOpen(false); void change(() => onInterventionChange(level)); }} className={`eterx-proxy-popout-item w-full flex flex-col items-start rounded-xl px-2.5 py-1 text-left text-[12px] transition-colors ${intervention === level ? 'eterx-proxy-popout-item-active bg-white/[0.08] text-white' : 'text-white/50 hover:bg-white/[0.04] hover:text-white/85'}`}>
                <span className="font-medium capitalize">{level}</span><span className="text-[9.5px] opacity-60">{level === 'minimal' ? 'Observe more' : level === 'normal' ? 'Balanced' : 'Best Efforts'}</span>
              </button>)}
            </div>
          </div>
        </div>
        <div className="h-px w-full eterx-proxy-group-divider" />
        <button type="button" aria-pressed={chatOpen} onClick={talk} className={`eterx-proxy-group-item w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-[12px] font-medium transition-colors rounded-b-2xl shrink-0 ${chatOpen ? 'bg-white/[0.08] text-white' : 'text-white/80 hover:bg-white/[0.06] hover:text-white'}`}><MessageSquare className="h-3.5 w-3.5 shrink-0" /><span>Talk with Proxy</span></button>
      </div>
      {error && <div role="alert" className="flex min-w-0 items-start gap-2 text-[11px] text-red-400"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span><button type="button" aria-label="Dismiss Proxy error" onClick={() => setError('')}><X className="h-3.5 w-3.5" /></button></div>}
    </div>
    {children}
  </div>;
}
