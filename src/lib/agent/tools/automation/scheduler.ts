import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';

/**
 * Cron Scheduler / Heartbeat Tool
 * 
 * Schedules recurring tasks that execute automatically.
 * This is the "heartbeat" — the agent can proactively check things
 * without the user asking.
 */

interface ScheduledTask {
  id: string;
  name: string;
  intervalMs: number;
  command: string;
  type: 'shell' | 'reminder' | 'check';
  enabled: boolean;
  lastRun: number | null;
  nextRun: number;
  runCount: number;
  createdAt: number;
  timerId?: ReturnType<typeof setInterval>;
}

// Global task store
const scheduledTasks: Map<string, ScheduledTask> = new Map();

// Callbacks for task execution
type TaskCallback = (task: ScheduledTask) => Promise<void>;
let globalTaskCallback: TaskCallback | null = null;

export function setSchedulerCallback(cb: TaskCallback) {
  globalTaskCallback = cb;
}

export const schedulerTool: ToolDefinition = {
  name: 'task_scheduler',
  description: `Schedule recurring automated tasks (heartbeat system). The agent can set up proactive monitoring, reminders, health checks, or any repeating action. Tasks run in the background at specified intervals. 
  
  Examples:
  - "Check email every 30 minutes"
  - "Monitor server health every 5 minutes"  
  - "Send a daily summary at 9 AM"
  - "Backup workspace files every hour"`,
  category: 'automation',
  inputSchema: z.object({
    action: z.enum(['create', 'list', 'pause', 'resume', 'delete', 'run_now'])
      .describe('Scheduler action to perform'),
    taskName: z.string().optional().describe('Name/ID of the scheduled task'),
    intervalMinutes: z.number().optional().describe('How often to run (in minutes). Min: 1, Max: 1440 (24h)'),
    command: z.string().optional().describe('The shell command or action description to execute'),
    taskType: z.enum(['shell', 'reminder', 'check']).optional().default('shell')
      .describe('Type: shell (run command), reminder (notification), check (health check)')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    tasks: z.array(z.any()).optional()
  }),
  execute: async (input: any) => {
    console.log(`[Tool: task_scheduler] Action: ${input.action}`);

    try {
      switch (input.action) {
        case 'create': {
          if (!input.taskName || !input.intervalMinutes || !input.command) {
            return { success: false, message: 'taskName, intervalMinutes, and command are required for create.' };
          }

          const intervalMs = Math.max(60000, Math.min(input.intervalMinutes * 60000, 86400000));
          const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(7)}`;

          const task: ScheduledTask = {
            id: taskId,
            name: input.taskName,
            intervalMs,
            command: input.command,
            type: input.taskType || 'shell',
            enabled: true,
            lastRun: null,
            nextRun: Date.now() + intervalMs,
            runCount: 0,
            createdAt: Date.now()
          };

          // Set up the interval timer
          task.timerId = setInterval(async () => {
            if (!task.enabled) return;
            task.lastRun = Date.now();
            task.runCount++;
            task.nextRun = Date.now() + task.intervalMs;
            console.log(`[Scheduler] Heartbeat: Running "${task.name}" (run #${task.runCount})`);
            
            if (globalTaskCallback) {
              await globalTaskCallback(task);
            }
          }, intervalMs);

          scheduledTasks.set(taskId, task);

          // Persist schedule to disk
          await persistSchedule();

          return {
            success: true,
            message: `✅ Scheduled task "${input.taskName}" created. Will run every ${input.intervalMinutes} minutes. ID: ${taskId}`,
            taskId
          };
        }

        case 'list': {
          const tasks = Array.from(scheduledTasks.values()).map(t => ({
            id: t.id,
            name: t.name,
            interval: `${t.intervalMs / 60000} min`,
            command: t.command.substring(0, 100),
            type: t.type,
            enabled: t.enabled,
            runCount: t.runCount,
            lastRun: t.lastRun ? new Date(t.lastRun).toISOString() : 'Never',
            nextRun: new Date(t.nextRun).toISOString()
          }));
          return { success: true, message: `${tasks.length} scheduled tasks found.`, tasks };
        }

        case 'pause': {
          const task = findTask(input.taskName);
          if (!task) return { success: false, message: `Task "${input.taskName}" not found.` };
          task.enabled = false;
          await persistSchedule();
          return { success: true, message: `⏸️ Task "${task.name}" paused.` };
        }

        case 'resume': {
          const task = findTask(input.taskName);
          if (!task) return { success: false, message: `Task "${input.taskName}" not found.` };
          task.enabled = true;
          task.nextRun = Date.now() + task.intervalMs;
          await persistSchedule();
          return { success: true, message: `▶️ Task "${task.name}" resumed.` };
        }

        case 'delete': {
          const task = findTask(input.taskName);
          if (!task) return { success: false, message: `Task "${input.taskName}" not found.` };
          if (task.timerId) clearInterval(task.timerId);
          scheduledTasks.delete(task.id);
          await persistSchedule();
          return { success: true, message: `🗑️ Task "${task.name}" deleted.` };
        }

        case 'run_now': {
          const task = findTask(input.taskName);
          if (!task) return { success: false, message: `Task "${input.taskName}" not found.` };
          task.lastRun = Date.now();
          task.runCount++;
          console.log(`[Scheduler] Manual run: "${task.name}"`);
          if (globalTaskCallback) await globalTaskCallback(task);
          return { success: true, message: `🚀 Task "${task.name}" executed manually (run #${task.runCount}).` };
        }

        default:
          return { success: false, message: 'Unknown action.' };
      }
    } catch (error: any) {
      return { success: false, message: `Scheduler error: ${error.message}` };
    }
  }
};

function findTask(nameOrId: string | undefined): ScheduledTask | undefined {
  if (!nameOrId) return undefined;
  // Search by ID first, then by name
  return scheduledTasks.get(nameOrId) || 
    Array.from(scheduledTasks.values()).find(t => t.name.toLowerCase() === nameOrId.toLowerCase());
}

async function persistSchedule() {
  try {
    const scheduleDir = path.resolve(process.cwd(), '.workspaces', '.memory');
    await fs.ensureDir(scheduleDir);
    const data = Array.from(scheduledTasks.values()).map(({ timerId, ...rest }) => rest);
    await fs.writeJSON(path.join(scheduleDir, 'scheduled_tasks.json'), data, { spaces: 2 });
  } catch (e) {
    console.warn('[Scheduler] Failed to persist schedule:', e);
  }
}
