'use client';

import { createContext, useContext, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ArrowUpRight, Check, ChevronRight, Circle, CircleAlert, CircleDashed, CircleSlash, Copy, Download, Lightbulb, Loader2, Minimize2 } from 'lucide-react';
import { useFilePanelOwner } from '../../contexts/FilePanelContext';
import { planMarkdown, planStepLabels, planTitle, planViewKey, type TaskTrackerState } from '../../lib/task-plan-trace';
import { addWorkspaceTab, updateWorkspace, useSideWorkspace, type WorkspaceTab } from '../../lib/side-workspace-store';
import { useLiveChat, type LiveChatLedger } from '../../lib/live-chat-ledger';
import { safeCopyTextToClipboard } from '../ui/copy-button';
import { ChatMediaOwnerContext } from './chat-media';
import { markdownComponents, rehypePlugins, remarkPlugins } from './markdown-renderer';
import styles from './task-plan.module.css';

export const PlanPanelOwner = createContext<string | null>(null);

export function openPlanInWorkspace(owner: string, chatId: string, plan: TaskTrackerState) {
  return addWorkspaceTab(owner, 'plan', { plan, planChatId: chatId });
}

function PlanActions({ plan }: { plan: TaskTrackerState }) {
  const [copyState, setCopyState] = useState('');
  const copy = async () => {
    const copied = await safeCopyTextToClipboard(planMarkdown(plan));
    setCopyState(copied ? 'Copied' : 'Copy failed');
  };
  const download = () => {
    const blob = new Blob([planMarkdown(plan) + '\n'], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (planTitle(plan).replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 90) || 'Plan') + '.md';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className={styles.actions}>
    <button type="button" title="Download plan" aria-label="Download plan as Markdown" onClick={download}><Download size={15} /></button>
    <button type="button" title={copyState || 'Copy plan'} aria-label={copyState || 'Copy plan'} onClick={copy}>
      {copyState === 'Copied' ? <Check size={15} /> : <Copy size={15} />}
    </button>
    <span className="sr-only" role="status">{copyState}</span>
  </div>;
}

function progressLabel(plan: TaskTrackerState) {
  const steps = plan.steps || [];
  if (plan.status === 'proposed') return 'Proposed';
  if (plan.status === 'failed') return 'Failed';
  if (plan.status === 'stopped') return 'Stopped';
  const done = steps.filter(step => step.status === 'done').length;
  const skipped = steps.filter(step => step.status === 'skipped').length;
  return [`${done}/${steps.length} done`, skipped ? `${skipped} skipped` : ''].filter(Boolean).join(' · ');
}

export function TaskPlanCard({ plan }: { plan: TaskTrackerState }) {
  const feedOwner = useFilePanelOwner();
  const owner = useContext(PlanPanelOwner) || feedOwner || '';
  const chatId = useContext(ChatMediaOwnerContext) || owner;
  const workspace = useSideWorkspace(owner);
  const here = workspace.tabs.find(tab => tab.id === workspace.activeId);
  const opened = workspace.open && here?.kind === 'plan' && here.planChatId === chatId && here.plan && planViewKey(here.plan) === planViewKey(plan);
  const generating = plan.phase === 'generating' || plan.status === 'generating';
  const available = Boolean(plan.document || plan.steps?.length);
  if (!available) return <div className={styles.notice} role="status">
    <Lightbulb size={16} aria-hidden />{generating ? 'Preparing plan…' : plan.error || (plan.status === 'stopped' ? 'Planning stopped' : plan.text || 'Task plan')}
  </div>;
  const open = () => {
    if (opened) updateWorkspace(owner, { open: false });
    else openPlanInWorkspace(owner, chatId, plan);
  };
  const blocks = plan.document?.trim().split(/\r?\n\s*\r?\n/) || [];
  let heading = '';
  let summary = '';
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    while (lines.length && /^#{1,6}\s+/.test(lines[0])) heading = lines.shift()!.replace(/^#{1,6}\s+/, '');
    summary = lines.join(' ').trim();
    if (summary) break;
  }
  return <section className={styles.card} aria-label={planTitle(plan)}>
    <div className={styles.toolbar}>
      <button type="button" className={styles.cardLabel} onClick={open} aria-expanded={Boolean(opened)}><Lightbulb size={17} />Plan</button>
      <span className={styles.meta}>{progressLabel(plan)}</span>
      <PlanActions key={planViewKey(plan) + (plan.revision || '')} plan={plan} />
      <button type="button" className={styles.iconButton} aria-label={opened ? 'Close plan panel' : 'Open plan in side panel'} title={opened ? 'Close plan panel' : 'Open plan in side panel'} onClick={open}>
        {opened ? <Minimize2 size={15} /> : <ArrowUpRight size={17} />}
      </button>
    </div>
    {!opened && <button type="button" className={styles.preview} onClick={open} aria-label={'Open ' + planTitle(plan) + ' in side panel'}>
      <strong>{planTitle(plan)}</strong>
      {summary ? <>
        {heading && heading !== planTitle(plan) && <span className={styles.previewHeading}>{heading}</span>}
        <span className={styles.summary}>{summary.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|__|`/g, '')}</span>
      </> : <span className={styles.compactSteps}>{plan.steps?.slice(0, 3).map(step => {
        const Icon = stepIcons[step.status] || Circle;
        return <span key={step.id || step.step}><Icon size={13} aria-hidden /><span>{step.name}</span></span>;
      })}</span>}
    </button>}
  </section>;
}

const stepIcons = { done: Check, skipped: CircleSlash, failed: CircleAlert, blocked: CircleDashed, in_progress: Loader2, pending: Circle };

export function WorkspacePlan({ tab, owner, logs, ledger, running }: { tab: WorkspaceTab; owner: string; logs: any[]; ledger?: LiveChatLedger; running: boolean }) {
  const sourceChat = tab.planChatId || owner;
  const live = useLiveChat(ledger, sourceChat);
  const source = sourceChat === owner || !live?.traceLogs?.length ? logs : live.traceLogs;
  const identity = tab.plan && planViewKey(tab.plan);
  const plan: TaskTrackerState | undefined = source.findLast(log => log?.type === 'task_plan' &&
    (!log.ownerChatId || log.ownerChatId === sourceChat) &&
    (identity ? planViewKey(log) === identity : !log.subAgentId && !log.subAgentChatId && !log.auxiliaryRuntime)) || tab.plan;
  if (!plan) return <div className="eterx-workspace-empty"><Lightbulb size={28} /><h3>No plan in this chat yet</h3><p>Choose /plan in the composer to develop an implementation plan.</p></div>;
  const steps = plan.steps || [];
  return <article className={styles.reader} aria-label="Implementation plan" tabIndex={0}>
    <div className={styles.readerBar}><span>{plan.status === 'generating' ? 'Preparing plan…' : progressLabel(plan)}</span>
      {(plan.revision || 1) > 1 && <span>Revision {plan.revision}</span>}
      <PlanActions key={planViewKey(plan) + (plan.revision || '')} plan={plan} />
    </div>
    <h1>{planTitle(plan)}</h1>
    {plan.document ? <div className={styles.document}><ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>{plan.document}</ReactMarkdown></div>
      : plan.title && plan.goal !== plan.title && <p className={styles.goal}>{plan.goal}</p>}
    {plan.context && <details className={styles.context}><summary>Planning context</summary><p>{plan.context}</p></details>}
    {steps.length > 0 && <>
      <h2 className={styles.stepHeading}>Implementation steps</h2>
      <ol className={styles.steps}>{steps.map(step => {
        const active = running && plan.status === 'in_progress' && step.status === 'in_progress';
        const Icon = active ? Loader2 : step.status === 'in_progress' ? Circle : stepIcons[step.status] || Circle;
        return <li key={step.id || step.step}><details>
          <summary aria-current={active ? 'step' : undefined}><Icon size={15} className={active ? 'motion-safe:animate-spin' : undefined} aria-hidden /><span>{step.name}</span><ChevronRight size={14} className={styles.chevron} /></summary>
          <div className={styles.stepDetails}>
            <small>{planStepLabels[step.status]}{step.depends_on?.length ? ' · After ' + step.depends_on.map(n => 'step ' + n).join(', ') : ''}</small>
            {step.description && <p>{step.description}</p>}
            {step.expected_output && step.expected_output !== step.description && step.expected_output !== step.done_when && <p><b>Expected outcome</b>{step.expected_output}</p>}
            {step.done_when && <p><b>Done when</b>{step.done_when}</p>}
            {step.artifacts?.length ? <p><b>Artifacts</b>{step.artifacts.join(', ')}</p> : null}
            {step.completionReason && <p>{step.completionReason}</p>}{step.failureReason && <p>{step.failureReason}</p>}
            {!!step.completionEvidence?.length && <ul>{step.completionEvidence.map((item, index) => <li key={index}>{item}</li>)}</ul>}
          </div>
        </details></li>;
      })}</ol>
    </>}
    {plan.error && <p role="status">{plan.error}</p>}
  </article>;
}
