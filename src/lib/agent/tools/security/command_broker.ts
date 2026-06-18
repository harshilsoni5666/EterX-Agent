import path from 'path';
import {
  appendSandboxAudit,
  buildSandboxEnv,
  checkSandboxCommand,
  createSandboxSession,
} from '../../../sandbox/policy';
import type { SandboxSession } from '../../../sandbox/types';
import type { SandboxGuard } from '../../../sandbox/sandbox-guard';
import { getRuntimeWorkspaceRoot } from '../../workspace/path_resolver';

export interface CommandBrokerDecision {
  allowed: boolean;
  reason?: string;
  session: SandboxSession;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function verifyCommandPaths(command: string, sandboxRoot: string): { allowed: boolean; reason?: string } {
  // Regex to match absolute paths on Windows and Unix:
  const pathRegex = /(?:[a-zA-Z]:[/\\][\w_.-]+(?:[/\\][\w_.-]+)*)|(?:\/[\w_.-]+(?:\/[\w_.-]+)+)/g;
  let match;
  const normalizedSandbox = path.resolve(sandboxRoot).toLowerCase().replace(/\\/g, '/');

  while ((match = pathRegex.exec(command)) !== null) {
    const foundPath = match[0];
    const resolvedFound = path.resolve(foundPath).toLowerCase().replace(/\\/g, '/');
    
    // Check if the found path is inside or equal to the sandbox root
    const isInside = resolvedFound === normalizedSandbox || resolvedFound.startsWith(normalizedSandbox + '/');
    if (!isInside) {
      // Allow system paths like system32, program files, node_modules
      const lowerFound = resolvedFound.toLowerCase();
      if (
        lowerFound.includes('/system32/') ||
        lowerFound.includes('/syswow64/') ||
        lowerFound.includes('/windows/') ||
        lowerFound.includes('/program files') ||
        lowerFound.includes('/node_modules/') ||
        lowerFound.includes('/AppData/Local/Microsoft/WindowsApps') ||
        lowerFound.includes('/.workspaces/')
      ) {
        continue;
      }
      return {
        allowed: false,
        reason: `Command contains host filesystem path outside sandbox: ${foundPath}`,
      };
    }
  }

  // Also block references to user profiles or home directories via environment variables or common folders
  const forbiddenPatterns = [
    /\bdesktop\b/i,
    /\bdocuments\b/i,
    /\bdownloads\b/i,
    /\bone_drive\b/i,
    /\bonedrive\b/i,
    /\buserprofile\b/i,
    /\bhomepath\b/i,
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Command references restricted host directory keyword: ${command.match(pattern)?.[0]}`,
      };
    }
  }

  return { allowed: true };
}

export async function authorizeToolCommand(input: {
  command: string;
  cwd?: string;
  context?: any;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  network?: 'allow' | 'deny';
}): Promise<CommandBrokerDecision> {
  const workspaceRoot = getRuntimeWorkspaceRoot(input.context);
  const cwd = path.resolve(input.cwd || workspaceRoot);
  const isSandbox = input.context?.runLocation === 'sandbox';
  const session = createSandboxSession({
    tenantId: input.context?.tenantId || 'local',
    userId: input.context?.userId || 'user',
    projectId: input.context?.projectId || input.context?.chatId || 'tool-command',
    sessionId: input.context?.chatId || input.context?.agentId || 'command',
    workspaceRoot,
    allowPaths: isSandbox ? [cwd, workspaceRoot] : [
      cwd,
      ...(Array.isArray(input.context?.allowedPaths) ? input.context.allowedPaths : []),
      ...(Array.isArray(input.context?.paths) ? input.context.paths : []),
    ],
    mode: input.context?.sandboxMode || 'workspace-write',
    network: input.network || input.context?.networkPolicy || 'allow',
    timeoutMs: input.timeoutMs,
  });

  if (isSandbox) {
    // If SandboxGuard is available on context, use it (enterprise enforcement)
    const guard: SandboxGuard | undefined = input.context?.sandboxGuard;
    if (guard) {
      const guardDecision = guard.assertCanExecute(input.command, cwd);
      if (!guardDecision.allowed) {
        await guard.audit({
          type: 'command.blocked',
          command: input.command,
          cwd,
          reason: guardDecision.reason,
          layer: guardDecision.layer,
        });
        return {
          allowed: false,
          reason: guardDecision.reason,
          session,
          cwd,
          env: buildSandboxEnv(session, input.env),
        };
      }
    } else {
      // Fallback: use local verifyCommandPaths
      const pathCheck = verifyCommandPaths(input.command, workspaceRoot);
      if (!pathCheck.allowed) {
        await appendSandboxAudit(session, {
          type: 'command.blocked',
          command: input.command,
          cwd,
          reason: pathCheck.reason,
        });
        return {
          allowed: false,
          reason: pathCheck.reason,
          session,
          cwd,
          env: buildSandboxEnv(session, input.env),
        };
      }
    }
  }

  const decision = checkSandboxCommand(session, input.command, cwd);
  if (!decision.allowed) {
    await appendSandboxAudit(session, {
      type: 'command.blocked',
      command: input.command,
      cwd,
      reason: decision.reason,
    });
    return {
      allowed: false,
      reason: decision.reason,
      session,
      cwd,
      env: buildSandboxEnv(session, input.env),
    };
  }

  await appendSandboxAudit(session, {
    type: 'command.authorized',
    command: input.command,
    cwd,
    timeoutMs: input.timeoutMs,
  });

  return {
    allowed: true,
    session,
    cwd,
    env: buildSandboxEnv(session, input.env),
  };
}
