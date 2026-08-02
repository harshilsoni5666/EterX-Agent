import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs-extra';
import { resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import { authorizeToolCommand } from '../security/command_broker';
import { getEterxWorkspaceDir } from '../../storage-paths';
import {
  getTerminalBackgroundTaskStatus,
  killTerminalBackgroundTask,
  listTerminalBackgroundTasks,
  runTerminalCommandWithCheckIn,
} from './terminal_background';
import { resolveTerminalShell } from './shell_resolver';

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

const TASKS_DIR = getEterxWorkspaceDir('background_tasks');

function safeTaskId(value: string): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

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

        const managedResult = await runTerminalCommandWithCheckIn({
          command: input.command,
          cwd: authorization.cwd,
          env: authorization.env,
          source: 'background_task',
          description: input.description,
          context,
          shell: resolveTerminalShell(context?.terminalShell),
          immediateHandoff: true,
          surviveRunSettlement: true,
        });
        return {
          success: managedResult.success !== false,
          taskId: managedResult.taskId,
          status: managedResult.status,
          output: managedResult.output || '',
          message: `Background task launched: "${input.description || input.command}" (ID: ${managedResult.taskId}, PID: ${managedResult.pid}). Use mode="check" to monitor progress.`,
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

        const terminalTask = await getTerminalBackgroundTaskStatus(taskId);
        if (terminalTask?.terminalTask) return terminalTask;

        return { success: false, taskId, message: `Task ${taskId} not found. Use mode="list" to see all tasks.` };
      }

      case 'list': {
        const tasks: any[] = await listTerminalBackgroundTasks();

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

        const terminalTask = await killTerminalBackgroundTask(taskId);
        if (terminalTask?.terminalTask) {
          return { ...terminalTask, success: true, message: `Task ${taskId} terminated.` };
        }

        return { success: false, message: `Task ${taskId} not found or not running` };
      }

      default:
        return { success: false, message: `Unknown mode: ${input.mode}` };
    }
  }
};
