export type SpecialistRole =
  | 'security_auditor'
  | 'performance_analyst'
  | 'architect'
  | 'qa_tester'
  | 'researcher';

export type SubAgentStrategyMode =
  | 'solo'
  | 'parallel'
  | 'consensus'
  | 'debate'
  | 'specialist'
  | 'hybrid';

export type SubAgentStrategyComplexity = 'simple' | 'standard' | 'complex' | 'critical';

export interface SubAgentStrategyRecommendation {
  role: SpecialistRole | 'parallel_worker' | 'optimist' | 'skeptic' | 'realist' | 'main_agent';
  name?: string;
  task: string;
  reason: string;
}

export interface SubAgentStrategy {
  mode: SubAgentStrategyMode;
  complexity: SubAgentStrategyComplexity;
  shouldSpawn: boolean;
  requiresTaskDesign?: boolean;
  confidence: number;
  estimatedAgentCount: number;
  rationale: string[];
  guardrails: string[];
  recommendedAgents: SubAgentStrategyRecommendation[];
  recommendedToolCall:
    | {
        mode: 'spawn';
        tasks: Array<{ task: string; name?: string }>;
      }
    | {
        mode: 'consensus' | 'debate';
        tasks: Array<{ task: string }>;
      }
    | {
        mode: 'specialist';
        specialistRole: SpecialistRole;
        tasks: Array<{ task: string }>;
      }
    | null;
}

const SPECIALIST_PROFILES: Record<SpecialistRole, { triggers: RegExp[]; task: string }> = {
  security_auditor: {
    triggers: [
      /\bsecurity|secure|auth|oauth|token|secret|xss|csrf|injection|vulnerabil|permission|privacy\b/i,
      /\bproduction|compliance|audit\b/i,
    ],
    task: 'Audit the security, authorization, data handling, and unsafe execution paths. Return severity-rated findings with exact files and fixes.',
  },
  performance_analyst: {
    triggers: [
      /\bperformance|slow|latency|memory|leak|optimi[sz]e|bottleneck|profil|cache|bundle\b/i,
      /\btimeout|rate limit|throughput|concurrency\b/i,
    ],
    task: 'Find performance bottlenecks, concurrency risks, memory pressure, and practical optimization changes. Include verification steps.',
  },
  architect: {
    triggers: [
      /\barchitecture|architect|design|system|orchestrat|coordination|refactor|scalab|module|boundary\b/i,
      /\bagent|subagent|main agent|workflow|pipeline\b/i,
    ],
    task: 'Review architecture, agent routing, module boundaries, state flow, and long-term maintainability. Recommend concrete implementation changes.',
  },
  qa_tester: {
    triggers: [
      /\bbug|fix|test|qa|regression|edge case|verify|coverage|broken|error\b/i,
      /\bfail|race|flaky|reproduce\b/i,
    ],
    task: 'Find likely bugs and missing verification coverage. Propose or add focused tests and reproduction steps.',
  },
  researcher: {
    triggers: [
      /\bresearch|source|cite|market|trend|compare|benchmark|latest|evidence|paper|report\b/i,
      /\bcompetitor|industry|forecast|deep dive\b/i,
    ],
    task: 'Research independently with source checking, date awareness, confidence levels, and a concise synthesis of conflicts.',
  },
};

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function detectSpecialists(request: string): SpecialistRole[] {
  const roles = Object.entries(SPECIALIST_PROFILES)
    .filter(([, profile]) => hasAny(request, profile.triggers))
    .map(([role]) => role as SpecialistRole);
  return uniq(roles);
}

/** True only when the user actually asks for delegated agent work. */
export function hasExplicitSubAgentRequest(request: string): boolean {
  const text = String(request || '');
  return /\b(?:use|spawn|launch|delegate|assign|ask|have|run)\b.{0,40}\b(?:sub[- ]?agents?|specialists?|worker agents?|agents?)\b/i.test(text)
    || /\b(?:sub[- ]?agents?|specialists?)\b.{0,30}\b(?:handle|work on|review|audit|research|implement|fix|investigate)\b/i.test(text)
    || /\b(?:multi[- ]?agent|agent swarm|parallel agents?|multiple agents?|several agents?)\b/i.test(text);
}

function detectComplexity(request: string): SubAgentStrategyComplexity {
  const words = wordCount(request);
  const highStakes = /\b(production|deploy|release|security|compliance|legal|financial|payments?|auth|privacy|data loss|migration)\b/i.test(request);
  const broadScope = /\b(entire|complete|full|comprehensive|all files|whole repo|system|architecture|multi[- ]?step|end to end)\b/i.test(request);
  const deepWork = /\b(advanced|deep|complex|sci fi|autonomous|orchestrat|subagent|specialist|parallel|debate|consensus)\b/i.test(request);

  if (highStakes) return 'critical';
  if (words > 80 || broadScope || deepWork) return 'complex';
  if (words > 22 || /\bbuild|fix|analy[sz]e|review|research|compare|design|implement\b/i.test(request)) return 'standard';
  return 'simple';
}

export function buildSubAgentStrategy(request: string, options?: { maxAgents?: number; forceHighRigor?: boolean }): SubAgentStrategy {
  const normalizedRequest = String(request || '').trim();
  const requestedMaxAgents = Number(options?.maxAgents);
  const maxAgents = Number.isFinite(requestedMaxAgents)
    ? Math.max(1, Math.floor(requestedMaxAgents))
    : 4;
  const complexity = detectComplexity(normalizedRequest);
  const specialists = detectSpecialists(normalizedRequest);
  const highStakes = complexity === 'critical';
  const decisionHeavy = /\b(decide|choice|tradeoff|strategy|risk|compare|versus|vs|should we|recommend)\b/i.test(normalizedRequest);
  const explicitPanel = /\b(consensus|debate|panel|adversarial (?:review|analysis)|multiple perspectives)\b/i.test(normalizedRequest);
  const explicitParallel = /\b(parallel(?:ize|ise)?|concurrent(?:ly)?|simultaneous(?:ly)?|multi[- ]?agent|swarm|multiple agents?|several agents?|split (?:this|the work|the task) (?:across|between|among))\b/i.test(normalizedRequest);
  const explicitDelegation = hasExplicitSubAgentRequest(normalizedRequest);
  const explicitSingleWorker = explicitDelegation
    && !explicitParallel
    && /\b(?:one|single|a|an)\s+(?:focused\s+|deep(?:-work)?\s+)?(?:sub[- ]?agent|specialist|worker agent)\b/i.test(normalizedRequest);
  const independentWork = explicitParallel
    || /\b(?:frontend|client)\b.{0,50}\b(?:backend|server)\b|\bsecurity\b.{0,50}\bperformance\b|\bresearch\b.{0,50}\bimplementation\b/i.test(normalizedRequest);

  const rationale: string[] = [];
  const guardrails = [
    'Do not spawn agents for tiny sequential tasks or tasks requiring one shared mutable edit at a time.',
    'Define each outcome, dependency and resource owner explicitly. Children may delegate narrower outcomes and must integrate their descendants.',
    'A broad request is not evidence that more agents will help. Expand only for useful independent work; reused evidence and local work can be cheaper.',
    'Use status sparingly; collect only when results are needed for synthesis.',
    'The main agent remains accountable for final verification and user-facing output.',
  ];

  if (!normalizedRequest || complexity === 'simple') {
    rationale.push('The request is small enough for direct main-agent execution.');
    return {
      mode: 'solo',
      complexity,
      shouldSpawn: false,
      confidence: 0.78,
      estimatedAgentCount: 0,
      rationale,
      guardrails,
      recommendedAgents: [],
      recommendedToolCall: null,
    };
  }

  if ((explicitPanel || options?.forceHighRigor) && (highStakes || decisionHeavy)) {
    rationale.push('High-stakes decision work benefits from adversarial analysis and rebuttal.');
    return {
      mode: 'debate',
      complexity,
      shouldSpawn: true,
      confidence: 0.86,
      estimatedAgentCount: 2,
      rationale,
      guardrails,
      recommendedAgents: [
        { role: 'skeptic', task: normalizedRequest, reason: 'Challenge assumptions and surface failure modes.' },
        { role: 'realist', task: normalizedRequest, reason: 'Resolve tradeoffs into practical recommendations.' },
      ],
      recommendedToolCall: { mode: 'debate', tasks: [{ task: normalizedRequest }] },
    };
  }

  if ((explicitPanel || options?.forceHighRigor) && highStakes && !decisionHeavy) {
    rationale.push('High-stakes analysis should use independent optimistic, skeptical, and practical perspectives.');
    return {
      mode: 'consensus',
      complexity,
      shouldSpawn: true,
      confidence: 0.82,
      estimatedAgentCount: 3,
      rationale,
      guardrails,
      recommendedAgents: [
        { role: 'optimist', task: normalizedRequest, reason: 'Identify upside and viable paths.' },
        { role: 'skeptic', task: normalizedRequest, reason: 'Identify risks and hidden failures.' },
        { role: 'realist', task: normalizedRequest, reason: 'Ground the synthesis in constraints.' },
      ],
      recommendedToolCall: { mode: 'consensus', tasks: [{ task: normalizedRequest }] },
    };
  }

  if (explicitSingleWorker) {
    const role = specialists[0];
    rationale.push(role
      ? `The user explicitly requested one focused ${role.replace(/_/g, ' ')} worker.`
      : 'The user explicitly requested one focused delegated worker.');
    return {
      mode: role ? 'specialist' : 'parallel',
      complexity,
      shouldSpawn: true,
      confidence: 0.91,
      estimatedAgentCount: 1,
      rationale,
      guardrails,
      recommendedAgents: [{
        role: role || 'parallel_worker',
        task: normalizedRequest,
        reason: 'One deep worker matches the explicit delegation request without unnecessary fan-out.',
      }],
      recommendedToolCall: role
        ? { mode: 'specialist', specialistRole: role, tasks: [{ task: normalizedRequest }] }
        : { mode: 'spawn', tasks: [{ task: normalizedRequest }] },
    };
  }

  if (specialists.length === 1 && !independentWork && !explicitDelegation) {
    const role = specialists[0];
    rationale.push(`The main agent can directly apply the detected ${role.replace(/_/g, ' ')} expertise without delegation overhead.`);
    return {
      mode: 'solo',
      complexity,
      shouldSpawn: false,
      confidence: 0.86,
      estimatedAgentCount: 0,
      rationale,
      guardrails,
      recommendedAgents: [],
      recommendedToolCall: null,
    };
  }

  if (independentWork || explicitDelegation) {
    rationale.push('Delegation is worth considering, but keywords cannot identify independent deliverables or file ownership.');
    rationale.push('Inspect the actual task and design a small frontier of distinct outcomes. Define acceptance, dependency edges, edit ownership, and why each worker helps.');
    return {
      mode: 'parallel', complexity, shouldSpawn: true, requiresTaskDesign: true,
      confidence: 0.5, estimatedAgentCount: 0, rationale, guardrails,
      recommendedAgents: [], recommendedToolCall: null,
    };
  }

  rationale.push(explicitDelegation
    ? 'Delegation was mentioned, but the request does not identify independent lanes; keep it with Main unless the user asks for one focused worker.'
    : 'The request is substantive but appears sequential enough for the main agent.');
  return {
    mode: 'solo',
    complexity,
    shouldSpawn: false,
    confidence: 0.7,
    estimatedAgentCount: 0,
    rationale,
    guardrails,
    recommendedAgents: [],
    recommendedToolCall: null,
  };
}
