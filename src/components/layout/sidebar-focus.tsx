import React from 'react';
import { AlarmClock, CircleAlert, CircleCheck, CirclePause, CircleStop, Clock3, LoaderCircle, MessageCircleQuestionMark } from 'lucide-react';
import { parseModelEntryKey, type ModelSelectorEntry } from '../../lib/agent/model-selector-store';
import { appStorage } from '../../lib/client-storage';
import { chatMatchesScope, type ChatScope } from '../../lib/chat-scope';
import { readFocusTrace, resolveFocusModel, type ChatFocusDisposition, type FocusGroup, type FocusStatus } from '../../lib/chat-focus';
import { useLiveChats, type LiveChatLedger } from '../../lib/live-chat-ledger';
import { SCHEDULED_TASKS_STORAGE_KEY, type ScheduledTaskRecord } from '../../lib/scheduled-tasks';
import { ProviderIconAsset } from '../ui/provider-icon';
import { modelLabel, providerLabel } from '../usage/usage-format';

const scheduleStatuses: Partial<Record<ScheduledTaskRecord['status'], FocusStatus>> = {
  running: 'working', scheduled: 'scheduled', queued: 'queued',
  paused: 'paused', failed: 'failed', completed: 'done',
};

interface FocusChat extends ChatFocusDisposition {
  id: string;
  modelSelection?: string;
}
interface FocusChatDetails {
  group: FocusGroup;
  status?: FocusStatus;
  model?: ModelSelectorEntry | null;
  nextRunAt?: number;
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

  return React.useMemo(() => {
    const groups: Record<FocusGroup, T[]> = { working: [], attention: [], settled: [] };
    const details = new Map<string, FocusChatDetails>();
    const unlinkedTasks: Record<FocusGroup, ScheduledTaskRecord[]> = { working: [], attention: [], settled: [] };
    if (!enabled) return { groups, details, unlinkedTasks };

    const byChat = new Map(liveChats.map(chat => [chat.id, chat]));
    const scheduleByChat = new Map<string, ScheduledTaskRecord>();
    for (const task of schedules) {
      const scheduleStatus = scheduleStatuses[task.status];
      if (!scheduleStatus) continue;
      const chatId = task.chatId || task.history?.at(-1)?.chatId;
      if (chatId && knownChatIds.has(chatId)) {
        const current = scheduleByChat.get(chatId);
        if (!current || Number(task.updatedAt || task.createdAt) > Number(current.updatedAt || current.createdAt)) {
          scheduleByChat.set(chatId, task);
        }
      } else if (scheduleStatus !== 'done' && chatMatchesScope({ workspacePath: task.workspacePath }, chatScope)) {
        unlinkedTasks[scheduleStatus === 'working' ? 'working' : 'attention'].push(task);
      }
    }
    for (const tasks of Object.values(unlinkedTasks)) {
      tasks.sort((a, b) => a.scheduledTimestamp - b.scheduledTimestamp);
    }

    for (const chat of chats) {
      const liveChat = byChat.get(chat.id);
      const trace = liveChat ? readFocusTrace(liveChat.traceLogs) : undefined;
      const task = scheduleByChat.get(chat.id);
      const scheduleStatus = task && scheduleStatuses[task.status];
      const awaitingInput = trace?.status === 'input';
      const working = !awaitingInput && (runningChats?.has(chat.id) || scheduleStatus === 'working');
      const activityAt = Math.max(trace?.activityAt || 0, Number(task?.updatedAt || task?.createdAt || 0));
      const settled = chat.focusSettled && activityAt <= Number(chat.focusUpdatedAt || 0);
      const group = working ? 'working' : settled ? 'settled' : 'attention';
      const status = working ? 'working' : awaitingInput ? 'input'
        : scheduleStatus === 'failed' || scheduleStatus === 'queued' || scheduleStatus === 'scheduled' || scheduleStatus === 'paused'
          ? scheduleStatus : trace?.status || scheduleStatus;

      groups[group].push(chat);
      details.set(chat.id, {
        group,
        status: group === 'settled' ? undefined : status,
        model: resolveFocusModel(trace, liveChat?.modelSelection || chat.modelSelection) || parseModelEntryKey(task?.model),
        nextRunAt: status === 'scheduled' ? task?.scheduledTimestamp : undefined,
      });
    }
    return { groups, details, unlinkedTasks };
  }, [enabled, liveChats, chats, chatScope, knownChatIds, runningChats, schedules]);
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

export function FocusRowContent({
  workspace, workspacePath, status, age, date, title, metadata, model, fallback, options,
}: {
  workspace: string;
  workspacePath?: string | null;
  status?: FocusStatus;
  age?: string;
  date?: string;
  title: React.ReactNode;
  metadata?: string;
  model?: ModelSelectorEntry | null;
  fallback?: 'anthropic' | 'codex';
  options?: React.ReactNode;
}) {
  const indicator = status && statusStyles[status];
  const Icon = indicator ? indicator.icon : null;
  const detail = metadata || (model?.modelId ? modelLabel(model.modelId) : undefined);
  return (
    <span className="eterx-sidebar-focus-card">
      <span className="eterx-sidebar-focus-row-header">
        <span className="eterx-sidebar-focus-folder" aria-hidden="true" />
        <span className="eterx-sidebar-focus-workspace" title={workspacePath || workspace}>{workspace}</span>
        {indicator && Icon ? (
          <span className="eterx-sidebar-focus-status" data-status={status} title={date}>
            <span className="eterx-sidebar-focus-status-icon" aria-hidden="true">
              <Icon size={15} strokeWidth={1.9} />
            </span>
            {indicator.label}
          </span>
        ) : age && <span className="eterx-sidebar-focus-age" title={date}>{age}</span>}
      </span>
      <span className="eterx-sidebar-focus-title-line">{title}</span>
      <span className="eterx-sidebar-focus-row-footer">
        <span className="eterx-sidebar-focus-detail" title={metadata || model?.modelId}>{detail}</span>
        {options}
        <FocusProvider model={model} fallback={fallback} />
      </span>
    </span>
  );
}

export function FocusTaskRow({ task, workspace, onOpen }: {
  task: ScheduledTaskRecord;
  workspace: string;
  onOpen: (task: ScheduledTaskRecord) => void;
}) {
  const upcoming = task.status === 'scheduled' || task.status === 'queued' || task.status === 'paused';
  const lastRun = task.history?.at(-1);
  const model = parseModelEntryKey(upcoming ? task.model : lastRun?.model) || parseModelEntryKey(task.model);
  const eventAt = upcoming ? task.scheduledTimestamp : lastRun?.completedAt || lastRun?.startedAt || task.updatedAt || task.createdAt;
  const eventTime = new Date(eventAt);
  return (
    <button
      type="button"
      className="eterx-sidebar-focus-row"
      data-focus-status={scheduleStatuses[task.status]}
      onClick={() => onOpen(task)}
    >
      <FocusRowContent
        workspace={workspace}
        workspacePath={task.workspacePath}
        status={scheduleStatuses[task.status]}
        date={eventTime.toLocaleString()}
        title={<span className="eterx-sidebar-focus-title" title={task.title}>{task.title}</span>}
        metadata={eventTime.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        model={model}
      />
    </button>
  );
}
