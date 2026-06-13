import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import { resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import { authorizeToolCommand } from '../security/command_broker';

const execAsync = promisify(exec);

/**
 * Background Task Runner — Autonomous Job Engine
 * 
 * NEXT-GEN CONCEPT: The agent can launch background tasks that run
 * independently while the main agent continues responding to the user.
 * 
 * USE CASES:
 * - Long-running downloads or installations
 * - Code compilation in background
 * - Data processing pipelines
 * - File watching and auto-rebuilding
 * - API polling at intervals
 * - Scheduled tasks
 * 
 * Tasks write their status/output to .workspaces/background_tasks/
 * The agent can check on them at any time.
 */

const TASKS_DIR = path.resolve(process.cwd(), '.workspaces', 'background_tasks');

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveUnder(parent: string, ...segments: string[]): string {
  const resolved = path.resolve(parent, ...segments);
  if (!isPathInside(parent, resolved)) {
    throw new Error(`Resolved path escapes expected directory: ${resolved}`);
  }
  return resolved;
}

function safeTaskId(value: string): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, data, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}

async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeFile(tmpPath, data, 'utf8');
  await fs.move(tmpPath, filePath, { overwrite: true });
}

function killProcessTree(pid?: number): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => undefined);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { }
  }
}

interface BackgroundTask {
  id: string;
  command: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  output?: string;
  error?: string;
  pid?: number;
}

// In-memory task tracking
const activeTasks: Map<string, BackgroundTask> = new Map();

export const backgroundTaskTool: ToolDefinition = {
  name: 'background_task',
  description: `Launch, monitor, or manage background tasks. Tasks run independently while you continue other work.

MODES:
- "launch": Start a command in the background. Returns immediately with a task ID.
- "check": Check status/output of a background task by ID.
- "list": List all active and completed background tasks.
- "kill": Terminate a running background task.

EXAMPLES:
- Launch: { mode: "launch", command: "npm run build", description: "Building project" }
- Check: { mode: "check", taskId: "bg_1234" }
- List: { mode: "list" }
- Kill: { mode: "kill", taskId: "bg_1234" }

Use for: long installs, builds, data processing, file watching, anything that takes time.`,
  category: 'core',
  inputSchema: z.object({
    mode: z.enum(['launch', 'check', 'list', 'kill']).describe('Operation mode'),
    command: z.string().optional().describe('Command to run (for launch mode)'),
    description: z.string().optional().describe('Human description of the task (for launch mode)'),
    taskId: z.string().optional().describe('Task ID (for check/kill modes)'),
    cwd: z.string().optional().describe('Working directory for the command')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    taskId: z.string().optional(),
    tasks: z.array(z.any()).optional(),
    output: z.string().optional(),
    message: z.string()
  }),
  execute: async (input: {
    mode: string, command?: string, description?: string,
    taskId?: string, cwd?: string
  }, context?: any) => {
    await fs.ensureDir(TASKS_DIR);

    switch (input.mode) {
      case 'launch': {
        if (!input.command) {
          return { success: false, message: 'command is required for launch mode' };
        }
        if (context?.abortSignal?.aborted || context?.isCancelled?.()) {
          return { success: false, message: 'Background task launch cancelled by user' };
        }

        const taskId = `bg_${Date.now()}`;
        const workDir = resolveWorkspaceDirectoryForContext(input.cwd, context);
        const authorization = await authorizeToolCommand({
          command: input.command,
          cwd: workDir,
          context,
          timeoutMs: 600000,
        });
        if (!authorization.allowed) {
          return {
            success: false,
            message: authorization.reason || 'Command blocked by command broker',
          };
        }

        const task: BackgroundTask = {
          id: taskId,
          command: input.command,
          description: input.description || input.command,
          status: 'running',
          startedAt: Date.now()
        };
        activeTasks.set(taskId, task);

        console.log(`[BackgroundTask] 🚀 Launching: ${input.command} (${taskId})`);

        // Run in background — don't await
        const outputFile = resolveUnder(TASKS_DIR, `${taskId}_output.txt`);
        const statusFile = resolveUnder(TASKS_DIR, `${taskId}_status.json`);

        // Write initial status
        await writeJsonAtomic(statusFile, task);

        // Execute asynchronously
        const child = exec(input.command, {
          cwd: authorization.cwd,
          env: authorization.env,
          timeout: 600000,  // 10 minute timeout
          maxBuffer: 50 * 1024 * 1024,  // 50MB buffer
          signal: context?.abortSignal,
        }, async (error, stdout, stderr) => {
          const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
          task.output = output.substring(0, 10000);  // Cap at 10KB
          task.completedAt = Date.now();

          if (error) {
            task.status = 'failed';
            task.error = error.message;
          } else {
            task.status = 'completed';
          }

          // Write final output and status
          await writeFileAtomic(outputFile, output).catch(() => {});
          await writeJsonAtomic(statusFile, task).catch(() => {});

          console.log(`[BackgroundTask] ${task.status === 'completed' ? '✅' : '❌'} ${taskId}: ${task.status}`);
        });

        // Stream partial output so check mode can see progress
        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          task.output = ((task.output || '') + text).slice(-10000); // Keep last 10KB
        });
        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          task.output = ((task.output || '') + '\nSTDERR: ' + text).slice(-10000);
        });

        task.pid = child.pid;

        return {
          success: true,
          taskId,
          message: `Background task launched: "${input.description || input.command}" (ID: ${taskId}, PID: ${child.pid}). Use mode="check" to monitor progress.`
        };
      }

      case 'check': {
        if (!input.taskId) {
          return { success: false, message: 'taskId is required for check mode' };
        }
        const taskId = safeTaskId(input.taskId);
        if (!taskId) {
          return { success: false, message: 'Invalid taskId' };
        }

        // Check in-memory first
        const task = activeTasks.get(taskId);
        if (task) {
          const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1);
          const partialOutput = task.output || '(no output yet)';
          const statusHint = task.status === 'running'
            ? `Still running (${elapsed}s elapsed). Use wait_timer seconds=30 then check again.`
            : `${task.status}`;

          return {
            success: true,
            taskId,
            output: partialOutput,
            status: task.status,
            elapsedSeconds: parseFloat(elapsed),
            message: `Task ${taskId}: ${statusHint} | "${task.description}" | Started: ${new Date(task.startedAt).toLocaleTimeString()}${task.completedAt ? ` | Duration: ${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s` : ''}`
          };
        }

        // Check persisted status file
        const statusFile = resolveUnder(TASKS_DIR, `${taskId}_status.json`);
        if (await fs.pathExists(statusFile)) {
          const status = await fs.readJson(statusFile);
          return {
            success: true,
            taskId,
            output: status.output || '',
            status: status.status,
            message: `Task ${taskId}: ${status.status} | "${status.description}"`
          };
        }

        return { success: false, taskId, message: `Task ${taskId} not found. Use mode="list" to see all tasks.` };
      }

      case 'list': {
        const tasks: any[] = [];

        // In-memory tasks
        for (const [id, task] of activeTasks) {
          tasks.push({
            id, status: task.status, description: task.description,
            startedAt: new Date(task.startedAt).toLocaleTimeString(),
            duration: task.completedAt ? `${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s` : 'running'
          });
        }

        // Persisted tasks
        try {
          const files = await fs.readdir(TASKS_DIR);
          for (const file of files) {
            if (file.endsWith('_status.json')) {
              const taskId = file.replace('_status.json', '');
              if (!activeTasks.has(taskId)) {
                const status = await fs.readJson(resolveUnder(TASKS_DIR, file));
                tasks.push({
                  id: taskId, status: status.status, description: status.description,
                  startedAt: new Date(status.startedAt).toLocaleTimeString(),
                  duration: status.completedAt ? `${((status.completedAt - status.startedAt) / 1000).toFixed(1)}s` : 'unknown'
                });
              }
            }
          }
        } catch { }

        return {
          success: true,
          tasks,
          message: `${tasks.length} background tasks. ${tasks.filter(t => t.status === 'running').length} running, ${tasks.filter(t => t.status === 'completed').length} completed.`
        };
      }

      case 'kill': {
        if (!input.taskId) {
          return { success: false, message: 'taskId is required for kill mode' };
        }
        const taskId = safeTaskId(input.taskId);
        if (!taskId) {
          return { success: false, message: 'Invalid taskId' };
        }

        const task = activeTasks.get(taskId);
        if (task && task.pid && task.status === 'running') {
          try {
            killProcessTree(task.pid);
            task.status = 'failed';
            task.error = 'Killed by agent';
            task.completedAt = Date.now();
            await writeJsonAtomic(resolveUnder(TASKS_DIR, `${taskId}_status.json`), task).catch(() => {});
            return { success: true, message: `Task ${taskId} (PID: ${task.pid}) terminated.` };
          } catch (e: any) {
            return { success: false, message: `Could not kill task: ${e.message}` };
          }
        }

        return { success: false, message: `Task ${taskId} not found or not running` };
      }

      default:
        return { success: false, message: `Unknown mode: ${input.mode}` };
    }
  }
};
