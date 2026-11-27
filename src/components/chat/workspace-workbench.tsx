'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Braces, Check, ChevronDown, CircleAlert, Globe, Loader2, Play, Plus, Radio, RotateCw, Search, Smartphone, Square, TerminalSquare, X } from 'lucide-react';
import { useAppVisibility } from '../../lib/app-visibility';
import { createTerminal, showTerminal } from '../../lib/chat-terminal-store';
import { stopManagedTerminal, type ManagedTerminalTask } from '../../lib/managed-terminal-client';
import { formatTerminalProgram } from '../../lib/agent/terminal-invocation';
import { addWorkspaceTab, openDevelopmentPreview, updateWorkspaceTab, type WorkspaceTab } from '../../lib/side-workspace-store';
import { notifyWorkbenchClient, workbenchAction, workbenchJson, workbenchUrl, type WorkbenchActivity } from '../../lib/workbench/client';
import { localWorkbenchUrl, workbenchRunKind, type ProjectScript, type WorkbenchTarget, type WorkbenchView } from '../../lib/workbench/contracts';
import { useWorkbenchServiceHealth } from '../../lib/workbench/service-health';
import { useWorkbenchActivity } from '../../lib/workbench/use-activity';
import { workbenchReceiptUrl } from '../../lib/workbench/activity-trace';
import { useWorkspacePaneVisible } from '../ui/workspace-pane-visibility';
import { WorkbenchApi } from './workbench-api';
import { WorkbenchDevices } from './workbench-devices';
import { WorkbenchRunOutput } from './workbench-run-output';
import { revealInWorkspaceScroller } from './workspace-scroll';

const views = [
  { id: 'runs', label: 'Runs', icon: Activity },
  { id: 'services', label: 'Services', icon: Radio },
  { id: 'api', label: 'API', icon: Braces },
  { id: 'devices', label: 'Devices', icon: Smartphone },
] as const;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const leaf = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;
const labels = { running: 'Running', completed: 'Completed', failed: 'Failed', killed: 'Stopped', unknown: 'Outcome unavailable' };
const kinds = { server: 'Server', test: 'Test', build: 'Build', command: 'Command' };

function WorkbenchRuns({ chatId, owner, root, visible, activity, loading, activeTaskId, onSelectTask, onOpenTarget }: {
  chatId: string;
  owner: string;
  root?: string | null;
  visible: boolean;
  activity: WorkbenchActivity;
  loading: boolean;
  activeTaskId?: string;
  onSelectTask: (taskId?: string) => void;
  onOpenTarget: (target: WorkbenchTarget) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'running' | 'test'>('all');
  const [search, setSearch] = useState('');
  const [scripts, setScripts] = useState<ProjectScript[]>();
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState('');
  const runList = useRef<HTMLDivElement>(null);
  const focusedRun = useRef<HTMLLIElement>(null);
  const hasFocusedRun = activity.tasks.some(task => task.id === activeTaskId);
  useEffect(() => {
    if (visible && hasFocusedRun && runList.current && focusedRun.current) {
      const header = focusedRun.current.firstElementChild;
      if (header instanceof HTMLElement) revealInWorkspaceScroller(runList.current, header);
    }
  }, [activeTaskId, hasFocusedRun, visible]);
  useEffect(() => {
    if (!root || !visible || !scriptsOpen || !activity.desktop) return;
    const controller = new AbortController();
    setScripts(undefined);
    setScriptError('');
    setScriptLoading(true);
    void workbenchJson<{ scripts: ProjectScript[] }>(workbenchUrl(chatId, 'scripts', { root }), { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setScripts(data.scripts); }, error => { if (!controller.signal.aborted) setScriptError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setScriptLoading(false); });
    return () => controller.abort();
  }, [chatId, root, visible, scriptsOpen, activity.desktop]);
  const run = async (script: ProjectScript) => {
    setError('');
    setPending(items => [...items, script.name]);
    try {
      const { taskId } = await workbenchAction<{ taskId: string }>(chatId, 'run-script', { root, name: script.name });
      setScriptsOpen(false);
      onSelectTask(taskId);
      notifyWorkbenchClient(chatId);
    } catch (error) { setError(errorText(error)); }
    finally { setPending(items => items.filter(item => item !== script.name)); }
  };
  const stop = async (task: ManagedTerminalTask) => {
    setError('');
    setPending(items => [...items, task.id]);
    try { await stopManagedTerminal(chatId, task.id); }
    catch (error) { setError(errorText(error)); }
    finally { setPending(items => items.filter(item => item !== task.id)); }
  };
  const query = search.trim().toLowerCase();
  const rows = activity.tasks.filter(task => task.id === activeTaskId ||
    ((filter === 'all' || (filter === 'running' ? task.status === 'running' : workbenchRunKind(task.command) === 'test'))
      && (!query || (task.command + ' ' + task.cwd).toLowerCase().includes(query))));
  return <div ref={runList} className="eterx-wb-runs eterx-scrollbar">
    <div className="eterx-wb-local-toolbar">
      <div className="eterx-wb-filters">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All runs</button>
        <button type="button" aria-pressed={filter === 'running'} onClick={() => setFilter('running')}>Running</button>
        <button type="button" aria-pressed={filter === 'test'} onClick={() => setFilter('test')}>Tests</button>
      </div>
      {activity.desktop && <div className="eterx-wb-run-tools">
        <button type="button" className="eterx-wb-icon" aria-label="Open a project shell" title="New shell" onClick={() => {
          addWorkspaceTab(owner, 'terminal');
          showTerminal(owner, 'right');
          void createTerminal(owner, root);
        }}><TerminalSquare size={16} /></button>
        {root && <button type="button" aria-expanded={scriptsOpen} className="eterx-wb-button" onClick={() => setScriptsOpen(!scriptsOpen)}><Play size={13} />Run script</button>}
      </div>}
    </div>
    {scriptsOpen && <section className="eterx-wb-scripts" aria-label="Project scripts">
      {scriptLoading && <p role="status">Loading project scripts…</p>}
      {scriptError && <p role="alert">{scriptError}</p>}
      {scripts?.length === 0 && <p>No package scripts in this folder. Use the terminal to run other commands.</p>}
      {scripts?.map(script => <button type="button" key={script.name} disabled={pending.includes(script.name)} onClick={() => void run(script)}>
        {pending.includes(script.name) ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        <span><strong>{script.name}</strong><small>{script.command}</small></span><span>{kinds[script.kind]}</span>
      </button>)}
    </section>}
    {activity.tasks.length > 0 && <label className="eterx-wb-search"><Search size={14} /><input placeholder="Find a command" aria-label="Find a command" value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" className="eterx-wb-icon" title="Clear search" aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</label>}
    {error && <p className="eterx-wb-error" role="alert">{error}</p>}
    {loading && <div className="eterx-wb-placeholder" role="status"><Loader2 size={20} className="animate-spin" />Loading runs…</div>}
    {!loading && !rows.length && <div className="eterx-wb-placeholder"><TerminalSquare size={28} strokeWidth={1.5} /><strong>{activity.tasks.length ? 'No matching runs' : 'No commands in this chat'}</strong>
      <span>{activity.tasks.length ? 'Change the filter or search terms.' : 'Project commands, test results, and server logs will appear here.'}</span></div>}
    {rows.length > 0 && <ul className="eterx-wb-list">
      {rows.map(task => {
        const label = task.program ? formatTerminalProgram(task.program, task.args, true) : task.command;
        const StatusIcon = task.status === 'running' ? Loader2 : task.status === 'completed' ? Check : task.status === 'killed' ? Square : CircleAlert;
        const expanded = task.id === activeTaskId;
        return <li ref={expanded ? focusedRun : undefined} key={task.id} className="eterx-wb-run" data-expanded={expanded}>
          <div className="eterx-wb-row">
            <button type="button" className="eterx-wb-row-main" title={task.command + '\n' + task.cwd} aria-expanded={expanded} onClick={() => onSelectTask(expanded ? undefined : task.id)}>
              <span className="eterx-wb-row-icon" data-status={task.status}><StatusIcon size={17} className={task.status === 'running' ? 'animate-spin' : ''} /></span>
              <span className="eterx-wb-row-copy"><strong>{label || task.description || 'Terminal command'}</strong>
                <small>{kinds[workbenchRunKind(task.command)]} <span>·</span> {leaf(task.cwd)} <span>·</span> {new Date(task.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></span>
              <span className="eterx-wb-status" data-status={task.status}>{labels[task.status]}{task.status === 'failed' && task.exitCode !== null ? ' · ' + task.exitCode : ''}</span>
              <ChevronDown size={14} className="eterx-wb-run-chevron" aria-hidden="true" />
            </button>
            {task.status === 'running' && <button type="button" className="eterx-wb-icon" title="Stop process" aria-label={'Stop ' + (label || 'command')} disabled={pending.includes(task.id)} onClick={() => void stop(task)}><Square size={14} /></button>}
          </div>
          {expanded && <WorkbenchRunOutput owner={owner} chatId={chatId} task={task} visible={visible} desktop={activity.desktop}
            targets={activity.targets.filter(target => target.taskId === task.id)} onOpenTarget={onOpenTarget} />}
        </li>;
      })}
    </ul>}
  </div>;
}

function WorkbenchServices({ chatId, activity, visible, selectedUrl, onOpen, onApi }: { chatId: string; activity: WorkbenchActivity; visible: boolean; selectedUrl?: string; onOpen: (url: string, label?: string) => void; onApi: (url: string) => void }) {
  const [entry, setEntry] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const targets = activity.targets;
  const list = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLLIElement>(null);
  const selectedTarget = selectedUrl && (targets.find(target => target.url === selectedUrl) ||
    targets.find(target => workbenchReceiptUrl(target.url) === workbenchReceiptUrl(selectedUrl)));
  const selectedKey = selectedTarget ? selectedTarget.kind + selectedTarget.url : '';
  useEffect(() => {
    if (visible && selectedKey && list.current && selected.current) revealInWorkspaceScroller(list.current, selected.current);
  }, [selectedKey, visible]);
  const probes = useWorkbenchServiceHealth(chatId, targets, visible && activity.desktop);
  const pin = async () => {
    if (adding) return;
    setAdding(true);
    setError('');
    try {
      const url = localWorkbenchUrl(entry).href;
      await workbenchAction(chatId, 'publish', { url });
      setEntry('');
      notifyWorkbenchClient(chatId);
    } catch (error) { setError(errorText(error)); }
    finally { setAdding(false); }
  };
  const forget = async (target: WorkbenchTarget) => {
    try { await workbenchAction(chatId, 'forget', { url: target.url }); notifyWorkbenchClient(chatId); }
    catch (error) { setError(errorText(error)); }
  };
  return <div ref={list} className="eterx-wb-services eterx-scrollbar">
    <form className="eterx-wb-service-input" onSubmit={event => { event.preventDefault(); void pin(); }}>
      <Globe size={16} /><input aria-label="Local service URL" value={entry} onChange={event => setEntry(event.target.value)} placeholder="http://localhost:3000" spellCheck={false} maxLength={2048} />
      <button type="submit" className="eterx-wb-button" disabled={adding || !entry.trim()}><Plus size={15} />Add</button>
    </form>
    {error && <p className="eterx-wb-error" role="alert">{error}</p>}
    {!targets.length && <div className="eterx-wb-placeholder"><Radio size={29} strokeWidth={1.5} /><strong>No local services yet</strong><span>Run a server or add a local URL to open its live browser or API.</span></div>}
    {targets.length > 0 && <ul className="eterx-wb-list">
      {targets.map(target => {
        const task = activity.tasks.find(item => item.id === target.taskId);
        const ready = probes[target.url];
        const primary = target.kind === 'api' ? 'Open API explorer' : 'Open live browser';
        const focused = target.kind + target.url === selectedKey;
        return <li key={target.kind + target.url} ref={focused ? selected : undefined} className="eterx-wb-row" data-focused={focused || undefined}>
          <button type="button" className="eterx-wb-row-main" title={target.url + '\n' + primary} onClick={() => target.kind === 'api' ? onApi(target.url) : onOpen(target.url, target.label)}>
            <span className="eterx-wb-row-icon">{target.kind === 'api' ? <Braces size={17} /> : <Globe size={17} />}</span>
            <span className="eterx-wb-row-copy"><strong>{target.label || target.url.replace(/^https?:\/\//, '')}</strong><small>{task ? task.command : target.kind === 'api' ? 'API endpoint' : 'Local web service'}</small></span>
            <span className="eterx-wb-status" data-status={ready === true ? 'running' : ready === false ? 'failed' : 'unknown'}><i />{ready === true ? 'Listening' : ready === false ? 'Unavailable' : 'Reported'}</span>
          </button>
          <button type="button" className="eterx-wb-icon" aria-label={primary} title={primary} onClick={() => target.kind === 'api' ? onApi(target.url) : onOpen(target.url, target.label)}><ArrowUpRight size={16} /></button>
          {target.kind === 'web' && <button type="button" className="eterx-wb-icon" title="Inspect as API" aria-label="Inspect as API" onClick={() => onApi(target.url)}><Braces size={15} /></button>}
          {!task && <button type="button" className="eterx-wb-icon" title="Remove saved target" aria-label="Remove saved target" onClick={() => void forget(target)}><X size={15} /></button>}
        </li>;
      })}
    </ul>}
  </div>;
}

export function WorkspaceWorkbench({ owner, chatId, tab, workspacePath, isActive, onOpenConnections }: {
  owner: string;
  chatId: string | null;
  tab: WorkspaceTab;
  workspacePath?: string | null;
  isActive: boolean;
  onOpenConnections: () => void;
}) {
  const visible = useAppVisibility() && useWorkspacePaneVisible() && isActive;
  const current = useWorkbenchActivity(chatId, visible);
  const [error, setError] = useState('');
  const onShareChange = useCallback((workbenchWindow?: string) => updateWorkspaceTab(owner, tab.id, { workbenchWindow }), [owner, tab.id]);
  const view = tab.workbenchView || 'runs';
  const running = useMemo(() => current.snapshot.tasks.filter(task => task.status === 'running').length, [current.snapshot.tasks]);
  const select = (next: WorkbenchView, url?: string) => updateWorkspaceTab(owner, tab.id, { workbenchView: next, ...(url && { workbenchUrl: url }) });
  const open = (url: string, label?: string) => {
    setError('');
    try {
      if ((window as any).electronAPI?.workspaceBrowserCreate) openDevelopmentPreview(owner, url, label);
      else window.open(localWorkbenchUrl(url).href, '_blank', 'noopener,noreferrer');
    } catch (error) { setError(errorText(error)); }
  };
  if (!chatId) return <div className="eterx-wb-placeholder"><Activity size={30} /><strong>Development workbench</strong><span>Start a conversation to follow its runs, services, and devices.</span></div>;
  return <div className="eterx-wb-shell">
    <header className="eterx-wb-heading">
      <div><h2>Workbench</h2><p title={workspacePath || undefined}>{workspacePath ? leaf(workspacePath) : 'Chat workspace'}</p></div>
      {running > 0 && <span className="eterx-wb-status" data-status="running"><i />{running} running</span>}
      <button type="button" className="eterx-wb-icon" title="Refresh workbench" aria-label="Refresh workbench" onClick={() => notifyWorkbenchClient(chatId)}><RotateCw size={15} /></button>
    </header>
    <nav className="eterx-wb-nav" aria-label="Workbench views">
      {views.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={view === id ? 'page' : undefined} onClick={() => select(id)}><Icon size={16} />{label}{id === 'services' && current.snapshot.targets.length > 0 && <small>{current.snapshot.targets.length}</small>}</button>)}
    </nav>
    {(error || current.error) && <p className="eterx-wb-error" role="alert">{error || current.error}</p>}
    {view === 'runs' && <WorkbenchRuns key={chatId} chatId={chatId} owner={owner} root={workspacePath} visible={visible}
      activity={current.snapshot} loading={current.loading} activeTaskId={tab.workbenchTaskId}
      onSelectTask={workbenchTaskId => updateWorkspaceTab(owner, tab.id, { workbenchTaskId })}
      onOpenTarget={target => target.kind === 'api' ? select('api', target.url) : open(target.url, target.label)} />}
    {view === 'services' && <WorkbenchServices key={chatId} chatId={chatId} activity={current.snapshot} visible={visible} selectedUrl={tab.workbenchUrl} onOpen={open} onApi={url => select('api', url)} />}
    {view === 'api' && <WorkbenchApi key={chatId} chatId={chatId} initialUrl={tab.workbenchUrl} desktop={current.snapshot.desktop} onOpen={open} />}
    {view === 'devices' && <WorkbenchDevices key={chatId} chatId={chatId} selectedId={current.snapshot.deviceId} desktop={current.snapshot.desktop} visible={visible} onOpenConnections={onOpenConnections}
      mode={tab.workbenchDeviceMode || 'devices'} onModeChange={workbenchDeviceMode => updateWorkspaceTab(owner, tab.id, { workbenchDeviceMode })}
      onShareChange={onShareChange} />}
  </div>;
}
