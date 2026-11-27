'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, Braces, Globe, TerminalSquare } from 'lucide-react';
import { openManagedTerminal } from '../../lib/chat-terminal-store';
import { readManagedTerminal, type ManagedTerminalTask } from '../../lib/managed-terminal-client';
import { notifyWorkbenchClient } from '../../lib/workbench/client';
import type { WorkbenchTarget } from '../../lib/workbench/contracts';
import { useWorkbenchServiceHealth } from '../../lib/workbench/service-health';

const limit = 52_000;
const plainOutput = (value: string) => value
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
  .replace(/[\u001b]\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r\n?/g, '\n');

export function WorkbenchRunOutput({ owner, chatId, task, visible, desktop, targets, onOpenTarget }: {
  owner: string;
  chatId: string;
  task: ManagedTerminalTask;
  visible: boolean;
  desktop: boolean;
  targets: WorkbenchTarget[];
  onOpenTarget: (target: WorkbenchTarget) => void;
}) {
  const [output, setOutput] = useState('');
  const [started, setStarted] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [following, setFollowing] = useState(true);
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  const cursor = useRef(0);
  const log = useRef<HTMLPreElement>(null);
  const probes = useWorkbenchServiceHealth(chatId, targets, visible && desktop);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const read = async () => {
      try {
        const snapshot = await readManagedTerminal(chatId, task.id, cursor.current, controller.signal);
        if (controller.signal.aborted) return;
        if (snapshot.outputStart > cursor.current || snapshot.outputEnd > limit) setTruncated(true);
        cursor.current = snapshot.outputEnd;
        const chunk = plainOutput(snapshot.output);
        if (chunk) setOutput(previous => (previous + chunk).slice(-limit));
        setStarted(true);
        setError(snapshot.outputReadError || snapshot.outputPersistenceError || '');
        failures = 0;
        if (snapshot.running || snapshot.hasMoreOutput) {
          timer = setTimeout(read, snapshot.hasMoreOutput ? 40 : 850);
        } else if (task.status === 'running') {
          notifyWorkbenchClient(chatId);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : String(error));
        if (task.status === 'running' && ++failures < 3) timer = setTimeout(read, 1800 * failures);
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [chatId, task.id, task.status, visible, revision]);

  useLayoutEffect(() => {
    const view = log.current;
    if (following && view) view.scrollTop = view.scrollHeight;
  }, [output, following]);

  return <section className="eterx-wb-output" aria-label="Run output">
    <div className="eterx-wb-output-head">
      <span>{truncated ? 'Recent output' : 'Output'}</span>
      <button type="button" className="eterx-wb-icon" title="Follow output" aria-label="Follow output" aria-pressed={following}
        onClick={() => setFollowing(value => !value)}><ArrowDown size={14} /></button>
      {desktop && <button type="button" className="eterx-wb-button" onClick={() => void openManagedTerminal(chatId, task, owner)
        .catch(error => setError(error instanceof Error ? error.message : String(error)))}><TerminalSquare size={14} />Open terminal</button>}
    </div>
    {error && <div className="eterx-wb-output-error" role="status"><span>{error}</span>
      <button type="button" className="eterx-wb-button" onClick={() => refresh(value => value + 1)}>Retry</button>
    </div>}
    <pre ref={log} className="eterx-wb-output-log eterx-scrollbar" tabIndex={0} aria-label="Terminal output" onScroll={event => {
      const view = event.currentTarget;
      setFollowing(view.scrollHeight - view.scrollTop - view.clientHeight < 28);
    }}>{output || (!started ? 'Loading output…' : task.status === 'running' ? 'Waiting for output…' : 'This run did not produce output.')}</pre>
    {!!targets.length && <ul className="eterx-wb-output-targets" aria-label="Services from this run">
      {targets.map(target => {
        const Icon = target.kind === 'api' ? Braces : Globe;
        const ready = desktop ? probes[target.url] : null;
        return <li key={target.kind + target.url}>
          <Icon size={14} />
          <span title={target.url}>{target.label || target.url.replace(/^https?:\/\//, '')}</span>
          <span className="eterx-wb-status" data-status={ready === true ? 'running' : 'unknown'}>
            <i />{ready === true ? 'Listening' : ready === false ? 'Waiting for service' : 'Reported'}
          </span>
          <button type="button" className="eterx-wb-icon" disabled={desktop && ready !== true}
            aria-label={target.kind === 'api' ? 'Inspect API' : 'Open preview'} title={target.kind === 'api' ? 'Inspect API' : 'Open preview'}
            onClick={() => onOpenTarget(target)}><ArrowUpRight size={15} /></button>
        </li>;
      })}
    </ul>}
  </section>;
}
