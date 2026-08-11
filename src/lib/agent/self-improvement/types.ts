export type ExperienceInsightKind =
  | 'user_model'
  | 'collaboration'
  | 'decision_policy'
  | 'strategy'
  | 'failure_boundary'
  | 'tool_affordance'
  | 'procedure';

export type ExperienceAuthority =
  | 'explicit_user'
  | 'verified_outcome'
  | 'reflective_inference';

export type ExperienceScopeLevel = 'global' | 'project' | 'workspace' | 'agent' | 'tool';

export type ExperienceInsightStatus = 'candidate' | 'active' | 'superseded' | 'quarantined';

export type ExperienceEpisodeStatus = 'pending' | 'reviewing' | 'complete' | 'deferred';

export type ExperienceScope = {
  level: ExperienceScopeLevel;
  key: string;
};

export type ExperienceTriggers = {
  intents: string[];
  terms: string[];
  tools: string[];
  situations: string[];
  exclusions?: string[];
};

export type ExperienceFacet =
  | 'autonomy'
  | 'ambiguity_handling'
  | 'clarification'
  | 'interruption'
  | 'communication'
  | 'evidence'
  | 'planning'
  | 'strategy'
  | 'verification'
  | 'recovery'
  | 'tool_use'
  | 'risk'
  | 'pace'
  | 'artifact_quality'
  | 'coordination'
  | 'generalization';

export type ExperiencePlaybook = {
  preconditions: string[];
  steps: string[];
  verification: string[];
  recovery: string[];
  stopConditions: string[];
};

export type ExperienceInsight = {
  id: string;
  kind: ExperienceInsightKind;
  title: string;
  directive: string;
  rationale: string;
  scope: ExperienceScope;
  triggers: ExperienceTriggers;
  facets?: ExperienceFacet[];
  playbook?: ExperiencePlaybook;
  authority: ExperienceAuthority;
  status: ExperienceInsightStatus;
  evidenceEpisodeIds: string[];
  evidenceQuotes: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
  supersededBy?: string;
  quarantineReason?: string;
};

export type ExperienceRelation = {
  id: string;
  from: string;
  to: string;
  type:
    | 'supports'
    | 'refines'
    | 'conflicts'
    | 'supersedes'
    | 'observed_in'
    | 'applied_in'
    | 'evaluated_in';
  episodeId: string;
  createdAt: number;
};

export type ObservableExperienceTrace = {
  type: string;
  tool?: string;
  text?: string;
  success?: boolean;
  error?: string;
  paths?: string[];
};

export type ExperienceConversationTurn = {
  role: 'user' | 'agent';
  text: string;
};

export type ExperiencePolicyApplication = {
  id: string;
  userId: string;
  projectId: string;
  workspaceKey: string;
  agentRuntime: string;
  role: 'main' | 'custom';
  taskSignature: string;
  insightIds: string[];
  operatingEnvelope: string;
  graphRevision: number;
  status: 'pending_outcome' | 'evaluated';
  createdAt: number;
  episodeId?: string;
  outcome?: 'success' | 'failure';
};

export type ExperienceSignalKind =
  | 'turning_point'
  | 'strategy_update'
  | 'failure_meaning'
  | 'tool_affordance'
  | 'user_correction'
  | 'collaboration_signal'
  | 'verification_result';

export type ExperienceSignal = {
  id: string;
  userId: string;
  projectId: string;
  chatId: string;
  workspaceKey: string;
  agentRuntime: string;
  kind: ExperienceSignalKind;
  observation: string;
  appliesWhen: string;
  evidence: string;
  tags: string[];
  status: 'pending' | 'consumed' | 'quarantined';
  createdAt: number;
  consumedByEpisodeId?: string;
  quarantineReason?: string;
};

export type ExperienceEpisode = {
  id: string;
  status: ExperienceEpisodeStatus;
  attempts: number;
  userId: string;
  projectId: string;
  chatId: string;
  workspaceKey: string;
  agentRuntime: string;
  task: string;
  recentUserContext: string[];
  recentConversation?: ExperienceConversationTurn[];
  finalAnswer: string;
  success: boolean;
  durationMs: number;
  artifacts: string[];
  trace: ObservableExperienceTrace[];
  experienceSignals?: ExperienceSignal[];
  appliedInsightIds?: string[];
  policyApplicationId?: string;
  model: { provider: string; modelId: string };
  createdAt: number;
  reviewedAt?: number;
  nextAttemptAt?: number;
  reviewSummary?: string;
  lastError?: string;
};

export type ExperienceGraphState = {
  version: 1;
  revision: number;
  episodes: ExperienceEpisode[];
  insights: ExperienceInsight[];
  relations: ExperienceRelation[];
  applications: ExperiencePolicyApplication[];
  signals: ExperienceSignal[];
  updatedAt: number;
};

export type ReflectionInsightDraft = {
  kind?: string;
  title?: string;
  directive?: string;
  rationale?: string;
  scope?: { level?: string; key?: string };
  triggers?: {
    intents?: unknown[];
    terms?: unknown[];
    tools?: unknown[];
    situations?: unknown[];
    exclusions?: unknown[];
  };
  facets?: unknown[];
  playbook?: {
    preconditions?: unknown[];
    steps?: unknown[];
    verification?: unknown[];
    recovery?: unknown[];
    stopConditions?: unknown[];
  };
  authority?: string;
  evidenceQuote?: string;
  operation?: string;
  targetInsightId?: string;
  conflictsWith?: unknown[];
  supportingSignalIds?: unknown[];
};

export type ExperienceReflection = {
  summary: string;
  insights: ReflectionInsightDraft[];
};

export type ExperienceSelectionInput = {
  userId?: string;
  projectId?: string;
  workspaceKey?: string;
  agentRuntime?: string;
  role?: 'main' | 'custom' | 'proxy' | 'proxy_manager';
  request: string;
  limit?: number;
  includeCandidates?: boolean;
};
