import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Process Manager — Long-Running Task Controller
 * 
 * Start, monitor, and manage background processes.
 * Essential for long-running servers, watch scripts, build processes, etc.
 */

interface ManagedProcess {
  id: string;
  command: string;
  pid: number;
  status: 'running' | 'stopped' | 'crashed';
  startedAt: number;
  output: string[];
  errors: string[];
  process?: ChildProcess;
}

const managedProcesses: Map<string, ManagedProcess> = new Map();

export const processManagerTool: ToolDefinition = {
  name: 'process_manager',
  description: `Manage long-running background processes. Start servers, watch scripts, build processes, or any command that runs continuously. Monitor their output and stop them when needed.
  
  Examples:
  - Start a dev server in the background
  - Run "npm run build --watch" and monitor its output
  - Start a database server
  - Kill a stuck process`,
  category: 'automation',
  inputSchema: z.object({
    action: z.enum(['start', 'stop', 'status', 'logs', 'list', 'kill_all'])
      .describe('Action: start a new process, stop/kill one, check status, view logs, list all'),
    command: z.string().optional().describe('Shell command to start (required for start action)'),
    processId: z.string().optional().describe('Process ID for stop/status/logs actions'),
    name: z.string().optional().describe('Friendly name for the process (e.g., "dev-server")')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    processId: z.string().optional(),
    output: z.string().optional()
  }),
  execute: async (input: any) => {
    console.log(`[Tool: process_manager] Action: ${input.action}`);

    try {
      switch (input.action) {
        case 'start': {
          if (!input.command) return { success: false, message: 'command is required for start action' };

          const id = input.name || `proc_${Date.now()}`;
          const workingDir = path.resolve(process.cwd(), '.workspaces', 'temp');

          const child = spawn(input.command, [], {
            shell: true,
            cwd: workingDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false
          });

          const managed: ManagedProcess = {
            id,
            command: input.command,
            pid: child.pid || 0,
            status: 'running',
            startedAt: Date.now(),
            output: [],
            errors: [],
            process: child
          };

          child.stdout?.on('data', (data) => {
            const line = data.toString().trim();
            if (line) managed.output.push(line);
            // Keep last 100 lines
            if (managed.output.length > 100) managed.output.shift();
          });

          child.stderr?.on('data', (data) => {
            const line = data.toString().trim();
            if (line) managed.errors.push(line);
            if (managed.errors.length > 100) managed.errors.shift();
          });

          child.on('exit', (code) => {
            managed.status = code === 0 ? 'stopped' : 'crashed';
            console.log(`[ProcessManager] Process "${id}" exited with code ${code}`);
          });

          child.on('error', (err) => {
            managed.status = 'crashed';
            managed.errors.push(`Process error: ${err.message}`);
          });

          managedProcesses.set(id, managed);

          return {
            success: true,
            message: `✅ Process "${id}" started (PID: ${child.pid}). Command: ${input.command}`,
            processId: id,
            pid: child.pid
          };
        }

        case 'stop': {
          const proc = findProcess(input.processId || input.name);
          if (!proc) return { success: false, message: `Process not found: ${input.processId || input.name}` };

          try {
            if (proc.process && proc.status === 'running') {
              proc.process.kill('SIGTERM');
              proc.status = 'stopped';
            }
          } catch (e) {
            // Force kill via shell
            if (proc.pid) {
              await execAsync(`taskkill /PID ${proc.pid} /F`, { shell: 'powershell.exe' }).catch(() => {});
            }
            proc.status = 'stopped';
          }
          return { success: true, message: `🛑 Process "${proc.id}" (PID: ${proc.pid}) stopped.` };
        }

        case 'status': {
          const proc = findProcess(input.processId || input.name);
          if (!proc) return { success: false, message: 'Process not found' };

          const uptime = proc.status === 'running' ? `${((Date.now() - proc.startedAt) / 1000).toFixed(0)}s` : 'N/A';
          return {
            success: true,
            message: `Process "${proc.id}": status=${proc.status}, pid=${proc.pid}, uptime=${uptime}, output_lines=${proc.output.length}, error_lines=${proc.errors.length}`,
            processId: proc.id
          };
        }

        case 'logs': {
          const proc = findProcess(input.processId || input.name);
          if (!proc) return { success: false, message: 'Process not found' };

          const recentOutput = proc.output.slice(-20).join('\n');
          const recentErrors = proc.errors.slice(-10).join('\n');
          return {
            success: true,
            message: `Logs for "${proc.id}":`,
            output: `=== STDOUT (last 20 lines) ===\n${recentOutput}\n\n=== STDERR (last 10 lines) ===\n${recentErrors}`
          };
        }

        case 'list': {
          const processes = Array.from(managedProcesses.values()).map(p => ({
            id: p.id,
            command: p.command.substring(0, 80),
            pid: p.pid,
            status: p.status,
            uptime: p.status === 'running' ? `${((Date.now() - p.startedAt) / 1000).toFixed(0)}s` : 'stopped'
          }));
          return {
            success: true,
            message: `${processes.length} managed processes.`,
            processes
          };
        }

        case 'kill_all': {
          let killed = 0;
          for (const proc of Array.from(managedProcesses.values())) {
            if (proc.status === 'running' && proc.process) {
              try { proc.process.kill('SIGTERM'); } catch { }
              proc.status = 'stopped';
              killed++;
            }
          }
          return { success: true, message: `🛑 Killed ${killed} running processes.` };
        }

        default:
          return { success: false, message: 'Unknown action' };
      }
    } catch (error: any) {
      return { success: false, message: `Process manager error: ${error.message}` };
    }
  }
};

function findProcess(idOrName?: string): ManagedProcess | undefined {
  if (!idOrName) return undefined;
  return managedProcesses.get(idOrName) ||
    Array.from(managedProcesses.values()).find(p => p.id === idOrName || p.command.includes(idOrName));
}
