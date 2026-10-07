import { randomUUID } from 'crypto';
import { operateBotRoutine } from '../../telegram-bot-routines';
import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { mutateScheduledTasks, loadScheduledTaskSnapshot } from '../../../scheduled-task-store';
import { computeNextScheduledRun, normalizeScheduledTask, type ScheduledTaskRecord } from '../../../scheduled-tasks';

const recurrenceValues = ['none', 'once', 'hourly', 'daily', 'weekdays', 'weekly'] as const;

function validRecurrence(value: string, after: number): boolean {
  return recurrenceValues.includes(value as any) || (value.startsWith('custom:') && computeNextScheduledRun(value, after) !== null);
}

function parseScheduledAt(value: unknown, fallback = Date.now()): number {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error('scheduledAt must be an ISO date/time with a timezone or local offset.');
  return parsed;
}

function scheduleFields(timestamp: number) {
  const date = new Date(timestamp);
  return {
    triggerTime: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    dateOption: 'custom' as const,
    customDate: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
  };
}

export const scheduledTasksTool: ToolDefinition = {
  name: 'scheduled_tasks',
  description: `Create and manage the user's real autonomous schedules shown in the Tasks tab. The first occurrence creates a full normal EterX chat; repeating occurrences continue in that same chat with prior context, while every run is recorded in durable history. It starts the chosen agent/model/thinking level and retains sources.

Use this tool when the user naturally asks to do something later or repeatedly. Resolve relative dates from the system temporal context and pass an exact ISO date/time. Inspect/list before changing an ambiguously named task. Prefer update or rename over creating duplicates.

Operations: list, get, create, update, rename, run_now, pause, resume, delete. Creating without scheduledAt runs as soon as the desktop companion is available. Recurrence supports none, once, hourly, daily, weekdays, weekly, custom:<number minutes|hours|days|weeks>, or custom:<5-field cron>. modelSelection accepts auto or an exact configured model key. agentId accepts null/general, coding, autonomous, or an exact custom-agent ID.`,
  category: 'automation',
  inputSchema: z.object({
    operation: z.enum(['list', 'get', 'create', 'update', 'rename', 'run_now', 'pause', 'resume', 'delete']),
    taskId: z.string().optional().describe('Exact task ID for every operation except list/create.'),
    title: z.string().optional().describe('Concise task/chat title.'),
    instructions: z.string().optional().describe('Complete standalone instructions the scheduled chat should execute.'),
    scheduledAt: z.string().optional().describe('Exact ISO date/time including timezone or offset.'),
    recurrence: z.string().optional().describe('none, once, hourly, daily, weekdays, weekly, custom:<interval>, or custom:<5-field cron>.'),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    modelSelection: z.string().optional().describe('auto or exact configured provider:model key.'),
    thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    agentId: z.string().nullable().optional().describe('null/general, coding, autonomous, or exact custom-agent ID.'),
    agentName: z.string().optional(),
    sources: z.array(z.object({ path: z.string(), name: z.string().optional(), type: z.string().optional() })).optional(),
  }),
  outputSchema: z.any(),
  execute: async (input: any, context?: any) => {
    if (context?.telegramBot) return operateBotRoutine(input, context);
    if (input.operation === 'list') {
      const snapshot = await loadScheduledTaskSnapshot();
      return { success: true, tasks: snapshot.tasks, total: snapshot.tasks.length };
    }

    if (input.operation === 'get') {
      const snapshot = await loadScheduledTaskSnapshot();
      const task = snapshot.tasks.find(item => item.id === input.taskId);
      return task
        ? { success: true, task, history: [...(task.history || [])].reverse() }
        : { success: false, message: `Scheduled task not found: ${input.taskId || '(missing ID)'}` };
    }

    if (input.operation === 'create') {
      const title = String(input.title || '').trim();
      const instructions = String(input.instructions || '').trim();
      if (!title || !instructions) return { success: false, message: 'title and instructions are required.' };
      const timestamp = parseScheduledAt(input.scheduledAt);
      const recurrence = String(input.recurrence || 'none').trim().toLowerCase();
      if (!validRecurrence(recurrence, timestamp)) return { success: false, message: 'Invalid recurrence rule.' };
      const agentId = input.agentId && input.agentId !== 'general' ? String(input.agentId) : null;
      const task = normalizeScheduledTask({
        id: `task_${Date.now()}_${randomUUID().slice(0, 8)}`,
        title,
        description: instructions,
        scheduledTimestamp: timestamp,
        ...scheduleFields(timestamp),
        recurrence,
        priority: input.priority || 'medium',
        model: String(input.modelSelection || 'auto'),
        thinkingLevel: input.thinkingLevel,
        agentId,
        agentName: String(input.agentName || (agentId === 'coding' ? 'Coding' : agentId === 'autonomous' ? 'Autonomous' : agentId || 'General')),
        // Schedules are durable background work. Capture the originating
        // chat's device/workspace so a later visible-chat switch cannot send
        // its terminal commands somewhere else.
        workspacePath: typeof context?.workspacePath === 'string' ? context.workspacePath : undefined,
        runLocation: context?.runLocation === 'sandbox' ? 'sandbox' : context?.runLocation === 'local' ? 'local' : undefined,
        sources: Array.isArray(input.sources) ? input.sources.map((source: any) => ({
          id: randomUUID(),
          path: String(source.path),
          name: String(source.name || String(source.path).split(/[/\\]/).pop() || 'Source'),
          type: String(source.type || 'file'),
        })) : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: timestamp <= Date.now() ? 'queued' : 'scheduled',
        history: [],
        runCount: 0,
      });
      await mutateScheduledTasks(tasks => [task, ...tasks]);
      return { success: true, task, message: timestamp <= Date.now() ? `Queued "${title}" to run now.` : `Scheduled "${title}".` };
    }

    let changed: ScheduledTaskRecord | undefined;
    let message = '';
    let missing = false;
    let deleted = false;
    await mutateScheduledTasks(tasks => {
      const index = tasks.findIndex(task => task.id === input.taskId);
      if (index < 0) { missing = true; return tasks; }
      // Validate on a copy so a rejected update cannot persist earlier fields.
      const task = { ...tasks[index] };
      if (task.status === 'running' && ['update', 'rename', 'run_now', 'pause', 'resume', 'delete'].includes(input.operation)) {
        message = 'A running scheduled task cannot be changed. Stop its chat run first or wait for completion.';
        return tasks;
      }
      if (input.operation === 'delete') {
        message = `Deleted "${task.title}".`;
        deleted = true;
        return tasks.filter(item => item.id !== task.id);
      }
      if (input.operation === 'rename') {
        const title = String(input.title || '').trim();
        if (!title) { message = 'title is required for rename.'; return tasks; }
        task.title = title;
        message = `Renamed task to "${title}".`;
      } else if (input.operation === 'run_now') {
        task.status = 'queued';
        task.scheduledTimestamp = Date.now();
        Object.assign(task, scheduleFields(task.scheduledTimestamp));
        task.lastError = undefined;
        message = `Queued "${task.title}" to run now.`;
      } else if (input.operation === 'pause') {
        task.status = 'paused';
        message = `Paused "${task.title}".`;
      } else if (input.operation === 'resume') {
        task.status = task.scheduledTimestamp <= Date.now() ? 'queued' : 'scheduled';
        message = `Resumed "${task.title}".`;
      } else if (input.operation === 'update') {
        if (input.title !== undefined) {
          const title = String(input.title).trim();
          if (!title) { message = 'title cannot be empty.'; return tasks; }
          task.title = title;
        }
        if (input.instructions !== undefined) {
          const instructions = String(input.instructions).trim();
          if (!instructions) { message = 'instructions cannot be empty.'; return tasks; }
          task.description = instructions;
        }
        if (input.scheduledAt !== undefined) {
          task.scheduledTimestamp = parseScheduledAt(input.scheduledAt);
          Object.assign(task, scheduleFields(task.scheduledTimestamp));
          task.status = task.scheduledTimestamp <= Date.now() ? 'queued' : 'scheduled';
        }
        if (input.recurrence !== undefined) {
          const recurrence = String(input.recurrence).trim().toLowerCase();
          if (!validRecurrence(recurrence, task.scheduledTimestamp)) { message = 'Invalid recurrence rule.'; return tasks; }
          task.recurrence = recurrence;
        }
        if (input.priority) task.priority = input.priority;
        if (input.modelSelection !== undefined) task.model = String(input.modelSelection || 'auto');
        if (input.thinkingLevel !== undefined) task.thinkingLevel = input.thinkingLevel;
        if (input.agentId !== undefined) {
          task.agentId = input.agentId && input.agentId !== 'general' ? String(input.agentId) : null;
          task.agentName = String(input.agentName || task.agentId || 'General');
        } else if (input.agentName !== undefined) task.agentName = String(input.agentName || task.agentName);
        if (Array.isArray(input.sources)) task.sources = input.sources.map((source: any) => ({
          id: randomUUID(), path: String(source.path), name: String(source.name || String(source.path).split(/[/\\]/).pop() || 'Source'), type: String(source.type || 'file'),
        }));
        message = `Updated "${task.title}".`;
      }
      task.updatedAt = Date.now();
      changed = normalizeScheduledTask(task);
      tasks[index] = changed;
      return tasks;
    });
    if (missing) return { success: false, message: `Scheduled task not found: ${input.taskId || '(missing ID)'}` };
    if (deleted) return { success: true, taskId: input.taskId, message };
    if (!changed && message) return { success: false, message };
    return { success: true, task: changed, message };
  },
};
