export type SandboxMode = 'read-only' | 'workspace-write' | 'ephemeral';
export type SandboxNetworkPolicy = 'deny' | 'allow';
export type SandboxOperation = 'read' | 'write' | 'execute';

export interface SandboxResourceLimits {
  /** Maximum size of a single file in bytes (default: 50MB) */
  maxFileSizeBytes: number;
  /** Maximum number of files the sandbox can create (default: 5000) */
  maxFileCount: number;
  /** Maximum total disk usage in bytes (default: 500MB) */
  maxTotalDiskBytes: number;
  /** Maximum command timeout in ms (default: 120_000) */
  maxCommandTimeoutMs: number;
}

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
  /** Paths the sandbox can read from but never write to (e.g. pinned project folders) */
  readOnlyPaths?: string[];
  env?: Record<string, string | undefined>;
  maxOutputChars?: number;
  timeoutMs?: number;
  resourceLimits?: Partial<SandboxResourceLimits>;
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
  /** Paths the sandbox can read from but never write to */
  readOnlyPaths: string[];
  env: Record<string, string>;
  maxOutputChars: number;
  timeoutMs: number;
  resourceLimits: SandboxResourceLimits;
  createdAt: string;
}

export interface SandboxDecision {
  allowed: boolean;
  reason: string;
  resolvedPath?: string;
}

/** Result from SandboxGuard enforcement checks */
export interface SandboxGuardDecision {
  allowed: boolean;
  reason: string;
  resolvedPath?: string;
  layer?: 'tool_policy' | 'path_jail' | 'command_firewall' | 'process_isolation' | 'resource_limit';
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
