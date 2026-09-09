import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { getEterxWorkspaceDir } from '../storage-paths';
import type {
  ExperienceAuthority,
  ExperienceEpisode,
  ExperienceFacet,
  ExperienceGraphState,
  ExperienceInsight,
  ExperienceInsightKind,
  ExperiencePlaybook,
  ExperiencePolicyApplication,
  ExperienceRelation,
  ExperienceReflection,
  ExperienceSignal,
  ExperienceSignalKind,
  ExperienceScope,
  ExperienceScopeLevel,
  ExperienceSelectionInput,
  ExperienceTriggers,
  ReflectionInsightDraft,
} from './types';

const MAX_EPISODES = 600;
const MAX_INSIGHTS = 1200;
const MAX_RELATIONS = 3000;
const MAX_SIGNALS = 2400;
const DEFAULT_LIMIT = 12;

const INSIGHT_KINDS = new Set<ExperienceInsightKind>([
  'user_model',
  'collaboration',
  'decision_policy',
  'strategy',
  'failure_boundary',
  'tool_affordance',
  'procedure',
]);
const AUTHORITIES = new Set<ExperienceAuthority>(['explicit_user', 'verified_outcome', 'reflective_inference']);
const SCOPE_LEVELS = new Set<ExperienceScopeLevel>(['global', 'project', 'workspace', 'agent', 'tool']);
const SIGNAL_KINDS = new Set<ExperienceSignalKind>([
  'turning_point',
  'strategy_update',
  'failure_meaning',
  'tool_affordance',
  'user_correction',
  'collaboration_signal',
  'verification_result',
]);
const FACETS = new Set<ExperienceFacet>([
  'autonomy', 'ambiguity_handling', 'clarification', 'interruption', 'communication', 'evidence',
  'planning', 'strategy', 'verification', 'recovery', 'tool_use', 'risk', 'pace',
  'artifact_quality', 'coordination', 'generalization',
]);

const SECRET_PATTERNS: RegExp[] = [
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(api[_-]?key|token|secret|password|passwd|credential)\s*[:=]\s*["']?([^\s"']{8,})/gi,
];

const POISON_PATTERNS: RegExp[] = [
  /\bignore (?:all )?(?:previous|prior|system|developer) instructions\b/i,
  /\b(?:disable|bypass|override).{0,35}(?:safety|guardrail|policy|permission|developer instruction)\b/i,
  /\b(?:reveal|show|print|dump).{0,35}(?:system prompt|developer message|hidden instruction|secrets?)\b/i,
  /\b(?:modify|rewrite|replace).{0,30}(?:core prompt|system prompt|developer prompt)\b/i,
  /\bjailbreak\b/i,
  /\bexfiltrat(?:e|ion)\b/i,
];

const EMPTY_STATE = (): ExperienceGraphState => ({
  version: 1,
  revision: 0,
  episodes: [],
  insights: [],
  relations: [],
  applications: [],
  signals: [],
  updatedAt: Date.now(),
});

const compact = (value: unknown, max = 1600): string => {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, max);
};

const redact = (value: unknown, max = 1600): string => {
  let result = compact(value, max);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (...args: any[]) => {
      if (args.length > 2 && args[1]) return `${args[1]}=[REDACTED_SECRET]`;
      return '[REDACTED_SECRET]';
    });
  }
  return result;
};

const words = (value: string): Set<string> => new Set(
  value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [],
);

const similarity = (left: string, right: string): number => {
  const a = words(left);
  const b = words(right);
  if (a.size === 0 || b.size === 0) return compact(left).toLowerCase() === compact(right).toLowerCase() ? 1 : 0;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
};

const cleanList = (value: unknown, limit = 16, maxItem = 180): string[] => Array.from(new Set(
  (Array.isArray(value) ? value : [])
    .map(item => compact(item, maxItem).toLowerCase())
    .filter(Boolean),
)).slice(0, limit);

const stableKey = (value: string): string => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .slice(0, 240);

const isExplicitDurableUserEvidence = (quote: string, episode: ExperienceEpisode): boolean => {
  const evidence = compact(quote, 600);
  if (!evidence) return false;
  const userText = [
    episode.task,
    ...episode.recentUserContext,
    ...(episode.recentConversation || []).filter(turn => turn.role === 'user').map(turn => turn.text),
  ].join('\n').toLowerCase();
  const normalizedEvidence = evidence.toLowerCase();
  const evidencePresent = userText.includes(normalizedEvidence)
    || similarity(normalizedEvidence, userText) >= 0.28;
  if (!evidencePresent) return false;
  return /\b(?:remember|always|never|from now on|in future|in the future|i prefer|i want you to|work with me|do not|don't|dont|must|make sure|my style|my way)\b/i.test(evidence);
};

const isExplicitGlobalUserEvidence = (quote: string): boolean => /\b(?:always|never|from now on|in future|in the future|i prefer|my style|my way|how i work|working style|across tasks|all tasks|not only (?:this|one) task|generally|in general)\b/i.test(compact(quote, 600));

const normalizeScope = (draft: ReflectionInsightDraft, episode: ExperienceEpisode, authority: ExperienceAuthority, evidenceQuote: string): ExperienceScope => {
  const requestedLevel = compact(draft.scope?.level, 40) as ExperienceScopeLevel;
  let level: ExperienceScopeLevel = SCOPE_LEVELS.has(requestedLevel) ? requestedLevel : 'project';
  if (level === 'global' && (authority !== 'explicit_user' || !isExplicitGlobalUserEvidence(evidenceQuote))) level = 'project';

  if (level === 'global') return { level, key: episode.userId || 'user' };
  // The reviewer may choose a scope level, but it may never invent or widen the
  // identity key. Keys are bound to the observed episode to prevent leakage.
  if (level === 'project') return { level, key: episode.projectId };
  if (level === 'workspace') return { level, key: episode.workspaceKey || episode.projectId };
  if (level === 'agent') return { level, key: episode.agentRuntime || 'main' };
  const firstTool = cleanList(draft.triggers?.tools, 1)[0] || '';
  return { level: 'tool', key: firstTool || 'unknown-tool' };
};

const normalizeTriggers = (draft: ReflectionInsightDraft): ExperienceTriggers => ({
  intents: cleanList(draft.triggers?.intents, 10),
  terms: cleanList(draft.triggers?.terms, 18),
  tools: cleanList(draft.triggers?.tools, 12),
  situations: cleanList(draft.triggers?.situations, 10, 260),
  exclusions: cleanList(draft.triggers?.exclusions, 10, 260),
});

const normalizeFacets = (draft: ReflectionInsightDraft): ExperienceFacet[] => cleanList(draft.facets, 8, 80)
  .filter((facet): facet is ExperienceFacet => FACETS.has(facet as ExperienceFacet));

const normalizePlaybook = (draft: ReflectionInsightDraft): ExperiencePlaybook | undefined => {
  if (!draft.playbook || typeof draft.playbook !== 'object') return undefined;
  const playbook: ExperiencePlaybook = {
    preconditions: cleanList(draft.playbook.preconditions, 8, 360),
    steps: cleanList(draft.playbook.steps, 10, 500),
    verification: cleanList(draft.playbook.verification, 8, 420),
    recovery: cleanList(draft.playbook.recovery, 8, 500),
    stopConditions: cleanList(draft.playbook.stopConditions, 8, 420),
  };
  return Object.values(playbook).some(items => items.length > 0) ? playbook : undefined;
};

async function readStateWithBackup(target: string): Promise<ExperienceGraphState> {
  for (const source of [target, `${target}.backup`]) {
    try {
      if (!(await fs.pathExists(source))) continue;
      const value = await fs.readJson(source);
      if (value?.version !== 1) continue;
      const state: ExperienceGraphState = {
        version: 1,
        revision: Number(value.revision || 0),
        episodes: Array.isArray(value.episodes) ? value.episodes : [],
        insights: Array.isArray(value.insights) ? value.insights : [],
        relations: Array.isArray(value.relations) ? value.relations : [],
        applications: Array.isArray(value.applications) ? value.applications : [],
        signals: Array.isArray(value.signals) ? value.signals : [],
        updatedAt: Number(value.updatedAt || Date.now()),
      };
      for (const episode of state.episodes) {
        if (episode.status === 'reviewing') {
          episode.status = 'deferred';
          episode.nextAttemptAt = Date.now();
          episode.lastError = 'Review was interrupted by a previous runtime shutdown and was safely re-queued.';
        }
      }
      return state;
    } catch {
      if (source === target) await fs.move(target, `${target}.corrupt-${Date.now()}`).catch(() => undefined);
    }
  }
  return EMPTY_STATE();
}

async function writeStateAtomic(target: string, state: ExperienceGraphState): Promise<void> {
  await fs.ensureDir(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeJson(temporary, state, { spaces: 2 });
  if (await fs.pathExists(target)) await fs.copyFile(target, `${target}.backup`).catch(() => undefined);
  await fs.move(temporary, target, { overwrite: true });
}

export class AdaptiveExperienceStore {
  private readonly stateFile: string;
  private state: ExperienceGraphState = EMPTY_STATE();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(baseDir = getEterxWorkspaceDir('.self_improvement')) {
    this.stateFile = path.join(baseDir, 'experience-graph.v1.json');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = readStateWithBackup(this.stateFile)
      .then(state => {
        this.state = state;
        this.initialized = true;
      })
      .finally(() => { this.initPromise = null; });
    return this.initPromise;
  }

  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.initialize();
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    const run = async () => {
      try {
        const value = await operation();
        this.state.revision += 1;
        this.state.updatedAt = Date.now();
        await writeStateAtomic(this.stateFile, this.state);
        resolve(value);
      } catch (error) {
        reject(error);
      }
    };
    this.mutationChain = this.mutationChain.then(run, run);
    await result;
    return result;
  }

  async appendEpisode(input: Omit<ExperienceEpisode, 'id' | 'status' | 'attempts' | 'createdAt'>): Promise<ExperienceEpisode> {
    return this.mutate(() => {
      const episode: ExperienceEpisode = {
        ...input,
        id: `exp_${crypto.randomUUID()}`,
        status: 'pending',
        attempts: 0,
        createdAt: Date.now(),
      };
      this.state.episodes.push(episode);
      this.state.episodes = this.state.episodes.slice(-MAX_EPISODES);
      const matchingSignals = this.state.signals.filter(signal =>
        signal.status === 'pending'
        && signal.userId === episode.userId
        && signal.projectId === episode.projectId
        && signal.chatId === episode.chatId,
      );
      if (matchingSignals.length > 0) {
        const attachedSignals = matchingSignals.slice(-24);
        episode.experienceSignals = attachedSignals.map(signal => ({ ...signal }));
        for (const signal of attachedSignals) {
          signal.status = 'consumed';
          signal.consumedByEpisodeId = episode.id;
          this.addRelation(signal.id, episode.id, 'observed_in', episode.id);
        }
      }
      const taskSignature = stableKey(episode.task);
      const application = [...this.state.applications].reverse().find(item =>
        item.status === 'pending_outcome'
        && item.projectId === episode.projectId
        && item.taskSignature === taskSignature
        && (item.role === 'main' || item.role === 'custom'),
      );
      if (application) {
        application.status = 'evaluated';
        application.episodeId = episode.id;
        application.outcome = episode.success ? 'success' : 'failure';
        episode.appliedInsightIds = [...application.insightIds];
        episode.policyApplicationId = application.id;
        this.addRelation(application.id, episode.id, 'evaluated_in', episode.id);
        for (const insightId of application.insightIds) {
          this.addRelation(insightId, application.id, 'applied_in', episode.id);
        }
      }
      this.state.relations = this.state.relations.slice(-MAX_RELATIONS);
      return episode;
    });
  }

  async claimPendingEpisode(now = Date.now()): Promise<ExperienceEpisode | null> {
    await this.initialize();
    if (!this.state.episodes.some(item =>
      (item.status === 'pending' || item.status === 'deferred')
      && (!item.nextAttemptAt || item.nextAttemptAt <= now),
    )) return null;
    return this.mutate(() => {
      const episode = this.state.episodes.find(item =>
        (item.status === 'pending' || item.status === 'deferred')
        && (!item.nextAttemptAt || item.nextAttemptAt <= now),
      );
      if (!episode) return null;
      episode.status = 'reviewing';
      episode.attempts += 1;
      return { ...episode };
    });
  }

  async releaseEpisode(id: string): Promise<void> {
    await this.mutate(() => {
      const episode = this.state.episodes.find(item => item.id === id);
      if (!episode || episode.status !== 'reviewing') return;
      episode.status = 'pending';
      episode.nextAttemptAt = undefined;
      episode.lastError = undefined;
    });
  }

  async recordApplication(input: Omit<ExperiencePolicyApplication, 'id' | 'status' | 'createdAt' | 'graphRevision'>): Promise<ExperiencePolicyApplication> {
    return this.mutate(() => {
      const taskSignature = stableKey(input.taskSignature);
      const duplicate = [...this.state.applications].reverse().find(item =>
        item.status === 'pending_outcome'
        && item.projectId === input.projectId
        && item.role === input.role
        && item.agentRuntime === input.agentRuntime
        && item.taskSignature === taskSignature
        && item.insightIds.join('|') === input.insightIds.join('|'),
      );
      if (duplicate) return duplicate;
      const application: ExperiencePolicyApplication = {
        ...input,
        id: `app_${crypto.randomUUID()}`,
        taskSignature,
        graphRevision: this.state.revision,
        status: 'pending_outcome',
        createdAt: Date.now(),
      };
      this.state.applications.push(application);
      this.state.applications = this.state.applications.slice(-1500);
      return application;
    });
  }

  async recordSignal(input: Omit<ExperienceSignal, 'id' | 'status' | 'createdAt' | 'consumedByEpisodeId' | 'quarantineReason'>): Promise<ExperienceSignal | null> {
    return this.mutate(() => {
      const pendingForRun = this.state.signals.filter(signal =>
        signal.status === 'pending'
        && signal.userId === input.userId
        && signal.projectId === input.projectId
        && signal.chatId === input.chatId,
      );
      if (pendingForRun.length >= 3) return null;
      const kind = SIGNAL_KINDS.has(input.kind) ? input.kind : 'turning_point';
      const observation = redact(input.observation, 1200);
      const appliesWhen = redact(input.appliesWhen, 700);
      const evidence = redact(input.evidence, 900);
      const tags = cleanList(input.tags, 12, 100);
      const poisoned = POISON_PATTERNS.some(pattern => pattern.test(`${observation}\n${appliesWhen}\n${evidence}`));
      const duplicate = [...this.state.signals].reverse().find(signal =>
        signal.status === 'pending'
        && signal.chatId === input.chatId
        && signal.kind === kind
        && similarity(signal.observation, observation) >= 0.82,
      );
      if (duplicate) return duplicate;
      const signal: ExperienceSignal = {
        id: `sig_${crypto.randomUUID()}`,
        userId: compact(input.userId, 120),
        projectId: compact(input.projectId, 300),
        chatId: compact(input.chatId, 300),
        workspaceKey: compact(input.workspaceKey, 600),
        agentRuntime: compact(input.agentRuntime, 160),
        kind,
        observation,
        appliesWhen,
        evidence,
        tags,
        status: poisoned ? 'quarantined' : 'pending',
        createdAt: Date.now(),
        quarantineReason: poisoned
          ? 'The internal signal attempted to alter protected instructions, permissions, secrets, or safety boundaries.'
          : undefined,
      };
      this.state.signals.push(signal);
      this.state.signals = this.state.signals.slice(-MAX_SIGNALS);
      return signal;
    });
  }

  async deferEpisode(id: string, error: string): Promise<void> {
    await this.mutate(() => {
      const episode = this.state.episodes.find(item => item.id === id);
      if (!episode) return;
      episode.status = 'deferred';
      episode.lastError = redact(error, 500);
      const retryMinutes = Math.min(60, Math.max(2, 2 ** Math.min(episode.attempts, 5)));
      episode.nextAttemptAt = Date.now() + retryMinutes * 60_000;
    });
  }

  async completeEpisode(id: string, reflection: ExperienceReflection): Promise<ExperienceInsight[]> {
    return this.mutate(() => {
      const episode = this.state.episodes.find(item => item.id === id);
      if (!episode) return [];
      const applied: ExperienceInsight[] = [];
      for (const draft of reflection.insights.slice(0, 14)) {
        const insight = this.applyDraft(episode, draft);
        if (insight) {
          applied.push(insight);
          const episodeSignalIds = new Set((episode.experienceSignals || []).map(signal => signal.id));
          for (const signalId of cleanList(draft.supportingSignalIds, 12, 180)) {
            if (episodeSignalIds.has(signalId)) this.addRelation(signalId, insight.id, 'supports', episode.id);
          }
        }
      }
      episode.status = 'complete';
      episode.reviewedAt = Date.now();
      episode.reviewSummary = redact(reflection.summary, 1200);
      episode.lastError = undefined;
      episode.nextAttemptAt = undefined;
      this.state.insights = this.state.insights.slice(-MAX_INSIGHTS);
      this.state.relations = this.state.relations.slice(-MAX_RELATIONS);
      return applied;
    });
  }

  private applyDraft(episode: ExperienceEpisode, draft: ReflectionInsightDraft): ExperienceInsight | null {
    const requestedKind = compact(draft.kind, 50) as ExperienceInsightKind;
    if (!INSIGHT_KINDS.has(requestedKind)) return null;
    const title = redact(draft.title, 180);
    const directive = redact(draft.directive, 1400);
    const rationale = redact(draft.rationale, 900);
    const evidenceQuote = redact(draft.evidenceQuote, 600);
    if (!title || !directive) return null;

    const requestedAuthority = compact(draft.authority, 50) as ExperienceAuthority;
    let authority: ExperienceAuthority = AUTHORITIES.has(requestedAuthority)
      ? requestedAuthority
      : 'reflective_inference';
    if (authority === 'explicit_user' && !isExplicitDurableUserEvidence(evidenceQuote, episode)) {
      authority = episode.success ? 'verified_outcome' : 'reflective_inference';
    }
    if (authority === 'verified_outcome' && !episode.success && requestedKind !== 'failure_boundary') {
      authority = 'reflective_inference';
    }

    const scope = normalizeScope(draft, episode, authority, evidenceQuote);
    const triggers = normalizeTriggers(draft);
    const facets = normalizeFacets(draft);
    const playbook = normalizePlaybook(draft);
    const poisoned = POISON_PATTERNS.some(pattern => pattern.test(`${title}\n${directive}\n${rationale}`));
    // General policies need corroboration before activation. A single run may
    // immediately establish only an explicit user rule or a concrete boundary/
    // affordance; repeated episodes promote matching strategy candidates.
    const canActivate = authority === 'explicit_user'
      || (authority === 'verified_outcome'
        && scope.level !== 'global'
        && (requestedKind === 'failure_boundary' || requestedKind === 'tool_affordance'));
    const now = Date.now();
    const targetId = compact(draft.targetInsightId, 180);
    const operation = compact(draft.operation, 40);
    const targetCandidate = targetId ? this.state.insights.find(item => item.id === targetId) : undefined;
    const target = targetCandidate
      && targetCandidate.kind === requestedKind
      && targetCandidate.scope.level === scope.level
      && stableKey(targetCandidate.scope.key) === stableKey(scope.key)
      ? targetCandidate
      : undefined;
    const identity = `${requestedKind}|${scope.level}|${stableKey(scope.key)}|${stableKey(title)}`;
    const nearDuplicate = target || this.state.insights.find(item =>
      item.status !== 'superseded'
      && `${item.kind}|${item.scope.level}|${stableKey(item.scope.key)}|${stableKey(item.title)}` === identity
      && similarity(item.directive, directive) >= 0.72,
    );

    if (nearDuplicate && operation !== 'supersede' && operation !== 'revise') {
      nearDuplicate.evidenceEpisodeIds = Array.from(new Set([...nearDuplicate.evidenceEpisodeIds, episode.id])).slice(-32);
      if (evidenceQuote) nearDuplicate.evidenceQuotes = Array.from(new Set([...nearDuplicate.evidenceQuotes, evidenceQuote])).slice(-12);
      nearDuplicate.updatedAt = now;
      nearDuplicate.revision += 1;
      const authorityRank: Record<ExperienceAuthority, number> = {
        reflective_inference: 0,
        verified_outcome: 1,
        explicit_user: 2,
      };
      if (authorityRank[authority] > authorityRank[nearDuplicate.authority]) nearDuplicate.authority = authority;
      if (nearDuplicate.status === 'candidate' && !poisoned && (
        canActivate
        || (authority === 'verified_outcome' && nearDuplicate.evidenceEpisodeIds.length >= 2)
      )) nearDuplicate.status = 'active';
      this.addRelation(nearDuplicate.id, nearDuplicate.id, 'supports', episode.id);
      return nearDuplicate;
    }

    const insight: ExperienceInsight = {
      id: `ins_${crypto.randomUUID()}`,
      kind: requestedKind,
      title,
      directive,
      rationale,
      scope,
      triggers,
      facets,
      playbook,
      authority,
      status: poisoned ? 'quarantined' : canActivate ? 'active' : 'candidate',
      evidenceEpisodeIds: [episode.id],
      evidenceQuotes: evidenceQuote ? [evidenceQuote] : [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
      quarantineReason: poisoned ? 'The proposed lesson attempted to alter protected instructions, permissions, secrets, or safety boundaries.' : undefined,
    };
    this.state.insights.push(insight);

    if (target && operation === 'revise') {
      if (canActivate && !poisoned) {
        target.status = 'superseded';
        target.supersededBy = insight.id;
        target.updatedAt = now;
        this.addRelation(insight.id, target.id, 'refines', episode.id);
      } else {
        insight.status = 'candidate';
        this.addRelation(insight.id, target.id, 'refines', episode.id);
      }
    }

    const sameContext = this.state.insights.filter(item =>
      item.id !== insight.id
      && item.status === 'active'
      && item.kind === insight.kind
      && item.scope.level === insight.scope.level
      && stableKey(item.scope.key) === stableKey(insight.scope.key)
      && similarity(item.title, insight.title) >= 0.5
      && similarity(item.directive, insight.directive) < 0.45,
    );
    for (const existing of sameContext) {
      if (authority === 'explicit_user') {
        existing.status = 'superseded';
        existing.supersededBy = insight.id;
        existing.updatedAt = now;
        this.addRelation(insight.id, existing.id, 'supersedes', episode.id);
      } else {
        this.addRelation(insight.id, existing.id, 'conflicts', episode.id);
        insight.status = 'candidate';
      }
    }

    for (const relationTarget of cleanList(draft.conflictsWith, 12, 180)) {
      const existing = this.state.insights.find(item => item.id === relationTarget);
      if (existing) this.addRelation(insight.id, existing.id, 'conflicts', episode.id);
    }
    return insight;
  }

  private addRelation(from: string, to: string, type: ExperienceRelation['type'], episodeId: string): void {
    const duplicate = this.state.relations.some(item => item.from === from && item.to === to && item.type === type && item.episodeId === episodeId);
    if (duplicate) return;
    this.state.relations.push({
      id: `rel_${crypto.randomUUID()}`,
      from,
      to,
      type,
      episodeId,
      createdAt: Date.now(),
    });
  }

  async select(input: ExperienceSelectionInput): Promise<ExperienceInsight[]> {
    await this.initialize();
    // Relevance must come from the live request. Scope identity decides where
    // a lesson is eligible; it must not manufacture a semantic match merely
    // because project paths or the word "main" appear in both records.
    const requestWords = words(input.request);
    const scopeMatches = (insight: ExperienceInsight): boolean => {
      if (insight.scope.level === 'global') {
        return Boolean(input.userId && stableKey(input.userId) === stableKey(insight.scope.key));
      }
      if (insight.scope.level === 'project') return Boolean(input.projectId && stableKey(input.projectId) === stableKey(insight.scope.key));
      if (insight.scope.level === 'workspace') return Boolean(input.workspaceKey && stableKey(input.workspaceKey) === stableKey(insight.scope.key));
      if (insight.scope.level === 'agent') return Boolean(input.agentRuntime && stableKey(input.agentRuntime) === stableKey(insight.scope.key));
      return insight.triggers.tools.some(tool => requestWords.has(tool)) || requestWords.has(stableKey(insight.scope.key));
    };
    const roleKinds: Record<NonNullable<ExperienceSelectionInput['role']>, Set<ExperienceInsightKind>> = {
      main: new Set(INSIGHT_KINDS),
      custom: new Set(INSIGHT_KINDS),
      proxy: new Set(['user_model', 'collaboration', 'decision_policy', 'failure_boundary', 'strategy']),
      proxy_manager: new Set(['user_model', 'collaboration', 'decision_policy', 'failure_boundary']),
    };
    const allowedKinds = roleKinds[input.role || 'main'];
    const relationConflicts = new Set<string>();
    for (const relation of this.state.relations) {
      if (relation.type === 'conflicts') relationConflicts.add(`${relation.from}|${relation.to}`);
    }

    const ranked = this.state.insights
      .filter(item => (
        item.status === 'active'
        || (input.includeCandidates === true && item.status === 'candidate')
      ) && allowedKinds.has(item.kind) && scopeMatches(item))
      .filter(item => !(item.triggers.exclusions || []).some(exclusion => {
        const normalizedExclusion = stableKey(exclusion);
        return normalizedExclusion.length >= 4 && stableKey(input.request).includes(normalizedExclusion);
      }))
      .map(item => {
        const triggerWords = words([
          item.title,
          item.directive,
          ...item.triggers.intents,
          ...item.triggers.terms,
          ...item.triggers.tools,
          ...item.triggers.situations,
        ].join(' '));
        let overlap = 0;
        for (const word of triggerWords) if (requestWords.has(word)) overlap += 1;
        const universallyApplicable = item.scope.level === 'global'
          && item.authority === 'explicit_user';
        const scopeWeight = item.scope.level === 'workspace' ? 7
          : item.scope.level === 'project' ? 6
            : item.scope.level === 'agent' ? 5
              : item.scope.level === 'tool' ? 5 : 3;
        const authorityWeight = item.authority === 'explicit_user' ? 6 : item.authority === 'verified_outcome' ? 3 : 0;
        return {
          item,
          overlap,
          universallyApplicable,
          score: scopeWeight + authorityWeight + overlap * 2 + (universallyApplicable ? 8 : 0),
        };
      })
      .filter(entry => entry.score > 3 && (entry.universallyApplicable || entry.overlap > 0))
      .sort((a, b) => b.score - a.score || b.item.revision - a.item.revision || a.item.id.localeCompare(b.item.id));

    const selected: ExperienceInsight[] = [];
    const perKind = new Map<ExperienceInsightKind, number>();
    for (const entry of ranked) {
      if (selected.length >= (input.limit || DEFAULT_LIMIT)) break;
      const count = perKind.get(entry.item.kind) || 0;
      if (count >= 3) continue;
      const conflicts = selected.some(existing =>
        relationConflicts.has(`${entry.item.id}|${existing.id}`)
        || relationConflicts.has(`${existing.id}|${entry.item.id}`),
      );
      if (conflicts) continue;
      selected.push(entry.item);
      perKind.set(entry.item.kind, count + 1);
    }
    return selected;
  }

  async getRelevantForReview(episode: ExperienceEpisode, limit = 18): Promise<ExperienceInsight[]> {
    return this.select({
      userId: episode.userId,
      projectId: episode.projectId,
      workspaceKey: episode.workspaceKey,
      agentRuntime: episode.agentRuntime,
      role: 'main',
      request: episode.task,
      limit,
      includeCandidates: true,
    });
  }

  async getStats(): Promise<Record<string, unknown>> {
    await this.initialize();
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const insight of this.state.insights) {
      byKind[insight.kind] = (byKind[insight.kind] || 0) + 1;
      byStatus[insight.status] = (byStatus[insight.status] || 0) + 1;
    }
    return {
      revision: this.state.revision,
      episodes: this.state.episodes.length,
      pendingReviews: this.state.episodes.filter(item => item.status === 'pending' || item.status === 'deferred').length,
      insights: this.state.insights.length,
      activeInsights: this.state.insights.filter(item => item.status === 'active').length,
      candidates: this.state.insights.filter(item => item.status === 'candidate').length,
      quarantined: this.state.insights.filter(item => item.status === 'quarantined').length,
      relations: this.state.relations.length,
      applications: this.state.applications.length,
      pendingOutcomes: this.state.applications.filter(item => item.status === 'pending_outcome').length,
      byKind,
      byStatus,
      updatedAt: this.state.updatedAt,
    };
  }
}

export const adaptiveExperienceStore = new AdaptiveExperienceStore();
