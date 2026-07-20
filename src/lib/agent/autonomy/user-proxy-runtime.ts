import fs from 'fs-extra';
import path from 'path';
import type { ProjectContext } from '../schemas';
import type { MainAgentMode } from '../model-routing';
import type { ScopedRuntimeSettings } from '../runtime-api-keys';

type TraceFn = (trace: any) => void;
type ProxyAction = 'observe' | 'steer' | 'redirect' | 'challenge' | 'request_real_user' | 'approve_completion';

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
  reviewCadence?: 'quiet' | 'normal' | 'close';
  attentionSignals?: string[];
  contractUpdate?: Partial<Pick<TaskContract, 'requiredDeliverables' | 'forbiddenActions' | 'safetyConstraints' | 'completionConditions'>>;
};

type TaskContract = {
  goal: string;
  priorUserContext: string[];
  requiredDeliverables: string[];
  forbiddenActions: string[];
  safetyConstraints: string[];
  completionConditions: string[];
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
    timestamp: number;
  }>;
  deliverableEvidence: Record<string, DeliverableEvidence>;
  actionCounts: Record<string, number>;
  lastGoalGap: string;
  lastDecisionAt: number;
  lastInterventionEventId: number;
  helperUsed: boolean;
  adaptivePolicy: {
    cadence: 'quiet' | 'normal' | 'close';
    attentionSignals: string[];
  };
  updatedAt: number;
};

type RuntimeOptions = {
  context: ProjectContext;
  objective: string;
  mode: MainAgentMode;
  apiKey: string;
  runtimeSettings?: ScopedRuntimeSettings | null;
  history?: any[];
  attachments?: Array<{ name?: string; path?: string; mimeType?: string }>;
  onTrace?: TraceFn;
  steer: (message: string, metadata?: Record<string, any>) => boolean;
};

export type ProxyInterventionLevel = 'minimal' | 'normal' | 'high';

const runtimes = new Map<string, UserProxyRuntime>();
const AUTONOMY_RUNTIME = 'autonomy_v1';
const MAX_EVENTS = 120;
const MAX_INTERVENTIONS = 8;
const INITIAL_SILENCE_MS = 12_000;
const MIN_REVIEW_INTERVAL_MS = 22_000;
const PERIODIC_REVIEW_MS = 55_000;
const HUMAN_OVERRIDE_SILENCE_MS = 90_000;
const MIN_EVENTS_AFTER_INTERVENTION = 2;
const REVIEW_SCORE_THRESHOLD = 10;

const CADENCE_SETTINGS = {
  quiet: { scoreThreshold: 16, minIntervalMs: 42_000, periodicMs: 100_000 },
  normal: { scoreThreshold: REVIEW_SCORE_THRESHOLD, minIntervalMs: MIN_REVIEW_INTERVAL_MS, periodicMs: PERIODIC_REVIEW_MS },
  close: { scoreThreshold: 6, minIntervalMs: 10_000, periodicMs: 32_000 },
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
  return path.resolve(process.cwd(), '.workspaces', 'autonomy', 'user-proxy', `${safe}.json`);
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
    requiredDeliverables: unique([...fileTokens, ...deliverableLines], 20),
    forbiddenActions: unique(forbidden, 16),
    safetyConstraints: unique(safety, 16),
    completionConditions: unique(completion.length > 0 ? completion : deliverableLines, 16),
    referencedPaths: unique([...contextPaths, ...attachmentNames], 20),
  };
}

function extractDecision(raw: string): ProxyDecision {
  const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { action: 'observe', reason: 'No structured intervention decision.' };
  try {
    const parsed = JSON.parse(match[0]);
    const actions = new Set<ProxyAction>(['observe', 'steer', 'redirect', 'challenge', 'request_real_user', 'approve_completion']);
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
      reviewCadence: new Set(['quiet', 'normal', 'close']).has(parsed.reviewCadence) ? parsed.reviewCadence : undefined,
      attentionSignals: Array.isArray(parsed.attentionSignals)
        ? unique(parsed.attentionSignals.map((item: any) => String(item)), 10)
        : [],
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

  constructor(options: RuntimeOptions) {
    this.options = options;
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
      lastInterventionEventId: 0,
      helperUsed: false,
      adaptivePolicy: {
        cadence: (options.context as any)?.autonomy?.intervention === 'minimal'
          ? 'quiet'
          : (options.context as any)?.autonomy?.intervention === 'high' ? 'close' : 'normal',
        attentionSignals: [],
      },
      updatedAt: Date.now(),
    };
    this.state = this.restoreCompatibleState(freshState);
    this.eventCounter = this.state.events.reduce((highest, event) => Math.max(highest, event.id), 0);
  }

  start(): void {
    this.state.status = 'watching';
    this.options.onTrace?.({
      type: 'autonomy_proxy_status',
      phase: 'watching',
      text: 'User Proxy is watching Main',
      _autonomyProxy: true,
      timestamp: Date.now(),
    });
    this.schedulePersist();
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
    this.state.adaptivePolicy.cadence = cadence;
    this.options.onTrace?.({ type: 'autonomy_proxy_status', phase: 'policy_changed', text: `Proxy intervention set to ${level}`, _autonomyProxy: true, timestamp: Date.now() });
    this.schedulePersist();
  }

  observe(trace: any): void {
    if (this.stopped || this.paused || !trace) return;

    if (trace.type === 'steering_applied' && this.pendingGuidance) {
      const lastGuidance = this.state.interventions[this.state.interventions.length - 1]?.message || '';
      if (!lastGuidance || compact(trace.text, 2400).includes(compact(lastGuidance, 1400))) {
        this.pendingGuidance = false;
        this.state.status = 'watching';
      }
    }
    if (trace._autonomyProxy) return;

    const traceType = String(trace.type || '');
    if (
      traceType === 'thought_stream' ||
      (traceType === 'work_note' && (trace.isStreaming === true || trace.isDelta === true)) ||
      (traceType === 'answer' && (trace.isStreaming === true || trace.isDelta === true))
    ) {
      this.mainPhase = 'composing';
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
    this.reviewScore += this.eventScore(event);
    this.schedulePersist();

    if (this.pendingGuidance || Date.now() < this.humanOverrideUntil) return;
    if (Date.now() - this.startedAt < INITIAL_SILENCE_MS && !event.risk) return;

    const eventsAfterIntervention = event.id - this.state.lastInterventionEventId;
    if (eventsAfterIntervention < MIN_EVENTS_AFTER_INTERVENTION && !event.risk) return;

    const cadence = CADENCE_SETTINGS[this.state.adaptivePolicy.cadence];
    const reviewAge = Date.now() - this.state.lastDecisionAt;
    const urgent = event.risk || this.consecutiveFailures >= 2 || event.repeated;
    const materialCheckpoint = this.reviewScore >= cadence.scoreThreshold;
    const periodicCheckpoint = reviewAge >= cadence.periodicMs && this.reviewScore >= Math.max(4, cadence.scoreThreshold / 2);
    if (urgent || materialCheckpoint || periodicCheckpoint) {
      this.scheduleReview(urgent ? this.urgentTrigger(event) : 'material_execution_checkpoint');
    }
  }

  async reviewCompletion(candidate: string): Promise<ProxyDecision> {
    if (this.stopped || this.paused) return { action: 'approve_completion', reason: 'Proxy inactive.' };
    if (this.state.interventions.length >= MAX_INTERVENTIONS) {
      return { action: 'approve_completion', reason: 'Proxy intervention budget exhausted.' };
    }
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
    this.applyDecision(decision, true);
    return decision;
  }

  private restoreCompatibleState(freshState: ProxyState): ProxyState {
    try {
      const saved = fs.readJsonSync(statePathFor(freshState.projectId));
      if (saved?.version !== 2 || saved?.objectiveSignature !== freshState.objectiveSignature) return freshState;
      if (saved?.status === 'complete') return freshState;
      return {
        ...freshState,
        events: Array.isArray(saved.events) ? saved.events.slice(-MAX_EVENTS) : [],
        interventions: Array.isArray(saved.interventions) ? saved.interventions.slice(-MAX_INTERVENTIONS) : [],
        deliverableEvidence: { ...freshState.deliverableEvidence, ...(saved.deliverableEvidence || {}) },
        actionCounts: saved.actionCounts && typeof saved.actionCounts === 'object' ? saved.actionCounts : {},
        lastGoalGap: compact(saved.lastGoalGap || freshState.lastGoalGap, 1600),
        lastDecisionAt: Number(saved.lastDecisionAt || 0),
        lastInterventionEventId: Number(saved.lastInterventionEventId || 0),
        helperUsed: saved.helperUsed === true,
        adaptivePolicy: {
          cadence: ['quiet', 'normal', 'close'].includes(saved?.adaptivePolicy?.cadence)
            ? saved.adaptivePolicy.cadence
            : 'normal',
          attentionSignals: Array.isArray(saved?.adaptivePolicy?.attentionSignals)
            ? unique(saved.adaptivePolicy.attentionSignals, 10)
            : [],
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

  private scheduleReview(trigger: string): void {
    if (this.reviewPromise || this.reviewTimer || this.stopped || this.pendingGuidance) return;
    if (this.state.interventions.length >= MAX_INTERVENTIONS) return;
    const elapsed = Date.now() - this.state.lastDecisionAt;
    const delay = Math.max(0, CADENCE_SETTINGS[this.state.adaptivePolicy.cadence].minIntervalMs - elapsed);
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = null;
      if (this.stopped || this.reviewPromise || this.pendingGuidance || Date.now() < this.humanOverrideUntil) return;
      this.reviewPromise = this.runReview(trigger)
        .then(decision => {
          this.applyAdaptiveUpdates(decision);
          if (this.isGroundedDecision(decision, false)) this.applyDecision(decision, false);
          else this.state.status = 'watching';
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
  }

  private async runReview(trigger: string, completionCandidate = ''): Promise<ProxyDecision> {
    this.reviewScore = 0;
    this.state.lastDecisionAt = Date.now();
    this.state.status = 'reviewing';

    const recent = this.state.events.slice(-24).map(event =>
      `#${event.id} [${event.kind}/${event.type}${event.tool ? `/${event.tool}` : ''}${event.failed ? '/FAILED' : ''}${event.risk ? '/RISK' : ''}${event.repeated ? '/REPEATED' : ''}] ${event.text}`,
    ).join('\n') || '(No material evidence yet.)';
    const prior = this.state.interventions.slice(-5).map(item =>
      `- ${item.action}: ${item.message} (evidence: ${item.evidenceEventIds.join(', ') || 'none'})`,
    ).join('\n') || '(none)';
    const deliverables = Object.entries(this.state.deliverableEvidence).map(([name, evidence]) =>
      `- ${name}: ${evidence.verified ? 'verified evidence observed' : evidence.observed ? 'mentioned but not verified' : 'not observed'}${evidence.evidenceEventIds.length ? ` [events ${evidence.evidenceEventIds.join(', ')}]` : ''}`,
    ).join('\n') || '(No explicit deliverables extracted.)';

    const prompt = [
      'You are the persistent USER PROXY in a two-agent autonomous loop. Main performs the work. You act like a perceptive expert user who protects intent, notices consequential gaps, and otherwise stays silent.',
      'Your observations are incomplete telemetry, not omniscience. Never claim an action failed, a file is missing, or a constraint was violated unless the supplied evidence supports it. Lack of visibility is not proof of failure.',
      'Thought streams, streaming work notes, and partially composed response text are unfinished internal activity. Never ask Main to provide a full answer, full code, or final response based on those fragments. Only completion_candidate contains a finished response that may be judged for completeness.',
      'Use intelligent counterfactual judgment, not fixed patterns: predict what a capable Main will naturally do next. Before speaking, compare the expected benefit of intervention with the cost of interrupting flow. If Main is likely to handle the issue correctly without you, observe—even if you can imagine an improvement.',
      'Questions are expensive. Infer ordinary implementation details, use available evidence, and trust Main on routine choices. Ask for real-user involvement only when the information or authority is genuinely human-exclusive and the outcome materially depends on it.',
      'Intervene only for: a concrete safety/constraint violation; repeated or blocked execution Main is not correcting; a materially wrong strategy; an unresolved decision requiring the real user; or a required completion gap.',
      'Do not intervene for optional polish, style preference, speculative improvement, ordinary planning, one recoverable tool failure, or activity that Main is already correcting. Silence is the normal action.',
      'The task contract began as a conservative machine-extracted seed, not a fixed truth. Semantically refine it only from the current goal and relevant prior-user context. Do not turn optional ideas into required deliverables.',
      'Omit contractUpdate unless the seed is materially wrong. When correcting it, return the complete corrected requiredDeliverables and completionConditions. Explicit forbiddenActions and safetyConstraints may be strengthened but never weakened.',
      'Adapt your future attention: choose quiet cadence for healthy predictable progress, normal for uncertain work, and close only for demonstrated risk/blockage. Return a few task-specific attention signals rather than applying one fixed workflow.',
      this.state.helperUsed
        ? 'The one temporary specialist allowance is already used. Do not call tools.'
        : 'You may call spawn_sub_agent once in specialist mode only when a consequential uncertainty cannot be resolved from the evidence. Use exactly one focused task. Never create a panel, fleet, or general worker.',
      `TASK CONTRACT:\n${JSON.stringify(this.state.contract, null, 2)}`,
      'The priorUserContext field is reference context only. Treat it as part of the task only when the current goal explicitly continues or refers to it.',
      `CURRENT GOAL GAP (may be stale; revise from evidence):\n${this.state.lastGoalGap || '(unknown)'}`,
      `DELIVERABLE EVIDENCE:\n${deliverables}`,
      `REVIEW TRIGGER: ${trigger}`,
      `CURRENT MAIN PHASE: ${this.mainPhase}. When this is composing, all visible answer text is partial and Main may already be producing exactly what is needed.`,
      `RECENT MAIN EVIDENCE:\n${recent}`,
      `PRIOR PROXY GUIDANCE (do not repeat or paraphrase):\n${prior}`,
      completionCandidate ? `MAIN'S PROPOSED FINAL ANSWER:\n${compact(completionCandidate, 5000)}` : '',
      completionCandidate
        ? 'Approve unless a required, consequential gap is supported by specific event evidence or explicitly admitted in the final answer. Optional improvements must never block completion.'
        : 'Choose observe unless intervention is necessary now. If visibility is insufficient, record visibilityGap and observe; do not nag Main for information it is likely still gathering.',
      'Return exactly one JSON object:',
      '{"action":"observe|steer|redirect|challenge|request_real_user|approve_completion","message":"one short natural user-like instruction, blank for observe/approve","reason":"private rationale including the counterfactual necessity test","remainingGoalGap":"concrete remaining gap or blank","confidence":0.0,"severity":"low|medium|high|critical","evidenceEventIds":[1],"visibilityGap":"missing telemetry, if any","optionalImprovement":false,"reviewCadence":"quiet|normal|close","attentionSignals":["task-specific signal"],"contractUpdate":null}',
    ].filter(Boolean).join('\n\n');

    const { createIsolatedClient } = await import('../Agent');
    const client = createIsolatedClient(this.options.apiKey, this.options.mode, this.options.runtimeSettings);
    const proxyContext: any = {
      projectId: `${this.options.context.projectId}::user-proxy`,
      agentRuntime: 'user_proxy',
      isUserProxy: true,
      disableSubAgents: this.state.helperUsed,
      allowAgentSpawning: !this.state.helperUsed,
      _userProxyHelperUsed: this.state.helperUsed,
      disableLongTermMemory: true,
      disableSessionPersistence: true,
      disableTaskStore: true,
      disableSharedCache: true,
      selectedModelMode: this.options.mode,
      selectedModelName: (this.options.context as any).selectedModelName,
      selectedThinkingLevel: 'low',
      runtimeSettings: this.options.runtimeSettings,
    };
    const response = await client.executeMessageLoop(proxyContext, prompt, [], undefined, []);
    this.state.helperUsed = Boolean(proxyContext._userProxyHelperUsed);
    return extractDecision(response.text);
  }

  private isGroundedDecision(decision: ProxyDecision, completionReview: boolean, completionCandidate = ''): boolean {
    if (decision.action === 'observe' || decision.action === 'approve_completion') return false;
    if (decision.optionalImprovement) return false;
    const confidence = decision.confidence ?? 0;
    if (confidence < (completionReview ? 0.74 : 0.7)) return false;
    if (!compact(decision.message, 1600)) return false;
    const knownIds = new Set(this.state.events.map(event => event.id));
    const evidenceIds = decision.evidenceEventIds || [];
    const hasEvidence = evidenceIds.some(id => {
      if (!knownIds.has(id)) return false;
      const event = this.state.events.find(item => item.id === id);
      return Boolean(event && event.kind !== 'intent' && event.kind !== 'other');
    });
    const candidateAdmitsGap = completionReview &&
      /\b(not completed|not created|not finished|not verified|could not|couldn't|unable to|failed to|still missing|remains incomplete)\b/i.test(completionCandidate);
    if (!hasEvidence && !candidateAdmitsGap && decision.action !== 'request_real_user') return false;
    return true;
  }

  private applyAdaptiveUpdates(decision: ProxyDecision): void {
    if (decision.reviewCadence) this.state.adaptivePolicy.cadence = decision.reviewCadence;
    if (decision.attentionSignals?.length) {
      this.state.adaptivePolicy.attentionSignals = unique(decision.attentionSignals, 10);
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

  private applyDecision(decision: ProxyDecision, completionReview: boolean): void {
    this.state.lastGoalGap = decision.remainingGoalGap || this.state.lastGoalGap;
    if (decision.action === 'observe' || decision.action === 'approve_completion' || decision.optionalImprovement) {
      this.state.status = 'watching';
      this.schedulePersist();
      return;
    }
    const message = compact(decision.message, 1600);
    if (!message) return;
    if (this.state.interventions.slice(-4).some(item => messageSimilarity(item.message, message) >= 0.72)) {
      this.state.status = 'watching';
      this.schedulePersist();
      return;
    }

    const evidenceEventIds = decision.evidenceEventIds || [];
    this.state.interventions.push({
      message,
      reason: decision.reason || '',
      action: decision.action,
      evidenceEventIds,
      timestamp: Date.now(),
    });
    this.state.lastInterventionEventId = this.eventCounter;
    this.pendingGuidance = true;
    this.state.status = decision.action === 'request_real_user' ? 'needs_user' : 'waiting_for_main';
    const accepted = this.options.steer(message, {
      _autonomyProxy: true,
      proxyAction: decision.action,
      proxyReason: decision.reason,
      proxySeverity: decision.severity,
      proxyEvidenceEventIds: evidenceEventIds,
      completionReview,
    });
    if (!accepted) {
      this.pendingGuidance = false;
      this.state.status = 'watching';
    }
    this.schedulePersist();
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
