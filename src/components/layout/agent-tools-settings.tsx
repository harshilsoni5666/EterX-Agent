'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Users, Code2, Braces, MessageSquare, Search, RotateCcw, Check, Loader2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { resolveToolTraceIcon } from '../chat/agent-icons';
import { BUILTIN_AGENT_MODES, type BuiltinAgentId, type AgentToolSettingsResponse } from '../../lib/agent/builtin-agent-settings';
import { requestJson } from '../../lib/request-json';

const modeIcons: Record<BuiltinAgentId, LucideIcon> = { 'coding-lite': Code2, 'coding-heavy': Braces, general: Users, chat: MessageSquare };

export function AgentToolsSettings() {
  const [data, setData] = useState<AgentToolSettingsResponse | null>(null);
  const [agent, setAgent] = useState<BuiltinAgentId>('coding-lite');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const chain = useRef(Promise.resolve());
  const outstanding = useRef(0);
  const dataRef = useRef<AgentToolSettingsResponse | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const loadVersion = useRef(0);

  const install = (value: AgentToolSettingsResponse) => {
    dataRef.current = value;
    if (mounted.current) setData(value);
  };

  const load = async () => {
    const version = ++loadVersion.current;
    try {
      const response = await requestJson('/api/settings/agents', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load agent tools.');
      if (mounted.current && version === loadVersion.current && outstanding.current === 0) {
        install(body);
        setError('');
      }
    } catch (cause) {
      if (mounted.current && version === loadVersion.current && outstanding.current === 0) {
        setError(cause instanceof Error ? cause.message : 'Could not load agent tools.');
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => { if (outstanding.current === 0) void load(); };
    window.addEventListener('focus', refresh);
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('eterx-agent-tools');
      channel.current.onmessage = refresh;
    }
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', refresh);
      channel.current?.close();
      channel.current = null;
    };
  }, []);

  const save = (change: { agent: BuiltinAgentId; tool?: string; enabled?: boolean; reset?: boolean }) => {
    if (!dataRef.current) return;
    const current = dataRef.current;
    loadVersion.current += 1;
    install({ ...current, settings: { ...current.settings, [change.agent]: change.reset ? {} : {
      ...current.settings[change.agent], [change.tool!]: change.enabled!,
    } } });
    outstanding.current += 1;
    setPending(outstanding.current);
    setError('');
    // Serialize writes, including reset, so fast clicks cannot overwrite later choices.
    chain.current = chain.current.then(async () => {
      try {
        const response = await requestJson('/api/settings/agents', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not save agent tools.');
        if (outstanding.current === 1) install(body);
        channel.current?.postMessage({ changed: true });
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not save agent tools.');
        // Reconcile failed optimistic changes once the write queue has drained.
        if (outstanding.current === 1) {
          try {
            const response = await requestJson('/api/settings/agents', { cache: 'no-store' });
            if (response.ok) {
              const saved = await response.json();
              if (outstanding.current === 1) install(saved);
            }
          } catch { /* Keep the error and offer an explicit reload. */ }
        }
      } finally {
        outstanding.current -= 1;
        if (mounted.current) setPending(outstanding.current);
      }
    });
  };

  if (!data) return <div className="rounded-xl border border-white/[0.08] p-6 text-sm text-[#999]" role="status">
    {error ? <><p>{error}</p><button onClick={() => void load()} className="mt-3 text-[#D0D0D0] underline underline-offset-2">Try again</button></> : <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading agent tools…</span>}
  </div>;

  const mode = BUILTIN_AGENT_MODES.find(entry => entry.id === agent)!;
  const supported = data.tools.filter(tool => agent !== 'chat' || tool.name === 'web_search');
  const enabled = (name: string) => data.settings[agent]?.[name] ?? data.defaults[agent].includes(name);
  const visible = supported.filter(tool => `${tool.label} ${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()));
  const count = supported.filter(tool => enabled(tool.name)).length;
  const customized = Object.keys(data.settings[agent] || {}).length > 0;

  const AgentIcon = modeIcons[agent];

  return <div className="space-y-5">
    <p className="text-[13px] leading-5 text-[#969696]">Choose which tools each agent can use. Changes save automatically.</p>
    <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Choose agent">
      {BUILTIN_AGENT_MODES.map(entry => {
        const Icon = modeIcons[entry.id];
        return <button key={entry.id} type="button" aria-pressed={agent === entry.id} onClick={() => { setAgent(entry.id); setQuery(''); }}
          className={`group flex min-h-[62px] items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-[background,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 sm:px-4 ${agent === entry.id ? 'border-white/[0.18] bg-white/[0.055] text-[#E6E6E6] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]' : 'border-white/[0.075] bg-white/[0.018] text-[#A6A6A6] hover:border-white/[0.14] hover:bg-white/[0.04]'}`}>
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${agent === entry.id ? 'bg-white/[0.09] text-[#E1E1E1]' : 'bg-white/[0.045] text-[#888] group-hover:text-[#B0B0B0]'}`}><Icon className="h-[17px] w-[17px]" /></span><span className="text-[13px] font-medium">{entry.label}</span>
          {agent === entry.id && <Check className="ml-auto h-3.5 w-3.5 text-[#D5D5D5]" />}
        </button>;
      })}
    </div>
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.018] p-3.5 sm:px-4">
      <div className="flex min-w-0 items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.075] bg-white/[0.04] text-[#CECECE]"><AgentIcon className="h-[17px] w-[17px]" /></span><div className="min-w-0"><h3 className="flex flex-wrap items-center gap-x-2 text-[14px] font-semibold text-[#E9E9E9]">{mode.label} <span className="rounded-full border border-white/[0.08] bg-white/[0.035] px-2 py-0.5 text-[10px] font-medium text-[#AAA]">{count} of {supported.length} selected</span></h3><p className="mt-0.5 truncate text-[11px] text-[#898989]">{mode.description}</p></div></div>
      <button type="button" disabled={!customized || pending > 0} onClick={() => save({ agent, reset: true })} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.085] px-2.5 text-[11px] font-medium text-[#B7B7B7] transition-colors hover:border-white/[0.16] hover:bg-white/[0.045] disabled:cursor-not-allowed disabled:text-[#626262] disabled:opacity-70"><RotateCcw className="h-3.5 w-3.5" />Restore defaults</button>
    </div>
    <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#777]" /><input aria-label="Search agent tools" value={query} onChange={event => setQuery(event.target.value)} placeholder={`Search ${supported.length} tools`} className="h-10 w-full rounded-xl border border-white/[0.09] bg-[#171717] pl-9 pr-10 text-[12px] text-[#EEE] outline-none transition-colors placeholder:text-[#737373] focus:border-white/[0.24] focus:bg-[#191919]" />{query && <button onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[#888] hover:bg-white/[0.07] hover:text-[#DDD]"><X className="h-3.5 w-3.5" /></button>}</div>
    <div className="max-h-[min(48vh,460px)] overflow-y-auto overscroll-contain rounded-xl border border-white/[0.085] bg-[#151515] eterx-scrollbar">
      {[true, false].map(checked => {
        const entries = visible.filter(tool => enabled(tool.name) === checked);
        if (!entries.length) return null;
        return <section key={String(checked)} aria-label={checked ? 'Enabled tools' : 'Available tools'}>
          <h4 className="sticky top-0 z-[1] flex items-center gap-2 border-b border-white/[0.055] bg-[#191919]/95 px-3.5 py-2.5 text-[10px] font-medium text-[#929292] backdrop-blur-md"><span className={`h-1.5 w-1.5 rounded-full ${checked ? 'bg-[#B6B6B6]' : 'bg-[#616161]'}`} />{checked ? 'Enabled' : 'Available'}<span className="font-normal text-[#707070]">{entries.length}</span></h4>
          <div className="divide-y divide-white/[0.045]">
            {entries.map(tool => { const { Icon } = resolveToolTraceIcon({ toolName: tool.name }); return <label key={tool.name} className="group flex min-h-[57px] cursor-pointer items-center gap-3 px-3 sm:px-3.5 transition-colors hover:bg-white/[0.027]">
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${checked ? 'border-white/[0.085] bg-white/[0.055] text-[#CECECE]' : 'border-white/[0.055] bg-white/[0.025] text-[#777] group-hover:text-[#AAA]'}`}><Icon size={15} color={checked ? '#D0D0D0' : '#858585'} /></span>
              <span className="min-w-0 flex-1 py-2.5"><span className="block text-[12px] font-medium text-[#D9D9D9]">{tool.label}</span><span title={tool.description} className="mt-0.5 line-clamp-2 block text-[10px] leading-[16px] text-[#888]">{tool.description}</span></span>
              <input type="checkbox" checked={checked} onChange={event => save({ agent, tool: tool.name, enabled: event.target.checked })} aria-label={`${tool.label} for ${mode.label}`} className="h-[15px] w-[15px] shrink-0 cursor-pointer accent-[#D0D0D0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/50" />
            </label>; })}
          </div>
        </section>;
      })}
      {!visible.length && <p className="py-8 text-center text-[13px] text-[#888]">No tools match your search.</p>}
    </div>
    <div className="space-y-1.5 pt-0.5">
      <div role="status" aria-live="polite" className={`flex items-center gap-1.5 text-[10px] ${error ? 'text-red-300' : 'text-[#999]'}`}>
        {pending ? <><Loader2 className="h-3 w-3 animate-spin" />Saving changes…</> : error ? <>{error}<button className="ml-2 underline" onClick={() => void load()}>Reload saved settings</button></> : <><Check className="h-3 w-3 text-emerald-400" />All changes saved</>}
      </div>
      <p className="text-[10px] leading-[17px] text-[#777]">Tool access and guidance update automatically for future calls. Tools still follow your connection and permission settings.{agent === 'chat' ? ' Chat supports web search; other tools are available in General and Coding modes.' : ''}</p>
    </div>
  </div>;
}
