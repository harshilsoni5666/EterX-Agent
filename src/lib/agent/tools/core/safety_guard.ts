import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';

/**
 * Permission & Safety Guard
 * 
 * Controls what the agent can and cannot do.
 * Enforces sandboxing, blacklists dangerous commands, and logs all operations.
 */

const AUDIT_DIR = path.resolve(process.cwd(), '.workspaces', '.audit');
const BLOCKED_COMMANDS = [
  'format', 'del /s', 'rm -rf /', 'rmdir /s c:', 'shutdown', 'restart-computer',
  'stop-service', 'disable-', 'set-executionpolicy unrestricted',
  'invoke-webrequest.*malware', 'net user', 'reg delete'
];

const BLOCKED_PATHS = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Users\\*\\AppData',
  '/etc', '/usr', '/bin', '/sbin', '/var', '/root'
];

interface AuditEntry {
  timestamp: string;
  tool: string;
  action: string;
  args: string;
  result: 'allowed' | 'blocked';
  reason?: string;
}

export const safetyGuardTool: ToolDefinition = {
  name: 'safety_guard',
  description: `Security and permission management. Check if an action is safe, view blocked commands, audit recent operations, and manage file path restrictions. The agent uses this to self-verify before dangerous operations.`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['check_command', 'check_path', 'audit_log', 'get_rules', 'add_rule']),
    command: z.string().optional().describe('Command to safety-check'),
    path: z.string().optional().describe('File path to validate'),
    rule: z.string().optional().describe('New rule to add to blocklist')
  }),
  outputSchema: z.object({ success: z.boolean(), safe: z.boolean().optional(), message: z.string(), data: z.any().optional() }),
  execute: async (input: any) => {
    await fs.ensureDir(AUDIT_DIR);

    try {
      switch (input.action) {
        case 'check_command': {
          if (!input.command) return { success: false, safe: false, message: 'command required' };
          const cmd = input.command.toLowerCase();
          
          for (const blocked of BLOCKED_COMMANDS) {
            if (cmd.includes(blocked.toLowerCase())) {
              await logAudit('command_check', 'check', input.command, 'blocked', `Matched rule: ${blocked}`);
              return { success: true, safe: false, message: `⛔ BLOCKED: Command matches safety rule "${blocked}". This operation is too dangerous.` };
            }
          }
          
          await logAudit('command_check', 'check', input.command, 'allowed');
          return { success: true, safe: true, message: `✅ Command is safe to execute.` };
        }

        case 'check_path': {
          if (!input.path) return { success: false, safe: false, message: 'path required' };
          const absPath = path.resolve(input.path);
          
          for (const blocked of BLOCKED_PATHS) {
            if (absPath.toLowerCase().startsWith(blocked.toLowerCase().replace('*', ''))) {
              await logAudit('path_check', 'check', input.path, 'blocked', `Protected path: ${blocked}`);
              return { success: true, safe: false, message: `⛔ BLOCKED: Path "${input.path}" is in a protected system directory.` };
            }
          }
          
          // Check if path is within workspace
          const workspaceRoot = path.resolve(process.cwd(), '.workspaces');
          const isInWorkspace = absPath.startsWith(workspaceRoot) || absPath.startsWith(process.cwd());
          
          await logAudit('path_check', 'check', input.path, 'allowed');
          return {
            success: true,
            safe: true,
            message: isInWorkspace ? `✅ Path is within workspace (fully safe).` : `⚠️ Path is outside workspace. Proceed with caution.`,
            inWorkspace: isInWorkspace
          };
        }

        case 'audit_log': {
          const auditFile = path.join(AUDIT_DIR, 'audit.json');
          if (!await fs.pathExists(auditFile)) return { success: true, message: 'No audit entries', data: [] };
          const entries = await fs.readJSON(auditFile);
          return { success: true, message: `${entries.length} audit entries`, data: entries.slice(-20) };
        }

        case 'get_rules': {
          return {
            success: true,
            message: 'Current safety rules',
            data: {
              blockedCommands: BLOCKED_COMMANDS,
              blockedPaths: BLOCKED_PATHS,
              totalRules: BLOCKED_COMMANDS.length + BLOCKED_PATHS.length
            }
          };
        }

        case 'add_rule': {
          if (!input.rule) return { success: false, message: 'rule required' };
          BLOCKED_COMMANDS.push(input.rule.toLowerCase());
          return { success: true, message: `Added safety rule: "${input.rule}"` };
        }

        default: return { success: false, safe: false, message: 'Unknown action' };
      }
    } catch (err: any) {
      return { success: false, safe: false, message: `Safety check error: ${err.message}` };
    }
  }
};

async function logAudit(tool: string, action: string, args: string, result: 'allowed' | 'blocked', reason?: string) {
  try {
    const auditFile = path.join(AUDIT_DIR, 'audit.json');
    const entries: AuditEntry[] = await fs.pathExists(auditFile) ? await fs.readJSON(auditFile) : [];
    entries.push({ timestamp: new Date().toISOString(), tool, action, args: args.substring(0, 200), result, reason });
    if (entries.length > 500) entries.splice(0, entries.length - 500);
    await fs.writeJSON(auditFile, entries, { spaces: 2 });
  } catch { }
}
