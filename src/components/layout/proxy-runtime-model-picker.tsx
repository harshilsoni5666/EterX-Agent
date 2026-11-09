'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { formatModelName } from '../../lib/agent/model-presentation';
import { modelEntryKey, parseModelEntryKey, type ModelSelectorEntry } from '../../lib/agent/model-selector-store';

export function ProxyChatModelPicker({ selection, entries, onSelect }: {
  selection: string;
  entries: ModelSelectorEntry[];
  onSelect: (selection: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 260, maxHeight: 280 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const active = parseModelEntryKey(selection);
  const name = active?.modelId ? formatModelName(active.modelId) : 'Select a model';

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const bounds = triggerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.min(280, window.innerWidth - 24);
      const above = bounds.top - 20;
      const below = window.innerHeight - bounds.bottom - 20;
      const onTop = above >= Math.min(280, below);
      const maxHeight = Math.max(48, Math.min(280, onTop ? above : below));
      setPosition({
        left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)),
        top: onTop ? bounds.top - 8 : bounds.bottom + 8,
        width,
        maxHeight,
      });
      if (menuRef.current) menuRef.current.style.transform = onTop ? 'translateY(-100%)' : '';
    };
    update();
    const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (selected || menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  return <div className="relative min-w-0" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button
      ref={triggerRef}
      type="button"
      aria-label={`Proxy model: ${name}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      title={active?.modelId || name}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      }}
      className="flex h-[32px] min-w-0 max-w-[160px] items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-white/70 hover:bg-white/[0.06] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/40"
    >
      <span className="min-w-0 truncate">{name}</span>
      <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
    </button>
    {open && createPortal(<div
      id={menuId}
      ref={menuRef}
      role="menu"
      aria-label="Proxy models"
      className="fixed z-[10020] overflow-y-auto rounded-xl border border-white/10 bg-[#252525] p-1.5 text-white shadow-xl"
      style={position}
      onKeyDown={event => {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') || []);
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
        if (event.key === 'Tab') setOpen(false);
      }}
    >
      {entries.length ? entries.map(entry => {
        const key = modelEntryKey(entry.provider, entry.modelId);
        const selected = key === selection;
        return <button
          key={key}
          type="button"
          role="menuitemradio"
          aria-checked={selected}
          title={entry.modelId}
          onClick={() => { onSelect(key); close(); }}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-white/[0.08] focus:bg-white/[0.08] focus:outline-hidden"
        >
          <span className="min-w-0 flex-1">
            <span className="block break-words text-[12px]">{formatModelName(entry.modelId)}</span>
            <span className="block text-[10px] text-white/45">{entry.provider}</span>
          </span>
          {selected && <Check className="h-3.5 w-3.5 shrink-0 text-white/75" />}
        </button>;
      }) : <p className="px-2.5 py-2 text-[12px] text-white/60">Add a model in Settings to use Proxy.</p>}
    </div>, document.body)}
  </div>;
}

export function ProxyRuntimeModelLabel({ chatSelection, entries }: {
  chatSelection: string; entries: ModelSelectorEntry[];
}) {
  const active = entries.find(entry => modelEntryKey(entry.provider, entry.modelId) === chatSelection);
  const modelName = active?.modelId || parseModelEntryKey(chatSelection)?.modelId || '';
  return <div className="eterx-proxy-group-item flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left">
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-normal opacity-55">Model</span>
        <span className="mt-0.5 block break-words [overflow-wrap:anywhere] text-[12px] leading-4 font-medium" title={modelName}>{modelName ? formatModelName(modelName) : 'Select a model in chat'}</span>
      </span>
  </div>;
}
