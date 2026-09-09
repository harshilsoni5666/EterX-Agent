import {
  RuntimeEvidenceLedger,
  type RuntimeEvidenceNode,
  type RuntimeEvidenceSnapshot,
} from './runtime-evidence';
import { writeRuntimeTrace } from './runtime-trace';

export type CognitiveMode =
  | 'exploration'
  | 'construction'
  | 'adversarial_evaluation'
  | 'evolutionary_search'
  | 'delegation'
  | 'reconciliation'
  | 'recovery'
  | 'convergence';

export type CognitiveOperator =
  | 'acquire_evidence'
  | 'reduce_uncertainty'
  | 'execute_change'
  | 'run_evaluator'
  | 'repair'
  | 'branch_strategy'
  | 'delegate_independent_work'
  | 'reconcile_evidence'
  | 'synthesize'
  | 'commit_external_action'
  | 'finalize';

export type ObligationKind =
  | 'produce_outcome'
  | 'ground_research'
  | 'verify_latest_state'
  | 'repair_failed_evaluation'
  | 'recover_failed_strategy'
  | 'complete_external_action'
  | 'reach_evaluation_target'
  | 'preserve_best_candidate';

export interface HarnessObligation {
  id: string;
  kind: ObligationKind;
  priority: 'critical' | 'high' | 'medium';
  reason: string;
  epoch: number;
  target?: string;
  suggestedOperators: CognitiveOperator[];
}

export interface GoalFacet {
  id: string;
  text: string;
  kind: 'outcome' | 'constraint' | 'quality' | 'evidence';
}

export interface StrategyCandidate {
  id: string;
  mutationEpoch: number;
  targets: string[];
  mutations: number;
  evaluations: number;
  status: 'unevaluated' | 'passing' | 'failing';
  score: number | null;
}

export interface HarnessEvent {
  id: number;
  type: 'goal_registered' | 'evidence_observed' | 'topology_changed' | 'completion_attempt';
  timestamp: number;
  evidenceId?: string;
  detail: string;
}

export interface AdaptiveHarnessSnapshot {
  scopeId: string;
  objective: string;
  events: HarnessEvent[];
  lastEvidenceSequence: number;
  lastModes: CognitiveMode[];
  completionAttempts: number;
  evidence: RuntimeEvidenceSnapshot;
}

export interface CompletionObservation {
  ready: boolean;
  outcome: 'complete' | 'incomplete' | 'blocked';
  issues: string[];
}

/** Compatibility shape for callers that inspect readiness without driving the runtime loop. */
export interface CompletionReview {
  approved: boolean;
  outcome: 'complete' | 'continue' | 'blocked';
  issues: string[];
  directive: string;
}

export interface HarnessDecisionSurface {
  modes: CognitiveMode[];
  frontier: CognitiveOperator[];
  obligations: HarnessObligation[];
  candidates: StrategyCandidate[];
  mutationEpoch: number;
  evidenceEvents: number;
}

type TaskSignals = {
  expectsAction: boolean;
  expectsMutation: boolean;
  expectsResearch: boolean;
  localInspection: boolean;
  expectsExternalAction: boolean;
  optimizationTask: boolean;
  highRisk: boolean;
  parallelizable: boolean;
  simpleAnswer: boolean;
  targetScore: number | null;
  evaluationDeclined: boolean;
};

const ACTION_VERBS = /\b(build|create|make|implement|develop|fix|debug|edit|change|update|refactor|migrate|install|configure|generate|write|prepare|export|run|execute|test|deploy|publish|send|schedule|connect|integrate)\b/i;
const MUTATION_VERBS = /\b(build|create|make|implement|develop|fix|edit|change|update|refactor|migrate|install|configure|generate|write|prepare|export|remove|delete|replace)\b/i;
const RESEARCH_VERBS = /\b(research|investigate|analyze|compare|benchmark|review|audit|latest|current|today|news|market|industry|sources?|citations?)\b/i;
const EXTERNAL_VERBS = /\b(deploy|publish|send|email|message|notify|schedule|post|upload|share)\b/i;
const OPTIMIZATION_WORDS = /\b(optimi[sz]e|benchmark|compare\s+(?:candidates|variants|approaches)|target\s+(?:score|accuracy|latency)|measur(?:e|ed)\s+(?:performance|improvement))\b/i;
const HIGH_RISK_WORDS = /\b(production|deploy|publish|release|security|credential|secret|financial|legal|compliance|delete|remove|payment|medical)\b/i;
const PARALLEL_WORDS = /\b(in parallel|independent|multiple|compare|research|across|frontend and backend|separately|each)\b/i;

function cleanObjective(raw: string): string {
  return String(raw || '')
    .replace(/\[(?:CURRENT USER REQUEST[^\]]*|END CURRENT USER REQUEST|USER MESSAGE|END USER MESSAGE)[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function taskSignals(objective: string): TaskSignals {
  const text = cleanObjective(objective);
  const words = text.split(/\s+/).filter(Boolean).length;
  const localInspection = /\b(code|codebase|repo(?:sitory)?|workspace|file|project|harness|implementation|module|function|class)\b/i.test(text)
    && !/\b(web|online|internet|latest|today|news|market|industry|sources?|citations?)\b/i.test(text);
  const questionOnly = /^(?:what|why|who|when|where|explain|define|how does|can you explain)\b/i.test(text)
    && !MUTATION_VERBS.test(text);
  const expectsAction = ACTION_VERBS.test(text) && !questionOnly;
  const expectsExternalAction = EXTERNAL_VERBS.test(text) && expectsAction;
  const explicitTarget = text.match(/(?:above|over|at least|>=|reach(?:ing)?|target(?:ing)?|score(?: of)?)\s*(\d+(?:\.\d+)?)\s*(%)?/i);
  const targetScore = explicitTarget
    ? Number(explicitTarget[1]) / (explicitTarget[2] ? 100 : 1)
    : null;
  const evaluationDeclined = /\b(?:do not|don't|dont|dotn|never|skip|without|no)(?:\s+(?!skip\b)\w+){0,4}\s+(?:tests?|testing|checks?|validation|verification)\b/i.test(text);
  return {
    expectsAction,
    expectsMutation: MUTATION_VERBS.test(text) && expectsAction && !expectsExternalAction,
    expectsResearch: RESEARCH_VERBS.test(text),
    localInspection,
    expectsExternalAction,
    optimizationTask: OPTIMIZATION_WORDS.test(text),
    highRisk: HIGH_RISK_WORDS.test(text),
    parallelizable: PARALLEL_WORDS.test(text),
    simpleAnswer: !expectsAction && !RESEARCH_VERBS.test(text) && (questionOnly || words < 18),
    targetScore: Number.isFinite(targetScore) ? targetScore : null,
    evaluationDeclined,
  };
}

function extractGoalFacets(objective: string): GoalFacet[] {
  const text = cleanObjective(objective);
  const candidates: Array<{ text: string; kind: GoalFacet['kind'] }> = [];
  const listItems = text.match(/(?:^|\s)(?:\d+[.)]|[-*])\s+([^\n]+)/g) || [];
  for (const item of listItems) {
    const cleaned = item.replace(/^\s*(?:\d+[.)]|[-*])\s+/, '').trim();
    if (cleaned.length > 5) candidates.push({ text: cleaned, kind: 'outcome' });
  }

  for (const clause of text.split(/(?<=[.!?;])\s+|\s+(?:and also|additionally|plus)\s+/i)) {
    const cleaned = clause.trim();
    if (cleaned.length < 8) continue;
    const kind: GoalFacet['kind'] = /\b(must|never|without|only|do not|don't|avoid|preserve)\b/i.test(cleaned)
      ? 'constraint'
      : /\b(verify|test|evidence|prove|score|benchmark)\b/i.test(cleaned)
        ? 'evidence'
        : /\b(quality|advanced|professional|polished|fast|reliable|robust|mature)\b/i.test(cleaned)
          ? 'quality'
          : 'outcome';
    candidates.push({ text: cleaned, kind });
  }

  if (candidates.length === 0 && text) candidates.push({ text, kind: 'outcome' });
  const seen = new Set<string>();
  return candidates
    .filter(candidate => {
      const key = candidate.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map((candidate, index) => ({ id: `goal-${index + 1}`, ...candidate }));
}

function admitsBlocker(answer: string): boolean {
  return /\b(blocked|could not|couldn't|unable to|failed to|requires (?:user|human)|missing (?:permission|credential|secret|access)|not available)\b/i.test(answer)
    && !/\b(successfully|fully complete|all tests pass|working perfectly|done and verified)\b/i.test(answer);
}

function claimsSuccess(answer: string): boolean {
  return /\b(successfully|completed|implemented|fixed|created|done|working|tests? pass(?:ed)?|verified|deployed|sent|published)\b/i.test(answer);
}

function distinctTargets(nodes: RuntimeEvidenceNode[]): number {
  return new Set(nodes.flatMap(node => node.targets).filter(Boolean)).size;
}

function primaryEvaluationScore(nodes: RuntimeEvidenceNode[]): number | null {
  const values = nodes.flatMap(node => Object.entries(node.metrics || {}));
  const higherIsBetter = values.filter(([key]) => !/(?:latency|duration|time)/i.test(key));
  if (higherIsBetter.length > 0) return Math.max(...higherIsBetter.map(([, value]) => value));
  const lowerIsBetter = values.filter(([key]) => /(?:latency|duration|time)/i.test(key));
  if (lowerIsBetter.length > 0) return -Math.min(...lowerIsBetter.map(([, value]) => value));
  return null;
}

/**
 * Adaptive Cognitive Fabric
 *
 * This is deliberately not a finite-state ReAct loop. It maintains an event
 * log and recomputes a set of concurrently useful cognitive modes from the
 * current goal/evidence graph. Actions emit obligations; later evidence can
 * discharge or invalidate them. The model receives only the current decision
 * frontier. Completion is observed in code, while verification is performed
 * beside the action that creates or changes evidence.
 */
export class AdaptiveHarness {
  public readonly evidence: RuntimeEvidenceLedger;
  public readonly goalFacets: GoalFacet[];

  private readonly signals: TaskSignals;
  private events: HarnessEvent[] = [];
  private eventSequence = 0;
  private lastEvidenceSequence = 0;
  private lastModes: CognitiveMode[] = [];
  private completionAttempts = 0;

  constructor(
    public readonly objective: string,
    private readonly scopeId: string = 'default',
    snapshot?: AdaptiveHarnessSnapshot | null,
  ) {
    this.signals = taskSignals(objective);
    this.goalFacets = extractGoalFacets(objective);
    this.evidence = new RuntimeEvidenceLedger(scopeId, snapshot?.evidence);
    if (snapshot) {
      this.events = snapshot.events.map(event => ({ ...event }));
      this.eventSequence = this.events.reduce((max, event) => Math.max(max, event.id), 0);
      this.lastEvidenceSequence = snapshot.lastEvidenceSequence;
      this.lastModes = [...snapshot.lastModes];
      this.completionAttempts = snapshot.completionAttempts;
    } else {
      this.appendEvent('goal_registered', `${this.goalFacets.length} goal facet(s) registered`);
    }
  }

  recordTool(toolName: string, args: Record<string, any> = {}, result: any = {}): RuntimeEvidenceNode {
    const node = this.evidence.recordTool(toolName, args, result);
    this.ingestEvidenceEvents();
    return node;
  }

  getOpenObligations(): HarnessObligation[] {
    const obligations: HarnessObligation[] = [];
    const nodes = this.evidence.list();
    const epoch = this.evidence.currentMutationEpoch();
    const lastMutation = this.evidence.lastSuccessfulMutation();
    const latestVerification = this.evidence.latestVerification();
    const unresolved = this.evidence.unresolvedFailures();

    if (this.signals.expectsAction && !this.evidence.hasWorkEvidence()) {
      obligations.push({
        id: 'produce-outcome',
        kind: 'produce_outcome',
        priority: 'critical',
        reason: 'The request requires an observable action or artifact, but none exists yet.',
        epoch,
        suggestedOperators: this.signals.expectsExternalAction
          ? ['commit_external_action']
          : ['acquire_evidence', 'execute_change'],
      });
    }

    const hasResearchGrounding = this.signals.localInspection
      ? this.evidence.hasEffect('observation')
      : this.evidence.successfulResearchCount() > 0;
    if (this.signals.expectsResearch && !hasResearchGrounding) {
      obligations.push({
        id: 'ground-research',
        kind: 'ground_research',
        priority: this.signals.highRisk ? 'critical' : 'high',
        reason: this.signals.localInspection
          ? 'The analysis targets local implementation state, but no successful workspace observation exists.'
          : 'The answer needs external/current evidence, but no successful research evidence exists.',
        epoch,
        suggestedOperators: ['acquire_evidence', 'delegate_independent_work', 'reconcile_evidence'],
      });
    }

    if (!this.signals.evaluationDeclined && lastMutation && !this.evidence.hasFreshVerificationEvidence()) {
      obligations.push({
        id: `verify-epoch-${epoch}`,
        kind: 'verify_latest_state',
        priority: this.signals.optimizationTask || this.signals.highRisk ? 'critical' : 'high',
        reason: `Mutation epoch ${epoch} has no successful evaluation performed after its latest change.`,
        epoch,
        target: lastMutation.targets[0],
        suggestedOperators: ['run_evaluator'],
      });
    }

    if (latestVerification && !latestVerification.success && latestVerification.mutationEpoch === epoch) {
      obligations.push({
        id: `repair-evaluation-${latestVerification.id}`,
        kind: 'repair_failed_evaluation',
        priority: 'critical',
        reason: `The latest evaluator failed: ${latestVerification.summary}`,
        epoch,
        target: latestVerification.targets[0],
        suggestedOperators: ['repair', 'branch_strategy', 'run_evaluator'],
      });
    }

    const recentUnresolved = unresolved.filter(node => node.mutationEpoch === epoch).slice(-3);
    if (recentUnresolved.length >= 2) {
      obligations.push({
        id: `recover-epoch-${epoch}`,
        kind: 'recover_failed_strategy',
        priority: recentUnresolved.length >= 3 ? 'critical' : 'high',
        reason: `${recentUnresolved.length} unresolved failures indicate that the current tactic may be non-credible.`,
        epoch,
        suggestedOperators: ['reduce_uncertainty', 'branch_strategy', 'repair'],
      });
    }

    if (this.signals.expectsExternalAction && !nodes.some(node => node.success && node.effect === 'external_action')) {
      obligations.push({
        id: 'complete-external-action',
        kind: 'complete_external_action',
        priority: 'critical',
        reason: 'The requested external side effect has not been confirmed by its action tool.',
        epoch,
        suggestedOperators: ['commit_external_action'],
      });
    }

    const portfolio = this.getStrategyPortfolio();
    const scored = portfolio.filter(candidate => candidate.score !== null);
    if (this.signals.targetScore !== null && scored.length > 0) {
      const best = Math.max(...scored.map(candidate => candidate.score as number));
      const normalizedTarget = best <= 1 && this.signals.targetScore > 1
        ? this.signals.targetScore / 100
        : best > 1 && this.signals.targetScore <= 1
          ? this.signals.targetScore * 100
          : this.signals.targetScore;
      if (best < normalizedTarget) {
        obligations.push({
          id: 'reach-evaluation-target',
          kind: 'reach_evaluation_target',
          priority: 'critical',
          reason: `Best measured candidate score ${best} is below the explicit target ${normalizedTarget}.`,
          epoch,
          suggestedOperators: ['branch_strategy', 'execute_change', 'run_evaluator'],
        });
      }
    }

    if (scored.length >= 2) {
      const best = scored.reduce((winner, candidate) =>
        (candidate.score as number) > (winner.score as number) ? candidate : winner,
      );
      const latest = scored.reduce((winner, candidate) =>
        candidate.mutationEpoch > winner.mutationEpoch ? candidate : winner,
      );
      if (latest.mutationEpoch !== best.mutationEpoch && (latest.score as number) < (best.score as number)) {
        obligations.push({
          id: `preserve-best-${best.mutationEpoch}`,
          kind: 'preserve_best_candidate',
          priority: 'high',
          reason: `Candidate epoch ${latest.mutationEpoch} regressed below best epoch ${best.mutationEpoch}; preserve or beat the best-known result before convergence.`,
          epoch,
          suggestedOperators: ['branch_strategy', 'repair', 'run_evaluator'],
        });
      }
    }

    return obligations;
  }

  getStrategyPortfolio(): StrategyCandidate[] {
    const byEpoch = new Map<number, RuntimeEvidenceNode[]>();
    for (const node of this.evidence.list()) {
      if (node.mutationEpoch <= 0) continue;
      const bucket = byEpoch.get(node.mutationEpoch) || [];
      bucket.push(node);
      byEpoch.set(node.mutationEpoch, bucket);
    }
    return Array.from(byEpoch.entries()).map(([mutationEpoch, nodes]) => {
      const evaluations = nodes.filter(node => node.effect === 'verification' && node.outcome !== 'pending' && node.outcome !== 'noop');
      const score = primaryEvaluationScore(evaluations);
      return {
        id: `candidate-${mutationEpoch}`,
        mutationEpoch,
        targets: Array.from(new Set(nodes.flatMap(node => node.targets))).slice(0, 8),
        mutations: nodes.filter(node => node.stateChanging).length,
        evaluations: evaluations.length,
        status: evaluations.length === 0
          ? 'unevaluated'
          : evaluations.at(-1)?.success ? 'passing' : 'failing',
        score,
      };
    });
  }

  selectModes(): CognitiveMode[] {
    this.ingestEvidenceEvents();
    const nodes = this.evidence.list();
    const obligations = this.getOpenObligations();
    const modes = new Set<CognitiveMode>();
    const unresolved = this.evidence.unresolvedFailures();
    const verificationFailures = nodes.filter(node => node.effect === 'verification' && !node.success).length;
    const recent = nodes.slice(-8);

    if ((nodes.length === 0 && !this.signals.simpleAnswer && !this.signals.expectsMutation) || obligations.some(item => item.kind === 'ground_research')) modes.add('exploration');
    if (this.signals.expectsMutation || obligations.some(item => item.kind === 'produce_outcome')) modes.add('construction');
    if (!this.signals.evaluationDeclined && (this.evidence.lastSuccessfulMutation() || this.signals.highRisk || this.signals.optimizationTask)) {
      modes.add('adversarial_evaluation');
    }
    if (this.signals.optimizationTask || verificationFailures >= 2 || unresolved.length >= 3) {
      modes.add('evolutionary_search');
    }
    if (this.signals.parallelizable && distinctTargets(recent) >= 2 && obligations.length > 1) modes.add('delegation');
    if (this.evidence.successfulResearchCount() >= 2 || distinctTargets(recent) >= 4) modes.add('reconciliation');
    if (unresolved.length >= 2) modes.add('recovery');
    if (obligations.length === 0) modes.add('convergence');

    const selected = Array.from(modes);
    if (selected.join('|') !== this.lastModes.join('|')) {
      this.lastModes = selected;
      this.appendEvent('topology_changed', selected.join(', ') || 'direct');
      writeRuntimeTrace('adaptive_harness_topology', {
        scopeId: this.scopeId,
        modes: selected,
        mutationEpoch: this.evidence.currentMutationEpoch(),
        evidenceEvents: nodes.length,
      });
    }
    return selected;
  }

  rankOperatorFrontier(): CognitiveOperator[] {
    const obligations = this.getOpenObligations();
    const modes = this.selectModes();
    const ranked: CognitiveOperator[] = [];
    const add = (...operators: CognitiveOperator[]) => {
      for (const operator of operators) if (!ranked.includes(operator)) ranked.push(operator);
    };

    for (const obligation of obligations.sort((a, b) => {
      const rank = { critical: 3, high: 2, medium: 1 };
      return rank[b.priority] - rank[a.priority];
    })) add(...obligation.suggestedOperators);

    if (modes.includes('evolutionary_search')) add('branch_strategy');
    if (modes.includes('delegation')) add('delegate_independent_work');
    if (modes.includes('reconciliation')) add('reconcile_evidence', 'synthesize');
    if (modes.includes('exploration')) add('acquire_evidence', 'reduce_uncertainty');
    if (modes.includes('construction')) add('execute_change');
    if (modes.includes('adversarial_evaluation')) add('run_evaluator');
    if (modes.includes('convergence')) add('synthesize', 'finalize');
    return ranked.slice(0, 6);
  }

  getDecisionSurface(): HarnessDecisionSurface {
    return {
      modes: this.selectModes(),
      frontier: this.rankOperatorFrontier(),
      obligations: this.getOpenObligations(),
      candidates: this.getStrategyPortfolio(),
      mutationEpoch: this.evidence.currentMutationEpoch(),
      evidenceEvents: this.evidence.list().length,
    };
  }

  /** Compile only the live decision surface; the full event log stays outside model context. */
  compileContext(maxChars = 3200): string {
    const modes = this.selectModes();
    const obligations = this.getOpenObligations();
    const frontier = this.rankOperatorFrontier();
    const evidence = this.evidence.summarize(5);
    const portfolio = this.getStrategyPortfolio();
    const facets = this.goalFacets.slice(0, 5).map(facet => `- ${facet.kind}: ${facet.text}`);

    const lines = [
      '[ADAPTIVE COGNITIVE FABRIC]',
      'This is an event-driven policy surface, not a prescribed step sequence. Choose or combine operators based on expected goal progress, information gain, risk, and cost.',
      `Active topology: ${modes.length ? modes.join(' + ') : 'direct reasoning'}`,
      `Operator frontier: ${frontier.length ? frontier.join(' > ') : 'answer directly'}`,
      'Goal facets:',
      ...facets,
    ];

    if (obligations.length > 0) {
      lines.push('Open proof obligations:');
      for (const obligation of obligations.slice(0, 6)) {
        lines.push(`- [${obligation.priority}] ${obligation.reason}`);
      }
    }
    if (evidence.length > 0) {
      lines.push('Recent causal evidence:');
      lines.push(...evidence.map(item => `- ${item}`));
    }
    if (portfolio.length > 0 && (this.signals.optimizationTask || portfolio.length > 1)) {
      lines.push('Strategy portfolio (never discard the best measured candidate silently):');
      for (const candidate of portfolio.slice(-5)) {
        lines.push(`- ${candidate.id}: ${candidate.status}, score=${candidate.score ?? 'unscored'}, targets=${candidate.targets.slice(0, 3).join(', ') || 'state'}`);
      }
    }
    lines.push(
      'Policy: preserve the objective and constraints, change topology when evidence invalidates the tactic, keep independent alternatives alive for optimization tasks, and never treat stale verification as proof.',
      this.signals.evaluationDeclined
        ? 'The user declined execution checks. Respect that constraint and distinguish implemented work from unverified behavior in the final answer.'
        : 'Resolve relevant verification before the final answer. Report remaining work honestly; final-answer generation does not start a critic/rewrite loop.',
      'Do not expose this control state or private deliberation in user-facing prose.',
      '[END ADAPTIVE COGNITIVE FABRIC]',
    );
    return lines.join('\n').slice(0, maxChars);
  }

  observeCompletion(candidate: string): CompletionObservation {
    this.ingestEvidenceEvents();
    this.completionAttempts++;
    const obligations = this.getOpenObligations();
    const issues = obligations.map(item => item.reason);
    const answer = String(candidate || '').trim();
    const blocker = admitsBlocker(answer);
    const successClaim = claimsSuccess(answer);
    const unresolved = this.evidence.unresolvedFailures();

    if (!answer) issues.unshift('The completion candidate is empty.');
    if (successClaim && unresolved.length > 0) {
      issues.push(`${unresolved.length} tool failure(s) remain unresolved while the answer claims success.`);
    }

    const dedupedIssues = Array.from(new Set(issues));
    const canReportBlocked = blocker && unresolved.length > 0 && !successClaim;
    const ready = dedupedIssues.length === 0 || canReportBlocked || this.signals.simpleAnswer;
    const outcome: CompletionObservation['outcome'] = ready
      ? canReportBlocked ? 'blocked' : 'complete'
      : 'incomplete';

    this.appendEvent('completion_attempt', `${outcome}: ${dedupedIssues.join('; ').slice(0, 500)}`);
    writeRuntimeTrace('adaptive_harness_completion_observed', {
      scopeId: this.scopeId,
      ready,
      blocking: false,
      outcome,
      issues: dedupedIssues,
      decisionSurface: this.getDecisionSurface(),
      completionAttempts: this.completionAttempts,
    });
    return { ready, outcome, issues: dedupedIssues };
  }

  /**
   * Compatibility-only assessment. Runtime execution uses observeCompletion,
   * so this result is never injected back into a model as a retry prompt.
   */
  reviewCompletion(candidate: string): CompletionReview {
    const observation = this.observeCompletion(candidate);
    return {
      approved: observation.ready,
      outcome: observation.outcome === 'incomplete' ? 'continue' : observation.outcome,
      issues: observation.issues,
      directive: '',
    };
  }

  snapshot(): AdaptiveHarnessSnapshot {
    this.ingestEvidenceEvents();
    return {
      scopeId: this.scopeId,
      objective: this.objective,
      events: this.events.slice(-300).map(event => ({ ...event })),
      lastEvidenceSequence: this.lastEvidenceSequence,
      lastModes: [...this.lastModes],
      completionAttempts: this.completionAttempts,
      evidence: this.evidence.snapshot(),
    };
  }

  private ingestEvidenceEvents(): void {
    for (const node of this.evidence.list()) {
      if (node.sequence <= this.lastEvidenceSequence) continue;
      this.appendEvent('evidence_observed', `${node.success ? 'success' : 'failure'} ${node.effect}: ${node.summary}`, node.id);
      this.lastEvidenceSequence = node.sequence;
    }
  }

  private appendEvent(type: HarnessEvent['type'], detail: string, evidenceId?: string): void {
    this.events.push({
      id: ++this.eventSequence,
      type,
      timestamp: Date.now(),
      evidenceId,
      detail,
    });
    if (this.events.length > 500) this.events = this.events.slice(-400);
  }
}
