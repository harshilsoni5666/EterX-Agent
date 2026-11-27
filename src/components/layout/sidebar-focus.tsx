import React from 'react';
import { useIsPresent, usePresenceData } from 'framer-motion';
import { AlarmClock, CircleAlert, CircleCheck, CirclePause, CircleStop, Clock3, GitBranch, GitCommitHorizontal, LoaderCircle, MessageCircleQuestionMark } from 'lucide-react';
import { parseModelEntryKey, type ModelSelectorEntry } from '../../lib/agent/model-selector-store';
import { appStorage } from '../../lib/client-storage';
import { updateScheduledTaskFocus } from '../../lib/scheduled-task-sync';
import { chatMatchesScope, type ChatScope } from '../../lib/chat-scope';
import { mergeChatCommitReceipts, readChatCommitTraces, type ChatCommitReceipt } from '../../lib/git/chat-commits';
import { canSettleFocusItem, readFocusTrace, resolveFocusModel, type ChatFocusDisposition, type FocusGroup, type FocusStatus } from '../../lib/chat-focus';
import { useLiveChats, type LiveChatLedger } from '../../lib/live-chat-ledger';
import { SCHEDULED_TASKS_STORAGE_KEY, type ScheduledTaskRecord } from '../../lib/scheduled-tasks';
import type { IdentityAvatarDescriptor } from '../ui/identity-avatar';
import { assignWorkspaceAvatars, useWorkspaceIcon, WorkspaceAvatar, workspaceIdentity, type WorkspaceIdentity, type WorkspaceSource } from '../ui/workspace-avatar';
import { ProviderIconAsset } from '../ui/provider-icon';
import { modelLabel, providerLabel } from '../usage/usage-format';
import { FocusScheduleActions } from './sidebar-focus-actions';
import { FocusChatHover } from './sidebar-focus-hover';

const scheduleStatuses: Partial<Record<ScheduledTaskRecord['status'], FocusStatus>> = {
  running: 'working', scheduled: 'scheduled', queued: 'queued',
  paused: 'paused', failed: 'failed', completed: 'done',
};

interface FocusWorkspace extends WorkspaceIdentity {
  avatar?: IdentityAvatarDescriptor;
}

interface FocusChat extends ChatFocusDisposition, WorkspaceSource {
  id: string;
  modelSelection?: string;
}
interface FocusChatDetails {
  group: FocusGroup;
  status?: FocusStatus;
  model?: ModelSelectorEntry | null;
  nextRunAt?: number;
  task?: ScheduledTaskRecord;
  question?: any;
  commits: ChatCommitReceipt[];
}

function subscribeSchedules(onChange: () => void) {
  const handleUpdate = (event: Event) => {
    if ((event as CustomEvent<{ key: string }>).detail?.key === SCHEDULED_TASKS_STORAGE_KEY) onChange();
  };
  window.addEventListener('eterx-folder-storage-updated', handleUpdate);
  return () => window.removeEventListener('eterx-folder-storage-updated', handleUpdate);
}

const readSchedules = () => appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY) || '';
const noSchedules = () => '';
const noSubscription = () => () => {};

function scheduledTaskFocus(task: ScheduledTaskRecord, clock: number): {
  group: FocusGroup;
  status?: FocusStatus;
  attentionStatus?: FocusStatus;
  activityAt: number;
} {
  const due = (task.status === 'scheduled' || task.status === 'queued') && task.scheduledTimestamp <= clock;
  const lastRun = task.history?.at(-1);
  const activityAt = Math.max(
    task.updatedAt || task.createdAt || 0,
    task.executedAt || 0,
    lastRun?.startedAt || 0,
    lastRun?.completedAt || 0,
    due ? task.scheduledTimestamp : 0,
  );
  const attentionStatus = due ? 'woke' : scheduleStatuses[task.status];
  if (task.status === 'running') return { group: 'working', status: 'working', attentionStatus, activityAt };

  // A due occurrence can be settled too. Only newer activity wakes it again.
  if (task.focusSettledAt && activityAt <= task.focusSettledAt) {
    return { group: 'settled', status: 'settled', attentionStatus, activityAt };
  }
  return { group: 'attention', status: attentionStatus, attentionStatus, activityAt };
}

export const formatFocusDate = (at: number) => new Date(at).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

export function shortFocusTaskTitle(title: string) {
  const words = title.trim().split(/\s+/);
  return words.slice(0, 3).join(' ') + (words.length > 3 ? '…' : '');
}

export function useSidebarFocus<T extends FocusChat>({
  enabled, ledger, chats, chatScope, runningChats, knownChatIds,
}: {
  enabled: boolean;
  ledger: LiveChatLedger;
  chats: T[];
  chatScope: ChatScope;
  runningChats?: Set<string>;
  knownChatIds: ReadonlySet<string>;
}) {
  const liveChats = useLiveChats(ledger, enabled);
  const snapshot = React.useSyncExternalStore(
    enabled ? subscribeSchedules : noSubscription,
    enabled ? readSchedules : noSchedules,
    noSchedules,
  );
  const schedules = React.useMemo((): ScheduledTaskRecord[] => {
    try {
      const records: unknown = JSON.parse(snapshot || '[]');
      return Array.isArray(records) ? records.filter(task => task && typeof task.id === 'string') : [];
    } catch { return []; }
  }, [snapshot]);

  const [clock, setClock] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const tick = () => {
      window.clearTimeout(timer);
      const now = Date.now();
      setClock(now);
      let next = Infinity;
      for (const chat of chats) if (chat.focusWakeAt && chat.focusWakeAt > now) next = Math.min(next, chat.focusWakeAt);
      for (const task of schedules) {
        if ((task.status === 'scheduled' || task.status === 'queued') && task.scheduledTimestamp > now) {
          next = Math.min(next, task.scheduledTimestamp);
        }
      }
      if (Number.isFinite(next)) timer = window.setTimeout(tick, Math.min(2_147_483_647, next - now));
    };
    tick();
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled, chats, schedules]);

  const getWorkspace = React.useMemo(() => {
    const avatars = assignWorkspaceAvatars(enabled ? chats : [], enabled ? schedules : []);

    return (source: WorkspaceSource): FocusWorkspace => {
      const workspace = workspaceIdentity(source);
      return { ...workspace, avatar: avatars.get(workspace.identity) };
    };
  }, [enabled, chats, schedules]);

  const focusState = React.useMemo(() => {
    const groups: Record<FocusGroup, T[]> = { working: [], attention: [], settled: [] };
    const details = new Map<string, FocusChatDetails>();
    const unlinkedTasks: Record<FocusGroup, ScheduledTaskRecord[]> = { working: [], attention: [], settled: [] };
    const taskStates = new Map<string, ReturnType<typeof scheduledTaskFocus>>();
    if (!enabled) return { groups, details, unlinkedTasks, taskStates };

    const byChat = new Map(liveChats.map(chat => [chat.id, chat]));
    const scheduleByChat = new Map<string, ScheduledTaskRecord>();
    for (const task of schedules) {
      if (!scheduleStatuses[task.status]) continue;
      const state = scheduledTaskFocus(task, clock);
      taskStates.set(task.id, state);
      const chatId = task.chatId || task.history?.at(-1)?.chatId;
      if (chatId && knownChatIds.has(chatId)) {
        const current = scheduleByChat.get(chatId);
        if (!current || Number(task.updatedAt || task.createdAt) > Number(current.updatedAt || current.createdAt)) {
          scheduleByChat.set(chatId, task);
        }
      } else if (chatMatchesScope({ workspacePath: task.workspacePath }, chatScope)) {
        unlinkedTasks[state.group].push(task);
      }
    }
    for (const tasks of Object.values(unlinkedTasks)) {
      tasks.sort((a, b) => a.scheduledTimestamp - b.scheduledTimestamp);
    }

    for (const chat of chats) {
      const liveChat = byChat.get(chat.id);
      const trace = liveChat ? readFocusTrace(liveChat.traceLogs) : undefined;
      const task = scheduleByChat.get(chat.id);
      const taskState = task && taskStates.get(task.id);
      const awaitingInput = trace?.status === 'input';
      const working = !awaitingInput && (runningChats?.has(chat.id) || taskState?.group === 'working');
      const activityAt = Math.max(trace?.activityAt || 0, taskState?.activityAt || 0);
      const focusUpdatedAt = chat.focusUpdatedAt || 0;
      const wakeAt = !task && chat.focusWakeAt && activityAt <= focusUpdatedAt
        ? chat.focusWakeAt : undefined;
      const taskSettledAt = taskState?.group === 'settled' ? task?.focusSettledAt || 0 : 0;
      const settledAt = taskSettledAt > focusUpdatedAt ? taskSettledAt : chat.focusSettled ? focusUpdatedAt : 0;
      const settled = !awaitingInput && settledAt > 0 && activityAt <= settledAt;
      const group = working ? 'working' : settled ? 'settled' : 'attention';
      const scheduledStatus = taskState?.attentionStatus;
      const hasPendingSchedule = scheduledStatus === 'scheduled' || scheduledStatus === 'queued' ||
        scheduledStatus === 'paused' || scheduledStatus === 'woke';
      const status: FocusStatus | undefined = working ? 'working' : awaitingInput ? 'input' : settled ? 'settled'
        : wakeAt ? (wakeAt > clock ? 'snoozed' : 'woke')
          : hasPendingSchedule ? scheduledStatus : trace?.status || scheduledStatus;

      groups[group].push(chat);
      details.set(chat.id, {
        group,
        status,
        task,
        question: awaitingInput ? trace?.question : undefined,
        model: resolveFocusModel(trace, liveChat?.modelSelection || chat.modelSelection) || parseModelEntryKey(task?.model),
        nextRunAt: wakeAt || (task && ['scheduled', 'queued', 'paused'].includes(task.status) ? task.scheduledTimestamp : undefined),
        commits: mergeChatCommitReceipts(
          liveChat?.workspaceCommits,
          liveChat ? readChatCommitTraces(liveChat.traceLogs, chat.id) : undefined,
        ),
      });
    }
    return { groups, details, unlinkedTasks, taskStates };
  }, [enabled, liveChats, chats, chatScope, knownChatIds, runningChats, schedules, clock]);

  return { ...focusState, getWorkspace };
}

const statusStyles = {
  working: { label: 'Working', icon: LoaderCircle },
  input: { label: 'Input', icon: MessageCircleQuestionMark },
  done: { label: 'Done', icon: CircleCheck },
  failed: { label: 'Failed', icon: CircleAlert },
  stopped: { label: 'Stopped', icon: CircleStop },
  scheduled: { label: 'Scheduled', icon: AlarmClock },
  queued: { label: 'Queued', icon: Clock3 },
  paused: { label: 'Paused', icon: CirclePause },
  snoozed: { label: 'Snoozed', icon: AlarmClock },
  woke: { label: 'Woke', icon: AlarmClock },
  settled: { label: 'Settled', icon: CircleCheck },
} satisfies Record<FocusStatus, { label: string; icon: typeof CircleCheck }>;

function FocusProvider({ model, fallback }: {
  model?: ModelSelectorEntry | null;
  fallback?: 'anthropic' | 'codex';
}) {
  const provider = model?.provider || fallback;
  if (!provider) return null;
  const name = provider === 'anthropic' ? 'Claude' : providerLabel(provider);
  const label = model?.modelId ? name + ' · ' + model.modelId : name;
  return (
    <span role="img" aria-label={label} title={label} className="eterx-sidebar-focus-provider">
      {provider === 'anthropic' ? (
        <span className="eterx-sidebar-focus-claude" aria-hidden="true" />
      ) : (
        <ProviderIconAsset provider={provider} className="size-[18px]"
          color={provider === 'openai' || provider === 'codex' ? 'currentColor' : undefined} />
      )}
    </span>
  );
}

function FocusWorkspaceLabel({ workspace, showCustomIcon = false }: { workspace: FocusWorkspace; showCustomIcon?: boolean }) {
  const preference = useWorkspaceIcon(showCustomIcon ? workspace.path : null);
  return (
    <>
      <WorkspaceAvatar workspace={workspace} descriptor={workspace.avatar} preference={preference} size={18} />
      <span className="eterx-sidebar-focus-workspace" title={workspace.path || workspace.name}>{workspace.name}</span>
    </>
  );
}

export function FocusChatPreview({
  title, workspace, status, settled, date, model, fallback, commits, task, nextRunAt,
}: {
  title: string;
  workspace: FocusWorkspace;
  status?: FocusStatus;
  settled: boolean;
  date?: string;
  model?: ModelSelectorEntry | null;
  fallback?: 'anthropic' | 'codex';
  commits: ChatCommitReceipt[];
  task?: ScheduledTaskRecord;
  nextRunAt?: number;
}) {
  const branch = commits.find(commit => Boolean(commit.branch))?.branch;
  const statusLabel = settled ? 'Settled' : status ? statusStyles[status].label : undefined;
  return (
    <div className="eterx-focus-preview-details">
      <strong>{title}</strong>
      <div className="eterx-focus-preview-line"><FocusWorkspaceLabel workspace={workspace} /></div>
      {branch && (
        <div className="eterx-focus-preview-line" aria-label={'Last commit branch ' + branch}>
          <GitBranch size={15} aria-hidden="true" />
          <span>{branch}</span>
        </div>
      )}
      {(model || fallback) && (
        <div className="eterx-focus-preview-line">
          <FocusProvider model={model} fallback={fallback} />
          <span>{model?.modelId ? modelLabel(model.modelId) : fallback === 'anthropic' ? 'Claude' : 'Codex'}</span>
        </div>
      )}
      {task && task.title !== title && (
        <div className="eterx-focus-preview-line"><AlarmClock size={15} aria-hidden="true" /><span>{task.title}</span></div>
      )}
      {nextRunAt !== undefined && (
        <div className="eterx-focus-preview-line">
          <AlarmClock size={15} aria-hidden="true" />
          <span>{formatFocusDate(nextRunAt)}{task?.recurrence && !['none', 'once'].includes(task.recurrence) ? ' · ' + task.recurrence : ''}</span>
        </div>
      )}
      {(statusLabel || date) && (
        <div className="eterx-focus-preview-line eterx-focus-preview-date">
          <Clock3 size={15} aria-hidden="true" />
          <span>{[statusLabel, date].filter(Boolean).join(' · ')}</span>
        </div>
      )}
    </div>
  );
}

export function FocusRowContent({
  rowId, workspace, status, age, date, title, metadata, model, fallback, options, commits, actions, input,
}: {
  rowId: string;
  workspace: FocusWorkspace;
  status?: FocusStatus;
  age?: string;
  date?: string;
  title: React.ReactNode;
  metadata?: string;
  model?: ModelSelectorEntry | null;
  fallback?: 'anthropic' | 'codex';
  options?: React.ReactNode;
  commits?: ChatCommitReceipt[];
  actions?: React.ReactNode;
  input?: React.ReactNode;
}) {
  const present = useIsPresent();
  const exitStatuses = usePresenceData() as ReadonlyMap<string, FocusStatus | undefined> | undefined;
  const displayStatus = present ? status : exitStatuses?.get(rowId) || status;
  const indicator = displayStatus && statusStyles[displayStatus];
  const Icon = indicator ? indicator.icon : null;
  const detail = metadata || (model?.modelId ? modelLabel(model.modelId) : undefined);
  return (
    <span className="eterx-sidebar-focus-card">
      <span className="eterx-sidebar-focus-row-header">
        <FocusWorkspaceLabel workspace={workspace} showCustomIcon />
        <span className="eterx-focus-row-end" data-has-actions={present && Boolean(actions) || undefined}>
          {present && input ? input : (
            <span className="eterx-focus-row-result">
              {indicator && Icon ? (
                <span className="eterx-sidebar-focus-status" data-status={displayStatus} title={date}>
                  <span className="eterx-sidebar-focus-status-icon" aria-hidden="true">
                    <Icon size={15} strokeWidth={1.9} />
                  </span>
                  {indicator.label}
                </span>
              ) : age && <span className="eterx-sidebar-focus-age" title={date}>{age}</span>}
            </span>
          )}
          {present && actions}
        </span>
      </span>
      <span className="eterx-sidebar-focus-title-line">{title}</span>
      <span className="eterx-sidebar-focus-row-footer">
        <span className="eterx-sidebar-focus-detail" title={metadata || model?.modelId}>{detail}</span>
        {!!commits?.length && (
          <button
            type="button"
            data-focus-commit-badge
            aria-label={commits.length + (commits.length === 1 ? ' chat commit' : ' chat commits')}
            className="eterx-sidebar-focus-commits"
            onClick={event => event.stopPropagation()}
          >
            <GitCommitHorizontal size={14} aria-hidden="true" />
            {commits.length}
          </button>
        )}
        {options}
        <FocusProvider model={model} fallback={fallback} />
      </span>
    </span>
  );
}

export function FocusTaskRow({ task, workspace, status, onOpen }: {
  task: ScheduledTaskRecord;
  workspace: FocusWorkspace;
  status?: FocusStatus;
  onOpen: (task: ScheduledTaskRecord) => void;
}) {
  const upcoming = task.status === 'scheduled' || task.status === 'queued' || task.status === 'paused';
  const lastRun = task.history?.at(-1);
  const model = parseModelEntryKey(upcoming ? task.model : lastRun?.model) || parseModelEntryKey(task.model);
  const eventAt = upcoming ? task.scheduledTimestamp : lastRun?.completedAt || lastRun?.startedAt || task.updatedAt || task.createdAt;
  const eventTime = new Date(eventAt);
  return (
    <FocusChatHover
      commits={[]}
      disabled={false}
      preview={
        <FocusChatPreview title={task.title} workspace={workspace} status={status} settled={status === 'settled'}
          model={model} commits={[]} task={task} nextRunAt={upcoming ? task.scheduledTimestamp : undefined}
          date={upcoming ? undefined : eventTime.toLocaleString()} />
      }
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={'Open scheduled task ' + task.title}
        className="eterx-sidebar-focus-row"
        data-focus-status={status}
        onClick={event => {
          if (event.currentTarget.contains(event.target as Node)) onOpen(task);
        }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          onOpen(task);
        }}
      >
        <FocusRowContent
          rowId={'task:' + task.id}
          workspace={workspace}
          status={status}
          date={eventTime.toLocaleString()}
          title={<span className="eterx-sidebar-focus-title" title={task.title}>{shortFocusTaskTitle(task.title)}</span>}
          metadata={formatFocusDate(eventAt)}
          model={model}
          actions={canSettleFocusItem(status) && (
            <FocusScheduleActions
              title={task.title}
              task
              settled={status === 'settled'}
              scheduledAt={upcoming ? task.scheduledTimestamp : undefined}
              onSchedule={at => updateScheduledTaskFocus(task.id, { action: 'reschedule', at })}
              onSettle={() => updateScheduledTaskFocus(task.id, { action: status === 'settled' ? 'restore' : 'settle' })}
            />
          )}
        />
      </div>
    </FocusChatHover>
  );
}
