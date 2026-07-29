/**
 * SandboxGuard — Enterprise-grade Central Enforcement Point
 *
 * This is the SINGLE SOURCE OF TRUTH for all sandbox security.
 * Every tool call in sandbox mode passes through this guard.
 *
 * IMPORTANT: This guard is ONLY created and used when runLocation === 'sandbox'.
 * When "Work locally" is selected, this module is never instantiated — the agent
 * runs with full permissions exactly as before.
 *
 * 5-Layer Security:
 *   Layer 1: Guard activation (only when sandbox mode)
 *   Layer 2: Tool policy (blocks dangerous tools entirely)
 *   Layer 3: Path jail (read-only from pinned paths, write only to sandbox root)
 *   Layer 4: Command firewall (blocks destructive/network/escape patterns)
 *   Layer 5: Process isolation (sanitized env, resource limits, audit trail)
 */
import path from 'path';
import {
  appendSandboxAudit,
  checkSandboxPath,
  isPathInsideOrEqual,
  SANDBOX_BLOCKED_COMMAND_PATTERNS,
} from './policy';
import type {
  SandboxGuardDecision,
  SandboxSession,
} from './types';

// ═══════════════════════════════════════════════════════════════
// Tools completely blocked in sandbox mode
// ═══════════════════════════════════════════════════════════════

export const SANDBOX_BLOCKED_TOOLS = new Set<string>([
  // Raw shell — use workspace_run_command instead
  // Long-running processes
  'background_task',
  'process_manager',
  // Host control
  'desktop_control',
  'screen_agent',
  'computer',
  'system_automation',
  'system_monitor',
  'clipboard_manager',
  'desktop_notification',
  'text_to_speech',
  // Browser control
  'browser_control',
  // Communication
  'slack_controller',
  'telegram_user_controller',
  'whatsapp_controller',
  'email_manager',
  // Agent spawning
  'spawn_sub_agent',
  // Dynamic code
  'create_dynamic_tool',
  'code_execution_js',
  // Secrets
  'api_key_vault',
  'env_manager',
  // Git (could push to remote)
]);

// Capabilities allowed in sandbox mode — very restricted
export const SANDBOX_ALLOWED_CAPABILITIES = new Set<string>([
  'command.workspace',
  'filesystem.read',
  'filesystem.write',
  'tool.utility',
  'memory.manage',
]);

// ═══════════════════════════════════════════════════════════════
// SandboxGuard Class
// ═══════════════════════════════════════════════════════════════

export class SandboxGuard {
  public readonly session: SandboxSession;

  constructor(session: SandboxSession) {
    this.session = session;
  }

  // ─── Layer 2: Tool Policy ───

  /** Check if a tool is allowed in sandbox mode */
  checkToolAllowed(toolName: string): SandboxGuardDecision {
    if (SANDBOX_BLOCKED_TOOLS.has(toolName)) {
      return {
        allowed: false,
        reason: `🔒 Sandbox: Tool "${toolName}" is disabled in sandbox mode for security. Use workspace_run_command for shell commands.`,
        layer: 'tool_policy',
      };
    }
    return { allowed: true, reason: 'allowed', layer: 'tool_policy' };
  }

  /** Check if a capability is allowed in sandbox mode */
  checkCapabilityAllowed(capability: string): SandboxGuardDecision {
    if (SANDBOX_ALLOWED_CAPABILITIES.has(capability)) {
      return { allowed: true, reason: 'allowed', layer: 'tool_policy' };
    }
    return {
      allowed: false,
      reason: `🔒 Sandbox: Capability "${capability}" is not available in sandbox mode.`,
      layer: 'tool_policy',
    };
  }

  // ─── Layer 3: Path Jail ───

  /** Assert a path can be read (sandbox root + readOnlyPaths) */
  assertCanRead(targetPath: string): SandboxGuardDecision {
    const resolved = path.resolve(targetPath);

    // Check deny list first
    for (const denied of this.session.denyPaths) {
      if (isPathInsideOrEqual(denied, resolved)) {
        return {
          allowed: false,
          reason: `🔒 Sandbox: Read blocked — path is inside denied location (${denied})`,
          resolvedPath: resolved,
          layer: 'path_jail',
        };
      }
    }

    // Allow reads from sandbox root
    if (isPathInsideOrEqual(this.session.root, resolved)) {
      return { allowed: true, reason: 'allowed', resolvedPath: resolved, layer: 'path_jail' };
    }

    // Allow reads from workspace root (the sandbox session workspaceRoot)
    if (isPathInsideOrEqual(this.session.workspaceRoot, resolved)) {
      return { allowed: true, reason: 'allowed', resolvedPath: resolved, layer: 'path_jail' };
    }

    // Allow reads from readOnlyPaths (pinned project folders)
    for (const roPath of this.session.readOnlyPaths) {
      if (isPathInsideOrEqual(roPath, resolved)) {
        return { allowed: true, reason: 'allowed (read-only pinned path)', resolvedPath: resolved, layer: 'path_jail' };
      }
    }

    // Allow reads from allowPaths (includes temp, workspace root, etc.)
    for (const allowed of this.session.allowPaths) {
      if (isPathInsideOrEqual(allowed, resolved)) {
        return { allowed: true, reason: 'allowed', resolvedPath: resolved, layer: 'path_jail' };
      }
    }

    return {
      allowed: false,
      reason: `🔒 Sandbox: Read blocked — path "${resolved}" is outside all allowed roots.`,
      resolvedPath: resolved,
      layer: 'path_jail',
    };
  }

  /** Assert a path can be written (sandbox root ONLY) */
  assertCanWrite(targetPath: string): SandboxGuardDecision {
    const resolved = path.resolve(targetPath);

    // Check deny list first
    for (const denied of this.session.denyPaths) {
      if (isPathInsideOrEqual(denied, resolved)) {
        return {
          allowed: false,
          reason: `🔒 Sandbox: Write blocked — path is inside denied location (${denied})`,
          resolvedPath: resolved,
          layer: 'path_jail',
        };
      }
    }

    // Writes ONLY allowed inside sandbox root
    if (isPathInsideOrEqual(this.session.root, resolved)) {
      return { allowed: true, reason: 'allowed', resolvedPath: resolved, layer: 'path_jail' };
    }

    // Also allow writes to workspace root (which IS the sandbox path)
    if (isPathInsideOrEqual(this.session.workspaceRoot, resolved)) {
      return { allowed: true, reason: 'allowed', resolvedPath: resolved, layer: 'path_jail' };
    }

    // Block write to readOnlyPaths explicitly
    for (const roPath of this.session.readOnlyPaths) {
      if (isPathInsideOrEqual(roPath, resolved)) {
        return {
          allowed: false,
          reason: `🔒 Sandbox: Write blocked — "${resolved}" is a read-only pinned path. You can read from it but cannot modify it.`,
          resolvedPath: resolved,
          layer: 'path_jail',
        };
      }
    }

    return {
      allowed: false,
      reason: `🔒 Sandbox: Write blocked — "${resolved}" is outside the sandbox directory. Writes are restricted to the sandbox workspace only.`,
      resolvedPath: resolved,
      layer: 'path_jail',
    };
  }

  // ─── Layer 4: Command Firewall ───

  /** Assert a command can be executed */
  assertCanExecute(command: string, cwd: string): SandboxGuardDecision {
    const resolvedCwd = path.resolve(cwd);

    // CWD must be inside sandbox root or workspace root
    const cwdCheck = this.assertCanWrite(resolvedCwd);
    if (!cwdCheck.allowed) {
      return {
        allowed: false,
        reason: `🔒 Sandbox: Command blocked — working directory "${resolvedCwd}" is outside sandbox.`,
        resolvedPath: resolvedCwd,
        layer: 'command_firewall',
      };
    }

    const normalized = command.trim();

    // Check against comprehensive blocked command patterns
    for (const pattern of SANDBOX_BLOCKED_COMMAND_PATTERNS) {
      if (pattern.test(normalized)) {
        return {
          allowed: false,
          reason: `🔒 Sandbox: Command blocked — destructive or dangerous pattern detected.`,
          resolvedPath: resolvedCwd,
          layer: 'command_firewall',
        };
      }
    }

    // Block network access when network policy is deny
    if (this.session.network === 'deny' && this._commandHasNetworkAccess(normalized)) {
      return {
        allowed: false,
        reason: '🔒 Sandbox: Command blocked — network access is disabled in sandbox mode.',
        resolvedPath: resolvedCwd,
        layer: 'command_firewall',
      };
    }

    // Block path escapes in command string
    const pathEscapeCheck = this._checkCommandPathEscapes(normalized);
    if (!pathEscapeCheck.allowed) {
      return pathEscapeCheck;
    }

    // Block environment variable references that could leak host info
    const envEscapeCheck = this._checkEnvVariableEscapes(normalized);
    if (!envEscapeCheck.allowed) {
      return envEscapeCheck;
    }

    return { allowed: true, reason: 'allowed', resolvedPath: resolvedCwd, layer: 'command_firewall' };
  }

  // ─── Layer 5: Audit ───

  /** Log an event to the sandbox audit trail */
  async audit(event: { type: string; [key: string]: unknown }): Promise<void> {
    try {
      await appendSandboxAudit(this.session, event);
    } catch (e) {
      console.error('[SandboxGuard] Audit log write failed:', e);
    }
  }

  // ─── Internal helpers ───

  private _commandHasNetworkAccess(command: string): boolean {
    const networkTools = /\b(curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|netcat|nmap|ping|tracert|traceroute|dig|nslookup)\b/i;
    const networkPackageOps = /\b(npm\s+(install|add|publish|login|whoami)|pnpm\s+(install|add)|yarn\s+(add|install)|pip\s+install|python\s+-m\s+pip\s+install|gem\s+install|cargo\s+install|go\s+get|git\s+(clone|fetch|pull|push|remote)|docker\s+(pull|push|run|login))\b/i;
    const powershellNetwork = /\b(invoke-webrequest|iwr|invoke-restmethod|irm|test-netconnection|new-object\s+system\.net|start-bitstransfer|send-mailmessage)\b/i;
    return networkTools.test(command) || networkPackageOps.test(command) || powershellNetwork.test(command);
  }

  private _checkCommandPathEscapes(command: string): SandboxGuardDecision {
    // Match absolute paths in the command
    const pathRegex = /(?:[a-zA-Z]:[/\\][\w_.-]+(?:[/\\][\w_.-]+)*)|(?:\/[\w_.-]+(?:\/[\w_.-]+)+)/g;
    let match;
    const sandboxLower = path.resolve(this.session.root).toLowerCase().replace(/\\/g, '/');
    const workspaceLower = path.resolve(this.session.workspaceRoot).toLowerCase().replace(/\\/g, '/');

    while ((match = pathRegex.exec(command)) !== null) {
      const foundPath = match[0];
      const resolvedFound = path.resolve(foundPath).toLowerCase().replace(/\\/g, '/');

      const isInsideSandbox = resolvedFound === sandboxLower || resolvedFound.startsWith(sandboxLower + '/');
      const isInsideWorkspace = resolvedFound === workspaceLower || resolvedFound.startsWith(workspaceLower + '/');

      if (!isInsideSandbox && !isInsideWorkspace) {
        // Allow system paths (needed for runtimes like python, node, etc.)
        const lowerFound = resolvedFound.toLowerCase();
        if (
          lowerFound.includes('/system32/') ||
          lowerFound.includes('/syswow64/') ||
          lowerFound.includes('/windows/') ||
          lowerFound.includes('/program files') ||
          lowerFound.includes('/node_modules/') ||
          lowerFound.includes('/appdata/local/microsoft/windowsapps') ||
          lowerFound.includes('/.workspaces/')
        ) {
          continue;
        }

        // Check if it's a read-only path (allowed for reads in commands)
        let isReadOnly = false;
        for (const roPath of this.session.readOnlyPaths) {
          const roLower = path.resolve(roPath).toLowerCase().replace(/\\/g, '/');
          if (resolvedFound === roLower || resolvedFound.startsWith(roLower + '/')) {
            isReadOnly = true;
            break;
          }
        }
        if (isReadOnly) continue;

        return {
          allowed: false,
          reason: `🔒 Sandbox: Command blocked — references host path outside sandbox: ${foundPath}`,
          layer: 'command_firewall',
        };
      }
    }

    // Block user directory keywords
    const forbiddenDirKeywords = [
      /\bdesktop\b/i,
      /\bdocuments\b/i,
      /\bdownloads\b/i,
      /\bonedrive\b/i,
      /\buserprofile\b/i,
      /\bhomepath\b/i,
    ];

    for (const pattern of forbiddenDirKeywords) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `🔒 Sandbox: Command blocked — references restricted host directory.`,
          layer: 'command_firewall',
        };
      }
    }

    return { allowed: true, reason: 'allowed', layer: 'command_firewall' };
  }

  private _checkEnvVariableEscapes(command: string): SandboxGuardDecision {
    // Block PowerShell env variable access that could reveal host info
    const envEscapePatterns = [
      /\$env:(userprofile|home|homepath|homedrive|appdata|localappdata|username|computername)/i,
      /%userprofile%/i,
      /%homepath%/i,
      /%homedrive%/i,
      /%appdata%/i,
      /%localappdata%/i,
      /\[Environment\]::GetFolderPath/i,
      /\[Environment\]::GetEnvironmentVariable/i,
    ];

    for (const pattern of envEscapePatterns) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: '🔒 Sandbox: Command blocked — attempts to access host environment variables.',
          layer: 'command_firewall',
        };
      }
    }

    return { allowed: true, reason: 'allowed', layer: 'command_firewall' };
  }
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

/** Create a SandboxGuard bound to a session. Only call when runLocation === 'sandbox'. */
export function createSandboxGuard(session: SandboxSession): SandboxGuard {
  return new SandboxGuard(session);
}
