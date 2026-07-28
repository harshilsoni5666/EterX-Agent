import fs from 'fs-extra';
import path from 'path';
import type { ProjectContext } from '../schemas';
import type { MainAgentMode } from '../model-routing';
import type { ScopedRuntimeSettings } from '../runtime-api-keys';
import { getEterxWorkspaceDir } from '../storage-paths';

type TraceFn = (trace: any) => void;
type ProxyAction = 'observe' | 'steer' | 'redirect' | 'challenge' | 'request_real_user' | 'interrupt_main' | 'stop_main' | 'approve_completion';

type ProxyDecision = {
  action: ProxyAction;
  message?: string;
  reason?: string;
  remainingGoalGap?: string;
  confidence?: number;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  evidenceEventIds?: number[];
  visibilityGap?: string;
  optionalImprovement?: boolean;
  attentionSignals?: string[];
  contractUpdate?: Partial<Pick<TaskContract, 'requiredDeliverables' | 'forbiddenActions' | 'safetyConstraints' | 'completionConditions'>>;
  managerDirectiveId?: string;
  managerNotice?: string;
  promptIntent?: {
    outcome: string;
    preserveRules: string[];
    acceptanceEvidence: string;
    strategyFreedom: 'free' | 'bounded' | 'exact';
    whyNow: string;
  };
  situationUpdate?: Partial<{
    progress: string;
    activeStrategy: string;
    unresolvedRisks: string[];
    nextExpectedBoundary: string;
  }>;
  complexityUpdate?: Partial<{
    level: 'simple' | 'moderate' | 'complex' | 'frontier';
    criticalPath: string[];
    dependencies: string[];
    invariants: string[];
    decisionPoints: string[];
    uncertainty: string[];
    recoveryBranches: string[];
    verificationGates: string[];
  }>;
};

type TaskContract = {
  goal: string;
  priorUserContext: string[];
  explicitRules: string[];
  preferences: string[];
  authorityBoundaries: string[];
  requiredDeliverables: string[];
  forbiddenActions: string[];
  safetyConstraints: string[];
  completionConditions: string[];
  successEvidence: string[];
  referencedPaths: string[];
};

type ProxyEvent = {
  id: number;
  type: string;
  kind: 'intent' | 'action' | 'result' | 'artifact' | 'failure' | 'question' | 'human_guidance' | 'other';
  text: string;
  tool?: string;
  signature: string;
  failed: boolean;
  risk: boolean;
  repeated: boolean;
  timestamp: number;
};

type DeliverableEvidence = {
  observed: boolean;
  verified: boolean;
  evidenceEventIds: number[];
};

export type ProxyManagerDirective = {
  id: string;
  message: string;
  target: 'proxy' | 'main' | 'both';
  timing: 'now' | 'when_relevant' | 'before_completion' | 'after_current';
  intent: 'goal' | 'constraint' | 'correction' | 'preference' | 'follow_up';
  rationale?: string;
  requestedAction?: 'advise_proxy' | 'steer_adaptively' | 'interrupt_main' | 'stop_main';
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  expiresAt?: number;
  activationCondition?: string;
  scope?: 'current_step' | 'current_task' | 'next_task' | 'persistent_mandate';
  supersedesDirectiveId?: string;
  createdAt: number;
  status: 'active' | 'pending' | 'delivered' | 'rejected' | 'expired';
  disposition?: string;
  deliveredAt?: number;
};

type ProxyCoordinationEvent = {
  id: string;
  kind: 'manager_request' | 'proxy_acknowledgement' | 'proxy_deferral' | 'proxy_delivery' | 'proxy_rejection' | 'supervisor_notice' | 'main_interrupted' | 'main_stopped' | 'outcome';
  directiveId?: string;
  message: string;
  timestamp: number;
};

type ProxyState = {
  version: 2;
  projectId: string;
  objective: string;
  objectiveSignature: string;
  contract: TaskContract;
  status: 'watching' | 'reviewing' | 'waiting_for_main' | 'needs_user' | 'complete' | 'stopped';
  events: ProxyEvent[];
  interventions: Array<{
    message: string;
    reason: string;
    action: ProxyAction;
    evidenceEventIds: number[];
    topicKey?: string;
    timestamp: number;
  }>;
  deliverableEvidence: Record<string, DeliverableEvidence>;
  actionCounts: Record<string, number>;
  lastGoalGap: string;
  lastDecisionAt: number;
  lastReviewedEventId: number;
  lastInterventionEventId: number;
  helperUsed: boolean;
  adaptivePolicy: {
    cadence: 'quiet' | 'normal' | 'close';
    attentionSignals: string[];
  };
  managerDirectives: ProxyManagerDirective[];
  coordinationEvents: ProxyCoordinationEvent[];
  situationModel: {
    progress: string;
    activeStrategy: string;
    unresolvedRisks: string[];
    nextExpectedBoundary: string;
  };
  complexityModel: {
    level: 'simple' | 'moderate' | 'complex' | 'frontier';
    criticalPath: string[];
    dependencies: string[];
    invariants: string[];
    decisionPoints: string[];
    uncertainty: string[];
    recoveryBranches: string[];
    verificationGates: string[];
  };
  updatedAt: number;
};

type RuntimeOptions = {
  context: ProjectContext;
  objective: string;
  mode: MainAgentMode;
  apiKey: string;
  runtimeSettings?: ScopedRuntimeSettings | null;
  fallbackMode?: MainAgentMode;
  fallbackApiKey?: string;
  fallbackRuntimeSettings?: ScopedRuntimeSettings | null;
  history?: any[];
  attachments?: Array<{ name?: string; path?: string; mimeType?: string }>;
  onTrace?: TraceFn;
  steer: (message: string, metadata?: Record<string, any>) => boolean;
  stopMain: (reason: string, metadata?: Record<string, any>) => boolean;
  queueNext: (message: string, rationale?: string) => boolean;
};

export type ProxyInterventionLevel = 'minimal' | 'normal' | 'high';

const runtimes = new Map<string, UserProxyRuntime>();
const AUTONOMY_RUNTIME = 'autonomy_v1';
const MAX_EVENTS = 120;
const MAX_INTERVENTIONS = 24;
const INITIAL_SILENCE_MS = 12_000;
const MIN_REVIEW_INTERVAL_MS = 22_000;
const PERIODIC_REVIEW_MS = 55_000;
const HUMAN_OVERRIDE_SILENCE_MS = 90_000;
const MIN_EVENTS_AFTER_INTERVENTION = 2;
const REVIEW_SCORE_THRESHOLD = 10;

const CADENCE_SETTINGS = {
  quiet: {
    scoreThreshold: 18,
    minIntervalMs: 60_000,
    periodicMs: 150_000,
    bootstrapAfterEvents: 2,
    failuresBeforeGuidance: 3,
    eventsAfterIntervention: 4,
    maxMidRunInterventions: 1,
    confidence: 0.86,
    completionConfidence: 0.88,
  },
  normal: {
    scoreThreshold: REVIEW_SCORE_THRESHOLD,
    minIntervalMs: MIN_REVIEW_INTERVAL_MS,
    periodicMs: PERIODIC_REVIEW_MS,
    bootstrapAfterEvents: 1,
    failuresBeforeGuidance: 2,
    eventsAfterIntervention: MIN_EVENTS_AFTER_INTERVENTION,
    maxMidRunInterventions: 4,
    confidence: 0.72,
    completionConfidence: 0.76,
  },
  close: {
    scoreThreshold: 5,
    minIntervalMs: 8_000,
    periodicMs: 24_000,
    bootstrapAfterEvents: 1,
    failuresBeforeGuidance: 2,
    eventsAfterIntervention: 1,
    maxMidRunInterventions: 8,
    confidence: 0.66,
    completionConfidence: 0.72,
  },
} as const;

const compact = (value: unknown, max = 1600): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
};

const objectiveSignature = (value: string): string =>
  compact(value, 1200).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const unique = (values: string[], limit = 24): string[] =>
  Array.from(new Set(values.map(value => compact(value, 500)).filter(Boolean))).slice(0, limit);

const isAutonomous = (context: any): boolean =>
  !context?.isUserProxy && context?.autonomy?.enabled !== false && (context?.agentRuntime === AUTONOMY_RUNTIME || context?.autonomy?.enabled === true);

function statePathFor(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 140);
  return getEterxWorkspaceDir('autonomy', 'user-proxy', `${safe}.json`);
}

function buildTaskContract(objective: string, context: any, history: any[] = [], attachments: RuntimeOptions['attachments'] = []): TaskContract {
  const lines = String(objective || '')
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map(line => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean);
  const fileTokens = String(objective || '').match(/(?:[A-Za-z]:\\[^\n,;]+|[\w ._-]+\.(?:md|txt|csv|json|pdf|docx|xlsx|pptx|html|zip|png|jpe?g))/gi) || [];
  const deliverableLines = lines.filter(line =>
    /\b(create|produce|write|generate|save|output|deliver|open|copy|export|report|summary|inventory|plan)\b/i.test(line),
  );
  const explicitRules = lines.filter(line =>
    /\b(must|required|ensure|make sure|always|exactly|only|do not|don't|never|must not|before finishing)\b/i.test(line),
  );
  const preferences = lines.filter(line =>
    /\b(prefer|would like|ideally|professional|simple|concise|detailed|style|tone|format)\b/i.test(line) &&
    !explicitRules.includes(line),
  );
  const authorityBoundaries = lines.filter(line =>
    /\b(ask|approval|permission|authorize|authority|login|credential|public|private|sensitive|send|publish|upload|delete|overwrite)\b/i.test(line),
  );
  const forbidden = lines.filter(line => /\b(do not|don't|never|must not|without changing|avoid)\b/i.test(line));
  const safety = lines.filter(line =>
    /\b(safe|safety|sensitive|personal|private|important|ambiguous|original|delete|move|overwrite|permission|approval)\b/i.test(line),
  );
  const completion = lines.filter(line =>
    /\b(when finished|before finishing|complete|completion|finally|at the end|do not stop|finished)\b/i.test(line),
  );
  const contextPaths = [
    ...(Array.isArray(context?.paths) ? context.paths : []),
    context?.workspacePath,
    ...(attachments || []).map(item => item?.path),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const priorUserContext = history
    .filter(item => String(item?.role || '').toLowerCase() === 'user')
    .map(item => {
      if (typeof item?.content === 'string') return item.content;
      if (Array.isArray(item?.parts)) return item.parts.map((part: any) => part?.text || '').join(' ');
      return item?.text || '';
    })
    .map(value => compact(value, 1200))
    .filter(Boolean)
    .slice(-4);
  const attachmentNames = (attachments || []).map(item => compact(item?.name || '', 240)).filter(Boolean);

  return {
    goal: compact(objective, 5000),
    priorUserContext,
    explicitRules: unique(explicitRules, 20),
    preferences: unique(preferences, 16),
    authorityBoundaries: unique(authorityBoundaries, 16),
    requiredDeliverables: unique([...fileTokens, ...deliverableLines], 20),
    forbiddenActions: unique(forbidden, 16),
    safetyConstraints: unique(safety, 16),
    completionConditions: unique(completion.length > 0 ? completion : deliverableLines, 16),
    successEvidence: unique([
      ...completion,
      ...deliverableLines.map(line => `Direct evidence that this outcome exists and is usable: ${line}`),
    ], 20),
    referencedPaths: unique([...contextPaths, ...attachmentNames], 20),
  };
}

function extractDecision(raw: string): ProxyDecision {
  const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { action: 'observe', reason: 'No structured intervention decision.' };
  try {
    const parsed = JSON.parse(match[0]);
    const actions = new Set<ProxyAction>(['observe', 'steer', 'redirect', 'challenge', 'request_real_user', 'interrupt_main', 'stop_main', 'approve_completion']);
    const severity = new Set(['low', 'medium', 'high', 'critical']).has(parsed.severity) ? parsed.severity : undefined;
    return {
      action: actions.has(parsed.action) ? parsed.action : 'observe',
      message: compact(parsed.message, 1600),
      reason: compact(parsed.reason, 900),
      remainingGoalGap: compact(parsed.remainingGoalGap, 1200),
      confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : undefined,
      severity,
      evidenceEventIds: Array.isArray(parsed.evidenceEventIds)
        ? parsed.evidenceEventIds.map(Number).filter(Number.isFinite).slice(0, 8)
        : [],
      visibilityGap: compact(parsed.visibilityGap, 700),
      optionalImprovement: parsed.optionalImprovement === true,
      attentionSignals: Array.isArray(parsed.attentionSignals)
        ? unique(parsed.attentionSignals.map((item: any) => String(item)), 10)
        : [],
      managerDirectiveId: compact(parsed.managerDirectiveId, 160),
      managerNotice: compact(parsed.managerNotice, 1200),
      promptIntent: parsed.promptIntent && typeof parsed.promptIntent === 'object' ? {
        outcome: compact(parsed.promptIntent.outcome, 900),
        preserveRules: Array.isArray(parsed.promptIntent.preserveRules)
          ? unique(parsed.promptIntent.preserveRules, 6)
          : [],
        acceptanceEvidence: compact(parsed.promptIntent.acceptanceEvidence, 700),
        strategyFreedom: new Set(['free', 'bounded', 'exact']).has(parsed.promptIntent.strategyFreedom)
          ? parsed.promptIntent.strategyFreedom
          : 'free',
        whyNow: compact(parsed.promptIntent.whyNow, 700),
      } : undefined,
      situationUpdate: parsed.situationUpdate && typeof parsed.situationUpdate === 'object' ? {
        progress: compact(parsed.situationUpdate.progress, 1400),
        activeStrategy: compact(parsed.situationUpdate.activeStrategy, 1000),
        unresolvedRisks: Array.isArray(parsed.situationUpdate.unresolvedRisks) ? unique(parsed.situationUpdate.unresolvedRisks, 8) : undefined,
        nextExpectedBoundary: compact(parsed.situationUpdate.nextExpectedBoundary, 700),
      } : undefined,
      complexityUpdate: parsed.complexityUpdate && typeof parsed.complexityUpdate === 'object' ? {
        level: new Set(['simple', 'moderate', 'complex', 'frontier']).has(parsed.complexityUpdate.level)
          ? parsed.complexityUpdate.level
          : undefined,
        criticalPath: Array.isArray(parsed.complexityUpdate.criticalPath) ? unique(parsed.complexityUpdate.criticalPath, 12) : undefined,
        dependencies: Array.isArray(parsed.complexityUpdate.dependencies) ? unique(parsed.complexityUpdate.dependencies, 16) : undefined,
        invariants: Array.isArray(parsed.complexityUpdate.invariants) ? unique(parsed.complexityUpdate.invariants, 16) : undefined,
        decisionPoints: Array.isArray(parsed.complexityUpdate.decisionPoints) ? unique(parsed.complexityUpdate.decisionPoints, 12) : undefined,
        uncertainty: Array.isArray(parsed.complexityUpdate.uncertainty) ? unique(parsed.complexityUpdate.uncertainty, 12) : undefined,
        recoveryBranches: Array.isArray(parsed.complexityUpdate.recoveryBranches) ? unique(parsed.complexityUpdate.recoveryBranches, 12) : undefined,
        verificationGates: Array.isArray(parsed.complexityUpdate.verificationGates) ? unique(parsed.complexityUpdate.verificationGates, 12) : undefined,
      } : undefined,
      contractUpdate: parsed.contractUpdate && typeof parsed.contractUpdate === 'object'
        ? {
          requiredDeliverables: Array.isArray(parsed.contractUpdate.requiredDeliverables) ? unique(parsed.contractUpdate.requiredDeliverables, 20) : undefined,
          forbiddenActions: Array.isArray(parsed.contractUpdate.forbiddenActions) ? unique(parsed.contractUpdate.forbiddenActions, 16) : undefined,
          safetyConstraints: Array.isArray(parsed.contractUpdate.safetyConstraints) ? unique(parsed.contractUpdate.safetyConstraints, 16) : undefined,
          completionConditions: Array.isArray(parsed.contractUpdate.completionConditions) ? unique(parsed.contractUpdate.completionConditions, 16) : undefined,
        }
        : undefined,
    };
  } catch {
    return { action: 'observe', reason: 'Malformed Proxy decision.' };
  }
}

function messageSimilarity(left: string, right: string): number {
  const words = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const a = words(left);
  const b = words(right);
  if (a.size === 0 || b.size === 0) return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function guidanceTopicKey(value: string): string {
  const text = value.toLowerCase();
  const domains = Array.from(new Set(
    (text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/g) || [])
      .map(item => item.replace(/^www\./, '')),
  )).sort();
  if (domains.length > 0) return `domains:${domains.join('|')}`;
  const fileTypes = Array.from(new Set(text.match(/\b(?:xlsx|pptx|docx|pdf|csv|json|zip|png|jpe?g)\b/g) || [])).sort();
  const operations = Array.from(new Set(
    (text.match(/\b(?:upload|download|share|publish|verify|install|build|create|edit|delete|move|send|connect|authenticate)\w*\b/g) || [])
      .map(item => item.replace(/(?:ing|ed|s)$/, '')),
  )).sort();
  return operations.length > 0 ? `work:${operations.join('|')}:${fileTypes.join('|')}` : '';
}

function humanDelegatedInstruction(message: string, goalGap: string, managerMessage = ''): string {
  const clean = compact(message, 1600);
  if (!clean) return '';
  const isInternalNarration =
    /\b(?:main|proxy-agent|proxy agent|user proxy|runtime proxy|manager directive|evidence event)\b/i.test(clean) ||
    /^(?:the agent|it)\s+(?:is|has|keeps|repeatedly)/i.test(clean);
  if (!isInternalNarration) return clean;
  const directManagerMessage = compact(managerMessage, 1600);
  if (directManagerMessage && !/\b(?:main|proxy-agent|user proxy|runtime proxy|manager directive)\b/i.test(directManagerMessage)) {
    return directManagerMessage;
  }
  const outcome = compact(goalGap, 700);
  return outcome
    ? `Please continue toward this outcome: ${outcome}. Change the approach if the current one is failing, and report completion only after the result is verified.`
    : 'Please change the failing approach, continue toward the requested outcome, and report completion only after the result is verified.';
}

function outcomeLevelInstruction(message: string, goalGap: string, preserveExactMechanism = false): string {
  const clean = compact(message, 1600);
  if (preserveExactMechanism) return clean;
  const micromanagesExecution =
    /\b(?:powershell|cmd(?:\.exe)?|bash|shell|curl(?:\.exe)?|invoke-restmethod|invoke-webrequest|python|node|npm|pip|git)\b/i.test(clean) ||
    /(?:^|\s)(?:--?[a-z][\w-]*|\/[A-Z])(?:\s|$)/.test(clean) ||
    /[`$][({\w]|(?:\|\s*(?:convert|select|where|out)-)/i.test(clean);
  if (!micromanagesExecution) return clean;
  const outcome = compact(goalGap, 700);
  return outcome
    ? `Please continue toward this outcome: ${outcome}. Use a materially different strategy if the current approach is failing, and confirm the result with direct evidence before reporting success.`
    : 'Please change the failing strategy, continue toward the requested outcome, and confirm the result with direct evidence before reporting success.';
}

function formHumanProxyPrompt(decision: ProxyDecision, contract: TaskContract): string {
  const intent = decision.promptIntent;
  const outcome = compact(intent?.outcome || decision.remainingGoalGap || contract.goal, 800);
  const exactMechanismRequired = intent?.strategyFreedom === 'exact';
  const raw = outcomeLevelInstruction(
    humanDelegatedInstruction(decision.message || '', outcome, ''),
    outcome,
    exactMechanismRequired,
  );
  const internallyFramed =
    /\b(?:main|proxy-agent|proxy agent|user proxy|runtime|directive|telemetry|evidence event)\b/i.test(raw);
  const executionPrescription =
    /\b(?:powershell|cmd(?:\.exe)?|bash|shell|curl(?:\.exe)?|invoke-restmethod|python|node|npm|pip)\b/i.test(raw) ||
    /(?:^|\s)(?:--?[a-z][\w-]*|\/[A-Z])(?:\s|$)/.test(raw);
  const outcomeAligned =
    decision.action === 'request_real_user' ||
    !outcome ||
    messageSimilarity(raw, outcome) >= 0.12;
  if (
    raw &&
    !internallyFramed &&
    (!executionPrescription || exactMechanismRequired) &&
    outcomeAligned &&
    raw.length <= 1000
  ) return raw;

  const preserved = unique(
    intent?.preserveRules?.length ? intent.preserveRules : contract.explicitRules,
    2,
  );
  const acceptance = compact(
    intent?.acceptanceEvidence ||
    contract.successEvidence[0] ||
    'direct evidence that the requested result is complete and usable',
    500,
  );
  if (decision.action === 'request_real_user') {
    const question = outcome.replace(/^(?:please\s+)?(?:clarify|confirm|decide|choose)\s+/i, '');
    return compact(
      question
        ? `Before I continue, please confirm ${question.replace(/[.?!]+$/, '')}?`
        : 'Before I continue, what outcome or authority should I use for this decision?',
      700,
    );
  }
  const parts = [
    outcome ? `Please make sure ${outcome.replace(/^[Pp]lease\s+/, '')}` : 'Please complete the requested outcome',
    preserved.length > 0 ? `Keep these requirements unchanged: ${preserved.join('; ')}.` : '',
    intent?.strategyFreedom === 'exact'
      ? 'Use the exact mechanism the user required.'
      : intent?.strategyFreedom === 'bounded'
        ? 'You may change the approach as long as those requirements remain intact.'
        : 'Choose a different approach if it is more reliable.',
    acceptance ? `Treat it as complete only after ${acceptance.replace(/^direct evidence that\s+/i, 'there is direct evidence that ')}.` : '',
  ].filter(Boolean);
  return compact(parts.join(' '), 1600);
}

export class UserProxyRuntime {
  private readonly options: RuntimeOptions;
  private readonly state: ProxyState;
  private eventCounter = 0;
  private reviewScore = 0;
  private consecutiveFailures = 0;
  private reviewPromise: Promise<ProxyDecision> | null = null;
  private reviewTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private paused = false;
  private pendingGuidance = false;
  private humanOverrideUntil = 0;
  private mainPhase: 'working' | 'composing' | 'acting' | 'recovering' | 'completion_review' = 'working';
  private lastThoughtSampleAt = 0;
  private readonly startedAt = Date.now();
  private selectedIntervention: ProxyInterventionLevel;
  private bootstrapReviewPending = true;

  constructor(options: RuntimeOptions) {
    this.options = options;
    const configuredIntervention = (options.context as any)?.autonomy?.intervention;
    this.selectedIntervention = configuredIntervention === 'minimal' || configuredIntervention === 'high'
      ? configuredIntervention
      : 'normal';
    const contract = buildTaskContract(options.objective, options.context, options.history, options.attachments);
    const freshState: ProxyState = {
      version: 2,
      projectId: options.context.projectId,
      objective: options.objective,
      objectiveSignature: objectiveSignature(options.objective),
      contract,
      status: 'watching',
      events: [],
      interventions: [],
      deliverableEvidence: Object.fromEntries(contract.requiredDeliverables.map(item => [item, {
        observed: false,
        verified: false,
        evidenceEventIds: [],
      }])),
      actionCounts: {},
      lastGoalGap: contract.goal,
      lastDecisionAt: 0,
      lastReviewedEventId: 0,
      lastInterventionEventId: 0,
      helperUsed: false,
      adaptivePolicy: {
        cadence: this.selectedIntervention === 'minimal'
          ? 'quiet'
          : this.selectedIntervention === 'high' ? 'close' : 'normal',
        attentionSignals: [],
      },
      managerDirectives: [],
      coordinationEvents: [],
      situationModel: { progress: '', activeStrategy: '', unresolvedRisks: [], nextExpectedBoundary: '' },
      complexityModel: {
        level: 'moderate',
        criticalPath: [],
        dependencies: [],
        invariants: [],
        decisionPoints: [],
        uncertainty: [],
        recoveryBranches: [],
        verificationGates: [],
      },
      updatedAt: Date.now(),
    };
    this.state = this.restoreCompatibleState(freshState);
    this.eventCounter = this.state.events.reduce((highest, event) => Math.max(highest, event.id), 0);
  }

  start(): void {
    this.state.status = 'watching';
    this.bootstrapReviewPending = true;
    this.options.onTrace?.({
      type: 'autonomy_proxy_status',
      phase: 'independent_supervision',
      text: 'Proxy-Agent independently supervising this task',
      _autonomyProxy: true,
      timestamp: Date.now(),
    });
    this.schedulePersist();
    if (this.state.managerDirectives.some(item => item.status === 'active')) {
      this.reviewScore = CADENCE_SETTINGS[this.state.adaptivePolicy.cadence].scoreThreshold;
      if (this.scheduleReview('proxy_manager_directive')) this.bootstrapReviewPending = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    if (this.state.status !== 'complete') this.state.status = 'stopped';
    this.persistNow();
  }

  pause(): void {
    this.paused = true;
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    this.reviewTimer = null;
    if (this.state.status !== 'complete') this.state.status = 'stopped';
    this.persistNow();
  }

  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    this.state.status = 'watching';
    this.options.onTrace?.({ type: 'autonomy_proxy_status', phase: 'watching', text: 'User Proxy resumed', _autonomyProxy: true, timestamp: Date.now() });
    this.schedulePersist();
  }

  setIntervention(level: ProxyInterventionLevel): void {
    const cadence = level === 'minimal' ? 'quiet' : level === 'high' ? 'close' : 'normal';
    this.selectedIntervention = level;
    this.state.adaptivePolicy.cadence = cadence;
    if (this.reviewTimer) {
      clearTimeout(this.reviewTimer);
      this.reviewTimer = null;
    }
    if (level === 'minimal') {
      this.reviewScore = Math.min(this.reviewScore, CADENCE_SETTINGS.quiet.scoreThreshold - 1);
    } else if (!this.stopped && !this.paused && this.state.events.length > 0) {
      const threshold = CADENCE_SETTINGS[cadence].scoreThreshold;
      if (level === 'high') this.reviewScore = Math.max(this.reviewScore, threshold);
      if (this.reviewScore >= threshold) this.scheduleReview('intervention_changed');
    }
    this.options.onTrace?.({ type: 'autonomy_proxy_status', phase: 'policy_changed', text: `Proxy intervention set to ${level}`, _autonomyProxy: true, timestamp: Date.now() });
    this.schedulePersist();
  }

  setModel(input: {
    mode: MainAgentMode;
    apiKey: string;
    runtimeSettings?: ScopedRuntimeSettings | null;
  }): void {
    this.options.mode = input.mode;
    this.options.apiKey = input.apiKey;
    this.options.runtimeSettings = input.runtimeSettings;
    this.options.onTrace?.({
      type: 'autonomy_proxy_status',
      phase: 'model_changed',
      text: 'Proxy model updated for the next supervision review',
      _autonomyProxy: true,
      timestamp: Date.now(),
    });
  }

  receiveManagerDirective(input: Omit<ProxyManagerDirective, 'id' | 'createdAt' | 'status'>): { accepted: boolean; status: ProxyManagerDirective['status']; id?: string } {
    const message = compact(input.message, 2400);
    if (!message || this.stopped) return { accepted: false, status: 'pending' };
    const duplicate = this.state.managerDirectives.slice(-8).find(item =>
      (item.status === 'active' || item.status === 'pending') && messageSimilarity(item.message, message) >= 0.82,
    );
    if (duplicate) return { accepted: true, status: duplicate.status, id: duplicate.id };

    const directive: ProxyManagerDirective = {
      ...input,
      id: `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      message,
      createdAt: Date.now(),
      status: input.timing === 'now' ? 'active' : 'pending',
      expiresAt: input.expiresAt || (Date.now() + (input.timing === 'after_current' ? 24 * 60 * 60_000 : 30 * 60_000)),
    };
    if (directive.supersedesDirectiveId) {
      const superseded = this.state.managerDirectives.find(item => item.id === directive.supersedesDirectiveId && (item.status === 'active' || item.status === 'pending'));
      if (superseded) {
        superseded.status = 'rejected';
        superseded.disposition = `Superseded by ${directive.id}.`;
        this.addCoordinationEvent('proxy_rejection', superseded.disposition, superseded.id);
      }
    }
    this.state.managerDirectives.push(directive);
    this.state.managerDirectives.splice(0, Math.max(0, this.state.managerDirectives.length - 24));
    this.addCoordinationEvent('manager_request', `Proxy Manager requested ${directive.requestedAction || 'adaptive supervision'}: ${directive.message}`, directive.id);

    const directEmergencySteer = directive.timing === 'now' &&
      directive.requestedAction === 'interrupt_main' &&
      (directive.urgency === 'high' || directive.urgency === 'critical') &&
      (directive.target === 'main' || directive.target === 'both');
    if (directEmergencySteer) {
      const accepted = this.options.steer(directive.message, {
        _autonomyProxy: true,
        _proxyManager: true,
        proxyAction: 'interrupt_main',
        proxyManagerDirectiveId: directive.id,
        proxyManagerIntent: directive.intent,
        proxyReason: directive.rationale,
        proxySeverity: directive.urgency,
        interruptMain: true,
      });
      directive.status = accepted ? 'delivered' : 'rejected';
      directive.deliveredAt = accepted ? Date.now() : undefined;
      directive.disposition = accepted
        ? 'Urgent correction was injected directly at Main\'s next model boundary and mirrored into Proxy supervision.'
        : 'Main was not available for urgent steering.';
      this.addCoordinationEvent(accepted ? 'main_interrupted' : 'proxy_rejection', directive.disposition, directive.id);
    }

    // The user-facing manager never bypasses the runtime Proxy. The supervisor
    // owns timing and may deliver, defer, or reject the request after comparing
    // it with live Main evidence. This prevents conversational suggestions from
    // becoming noisy direct injections.
    if (directive.target === 'proxy' || directive.target === 'both') {
      this.state.adaptivePolicy.attentionSignals = unique([
        directive.timing === 'now' ? directive.message : (directive.activationCondition || directive.message),
        ...this.state.adaptivePolicy.attentionSignals,
      ], 10);
    }
    if (directive.timing === 'now' && !directEmergencySteer) {
      this.addCoordinationEvent('proxy_acknowledgement', 'Runtime Proxy accepted the request for contextual review.', directive.id);
      this.reviewScore = Math.max(this.reviewScore, CADENCE_SETTINGS[this.state.adaptivePolicy.cadence].scoreThreshold);
      this.scheduleReview('proxy_manager_directive');
    } else {
      this.addCoordinationEvent('proxy_deferral', `Runtime Proxy staged this request for ${directive.timing.replace(/_/g, ' ')}${directive.activationCondition ? `: ${directive.activationCondition}` : '.'}`, directive.id);
    }
    this.options.onTrace?.({
      type: 'autonomy_proxy_status',
      phase: 'manager_directive',
      text: directive.status === 'pending' ? 'Proxy Manager queued guidance for the completion boundary' : 'Proxy Manager updated the autonomy loop',
      _autonomyProxy: true,
      _proxyManager: true,
      timestamp: Date.now(),
    });
    this.schedulePersist();
    return { accepted: true, status: directive.status, id: directive.id };
  }

  private addCoordinationEvent(kind: ProxyCoordinationEvent['kind'], message: string, directiveId?: string): void {
    this.state.coordinationEvents.push({
      id: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind,
      directiveId,
      message: compact(message, 1200),
      timestamp: Date.now(),
    });
    this.state.coordinationEvents = this.state.coordinationEvents.slice(-40);
  }

  getManagerSnapshot(): Record<string, any> {
    return {
      status: this.paused ? 'paused' : this.state.status,
      objective: this.state.objective,
      contract: this.state.contract,
      mainPhase: this.mainPhase,
      lastGoalGap: this.state.lastGoalGap,
      situationModel: this.state.situationModel,
      complexityModel: this.state.complexityModel,
      interventionLevel: this.selectedIntervention,
      recentEvents: this.state.events.slice(-18).map(event => ({ id: event.id, kind: event.kind, type: event.type, text: event.text, failed: event.failed, risk: event.risk, timestamp: event.timestamp })),
      recentInterventions: this.state.interventions.slice(-6),
      managerDirectives: this.state.managerDirectives.slice(-10),
      coordinationEvents: this.state.coordinationEvents.slice(-16),
    };
  }

  observe(trace: any): void {
    if (this.stopped || this.paused || !trace) return;

    const now = Date.now();
    for (const directive of this.state.managerDirectives) {
      if ((directive.status === 'active' || directive.status === 'pending') && directive.expiresAt && directive.expiresAt < now) {
        directive.status = 'expired';
        directive.disposition = 'Expired before a safe and useful delivery boundary appeared.';
        this.addCoordinationEvent('proxy_rejection', directive.disposition, directive.id);
      }
    }

    if (trace.type === 'steering_applied' && this.pendingGuidance) {
      const lastGuidance = this.state.interventions[this.state.interventions.length - 1]?.message || '';
      if (!lastGuidance || compact(trace.text, 2400).includes(compact(lastGuidance, 1400))) {
        this.pendingGuidance = false;
        this.state.status = 'watching';
      }
      const directiveId = compact(trace.proxyManagerDirectiveId || trace.metadata?.proxyManagerDirectiveId, 160);
      if (directiveId) {
        const directive = this.state.managerDirectives.find(item => item.id === directiveId);
        if (directive) {
          directive.status = 'delivered';
          directive.deliveredAt = Date.now();
          this.addCoordinationEvent('outcome', 'Main consumed the supervisor guidance at a model boundary.', directive.id);
        }
      }
    }
    if (trace._autonomyProxy) return;

    const traceType = String(trace.type || '');
    if (traceType === 'answer' && (trace.isStreaming === true || trace.isDelta === true)) {
      this.mainPhase = 'composing';
    } else if (traceType === 'thought_stream' || traceType === 'work_note') {
      this.mainPhase = 'working';
    } else if (['tool_call', 'action', 'command'].includes(traceType)) {
      this.mainPhase = 'acting';
    } else if (['error'].includes(traceType)) {
      this.mainPhase = 'recovering';
    } else if (['tool_result', 'file_preview', 'evidence', 'work_note'].includes(traceType)) {
      this.mainPhase = 'working';
    }

    if (trace.type === 'steering_received') {
      this.humanOverrideUntil = Date.now() + HUMAN_OVERRIDE_SILENCE_MS;
    }

    const event = this.normalizeEvent(trace);
    if (!event) return;
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) this.state.events = this.state.events.slice(-MAX_EVENTS);
    this.updateWorldModel(event);
    const conditionalDirective = this.state.managerDirectives.find(item =>
      item.status === 'pending' && item.timing === 'when_relevant' && item.expiresAt && item.expiresAt > Date.now(),
    );
    if (conditionalDirective) {
      // Telemetry is the wake-up signal; the model decides semantic relevance.
      // No brittle string matcher is allowed to turn the condition into guidance.
      this.reviewScore = Math.max(this.reviewScore, CADENCE_SETTINGS[this.state.adaptivePolicy.cadence].scoreThreshold);
    }
    this.reviewScore += this.eventScore(event);
    this.schedulePersist();

    if (this.pendingGuidance || Date.now() < this.humanOverrideUntil) return;
    const cadence = CADENCE_SETTINGS[this.state.adaptivePolicy.cadence];
    if (
      this.bootstrapReviewPending &&
      this.state.events.length >= cadence.bootstrapAfterEvents &&
      (this.state.adaptivePolicy.cadence === 'close' || event.kind !== 'intent')
    ) {
      if (this.scheduleReview('task_bootstrap')) this.bootstrapReviewPending = false;
    }
    const initialSilence = this.state.adaptivePolicy.cadence === 'quiet'
      ? INITIAL_SILENCE_MS * 1.5
      : this.state.adaptivePolicy.cadence === 'close' ? 4_000 : INITIAL_SILENCE_MS;
    if (Date.now() - this.startedAt < initialSilence && !event.risk) return;

    const eventsAfterIntervention = event.id - this.state.lastInterventionEventId;
    if (eventsAfterIntervention < cadence.eventsAfterIntervention && !event.risk) return;

    const reviewAge = Date.now() - this.state.lastDecisionAt;
    const urgent = event.risk || this.consecutiveFailures >= cadence.failuresBeforeGuidance || event.repeated;
    const materialCheckpoint = this.reviewScore >= cadence.scoreThreshold;
    const periodicCheckpoint = reviewAge >= cadence.periodicMs && this.reviewScore >= Math.max(4, cadence.scoreThreshold / 2);
    if (urgent || materialCheckpoint || periodicCheckpoint) {
      this.scheduleReview(urgent ? this.urgentTrigger(event) : 'material_execution_checkpoint');
    }
  }

  async reviewCompletion(candidate: string): Promise<ProxyDecision> {
    if (this.stopped || this.paused) return { action: 'approve_completion', reason: 'Proxy inactive.' };
    if (this.reviewTimer) {
      clearTimeout(this.reviewTimer);
      this.reviewTimer = null;
    }
    if (this.reviewPromise) await this.reviewPromise.catch(() => undefined);
    if (this.pendingGuidance) {
      return {
        action: 'steer',
        message: this.state.interventions[this.state.interventions.length - 1]?.message || 'Apply the pending guidance before completing.',
        reason: 'Main has not processed the latest Proxy intervention.',
        remainingGoalGap: this.state.lastGoalGap,
      };
    }

    this.state.status = 'reviewing';
    this.mainPhase = 'completion_review';
    for (const directive of this.state.managerDirectives) {
      if (directive.status === 'pending' && directive.timing === 'before_completion') {
        directive.status = 'active';
        this.addCoordinationEvent('proxy_acknowledgement', 'Completion boundary reached; runtime Proxy activated the staged concept for semantic review.', directive.id);
      }
    }
    let decision: ProxyDecision;
    try {
      decision = await this.runReview('completion_candidate', candidate);
    } catch (error: any) {
      // Proxy capacity must never turn a successful Main run into a failure.
      this.state.status = 'complete';
      this.schedulePersist();
      return {
        action: 'approve_completion',
        reason: `Proxy review unavailable; completion left to Main: ${compact(error?.message || error, 180)}`,
      };
    }

    this.applyAdaptiveUpdates(decision);

    if (decision.action === 'approve_completion' || decision.action === 'observe' || decision.optionalImprovement) {
      const followUp = this.state.managerDirectives.find(item => item.status === 'pending' && item.timing === 'after_current');
      if (followUp) {
        const queued = this.options.queueNext(
          followUp.message,
          followUp.rationale || 'The user explicitly scheduled this as a separate task after the current task.',
        );
        followUp.status = queued ? 'delivered' : 'rejected';
        followUp.deliveredAt = queued ? Date.now() : undefined;
        followUp.disposition = queued
          ? 'Queued as an isolated successor task; it was not injected into the completing run.'
          : 'Could not queue the successor task.';
        this.addCoordinationEvent(queued ? 'proxy_delivery' : 'proxy_rejection', followUp.disposition, followUp.id);
      }
      this.state.status = 'complete';
      this.options.onTrace?.({
        type: 'autonomy_proxy_status',
        phase: 'approved',
        text: 'User Proxy accepted completion',
        _autonomyProxy: true,
        timestamp: Date.now(),
      });
      this.schedulePersist();
      return { ...decision, action: 'approve_completion' };
    }
    if (!this.isGroundedDecision(decision, true, candidate)) {
      this.state.status = 'complete';
      this.schedulePersist();
      return { action: 'approve_completion', reason: 'Proxy rejection lacked concrete evidence.' };
    }
    const delivered = this.applyDecision(decision, true);
    if (!delivered) {
      this.state.status = 'complete';
      this.schedulePersist();
      return {
        action: 'approve_completion',
        reason: 'Proxy did not deliver a new actionable correction, so completion was not blocked.',
      };
    }
    return decision;
  }

  private restoreCompatibleState(freshState: ProxyState): ProxyState {
    try {
      const saved = fs.readJsonSync(statePathFor(freshState.projectId));
      if (saved?.version !== 2) return freshState;
      if (saved?.objectiveSignature !== freshState.objectiveSignature || saved?.status === 'complete') {
        const carried = (Array.isArray(saved.managerDirectives) ? saved.managerDirectives : [])
          .filter((item: ProxyManagerDirective) =>
            (item.status === 'active' || item.status === 'pending') &&
            (item.scope === 'next_task' || item.scope === 'persistent_mandate') &&
            (!item.expiresAt || item.expiresAt > Date.now()),
          )
          .map((item: ProxyManagerDirective) => ({
            ...item,
            status: 'active' as const,
            timing: item.scope === 'next_task' ? 'now' as const : 'when_relevant' as const,
            disposition: item.scope === 'next_task'
              ? 'Activated at the start of the requested next task.'
              : 'Persistent supervisory mandate carried into the new task.',
          }));
        if (carried.length === 0) return freshState;
        return {
          ...freshState,
          managerDirectives: carried.slice(-12),
          coordinationEvents: [
            ...(Array.isArray(saved.coordinationEvents) ? saved.coordinationEvents.slice(-8) : []),
            ...carried.map((item: ProxyManagerDirective) => ({
              id: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              kind: 'proxy_acknowledgement' as const,
              directiveId: item.id,
              message: item.disposition || 'Supervisory mandate carried into the new task.',
              timestamp: Date.now(),
            })),
          ].slice(-40),
          adaptivePolicy: {
            ...freshState.adaptivePolicy,
            attentionSignals: unique(carried.map((item: ProxyManagerDirective) => item.activationCondition || item.message), 10),
          },
        };
      }
      return {
        ...freshState,
        events: Array.isArray(saved.events) ? saved.events.slice(-MAX_EVENTS) : [],
        interventions: Array.isArray(saved.interventions) ? saved.interventions.slice(-MAX_INTERVENTIONS) : [],
        deliverableEvidence: { ...freshState.deliverableEvidence, ...(saved.deliverableEvidence || {}) },
        actionCounts: saved.actionCounts && typeof saved.actionCounts === 'object' ? saved.actionCounts : {},
        lastGoalGap: compact(saved.lastGoalGap || freshState.lastGoalGap, 1600),
        lastDecisionAt: Number(saved.lastDecisionAt || 0),
        lastReviewedEventId: Number(saved.lastReviewedEventId || 0),
        lastInterventionEventId: Number(saved.lastInterventionEventId || 0),
        helperUsed: saved.helperUsed === true,
        adaptivePolicy: {
          cadence: freshState.adaptivePolicy.cadence,
          attentionSignals: Array.isArray(saved?.adaptivePolicy?.attentionSignals)
            ? unique(saved.adaptivePolicy.attentionSignals, 10)
            : [],
        },
        managerDirectives: Array.isArray(saved.managerDirectives) ? saved.managerDirectives.slice(-24) : [],
        coordinationEvents: Array.isArray(saved.coordinationEvents) ? saved.coordinationEvents.slice(-40) : [],
        situationModel: {
          progress: compact(saved?.situationModel?.progress, 1400),
          activeStrategy: compact(saved?.situationModel?.activeStrategy, 1000),
          unresolvedRisks: Array.isArray(saved?.situationModel?.unresolvedRisks) ? unique(saved.situationModel.unresolvedRisks, 8) : [],
          nextExpectedBoundary: compact(saved?.situationModel?.nextExpectedBoundary, 700),
        },
        complexityModel: {
          level: new Set(['simple', 'moderate', 'complex', 'frontier']).has(saved?.complexityModel?.level)
            ? saved.complexityModel.level
            : freshState.complexityModel.level,
          criticalPath: Array.isArray(saved?.complexityModel?.criticalPath) ? unique(saved.complexityModel.criticalPath, 12) : [],
          dependencies: Array.isArray(saved?.complexityModel?.dependencies) ? unique(saved.complexityModel.dependencies, 16) : [],
          invariants: Array.isArray(saved?.complexityModel?.invariants) ? unique(saved.complexityModel.invariants, 16) : [],
          decisionPoints: Array.isArray(saved?.complexityModel?.decisionPoints) ? unique(saved.complexityModel.decisionPoints, 12) : [],
          uncertainty: Array.isArray(saved?.complexityModel?.uncertainty) ? unique(saved.complexityModel.uncertainty, 12) : [],
          recoveryBranches: Array.isArray(saved?.complexityModel?.recoveryBranches) ? unique(saved.complexityModel.recoveryBranches, 12) : [],
          verificationGates: Array.isArray(saved?.complexityModel?.verificationGates) ? unique(saved.complexityModel.verificationGates, 12) : [],
        },
        status: saved.status || 'watching',
      };
    } catch {
      return freshState;
    }
  }

  private normalizeEvent(trace: any): ProxyEvent | null {
    const type = String(trace.type || 'event');
    if (['work_note_cancel', 'done', 'answer'].includes(type)) return null;
    if (type === 'thought_stream') {
      if (Date.now() - this.lastThoughtSampleAt < 14_000) return null;
      this.lastThoughtSampleAt = Date.now();
    }

    const tool = compact(trace.tool || trace.toolName || trace.name || trace.functionName || '', 120);
    const rawText = trace.text || trace.data || trace.output || trace.result || trace.error || trace.message ||
      (tool ? `${tool} ${JSON.stringify(trace.args || trace.input || {})}` : '');
    const text = compact(rawText, type === 'thought_stream' ? 900 : 1800);
    if (!text && !tool) return null;

    const failed = type === 'error' || trace.success === false || trace.status === 'failed' ||
      /\b(error|failed|denied|rate limit|timed out|timeout|not found|unable to)\b/i.test(text);
    const risk = this.detectRisk(tool, text);
    const signature = this.eventSignature(type, tool, text, trace);
    const count = (this.state.actionCounts[signature] || 0) + 1;
    const repeated = count >= 3 && ['tool_call', 'action', 'command', 'error'].includes(type);

    return {
      id: ++this.eventCounter,
      type,
      kind: this.eventKind(type, failed),
      text,
      tool: tool || undefined,
      signature,
      failed,
      risk,
      repeated,
      timestamp: Date.now(),
    };
  }

  private eventKind(type: string, failed: boolean): ProxyEvent['kind'] {
    if (failed) return 'failure';
    if (['thought_stream', 'work_note', 'plan', 'task_plan'].includes(type)) return 'intent';
    if (['tool_call', 'action', 'command'].includes(type)) return 'action';
    if (['tool_result', 'console_output', 'evidence'].includes(type)) return 'result';
    if (['file_preview', 'artifact', 'file_created'].includes(type)) return 'artifact';
    if (type === 'ask_user') return 'question';
    if (type === 'steering_received') return 'human_guidance';
    return 'other';
  }

  private eventSignature(type: string, tool: string, text: string, trace: any): string {
    const target = compact(
      trace?.args?.path || trace?.args?.filepath || trace?.args?.command || trace?.input?.path || trace?.filepath || '',
      260,
    );
    const base = `${type}|${tool}|${target || text.slice(0, 240)}`
      .toLowerCase()
      .replace(/\d{10,}/g, '#')
      .replace(/\s+/g, ' ')
      .trim();
    return base.slice(0, 420);
  }

  private detectRisk(tool: string, text: string): boolean {
    const destructive = /\b(remove-item|rm\s+-r|del(?:ete)?\b|rmdir|move-item|format\b|overwrite|truncate|drop\s+(?:table|database))\b/i;
    const forbiddenTerms = this.state.contract.forbiddenActions
      .flatMap(item => item.toLowerCase().match(/[a-z0-9]{4,}/g) || [])
      .filter(term => !['that', 'this', 'with', 'from', 'when', 'only'].includes(term));
    const combined = `${tool} ${text}`;
    if (destructive.test(combined)) return true;
    return forbiddenTerms.length >= 2 && forbiddenTerms.filter(term => combined.toLowerCase().includes(term)).length >= 2;
  }

  private updateWorldModel(event: ProxyEvent): void {
    this.state.actionCounts[event.signature] = (this.state.actionCounts[event.signature] || 0) + 1;
    this.consecutiveFailures = event.failed ? this.consecutiveFailures + 1 : event.kind === 'result' || event.kind === 'artifact' ? 0 : this.consecutiveFailures;

    for (const [deliverable, evidence] of Object.entries(this.state.deliverableEvidence)) {
      const stopWords = new Set(['create', 'produce', 'write', 'generate', 'save', 'output', 'deliver', 'open', 'copy', 'export', 'report', 'when', 'then', 'with', 'from', 'into', 'inside', 'should', 'must']);
      const tokens = (deliverable.toLowerCase().match(/[a-z0-9_.-]{3,}/g) || [])
        .filter(token => !stopWords.has(token));
      const matched = tokens.filter(token => event.text.toLowerCase().includes(token));
      const requiredMatches = tokens.some(token => token.includes('.')) ? 1 : Math.min(2, tokens.length);
      if (tokens.length === 0 || matched.length < requiredMatches) continue;
      evidence.observed = true;
      evidence.verified = evidence.verified || (!event.failed && ['artifact', 'result'].includes(event.kind));
      evidence.evidenceEventIds = unique([...evidence.evidenceEventIds.map(String), String(event.id)], 8).map(Number);
    }
  }

  private eventScore(event: ProxyEvent): number {
    const attentionMatch = this.state.adaptivePolicy.attentionSignals.some(signal => {
      const terms = signal.toLowerCase().match(/[a-z0-9]{4,}/g) || [];
      return terms.length > 0 && terms.some(term => event.text.toLowerCase().includes(term));
    });
    const adaptiveBoost = attentionMatch ? 3 : 0;
    if (event.risk) return 12;
    if (event.repeated) return 9;
    if (event.failed) return 4 + adaptiveBoost;
    if (event.kind === 'artifact') return 4 + adaptiveBoost;
    if (event.kind === 'result') return 3 + adaptiveBoost;
    if (event.kind === 'action') return 2 + adaptiveBoost;
    if (event.kind === 'question') return 4 + adaptiveBoost;
    if (event.kind === 'intent') return 0.5 + adaptiveBoost;
    return 0.5 + adaptiveBoost;
  }

  private urgentTrigger(event: ProxyEvent): string {
    if (event.risk) return 'possible_constraint_or_safety_violation';
    if (event.repeated) return 'repeated_action_or_loop';
    return 'consecutive_execution_failures';
  }

  private scheduleReview(trigger: string): boolean {
    if (this.reviewPromise || this.reviewTimer || this.stopped || this.pendingGuidance || this.mainPhase === 'composing' || this.mainPhase === 'completion_review') return false;
    const elapsed = Date.now() - this.state.lastDecisionAt;
    const urgent = trigger !== 'material_execution_checkpoint';
    // Do not arm a delayed background review that can wake while Main is
    // silently composing a response. Non-urgent reviews wait for the next
    // observable execution boundary once cadence permits; urgent evidence is
    // reviewed immediately.
    if (!urgent && elapsed < CADENCE_SETTINGS[this.state.adaptivePolicy.cadence].minIntervalMs) return false;
    const delay = 0;
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = null;
      if (this.stopped || this.reviewPromise || this.pendingGuidance || this.mainPhase === 'composing' || this.mainPhase === 'completion_review' || (trigger !== 'proxy_manager_directive' && Date.now() < this.humanOverrideUntil)) return;
      this.reviewPromise = this.runReview(trigger)
        .then(decision => {
          this.applyAdaptiveUpdates(decision);
          if (this.isGroundedDecision(decision, false)) this.applyDecision(decision, false);
          else {
            this.state.status = 'watching';
            if (trigger === 'proxy_manager_directive') this.settleObservedManagerDirective(decision);
          }
          return decision;
        })
        .catch(() => {
          this.state.status = 'watching';
          return { action: 'observe' as const, reason: 'Proxy review unavailable; Main continues uninterrupted.' };
        })
        .finally(() => {
          this.reviewPromise = null;
          this.schedulePersist();
        });
    }, delay);
    this.reviewTimer.unref?.();
    return true;
  }

  private async runReview(trigger: string, completionCandidate = ''): Promise<ProxyDecision> {
    this.reviewScore = 0;
    this.state.lastDecisionAt = Date.now();
    this.state.status = 'reviewing';

    const recentRisk = this.state.events.slice(-10).some(event => event.risk || event.repeated);
    const posture = this.state.adaptivePolicy.cadence;
    const reviewDepth: 'scan' | 'standard' | 'deep' =
      completionCandidate || recentRisk || trigger === 'possible_constraint_or_safety_violation'
        ? 'deep'
        : trigger === 'task_bootstrap' ||
          trigger === 'proxy_manager_directive' ||
          trigger === 'intervention_changed' ||
          this.consecutiveFailures >= 2 ||
          (posture === 'close' && trigger === 'material_execution_checkpoint')
          ? 'standard'
          : 'scan';
    const evidenceLimit = reviewDepth === 'deep' ? 24 : reviewDepth === 'standard' ? 16 : 10;
    const investigationBudget = reviewDepth === 'deep'
      ? posture === 'close' ? 4 : posture === 'normal' ? 3 : 2
      : reviewDepth === 'standard'
        ? posture === 'close' ? 2 : posture === 'normal' ? 1 : 0
        : 0;
    const evidenceWindow = this.state.events.slice(-evidenceLimit);
    const reviewThroughEventId = evidenceWindow.reduce((highest, event) => Math.max(highest, event.id), this.state.lastReviewedEventId);
    const recent = evidenceWindow.map(event =>
      `#${event.id} [${event.kind}/${event.type}${event.tool ? `/${event.tool}` : ''}${event.failed ? '/FAILED' : ''}${event.risk ? '/RISK' : ''}${event.repeated ? '/REPEATED' : ''}] ${event.text}`,
    ).join('\n') || '(No material evidence yet.)';
    const prior = this.state.interventions.slice(-5).map(item =>
      `- ${item.action}: ${item.message} (evidence: ${item.evidenceEventIds.join(', ') || 'none'})`,
    ).join('\n') || '(none)';
    const deliverables = Object.entries(this.state.deliverableEvidence).map(([name, evidence]) =>
      `- ${name}: ${evidence.verified ? 'verified evidence observed' : evidence.observed ? 'mentioned but not verified' : 'not observed'}${evidence.evidenceEventIds.length ? ` [events ${evidence.evidenceEventIds.join(', ')}]` : ''}`,
    ).join('\n') || '(No explicit deliverables extracted.)';

    const interventionDoctrine = this.state.adaptivePolicy.cadence === 'quiet'
      ? [
        'MINIMAL INTERVENTION DOCTRINE:',
        '- Preserve Main\'s uninterrupted deep-work state as the default. Review primarily at irreversible-risk, explicit-constraint, repeated-blockage, and completion boundaries.',
        '- Do not intervene for a merely better approach, missing optional polish, uncertain telemetry, or a recoverable mistake Main can reasonably notice and repair.',
        '- Require a large counterfactual benefit: without your message, the task is likely to become materially wrong, unsafe, unauthorized, or falsely complete.',
        '- Prefer dormant attention and completion review over mid-task steering. One precise late correction is better than several preventative suggestions.',
        '- A command or tool failure is not an intervention trigger by itself. Allow Main room to repair recoverable failures, but act immediately when one failure proves a binding assumption false, exposes missing authority, or makes the strategy non-credible.',
        '- Escalate immediately only for concrete critical risk or an explicit urgent user directive.',
      ].join('\n')
      : this.state.adaptivePolicy.cadence === 'close'
        ? [
          'HIGH INTERVENTION DOCTRINE:',
          '- Act as an active expert supervisor. Inspect strategy transitions, dependencies, user constraints, evidence quality, recovery behavior, and completion claims early.',
          '- Intervene before substantial rework when evidence shows Main is committing to a materially wrong path, silently dropping a required dependency, or repeatedly operating without needed evidence.',
          '- High initiative does not mean frequent commentary. Consolidate related concerns into one actionable instruction and then give Main room to apply it.',
          '- Review the first failure early and interpret what it changes. Intervene immediately when it exposes a false assumption, missing authority, non-credible strategy, consequential drift, or concrete risk; otherwise watch the recovery with patience.',
          '- Challenge weak assumptions when they affect the outcome; redirect when the current strategy is no longer credible; interrupt only when the next action would create concrete harm or major wasted work.',
          '- Track unresolved risks across reviews and close them at the most useful natural boundary. Never manufacture urgency from incomplete visibility.',
        ].join('\n')
        : [
          'NORMAL INTERVENTION DOCTRINE:',
          '- Balance uninterrupted execution with timely expert supervision. Let healthy work proceed, but intervene when a consequential gap is supported and waiting would noticeably reduce quality or increase rework.',
          '- Review material checkpoints, strategy changes, repeated failures, important artifacts, explicit user constraints, and the completion boundary.',
          '- Prefer a concise steer at the next model boundary. Redirect only for a materially wrong strategy; challenge only when Main must reassess a consequential assumption.',
          '- Let Main repair an isolated mechanical error. Intervene after one failure when its meaning is structural—for example a false assumption, unavailable authority, invalid target, or infeasible strategy—or when waiting would create consequential rework.',
          '- Combine related observations, avoid duplicate guidance, and allow Main a fair opportunity to self-correct before escalating.',
          '- Treat optional improvements as silent notes, not blockers.',
        ].join('\n');

    const prompt = [
      'You are the persistent USER PROXY in a two-agent autonomous loop. Main performs the work. You remain actively engaged as a perceptive expert user: understand the trajectory, interpret failures, protect intent, and communicate with proportionate timing and firmness.',
      'ROLE SEPARATION: you are the live execution supervisor. You do not hold a parallel user conversation, invent new goals, or perform Main\'s task yourself. Proxy Manager is the user-facing coordinator; Main is the executor. You exclusively maintain task fidelity, supervise evidence, choose intervention timing, and guard completion.',
      'INDEPENDENCE: your mandate begins from the original task contract and Main telemetry. You never wait for Proxy Manager, a side conversation, or an external directive before supervising. Manager directives are optional additional context; they do not activate you and their absence never makes you passive.',
      'At task start, independently form a compact supervision model: intended outcome, hard constraints, required evidence, likely failure modes, irreversible boundaries, and completion gates. Update it from Main evidence rather than repeatedly re-planning the task.',
      'Intent hierarchy: (1) explicit user prohibitions, requirements, authority limits, and exact mechanisms are binding; (2) requested deliverables and success conditions define completion; (3) user preferences guide quality when compatible; (4) inferred implementation tactics are disposable. Never protect a failing tactic at the expense of the user\'s actual outcome.',
      'Pivot doctrine: preserve the goal and binding rules while allowing Main to replace tools, commands, services, sequence, decomposition, or implementation technique. Recommend a pivot only when evidence makes the current strategy non-credible, not merely because another approach exists.',
      'AI failure model: watch for local optimization that loses the global goal, action inertia after a tactic stops working, confirmation bias toward earlier claims, misreading tool output, confusing generated artifacts with usable deliverables, context decay that drops old constraints, premature satisficing, scope expansion, and confident completion without outcome evidence. These are attention hypotheses, never assumed defects.',
      'Intervention-cost model: interruption fragments Main\'s working context, competes with self-correction, and can anchor execution on your local diagnosis. Repeated prompts are especially harmful. Speak only when the counterfactual is clear: without this message, a consequential user outcome is likely to worsen.',
      'Resource economics: supervision also consumes latency, model tokens, and tool capacity. Spend them in proportion to uncertainty and consequence. Reuse the durable situation model, inspect only facts that could change the decision, and never perform broad research merely to make an observe decision feel more thorough.',
      'Your observations are incomplete telemetry, not omniscience. Never claim an action failed, a file is missing, or a constraint was violated unless the supplied evidence supports it. Lack of visibility is not proof of failure.',
      'Thought streams, streaming work notes, and partially composed response text are unfinished internal activity. Never ask Main to provide a full answer, full code, or final response based on those fragments. Only completion_candidate contains a finished response that may be judged for completeness.',
      'Use intelligent counterfactual judgment, not fixed patterns: predict what a capable Main will naturally do next. Before speaking, compare the expected benefit of intervention with the cost of interrupting flow. If Main is likely to handle the issue correctly without you, observe—even if you can imagine an improvement.',
      'Questions are expensive. Infer ordinary implementation details, use available evidence, and trust Main on routine choices. Ask for real-user involvement only when the information or authority is genuinely human-exclusive and the outcome materially depends on it.',
      'Intervene for: a concrete safety/constraint violation; execution Main is not credibly recovering; a failure that changes feasibility, authority, or a binding assumption; a materially wrong strategy; an unresolved decision requiring the real user; or a required completion gap.',
      'Failure temperament: classify before reacting. Distinguish malformed invocation, transient service failure, missing capability, missing credential/authority, invalid assumption, and fundamentally infeasible strategy. Give mechanical recovery patience, but do not wait for repetition when one evidenced failure already invalidates the plan. Respond to the meaning and consequence of failure, never its mere existence. Do not become an interactive command debugger.',
      'Recovery ladder: first observe self-correction; then steer the missing outcome or constraint; redirect only when the strategy is no longer credible; request the real user only for genuinely human-exclusive information or authority; stop only for critical active harm. Never escalate merely because a tool is inconvenient.',
      'You are Main\'s runtime supervisor, not merely an adviser. You may steer Main at a model boundary, redirect its strategy, or interrupt it. Use stop_main only for a critical active safety/authority violation or an explicit user-authorized stop request carried by an active Proxy Manager directive. Never stop merely because progress is imperfect, slow, or uncertain.',
      'Proxy Manager directives are user-facing requests to you, not commands injected straight into Main. Semantically decide whether to absorb them into your mandate, deliver now, defer to a natural boundary, or reject them as redundant/harmful. When acting on one, return its exact managerDirectiveId. Prefer one consolidated high-value instruction over repeated incremental coaching.',
      'Any message delivered to Main appears as a real user message. Write it directly in a calm human voice. Never say "Main", "the agent", "Proxy-Agent", "User Proxy", "runtime", "directive", or describe what another component is doing. State the desired outcome or correction itself.',
      'Message formation: write like a capable human correcting the work, not a debugger controlling keystrokes. State the unmet outcome, the constraint that must hold, and the evidence that will count as done. Do not prescribe PowerShell, shell syntax, commands, flags, tool names, or code snippets unless the original user explicitly required that exact mechanism. Never resend the same diagnosis with different wording.',
      'The message field is the exact final user prompt Main will see. It must stand alone and sound natural. Use the shortest shape that fits: correction = unmet outcome + binding rule + done evidence; pivot = unchanged outcome + freedom to replace the failing tactic; clarification = one human-exclusive decision; completion gap = missing required result + proof needed; safety = boundary that must not be crossed. Do not include your rationale or component names.',
      'promptIntent is the private semantic frame used to validate that message. outcome states what must change; preserveRules lists only binding rules relevant now; acceptanceEvidence states observable proof; strategyFreedom is free unless the user constrained the method, bounded when some methods are excluded, and exact only when the user explicitly required a mechanism; whyNow explains the evidence-backed timing privately.',
      'A pending when_relevant directive is dormant supervisory memory. Compare its activationCondition with the evolving situation, but do not mention or deliver it until it has real present value. A before_completion directive activates only during completion review. An after_current directive remains isolated from the current objective. This lets one compressed user concept guide later work without repeated side-agent model calls.',
      'The coordination history is two-way memory. Use it to avoid duplicate guidance and to tell whether Main consumed earlier supervision. Active supervision is continuous; an external message is warranted whenever its expected value clearly exceeds its disruption cost.',
      'Do not intervene for optional polish, style preference, speculative improvement, ordinary planning, or a mechanical failure Main is credibly correcting. Do intervene when the evidence changes the task\'s feasibility, authority, strategy credibility, constraint compliance, or completion truth.',
      'The task contract began as a conservative machine-extracted seed, not a fixed truth. Semantically refine it only from the current goal and relevant prior-user context. Do not turn optional ideas into required deliverables.',
      'Omit contractUpdate unless the seed is materially wrong. When correcting it, return the complete corrected requiredDeliverables and completionConditions. Explicit forbiddenActions and safetyConstraints may be strengthened but never weakened.',
      'The user-selected intervention posture is authoritative and cannot be changed by your response. Adapt only the task-specific attention signals within that posture.',
      interventionDoctrine,
      'You have bounded read-only investigation tools. Use them only when a consequential factual uncertainty cannot be resolved from Main telemetry and the answer could change whether intervention is necessary. Never edit, execute Main\'s task, or use tools for routine curiosity. Tool findings are supervisory evidence, not permission to take over execution.',
      `REVIEW DEPTH: ${reviewDepth.toUpperCase()}. Read-only investigation budget for this review: at most ${investigationBudget} tool call${investigationBudget === 1 ? '' : 's'}. ${reviewDepth === 'scan' ? 'Use telemetry and durable memory only; do not call tools.' : reviewDepth === 'standard' ? 'Resolve at most one decision-changing uncertainty.' : 'Investigate only the few consequential uncertainties needed for safety or completion judgment.'}`,
      this.state.helperUsed
        ? 'The one temporary specialist allowance is already used. Continue with telemetry and bounded read-only inspection.'
        : 'You may call spawn_sub_agent once in specialist mode only after direct read-only inspection is insufficient for a consequential domain uncertainty. Use exactly one focused task. Never create a panel, fleet, or general worker.',
      `TASK CONTRACT:\n${JSON.stringify(this.state.contract, null, 2)}`,
      'The priorUserContext field is reference context only. Treat it as part of the task only when the current goal explicitly continues or refers to it.',
      `CURRENT GOAL GAP (may be stale; revise from evidence):\n${this.state.lastGoalGap || '(unknown)'}`,
      `COMPACT SITUATION MODEL FROM PRIOR REVIEWS:\n${JSON.stringify(this.state.situationModel, null, 2)}`,
      `DURABLE COMPLEXITY MODEL:\n${JSON.stringify(this.state.complexityModel, null, 2)}`,
      'Complex-task reasoning protocol: maintain the smallest accurate dependency graph that explains the work. Distinguish prerequisites from preferences, invariants from tactics, reversible experiments from commitments, and verification gates from ordinary progress. Track the critical path without forcing Main to follow a rigid plan when evidence supports adaptation.',
      'When work branches, reason about whether branches are independent, mutually constraining, or gated by a shared artifact. Do not demand sequential work merely because events arrive sequentially. Do not encourage parallel work when branches would race on the same mutable state, depend on an unresolved decision, or require the same scarce authority.',
      'When the strategy changes, test whether prior evidence remains valid, whether an invariant was silently weakened, and whether downstream work must be revised. A failed tactic is not a failed goal: prefer a bounded recovery branch when one exists, and escalate only when the failure changes feasibility, authority, safety, or the user-visible outcome.',
      'Treat uncertainty explicitly. Separate unknown facts, missing telemetry, unresolved user choices, and model speculation. Reduce uncertainty at the cheapest meaningful boundary. Never convert uncertainty into a claimed defect.',
      `DELIVERABLE EVIDENCE:\n${deliverables}`,
      `REVIEW TRIGGER: ${trigger}`,
      `CURRENT MAIN PHASE: ${this.mainPhase}. When this is composing, all visible answer text is partial and Main may already be producing exactly what is needed.`,
      `INDEPENDENT STARTUP REVIEW: ${trigger === 'task_bootstrap' ? 'Build the supervision model now. Do not invent a problem and do not intervene without grounded evidence; normally return observe with useful attention signals and situation/complexity updates.' : 'The independent startup review has already occurred or this is a later evidence boundary.'}`,
      `USER-SELECTED INTERVENTION POSTURE: ${this.state.adaptivePolicy.cadence === 'quiet' ? 'MINIMAL — remain silent unless evidence shows a serious safety, constraint, blockage, or required-completion failure' : this.state.adaptivePolicy.cadence === 'close' ? 'HIGH — inspect material uncertainty and deviations earlier, while still requiring evidence and avoiding optional-polish interruptions' : 'NORMAL — balance flow protection with timely intervention on consequential gaps'}. This posture changes initiative, never the truthfulness or safety standard.`,
      `RECENT MAIN EVIDENCE:\n${recent}`,
      `PRIOR PROXY GUIDANCE (do not repeat or paraphrase):\n${prior}`,
      `USER-APPROVED PROXY MANAGER DIRECTIVES:\n${this.state.managerDirectives.filter(item => item.status === 'active' || item.status === 'pending').slice(-10).map(item => `- [id=${item.id}; status=${item.status}; timing=${item.timing}; target=${item.target}; intent=${item.intent}; requested=${item.requestedAction || 'adaptive'}; urgency=${item.urgency || 'normal'}] ${item.message}`).join('\n') || '(none)'}`,
      `PROXY COORDINATION HISTORY:\n${this.state.coordinationEvents.slice(-12).map(item => `- [${item.kind}${item.directiveId ? `/${item.directiveId}` : ''}] ${item.message}`).join('\n') || '(none)'}`,
      completionCandidate ? `MAIN'S PROPOSED FINAL ANSWER:\n${compact(completionCandidate, 5000)}` : '',
      completionCandidate
        ? 'Approve unless a required, consequential gap is supported by specific event evidence or explicitly admitted in the final answer. Optional improvements must never block completion.'
        : 'Choose observe unless intervention is necessary now. If visibility is insufficient, record visibilityGap and observe; do not nag Main for information it is likely still gathering.',
      'Return exactly one JSON object:',
      '{"action":"observe|steer|redirect|challenge|request_real_user|interrupt_main|stop_main|approve_completion","message":"exact short natural user prompt, blank for observe/approve","reason":"private rationale including the counterfactual necessity test","remainingGoalGap":"concrete remaining goal gap or blank","confidence":0.0,"severity":"low|medium|high|critical","evidenceEventIds":[1],"promptIntent":{"outcome":"what must change now","preserveRules":["binding user rule relevant now"],"acceptanceEvidence":"observable proof of completion","strategyFreedom":"free|bounded|exact","whyNow":"private evidence-backed timing"},"managerDirectiveId":"matching active directive id or blank","managerNotice":"only a consequential concise update worth surfacing to Proxy Manager, otherwise blank","visibilityGap":"missing telemetry, if any","optionalImprovement":false,"attentionSignals":["task-specific signal"],"situationUpdate":{"progress":"durable compact progress summary","activeStrategy":"Main current strategy","unresolvedRisks":[],"nextExpectedBoundary":"next meaningful checkpoint"},"complexityUpdate":{"level":"simple|moderate|complex|frontier","criticalPath":[],"dependencies":[],"invariants":[],"decisionPoints":[],"uncertainty":[],"recoveryBranches":[],"verificationGates":[]},"contractUpdate":null}',
    ].filter(Boolean).join('\n\n');

    const { createIsolatedClient } = await import('../Agent');
    const client = createIsolatedClient(this.options.apiKey, this.options.mode, this.options.runtimeSettings);
    const proxyContext: any = {
      projectId: `${this.options.context.projectId}::user-proxy`,
      agentRuntime: 'user_proxy',
      isUserProxy: true,
      isProxyManager: false,
      proxyRole: 'independent_runtime_supervisor',
      disableSubAgents: this.state.helperUsed,
      allowAgentSpawning: !this.state.helperUsed,
      _userProxyHelperUsed: this.state.helperUsed,
      disableLongTermMemory: true,
      disableSessionPersistence: true,
      disableTaskStore: true,
      disableSharedCache: true,
      selectedModelMode: this.options.mode,
      selectedModelName: (this.options.context as any).selectedModelName,
      selectedThinkingLevel: this.selectedIntervention === 'high'
        ? 'high'
        : this.selectedIntervention === 'minimal' ? 'low' : 'medium',
      proxyInvestigationBudget: investigationBudget,
      maxToolCalls: Math.max(1, investigationBudget),
      workspacePath: (this.options.context as any).workspacePath,
      paths: Array.isArray((this.options.context as any).paths)
        ? [...(this.options.context as any).paths]
        : [],
      runtimeSettings: this.options.runtimeSettings,
    };
    let response: any;
    try {
      response = await client.executeMessageLoop(proxyContext, prompt, [], undefined, []);
    } catch (error) {
      // A user-selected Proxy model is a preference, not a single point of
      // failure. Quietly fall back to the configured runtime priority so Main
      // is never disturbed just because the selected Proxy model is unavailable.
      const selectedOverrides = JSON.stringify(this.options.runtimeSettings?.modelOverrides || {});
      const fallbackOverrides = JSON.stringify(this.options.fallbackRuntimeSettings?.modelOverrides || {});
      if (!this.options.fallbackApiKey || !this.options.fallbackMode || selectedOverrides === fallbackOverrides) throw error;
      const fallbackClient = createIsolatedClient(this.options.fallbackApiKey, this.options.fallbackMode, this.options.fallbackRuntimeSettings || null);
      response = await fallbackClient.executeMessageLoop({
        ...proxyContext,
        selectedModelMode: this.options.fallbackMode,
        runtimeSettings: this.options.fallbackRuntimeSettings || null,
      }, prompt, [], undefined, []);
    }
    this.state.helperUsed = Boolean(proxyContext._userProxyHelperUsed);
    const decision = extractDecision(response.text);
    const investigationEvidenceIds = this.recordInvestigationEvidence(response.trace);
    if (decision.action !== 'observe' && decision.action !== 'approve_completion' && investigationEvidenceIds.length > 0) {
      const decisionBasis = [
        decision.reason,
        decision.promptIntent?.whyNow,
        decision.promptIntent?.outcome,
        decision.message,
      ].filter(Boolean).join(' ');
      const linkedInvestigationIds = investigationEvidenceIds.filter(id => {
        const event = this.state.events.find(item => item.id === id);
        return Boolean(event && messageSimilarity(event.text, decisionBasis) >= 0.15);
      });
      decision.evidenceEventIds = unique([
        ...(decision.evidenceEventIds || []).map(String),
        ...linkedInvestigationIds.map(String),
      ], 8).map(Number);
    }
    this.state.lastReviewedEventId = reviewThroughEventId;
    if (decision.managerNotice) this.addCoordinationEvent('supervisor_notice', decision.managerNotice, decision.managerDirectiveId);
    return decision;
  }

  private recordInvestigationEvidence(trace: any): number[] {
    if (!Array.isArray(trace)) return [];
    const evidenceIds: number[] = [];
    const findings = trace
      .filter(item => item?.tool && item?.text)
      .filter(item => item.success !== false && !/\b(error|failed|denied|not found|unable to)\b/i.test(String(item.text)))
      .slice(-4);
    for (const finding of findings) {
      const tool = compact(finding.tool, 120);
      const text = compact(finding.text, 1200);
      if (!tool || !text) continue;
      const event: ProxyEvent = {
        id: ++this.eventCounter,
        type: 'proxy_investigation',
        kind: 'result',
        text: `Read-only ${tool} finding: ${text}`,
        tool,
        signature: `proxy_investigation|${tool}|${text.slice(0, 240)}`.toLowerCase(),
        failed: false,
        risk: false,
        repeated: false,
        timestamp: Date.now(),
      };
      this.state.events.push(event);
      evidenceIds.push(event.id);
    }
    if (this.state.events.length > MAX_EVENTS) this.state.events = this.state.events.slice(-MAX_EVENTS);
    return evidenceIds;
  }

  private isGroundedDecision(decision: ProxyDecision, completionReview: boolean, completionCandidate = ''): boolean {
    if (decision.action === 'observe' || decision.action === 'approve_completion') return false;
    if (decision.optionalImprovement) return false;
    const policy = CADENCE_SETTINGS[this.state.adaptivePolicy.cadence];
    const confidence = decision.confidence ?? 0;
    const requiredConfidence = completionReview ? policy.completionConfidence : policy.confidence;
    if (confidence < requiredConfidence) return false;
    if (!compact(decision.message, 1600)) return false;
    const knownIds = new Set(this.state.events.map(event => event.id));
    const evidenceIds = decision.evidenceEventIds || [];
    const citedEvents = evidenceIds
      .filter(id => knownIds.has(id))
      .map(id => this.state.events.find(event => event.id === id))
      .filter((event): event is ProxyEvent => Boolean(event));
    const managerDirective = decision.managerDirectiveId
      ? this.state.managerDirectives.find(item => item.id === decision.managerDirectiveId && (item.status === 'active' || item.status === 'pending'))
      : undefined;
    const hasEvidence = citedEvents.some(event => event.kind !== 'intent' && event.kind !== 'other');
    const onlyRecoverableFailureEvidence =
      citedEvents.length > 0 &&
      citedEvents.every(event => event.failed && !event.risk && !event.repeated);
    const structuralFailureDecision =
      (decision.severity === 'high' || decision.severity === 'critical') &&
      /\b(?:invalid|false|wrong)\s+(?:assumption|target|premise)|missing\s+(?:authority|credential|capability|permission)|unauthori[sz]ed|infeasible|not viable|cannot satisfy|fundamentally blocked\b/i.test(
        `${decision.reason || ''} ${decision.promptIntent?.whyNow || ''}`,
      );
    if (
      !completionReview &&
      onlyRecoverableFailureEvidence &&
      this.consecutiveFailures < policy.failuresBeforeGuidance &&
      !structuralFailureDecision
    ) {
      return false;
    }
    const midRunInterventions = this.state.interventions.filter(item =>
      item.timestamp >= this.startedAt &&
      item.action !== 'stop_main'
    ).length;
    if (
      !completionReview &&
      midRunInterventions >= policy.maxMidRunInterventions &&
      decision.severity !== 'critical' &&
      !citedEvents.some(event => event.risk)
    ) {
      return false;
    }
    const candidateAdmitsGap = completionReview &&
      /\b(not completed|not created|not finished|not verified|could not|couldn't|unable to|failed to|still missing|remains incomplete)\b/i.test(completionCandidate);
    const unverifiedDeliverables = Object.entries(this.state.deliverableEvidence)
      .filter(([, evidence]) => !evidence.verified)
      .map(([deliverable]) => deliverable);
    const hasContractEvidenceGap =
      completionReview &&
      unverifiedDeliverables.length > 0 &&
      Boolean(decision.promptIntent?.acceptanceEvidence) &&
      (
        unverifiedDeliverables.some(deliverable =>
          messageSimilarity(deliverable, decision.promptIntent?.outcome || decision.message || '') >= 0.12
        ) ||
        /\b(verify|evidence|confirm|prove|exists|usable|open|read back)\b/i.test(
          `${decision.promptIntent?.acceptanceEvidence || ''} ${decision.message || ''}`,
        )
      );
    const pendingCanActivate = managerDirective?.status !== 'pending' ||
      managerDirective.timing === 'when_relevant' ||
      (completionReview && managerDirective.timing === 'before_completion');
    if (managerDirective?.status === 'pending' && !pendingCanActivate) return false;
    const userAuthorizedSupervisorAction = Boolean(managerDirective && managerDirective.target !== 'proxy' && pendingCanActivate);
    if (!hasEvidence && !candidateAdmitsGap && !hasContractEvidenceGap && !userAuthorizedSupervisorAction && decision.action !== 'request_real_user') return false;
    if (decision.action === 'stop_main') {
      const explicitStop = managerDirective?.requestedAction === 'stop_main' && managerDirective.urgency === 'critical';
      if (!explicitStop && !((decision.confidence ?? 0) >= 0.92 && decision.severity === 'critical' && hasEvidence)) return false;
    }
    return true;
  }

  private settleObservedManagerDirective(decision: ProxyDecision): void {
    const directive = decision.managerDirectiveId
      ? this.state.managerDirectives.find(item => item.id === decision.managerDirectiveId)
      : [...this.state.managerDirectives].reverse().find(item => item.status === 'active');
    if (!directive) return;
    directive.status = 'delivered';
    directive.deliveredAt = Date.now();
    directive.disposition = decision.reason || 'Absorbed into the runtime Proxy mandate without interrupting Main.';
    this.addCoordinationEvent('proxy_delivery', directive.disposition, directive.id);
  }

  private applyAdaptiveUpdates(decision: ProxyDecision): void {
    if (decision.attentionSignals?.length) {
      this.state.adaptivePolicy.attentionSignals = unique(decision.attentionSignals, 10);
    }
    if (decision.situationUpdate) {
      this.state.situationModel = {
        progress: decision.situationUpdate.progress || this.state.situationModel.progress,
        activeStrategy: decision.situationUpdate.activeStrategy || this.state.situationModel.activeStrategy,
        unresolvedRisks: decision.situationUpdate.unresolvedRisks || this.state.situationModel.unresolvedRisks,
        nextExpectedBoundary: decision.situationUpdate.nextExpectedBoundary || this.state.situationModel.nextExpectedBoundary,
      };
    }
    if (decision.complexityUpdate) {
      const update = decision.complexityUpdate;
      this.state.complexityModel = {
        level: update.level || this.state.complexityModel.level,
        criticalPath: update.criticalPath || this.state.complexityModel.criticalPath,
        dependencies: update.dependencies || this.state.complexityModel.dependencies,
        invariants: update.invariants || this.state.complexityModel.invariants,
        decisionPoints: update.decisionPoints || this.state.complexityModel.decisionPoints,
        uncertainty: update.uncertainty || this.state.complexityModel.uncertainty,
        recoveryBranches: update.recoveryBranches || this.state.complexityModel.recoveryBranches,
        verificationGates: update.verificationGates || this.state.complexityModel.verificationGates,
      };
    }
    const update = decision.contractUpdate;
    if (!update) return;
    if (update.requiredDeliverables !== undefined) {
      this.state.contract.requiredDeliverables = unique(update.requiredDeliverables, 20);
    }
    if (update.completionConditions !== undefined) {
      this.state.contract.completionConditions = unique(update.completionConditions, 16);
    }
    if (update.forbiddenActions?.length) {
      this.state.contract.forbiddenActions = unique([...this.state.contract.forbiddenActions, ...update.forbiddenActions], 16);
    }
    if (update.safetyConstraints?.length) {
      this.state.contract.safetyConstraints = unique([...this.state.contract.safetyConstraints, ...update.safetyConstraints], 16);
    }
    const retainedEvidence: Record<string, DeliverableEvidence> = {};
    for (const deliverable of this.state.contract.requiredDeliverables) {
      retainedEvidence[deliverable] = this.state.deliverableEvidence[deliverable] || {
        observed: false,
        verified: false,
        evidenceEventIds: [],
      };
    }
    this.state.deliverableEvidence = retainedEvidence;
  }

  private applyDecision(decision: ProxyDecision, completionReview: boolean): boolean {
    this.state.lastGoalGap = decision.remainingGoalGap || this.state.lastGoalGap;
    if (decision.action === 'observe' || decision.action === 'approve_completion' || decision.optionalImprovement) {
      this.state.status = 'watching';
      this.schedulePersist();
      return false;
    }
    const directive = decision.managerDirectiveId
      ? this.state.managerDirectives.find(item => item.id === decision.managerDirectiveId)
      : undefined;
    const message = formHumanProxyPrompt({
      ...decision,
      message: decision.message || directive?.message || '',
      remainingGoalGap: decision.remainingGoalGap || this.state.lastGoalGap,
    }, this.state.contract);
    if (!message) return false;
    const topicKey = guidanceTopicKey(message);
    const recentInterventions = this.state.interventions.slice(-6);
    const newMaterialEvidence = this.state.events.some(event =>
      event.id > this.state.lastInterventionEventId &&
      (event.failed || event.repeated || event.risk || event.kind === 'artifact' || event.kind === 'result')
    );
    const repeatsRecentTopic = Boolean(topicKey && recentInterventions.some(item =>
      (item.topicKey || guidanceTopicKey(item.message)) === topicKey &&
      Date.now() - item.timestamp < 10 * 60_000 &&
      !newMaterialEvidence,
    ));
    const similarityThreshold = newMaterialEvidence ? 0.82 : 0.58;
    if (repeatsRecentTopic || recentInterventions.some(item => messageSimilarity(item.message, message) >= similarityThreshold)) {
      this.state.status = 'watching';
      this.schedulePersist();
      return false;
    }

    const evidenceEventIds = decision.evidenceEventIds || [];
    this.state.interventions.push({
      message,
      reason: decision.reason || '',
      action: decision.action,
      evidenceEventIds,
      topicKey,
      timestamp: Date.now(),
    });
    this.state.lastInterventionEventId = this.eventCounter;
    if (directive) {
      directive.status = 'active';
      directive.disposition = decision.reason || `Runtime Proxy chose ${decision.action}.`;
    }
    if (decision.action === 'stop_main') {
      const stopped = this.options.stopMain(message, {
        _autonomyProxy: true,
        _proxyManager: Boolean(directive),
        proxyManagerDirectiveId: directive?.id,
        proxyReason: decision.reason,
        proxySeverity: decision.severity,
      });
      if (directive) {
        directive.status = stopped ? 'delivered' : 'rejected';
        directive.deliveredAt = stopped ? Date.now() : undefined;
      }
      this.pendingGuidance = false;
      this.state.status = stopped ? 'stopped' : 'watching';
      this.addCoordinationEvent(stopped ? 'main_stopped' : 'proxy_rejection', stopped ? message : 'Main was already inactive; stop request was not applied.', directive?.id);
      this.schedulePersist();
      return stopped;
    }
    this.pendingGuidance = true;
    this.state.status = decision.action === 'request_real_user' ? 'needs_user' : 'waiting_for_main';
    const accepted = this.options.steer(message, {
      _autonomyProxy: true,
      proxyAction: decision.action,
      proxyReason: decision.reason,
      proxySeverity: decision.severity,
      proxyEvidenceEventIds: evidenceEventIds,
      proxyManagerDirectiveId: directive?.id,
      proxyManagerIntent: directive?.intent,
      interruptMain: decision.action === 'interrupt_main',
      completionReview,
    });
    if (accepted && directive) {
      directive.status = 'delivered';
      directive.deliveredAt = Date.now();
      this.addCoordinationEvent(decision.action === 'interrupt_main' ? 'main_interrupted' : 'proxy_delivery', message, directive.id);
    }
    if (!accepted) {
      this.pendingGuidance = false;
      this.state.status = 'watching';
    }
    this.schedulePersist();
    return accepted;
  }

  private get statePath(): string {
    return statePathFor(this.state.projectId);
  }

  private schedulePersist(): void {
    this.state.updatedAt = Date.now();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), 250);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      fs.ensureDirSync(path.dirname(this.statePath));
      fs.writeJsonSync(this.statePath, this.state, { spaces: 2 });
    } catch {
      // Persistence is advisory and must never block Main.
    }
  }
}

export function startUserProxyRuntime(options: RuntimeOptions): UserProxyRuntime | null {
  if (!isAutonomous(options.context)) return null;
  stopUserProxyRuntime(options.context.projectId);
  const runtime = new UserProxyRuntime(options);
  runtimes.set(options.context.projectId, runtime);
  runtime.start();
  return runtime;
}

export function observeUserProxy(projectId: string, trace: any): void {
  runtimes.get(projectId)?.observe(trace);
}

export async function reviewAutonomousCompletion(projectId: string, candidate: string): Promise<ProxyDecision> {
  const runtime = runtimes.get(projectId);
  if (!runtime) return { action: 'approve_completion', reason: 'No User Proxy runtime.' };
  return runtime.reviewCompletion(candidate);
}

export function stopUserProxyRuntime(projectId: string): void {
  const runtime = runtimes.get(projectId);
  if (!runtime) return;
  runtime.stop();
  runtimes.delete(projectId);
}

export function pauseUserProxyRuntime(projectId: string): boolean {
  const runtime = runtimes.get(projectId);
  if (!runtime) return false;
  runtime.pause();
  return true;
}

export function resumeUserProxyRuntime(projectId: string): boolean {
  const runtime = runtimes.get(projectId);
  if (!runtime) return false;
  runtime.resume();
  return true;
}

export function setUserProxyIntervention(projectId: string, level: ProxyInterventionLevel): boolean {
  const runtime = runtimes.get(projectId);
  if (!runtime) return false;
  runtime.setIntervention(level);
  return true;
}

export function setUserProxyModel(
  projectId: string,
  input: { mode: MainAgentMode; apiKey: string; runtimeSettings?: ScopedRuntimeSettings | null },
): boolean {
  const runtime = runtimes.get(projectId);
  if (!runtime) return false;
  runtime.setModel(input);
  return true;
}

export function getUserProxyManagerSnapshot(projectId: string): Record<string, any> | null {
  const live = runtimes.get(projectId)?.getManagerSnapshot();
  if (live) return live;
  try {
    const saved = fs.readJsonSync(statePathFor(projectId));
    if (!saved || saved.version !== 2) return null;
    return {
      status: saved.status || 'stopped',
      objective: compact(saved.objective, 6000),
      contract: saved.contract || null,
      mainPhase: 'complete',
      lastGoalGap: compact(saved.lastGoalGap, 1800),
      situationModel: saved.situationModel || null,
      complexityModel: saved.complexityModel || null,
      interventionLevel: saved?.adaptivePolicy?.cadence === 'quiet' ? 'minimal' : saved?.adaptivePolicy?.cadence === 'close' ? 'high' : 'normal',
      recentEvents: Array.isArray(saved.events) ? saved.events.slice(-18) : [],
      recentInterventions: Array.isArray(saved.interventions) ? saved.interventions.slice(-6) : [],
      managerDirectives: Array.isArray(saved.managerDirectives) ? saved.managerDirectives.slice(-10) : [],
      coordinationEvents: Array.isArray(saved.coordinationEvents) ? saved.coordinationEvents.slice(-16) : [],
      persisted: true,
    };
  } catch {
    return null;
  }
}

export function deliverUserProxyManagerDirective(
  projectId: string,
  directive: Omit<ProxyManagerDirective, 'id' | 'createdAt' | 'status'>,
): { accepted: boolean; status: ProxyManagerDirective['status']; id?: string } {
  const runtime = runtimes.get(projectId);
  if (!runtime) return { accepted: false, status: 'pending' };
  return runtime.receiveManagerDirective(directive);
}
