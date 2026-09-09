/**
 * ═══════════════════════════════════════════════════════════════
 * COGNITIVE REASONING ENGINE — The Thinking Brain of EterX
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * Instead of the flat ReAct loop (think → act → observe), this engine
 * adds a multi-layered reasoning pipeline:
 *
 *   CLASSIFY → HYPOTHESIZE → PLAN (DAG) → EXECUTE → VERIFY → ADAPT
 *
 * KEY INNOVATIONS:
 * 1. Tree-of-Thought: For complex problems, generates 2-3 solution
 *    hypotheses and scores them before committing.
 * 2. Dependency-Aware DAG: Tasks are decomposed into nodes with
 *    explicit dependencies, enabling parallel execution.
 * 3. Strategy Adaptation: If a hypothesis fails, the engine switches
 *    to the next-best without losing progress.
 * 4. Confidence Calibration: Every decision has a confidence score
 *    that determines whether to proceed or investigate further.
 *
 * INTEGRATION:
 * - Injected into the system prompt as cognitive directives
 * - Tracked per-iteration in the ReAct loop
 * - Persisted across 429/rotation retries via survivorState
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProblemClass =
  | 'trivial'        // Direct answer, no tools needed
  | 'single_step'    // One tool call solves it
  | 'sequential'     // Multiple steps in order
  | 'parallel'       // Multiple independent sub-tasks
  | 'research'       // Multi-source investigation
  | 'creative'       // Open-ended generation
  | 'debugging'      // Find and fix a problem
  | 'architectural'; // System design / planning

export interface Hypothesis {
  id: string;
  approach: string;
  toolsNeeded: string[];
  estimatedSteps: number;
  risks: string[];
  confidence: number;  // 0-1
  status: 'pending' | 'active' | 'succeeded' | 'failed' | 'abandoned';
  failureReason?: string;
}

export interface TaskNode {
  id: string;
  description: string;
  toolHint?: string;         // Suggested tool
  dependencies: string[];    // IDs of prerequisite nodes
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
  verificationRequired: boolean;
  estimatedMs?: number;
}

export interface CognitiveState {
  problemClass: ProblemClass;
  hypotheses: Hypothesis[];
  activeHypothesis: string | null;
  taskDag: TaskNode[];
  currentPhase: 'classify' | 'hypothesize' | 'plan' | 'execute' | 'verify' | 'adapt' | 'complete';
  confidence: number;
  strategyShifts: number;
  startedAt: number;
  iteration: number;
}

// ─── Problem Classifier ──────────────────────────────────────────────────────

const PROBLEM_PATTERNS: Array<{ pattern: RegExp; class: ProblemClass; weight: number }> = [
  // Trivial
  { pattern: /^(hi|hello|hey|thanks?|ok|okay|yes|no|cool|sure|fine|great)[!.?\s]*$/i, class: 'trivial', weight: 10 },
  { pattern: /^(what is|who is|define|meaning of|explain)\b.{0,40}$/i, class: 'trivial', weight: 8 },

  // Debugging
  { pattern: /\b(fix|debug|error|bug|broken|crash|not work|fails?|issue|wrong)\b/i, class: 'debugging', weight: 9 },
  { pattern: /\b(undefined|null|exception|stack\s*trace|cannot read|is not a function)\b/i, class: 'debugging', weight: 10 },

  // Research
  { pattern: /\b(research|investigate|analyze|compare|benchmark|study|survey|review)\b/i, class: 'research', weight: 7 },
  { pattern: /\b(market|industry|competitor|trends?|statistics|report)\b/i, class: 'research', weight: 8 },

  // Creative exploration (ordinary creation is execution, not brainstorming)
  { pattern: /\b(imagine|brainstorm|concept|ideate|creative directions?|explore designs?|innovate)\b/i, class: 'creative', weight: 6 },
  { pattern: /\b(logo|illustration|mockup|prototype|wireframe)\b/i, class: 'creative', weight: 8 },

  // Architectural
  { pattern: /\b(architect|design system|infrastructure|migration|refactor entire|rebuild)\b/i, class: 'architectural', weight: 9 },
  { pattern: /\b(end.to.end|full.stack|entire app|whole project|complete system)\b/i, class: 'architectural', weight: 8 },

  // Parallel (multiple independent sub-tasks)
  { pattern: /\b(and also|plus|additionally|meanwhile|separately|at the same time)\b/i, class: 'parallel', weight: 5 },

  // Sequential multi-step
  { pattern: /\b(then|after that|next|step by step|first.*then|workflow)\b/i, class: 'sequential', weight: 5 },
];

// ─── Core Engine ──────────────────────────────────────────────────────────────

export class CognitiveReasoningEngine {
  /**
   * Classify the problem type from a user message.
   * Returns the most likely class with confidence.
   */
  classifyProblem(message: string): { class: ProblemClass; confidence: number; reasoning: string } {
    const text = message.trim();

    // A short directive can still request consequential work. Length alone
    // must not turn "delete files" or a contextual follow-up into small talk.

    // Score each class
    const scores: Map<ProblemClass, { total: number; reasons: string[] }> = new Map();
    for (const { pattern, class: cls, weight } of PROBLEM_PATTERNS) {
      if (pattern.test(text)) {
        const entry = scores.get(cls) || { total: 0, reasons: [] };
        entry.total += weight;
        entry.reasons.push(pattern.source.substring(0, 40));
        scores.set(cls, entry);
      }
    }

    if (scores.size === 0) {
      return { class: 'single_step', confidence: 0.6, reasoning: 'No dependency or specialist signal → direct execution' };
    }

    // Find highest scoring class
    let bestClass: ProblemClass = 'sequential';
    let bestScore = 0;
    let bestReasons: string[] = [];

    for (const [cls, { total, reasons }] of scores) {
      if (total > bestScore) {
        bestScore = total;
        bestClass = cls;
        bestReasons = reasons;
      }
    }

    // Confidence is proportional to score clarity (gap between best and second-best)
    const sortedScores = Array.from(scores.values()).map(s => s.total).sort((a, b) => b - a);
    const gap = sortedScores.length > 1 ? (sortedScores[0] - sortedScores[1]) / sortedScores[0] : 0.8;
    const confidence = Math.min(0.95, 0.5 + gap * 0.5);

    return { class: bestClass, confidence, reasoning: `Matched: ${bestReasons.join(', ')} → ${bestClass}` };
  }

  /**
   * Generate solution hypotheses for a problem.
   * For trivial/single-step problems, returns just one.
   * For complex problems, returns 2-3 ranked approaches.
   */
  generateHypotheses(message: string, problemClass: ProblemClass, availableTools: string[]): Hypothesis[] {
    // Trivial problems don't need hypotheses
    if (problemClass === 'trivial') {
      return [{
        id: 'h_direct',
        approach: 'Direct answer from knowledge',
        toolsNeeded: [],
        estimatedSteps: 0,
        risks: [],
        confidence: 0.9,
        status: 'active',
      }];
    }

    const lower = message.toLowerCase();
    const hypotheses: Hypothesis[] = [];

    switch (problemClass) {
      case 'debugging': {
        hypotheses.push({
          id: 'h_read_fix',
          approach: 'Read the error context, identify root cause, apply targeted fix, verify',
          toolsNeeded: ['workspace_run_command', 'workspace_edit_file'],
          estimatedSteps: 4,
          risks: ['Root cause may be in a different file', 'Fix may introduce new issues'],
          confidence: 0.75,
          status: 'pending',
        });
        hypotheses.push({
          id: 'h_search_fix',
          approach: 'Search codebase for error pattern, trace the call chain, fix at source',
          toolsNeeded: ['workspace_run_command', 'workspace_edit_file'],
          estimatedSteps: 5,
          risks: ['Search may return too many results', 'Deeper systemic issue'],
          confidence: 0.6,
          status: 'pending',
        });
        break;
      }

      case 'research': {
        hypotheses.push({
          id: 'h_web_research',
          approach: 'Use provider-aware web research for authoritative sources, extract top results, and synthesize findings',
          toolsNeeded: ['web_search'],
          estimatedSteps: 5,
          risks: ['Sources may be outdated', 'Conflicting information'],
          confidence: 0.7,
          status: 'pending',
        });
        break;
      }

      case 'sequential':
      case 'architectural': {
        hypotheses.push({
          id: 'h_systematic',
          approach: 'Execute the requested outcomes directly in dependency order; keep coordination internal unless the strict live-plan gate is met',
          toolsNeeded: this.inferToolsFromMessage(message, availableTools),
          estimatedSteps: this.estimateStepCount(message),
          risks: ['Scope creep', 'Integration issues between steps'],
          confidence: 0.7,
          status: 'pending',
        });
        if (problemClass === 'architectural') {
          hypotheses.push({
            id: 'h_scaffold_then_fill',
            approach: 'Create the coherent implementation structure directly, then fill only the required details',
            toolsNeeded: ['workspace_edit_file', 'workspace_run_command'],
            estimatedSteps: Math.max(6, this.estimateStepCount(message)),
            risks: ['Scaffold may not match exact requirements', 'May need heavy customization'],
            confidence: 0.6,
            status: 'pending',
          });
        }
        break;
      }

      case 'parallel': {
        hypotheses.push({
          id: 'h_parallel_exec',
          approach: 'Identify independent sub-tasks, execute in parallel, merge results',
          toolsNeeded: this.inferToolsFromMessage(message, availableTools),
          estimatedSteps: this.estimateStepCount(message),
          risks: ['Sub-tasks may have hidden dependencies'],
          confidence: 0.7,
          status: 'pending',
        });
        break;
      }

      default: {
        hypotheses.push({
          id: 'h_default',
          approach: 'Execute task directly with appropriate tools',
          toolsNeeded: this.inferToolsFromMessage(message, availableTools),
          estimatedSteps: this.estimateStepCount(message),
          risks: [],
          confidence: 0.6,
          status: 'pending',
        });
      }
    }

    // Sort by confidence (highest first)
    hypotheses.sort((a, b) => b.confidence - a.confidence);

    // Activate the best hypothesis
    if (hypotheses.length > 0) {
      hypotheses[0].status = 'active';
    }

    return hypotheses;
  }

  /**
   * Build a dependency-aware task DAG from the active hypothesis.
   */
  buildTaskDag(hypothesis: Hypothesis, message: string): TaskNode[] {
    const nodes: TaskNode[] = [];
    const lower = message.toLowerCase();

    switch (hypothesis.id) {
      case 'h_read_fix': {
        nodes.push(
          { id: 'read_context', description: 'Read the file/error context', toolHint: 'workspace_run_command', dependencies: [], status: 'pending', verificationRequired: false },
          { id: 'identify_cause', description: 'Identify root cause from the error', dependencies: ['read_context'], status: 'pending', verificationRequired: false },
          { id: 'apply_fix', description: 'Apply the targeted fix', toolHint: 'workspace_edit_file', dependencies: ['identify_cause'], status: 'pending', verificationRequired: true },
          { id: 'verify_fix', description: 'Verify the fix works', toolHint: 'workspace_run_command', dependencies: ['apply_fix'], status: 'pending', verificationRequired: false },
        );
        break;
      }

      case 'h_web_research': {
        nodes.push(
          { id: 'search', description: 'Search for authoritative sources', toolHint: 'web_search', dependencies: [], status: 'pending', verificationRequired: false },
          { id: 'read_sources', description: 'Read and extract key information from top sources', toolHint: 'web_search', dependencies: ['search'], status: 'pending', verificationRequired: false },
          { id: 'synthesize', description: 'Synthesize findings into a coherent answer', dependencies: ['read_sources'], status: 'pending', verificationRequired: false },
        );
        // If deliverable requested, add creation step
        if (/\b(report|document|docx|pdf|spreadsheet|xlsx)\b/i.test(lower)) {
          nodes.push(
            { id: 'create_deliverable', description: 'Create the requested deliverable file with a workspace script', toolHint: 'workspace_run_command', dependencies: ['synthesize'], status: 'pending', verificationRequired: true },
          );
        }
        break;
      }

      default: {
        // Internal execution guidance only. These nodes must not become a
        // visible task plan or generic preparation ritual.
        const stepCount = hypothesis.estimatedSteps;
        for (let i = 0; i < stepCount; i++) {
          const isLast = i === stepCount - 1;
          nodes.push({
            id: `step_${i}`,
            description: i === 0 ? 'Produce the first concrete requested outcome'
              : isLast ? 'Finish the requested outcome with proportionate evidence'
                : `Continue the next dependent outcome`,
            dependencies: i > 0 ? [`step_${i - 1}`] : [],
            status: 'pending',
            verificationRequired: isLast,
          });
        }
      }
    }

    return nodes;
  }

  /**
   * Generate a cognitive directive for the system prompt.
   * This tells the model HOW to think about the current task.
   */
  generateCognitiveDirective(state: CognitiveState, message: string): string {
    if (state.problemClass === 'trivial' || state.problemClass === 'single_step') return '';

    const parts: string[] = ['━━━ COGNITIVE REASONING ENGINE ━━━'];
    parts.push('This is an internal execution hint, not authorization to call task_decomposer, announce a plan, inspect directories, or run setup checks. Follow the main prompt\'s strict plan and direct-creation rules.');

    // Problem classification
    parts.push(`Problem Type: ${state.problemClass} (confidence: ${(state.confidence * 100).toFixed(0)}%)`);

    // Active hypothesis
    const active = state.hypotheses.find(h => h.id === state.activeHypothesis);
    if (active) {
      parts.push(`Strategy: ${active.approach}`);
      if (active.risks.length > 0) {
        parts.push(`Risks to monitor: ${active.risks.join('; ')}`);
      }
    }

    // Fallback hypotheses
    const fallbacks = state.hypotheses.filter(h => h.status === 'pending');
    if (fallbacks.length > 0) {
      parts.push(`Fallback strategies: ${fallbacks.map(h => h.approach.substring(0, 60)).join(' | ')}`);
    }

    // Task DAG progress
    const done = state.taskDag.filter(n => n.status === 'done').length;
    const total = state.taskDag.length;
    if (total > 0 && (state.problemClass === 'debugging' || state.problemClass === 'research')) {
      const nextPending = state.taskDag.find(n => n.status === 'pending');
      parts.push(`Internal evidence progress: ${done}/${total}${nextPending ? `. Next necessary action: ${nextPending.description}` : ''}`);
      if (nextPending?.toolHint) {
        parts.push(`Suggested tool: ${nextPending.toolHint}`);
      }
    }

    // Strategy shift warning
    if (state.strategyShifts > 0) {
      parts.push(`⚠️ Strategy shifted ${state.strategyShifts} time(s). If current approach fails, switch to fallback.`);
    }

    // Metacognitive instructions based on problem class
    switch (state.problemClass) {
      case 'debugging':
        parts.push('THINK: Read the error first. Do NOT guess the fix. Trace the actual call chain.');
        break;
      case 'research':
        parts.push('THINK: Search is discovery, not proof. Read actual sources before synthesizing.');
        break;
      case 'architectural':
        parts.push('THINK: For a new artifact, choose a coherent structure internally and create it directly. Inspect first only when existing implementation evidence is actually required.');
        break;
      case 'creative':
        parts.push('THINK: Explore multiple approaches. The first idea is rarely the best.');
        break;
      case 'parallel':
        parts.push('THINK: Identify truly independent sub-tasks. Execute them in parallel when possible.');
        break;
    }

    parts.push('━━━ END COGNITIVE ENGINE ━━━');
    return parts.join('\n');
  }

  /**
   * Create a fresh cognitive state for a new task.
   */
  initializeState(message: string, availableTools: string[]): CognitiveState {
    const classification = this.classifyProblem(message);
    const hypotheses = this.generateHypotheses(message, classification.class, availableTools);
    const activeHypothesis = hypotheses.find(h => h.status === 'active');
    const taskDag = activeHypothesis ? this.buildTaskDag(activeHypothesis, message) : [];

    return {
      problemClass: classification.class,
      hypotheses,
      activeHypothesis: activeHypothesis?.id || null,
      taskDag,
      currentPhase: classification.class === 'trivial' ? 'complete' : 'execute',
      confidence: classification.confidence,
      strategyShifts: 0,
      startedAt: Date.now(),
      iteration: 0,
    };
  }

  /**
   * Update cognitive state after a tool call result.
   * Advances the DAG, detects failures, triggers strategy shifts.
   */
  updateAfterToolCall(
    state: CognitiveState,
    toolName: string,
    success: boolean,
    resultSummary: string,
  ): CognitiveState {
    state.iteration++;

    // Find the current active node in the DAG
    const activeNode = state.taskDag.find(n => n.status === 'pending' || n.status === 'running');
    if (activeNode) {
      if (success) {
        activeNode.status = 'done';
        activeNode.result = resultSummary.substring(0, 200);
      } else {
        activeNode.status = 'failed';
        activeNode.result = `FAILED: ${resultSummary.substring(0, 150)}`;

        // Check if we should shift strategy
        const activeHypothesis = state.hypotheses.find(h => h.id === state.activeHypothesis);
        if (activeHypothesis) {
          const failedNodes = state.taskDag.filter(n => n.status === 'failed').length;
          if (failedNodes >= 2) {
            // Abandon current hypothesis and switch to fallback
            activeHypothesis.status = 'failed';
            activeHypothesis.failureReason = `${failedNodes} tasks failed`;

            const fallback = state.hypotheses.find(h => h.status === 'pending');
            if (fallback) {
              fallback.status = 'active';
              state.activeHypothesis = fallback.id;
              state.taskDag = this.buildTaskDag(fallback, ''); // Rebuild DAG
              state.strategyShifts++;
              state.currentPhase = 'adapt';
              console.log(`[CognitiveEngine] ♻️ Strategy shift #${state.strategyShifts}: ${activeHypothesis.approach} → ${fallback.approach}`);
            }
          }
        }
      }
    }

    // Check if all nodes are done
    const allDone = state.taskDag.every(n => n.status === 'done' || n.status === 'skipped');
    if (allDone && state.taskDag.length > 0) {
      state.currentPhase = 'verify';
    }

    // Update confidence based on progress
    const doneCount = state.taskDag.filter(n => n.status === 'done').length;
    const totalCount = state.taskDag.length;
    if (totalCount > 0) {
      state.confidence = Math.min(0.95, 0.3 + (doneCount / totalCount) * 0.65);
    }

    return state;
  }

  /**
   * Check if the DAG has tasks that can run in parallel.
   */
  getParallelizableNodes(state: CognitiveState): TaskNode[] {
    return state.taskDag.filter(node => {
      if (node.status !== 'pending') return false;
      // All dependencies must be done
      return node.dependencies.every(depId => {
        const dep = state.taskDag.find(n => n.id === depId);
        return dep?.status === 'done';
      });
    });
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private inferToolsFromMessage(message: string, available: string[]): string[] {
    const tools: string[] = [];
    const lower = message.toLowerCase();

    if (/\b(read|inspect|examine)\b.*\b(file|path|folder|directory|code|source|implementation)\b/i.test(lower)) tools.push('workspace_run_command');
    if (/\b(write|create|make|generate|add|new)\b/i.test(lower)) tools.push('workspace_edit_file');
    if (/\b(build|scaffold)\b.*\b(game|app|website|page|file|component|module|project|tool|artifact)\b/i.test(lower)) {
      tools.push('workspace_edit_file');
    }
    if (/\b(edit|modify|change|update|fix|patch)\b/i.test(lower)) {
      tools.push('workspace_edit_file');
    }
    if (/\b(search|find|grep|locate)\b/i.test(lower)) {
      tools.push('workspace_run_command');
    }
    if (/\b(run|execute|command|shell|terminal|npm|pip|install)\b/i.test(lower)) tools.push('workspace_run_command');
    if (/\b(web|search|google|online|internet|latest)\b/i.test(lower)) tools.push('web_search');
    if (/\b(test|verify|lint|compile|run\s+(?:the\s+)?build)\b/i.test(lower)) tools.push('workspace_run_command');
    if (/\b(image|picture|photo|logo|illustration)\b/i.test(lower)) tools.push('image_generator');

    return tools.filter(t => available.includes(t));
  }

  private estimateStepCount(message: string): number {
    const words = message.split(/\s+/).length;
    const conjunctions = (message.match(/\b(and|then|also|plus|with|after)\b/gi) || []).length;
    const actionVerbs = (message.match(/\b(create|build|fix|add|remove|update|write|read|search|deploy|test)\b/gi) || []).length;

    return Math.min(15, Math.max(2, Math.ceil(conjunctions + actionVerbs * 1.5 + words / 20)));
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const cognitiveEngine = new CognitiveReasoningEngine();
