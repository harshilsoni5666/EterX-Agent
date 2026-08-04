/**
 * ═══════════════════════════════════════════════════════════════
 * EXECUTION MONITOR — Real-time Agent Cognition Dashboard
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * Tracks the agent's cognitive state in real-time:
 * - Thinking Velocity: Progress rate
 * - Confidence Score: Estimated output quality
 * - Strategy Tracker: Current approach + fallbacks
 * - Token Budget: Live context usage
 * - Loop Detection: Spinning without progress
 * - Effort Estimation: Completion percentage
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionMetrics {
  /** Total iterations completed */
  iterations: number;
  /** Total tool calls made */
  toolCalls: number;
  /** Successful tool calls */
  successfulCalls: number;
  /** Failed tool calls */
  failedCalls: number;
  /** Files created */
  filesCreated: number;
  /** Files modified */
  filesModified: number;
  /** Current confidence (0-100%) */
  confidence: number;
  /** Estimated completion (0-100%) */
  completionEstimate: number;
  /** Time elapsed in ms */
  elapsedMs: number;
  /** Thinking velocity (tool calls per minute) */
  velocity: number;
  /** Is the agent stuck in a loop? */
  isStuck: boolean;
  /** Current strategy description */
  currentStrategy: string;
  /** Context window utilization percentage */
  contextUtilization: number;
  /** Warning messages */
  warnings: string[];
}

export interface ProgressMilestone {
  description: string;
  timestamp: number;
  category: 'exploration' | 'creation' | 'verification' | 'fix';
}

// ─── Core Engine ──────────────────────────────────────────────────────────────

export class ExecutionMonitor {
  private startTime: number = 0;
  private iterations: number = 0;
  private toolCalls: number = 0;
  private successfulCalls: number = 0;
  private failedCalls: number = 0;
  private filesCreated: Set<string> = new Set();
  private filesModified: Set<string> = new Set();
  private milestones: ProgressMilestone[] = [];
  private recentToolNames: string[] = [];
  private currentStrategy: string = 'analyzing';
  private noProgressIterations: number = 0;
  private lastProgressToolCall: number = 0;

  /**
   * Start monitoring a new task execution.
   */
  startTask(strategy?: string): void {
    this.startTime = Date.now();
    this.iterations = 0;
    this.toolCalls = 0;
    this.successfulCalls = 0;
    this.failedCalls = 0;
    this.filesCreated.clear();
    this.filesModified.clear();
    this.milestones = [];
    this.recentToolNames = [];
    this.currentStrategy = strategy || 'analyzing';
    this.noProgressIterations = 0;
    this.lastProgressToolCall = 0;
  }

  /**
   * Record a completed iteration.
   */
  recordIteration(): void {
    this.iterations++;
  }

  /**
   * Record a tool call result.
   */
  recordToolCall(toolName: string, success: boolean, args?: Record<string, any>): void {
    this.toolCalls++;
    if (success) {
      this.successfulCalls++;
    } else {
      this.failedCalls++;
    }

    this.recentToolNames.push(toolName);
    if (this.recentToolNames.length > 30) this.recentToolNames.shift();

    // Track file operations
    const filename = args?.filename || args?.path || '';
    if (success && filename) {
      if (toolName === 'workspace_write_file') {
        this.filesCreated.add(filename);
        this.recordMilestone(`Created: ${String(filename).split(/[\\/]/).pop()}`, 'creation');
      } else if (['workspace_str_replace', 'workspace_apply_patch', 'workspace_edit_file', 'workspace_edit_many_files'].includes(toolName)) {
        this.filesModified.add(filename);
        this.recordMilestone(`Modified: ${String(filename).split(/[\\/]/).pop()}`, 'fix');
      }
    }

    // Track progress
    const productiveTools = new Set([
      'workspace_write_file', 'workspace_str_replace', 'workspace_apply_patch', 'workspace_edit_file', 'workspace_edit_many_files', 'system_shell',
      'workspace_run_command', 'workspace_apply_patch',
      'image_generator', 'video_generator', 'docx_generator', 'office_artifact_builder',
    ]);

    if (productiveTools.has(toolName) && success) {
      this.noProgressIterations = 0;
      this.lastProgressToolCall = this.toolCalls;
    } else {
      // Check if we're making progress
      if (this.toolCalls - this.lastProgressToolCall > 8) {
        this.noProgressIterations++;
      }
    }
  }

  /**
   * Record a progress milestone.
   */
  recordMilestone(description: string, category: ProgressMilestone['category']): void {
    this.milestones.push({
      description,
      timestamp: Date.now(),
      category,
    });
    if (this.milestones.length > 50) this.milestones.shift();
  }

  /**
   * Set the current strategy description.
   */
  setStrategy(strategy: string): void {
    this.currentStrategy = strategy;
  }

  /**
   * Get current execution metrics.
   */
  getMetrics(contextUtilization?: number): ExecutionMetrics {
    const elapsed = Date.now() - this.startTime;
    const velocity = elapsed > 0 ? (this.toolCalls / elapsed) * 60000 : 0; // per minute

    // Estimate completion
    let completionEstimate = 0;
    if (this.toolCalls > 0) {
      // Heuristic: most tasks complete in 5-20 tool calls
      completionEstimate = Math.min(95, (this.toolCalls / 15) * 100);
    }

    // Calculate confidence
    let confidence = 50; // Base
    if (this.toolCalls > 0) {
      const successRate = this.successfulCalls / this.toolCalls;
      confidence = Math.min(95, 30 + successRate * 50 + (this.filesCreated.size + this.filesModified.size) * 5);
    }

    // Loop detection
    const isStuck = this.noProgressIterations >= 3 || this.isInLoop();

    // Warnings
    const warnings: string[] = [];
    if (isStuck) warnings.push('Agent may be stuck — no productive actions for 8+ tool calls');
    if (this.failedCalls > this.successfulCalls && this.toolCalls > 4) {
      warnings.push(`High failure rate: ${this.failedCalls}/${this.toolCalls} calls failed`);
    }
    if (velocity > 30) warnings.push('Very high tool call rate — may be looping');

    return {
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      successfulCalls: this.successfulCalls,
      failedCalls: this.failedCalls,
      filesCreated: this.filesCreated.size,
      filesModified: this.filesModified.size,
      confidence: Math.round(confidence),
      completionEstimate: Math.round(completionEstimate),
      elapsedMs: elapsed,
      velocity: Math.round(velocity * 10) / 10,
      isStuck,
      currentStrategy: this.currentStrategy,
      contextUtilization: contextUtilization || 0,
      warnings,
    };
  }

  /**
   * Build a metrics summary for the system prompt.
   */
  buildMetricsContext(contextUtilization?: number): string {
    const m = this.getMetrics(contextUtilization);
    if (m.toolCalls === 0) return '';

    const parts: string[] = [];
    parts.push(`📊 Progress: ${m.toolCalls} tool calls, ${m.filesCreated} files created, ${m.filesModified} files modified`);

    if (m.isStuck) {
      parts.push('⚠️ LOOP DETECTED — You are not making productive progress. Change approach or deliver what you have.');
    }

    if (m.failedCalls > 2) {
      parts.push(`⚠️ ${m.failedCalls} tool failures — consider alternative approaches.`);
    }

    if (m.warnings.length > 0) {
      for (const w of m.warnings) {
        parts.push(`⚠️ ${w}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Get recent milestones for progress reporting.
   */
  getRecentMilestones(limit: number = 5): ProgressMilestone[] {
    return this.milestones.slice(-limit);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private isInLoop(): boolean {
    if (this.recentToolNames.length < 6) return false;

    // Check for repeating patterns
    const last6 = this.recentToolNames.slice(-6);
    const last3 = this.recentToolNames.slice(-3);

    // Same tool called 4+ times in a row
    const uniqueInLast6 = new Set(last6).size;
    if (uniqueInLast6 === 1 && last6.length >= 4) return true;

    // 2-step pattern repeating 3+ times
    if (last6.length >= 6 &&
      last6[0] === last6[2] && last6[2] === last6[4] &&
      last6[1] === last6[3] && last6[3] === last6[5]) {
      return true;
    }

    return false;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const executionMonitor = new ExecutionMonitor();
