import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_COMMANDS = [
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'zsh',
  'fish',
  'sh',
  'git',
  'node',
  'npm',
  'npx',
  'python',
  'py',
  'rg',
  'docker',
];

export const terminalAccessTool: ToolDefinition = {
  name: 'terminal_access',
  description: `Inspect the local terminal/runtime access available to the agent without executing arbitrary user commands. Use this before environment setup, debugging command failures, choosing PowerShell vs cmd, or explaining what terminal capabilities are available. It reports cwd, OS, shell hints, user/home/temp paths, PATH tool availability, and safe environment metadata without exposing secret values.`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['profile', 'which', 'env_keys']).default('profile')
      .describe('profile = full terminal capability summary; which = resolve command paths; env_keys = list environment variable names without values'),
    commands: z.array(z.string()).optional().describe('Commands to resolve for action="which". Defaults to common developer tools.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    profile: z.any().optional(),
    commands: z.any().optional(),
    envKeys: z.array(z.string()).optional(),
  }),
  execute: async (input: { action?: 'profile' | 'which' | 'env_keys'; commands?: string[] }) => {
    const action = input.action || 'profile';

    if (action === 'env_keys') {
      return {
        success: true,
        envKeys: Object.keys(process.env).sort(),
      };
    }

    const commands = normalizeCommands(input.commands);
    const resolvedCommands = Object.fromEntries(
      commands.map(command => [command, findOnPath(command)])
    );

    if (action === 'which') {
      return {
        success: true,
        commands: resolvedCommands,
      };
    }

    return {
      success: true,
      profile: {
        cwd: process.cwd(),
        user: os.userInfo().username,
        homeDir: os.homedir(),
        tempDir: os.tmpdir(),
        platform: process.platform,
        osType: os.type(),
        osRelease: os.release(),
        arch: process.arch,
        nodeVersion: process.version,
        defaultShell: process.env.ComSpec || process.env.SHELL || 'unknown',
        recommendedShell: process.platform === 'win32'
          ? (resolvedCommands.pwsh || resolvedCommands.powershell || resolvedCommands.cmd)
          : (process.env.SHELL || resolvedCommands.zsh || resolvedCommands.bash || resolvedCommands.sh),
        pathSeparator: path.delimiter,
        isWindows: process.platform === 'win32',
        isElevated: getElevationStatus(),
        safetyModel: {
          defaultScope: 'local machine, current workspace first',
          secretHandling: 'environment values are not returned by this tool',
          longRunningCommands: 'use process_manager, not system_shell or workspace_run_command',
          destructiveActions: 'check with safety_guard before delete/reset/deploy/migration operations',
        },
        availableCommands: resolvedCommands,
      },
    };
  },
};

function normalizeCommands(commands?: string[]): string[] {
  const clean = (commands || DEFAULT_COMMANDS)
    .map(command => String(command || '').trim())
    .filter(Boolean);
  return Array.from(new Set(clean));
}

function findOnPath(command: string): string | null {
  const pathValue = process.env.PATH || '';
  const pathDirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .filter(Boolean)
        .map(ext => ext.toLowerCase())
    : [''];
  const hasExtension = Boolean(path.extname(command));
  const candidateNames = process.platform === 'win32' && !hasExtension
    ? extensions.map(ext => `${command}${ext}`)
    : [command];

  for (const dir of pathDirs) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        try {
          fs.accessSync(candidate, fs.constants.F_OK);
          return candidate;
        } catch {
          // Try next candidate.
        }
      }
    }
  }

  return null;
}

function getElevationStatus(): boolean | null {
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function') return process.getuid() === 0;
    return null;
  }

  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const adminProbe = path.join(systemRoot, 'System32', 'config');
  try {
    fs.accessSync(adminProbe, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
