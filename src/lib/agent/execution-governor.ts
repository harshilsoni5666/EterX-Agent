/**
 * Provider-neutral guardrails for an autonomous tool loop.
 *
 * Models are good at choosing a next action, but they cannot reliably observe
 * repetitive failure or stale state by themselves. This controller turns the
 * execution trace into compact, actionable feedback without owning the plan or
 * changing tool permissions.
 *
 * Features:
 *   - Blocks exact AND semantically-similar repeated failures
 *   - Escalating no-progress guidance (3 → 5 → 8 calls)
 *   - Time-based circuit breaker (soft + hard timeout)
 *   - Tool call budget tracking with approaching-limit warnings
 *   - Mutation/verification evidence tracking
 */

export type ExecutionGovernorDecision = {
  allowed: boolean;
  reason?: string;
  recovery?: string;
};

export type ExecutionGovernorSnapshot = {
  toolCalls: number;
  successfulCalls: number;
  consecutiveFailures: number;
  consecutiveNoProgress: number;
  hasMutation: boolean;
  hasVerification: boolean;
  mutationEpoch: number;
  elapsedMs: number;
  budgetRemaining: number | null;
};

export type ExecutionGovernorOptions = {
  /** Max tool calls before forcing completion. Default: 120 (desktop), set lower for telegram. */
  maxToolCalls?: number;
  /** Soft timeout in ms — injects urgent guidance. Default: 10 minutes. */
  softTimeoutMs?: number;
  /** Hard timeout in ms — forces completion. Default: 20 minutes. */
  hardTimeoutMs?: number;
};

type ToolAttempt = {
  signature: string;
  toolName: string;
  mutationEpoch: number;
  success: boolean;
  materialProgress: boolean;
};

const MUTATION_TOOLS = new Set([
  'workspace_write_file',
  'workspace_edit_file',
  'office_artifact_builder',
  'docx_generator',
  'image_generator',
  'video_generator',
  'scheduled_tasks',
]);

const VERIFICATION_TOOLS = new Set([
  'workspace_verify_code',
  'realtime_verify',
]);

const REFRESH_SENSITIVE_TOOLS = new Set([
  'browser_control',
  'web_search',
  'web_scraper',
  'deep_research',
  'workspace_read_file',
  'workspace_read_many_files',
  'workspace_search_text',
  'workspace_semantic_search',
  'workspace_file_outline',
  'workspace_list_directory',
  'workspace_find_files',
]);

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * Normalize a file path for fuzzy comparison: lowercase, forward slashes,
 * collapse repeated separators, strip trailing slash.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

/**
 * Check if two tool call signatures are semantically similar even if not
 * byte-identical.  Covers: same file with different path separators or case,
 * same command with trivial whitespace differences, same search query
 * with minor rewording (token overlap ≥ 80%).
 */
function isSemanticallyDuplicateSignature(sigA: string, sigB: string): boolean {
  if (sigA === sigB) return true;

  // Split into toolName + serialized args
  const colonA = sigA.indexOf(':');
  const colonB = sigB.indexOf(':');
  if (colonA < 0 || colonB < 0) return false;
  const toolA = sigA.slice(0, colonA);
  const toolB = sigB.slice(0, colonB);
  if (toolA !== toolB) return false;

  const argsA = sigA.slice(colonA + 1);
  const argsB = sigB.slice(colonB + 1);

  // Path-based tools: normalize paths before comparing
  if (toolA.startsWith('workspace_')) {
    if (normalizePath(argsA) === normalizePath(argsB)) return true;
    // Collapse whitespace for command strings
    if (argsA.replace(/\s+/g, ' ').trim() === argsB.replace(/\s+/g, ' ').trim()) return true;
  }

  // Token overlap for search/research queries
  if (toolA.includes('search') || toolA === 'deep_research' || toolA === 'web_scraper') {
    const tokensA = new Set(argsA.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 2));
    const tokensB = new Set(argsB.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 2));
    if (tokensA.size === 0 || tokensB.size === 0) return false;
    let overlap = 0;
    for (const t of tokensA) { if (tokensB.has(t)) overlap++; }
    const similarity = overlap / Math.min(tokensA.size, tokensB.size);
    if (similarity >= 0.8) return true;
  }

  return false;
}

function outputSucceeded(output: any): boolean {
  if (output === undefined || output === null) return false;
  if (typeof output === 'string') return !/\b(error|failed|denied|not found)\b/i.test(output);
  if (output.error || output.CRITICAL_ERROR || output.cancelled) return false;
  if (output.success === false || output.passed === false || output.verified === false) return false;
  if (Array.isArray(output.errors) && output.errors.length > 0) return false;
  const exitCode = output.exitCode ?? output.code ?? output.exit_code;
  return typeof exitCode !== 'number' || exitCode === 0;
}

function commandLooksLikeVerification(args: Record<string, any>): boolean {
  return /\b(test|lint|build|typecheck|tsc|pytest|vitest|jest|playwright|verify|check)\b/i.test(
    String(args?.command || args?.script || ''),
  );
}

function outputHasArtifact(output: any): boolean {
  return Boolean(
    output?.path || output?.filePath ||
    (Array.isArray(output?.filesCreated) && output.filesCreated.length > 0) ||
    (Array.isArray(output?.filesModified) && output.filesModified.length > 0) ||
    (Array.isArray(output?.artifacts) && output.artifacts.length > 0),
  );
}

/**
 * Tracks actual tool outcomes during one agent run. It only blocks an exact
 * retry after the same action has already failed twice against unchanged state;
 * refresh-sensitive reads and all mutations remain available to the planner.
 */
export class ExecutionGovernor {
  private readonly attempts: ToolAttempt[] = [];
  private mutationEpoch = 0;
  private consecutiveFailures = 0;
  private consecutiveNoProgress = 0;
  private hasMutation = false;
  private hasVerification = false;
  private readonly startTime = Date.now();
  private readonly maxToolCalls: number;
  private readonly softTimeoutMs: number;
  private readonly hardTimeoutMs: number;
  private softTimeoutFired = false;
  private hardTimeoutFired = false;

  constructor(options: ExecutionGovernorOptions = {}) {
    this.maxToolCalls = options.maxToolCalls ?? 120;
    this.softTimeoutMs = options.softTimeoutMs ?? 10 * 60 * 1000; // 10 min
    this.hardTimeoutMs = options.hardTimeoutMs ?? 20 * 60 * 1000; // 20 min
  }

  public beforeTool(toolName: string, args: Record<string, any> = {}): ExecutionGovernorDecision {
    const normalizedName = String(toolName || '').trim();

    // Hard timeout — force completion regardless of tool type
    const elapsed = Date.now() - this.startTime;
    if (elapsed >= this.hardTimeoutMs) {
      return {
        allowed: false,
        reason: `Hard timeout reached (${Math.round(elapsed / 60_000)} min). The execution must complete now.`,
        recovery: 'Synthesize all progress so far into a final answer. Do not start new work.',
      };
    }

    // Budget exhausted
    if (this.attempts.length >= this.maxToolCalls) {
      return {
        allowed: false,
        reason: `Tool call budget exhausted (${this.attempts.length}/${this.maxToolCalls}). Complete the task with what you have.`,
        recovery: 'Report what was accomplished and any remaining work. Do not make more tool calls.',
      };
    }

    if (!normalizedName || MUTATION_TOOLS.has(normalizedName) || REFRESH_SENSITIVE_TOOLS.has(normalizedName)) {
      return { allowed: true };
    }

    const signature = this.signature(normalizedName, args);

    // Check for exact OR semantically-similar failed attempts in the current mutation epoch
    const failedAttempts = this.attempts.filter(attempt =>
      !attempt.success &&
      attempt.mutationEpoch === this.mutationEpoch &&
      (attempt.signature === signature || isSemanticallyDuplicateSignature(attempt.signature, signature)),
    );

    if (failedAttempts.length >= 2) {
      return {
        allowed: false,
        reason: `This ${normalizedName} call (or a semantically similar one) has already failed ${failedAttempts.length} times without any workspace change.`,
        recovery: 'Inspect the latest error, change the inputs or strategy, or use a different tool. Do not repeat the same call unchanged.',
      };
    }

    return { allowed: true };
  }

  public recordTool(toolName: string, args: Record<string, any> = {}, output: any): void {
    const normalizedName = String(toolName || '').trim();
    if (!normalizedName) return;

    const success = outputSucceeded(output);
    const isMutation = MUTATION_TOOLS.has(normalizedName);
    const isVerification = VERIFICATION_TOOLS.has(normalizedName) ||
      (normalizedName === 'workspace_run_command' && commandLooksLikeVerification(args));
    const materialProgress = success && (isMutation || isVerification || outputHasArtifact(output));

    this.attempts.push({
      signature: this.signature(normalizedName, args),
      toolName: normalizedName,
      mutationEpoch: this.mutationEpoch,
      success,
      materialProgress,
    });

    if (!success) {
      this.consecutiveFailures++;
      this.consecutiveNoProgress++;
      return;
    }

    this.consecutiveFailures = 0;
    if (materialProgress) {
      this.consecutiveNoProgress = 0;
    } else {
      this.consecutiveNoProgress++;
    }

    if (isMutation) {
      this.hasMutation = true;
      this.mutationEpoch++;
    }
    if (isVerification) this.hasVerification = true;
  }

  public buildGuidance(): string {
    const notices: string[] = [];
    const elapsed = Date.now() - this.startTime;

    // Consecutive failure warnings
    if (this.consecutiveFailures >= 2) {
      notices.push(`Recent actions have failed ${this.consecutiveFailures} times in a row. Change strategy; inspect the error and do not repeat an unchanged action.`);
    }

    // Escalating no-progress guidance: 3 → 5 → 8
    if (this.consecutiveNoProgress >= 8) {
      notices.push(`URGENT: ${this.consecutiveNoProgress} consecutive tool calls without material progress. You MUST either use a different tool, produce a concrete artifact, or state the exact blocker in your final answer. Do not continue exploratory calls.`);
    } else if (this.consecutiveNoProgress >= 5) {
      notices.push(`No material progress in ${this.consecutiveNoProgress} consecutive calls. State what is blocking you or change your approach. Do not repeat similar exploratory actions.`);
    } else if (this.consecutiveNoProgress >= 3) {
      notices.push(`Recent actions have not produced artifacts or verification results. Focus on the next concrete step that creates a file, runs a check, or directly advances the task.`);
    }

    // Verification gap
    if (this.hasMutation && !this.hasVerification) {
      notices.push('Workspace changes exist without recorded verification. Before claiming the task works or tests pass, run an appropriate focused check or state that verification was not run.');
    }

    // Soft timeout warning
    if (elapsed >= this.softTimeoutMs && !this.softTimeoutFired) {
      this.softTimeoutFired = true;
      notices.push(`Execution has been running for ${Math.round(elapsed / 60_000)} minutes. Prioritize completing the most important remaining work. Wrap up soon.`);
    }

    // Budget approaching warning (at 80%)
    const budgetUsed = this.attempts.length / this.maxToolCalls;
    if (budgetUsed >= 0.8 && budgetUsed < 1.0) {
      notices.push(`Tool call budget: ${this.attempts.length}/${this.maxToolCalls} used (${Math.round(budgetUsed * 100)}%). Prioritize completing the most important remaining work.`);
    }

    return notices.length > 0
      ? `[RUNTIME EXECUTION GOVERNOR]\n${notices.map(notice => `- ${notice}`).join('\n')}\n[END RUNTIME EXECUTION GOVERNOR]`
      : '';
  }

  public snapshot(): ExecutionGovernorSnapshot {
    return {
      toolCalls: this.attempts.length,
      successfulCalls: this.attempts.filter(attempt => attempt.success).length,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveNoProgress: this.consecutiveNoProgress,
      hasMutation: this.hasMutation,
      hasVerification: this.hasVerification,
      mutationEpoch: this.mutationEpoch,
      elapsedMs: Date.now() - this.startTime,
      budgetRemaining: this.maxToolCalls - this.attempts.length,
    };
  }

  /** Whether the hard timeout has been reached. */
  public isTimedOut(): boolean {
    return (Date.now() - this.startTime) >= this.hardTimeoutMs;
  }

  /** Whether the tool call budget is exhausted. */
  public isBudgetExhausted(): boolean {
    return this.attempts.length >= this.maxToolCalls;
  }

  private signature(toolName: string, args: Record<string, any>): string {
    return `${toolName}:${stableSerialize(args)}`;
  }
}
