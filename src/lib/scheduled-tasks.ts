export type ScheduledTaskStatus = 'scheduled' | 'queued' | 'running' | 'completed' | 'failed';
export type ScheduledTaskRunStatus = 'queued' | 'running' | 'completed' | 'failed';

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
}

export interface ScheduledTaskRecord {
  id: string;
  title: string;
  description: string;
  model: string;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  agentId: string | null;
  agentName: string;
  priority: 'low' | 'medium' | 'high';
  recurrence: string;
  triggerTime: string;
  dateOption: 'today' | 'tomorrow' | 'custom';
  customDate?: string;
  sources: Array<{ id: string; name: string; type: string; path: string }>;
  createdAt: number;
  updatedAt?: number;
  scheduledTimestamp: number;
  status: ScheduledTaskStatus;
  executedAt?: number;
  chatId?: string;
  runCount?: number;
  history?: ScheduledTaskRun[];
  lastError?: string;
}

const fieldMatches = (value: number, field: string, min: number, max: number): boolean => {
  const token = String(field || '*').trim();
  if (token === '*') return true;
  return token.split(',').some(part => {
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      return step > 0 && value % step === 0;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(min, Number(rangeMatch[1]));
      const end = Math.min(max, Number(rangeMatch[2]));
      return value >= start && value <= end;
    }
    const exact = Number(part);
    return Number.isInteger(exact) && exact >= min && exact <= max && value === exact;
  });
};

const nextCronOccurrence = (expression: string, after: number): number | null => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = 60 * 24 * 366 * 2;
  for (let offset = 0; offset < limit; offset += 1) {
    if (
      fieldMatches(candidate.getMinutes(), minute, 0, 59) &&
      fieldMatches(candidate.getHours(), hour, 0, 23) &&
      fieldMatches(candidate.getDate(), dayOfMonth, 1, 31) &&
      fieldMatches(candidate.getMonth() + 1, month, 1, 12) &&
      fieldMatches(candidate.getDay(), dayOfWeek, 0, 6)
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
    const interval = custom.match(/^(\d+)\s*(min|mins|minute|minutes|hour|hours|day|days|week|weeks)$/);
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
    createdAt,
    updatedAt: Number(task.updatedAt || createdAt),
    scheduledTimestamp: Number(task.scheduledTimestamp || Date.now()),
    status: ['scheduled', 'queued', 'running', 'completed', 'failed'].includes(String(task.status))
      ? task.status as ScheduledTaskStatus
      : 'scheduled',
    executedAt: task.executedAt,
    chatId: task.chatId,
    runCount: Number(task.runCount || task.history?.length || 0),
    history: Array.isArray(task.history) ? task.history.slice(-100) : [],
    lastError: task.lastError,
  };
}
