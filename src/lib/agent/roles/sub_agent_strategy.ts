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

function splitParallelTasks(request: string, specialists: SpecialistRole[], maxAgents: number): SubAgentStrategyRecommendation[] {
  if (specialists.length > 0) {
    return specialists.slice(0, maxAgents).map((role) => ({
      role,
      task: request,
      reason: `The request matches ${role.replace(/_/g, ' ')} signals.`,
    }));
  }

  const genericTasks = [
    {
      role: 'parallel_worker' as const,
      task: request,
      reason: 'Independent discovery can run while the main agent starts implementation.',
    },
    {
      role: 'parallel_worker' as const,
      task: request,
      reason: 'Independent QA review reduces missed regressions.',
    },
  ];

  return genericTasks.slice(0, maxAgents);
}

export function buildSubAgentStrategy(request: string, options?: { maxAgents?: number; forceHighRigor?: boolean }): SubAgentStrategy {
  const normalizedRequest = String(request || '').trim();
  const maxAgents = Math.max(1, Math.min(options?.maxAgents ?? 4, 6));
  const complexity = detectComplexity(normalizedRequest);
  const specialists = detectSpecialists(normalizedRequest);
  const highStakes = complexity === 'critical';
  const decisionHeavy = /\b(decide|choice|tradeoff|strategy|risk|compare|versus|vs|should we|recommend)\b/i.test(normalizedRequest);
  const independentWork = /\b(parallel|multiple|several|research.*and|audit.*and|fix.*and|review.*and|frontend.*backend|security.*performance)\b/i.test(normalizedRequest);
  const wantsAdvancedAgentWork = /\b(subagent|sub-agent|multi[- ]?agent|orchestrat|specialist|swarm|deep work|advanced|sci fi|autonomous)\b/i.test(normalizedRequest);

  const rationale: string[] = [];
  const guardrails = [
    'Do not spawn agents for tiny sequential tasks or tasks requiring one shared mutable edit at a time.',
    'Keep each sub-agent task independent, scoped, and mergeable by the main agent.',
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

  if ((highStakes || options?.forceHighRigor) && decisionHeavy) {
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

  if (highStakes && !decisionHeavy) {
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

  if (specialists.length === 1 && !independentWork && !wantsAdvancedAgentWork) {
    const role = specialists[0];
    rationale.push(`The request maps cleanly to one ${role.replace(/_/g, ' ')} specialist.`);
    return {
      mode: 'specialist',
      complexity,
      shouldSpawn: true,
      confidence: 0.79,
      estimatedAgentCount: 1,
      rationale,
      guardrails,
      recommendedAgents: [{
        role,
        task: normalizedRequest,
        reason: 'A focused specialist is lower overhead than a broad swarm.',
      }],
      recommendedToolCall: { mode: 'specialist', specialistRole: role, tasks: [{ task: normalizedRequest }] },
    };
  }

  if (specialists.length > 0 || independentWork || wantsAdvancedAgentWork || complexity === 'complex') {
    const agents = splitParallelTasks(normalizedRequest, specialists, maxAgents);
    rationale.push('The request has independent work lanes that can be explored in parallel.');
    if (specialists.length > 0) {
      rationale.push(`Detected specialist lanes: ${specialists.map((role) => role.replace(/_/g, ' ')).join(', ')}.`);
    }
    return {
      mode: specialists.length > 1 ? 'hybrid' : 'parallel',
      complexity,
      shouldSpawn: true,
      confidence: 0.74,
      estimatedAgentCount: agents.length,
      rationale,
      guardrails,
      recommendedAgents: agents,
      recommendedToolCall: {
        mode: 'spawn',
        tasks: agents.map((agent) => ({ task: agent.task, name: agent.name })),
      },
    };
  }

  rationale.push('The request is substantive but appears sequential enough for the main agent.');
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
