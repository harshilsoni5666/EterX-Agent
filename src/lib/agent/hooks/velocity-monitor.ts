/**
 * EterX Agent — Execution Velocity Monitor
 * 
 * Tracks execution velocity in real-time and detects anomalies:
 * - Stall detection: No tool call for extended time → inject nudge
 * - Loop detection: Same tool pattern repeats 3+ times → force strategy shift
 * - Progress estimation: Based on task type + tools used → estimate % complete
 * - Time budget warnings: Simple task taking >20 iterations → warn overcomplication
 * - Velocity decay detection: Tool calls slowing down → suggest different approach
 */

interface ToolCallRecord {
  tool: string;
  args: string;       // Serialized key args for pattern matching
  timestamp: number;
  success: boolean;
  durationMs: number;
}

interface VelocitySnapshot {
  /** Calls per minute over last 5 minutes */
  callsPerMinute: number;
  /** Average duration of recent tool calls */
  avgDurationMs: number;
  /** Is the agent making progress or spinning? */
  trend: 'accelerating' | 'steady' | 'decaying' | 'stalled';
  /** Detected repeating patterns */
  loopPatterns: string[];
  /** Estimated task completion (0-100, -1 if unknown) */
  estimatedProgress: number;
  /** Warnings to surface */
  warnings: string[];
}

interface TaskProfile {
  type: 'simple_question' | 'file_edit' | 'project_creation' | 'research' | 'debugging' | 'complex' | 'unknown';
  expectedIterations: [number, number]; // [min, max]
  expectedTools: string[];
}

export class ExecutionVelocityMonitor {
  private callLog: ToolCallRecord[] = [];
  private iterationCount = 0;
  private taskStartTime = 0;
  private lastCallTime = 0;
  private taskProfile: TaskProfile = { type: 'unknown', expectedIterations: [1, 50], expectedTools: [] };
  private strategyShiftCount = 0;
  private fileArtifactsCreated = 0;
  private readonly MAX_LOG_SIZE = 200;

  /** Reset for a new task */
  reset(): void {
    this.callLog = [];
    this.iterationCount = 0;
    this.taskStartTime = Date.now();
    this.lastCallTime = 0;
    this.taskProfile = { type: 'unknown', expectedIterations: [1, 50], expectedTools: [] };
    this.strategyShiftCount = 0;
    this.fileArtifactsCreated = 0;
  }

  /** Profile the task based on the user's message */
  profileTask(message: string): TaskProfile {
    const lower = message.toLowerCase();
    
    // Simple questions
    if (/^(what|how|why|where|when|who|explain|describe|list|show|tell)\b/i.test(lower) && lower.length < 200) {
      this.taskProfile = { type: 'simple_question', expectedIterations: [1, 5], expectedTools: ['web_search'] };
    }
    // File editing
    else if (/\b(edit|fix|change|update|modify|refactor|rename)\b/i.test(lower) && /\b(file|code|function|class|method)\b/i.test(lower)) {
      this.taskProfile = { type: 'file_edit', expectedIterations: [2, 15], expectedTools: ['workspace_read_file', 'workspace_edit_file', 'workspace_write_file'] };
    }
    // Project creation
    else if (/\b(create|build|make|scaffold|generate|setup|initialize)\b.*\b(project|app|website|api|server|tool)\b/i.test(lower)) {
      this.taskProfile = { type: 'project_creation', expectedIterations: [5, 40], expectedTools: ['workspace_write_file', 'system_shell'] };
    }
    // Research
    else if (/\b(research|find|search|look up|investigate|analyze|compare)\b/i.test(lower)) {
      this.taskProfile = { type: 'research', expectedIterations: [3, 20], expectedTools: ['web_search', 'deep_research'] };
    }
    // Debugging
    else if (/\b(debug|error|fix|bug|crash|issue|broken|not working|fails?)\b/i.test(lower)) {
      this.taskProfile = { type: 'debugging', expectedIterations: [3, 25], expectedTools: ['workspace_read_file', 'workspace_search_text', 'system_shell'] };
    }
    // Complex multi-step
    else if (lower.length > 300 || /\b(then|after that|also|and then|next|finally)\b/i.test(lower)) {
      this.taskProfile = { type: 'complex', expectedIterations: [5, 50], expectedTools: [] };
    }
    else {
      this.taskProfile = { type: 'unknown', expectedIterations: [1, 50], expectedTools: [] };
    }

    this.taskStartTime = Date.now();
    return this.taskProfile;
  }

  /** Record a tool call */
  recordToolCall(tool: string, args: Record<string, any>, success: boolean, durationMs: number): void {
    const argsKey = this.serializeArgs(tool, args);
    this.callLog.push({
      tool,
      args: argsKey,
      timestamp: Date.now(),
      success,
      durationMs,
    });

    this.lastCallTime = Date.now();

    // Track file creation
    if ((tool === 'workspace_write_file' || tool === 'workspace_edit_file') && success) {
      this.fileArtifactsCreated++;
    }

    // Trim log
    if (this.callLog.length > this.MAX_LOG_SIZE) {
      this.callLog = this.callLog.slice(-this.MAX_LOG_SIZE);
    }
  }

  /** Record a new iteration (model turn) */
  recordIteration(): void {
    this.iterationCount++;
  }

  /** Get the current velocity snapshot */
  getSnapshot(): VelocitySnapshot {
    const now = Date.now();
    const warnings: string[] = [];

    // === CALLS PER MINUTE ===
    const fiveMinAgo = now - 5 * 60 * 1000;
    const recentCalls = this.callLog.filter(c => c.timestamp > fiveMinAgo);
    const minutesElapsed = Math.max(1, (now - Math.max(this.taskStartTime, fiveMinAgo)) / 60000);
    const callsPerMinute = recentCalls.length / minutesElapsed;

    // === AVG DURATION ===
    const last10 = this.callLog.slice(-10);
    const avgDurationMs = last10.length > 0
      ? last10.reduce((sum, c) => sum + c.durationMs, 0) / last10.length
      : 0;

    // === TREND DETECTION ===
    let trend: VelocitySnapshot['trend'] = 'steady';
    if (this.callLog.length >= 4) {
      const firstHalf = this.callLog.slice(-10, -5);
      const secondHalf = this.callLog.slice(-5);
      if (firstHalf.length > 0 && secondHalf.length > 0) {
        const firstRate = firstHalf.length / Math.max(1, (firstHalf[firstHalf.length - 1].timestamp - firstHalf[0].timestamp) / 60000);
        const secondRate = secondHalf.length / Math.max(1, (secondHalf[secondHalf.length - 1].timestamp - secondHalf[0].timestamp) / 60000);
        if (secondRate > firstRate * 1.3) trend = 'accelerating';
        else if (secondRate < firstRate * 0.5) trend = 'decaying';
      }
    }
    
    if (this.lastCallTime > 0 && now - this.lastCallTime > 30000) {
      trend = 'stalled';
    }

    // === LOOP PATTERN DETECTION ===
    const loopPatterns: string[] = [];
    if (this.callLog.length >= 6) {
      // Check for 2-tool and 3-tool repeating patterns
      for (const windowSize of [2, 3]) {
        const recent = this.callLog.slice(-windowSize * 4);
        if (recent.length >= windowSize * 3) {
          const windows: string[] = [];
          for (let i = 0; i <= recent.length - windowSize; i += windowSize) {
            const window = recent.slice(i, i + windowSize).map(c => `${c.tool}:${c.args}`).join('→');
            windows.push(window);
          }
          // Check for 3+ repetitions of the same window
          const counts = new Map<string, number>();
          for (const w of windows) {
            counts.set(w, (counts.get(w) || 0) + 1);
          }
          for (const [pattern, count] of counts.entries()) {
            if (count >= 3) {
              const toolNames = pattern.split('→').map(p => p.split(':')[0]).join('→');
              loopPatterns.push(toolNames);
              warnings.push(`LOOP DETECTED: pattern "${toolNames}" repeated ${count}x — try a different approach`);
            }
          }
        }
      }
    }

    // === PROGRESS ESTIMATION ===
    let estimatedProgress = -1;
    const [minIter, maxIter] = this.taskProfile.expectedIterations;
    if (this.taskProfile.type !== 'unknown') {
      // Linear interpolation based on iterations
      estimatedProgress = Math.min(95, Math.round((this.iterationCount / maxIter) * 100));
      // Boost if file artifacts created
      if (this.fileArtifactsCreated > 0 && this.taskProfile.type === 'project_creation') {
        estimatedProgress = Math.min(95, estimatedProgress + this.fileArtifactsCreated * 5);
      }
    }

    // === TIME BUDGET WARNINGS ===
    if (this.iterationCount > maxIter && this.taskProfile.type !== 'unknown') {
      warnings.push(`Task is taking ${this.iterationCount} iterations (expected max: ${maxIter}). Consider simplifying or delivering partial results.`);
    }

    // Excessive failure rate
    const recentResults = this.callLog.slice(-10);
    const failureRate = recentResults.filter(c => !c.success).length / Math.max(1, recentResults.length);
    if (failureRate > 0.5 && recentResults.length >= 5) {
      warnings.push(`High failure rate (${Math.round(failureRate * 100)}%) — consider switching tools or approach`);
    }

    // Velocity decay warning
    if (trend === 'decaying') {
      warnings.push('Execution velocity is decaying — the agent may be losing focus');
    }

    return {
      callsPerMinute: Math.round(callsPerMinute * 10) / 10,
      avgDurationMs: Math.round(avgDurationMs),
      trend,
      loopPatterns,
      estimatedProgress,
      warnings,
    };
  }

  /** Generate a nudge message if the agent needs intervention */
  generateNudge(): string | null {
    const snapshot = this.getSnapshot();

    if (snapshot.loopPatterns.length > 0) {
      this.strategyShiftCount++;
      return `[VELOCITY MONITOR] 🔄 Loop pattern detected: ${snapshot.loopPatterns.join(', ')}. ` +
        `You have repeated the same tool sequence ${3}+ times. SHIFT STRATEGY NOW: ` +
        `try a completely different tool, combine steps, or deliver what you have.`;
    }

    if (snapshot.warnings.length > 0 && this.iterationCount > this.taskProfile.expectedIterations[1]) {
      return `[VELOCITY MONITOR] ⚠️ ${snapshot.warnings[0]}`;
    }

    return null;
  }

  /** Get a compact status line for logging */
  getStatusLine(): string {
    const snap = this.getSnapshot();
    const progress = snap.estimatedProgress >= 0 ? ` ${snap.estimatedProgress}%` : '';
    return `[velocity: ${snap.callsPerMinute} calls/min, trend: ${snap.trend}, iter: ${this.iterationCount}${progress}]`;
  }

  /** Serialize args for pattern matching (only key identifiers, not full content) */
  private serializeArgs(tool: string, args: Record<string, any>): string {
    switch (tool) {
      case 'workspace_read_file':
      case 'workspace_write_file':
      case 'workspace_edit_file':
        return String(args?.filename || args?.path || '').split('/').pop() || '';
      case 'web_search':
      case 'deep_research':
        return String(args?.query || args?.topic || '').substring(0, 50);
      case 'system_shell':
      case 'workspace_run_command':
        return String(args?.command || '').substring(0, 40);
      case 'workspace_search_text':
        return String(args?.pattern || args?.query || '').substring(0, 30);
      default:
        return Object.values(args || {}).map(v => String(v).substring(0, 20)).join(',').substring(0, 50);
    }
  }
}

/** Singleton instance */
export const velocityMonitor = new ExecutionVelocityMonitor();
