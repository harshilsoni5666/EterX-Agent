import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import { resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import { authorizeToolCommand } from '../security/command_broker';

const execAsync = promisify(exec);

/**
 * Process Manager — Long-Running Task Controller
 * 
 * Start, monitor, and manage background processes.
 * Essential for long-running servers, watch scripts, build processes, etc.
 */

export interface ManagedProcess {
  id: string;
  command: string;
  pid: number;
  status: 'running' | 'stopped' | 'crashed';
  startedAt: number;
  cwd: string;
  exitCode?: number | null;
  output: string[];
  errors: string[];
  process?: ChildProcess;
}

export const managedProcesses: Map<string, ManagedProcess> = new Map();

export const processManagerTool: ToolDefinition = {
  name: 'process_manager',
  description: `Manage long-running background processes. Start servers, watch scripts, build processes, or any command that runs continuously. Monitor their output and stop them when needed.
  
  USAGE:
  - Start a dev server: action="start" command="npm run dev" cwd="C:\\Users\\User\\Desktop\\my-project"
  - Monitor output: action="logs" processId="dev-server"
  - Check status: action="status" processId="dev-server"
  - Stop: action="stop" processId="dev-server"

  CRITICAL: Always use ABSOLUTE PATHS for the cwd parameter. Relative paths resolve against the workspace root, not the current directory. NEVER prefix commands with "cd path;".`,
  category: 'automation',
  inputSchema: z.object({
    action: z.enum(['start', 'stop', 'status', 'logs', 'list', 'kill_all'])
      .describe('Action: start a new process, stop/kill one, check status, view logs, list all'),
    command: z.string().optional().describe('Shell command to start (required for start action). Do NOT prefix with "cd path;"'),
    processId: z.string().optional().describe('Process ID for stop/status/logs actions'),
    name: z.string().optional().describe('Friendly name for the process (e.g., "dev-server")'),
    cwd: z.string().optional().describe('ABSOLUTE PATH to the working directory for the command. Required for start action. Example: "C:\\\\Users\\\\User\\\\Desktop\\\\my-project"'),
    shellType: z.enum(['default', 'powershell', 'cmd']).optional().default('default').describe('Shell for start action. Use default unless a command specifically needs PowerShell or cmd.'),
    env: z.string().optional().describe('Optional JSON object string of environment variables, e.g. {"PORT":"3001"}'),
    maxLines: z.number().optional().describe('Maximum output lines to return for action="logs" (default: 100, max: 200)')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    processId: z.string().optional(),
    output: z.string().optional()
  }),
  execute: async (input: any, context?: any) => {
    console.log(`[Tool: process_manager] Action: ${input.action}`);

    try {
      switch (input.action) {
        case 'start': {
          if (!input.command) return { success: false, message: 'command is required for start action' };

          const id = input.name || `proc_${Date.now()}`;
          const workingDir = resolveProcessCwd(input.cwd, context);
          if (!await fs.pathExists(workingDir)) {
            return { success: false, message: `Working directory not found: ${workingDir}` };
          }
          const env = parseStringRecord(input.env);
          const authorization = await authorizeToolCommand({
            command: input.command,
            cwd: workingDir,
            context,
            env,
          });
          if (!authorization.allowed) {
            return {
              success: false,
              message: authorization.reason || 'Command blocked by command broker',
            };
          }

          const shell = input.shellType === 'powershell'
            ? 'powershell.exe'
            : input.shellType === 'cmd'
              ? 'cmd.exe'
              : true;

          const child = spawn(input.command, [], {
            shell,
            cwd: authorization.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
            env: authorization.env
          });

          const managed: ManagedProcess = {
            id,
            command: input.command,
            pid: child.pid || 0,
            status: 'running',
            startedAt: Date.now(),
            cwd: authorization.cwd,
            exitCode: null,
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
            managed.exitCode = code;
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
            pid: child.pid,
            cwd: workingDir
          };
        }

        case 'stop': {
          const proc = findProcess(input.processId || input.name);
          if (!proc) return { success: false, message: `Process not found: ${input.processId || input.name}` };

          try {
            if (proc.process && proc.status === 'running') {
              if (process.platform === 'win32' && proc.pid) {
                const { exec } = require('child_process');
                exec(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true }, () => {});
              } else {
                proc.process.kill('SIGTERM');
              }
              proc.status = 'stopped';
            }
          } catch (e) {
            // Force kill via shell
            if (proc.pid) {
              if (process.platform === 'win32') {
                await execAsync(`taskkill /PID ${proc.pid} /T /F`, { shell: 'powershell.exe' }).catch(() => {});
              } else {
                await execAsync(`kill -9 ${proc.pid}`).catch(() => {});
              }
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
            message: `Process "${proc.id}": status=${proc.status}, pid=${proc.pid}, cwd=${proc.cwd}, uptime=${uptime}, exitCode=${proc.exitCode ?? 'N/A'}, output_lines=${proc.output.length}, error_lines=${proc.errors.length}`,
            processId: proc.id,
            cwd: proc.cwd,
            exitCode: proc.exitCode
          };
        }

        case 'logs': {
          const proc = findProcess(input.processId || input.name);
          if (!proc) return { success: false, message: 'Process not found' };

          const maxLines = Math.min(input.maxLines || 100, 200);
          const recentOutput = proc.output.slice(-maxLines).join('\n');
          const recentErrors = proc.errors.slice(-Math.round(maxLines / 2)).join('\n');
          return {
            success: true,
            message: `Logs for "${proc.id}":`,
            output: `=== STDOUT (last ${maxLines} lines) ===\n${recentOutput}\n\n=== STDERR (last ${Math.round(maxLines / 2)} lines) ===\n${recentErrors}`
          };
        }

        case 'list': {
          const processes = Array.from(managedProcesses.values()).map(p => ({
            id: p.id,
            command: p.command.substring(0, 80),
            pid: p.pid,
            status: p.status,
            cwd: p.cwd,
            exitCode: p.exitCode,
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
              try {
                if (process.platform === 'win32' && proc.pid) {
                  const { exec } = require('child_process');
                  exec(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true }, () => {});
                } else {
                  proc.process.kill('SIGTERM');
                }
              } catch { }
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

function resolveProcessCwd(cwd?: string, context?: any): string {
  return resolveWorkspaceDirectoryForContext(cwd, context);
}

function parseStringRecord(value: Record<string, string> | string | undefined): Record<string, string> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const normalized: Record<string, string> = {};
    for (const [key, recordValue] of Object.entries(parsed)) {
      normalized[key] = String(recordValue);
    }
    return normalized;
  } catch {
    return {};
  }
}
