/**
 * ═══════════════════════════════════════════════════════════════
 * PLAN EXECUTION ENGINE — Model-Driven State Machine
 * ═══════════════════════════════════════════════════════════════
 *
 * Philosophy: The MODEL is the intelligence. This engine does NOT
 * try to classify outputs, match keywords, or score confidence.
 * Instead it:
 *
 *   1. Maintains plan state (DAG of steps with status tracking)
 *   2. Generates rich context for the model's prompt so it always
 *      knows WHERE it is in the plan, WHAT has been done, and
 *      WHAT to do next
 *   3. Records an execution trace (which tools were called, what
 *      they returned) so the model has full situational awareness
 *   4. Exposes control actions (advance, skip, fail, replan) that
 *      the model invokes through a tool when IT decides a step
 *      is done — not when a regex thinks so
 *
 * The result: the model's own reasoning drives plan execution,
 * while the engine ensures it never loses track of where it is.
 */

// ─── Plan Step ────────────────────────────────────────────────────────────────

export type StepStatus = 'blocked' | 'ready' | 'active' | 'done' | 'skipped' | 'failed';

export type ExecutionStep = {
  id: string;
  step: number;
  name: string;
  description: string;
  step_type: string;
  tools: string[];
  done_when: string;
  expected_output: string;
  depends_on: number[];
  artifacts: string[];
  risk: string;
  priority: string;

  // Execution state
  status: StepStatus;
  startedAt: number | null;
  completedAt: number | null;
  failureReason: string | null;
  completionReason: string | null;
  completionEvidence: string[];

  // Execution trace — what actually happened during this step
  trace: StepTraceEntry[];
};

export type StepTraceEntry = {
  toolName: string;
  /** First 300 chars of serialized args — enough for the model to recall what it did */
  argsDigest: string;
  /** First 400 chars of output — enough to understand what happened */
  outputDigest: string;
  succeeded: boolean;
  timestamp: number;
};

// ─── Plan State ───────────────────────────────────────────────────────────────

export type PlanState = {
  goal: string;
  steps: ExecutionStep[];
  createdAt: number;
  updatedAt: number;
  status: 'executing' | 'completed' | 'failed';
  totalToolCalls: number;
  revision: number;
  revisionHistory: Array<{ timestamp: number; reason: string }>;
  completionSummary: string | null;
  completionEvidence: string[];
  actionHistory: Array<{
    timestamp: number;
    action: PlanAction['type'];
    stepNumber: number | null;
    reason: string;
    evidence: string[];
  }>;
};

// ─── Plan Control Actions ─────────────────────────────────────────────────────
// These are what the MODEL calls through the task_checkpoint tool.

export type PlanAction =
  | { type: 'advance'; reason: string; evidence?: string[] } // Mark active step done, move to next
  | { type: 'skip'; reason: string }               // Skip active step
  | { type: 'fail'; reason: string }               // Mark active step failed
  | { type: 'activate'; stepNumber: number }        // Jump to a specific step
  | { type: 'revise'; reason: string; steps: any[]; goal?: string } // Replace unfinished plan
  | { type: 'complete'; summary: string; force?: boolean; evidence?: string[] }; // Mark entire plan done

export type PlanActionResult = {
  success: boolean;
  message: string;
  activeStep: ExecutionStep | null;
  planCompleted: boolean;
};

// ─── The Engine ───────────────────────────────────────────────────────────────

export class PlanExecutionEngine {
  private state: PlanState | null = null;

  /** Whether a plan is currently loaded and executing. */
  public hasActivePlan(): boolean {
    return this.state !== null && this.state.status === 'executing';
  }

  /** Load a plan from the task decomposer output. */
  public loadPlan(goal: string, rawSteps: any[]): void {
    const steps: ExecutionStep[] = rawSteps.map((raw, i) => ({
      id: String(raw.id || `step_${i + 1}`),
      step: i + 1,
      name: String(raw.name || ''),
      description: String(raw.description || ''),
      step_type: String(raw.step_type || 'create'),
      tools: Array.isArray(raw.tools) ? raw.tools : [],
      done_when: String(raw.done_when || ''),
      expected_output: String(raw.expected_output || ''),
      depends_on: Array.isArray(raw.depends_on)
        ? Array.from(new Set(raw.depends_on.map(Number).filter((value: number) => Number.isInteger(value) && value > 0 && value < i + 1)))
        : (i > 0 ? [i] : []),
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
      risk: String(raw.risk || 'low'),
      priority: String(raw.priority || 'high'),
      status: 'blocked' as StepStatus,
      startedAt: null,
      completedAt: null,
      failureReason: null,
      completionReason: null,
      completionEvidence: [],
      trace: [],
    }));

    this.state = {
      goal,
      steps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'executing',
      totalToolCalls: 0,
      revision: 1,
      revisionHistory: [],
      completionSummary: null,
      completionEvidence: [],
      actionHistory: [],
    };

    this.resolveReadiness();

    // Auto-activate the first ready step
    const first = this.state.steps.find(s => s.status === 'ready');
    if (first) {
      first.status = 'active';
      first.startedAt = Date.now();
    }
  }

  /**
   * Record a tool call against the active step's trace.
   * This does NOT decide if a step is done — the model does that.
   * It only records what happened so the model has context.
   */
  public recordToolCall(toolName: string, args: any, output: any, succeeded: boolean): void {
    if (!this.state) return;
    if (toolName === 'task_decomposer' || toolName === 'task_checkpoint') return;
    this.state.totalToolCalls++;
    this.state.updatedAt = Date.now();

    const active = this.getActiveStep();
    if (!active) return;

    // Keep trace compact — the model doesn't need full output
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output ?? {});

    active.trace.push({
      toolName,
      argsDigest: argsStr.slice(0, 300),
      outputDigest: outputStr.slice(0, 400),
      succeeded,
      timestamp: Date.now(),
    });

    // Auto-activate if still 'ready'
    if (active.status === 'ready') {
      active.status = 'active';
      active.startedAt = Date.now();
    }
  }

  /**
   * Execute a plan control action (called by the model through task_checkpoint).
   */
  public executeAction(action: PlanAction): PlanActionResult {
    if (!this.state) {
      return { success: false, message: 'No active plan.', activeStep: null, planCompleted: false };
    }

    switch (action.type) {
      case 'advance': {
        const active = this.getActiveStep();
        if (!active) {
          return { success: false, message: 'No active step to advance.', activeStep: null, planCompleted: this.isComplete() };
        }
        if (!String(action.reason || '').trim()) {
          return {
            success: false,
            message: `Explain why step ${active.step}'s done_when contract is satisfied before advancing.`,
            activeStep: active,
            planCompleted: false,
          };
        }
        const explicitEvidence = this.normalizeEvidence(action.evidence);
        const observedEvidence = active.trace
          .filter(entry => entry.succeeded)
          .slice(-5)
          .map(entry => `${entry.toolName}: ${entry.outputDigest.slice(0, 180)}`);
        const completionEvidence = explicitEvidence.length > 0 ? explicitEvidence : observedEvidence;
        if (!['communicate', 'deliver'].includes(active.step_type) && completionEvidence.length === 0) {
          return {
            success: false,
            message: `Step ${active.step} cannot advance without observed tool evidence or explicit evidence that its done_when contract is satisfied.`,
            activeStep: active,
            planCompleted: false,
          };
        }
        active.status = 'done';
        active.completedAt = Date.now();
        active.completionReason = action.reason.trim();
        active.completionEvidence = completionEvidence;
        this.state.updatedAt = Date.now();
        this.recordAction('advance', active.step, action.reason, active.completionEvidence);
        console.log(`[PlanEngine] Step ${active.step} "${active.name}" marked done by model.`);
        this.resolveReadiness();
        this.activateNext();
        const next = this.getActiveStep();
        const completed = this.isComplete();
        if (completed) this.state.status = 'completed';
        return {
          success: true,
          message: next ? `Step ${active.step} done. Now on step ${next.step}: "${next.name}"` : `Step ${active.step} done. ${completed ? 'Plan complete!' : 'No more steps ready.'}`,
          activeStep: next,
          planCompleted: completed,
        };
      }

      case 'skip': {
        const active = this.getActiveStep();
        if (!active) {
          return { success: false, message: 'No active step to skip.', activeStep: null, planCompleted: false };
        }
        if (!String(action.reason || '').trim()) {
          return { success: false, message: 'A concrete reason is required to skip a plan step.', activeStep: active, planCompleted: false };
        }
        active.status = 'skipped';
        active.completedAt = Date.now();
        active.failureReason = action.reason;
        this.recordAction('skip', active.step, action.reason);
        console.log(`[PlanEngine] Step ${active.step} "${active.name}" skipped: ${action.reason}`);
        this.resolveReadiness();
        this.activateNext();
        const completed = this.isComplete();
        if (completed) this.state.status = 'completed';
        return {
          success: true,
          message: `Step ${active.step} skipped. Reason: ${action.reason}`,
          activeStep: this.getActiveStep(),
          planCompleted: completed,
        };
      }

      case 'fail': {
        const active = this.getActiveStep();
        if (!active) {
          return { success: false, message: 'No active step to fail.', activeStep: null, planCompleted: false };
        }
        active.status = 'failed';
        active.completedAt = Date.now();
        active.failureReason = action.reason;
        this.recordAction('fail', active.step, action.reason);
        console.log(`[PlanEngine] Step ${active.step} "${active.name}" failed: ${action.reason}`);
        this.resolveReadiness();
        this.activateNext();
        return {
          success: true,
          message: `Step ${active.step} marked failed: ${action.reason}`,
          activeStep: this.getActiveStep(),
          planCompleted: false,
        };
      }

      case 'activate': {
        const target = this.state.steps.find(s => s.step === action.stepNumber);
        if (!target) {
          return { success: false, message: `Step ${action.stepNumber} not found.`, activeStep: this.getActiveStep(), planCompleted: false };
        }
        if (target.status === 'done' || target.status === 'skipped') {
          return { success: false, message: `Step ${action.stepNumber} is already ${target.status}.`, activeStep: this.getActiveStep(), planCompleted: false };
        }
        if (target.status === 'blocked') {
          const unmet = target.depends_on.filter(depNum => {
            const dep = this.state!.steps.find(s => s.step === depNum);
            return dep && dep.status !== 'done' && dep.status !== 'skipped';
          });
          return {
            success: false,
            message: `Step ${target.step} is blocked by unfinished dependencies: ${unmet.join(', ')}. Revise the plan or finish those dependencies first.`,
            activeStep: this.getActiveStep(),
            planCompleted: false,
          };
        }
        // Deactivate current
        const current = this.getActiveStep();
        if (current && current !== target) {
          if (current.status === 'active') current.status = 'ready';
        }
        target.status = 'active';
        if (!target.startedAt) target.startedAt = Date.now();
        target.completedAt = null;
        target.failureReason = null;
        this.state.status = 'executing';
        this.state.updatedAt = Date.now();
        this.recordAction('activate', target.step, `Activated step ${target.step}`);
        return {
          success: true,
          message: `Jumped to step ${target.step}: "${target.name}"`,
          activeStep: target,
          planCompleted: false,
        };
      }

      case 'revise': {
        if (!String(action.reason || '').trim()) {
          return { success: false, message: 'A reason is required to revise the plan.', activeStep: this.getActiveStep(), planCompleted: false };
        }
        if (!Array.isArray(action.steps) || action.steps.length === 0) {
          return { success: false, message: 'Revised plan must contain at least one step.', activeStep: this.getActiveStep(), planCompleted: false };
        }
        this.revisePlan(action.steps, action.reason, action.goal);
        this.recordAction('revise', this.getActiveStep()?.step ?? null, action.reason);
        return {
          success: true,
          message: `Plan revised intelligently (${this.state.revision} revisions). Active step: ${this.getActiveStep()?.name || 'none'}.`,
          activeStep: this.getActiveStep(),
          planCompleted: false,
        };
      }

      case 'complete': {
        if (!String(action.summary || '').trim()) {
          return { success: false, message: 'A completion summary is required.', activeStep: this.getActiveStep(), planCompleted: false };
        }
        const unfinished = this.state.steps.filter(step => !['done', 'skipped'].includes(step.status));
        if (unfinished.length > 0 && !action.force) {
          return {
            success: false,
            message: `Cannot complete while ${unfinished.length} step(s) remain. Advance or skip them, revise the plan, or explicitly force completion with justification.`,
            activeStep: this.getActiveStep(),
            planCompleted: false,
          };
        }
        for (const step of unfinished) {
          step.status = 'skipped';
          step.completedAt = Date.now();
          step.failureReason = `Forced plan completion: ${action.summary}`;
        }
        this.state.status = 'completed';
        this.state.updatedAt = Date.now();
        this.state.completionSummary = action.summary;
        this.state.completionEvidence = this.normalizeEvidence(action.evidence);
        this.recordAction('complete', null, action.summary, this.state.completionEvidence);
        return {
          success: true,
          message: `Plan marked complete: ${action.summary}`,
          activeStep: null,
          planCompleted: true,
        };
      }
    }
  }

  /** Get the currently active step. */
  public getActiveStep(): ExecutionStep | null {
    if (!this.state) return null;
    return this.state.steps.find(s => s.status === 'active') ||
           this.state.steps.find(s => s.status === 'ready') ||
           null;
  }

  /**
   * Build the plan context that gets injected into the model's prompt.
   *
   * This is the KEY integration point. The model sees this on every turn
   * and uses its own intelligence to decide what to do next, when a step
   * is done, and whether to adjust the plan.
   */
  public buildModelContext(): string {
    if (!this.state) return '';
    const sections: string[] = [];
    const active = this.getActiveStep();

    const done = this.state.steps.filter(s => s.status === 'done').length;
    const total = this.state.steps.length;
    const skipped = this.state.steps.filter(s => s.status === 'skipped').length;
    const failed = this.state.steps.filter(s => s.status === 'failed').length;
    const resolved = done + skipped;

    // ── Header
    sections.push(`PLAN: "${this.state.goal}" — ${resolved}/${total} resolved (${done} done${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}) (revision ${this.state.revision})`);

    // ── Completed steps (compact summary so the model knows what's been done)
    const completedSteps = this.state.steps.filter(s => s.status === 'done' || s.status === 'skipped');
    if (completedSteps.length > 0) {
      sections.push('COMPLETED:');
      for (const step of completedSteps) {
        const status = step.status === 'done' ? '✓' : '⊘';
        sections.push(`  ${status} Step ${step.step}: ${step.name} (${step.trace.length} tool calls)`);
        if (step.completionReason) sections.push(`    Completion claim: ${step.completionReason}`);
        if (step.completionEvidence.length > 0) sections.push(`    Evidence: ${step.completionEvidence.join('; ')}`);
      }
    }

    const failedSteps = this.state.steps.filter(s => s.status === 'failed');
    if (failedSteps.length > 0) {
      sections.push('FAILED — retry, activate, or revise these before finalizing:');
      for (const step of failedSteps) {
        sections.push(`  ✗ Step ${step.step}: ${step.name}${step.failureReason ? ` — ${step.failureReason}` : ''}`);
      }
    }

    // ── Active step (rich detail — this is what the model should focus on)
    if (active) {
      sections.push('');
      sections.push(`▶ ACTIVE STEP ${active.step}: ${active.name}`);
      sections.push(`  Type: ${active.step_type}`);
      sections.push(`  Description: ${active.description}`);
      sections.push(`  Done when: ${active.done_when}`);
      if (active.expected_output) {
        sections.push(`  Expected output: ${active.expected_output}`);
      }
      if (active.tools.length > 0) {
        sections.push(`  Suggested tools: ${active.tools.join(', ')}`);
      }
      if (active.artifacts.length > 0) {
        sections.push(`  Target artifacts: ${active.artifacts.join(', ')}`);
      }
      if (active.risk !== 'low') {
        sections.push(`  ⚠ Risk: ${active.risk}`);
      }

      // Show recent trace for the active step (last 5 tool calls)
      if (active.trace.length > 0) {
        const recent = active.trace.slice(-5);
        sections.push(`  Recent actions (${active.trace.length} total):`);
        for (const entry of recent) {
          const icon = entry.succeeded ? '✓' : '✗';
          sections.push(`    ${icon} ${entry.toolName}: ${entry.argsDigest.slice(0, 100)}`);
        }
      }

      // Stuck warning (let model decide what to do)
      if (active.trace.length >= 15) {
        sections.push(`  ⚠ This step has consumed ${active.trace.length} tool calls. Consider whether it's complete, needs to be skipped, or needs a different approach.`);
      }
    }

    // ── Upcoming steps (so the model knows what's ahead)
    const upcoming = this.state.steps.filter(s => s.status === 'ready' || s.status === 'blocked');
    if (upcoming.length > 0) {
      sections.push('');
      sections.push('UPCOMING:');
      for (const step of upcoming.slice(0, 5)) {
        const deps = step.depends_on.length > 0 ? ` (after step ${step.depends_on.join(', ')})` : '';
        const ready = step.status === 'ready' ? ' [READY]' : '';
        sections.push(`  ○ Step ${step.step}: ${step.name}${deps}${ready}`);
      }
      if (upcoming.length > 5) {
        sections.push(`  ... and ${upcoming.length - 5} more steps`);
      }
    }

    // ── Instructions for model
    sections.push('');
    sections.push('You own the plan semantics. Use task_checkpoint to: advance with a done_when justification and evidence, skip with reason, activate a READY step, revise future work when evidence changes the approach, or complete after all important steps are terminal.');

    if (resolved === total && total > 0) {
      sections.push('ALL STEPS COMPLETE — deliver your final answer now.');
      this.state.status = 'completed';
    }

    return `[PLAN EXECUTION STATE]\n${sections.join('\n')}\n[END PLAN STATE]`;
  }

  /** Serialize for survivor state / session persistence. */
  public serialize(): PlanState | null {
    return this.state ? JSON.parse(JSON.stringify(this.state)) : null;
  }

  /** Restore from serialized state. */
  public restore(state: PlanState): void {
    this.state = {
      ...state,
      revision: Number(state?.revision || 1),
      revisionHistory: Array.isArray(state?.revisionHistory) ? state.revisionHistory : [],
      completionSummary: state?.completionSummary || null,
      completionEvidence: Array.isArray(state?.completionEvidence) ? state.completionEvidence : [],
      actionHistory: Array.isArray(state?.actionHistory) ? state.actionHistory : [],
      steps: Array.isArray(state?.steps) ? state.steps.map(step => ({
        ...step,
        completionReason: step.completionReason || null,
        completionEvidence: Array.isArray(step.completionEvidence) ? step.completionEvidence : [],
        trace: Array.isArray(step.trace) ? step.trace : [],
      })) : [],
    };
    this.resolveReadiness();
    this.activateNext();
  }

  /** Get completion percentage. */
  public getCompletionPercent(): number {
    if (!this.state || this.state.steps.length === 0) return 0;
    const done = this.state.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
    return Math.round((done / this.state.steps.length) * 100);
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private isComplete(): boolean {
    if (!this.state) return false;
    return this.state.steps.every(s => s.status === 'done' || s.status === 'skipped');
  }

  private normalizeEvidence(evidence?: string[]): string[] {
    if (!Array.isArray(evidence)) return [];
    return Array.from(new Set(evidence.map(item => String(item || '').trim()).filter(Boolean))).slice(0, 12);
  }

  private recordAction(action: PlanAction['type'], stepNumber: number | null, reason: string, evidence: string[] = []): void {
    if (!this.state) return;
    this.state.actionHistory.push({
      timestamp: Date.now(),
      action,
      stepNumber,
      reason: String(reason || '').trim(),
      evidence: this.normalizeEvidence(evidence),
    });
    this.state.actionHistory = this.state.actionHistory.slice(-100);
    this.state.updatedAt = Date.now();
  }

  private revisePlan(rawSteps: any[], reason: string, goal?: string): void {
    if (!this.state) return;
    const priorById = new Map(this.state.steps.map(step => [step.id, step]));
    const priorByNumber = new Map(this.state.steps.map(step => [step.step, step]));

    this.state.steps = rawSteps.map((raw, index): ExecutionStep => {
      const stepNumber = index + 1;
      const id = String(raw?.id || `step_${stepNumber}`);
      const prior = priorById.get(id) || priorByNumber.get(stepNumber);
      const terminal = prior && ['done', 'skipped'].includes(prior.status);
      return {
        id,
        step: stepNumber,
        name: String(raw?.name || prior?.name || ''),
        description: String(raw?.description || prior?.description || ''),
        step_type: String(raw?.step_type || prior?.step_type || 'create'),
        tools: Array.isArray(raw?.tools) ? raw.tools : (prior?.tools || []),
        done_when: String(raw?.done_when || prior?.done_when || ''),
        expected_output: String(raw?.expected_output || prior?.expected_output || ''),
        depends_on: Array.isArray(raw?.depends_on)
          ? Array.from(new Set(raw.depends_on.map(Number).filter((value: number) => Number.isInteger(value) && value > 0 && value < stepNumber)))
          : (stepNumber > 1 ? [stepNumber - 1] : []),
        artifacts: Array.isArray(raw?.artifacts) ? raw.artifacts : (prior?.artifacts || []),
        risk: String(raw?.risk || prior?.risk || 'low'),
        priority: String(raw?.priority || prior?.priority || 'high'),
        status: terminal ? prior!.status : 'blocked',
        startedAt: terminal ? prior!.startedAt : null,
        completedAt: terminal ? prior!.completedAt : null,
        failureReason: terminal ? prior!.failureReason : null,
        completionReason: terminal ? prior!.completionReason : null,
        completionEvidence: terminal ? prior!.completionEvidence : [],
        trace: terminal ? prior!.trace : (prior?.trace || []),
      };
    });
    if (String(goal || '').trim()) this.state.goal = String(goal).trim();
    this.state.status = 'executing';
    this.state.revision += 1;
    this.state.updatedAt = Date.now();
    this.state.revisionHistory.push({ timestamp: Date.now(), reason: reason.trim() });
    this.resolveReadiness();
    this.activateNext();
  }

  private resolveReadiness(): void {
    if (!this.state) return;
    for (const step of this.state.steps) {
      if (step.status !== 'blocked') continue;
      const depsOk = step.depends_on.every(depNum => {
        const dep = this.state!.steps.find(s => s.step === depNum);
        return !!dep && (dep.status === 'done' || dep.status === 'skipped');
      });
      if (depsOk) step.status = 'ready';
    }
  }

  private activateNext(): void {
    if (!this.state) return;
    const hasActive = this.state.steps.some(s => s.status === 'active');
    if (hasActive) return;
    const next = this.state.steps.find(s => s.status === 'ready');
    if (next) {
      next.status = 'active';
      next.startedAt = Date.now();
    }
  }
}

type ScopedPlanEngineEntry = { engine: PlanExecutionEngine; lastAccessedAt: number };
const scopedPlanEngines = new Map<string, ScopedPlanEngineEntry>();
const PLAN_ENGINE_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizePlanScope(scopeId?: string | null): string {
  return String(scopeId || '').trim() || 'default';
}

/** Returns a plan controller isolated to one chat/task scope. */
export function getPlanEngine(scopeId?: string | null): PlanExecutionEngine {
  const scope = normalizePlanScope(scopeId);
  const now = Date.now();
  const existing = scopedPlanEngines.get(scope);
  if (existing) {
    existing.lastAccessedAt = now;
    return existing.engine;
  }

  for (const [key, entry] of scopedPlanEngines) {
    if (!entry.engine.hasActivePlan() && now - entry.lastAccessedAt > PLAN_ENGINE_IDLE_TTL_MS) {
      scopedPlanEngines.delete(key);
    }
  }

  const engine = new PlanExecutionEngine();
  scopedPlanEngines.set(scope, { engine, lastAccessedAt: now });
  return engine;
}

export function clearPlanEngine(scopeId?: string | null): void {
  scopedPlanEngines.delete(normalizePlanScope(scopeId));
}
