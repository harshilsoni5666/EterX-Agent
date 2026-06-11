export type SandboxMode = 'read-only' | 'workspace-write' | 'ephemeral';
export type SandboxNetworkPolicy = 'deny' | 'allow';
export type SandboxOperation = 'read' | 'write' | 'execute';

export interface SandboxCreateInput {
  tenantId?: string;
  userId?: string;
  projectId?: string;
  sessionId?: string;
  workspaceRoot?: string;
  mode?: SandboxMode;
  network?: SandboxNetworkPolicy;
  allowPaths?: string[];
  denyPaths?: string[];
  env?: Record<string, string | undefined>;
  maxOutputChars?: number;
  timeoutMs?: number;
}

export interface SandboxSession {
  id: string;
  tenantId: string;
  userId: string;
  projectId: string;
  sessionId: string;
  mode: SandboxMode;
  network: SandboxNetworkPolicy;
  workspaceRoot: string;
  root: string;
  tempRoot: string;
  auditLogPath: string;
  allowPaths: string[];
  denyPaths: string[];
  env: Record<string, string>;
  maxOutputChars: number;
  timeoutMs: number;
  createdAt: string;
}

export interface SandboxDecision {
  allowed: boolean;
  reason: string;
  resolvedPath?: string;
}

export interface SandboxCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface SandboxCommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export interface SandboxAuditEvent {
  type: string;
  [key: string]: unknown;
}
