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
  const [position, setPosition] = useState({ left: 0, top: 0, width: 260, maxHeight: 280, transform: '' });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const active = parseModelEntryKey(selection);
  const name = active?.modelId ? formatModelName(active.modelId) : 'Select a model';

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bounds = triggerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      // A portaled menu still belongs to its proxy window. Keep it inside
      // that window's horizontal lane when both conversations are open.
      const owner = triggerRef.current?.closest('.eterx-proxy-chat-window')?.getBoundingClientRect();
      const left = Math.max(12, (owner?.left ?? 4) + 8);
      const right = Math.min(window.innerWidth - 12, (owner?.right ?? window.innerWidth - 4) - 8);
      const top = Math.max(12, (owner?.top ?? 4) + 8);
      const bottom = Math.min(window.innerHeight - 12, (owner?.bottom ?? window.innerHeight - 4) - 8);
      const width = Math.max(1, Math.min(280, right - left));
      const above = bounds.top - top - 6;
      const below = bottom - bounds.bottom - 6;
      const onTop = above >= Math.min(280, below);
      const next = {
        left: Math.max(left, Math.min(bounds.right - width, right - width)),
        top: onTop ? bounds.top - 6 : bounds.bottom + 6,
        width,
        maxHeight: Math.max(1, Math.min(280, onTop ? above : below)),
        transform: onTop ? 'translateY(-100%)' : '',
      };
      setPosition(previous => previous.left === next.left && previous.top === next.top
        && previous.width === next.width && previous.maxHeight === next.maxHeight
        && previous.transform === next.transform ? previous : next);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (selected || menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus({ preventScroll: true });
    if (selected && menuRef.current) {
      menuRef.current.scrollTop = Math.max(0, selected.offsetTop - (menuRef.current.clientHeight - selected.offsetHeight) / 2);
    }
    const observer = new ResizeObserver(schedule);
    if (triggerRef.current) observer.observe(triggerRef.current);
    const owner = triggerRef.current?.closest('.eterx-proxy-chat-window');
    if (owner) observer.observe(owner);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('pointermove', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('pointermove', schedule);
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

  const close = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  return <div className="eterx-proxy-model-picker" onKeyDown={event => {
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
      className="eterx-proxy-model-trigger"
    >
      <span className="min-w-0 truncate">{name}</span>
      <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
    </button>
    {open && createPortal(<div
      id={menuId}
      ref={menuRef}
      role="menu"
      aria-label="Proxy models"
      className="eterx-proxy-chat-model-menu eterx-scrollbar"
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
        if (event.key === 'Tab') close();
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
        >
          <span className="min-w-0 flex-1">
            <span className="block [overflow-wrap:anywhere] text-[12px]">{formatModelName(entry.modelId)}</span>
            <span className="eterx-proxy-model-provider">{entry.provider}</span>
          </span>
          {selected && <Check className="h-3.5 w-3.5 shrink-0 opacity-75" />}
        </button>;
      }) : <p className="px-2.5 py-2 text-[12px] text-[var(--muted-foreground)]">Add a model in Settings to use Proxy.</p>}
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
