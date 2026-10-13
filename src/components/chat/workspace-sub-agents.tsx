'use client';

import { useId, useMemo, useState, useRef, useEffect, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, ChevronRight, Circle, CircleAlert, Network, Pause, Search, Square, X } from 'lucide-react';
import { agentIdentitiesOverlap } from '../../lib/chat-feed-lifecycle';
import { EterxLogo, SubAgentIdentityIcon } from './agent-icons';

type WorkspaceAgent = {
  id?: string;
  name: string;
  subAgentId?: string;
  subAgentChatId?: string;
  status?: string;
  task?: string;
  currentAction?: string;
  unreadCount?: number;
  parentAgentId?: string;
  parentAgentName?: string;
  depth?: number;
};

export type WorkspaceSubAgentsProps = {
  agents: WorkspaceAgent[];
  activeAgentId: string | null;
  assetIndexes: Record<string, number>;
  mainChatTitle: string;
  mainStatus: string;
  available: boolean;
  onSelect: (agentId: string | null) => void;
};

const isRunning = (status: string) => ['spawning', 'running', 'working'].includes(status);
const statusLabel = (status: string) => {
  if (['planned', 'queued'].includes(status)) return 'Queued';
  if (status === 'waiting') return 'Joining children';
  if (status === 'blocked') return 'Blocked';
  if (status === 'spawning') return 'Starting';
  if (isRunning(status)) return 'Working';
  if (['completed', 'done'].includes(status)) return 'Completed';
  if (['failed', 'error'].includes(status)) return 'Failed';
  if (status === 'paused') return 'Paused';
  if (['closed', 'cancelled', 'stopped'].includes(status)) return 'Stopped';
  return 'Ready';
};

function AgentRow({ name, detail, status, selected, icon, unreadCount = 0, onSelect }: {
  name: string;
  detail: string;
  status: string;
  selected: boolean;
  icon: ReactNode;
  unreadCount?: number;
  onSelect: () => void;
}) {
  const label = statusLabel(status);
  const StatusIcon = ['completed', 'done'].includes(status) ? Check
    : ['failed', 'error'].includes(status) ? CircleAlert
      : status === 'paused' ? Pause
        : ['closed', 'cancelled', 'stopped'].includes(status) ? Square : Circle;

  return (
    <button
      type="button"
      className="eterx-workspace-agent-row"
      aria-current={selected ? 'true' : undefined}
      aria-label={`${name}, ${label}${selected ? ', viewing' : ''}${unreadCount > 0 ? `, ${unreadCount} unread messages` : ''}`}
      onClick={onSelect}
    >
      <span className="eterx-workspace-agent-avatar" aria-hidden="true">{icon}</span>
      <span className="eterx-workspace-agent-copy">
        <span className="eterx-workspace-agent-name">
          <strong title={name}>{name}</strong>
          {selected && <span className="eterx-workspace-agent-viewing">Viewing</span>}
        </span>
        <span className="eterx-workspace-agent-detail" title={detail}>{detail}</span>
      </span>
      <span className="eterx-workspace-agent-indicators" aria-hidden="true">
        {unreadCount > 0 && <span className="eterx-workspace-agent-unread">{unreadCount > 99 ? '99+' : unreadCount}</span>}
        <span className="eterx-workspace-agent-status" data-status={status} title={label}>
          {isRunning(status) ? <span className="eterx-splash-spinner" /> : <StatusIcon size={15} strokeWidth={1.8} />}
        </span>
      </span>
    </button>
  );
}

export function WorkspaceSubAgents({ agents, activeAgentId, assetIndexes, mainChatTitle, mainStatus, available, onSelect }: WorkspaceSubAgentsProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLElement | null>(null);
  const revealedSelection = useRef<string | null>(null);
  const pendingSelectionScroll = useRef<string | null>(null);
  const headingId = useId();
  const groupId = useId();
  const showSearch = agents.length > 5;
  const search = showSearch ? query.trim().toLocaleLowerCase() : '';
  const tree = useMemo(() => {
    const identity = (agent: WorkspaceAgent) => agent.subAgentId || agent.id || agent.subAgentChatId || agent.name;
    const nodes = new Map(agents.map(agent => [identity(agent), agent]));
    const aliases = new Map<string, string>();
    for (const [id, agent] of nodes) for (const alias of [id, agent.id, agent.subAgentId, agent.subAgentChatId]) if (alias) aliases.set(alias, id);
    const parents = new Map<string, string>();
    for (const [id, agent] of nodes) {
      const parent = agent.parentAgentId ? aliases.get(agent.parentAgentId) : undefined;
      if (parent && parent !== id) parents.set(id, parent);
    }
    // Recovered traces can be partial or malformed. Break cycles and keep
    // orphaned agents visible rather than losing them inside a hidden branch.
    for (const id of nodes.keys()) {
      const seen = new Set([id]); let current = parents.get(id);
      while (current) { if (seen.has(current)) { parents.delete(id); break; } seen.add(current); current = parents.get(current); }
    }
    const children = new Map<string, string[]>();
    for (const id of nodes.keys()) { const parent = parents.get(id) || ''; children.set(parent, [...(children.get(parent) || []), id]); }
    const included = new Set<string>();
    for (const [id, agent] of nodes) if (!search || `${agent.name} ${agent.task || ''} ${agent.currentAction || ''} ${agent.status || ''}`.toLocaleLowerCase().includes(search)) {
      included.add(id); let parent = parents.get(id);
      while (parent) { included.add(parent); parent = parents.get(parent); }
    }
    const rows: Array<{ id: string; agent: WorkspaceAgent; depth: number; children: number }> = [];
    const stack = [...(children.get('') || [])].reverse().map(id => ({ id, depth: 0 }));
    while (stack.length) {
      const item = stack.pop()!; if (!included.has(item.id)) continue;
      const branch = children.get(item.id) || [];
      rows.push({ ...item, agent: nodes.get(item.id)!, children: branch.length });
      if (search || !collapsed.has(item.id)) for (let i = branch.length - 1; i >= 0; i--) stack.push({ id: branch[i], depth: item.depth + 1 });
    }
    return { rows, parents, aliases };
  }, [agents, collapsed, search]);
  const virtualizer = useVirtualizer({ count: tree.rows.length, getScrollElement: () => listRef.current, getItemKey: index => tree.rows[index].id, estimateSize: () => 72, overscan: 6 });
  useEffect(() => {
    if (!activeAgentId) { revealedSelection.current = null; return; }
    if (revealedSelection.current === activeAgentId) return;
    const id = tree.aliases.get(activeAgentId);
    if (!id) return;
    revealedSelection.current = activeAgentId;
    pendingSelectionScroll.current = activeAgentId;
    const ancestors: string[] = []; let parent = id ? tree.parents.get(id) : undefined;
    while (parent) { ancestors.push(parent); parent = tree.parents.get(parent); }
    if (ancestors.some(ancestor => collapsed.has(ancestor))) setCollapsed(current => { const next = new Set(current); ancestors.forEach(ancestor => next.delete(ancestor)); return next; });
  }, [activeAgentId, tree.parents, tree.aliases, collapsed]);
  useEffect(() => {
    const pending = pendingSelectionScroll.current;
    if (!pending) return;
    const id = tree.aliases.get(pending);
    const index = tree.rows.findIndex(row => row.id === id);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: 'auto' });
    pendingSelectionScroll.current = null;
  }, [tree.rows, tree.aliases, virtualizer]);
  const runningCount = agents.filter(agent => isRunning(String(agent.status || '').toLowerCase())).length;

  return (
    <section className="eterx-workspace-agents" aria-labelledby={headingId}>
      <header className="eterx-workspace-agents-heading">
        <div>
          <h2 id={headingId}>Sub-Agents <span className="eterx-workspace-agents-count">{agents.length}</span></h2>
          <p>Follow the work and its delegated branches.</p>
        </div>
        {runningCount > 0 && <span className="eterx-workspace-agents-running" role="status">{runningCount} active</span>}
      </header>

      {available && (
        <div className="eterx-workspace-agents-main">
          <AgentRow name="Main chat" detail={mainChatTitle} status={mainStatus} selected={!activeAgentId} icon={<EterxLogo size={28} />} onSelect={() => onSelect(null)} />
        </div>
      )}

      {available && agents.length > 0 ? (
        <>
          {showSearch && (
            <div className="eterx-workspace-agents-search">
              <Search size={15} aria-hidden="true" />
              <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }} placeholder="Find an agent" aria-label="Find an agent" autoComplete="off" spellCheck={false} />
              {query && <button type="button" aria-label="Clear agent search" onClick={() => setQuery('')}><X size={14} /></button>}
            </div>
          )}
          <div className="eterx-workspace-agents-section" id={groupId}>Agent tree <span>{search ? `${tree.rows.length} shown` : agents.length}</span></div>
          <nav ref={listRef} className="eterx-workspace-agents-list eterx-scrollbar" aria-labelledby={groupId} style={{ display: 'block', minHeight: 120 }}>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map(item => {
              const row = tree.rows[item.index];
              const agent = row.agent;
              const identity = agent.id || agent.subAgentChatId || agent.subAgentId || agent.name;
              const status = String(agent.status || 'idle').toLowerCase();
              return <div key={row.id} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)`, paddingLeft: Math.min(row.depth, 6) * 13, display: 'flex', alignItems: 'center', gap: 2 }}>
                {row.children > 0 ? <button type="button" className="grid h-7 w-5 shrink-0 place-items-center rounded hover:bg-white/10" aria-label={`${collapsed.has(row.id) ? 'Expand' : 'Collapse'} ${agent.name}, ${row.children} child agents`} aria-expanded={Boolean(search) || !collapsed.has(row.id)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })}><ChevronRight size={13} style={{ transform: search || !collapsed.has(row.id) ? 'rotate(90deg)' : undefined }} /></button> : <span className="w-5 shrink-0" aria-hidden="true" />}
                <AgentRow
                name={agent.name}
                detail={`${row.children ? `${row.children} child agents · ` : ''}${agent.currentAction || agent.task || statusLabel(status)}`}
                status={status}
                selected={Boolean(activeAgentId && agentIdentitiesOverlap(agent, activeAgentId))}
                icon={<SubAgentIdentityIcon name={agent.name} size={30} assetIndex={assetIndexes[agent.name] ?? assetIndexes[identity]} />}
                unreadCount={Number(agent.unreadCount || 0)}
                onSelect={() => onSelect(identity)}
              /></div>;
            })}
            </div>
            {tree.rows.length === 0 && <div className="eterx-workspace-agents-no-results" role="status"><Search size={22} aria-hidden="true" /><strong>No matching agents</strong><p>Try a different name or task.</p></div>}
          </nav>
        </>
      ) : (
        <div className="eterx-workspace-agents-empty">
          <span><Network size={24} strokeWidth={1.6} aria-hidden="true" /></span>
          <h3>{available ? 'No sub-agents yet' : 'Open a chat to see its agents'}</h3>
          <p>{available ? 'When a task is delegated, its agent will appear here. Select an agent to follow its work or send a message.' : 'Sub-agents stay with the conversation that created them.'}</p>
        </div>
      )}
    </section>
  );
}
