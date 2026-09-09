import { formatModelName } from '../../lib/agent/model-presentation';
import { Check, ChevronDown } from 'lucide-react';
import { useRef } from 'react';
import { AdaptiveMenu } from '../ui/adaptive-menu';
import { AUTO_MODEL_SELECTION, modelEntryKey, type ModelSelectorEntry } from '../../lib/agent/model-selector-store';

export function ProxyRuntimeModelPicker({ selection, chatSelection, entries, open, onToggle, onSelect }: {
  selection: string; chatSelection: string; entries: ModelSelectorEntry[];
  open: boolean; onToggle: () => void; onSelect: (selection: string) => void;
}) {
  const followsChat = selection === AUTO_MODEL_SELECTION;
  const effective = followsChat ? chatSelection : selection;
  const active = entries.find(entry => modelEntryKey(entry.provider, entry.modelId) === effective);
  const wrapperRef = useRef<HTMLDivElement>(null);
  return <div ref={wrapperRef} className="relative" onKeyDown={event => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    onToggle();
    wrapperRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }}>
    <button type="button" onClick={onToggle} aria-expanded={open} aria-haspopup="dialog"
      className="eterx-proxy-group-item flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left">
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-normal opacity-55">{followsChat ? 'Supervisor · follows chat' : 'Supervisor model'}</span>
        <span className="mt-0.5 block break-words [overflow-wrap:anywhere] text-[12px] leading-4 font-medium" title={active?.modelId || effective}>{(active ? formatModelName(active.modelId) : '') || (followsChat ? 'Select a chat model' : 'Selected model unavailable')}</span>
      </span>
      <ChevronDown className={`h-3.5 w-3.5 shrink-0 opacity-50 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
    </button>
    {open && <AdaptiveMenu preferredSide="bottom" heightLimit={300}
      className="eterx-proxy-runtime-model-menu eterx-proxy-inset-menu absolute right-0 top-full z-[140] flex w-[260px] flex-col overflow-hidden rounded-[14px] border border-[var(--border)] p-1.5"
      role="dialog" aria-label="Proxy model selection">
      <div className="eterx-agent-menu-scroll min-h-0 overflow-y-auto overscroll-contain">
        <button type="button" autoFocus={followsChat} onClick={() => onSelect(AUTO_MODEL_SELECTION)} aria-pressed={followsChat}
          className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-[12px]">
          <span className="min-w-0 flex-1">Follow chat model</span>{followsChat && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        </button>
        {entries.map(entry => {
          const key = modelEntryKey(entry.provider, entry.modelId);
          return <button key={key} type="button" autoFocus={selection === key} onClick={() => onSelect(key)} aria-pressed={selection === key}
            className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left">
            <span className="min-w-0 flex-1"><span className="block break-words [overflow-wrap:anywhere] text-[12px]">{formatModelName(entry.modelId)}</span><span className="text-[10px] opacity-50">{entry.provider}</span></span>
            {selection === key && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          </button>;
        })}
      </div>
    </AdaptiveMenu>}
  </div>;
}
