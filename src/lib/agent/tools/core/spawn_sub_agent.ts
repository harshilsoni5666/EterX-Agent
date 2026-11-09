import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { globalSubAgentSpawner, agentMessageBus, SubAgentName, clearPendingResults, getPendingResults, getRetainedResult, hasPendingResults, pauseAgent, resumeAgent, closeAgent } from '../../roles/sub_agent';
import { interAgentMailbox } from '../../roles/inter_agent_comm';
import { buildSubAgentStrategy, type SpecialistRole } from '../../roles/sub_agent_strategy';
import { enforceToolCapability } from '../security/tool_policy';
import { MODEL_PROVIDER_ORDER } from '../../model-selector-store';
import type { MainAgentMode, MainAgentProvider } from '../../model-routing';
import { MAX_SUB_AGENTS } from '../../sub-agent-settings';
import { swarmCoordinator, SWARM_LIMITS, type SwarmContract } from '../../swarm-coordinator';
import { SUB_AGENT_MODEL_SELECTION_GUIDANCE } from '../../sub-agent-model-guidance';
import { getSubAgentCreationArgumentGaps, SUB_AGENT_SPAWN_EXAMPLE, SUB_AGENT_SPAWN_GUIDANCE } from '../../sub-agent-spawn-guidance';
import {
  assessDelegatedAgent,
  formatDelegationCollection,
  summarizeDelegationCollection,
} from '../../delegation-evidence';

const SPECIALIST_ROLES = ['security_auditor', 'performance_analyst', 'architect', 'qa_tester', 'researcher'] as const;
const MODEL_PROVIDER_ENUM = MODEL_PROVIDER_ORDER as [MainAgentProvider, ...MainAgentProvider[]];
const MODEL_MODE_ENUM = ['think', 'fast', ...MODEL_PROVIDER_ORDER.filter(provider => provider !== 'gemini')] as [MainAgentMode, ...MainAgentMode[]];
const SUB_AGENT_TASK_SCHEMA = z.object({
  task: z.string().min(1).max(200_000).describe('Detailed task description for this sub-agent'),
  name: z.string().optional().describe('Optional agent name (auto-assigned if not provided)'),
  key: z.string().min(1).max(100).optional().describe('Unique task key within this run, usable by dependsOn in the same batch'),
  dependsOn: z.array(z.string()).max(64).optional().describe('Task keys in this batch or existing task IDs in this run whose usable evidence must arrive before this task starts'),
  acceptance: z.string().max(4000).optional().describe('Concrete evidence or deliverable that makes this assignment complete'),
  rationale: z.string().max(2000).optional().describe('Why this independent outcome justifies another agent; avoid duplicating an existing task'),
  resources: z.array(z.object({ path: z.string().min(1), access: z.enum(['read', 'write']) })).max(64).optional()
    .describe('File or directory ownership. Overlapping writers/readers are serialized. Omission inherits the parent scope; [] permits no file writes. Paths are relative to the workspace. Declare all shared writes.'),
  priority: z.number().int().min(0).max(10).optional().describe('Scheduling priority; waiting tasks gain priority with age'),
  mode: z.enum(MODEL_MODE_ENUM).optional()
    .describe('Optional worker provider mode. Strongly prefer omission to inherit your current model; use thinkingLevel for a reasoning-depth change. For a deliberate model change, prefer exact provider plus model.'),
  provider: z.enum(MODEL_PROVIDER_ENUM).optional()
    .describe('Optional exact provider chosen by the spawning agent; use together with model. Prefer your current provider and model by default. Override for a concrete task benefit or recovery, not model variety.'),
  model: z.string().min(1).optional().describe('Optional exact model ID chosen by the spawning agent; use together with provider. Usually omit to inherit your current model. Another available model may be chosen before any failure when its task benefit is clear.'),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    .describe('Optional thinking level for this worker')
}).refine(
  task => Boolean(task.provider) === Boolean(task.model),
  { message: 'provider and model must be provided together' },
);

function rejectAgentAction(mode: string, message: string, requiredArguments: string[] = []) {
  return {
    mode, agents: [], success: false, executed: false, error: message,
    message: requiredArguments.length ? `${message}\n${SUB_AGENT_SPAWN_GUIDANCE}` : message,
    shouldPoll: false,
    ...(requiredArguments.length ? { needsArguments: true, requiredArguments, argumentExample: SUB_AGENT_SPAWN_EXAMPLE } : {}),
  };
}

function buildCollectionPayload(agents: any[], prefix = '', options: { resultOffset?: number; resultLimit?: number } = {}) {
  const perReportLimit = Math.min(options.resultLimit || 12000, Math.max(1, Math.floor(48000 / Math.max(1, agents.length))));
  const annotatedAgents = agents.map(agent => {
    const delegationEvidence = assessDelegatedAgent(agent, true);
    const fullResult = String(agent.result || '');
    const resultOffset = Math.min(options.resultOffset || 0, fullResult.length);
    const result = fullResult.slice(resultOffset, resultOffset + perReportLimit);
    const nextResultOffset = resultOffset + result.length < fullResult.length ? resultOffset + result.length : null;
    const payloadTruncated = resultOffset > 0 || nextResultOffset !== null;
    return { ...agent, task: String(agent.task || '').slice(0, 1200), result,
      traceLog: Array.isArray(agent.traceLog) ? agent.traceLog.slice(-3) : [],
      collected: delegationEvidence.collected, resultOffset, nextResultOffset,
      resultChars: fullResult.length, payloadTruncated,
      delegationEvidence: { ...delegationEvidence, payloadTruncated } };
  });
  const collection = summarizeDelegationCollection(annotatedAgents.map(agent => agent.delegationEvidence));
  const truncated = annotatedAgents.some(agent => agent.payloadTruncated);
  return {
    agents: annotatedAgents, collection,
    evidenceReady: collection.evidenceReady,
    fullyGrounded: collection.fullyGrounded && !truncated,
    usableResults: annotatedAgents.filter(agent => agent.delegationEvidence.evidenceReady),
    message: [prefix, formatDelegationCollection(collection), truncated ? 'Some reports are excerpts. Continue collect with the exact agentId and nextResultOffset as resultOffset to read the remainder before relying on it.' : ''].filter(Boolean).join(' '),
    snapshotOnly: true, shouldPoll: false,
    nextRecommendedAction: collection.evidenceReady
      ? 'Read the required reports, resolve uncertainties, and integrate their evidence.'
      : 'Continue independent work or join when child evidence is needed.',
  };
}

async function collectGraphNode(projectId: string, node: any) {
  if (['queued', 'running', 'waiting'].includes(node.state)) {
    return { name: node.name, agentId: node.id, task: node.task, status: node.state, progress: node.reason,
      parentAgentId: node.parentAgentId, parentAgentName: node.parentAgentName, depth: node.depth, result: '' };
  }
  const retained = await getRetainedResult(projectId, node.id, false);
  if (retained && (retained.attempt || 0) === (node.attempt || 0)) return await getRetainedResult(projectId, node.id) || retained;
  return {
    name: node.name, agentId: node.id, task: node.task, status: node.state,
    result: node.reason || '', success: false,
    parentAgentId: node.parentAgentId, parentAgentName: node.parentAgentName, depth: node.depth,
  };
}

/**
 * Spawn Sub-Agent Tool v2 — Fire-and-Forget Parallel Agent Spawner
 * 
 * KEY CHANGE: "spawn" mode now returns IMMEDIATELY with agent names.
 * The main agent continues working while sub-agents run in the background.
 * Workers hand off automatically; Main collects only when synthesis needs a retained snapshot.
 * 
 * Parents continue independent work, then explicitly join required children.
 * Waiting parents release their slots and claims to prevent nested deadlocks.
 * 
 * MODES:
 * - spawn: Fire-and-forget launch. Returns immediately with agent names.
 * - status: Check what sub-agents are doing right now.
 * - collect: Snapshot result payloads and their evidence usability; never a join barrier.
 * - clear: Clean up completed agent files.
 */
export const spawnSubAgentTool: ToolDefinition = {
  name: 'spawn_sub_agent',
  description: `Spawn full-power sub-agents, ask for orchestration advice, check status, collect results, or run advanced panels.

MODES:
- "advise": Decide whether the current request should stay solo or use parallel agents, consensus, debate, or a specialist. Does not spawn anything.
- "spawn": FIRE-AND-FORGET launch. Returns immediately with custom task-based names and exact run IDs. Existing workers keep running and new workers fill available concurrent slots. Continue independent work; use join when further progress requires child evidence.
- "graph": Paginated dependency graph, resource ownership, queue reasons and remaining task budget.
- "join": Wait for your children only when their evidence is needed. Your slot is released while waiting and reacquired before returning.
- "status": Check what sub-agents are doing right now. Returns their current progress.
- "collect": Get retained, distinct run-ID-based results from completed, failed, or cancelled sub-agents. Call this ONLY when you need their output snapshot; workers also report to their delegating parent automatically.
- "consensus": Run a 3-agent Optimist/Skeptic/Realist panel for high-stakes analysis.
- "debate": Run multi-round adversarial analysis for critical tradeoffs, security, financial, or strategic decisions.
- "specialist": Run one deeply profiled specialist: security_auditor, performance_analyst, architect, qa_tester, researcher.
- "pause", "resume", "close": Control a specific running agent.
- "clear": Clean up completed agent data files.

CRITICAL WORKFLOW:
1. If unsure, call mode="advise" with the user request.
2. If spawning, use independent tasks only. Launch with mode="spawn" and continue your own work.
3. Use mode="status" sparingly; do not poll in a loop. Use agent_communicate for direct/team coordination while work continues.
4. Workers automatically hand off to their parent, which owns integration. Call mode="collect" when retained distinct results are needed and synthesize them with your own work.
5. Lifecycle is not evidence. Read collection.fullyGrounded and each agent.delegationEvidence. Never infer a finding from started/running/completed status, and never merge a pending, empty, failed, cancelled, or unavailable payload.

${SUB_AGENT_MODEL_SELECTION_GUIDANCE}

${SUB_AGENT_SPAWN_GUIDANCE}

WHEN TO SPAWN: 2+ independent parts, each worth meaningful work.
WHEN NOT TO SPAWN: simple tasks, strictly sequential edits, or one shared mutable file that needs careful single-threaded changes.
WHEN TO USE DEBATE: high-stakes choices where assumptions need challenge and rebuttal.
WHEN TO USE SPECIALIST: focused security, performance, architecture, QA, or research tasks.`,
  category: 'core',
  inputSchema: z.object({
    mode: z.enum(['advise', 'spawn', 'graph', 'join', 'status', 'collect', 'clear', 'consensus', 'debate', 'specialist', 'pause', 'resume', 'close'])
      .describe('advise = choose the right orchestration pattern without spawning, spawn = fire-and-forget launch, status = check progress, collect = get results, clear = cleanup, consensus = 3-agent panel, debate = multi-round adversarial panel, specialist = one expert role, pause/resume/close = control an agent'),
    tasks: z.array(SUB_AGENT_TASK_SCHEMA).max(SWARM_LIMITS.maxBatch).optional().describe('REQUIRED nonempty array for spawn, consensus, debate, and specialist, even for one worker. Every entry requires task; put name and worker options inside the entry. Swarm spawn also requires rationale and acceptance. Panels/specialist accept exactly one topic; ordinary spawn accepts a bounded frontier.'),
    offset: z.number().int().min(0).optional().describe('Pagination offset for graph, status, collect, or join'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum entries per page; default 50 for graph and 20 for reports/status'),
    resultOffset: z.number().int().min(0).optional().describe('Character offset for reading a retained report; use with exact agentId'),
    resultLimit: z.number().int().min(512).max(48000).optional().describe('Maximum report characters; pages share a 48000-character payload budget'),
    request: z.string().optional().describe('Original user request for advise mode. Falls back to the first task if omitted.'),
    specialistRole: z.enum(SPECIALIST_ROLES).optional().describe('Required for specialist mode.'),
    maxAgents: z.number().int().min(1).max(MAX_SUB_AGENTS).optional().describe('Maximum agents to recommend in advise mode.'),
    agentName: z.string().optional().describe('Existing agent name to check status/collect/control for; not a new worker name. Use tasks[i].name when spawning.'),
    agentId: z.string().optional().describe('Exact run ID for unambiguous status, collection, or control when a task name has been reused')
  }).superRefine((input, ctx) => {
    for (const argument of getSubAgentCreationArgumentGaps(input)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: argument.split('.'), message: `Required for ${input.mode}: ${argument}. Creation modes require a nonempty tasks array of task objects; provider and model must be supplied or omitted together.` });
    }
    if (['consensus', 'debate', 'specialist'].includes(input.mode) && input.tasks && input.tasks.length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks'], message: `${input.mode} accepts exactly one topic in tasks. Use mode="spawn" for multiple independent assignments.` });
    }
  }),
  outputSchema: z.object({
    mode: z.string(),
    agents: z.array(z.any()),
    message: z.string(),
    success: z.boolean().optional(),
    executed: z.boolean().optional(),
    error: z.string().optional(),
    needsArguments: z.boolean().optional(),
    requiredArguments: z.array(z.string()).optional(),
    argumentExample: z.any().optional(),
    collection: z.any().optional(),
    graph: z.any().optional(),
    total: z.number().optional(),
    nextOffset: z.number().nullable().optional(),
    unresolvedCount: z.number().optional(),
    collectionScope: z.string().optional(),
    unresolved: z.array(z.any()).optional(),
    evidenceReady: z.boolean().optional(),
    fullyGrounded: z.boolean().optional(),
    usableResults: z.array(z.any()).optional(),
    completedResults: z.array(z.any()).optional(),
    shouldPoll: z.boolean().optional(),
    snapshotOnly: z.boolean().optional(),
    nextRecommendedAction: z.string().optional(),
    repeatSuppressed: z.boolean().optional(),
    spawnedAgentNames: z.array(z.string()).optional(),
    notStartedTasks: z.array(z.any()).optional(),
  }),
  execute: async (input: {
    mode: string,
    tasks?: Array<SwarmContract & {
      task: string,
      name?: string,
      mode?: MainAgentMode,
      provider?: MainAgentProvider,
      model?: string,
      thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    }>,
    request?: string,
    specialistRole?: SpecialistRole,
    maxAgents?: number,
    agentName?: string,
    agentId?: string,
    offset?: number,
    limit?: number,
    resultOffset?: number,
    resultLimit?: number,
  }, context: any) => {
    const argumentGaps = getSubAgentCreationArgumentGaps(input);
    if (argumentGaps.length) {
      return rejectAgentAction(input.mode, `No workers started. Supply ${argumentGaps.join(', ')} using the required tasks array.`, argumentGaps);
    }
    if (['consensus', 'debate', 'specialist'].includes(input.mode) && input.tasks && input.tasks.length > 1) {
      return rejectAgentAction(input.mode, `${input.mode} requires exactly one topic in tasks; use mode="spawn" for multiple assignments.`, ['tasks']);
    }
    if (context?.isUserProxy) {
      if (input.mode !== 'specialist') {
        return rejectAgentAction(input.mode, 'User Proxy may only create one temporary specialist.');
      }
      if (context._userProxyHelperUsed) {
        return rejectAgentAction(input.mode, 'User Proxy specialist allowance has already been used.');
      }
      if (!input.tasks || input.tasks.length !== 1) {
        return rejectAgentAction(input.mode, 'User Proxy must provide exactly one focused specialist task.', ['tasks']);
      }
    }
    const decision = enforceToolCapability('spawn_sub_agent', input, context);
    if (!decision.allowed) {
      return rejectAgentAction(input.mode || 'blocked', decision.reason || 'Sub-agent spawning is not allowed');
    }

    if (input.agentId && ['pause', 'resume', 'close'].includes(input.mode)) {
      const target = swarmCoordinator.get(input.agentId);
      const active = globalSubAgentSpawner.getAgentStatus().find(agent => agent.id === input.agentId && agent.projectId === context.projectId);
      const name = target && target.projectId === context.projectId ? target.name : active?.name;
      if (!name || input.agentName && input.agentName.toLowerCase() !== name.toLowerCase()) {
        return rejectAgentAction(input.mode, 'The agent ID does not match a worker in this project or the supplied agent name.');
      }
      input = { ...input, agentName: name };
    }

    if (context?.isSubAgent && ['pause', 'resume', 'close', 'clear'].includes(input.mode)) {
      const target = input.agentId || (input.agentName ? globalSubAgentSpawner.findActiveAgentId(context.projectId, input.agentName) : undefined);
      if (input.mode === 'clear' || !target || !swarmCoordinator.descendants(context.subAgentId).some(node => node.id === target)) {
        return rejectAgentAction(input.mode, 'Workers may control only their descendants. Ask the parent to coordinate changes to another branch.');
      }
    }

    // Extract the UI trace callback from context (injected by gemini.ts)
    const onTrace = (context?._rootOnTrace || context?._onTrace) as ((t: any) => void) | undefined;
    const resolveActiveAgentId = (agentName: string) =>
      globalSubAgentSpawner.findActiveAgentId(context?.projectId, agentName);
    const topic = input.tasks?.[0];
    const workerOptions = topic ? {
      mode: topic.mode, provider: topic.provider, model: topic.model,
      thinkingLevel: topic.thinkingLevel, resources: topic.resources,
    } : undefined;

    // Status and collect are observations, not a waiting primitive. Suppress an
    // immediate second observation in the same Main turn regardless of which
    // observation mode the model swaps to (collect -> status was a common loop).
    if (input.mode === 'status' || input.mode === 'collect') {
      const now = Date.now();
      const observations: Map<string, number> = context._subAgentObservations ||= new Map();
      const revision = swarmCoordinator.snapshot(context, 0, 0).revision;
      const observationKey = `${input.mode}:${input.agentId || input.agentName || '*'}:${input.offset || 0}:${input.resultOffset || 0}:${revision}`;
      const previousObservationAt = observations.get(observationKey) || 0;
      if (previousObservationAt > 0 && now - previousObservationAt < 15_000) {
        return {
          mode: input.mode,
          agents: [],
          shouldPoll: false,
          snapshotOnly: true,
          repeatSuppressed: true,
          nextRecommendedAction: 'Continue Main work; incoming worker handoffs are automatic.',
          message: 'Repeated agent observation suppressed. No waiting or polling is needed; continue Main work.',
        };
      }
      observations.set(observationKey, now);
      if (observations.size > 64) observations.delete(observations.keys().next().value!);
    }

    switch (input.mode) {
      case 'graph': {
        const graph = swarmCoordinator.snapshot(context, input.offset || 0, input.limit || 50);
        return { mode: 'graph', agents: graph.nodes, graph, shouldPoll: false,
          message: 'Use dependencies, ownership and actual evidence to decide the next useful frontier. Team size is not a target.' };
      }
      case 'join': {
        await globalSubAgentSpawner.joinChildren(context);
        const graph = swarmCoordinator.snapshot(context, 0, SWARM_LIMITS.maxNodes);
        const children = graph.nodes.filter(node => node.parentAgentId === context.subAgentId);
        const offset = input.offset || 0, limit = input.limit || 20;
        const page = children.slice(offset, offset + limit);
        const results = await Promise.all(page.map(node => collectGraphNode(context.projectId, node)));
        const unresolved = children.filter(node => ['blocked', 'failed', 'cancelled'].includes(node.state));
        const payload = buildCollectionPayload(results, 'Direct children settled. Integrate their reports; inspect the graph for deeper branches.', input);
        return { mode: 'join', ...payload, total: children.length,
          collectionScope: 'Returned page of direct children',
          fullyGrounded: payload.fullyGrounded && page.length === children.length && unresolved.length === 0,
          nextOffset: offset + limit < children.length ? offset + limit : null,
          unresolvedCount: unresolved.length,
          unresolved: unresolved.slice(0, limit).map(node => ({ agentId: node.id, name: node.name, status: node.state, reason: node.reason })) };
      }
      // === ADVISE: Decide orchestration without spawning ===
      case 'advise': {
        const request = input.request || input.tasks?.[0]?.task || '';
        const strategy = buildSubAgentStrategy(request, { maxAgents: input.maxAgents });
        return {
          mode: 'advise',
          agents: strategy.recommendedAgents,
          message: strategy.requiresTaskDesign
            ? 'Define task-specific independent outcomes before spawning. No team size or fixed role layout has been prescribed.'
            : strategy.shouldSpawn
            ? `Recommended ${strategy.mode} orchestration with ${strategy.estimatedAgentCount} agent(s).`
            : 'Recommended direct main-agent execution.',
          strategy
        };
      }

      // ═══ SPAWN: Fire-and-forget launch ═══
      case 'spawn': {
        if (!input.tasks || input.tasks.length === 0) {
          return rejectAgentAction('spawn', 'No workers started. Pass a nonempty tasks array containing {task, name?} objects.', ['tasks']);
        }
        if (context.swarmMode && input.tasks.some(task => !task.rationale?.trim() || !task.acceptance?.trim())) {
          const required = input.tasks.flatMap((task, index) => [
            ...(!task.rationale?.trim() ? [`tasks.${index}.rationale`] : []),
            ...(!task.acceptance?.trim() ? [`tasks.${index}.acceptance`] : []),
          ]);
          return rejectAgentAction('spawn', 'No workers started. Swarm Mode requires a rationale and acceptance condition for each task.', required);
        }

        const taskList = input.tasks.map(t => ({
          ...t,
          task: t.task,
          name: t.name as SubAgentName | undefined,
          mode: t.mode,
          provider: t.provider,
          model: t.model,
          thinkingLevel: t.thinkingLevel,
        }));

        const parentContext = `${context.agentName || 'Main'} delegated ${taskList.length} outcomes. Integrate your own descendants and report to your parent. Original user request and restrictions:\n${context.rootUserRequest || context.workingContextRequest?.visibleText || context.conversationSummary || ''}`;

        // Fire-and-forget: returns immediately
        let launch: ReturnType<typeof globalSubAgentSpawner.spawnParallelFireAndForget>;
        try { launch = globalSubAgentSpawner.spawnParallelFireAndForget(
          taskList,
          context,
          parentContext,
          onTrace
        ); } catch (error) {
          const message = error instanceof Error ? error.message : 'Task graph admission failed';
          // Admission errors normally precede side effects, but a launch-time
          // exception can occur later. Do not promise executed=false here.
          return { mode: 'spawn', agents: [], success: false, error: message, message, shouldPoll: false,
            nextRecommendedAction: 'Inspect the task graph before retrying; do not duplicate assignments already admitted.' };
        }
        const { agentNames, agents, notStartedTasks, message } = launch;

        return {
          mode: 'spawn',
          success: true,
          agents: agents.map(agent => ({ ...agent, status: swarmCoordinator.get(agent.agentId)?.state || 'queued' })),
          message: message + '\n\nContinue independent work. Join when a dependent step needs child evidence; collect reads retained snapshots without waiting. Every parent must integrate its required branches before finishing.',
          shouldPoll: false,
          nextRecommendedAction: 'Continue Main work on independent parts of the request.',
          spawnedAgentNames: agentNames,
          notStartedTasks,
        };
      }

      // ═══ STATUS: Check what sub-agents are doing ═══
      case 'status': {
        const graph = swarmCoordinator.snapshot(context, 0, SWARM_LIMITS.maxNodes);
        if (graph.total || input.agentId) {
          const exact = input.agentId ? swarmCoordinator.get(input.agentId) : undefined;
          const matches = input.agentId ? (exact && exact.projectId === context.projectId ? [exact] : [])
            : graph.nodes.filter(node => !input.agentName || node.name.toLowerCase() === input.agentName.toLowerCase());
          const offset = input.offset || 0, limit = input.limit || 20;
          const agents: any[] = matches.slice(offset, offset + limit).map(node => ({
            name: node.name, agentId: node.id, status: node.state, progress: node.reason,
            task: node.task.slice(0, 600), parentAgentId: node.parentAgentId, parentAgentName: node.parentAgentName, depth: node.depth,
          }));
          if (!agents.length && input.agentId) {
            const retained = await getRetainedResult(context.projectId, input.agentId, false);
            if (retained) agents.push({ name: retained.name, agentId: retained.agentId, status: retained.status, task: retained.task.slice(0, 600) });
          }
          return { mode: 'status', agents, total: matches.length || agents.length,
            nextOffset: offset + limit < matches.length ? offset + limit : null,
            shouldPoll: false, message: `${agents.length} task states returned. Completion is not proof of correctness; collect the required reports.` };
        }
        if (input.agentName) {
          const liveAgentId = input.agentId || globalSubAgentSpawner.findActiveAgentId(context?.projectId, input.agentName);
          const liveAgent = liveAgentId
            ? globalSubAgentSpawner.getAgentStatus().find(agent => agent.id === liveAgentId)
            : undefined;
          const diskStatus = await agentMessageBus.readAgentStatus(input.agentName, context?.projectId);
          const status = liveAgent || (!input.agentId || diskStatus?.agentId === input.agentId ? diskStatus : null);
          const mailboxSummary = interAgentMailbox.getMailboxSummaries(context?.projectId || '')
            .find(summary => summary.agentName.toLowerCase() === input.agentName!.toLowerCase());
          const presence = interAgentMailbox.getTeamSnapshot(context?.projectId || '')
            .find(agent => agent.agentName.toLowerCase() === input.agentName!.toLowerCase());
          if (!status) {
            if (presence || mailboxSummary) {
              return {
                mode: 'status',
                agents: [{
                  name: input.agentName,
                  agentId: presence?.agentId,
                  subAgentChatId: presence?.subAgentChatId,
                  status: presence?.status || 'registered',
                  progress: presence?.progress,
                  task: presence?.task,
                  unreadCount: mailboxSummary?.unreadCount || 0,
                  recentActions: []
                }],
                message: `${ input.agentName }: ${ presence?.status || 'registered' }`
              };
            }
            return {
              mode: 'status', agents: [], shouldPoll: false,
              nextRecommendedAction: 'Continue Main work or send a direct message only if coordination is required.',
              message: `No status found for ${ input.agentName }. Do not repeat this status check.`
            };
          }
          return {
            mode: 'status',
            shouldPoll: false,
            nextRecommendedAction: 'Continue Main work; this worker will report automatically.',
            agents: [{
              name: input.agentName,
              agentId: (status as any).id || status.agentId,
              subAgentChatId: status.subAgentChatId || ((status as any).id ? `${context?.projectId}::sub-agent::${(status as any).id}` : undefined),
              status: presence?.status || status.status,
              progress: presence?.progress || status.progress,
              task: presence?.task || status.task,
              unreadCount: mailboxSummary?.unreadCount || 0,
              recentActions: status.traceLog?.slice(-5) || []
            }],
            message: `${ input.agentName }: ${ presence?.status || status.status } — ${ presence?.progress || status.progress || 'working...' }`
          };
        }

        // Check for queued results first
        const queuedCount = hasPendingResults(context?.projectId) ? 'Uncollected reports are available; read their result usability before synthesis.' : '';
        
        const projectId = context?.projectId || '';
        const allStatuses = await agentMessageBus.readAllStatuses(projectId);
        const teamSnapshot = interAgentMailbox.getTeamSnapshot(projectId);
        const mailboxSummaries = interAgentMailbox.getMailboxSummaries(projectId);
        const mailboxByName = new Map(mailboxSummaries.map(summary => [summary.agentName.toLowerCase(), summary]));
        const statusByName = new Map<string, any>();
        for (const [name, data] of Object.entries(allStatuses) as Array<[string, any]>) {
          statusByName.set(String(data.agentName || name).toLowerCase(), data);
        }
        const rosterNames = new Set<string>([
          ...teamSnapshot.map(agent => agent.agentName),
          ...mailboxSummaries.map(summary => summary.agentName),
          ...Array.from(statusByName.values()).map((status: any) => status.agentName || ''),
        ].filter(Boolean));

        const presenceByName = new Map(teamSnapshot.map(agent => [agent.agentName.toLowerCase(), agent]));
        const roster = Array.from(rosterNames);
        const offset = input.offset || 0, limit = input.limit || 20;
        const agents = roster.slice(offset, offset + limit).map((name) => {
          const key = name.toLowerCase();
          const data = statusByName.get(key);
          const presence = presenceByName.get(key);
          const mailbox = mailboxByName.get(key);
          return {
            name,
            agentId: data?.agentId || presence?.agentId,
            subAgentChatId: data?.subAgentChatId || presence?.subAgentChatId,
            role: presence?.role || (key === 'main' ? 'main' : 'sub_agent'),
            status: presence?.status || data?.status || 'registered',
            progress: presence?.progress || data?.progress,
            task: (presence?.task || data?.task)?.substring(0, 120),
            unreadCount: mailbox?.unreadCount || 0,
            totalMessages: mailbox?.totalCount || 0,
            recentActions: data?.traceLog?.slice(-3) || []
          };
        });

        return {
          mode: 'status',
          agents,
          total: roster.length,
          nextOffset: offset + limit < roster.length ? offset + limit : null,
          shouldPoll: false,
          nextRecommendedAction: 'Continue Main work; use direct communication only for a concrete coordination need.',
          message: agents.length > 0
            ? `${ agents.length } agents tracked. ${ agents.filter((a: any) => a.status === 'running').length } running, ${ agents.filter((a: any) => a.status === 'completed').length } completed. ${ queuedCount } Do not poll; workers report to Main automatically.`
            : 'No active sub-agents. Do not repeat this status check.'
        };
      }

      // ═══ COLLECT: Get final results from completed sub-agents ═══
      case 'collect': {
        // Select before reading/marking reports. A branch or page cannot consume
        // a sibling's unread evidence, and exact IDs survive display-name reuse.
        const projectId = context.projectId;
        const graph = swarmCoordinator.snapshot(context, 0, SWARM_LIMITS.maxNodes);
        const offset = input.offset || 0, limit = input.limit || 20;
        let records: any[];
        let total: number;
        if (input.agentId) {
          const node = swarmCoordinator.get(input.agentId);
          const record = node?.projectId === projectId ? await collectGraphNode(projectId, node)
            : await getRetainedResult(projectId, input.agentId);
          records = record ? [record] : [];
          total = records.length;
        } else if (graph.total) {
          const matches = graph.nodes.filter(node => !input.agentName || node.name.toLowerCase() === input.agentName.toLowerCase());
          total = matches.length;
          records = await Promise.all(matches.slice(offset, offset + limit).map(node => collectGraphNode(projectId, node)));
        } else {
          // Compatibility/restart fallback: exact-ID archives remain available,
          // while name-based discovery uses the last saved status per name.
          const retained = getPendingResults(projectId, input.agentName, undefined, { markCollected: false });
          const statuses = input.agentName
            ? [await agentMessageBus.readAgentStatus(input.agentName, projectId)].filter(Boolean)
            : Object.values(await agentMessageBus.readAllStatuses(projectId));
          const ids = new Set(retained.map(record => record.agentId));
          const candidates: any[] = [...retained, ...statuses.filter((status: any) => !ids.has(status.agentId))];
          total = candidates.length;
          records = await Promise.all(candidates.slice(offset, offset + limit).map(async record =>
            record.agentId ? await getRetainedResult(projectId, record.agentId) || { ...record, name: record.agentName || record.name }
              : { ...record, name: record.agentName || record.name }));
        }
        const nextOffset = !input.agentId && offset + limit < total ? offset + limit : null;
        const payload = buildCollectionPayload(records, `${records.length} of ${total} matching task records returned.`, input);
        return { mode: 'collect', ...payload, total, nextOffset,
          collectionScope: input.agentId ? 'Exact task ID' : graph.total ? 'Returned page of this run' : 'Returned page of retained history',
          fullyGrounded: payload.fullyGrounded && records.length === total,
          completedResults: payload.usableResults };
      }

      // ═══ CLEAR: Clean up agent files ═══
      case 'clear': {
        if (globalSubAgentSpawner.getBackgroundCount(context?.projectId)) return { mode: 'clear', agents: [], message: 'Active tasks still own their reports and mailboxes. Finish or close them before clearing retained data.' };
        let release: () => void;
        try { release = swarmCoordinator.beginResultCleanup(context.projectId); }
        catch (error) { return { mode: 'clear', agents: [], message: error instanceof Error ? error.message : 'Task data is currently in use.' }; }
        try {
          await agentMessageBus.clearAll(context.projectId);
          await interAgentMailbox.clearProject(context.projectId);
          clearPendingResults(context.projectId);
        } finally { release(); }
        return { mode: 'clear', agents: [], message: 'All sub-agent data cleared.' };
      }

      // ═══ CONSENSUS: 3-Agent Debate Panel ═══
      case 'consensus': {
        if (!input.tasks || input.tasks.length === 0) {
          return rejectAgentAction('consensus', 'Pass tasks with exactly one {task} describing the analysis needed.', ['tasks']);
        }

        const consensusTask = input.tasks[0].task; // Use the first task as the consensus topic
        const consensusResult = await globalSubAgentSpawner.spawnConsensus(
          consensusTask,
          context,
          onTrace,
          workerOptions,
        );

        const payload = buildCollectionPayload(consensusResult.perspectives.map(item => ({
          name: item.agent,
          task: `${item.perspective} perspective: ${consensusTask}`,
          status: item.success ? 'completed' : 'failed',
          success: item.success,
          result: item.result,
          perspective: item.perspective,
        })), 'Consensus panel evidence collected.');
        return {
          mode: 'consensus',
          ...payload,
          message: `${payload.message}\n\nPanel synthesis request:\n${consensusResult.synthesisPrompt}`,
          synthesisPrompt: consensusResult.synthesisPrompt,
          totalDurationMs: consensusResult.totalDurationMs
        };
      }

      // === DEBATE: Multi-round adversarial panel ===
      case 'debate': {
        if (!input.tasks || input.tasks.length === 0) {
          return rejectAgentAction('debate', 'Pass tasks with exactly one {task} describing the decision or analysis.', ['tasks']);
        }

        const debateResult = await globalSubAgentSpawner.spawnDebate(
          input.tasks[0].task,
          context,
          onTrace,
          workerOptions,
        );

        const payload = buildCollectionPayload(debateResult.rounds.flatMap(round => round.results.map(result => ({
            round: round.round,
            name: result.agent,
            task: `Debate round ${round.round}: ${input.tasks![0].task}`,
            status: result.success ? 'completed' : 'failed',
            success: result.success,
            result: result.result,
          }))));
        return {
          mode: 'debate',
          ...payload,
          message: `${payload.message}\n\nDebate synthesis:\n${debateResult.synthesis}`,
          synthesis: debateResult.synthesis,
          totalDurationMs: debateResult.totalDurationMs,
          confidenceScore: debateResult.confidenceScore
        };
      }

      // === SPECIALIST: One focused expert role ===
      case 'specialist': {
        if (!input.specialistRole) {
          return rejectAgentAction('specialist', `specialistRole is required. Use one of: ${SPECIALIST_ROLES.join(', ')}.`, ['specialistRole']);
        }
        if (!input.tasks || input.tasks.length === 0) {
          return rejectAgentAction('specialist', 'Pass tasks with exactly one {task}.', ['tasks']);
        }

        if (context?.isUserProxy) context._userProxyHelperUsed = true;
        const specialistResult = await globalSubAgentSpawner.spawnSpecialist(
          input.specialistRole,
          input.tasks[0].task,
          context,
          onTrace,
          workerOptions,
        );

        const payload = buildCollectionPayload([{
            role: input.specialistRole,
            name: specialistResult.name,
            status: specialistResult.success ? 'completed' : 'failed',
            success: specialistResult.success,
            task: input.tasks[0].task,
            result: specialistResult.result,
            durationMs: specialistResult.durationMs,
            confidence: specialistResult.confidence
          }], `${specialistResult.name} completed ${input.specialistRole.replace(/_/g, ' ')} specialist work.`);
        return {
          mode: 'specialist',
          ...payload,
          totalDurationMs: specialistResult.durationMs
        };
      }

      // === PAUSE: Pause a specific sub-agent ===
      case 'pause': {
        if (!input.agentName) {
          return rejectAgentAction('pause', 'agentName is required for pause mode.');
        }
        const targetAgentId = input.agentId || resolveActiveAgentId(input.agentName);
        const paused = pauseAgent(context?.projectId, input.agentName, onTrace, targetAgentId);
        return {
          mode: 'pause',
          agents: [{ name: input.agentName, agentId: targetAgentId, status: paused ? 'paused' : 'not_running' }],
          message: paused ? `${input.agentName} has been paused. Call mode="resume" with agentId="${targetAgentId}" to continue.` : `${input.agentName} is not an active controllable run.`
        };
      }

      // === RESUME: Resume a paused sub-agent ===
      case 'resume': {
        if (!input.agentName) {
          return rejectAgentAction('resume', 'agentName is required for resume mode.');
        }
        const targetAgentId = input.agentId || resolveActiveAgentId(input.agentName);
        const resumed = resumeAgent(context?.projectId, input.agentName, onTrace, targetAgentId);
        return {
          mode: 'resume',
          agents: [{ name: input.agentName, agentId: targetAgentId, status: resumed ? 'working' : 'not_paused_or_running' }],
          message: resumed ? `${input.agentName} has been resumed.` : `${input.agentName} is not paused or no longer running.`
        };
      }

      // === CLOSE: Terminate a specific sub-agent ===
      case 'close': {
        if (!input.agentName) {
          return rejectAgentAction('close', 'agentName is required for close mode.');
        }
        const targetAgentId = input.agentId || resolveActiveAgentId(input.agentName);
        const closed = closeAgent(context?.projectId, input.agentName, onTrace, targetAgentId);
        return {
          mode: 'close',
          agents: [{ name: input.agentName, agentId: targetAgentId, status: closed ? 'closed' : 'not_running' }],
          message: closed ? `${input.agentName} has been terminated.` : `${input.agentName} is not an active controllable run.`
        };
      }

      default:
        return rejectAgentAction(input.mode, `Unknown mode: ${ input.mode }`);
    }
  }
};
