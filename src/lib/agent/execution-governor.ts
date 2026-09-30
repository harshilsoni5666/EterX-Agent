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
 *   - Optional time and tool-call boundaries when explicitly configured
 *   - Mutation/verification evidence tracking
 */

import { classifyToolSemantics, getToolResultOutcome, toolResultChangedState, toolResultMadeProgress, toolResultSucceeded } from './tool-semantics';
import { ObservationProgressTracker, stampObservation, type ObservationStamp } from './observation-progress';

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
  /** Optional max tool calls. Omitted means no fixed tool-call limit. */
  maxToolCalls?: number;
  /** Soft timeout in ms — injects urgent guidance. Default: 10 minutes. */
  softTimeoutMs?: number;
  /** Optional hard timeout in ms. Omitted means no fixed runtime cutoff. */
  hardTimeoutMs?: number;
  /** Restore run-local control state after a provider/key retry. */
  state?: ExecutionGovernorState | null;
};

export type ExecutionGovernorAttempt = {
  signature: string;
  toolName: string;
  mutationEpoch: number;
  success: boolean;
  materialProgress: boolean;
  observation?: ObservationStamp;
};

export type ExecutionGovernorState = {
  attempts: ExecutionGovernorAttempt[];
  mutationEpoch: number;
  consecutiveFailures: number;
  consecutiveNoProgress: number;
  hasMutation: boolean;
  hasVerification: boolean;
  startedAt: number;
  softTimeoutFired: boolean;
};

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
  const normalized = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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

  // Only paths are case-insensitive on Windows. Search/replacement content
  // and quoted shell arguments must keep their exact bytes for retry identity.
  if (toolA.startsWith('workspace_')) {
    const normalizeTargets = (args: Record<string, any>): Record<string, any> => {
      const normalized = { ...args };
      for (const key of ['filename', 'path', 'filePath', 'cwd']) {
        if (typeof normalized[key] === 'string') normalized[key] = normalizePath(normalized[key]);
      }
      if (Array.isArray(normalized.files)) normalized.files = normalized.files.map(normalizeTargets);
      return normalized;
    };
    try {
      return stableSerialize(normalizeTargets(JSON.parse(argsA))) === stableSerialize(normalizeTargets(JSON.parse(argsB)));
    } catch { return false; }
  }

  // Token overlap for search/research queries
  if (toolA.includes('search')) {
    const tokensA = new Set(argsA.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 2));
    const tokensB = new Set(argsB.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 2));
    if (tokensA.size === 0 || tokensB.size === 0) return false;
    let overlap = 0;
    for (const t of tokensA) { if (tokensB.has(t)) overlap++; }
    const similarity = overlap / Math.max(tokensA.size, tokensB.size);
    if (similarity >= 0.8) return true;
  }

  return false;
}

/**
 * Tracks actual tool outcomes during one agent run. It only blocks an exact
 * retry after the same action has already failed twice against unchanged state;
 * refresh-sensitive reads and all mutations remain available to the planner.
 */
export class ExecutionGovernor {
  private readonly attempts: ExecutionGovernorAttempt[] = [];
  private readonly observations: ObservationProgressTracker;
  private mutationEpoch = 0;
  private consecutiveFailures = 0;
  private consecutiveNoProgress = 0;
  private hasMutation = false;
  private hasVerification = false;
  private readonly startTime: number;
  private readonly maxToolCalls: number | null;
  private readonly softTimeoutMs: number;
  private readonly hardTimeoutMs: number | null;
  private softTimeoutFired = false;
  private hardTimeoutFired = false;

  constructor(options: ExecutionGovernorOptions = {}) {
    this.observations = new ObservationProgressTracker(options.state?.attempts);
    this.maxToolCalls = Number.isFinite(options.maxToolCalls) && Number(options.maxToolCalls) > 0
      ? Math.floor(Number(options.maxToolCalls))
      : null;
    this.softTimeoutMs = options.softTimeoutMs ?? 10 * 60 * 1000; // 10 min
    this.hardTimeoutMs = Number.isFinite(options.hardTimeoutMs) && Number(options.hardTimeoutMs) > 0
      ? Math.floor(Number(options.hardTimeoutMs))
      : null;
    this.startTime = options.state?.startedAt || Date.now();
    if (options.state) {
      this.attempts.push(...options.state.attempts.map(attempt => ({ ...attempt })));
      this.mutationEpoch = Math.max(0, options.state.mutationEpoch || 0);
      this.consecutiveFailures = Math.max(0, options.state.consecutiveFailures || 0);
      this.consecutiveNoProgress = Math.max(0, options.state.consecutiveNoProgress || 0);
      this.hasMutation = Boolean(options.state.hasMutation);
      this.hasVerification = Boolean(options.state.hasVerification);
      this.softTimeoutFired = Boolean(options.state.softTimeoutFired);
    }
  }

  public beforeTool(toolName: string, args: Record<string, any> = {}): ExecutionGovernorDecision {
    const normalizedName = String(toolName || '').trim();

    // Hard timeout — force completion regardless of tool type
    const elapsed = Date.now() - this.startTime;
    if (this.hardTimeoutMs !== null && elapsed >= this.hardTimeoutMs) {
      return {
        allowed: false,
        reason: `Hard timeout reached (${Math.round(elapsed / 60_000)} min). The execution must complete now.`,
        recovery: 'Synthesize all progress so far into a final answer. Do not start new work.',
      };
    }

    // Budget exhausted
    if (this.maxToolCalls !== null && this.attempts.length >= this.maxToolCalls) {
      return {
        allowed: false,
        reason: `Tool call budget exhausted (${this.attempts.length}/${this.maxToolCalls}). Complete the task with what you have.`,
        recovery: 'Report what was accomplished and any remaining work. Do not make more tool calls.',
      };
    }

    const semantics = classifyToolSemantics(normalizedName, args);
    if (!normalizedName || semantics.isRefreshSensitive) {
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

    const success = toolResultSucceeded(output);
    const semantics = classifyToolSemantics(normalizedName, args);
    const isMutation = toolResultChangedState(output, semantics);
    const isVerification = semantics.isVerification;
    const observation = semantics.effect === 'observation' && getToolResultOutcome(output) === 'completed'
      ? stampObservation(normalizedName, args, output) : undefined;
    const novelObservation = this.observations.record(observation, this.mutationEpoch);
    const materialProgress = toolResultMadeProgress(output, semantics) && novelObservation;

    this.attempts.push({
      signature: this.signature(normalizedName, args),
      toolName: normalizedName,
      mutationEpoch: this.mutationEpoch,
      success,
      materialProgress,
      ...(observation ? { observation } : {}),
    });

    if (isMutation) {
      this.hasMutation = true;
      this.mutationEpoch++;
      this.hasVerification = false;
    } else if (success && semantics.effect === 'command' && getToolResultOutcome(output) === 'completed') {
      // A script or native program can repair dependencies without producing
      // an editor diff. Its completion invalidates an unchanged-state retry
      // assumption, but does not prove that it modified or verified files.
      this.mutationEpoch++;
    }

    if (!success) {
      this.consecutiveFailures++;
      this.consecutiveNoProgress++;
      return;
    }

    // An accepted background job is neither a failed tactic nor completed work.
    if (getToolResultOutcome(output) === 'pending') return;

    this.consecutiveFailures = 0;
    if (materialProgress) {
      this.consecutiveNoProgress = 0;
    } else {
      this.consecutiveNoProgress++;
    }

    if (isVerification && getToolResultOutcome(output) === 'completed') this.hasVerification = true;
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
      notices.push(`${this.consecutiveNoProgress} calls have not advanced the task. Stop repeating unchanged discovery. If a process is pending, wait on its task ID; otherwise use the existing evidence to correct the specific cause or report a real blocker. This counter is not a deadline or a reason to invent an artifact.`);
    } else if (this.consecutiveNoProgress >= 5) {
      notices.push(`No material progress in ${this.consecutiveNoProgress} consecutive calls. State what is blocking you or change your approach. Do not repeat similar exploratory actions.`);
    } else if (this.consecutiveNoProgress >= 3) {
      notices.push('Recent actions have not advanced the task. Reuse established paths and results, read the actual blocker, and take the next useful step toward the requested outcome. Do not restart setup or add checks that the user declined.');
    }
    const repeatedReads = this.attempts.slice(-6).filter(attempt => attempt.observation && !attempt.materialProgress).length;
    if (repeatedReads >= 2) {
      notices.push(`${repeatedReads} recent reads returned unchanged evidence. Reuse the existing result, narrow the next read to an unanswered question, or act on what is already known. Fresh reads remain available when state may have changed; repeating a read is not itself progress.`);
    }

    // Verification gap
    if (this.hasMutation && !this.hasVerification) {
      notices.push('Workspace changes are recorded, but runtime verification is not. Do not claim tests passed or behavior is proven. Verify only when relevant and permitted; when the user declined checks, report that limitation and continue the requested work.');
    }

    // Soft timeout warning
    if (elapsed >= this.softTimeoutMs && !this.softTimeoutFired) {
      this.softTimeoutFired = true;
      notices.push(`Execution has been running for ${Math.round(elapsed / 60_000)} minutes. Follow WORK NOTES and the user's communication preferences: if the user needs an update and a recent note has not already covered it, briefly describe actual progress or a consequential wait and remaining work. Do not repeat an unchanged update solely because this reminder appeared. Continue the authorized task; elapsed time alone is not a completion criterion.`);
    }

    // Budget approaching warning (at 80%)
    const budgetUsed = this.maxToolCalls === null ? 0 : this.attempts.length / this.maxToolCalls;
    if (this.maxToolCalls !== null && budgetUsed >= 0.8 && budgetUsed < 1.0) {
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
      budgetRemaining: this.maxToolCalls === null ? null : this.maxToolCalls - this.attempts.length,
    };
  }

  public exportState(): ExecutionGovernorState {
    return {
      attempts: this.attempts.map(attempt => ({ ...attempt })),
      mutationEpoch: this.mutationEpoch,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveNoProgress: this.consecutiveNoProgress,
      hasMutation: this.hasMutation,
      hasVerification: this.hasVerification,
      startedAt: this.startTime,
      softTimeoutFired: this.softTimeoutFired,
    };
  }

  /** Whether the hard timeout has been reached. */
  public isTimedOut(): boolean {
    return this.hardTimeoutMs !== null && (Date.now() - this.startTime) >= this.hardTimeoutMs;
  }

  /** Whether the tool call budget is exhausted. */
  public isBudgetExhausted(): boolean {
    return this.maxToolCalls !== null && this.attempts.length >= this.maxToolCalls;
  }

  private signature(toolName: string, args: Record<string, any>): string {
    return `${toolName}:${stableSerialize(args)}`;
  }
}
