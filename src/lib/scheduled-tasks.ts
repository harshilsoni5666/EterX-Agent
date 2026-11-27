export type ScheduledTaskStatus = 'scheduled' | 'paused' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ScheduledTaskRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ScheduledTaskRun {
  id: string;
  chatId: string;
  status: ScheduledTaskRunStatus;
  startedAt: number;
  completedAt?: number;
  model: string;
  agentId: string | null;
  agentName: string;
  error?: string;
  /** Manual runs resume this schedule. Null means there was no pending schedule. */
  scheduleStatusAfterRun?: 'scheduled' | 'queued' | 'paused' | null;
}

export interface ScheduledTaskRecord {
  id: string;
  title: string;
  description: string;
  model: string;
  thinkingLevel?: import('./agent/model-routing').MainAgentThinkingLevel;
  agentId: string | null;
  agentName: string;
  priority: 'low' | 'medium' | 'high';
  recurrence: string;
  triggerTime: string;
  dateOption: 'today' | 'tomorrow' | 'custom';
  customDate?: string;
  sources: Array<{ id: string; name: string; type: string; path: string }>;
  /** Device/workspace captured when the schedule was created. */
  workspacePath?: string | null;
  runLocation?: 'local' | 'sandbox' | 'worktree';
  createdAt: number;
  updatedAt?: number;
  scheduledTimestamp: number;
  status: ScheduledTaskStatus;
  executedAt?: number;
  runNowRequestedAt?: number;
  focusSettledAt?: number | null;
  chatId?: string;
  runCount?: number;
  history?: ScheduledTaskRun[];
  lastError?: string;
}

export type ScheduledFocusUpdate = { action: 'reschedule'; at: number | 'now' } | { action: 'settle' | 'restore' };

export function hasActiveTaskSchedule(task: ScheduledTaskRecord) {
  return task.status === 'scheduled' || task.status === 'queued';
}

export function isScheduledTaskDue(task: ScheduledTaskRecord, now: number) {
  return hasActiveTaskSchedule(task) && task.scheduledTimestamp <= now;
}

export function canRunTaskFromFocus(task: ScheduledTaskRecord, settled: boolean) {
  return task.status !== 'running' && !task.runNowRequestedAt && (settled || hasActiveTaskSchedule(task));
}

export function queueScheduledTaskRunNow(task: ScheduledTaskRecord, now = Date.now()) {
  if (task.runNowRequestedAt) return;
  task.runNowRequestedAt = now;
  task.updatedAt = now;
  task.focusSettledAt = null;
}

export function rescheduleTask(task: ScheduledTaskRecord, at: number, now: number): ScheduledTaskRecord {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    ...task,
    scheduledTimestamp: at,
    updatedAt: now,
    status: at <= now ? 'queued' : 'scheduled',
    dateOption: 'custom',
    customDate: [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-'),
    triggerTime: pad(date.getHours()) + ':' + pad(date.getMinutes()),
    runNowRequestedAt: undefined,
    focusSettledAt: null,
  };
}

export function scheduledTaskSection({ status, runNowRequestedAt }: Pick<ScheduledTaskRecord, 'status' | 'runNowRequestedAt'>) {
  if (runNowRequestedAt || status === 'queued' || status === 'running') return 'queue';
  if (status === 'scheduled' || status === 'paused') return 'my-list';
  return 'completed';
}

export const SCHEDULED_TASKS_STORAGE_KEY = 'eterx_scheduled_tasks';
export const SCHEDULED_TASKS_UPDATED_EVENT = 'eterx_scheduled_tasks_updated';
const CUSTOM_INTERVAL = /^(\d+)\s*(min|mins|minute|minutes|hour|hours|day|days|week|weeks)$/;

const fieldMatches = (value: number, field: string, min: number, max: number): boolean => {
  const token = String(field || '*').trim();
  if (token === '*') return true;
  return token.split(',').some(part => {
    const [base, rawStep] = part.split('/');
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step <= 0) return false;
    if (base === '*') return (value - min) % step === 0;
    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(min, Number(rangeMatch[1]));
      const end = Math.min(max, Number(rangeMatch[2]));
      return value >= start && value <= end && (value - start) % step === 0;
    }
    const exact = Number(base);
    return Number.isInteger(exact) && exact >= min && exact <= max && value === exact;
  });
};

const cronFieldRestricted = (field: string) => String(field || '*').trim() !== '*';

const nextCronOccurrence = (expression: string, after: number): number | null => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = 60 * 24 * 366 * 2;
  for (let offset = 0; offset < limit; offset += 1) {
    const dayOfMonthMatches = fieldMatches(candidate.getDate(), dayOfMonth, 1, 31);
    const dayOfWeekMatches = fieldMatches(candidate.getDay(), dayOfWeek, 0, 7) ||
      (candidate.getDay() === 0 && fieldMatches(7, dayOfWeek, 0, 7));
    const dayMatches = cronFieldRestricted(dayOfMonth) && cronFieldRestricted(dayOfWeek)
      ? dayOfMonthMatches || dayOfWeekMatches
      : dayOfMonthMatches && dayOfWeekMatches;
    if (
      fieldMatches(candidate.getMinutes(), minute, 0, 59) &&
      fieldMatches(candidate.getHours(), hour, 0, 23) &&
      dayMatches &&
      fieldMatches(candidate.getMonth() + 1, month, 1, 12)
    ) return candidate.getTime();
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
};

export function computeNextScheduledRun(recurrence: string, after = Date.now()): number | null {
  const rule = String(recurrence || 'none').trim().toLowerCase();
  if (!rule || rule === 'none' || rule === 'once') return null;
  const next = new Date(after);
  if (rule === 'hourly') return after + 60 * 60 * 1000;
  if (rule === 'daily') return after + 24 * 60 * 60 * 1000;
  if (rule === 'weekly') return after + 7 * 24 * 60 * 60 * 1000;
  if (rule === 'weekdays') {
    do {
      next.setDate(next.getDate() + 1);
    } while (next.getDay() === 0 || next.getDay() === 6);
    return next.getTime();
  }
  if (rule.startsWith('custom:')) {
    const custom = rule.slice('custom:'.length).trim();
    const interval = custom.match(CUSTOM_INTERVAL);
    if (interval) {
      const amount = Number(interval[1]);
      const unit = interval[2];
      const multiplier = unit.startsWith('min')
        ? 60 * 1000
        : unit.startsWith('hour')
          ? 60 * 60 * 1000
          : unit.startsWith('day')
            ? 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
      return after + amount * multiplier;
    }
    return nextCronOccurrence(custom, after);
  }
  return null;
}

function nextTaskOccurrence(task: ScheduledTaskRecord, completedAt: number): number | null {
  const rule = task.recurrence.trim().toLowerCase();
  const plannedAt = Number.isFinite(task.scheduledTimestamp) ? task.scheduledTimestamp : completedAt;
  const after = Math.max(plannedAt, completedAt);

  if (rule === 'daily' || rule === 'weekdays' || rule === 'weekly') {
    const planned = new Date(plannedAt);
    const candidate = new Date(after);
    const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(task.triggerTime);
    const hour = time ? Number(time[1]) : planned.getHours();
    const minute = time ? Number(time[2]) : planned.getMinutes();
    if (rule === 'weekly') {
      candidate.setDate(candidate.getDate() + (planned.getDay() - candidate.getDay() + 7) % 7);
    }
    const setRunTime = () => candidate.setHours(hour, minute, planned.getSeconds(), planned.getMilliseconds());
    setRunTime();
    if (candidate.getTime() <= after) {
      candidate.setDate(candidate.getDate() + (rule === 'weekly' ? 7 : 1));
      setRunTime();
    }
    if (rule === 'weekdays') {
      while (candidate.getDay() === 0 || candidate.getDay() === 6) candidate.setDate(candidate.getDate() + 1);
      setRunTime();
    }
    return candidate.getTime();
  }

  if (rule.startsWith('custom:') && !CUSTOM_INTERVAL.test(rule.slice('custom:'.length).trim())) {
    return computeNextScheduledRun(rule, after);
  }

  const first = computeNextScheduledRun(rule, plannedAt);
  if (first === null || !Number.isFinite(first) || first <= plannedAt) return null;
  const interval = first - plannedAt;
  return plannedAt + (Math.floor((after - plannedAt) / interval) + 1) * interval;
}

export function finishScheduledTaskRun(
  task: ScheduledTaskRecord,
  run: ScheduledTaskRun,
  status: 'completed' | 'failed',
  completedAt: number,
  error?: string,
) {
  run.status = status;
  run.completedAt = completedAt;
  run.error = error;
  task.executedAt = completedAt;
  task.lastError = error;

  const resume = run.scheduleStatusAfterRun;
  if (resume === null || resume === 'scheduled' || resume === 'queued' || resume === 'paused') {
    task.status = resume ?? status;
    return;
  }

  const next = nextTaskOccurrence(task, completedAt);
  if (next === null || !Number.isFinite(new Date(next).getTime())) {
    task.status = status;
    return;
  }

  const date = new Date(next);
  const pad = (value: number) => String(value).padStart(2, '0');
  const rule = task.recurrence.trim().toLowerCase();
  task.status = 'scheduled';
  task.scheduledTimestamp = next;
  task.customDate = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
  task.dateOption = 'custom';
  if (rule !== 'daily' && rule !== 'weekdays' && rule !== 'weekly') {
    task.triggerTime = pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
}

export function normalizeScheduledTask(task: Partial<ScheduledTaskRecord>): ScheduledTaskRecord {
  const createdAt = Number(task.createdAt || Date.now());
  const model = String(task.model || 'auto');
  const agentId = task.agentId ? String(task.agentId) : null;
  const agentName = String(task.agentName || (agentId === 'coding' ? 'Coding' : 'General'));
  return {
    id: String(task.id || `task_${Date.now()}_${Math.floor(Math.random() * 10000)}`),
    title: String(task.title || 'Scheduled task'),
    description: String(task.description || task.title || ''),
    model,
    thinkingLevel: task.thinkingLevel,
    agentId,
    agentName,
    priority: ['low', 'medium', 'high'].includes(String(task.priority)) ? task.priority as ScheduledTaskRecord['priority'] : 'medium',
    recurrence: String(task.recurrence || 'none'),
    triggerTime: String(task.triggerTime || '09:00'),
    dateOption: task.dateOption === 'today' || task.dateOption === 'tomorrow' ? task.dateOption : 'custom',
    customDate: task.customDate,
    sources: Array.isArray(task.sources) ? task.sources : [],
    workspacePath: task.workspacePath === null
      ? null
      : String(task.workspacePath || '').trim() || undefined,
    runLocation: task.runLocation === 'worktree' ? 'worktree' : task.runLocation === 'sandbox'
      ? 'sandbox'
      : task.runLocation === 'local'
        ? 'local'
        : undefined,
    createdAt,
    updatedAt: Number(task.updatedAt || createdAt),
    scheduledTimestamp: Number(task.scheduledTimestamp || Date.now()),
    status: ['scheduled', 'paused', 'queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(task.status))
      ? task.status as ScheduledTaskStatus
      : 'scheduled',
    executedAt: task.executedAt,
    runNowRequestedAt: typeof task.runNowRequestedAt === 'number' && Number.isFinite(task.runNowRequestedAt) && task.runNowRequestedAt > 0
      ? task.runNowRequestedAt : undefined,
    focusSettledAt: typeof task.focusSettledAt === 'number' && Number.isFinite(task.focusSettledAt) ? task.focusSettledAt : null,
    chatId: task.chatId,
    runCount: Number(task.runCount || task.history?.length || 0),
    history: Array.isArray(task.history) ? task.history.slice(-100) : [],
    lastError: task.lastError,
  };
}
