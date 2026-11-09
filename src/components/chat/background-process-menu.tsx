'use client';

import { useEffect, useState } from 'react';
import { Check, CircleAlert, CircleStop, Loader2, Square, TerminalSquare } from 'lucide-react';
import { WorkMenuEmptyState, WorkMenuSectionButton } from '../layout/WorkMenuHelpers';
import { listManagedTerminals, managedTerminalCache, stopManagedTerminal, type ManagedTerminalTask } from '../../lib/managed-terminal-client';
import { openManagedTerminal } from '../../lib/chat-terminal-store';
import { formatTerminalProgram } from '../../lib/agent/terminal-invocation';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';

export function BackgroundProcessMenu({ chatId, onOpen, onMouseEnter }: { chatId: string; onOpen: () => void; onMouseEnter: () => void }) {
  const [open, setOpen] = useState(true);
  const [tasks, setTasks] = useState<ManagedTerminalTask[]>(() => managedTerminalCache.get(chatId) || []);
  const [loaded, setLoaded] = useState(() => managedTerminalCache.has(chatId));
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [stopping, setStopping] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const cached = managedTerminalCache.get(chatId) || [];
    setTasks(cached);
    setLoaded(managedTerminalCache.has(chatId));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let busy = false;
    let failures = 0;
    let polls = 0;
    let previous = JSON.stringify(cached);
    const refresh = async () => {
      if (busy || controller.signal.aborted || !isAppVisible()) return;
      clearTimeout(timer);
      busy = true;
      let active = false;
      try {
        const result = await listManagedTerminals(chatId, controller.signal);
        if (controller.signal.aborted) return;
        active = result.some(task => task.status === 'running');
        const signature = JSON.stringify(result);
        if (signature !== previous) { previous = signature; setTasks(result); }
        setLoaded(true); setError(''); failures = 0;
      } catch (e) {
        if (!controller.signal.aborted) {
          failures++;
          setLoaded(true);
          setError('Terminal connection unavailable. Retrying quietly.');
        }
      } finally {
        busy = false;
        polls++;
        if (!controller.signal.aborted && isAppVisible()) {
          const delay = failures ? Math.min(30_000, 4000 * failures) : active || polls < 3 ? 2500 : 10_000;
          timer = setTimeout(refresh, delay);
        }
      }
    };
    void refresh();
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.chatId === chatId) void refresh();
    };
    const visibility = () => { clearTimeout(timer); if (isAppVisible()) void refresh(); };
    window.addEventListener('eterx-terminal-task-changed', changed);
    const unsubscribeVisibility = subscribeAppVisibility(visibility);
    return () => {
      controller.abort(); clearTimeout(timer);
      window.removeEventListener('eterx-terminal-task-changed', changed);
      unsubscribeVisibility();
    };
  }, [chatId, open, retry]);
  const openTask = (task: ManagedTerminalTask) => {
    const opening = openManagedTerminal(chatId, task);
    onOpen();
    void opening.catch(() => {}); // The terminal dock presents connection/open errors.
  };
  const running = tasks.filter(task => task.status === 'running').length;
  return <div onMouseEnter={onMouseEnter}>
    <div className="eterx-work-menu-divider" />
    <WorkMenuSectionButton title="Background processes" meta={running ? `${running} running` : undefined} open={open} onClick={event => { event.stopPropagation(); setOpen(!open); }} />
    {open && <div className="eterx-background-process-list eterx-thread-switcher-scrollbar eterx-scrollbar">
      {error && <p className="eterx-work-menu-detail px-3 py-2" role="status">{error} <button type="button" className="underline underline-offset-2" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
      {actionError && <p className="eterx-work-menu-detail px-3 py-2" role="alert">{actionError}</p>}
      {!error && !loaded && <div className="flex justify-center py-3" role="status" aria-label="Loading background processes"><Loader2 className="h-4 w-4 animate-spin text-neutral-500" /></div>}
      {!error && loaded && !tasks.length && <WorkMenuEmptyState label="No background processes in this chat" />}
      {tasks.map(task => {
        const label = task.program ? formatTerminalProgram(task.program, task.args, true) : task.command.replace(/\s+/g, ' ').trim() || task.description || 'Terminal command';
        const active = task.status === 'running';
        const status = active ? 'Running' : task.status === 'completed' ? 'Completed' : task.status === 'killed' ? 'Stopped' : task.status === 'unknown' ? 'Outcome unavailable' : `Failed${task.exitCode !== null ? ` (exit ${task.exitCode})` : ''}`;
        return <div key={task.id} className="eterx-work-menu-row group cursor-pointer" title={`${task.command}\n${status}\n${task.cwd}`} onClick={() => openTask(task)}>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-label={`Open terminal: ${label}, ${status}`}>
            <TerminalSquare className="h-4 w-4 shrink-0 text-neutral-500" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-neutral-800 dark:text-white/90">{label}</span>
          </button>
          {active && <button type="button" aria-label={`Stop ${label}`} title="Stop process" disabled={stopping.includes(task.id)} className="rounded-sm p-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-50" onClick={async event => {
            event.stopPropagation(); setActionError(''); setStopping(ids => [...ids, task.id]);
            try {
              const result = await stopManagedTerminal(chatId, task.id);
              setTasks(items => items.map(item => item.id === task.id ? { ...item, ...result, id: task.id } : item));
            } catch (e) { setActionError(e instanceof Error ? e.message : 'Could not stop process.'); }
            finally { setStopping(ids => ids.filter(id => id !== task.id)); }
          }}><Square className="h-3.5 w-3.5" /></button>}
          <span role="img" aria-label={status} className="shrink-0">
            {active ? <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-500 dark:text-neutral-300" /> : task.status === 'completed' ? <Check className="h-4 w-4 text-emerald-500" /> : task.status === 'killed' ? <CircleStop className="h-3.5 w-3.5 text-neutral-500" /> : <CircleAlert className="h-3.5 w-3.5 text-rose-500" />}
          </span>
        </div>;
      })}
    </div>}
  </div>;
}
