import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { getEterxWorkspaceDir } from '../agent/storage-paths';
import {
  SandboxAuditEvent,
  SandboxCreateInput,
  SandboxDecision,
  SandboxNetworkPolicy,
  SandboxOperation,
  SandboxResourceLimits,
  SandboxSession,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const MAX_SEGMENT_LENGTH = 80;

export const DEFAULT_RESOURCE_LIMITS: SandboxResourceLimits = {
  maxFileSizeBytes: 50 * 1024 * 1024,   // 50MB per file
  maxFileCount: 5000,                    // 5000 files max
  maxTotalDiskBytes: 500 * 1024 * 1024,  // 500MB total
  maxCommandTimeoutMs: 120_000,          // 2 minutes max
};

/** Comprehensive list of dangerous command patterns blocked in sandbox mode */
export const SANDBOX_BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  // Destructive file operations
  /\brm\s+-rf\b/i,
  /\bdel\s+\/[fsq]/i,
  /\brmdir\s+\/s\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  // Registry and system modification
  /\breg\s+(add|delete|import)\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  /\btaskkill\b/i,
  // Permission changes
  /\bchmod\s/i,
  /\bchown\s/i,
  /\bicacls\s/i,
  /\btakeown\s/i,
  // Service manipulation
  /\bsc\s+(create|delete|config|start|stop)\b/i,
  /\bnet\s+(start|stop|user|localgroup)\b/i,
  /\b(start|stop|restart|set)-service\b/i,
  // Scheduled tasks
  /\bschtasks\s/i,
  /\bat\s+\d/i,
  // Execution policy bypass
  /\bset-executionpolicy\b/i,
  // PowerShell remoting
  /\binvoke-command\b/i,
  /\benter-pssession\b/i,
  /\bnew-pssession\b/i,
  // Credential access
  /\bget-credential\b/i,
  /\bcmdkey\b/i,
  /\brunas\b/i,
  // Symbolic link / junction creation (escape sandbox via links)
  /\bmklink\b/i,
  /\bnew-item.*-itemtype\s+(symboliclink|junction|hardlink)\b/i,
  // Environment variable persistence
  /\bsetx\b/i,
  /\[Environment\]::SetEnvironmentVariable/i,
];

const SECRET_ENV_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /private[_-]?key/i,
  /connection[_-]?string/i,
];

/** Environment variable names that must never be exposed to sandbox */
export const SANDBOX_BLOCKED_ENV_VARS: RegExp[] = [
  ...SECRET_ENV_PATTERNS,
  /^HOME$/i,
  /^USERPROFILE$/i,
  /^HOMEPATH$/i,
  /^HOMEDRIVE$/i,
  /^APPDATA$/i,
  /^LOCALAPPDATA$/i,
  /^COMPUTERNAME$/i,
  /^USERNAME$/i,
  /^LOGNAME$/i,
  /^USER$/i,
];

const DEFAULT_DENY_NAMES = [
  '.git',
  '.next',
  'node_modules',
  '.env',
  '.env.local',
  '.env.production',
  '.ssh',
  '.aws',
  '.azure',
  '.config',
];

export function createSandboxSession(input: SandboxCreateInput = {}): SandboxSession {
  const tenantId = sanitizeSegment(input.tenantId || 'local');
  const userId = sanitizeSegment(input.userId || 'user');
  const projectId = sanitizeSegment(input.projectId || 'default');
  const sessionId = sanitizeSegment(input.sessionId || crypto.randomUUID());
  const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd());
  const root = getEterxWorkspaceDir('sandboxes', tenantId, userId, projectId, sessionId);
  const tempRoot = path.join(root, 'tmp');
  const auditLogPath = path.join(root, 'audit.jsonl');

  const resourceLimits: SandboxResourceLimits = {
    ...DEFAULT_RESOURCE_LIMITS,
    ...(input.resourceLimits || {}),
  };

  return {
    id: stableId(tenantId, userId, projectId, sessionId, workspaceRoot),
    tenantId,
    userId,
    projectId,
    sessionId,
    mode: input.mode || 'workspace-write',
    network: input.network || 'deny',
    workspaceRoot,
    root,
    tempRoot,
    auditLogPath,
    allowPaths: uniqueResolvedPaths([workspaceRoot, root, tempRoot, ...(input.allowPaths || [])]),
    denyPaths: uniqueResolvedPaths([...defaultDenyPaths(workspaceRoot), ...(input.denyPaths || [])]),
    readOnlyPaths: uniqueResolvedPaths(input.readOnlyPaths || []),
    env: sanitizeEnvironment(input.env || {}),
    maxOutputChars: input.maxOutputChars || DEFAULT_MAX_OUTPUT_CHARS,
    timeoutMs: input.timeoutMs || DEFAULT_TIMEOUT_MS,
    resourceLimits,
    createdAt: new Date().toISOString(),
  };
}

export async function initializeSandbox(session: SandboxSession): Promise<SandboxSession> {
  await fs.ensureDir(session.root);
  await fs.ensureDir(session.tempRoot);
  await appendSandboxAudit(session, {
    type: 'sandbox.initialized',
    mode: session.mode,
    network: session.network,
    workspaceRoot: session.workspaceRoot,
    allowPaths: session.allowPaths,
  });
  return session;
}

export function checkSandboxPath(
  session: SandboxSession,
  targetPath: string,
  operation: SandboxOperation,
): SandboxDecision {
  const resolvedPath = path.resolve(targetPath);

  for (const denied of session.denyPaths) {
    if (isPathInsideOrEqual(denied, resolvedPath)) {
      return {
        allowed: false,
        reason: `Sandbox blocked ${operation}: path is inside denied location ${denied}`,
        resolvedPath,
      };
    }
  }

  const inAllowedRoot = session.allowPaths.some(root => isPathInsideOrEqual(root, resolvedPath));
  if (!inAllowedRoot) {
    return {
      allowed: false,
      reason: `Sandbox blocked ${operation}: path is outside allowed roots`,
      resolvedPath,
    };
  }

  if (operation === 'write' && session.mode === 'read-only') {
    return {
      allowed: false,
      reason: 'Sandbox is read-only; write operations are disabled',
      resolvedPath,
    };
  }

  if (operation !== 'read' && session.mode === 'ephemeral' && !isPathInsideOrEqual(session.root, resolvedPath)) {
    return {
      allowed: false,
      reason: 'Ephemeral sandbox can only write or execute inside its session root',
      resolvedPath,
    };
  }

  return { allowed: true, reason: 'allowed', resolvedPath };
}

export function checkSandboxCommand(session: SandboxSession, command: string, cwd: string): SandboxDecision {
  const cwdDecision = checkSandboxPath(session, cwd, 'execute');
  if (!cwdDecision.allowed) return cwdDecision;

  const normalized = command.trim().toLowerCase();
  const riskyPatterns = [
    /\brm\s+-rf\b/,
    /\bdel\s+\/[fsq]/,
    /\brmdir\s+\/s\b/,
    /\bformat\b/,
    /\bdiskpart\b/,
    /\breg\s+(add|delete|import)\b/,
    /\bshutdown\b/,
    /\btaskkill\b/,
    /\bchmod\s+-r\b/,
    /\bchown\s+-r\b/,
  ];

  if (riskyPatterns.some(pattern => pattern.test(normalized))) {
    return {
      allowed: false,
      reason: 'Sandbox blocked command: destructive system-level command pattern',
      resolvedPath: cwdDecision.resolvedPath,
    };
  }

  if (session.network === 'deny' && commandLooksLikeNetworkAccess(command)) {
    return {
      allowed: false,
      reason: 'Sandbox blocked command: network access is disabled',
      resolvedPath: cwdDecision.resolvedPath,
    };
  }

  return { allowed: true, reason: 'allowed', resolvedPath: cwdDecision.resolvedPath };
}

export function buildSandboxEnv(
  session: SandboxSession,
  extraEnv: Record<string, string | undefined> = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const cleanBase = sanitizeEnvironment(baseEnv);
  const cleanExtra = sanitizeEnvironment(extraEnv);
  return {
    ...cleanBase,
    ...session.env,
    ...cleanExtra,
    NODE_ENV: baseEnv.NODE_ENV || 'development',
    ETERX_SANDBOX_ID: session.id,
    ETERX_SANDBOX_ROOT: session.root,
    ETERX_SANDBOX_TEMP: session.tempRoot,
    ETERX_SANDBOX_MODE: session.mode,
    ETERX_SANDBOX_NETWORK: session.network,
    HOME: session.tempRoot,
    USERPROFILE: session.tempRoot,
    TMP: session.tempRoot,
    TEMP: session.tempRoot,
  };
}

export async function appendSandboxAudit(session: SandboxSession, event: SandboxAuditEvent): Promise<void> {
  await fs.ensureDir(path.dirname(session.auditLogPath));
  await fs.appendFile(
    session.auditLogPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      sandboxId: session.id,
      tenantId: session.tenantId,
      userId: session.userId,
      projectId: session.projectId,
      sessionId: session.sessionId,
      ...event,
    })}\n`,
    'utf8',
  );
}

export function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function commandLooksLikeNetworkAccess(command: string): boolean {
  const networkTools = /\b(curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|netcat|nmap|ping|tracert|traceroute|dig|nslookup)\b/i;
  const networkPackageOps = /\b(npm\s+(install|add|publish|login|whoami)|pnpm\s+(install|add)|yarn\s+(add|install)|pip\s+install|python\s+-m\s+pip\s+install|gem\s+install|cargo\s+install|go\s+get|git\s+(clone|fetch|pull|push|remote)|docker\s+(pull|push|run|login))\b/i;
  const powershellNetwork = /\b(invoke-webrequest|iwr|invoke-restmethod|irm|test-netconnection|new-object\s+system\.net|start-bitstransfer|send-mailmessage)\b/i;
  const nodeNetwork = /\b(fetch|axios|got|request|http\.get|https\.get|net\.connect|dgram)\b/i;
  return networkTools.test(command) || networkPackageOps.test(command) || powershellNetwork.test(command) || nodeNetwork.test(command);
}

function defaultDenyPaths(workspaceRoot: string): string[] {
  const home = os.homedir();
  return [
    ...DEFAULT_DENY_NAMES.map(name => path.join(workspaceRoot, name)),
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.azure'),
    path.join(home, '.config'),
  ];
}

function sanitizeEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERNS.some(pattern => pattern.test(key))) continue;
    clean[key] = value;
  }
  return clean;
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_SEGMENT_LENGTH);
  return sanitized || 'default';
}

function stableId(tenantId: string, userId: string, projectId: string, sessionId: string, workspaceRoot: string): string {
  const hash = crypto
    .createHash('sha256')
    .update([tenantId, userId, projectId, sessionId, workspaceRoot].join('\0'))
    .digest('hex')
    .slice(0, 12);
  return `sbx_${hash}`;
}

function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}
