import path from 'path';
import {
  appendSandboxAudit,
  buildSandboxEnv,
  checkSandboxCommand,
  createSandboxSession,
} from '../../../sandbox/policy';
import type { SandboxSession } from '../../../sandbox/types';
import { getRuntimeWorkspaceRoot } from '../../workspace/path_resolver';

export interface CommandBrokerDecision {
  allowed: boolean;
  reason?: string;
  session: SandboxSession;
  cwd: string;
  env: NodeJS.ProcessEnv;
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
  const session = createSandboxSession({
    tenantId: input.context?.tenantId || 'local',
    userId: input.context?.userId || 'user',
    projectId: input.context?.projectId || input.context?.chatId || 'tool-command',
    sessionId: input.context?.chatId || input.context?.agentId || 'command',
    workspaceRoot,
    allowPaths: [
      cwd,
      ...(Array.isArray(input.context?.allowedPaths) ? input.context.allowedPaths : []),
      ...(Array.isArray(input.context?.paths) ? input.context.paths : []),
    ],
    mode: input.context?.sandboxMode || 'workspace-write',
    network: input.network || input.context?.networkPolicy || 'allow',
    timeoutMs: input.timeoutMs,
  });

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
