import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { globalSubAgentSpawner, agentMessageBus, SubAgentName, clearPendingResults, getPendingResults, hasPendingResults, pauseAgent, resumeAgent, closeAgent } from '../../roles/sub_agent';
import { interAgentMailbox } from '../../roles/inter_agent_comm';
import { buildSubAgentStrategy, type SpecialistRole } from '../../roles/sub_agent_strategy';
import { enforceToolCapability } from '../security/tool_policy';
import { MODEL_PROVIDER_ORDER } from '../../model-selector-store';
import type { MainAgentMode, MainAgentProvider } from '../../model-routing';
import { MAX_SUB_AGENTS } from '../../sub-agent-settings';
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
  mode: z.enum(MODEL_MODE_ENUM).optional()
    .describe('Optional provider mode for this worker; otherwise inherit the parent mode'),
  provider: z.enum(MODEL_PROVIDER_ENUM).optional()
    .describe('Optional exact provider; use together with model'),
  model: z.string().min(1).optional().describe('Optional exact model ID; use together with provider'),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    .describe('Optional thinking level for this worker')
}).refine(
  task => Boolean(task.provider) === Boolean(task.model),
  { message: 'provider and model must be provided together' },
);

function buildCollectionPayload(agents: any[], prefix = '') {
  const annotatedAgents = agents.map(agent => {
    const delegationEvidence = assessDelegatedAgent(agent, true);
    return { ...agent, collected: true, delegationEvidence };
  });
  const collection = summarizeDelegationCollection(
    annotatedAgents.map(agent => agent.delegationEvidence),
  );
  return {
    agents: annotatedAgents,
    collection,
    evidenceReady: collection.evidenceReady,
    fullyGrounded: collection.fullyGrounded,
    usableResults: annotatedAgents.filter(agent => agent.delegationEvidence.evidenceReady),
    message: [prefix, formatDelegationCollection(collection)].filter(Boolean).join(' '),
    snapshotOnly: true,
    shouldPoll: false,
    nextRecommendedAction: collection.evidenceReady
      ? 'Synthesize the usable reports with Main work.'
      : 'Continue Main work; workers will hand off automatically when their evidence is ready.',
  };
}

/**
 * Spawn Sub-Agent Tool v2 — Fire-and-Forget Parallel Agent Spawner
 * 
 * KEY CHANGE: "spawn" mode now returns IMMEDIATELY with agent names.
 * The main agent continues working while sub-agents run in the background.
 * Workers hand off automatically; Main collects only when synthesis needs a retained snapshot.
 * 
 * This means the main agent is NEVER blocked waiting for sub-agents.
 * It can do its own work in parallel.
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
- "spawn": FIRE-AND-FORGET launch. Returns immediately with custom task-based names and exact run IDs. Existing workers keep running and new workers fill available concurrent slots. You MUST continue doing YOUR OWN work after spawning — do NOT wait.
- "status": Check what sub-agents are doing right now. Returns their current progress.
- "collect": Get retained, distinct run-ID-based results from completed, failed, or cancelled sub-agents. Call this ONLY when you need their output snapshot; workers also report to Main automatically.
- "consensus": Run a 3-agent Optimist/Skeptic/Realist panel for high-stakes analysis.
- "debate": Run multi-round adversarial analysis for critical tradeoffs, security, financial, or strategic decisions.
- "specialist": Run one deeply profiled specialist: security_auditor, performance_analyst, architect, qa_tester, researcher.
- "pause", "resume", "close": Control a specific running agent.
- "clear": Clean up completed agent data files.

CRITICAL WORKFLOW:
1. If unsure, call mode="advise" with the user request.
2. If spawning, use independent tasks only. Launch with mode="spawn" and continue your own work.
3. Use mode="status" sparingly; do not poll in a loop. Use agent_communicate for direct/team coordination while work continues.
4. Workers automatically hand off to Main. Call mode="collect" when retained distinct results are needed and synthesize them with your own work.
5. Lifecycle is not evidence. Read collection.fullyGrounded and each agent.delegationEvidence. Never infer a finding from started/running/completed status, and never merge a pending, empty, failed, cancelled, or unavailable payload.

WHEN TO SPAWN: 2+ independent parts, each worth meaningful work.
WHEN NOT TO SPAWN: simple tasks, strictly sequential edits, or one shared mutable file that needs careful single-threaded changes.
WHEN TO USE DEBATE: high-stakes choices where assumptions need challenge and rebuttal.
WHEN TO USE SPECIALIST: focused security, performance, architecture, QA, or research tasks.`,
  category: 'core',
  inputSchema: z.object({
    mode: z.enum(['advise', 'spawn', 'status', 'collect', 'clear', 'consensus', 'debate', 'specialist', 'pause', 'resume', 'close'])
      .describe('advise = choose the right orchestration pattern without spawning, spawn = fire-and-forget launch, status = check progress, collect = get results, clear = cleanup, consensus = 3-agent panel, debate = multi-round adversarial panel, specialist = one expert role, pause/resume/close = control an agent'),
    tasks: z.array(SUB_AGENT_TASK_SCHEMA).max(MAX_SUB_AGENTS).optional().describe('Array of tasks for spawn, consensus, debate, or specialist mode'),
    request: z.string().optional().describe('Original user request for advise mode. Falls back to the first task if omitted.'),
    specialistRole: z.enum(SPECIALIST_ROLES).optional().describe('Required for specialist mode.'),
    maxAgents: z.number().int().min(1).max(MAX_SUB_AGENTS).optional().describe('Maximum agents to recommend in advise mode.'),
    agentName: z.string().optional().describe('Specific agent name to check status/collect/control for (or omit for all)'),
    agentId: z.string().optional().describe('Exact run ID for unambiguous status, collection, or control when a task name has been reused')
  }),
  outputSchema: z.object({
    mode: z.string(),
    agents: z.array(z.any()),
    message: z.string(),
    collection: z.any().optional(),
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
    tasks?: Array<{
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
  }, context: any) => {
    if (context?.isUserProxy) {
      if (input.mode !== 'specialist') {
        return { mode: input.mode, agents: [], message: 'User Proxy may only create one temporary specialist.' };
      }
      if (context._userProxyHelperUsed) {
        return { mode: input.mode, agents: [], message: 'User Proxy specialist allowance has already been used.' };
      }
      if (!input.tasks || input.tasks.length !== 1) {
        return { mode: input.mode, agents: [], message: 'User Proxy must provide exactly one focused specialist task.' };
      }
      context._userProxyHelperUsed = true;
    }
    const decision = enforceToolCapability('spawn_sub_agent', input, context);
    if (!decision.allowed) {
      return { mode: input.mode || 'blocked', agents: [], message: decision.reason || 'Sub-agent spawning is not allowed' };
    }

    // Extract the UI trace callback from context (injected by gemini.ts)
    const onTrace = context?._onTrace as ((t: any) => void) | undefined;
    const resolveActiveAgentId = (agentName: string) =>
      globalSubAgentSpawner.findActiveAgentId(context?.projectId, agentName);

    // Status and collect are observations, not a waiting primitive. Suppress an
    // immediate second observation in the same Main turn regardless of which
    // observation mode the model swaps to (collect -> status was a common loop).
    if (input.mode === 'status' || input.mode === 'collect') {
      const now = Date.now();
      const previousObservationAt = Number(context?._lastSubAgentObservationAt || 0);
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
      context._lastSubAgentObservationAt = now;
    }

    switch (input.mode) {
      // === ADVISE: Decide orchestration without spawning ===
      case 'advise': {
        const request = input.request || input.tasks?.[0]?.task || '';
        const strategy = buildSubAgentStrategy(request, { maxAgents: input.maxAgents });
        return {
          mode: 'advise',
          agents: strategy.recommendedAgents,
          message: strategy.shouldSpawn
            ? `Recommended ${strategy.mode} orchestration with ${strategy.estimatedAgentCount} agent(s).`
            : 'Recommended direct main-agent execution.',
          strategy
        };
      }

      // ═══ SPAWN: Fire-and-forget launch ═══
      case 'spawn': {
        if (!input.tasks || input.tasks.length === 0) {
          return { mode: 'spawn', agents: [], message: 'ERROR: No tasks provided. Pass tasks array with {task, name?} objects.' };
        }

        const taskList = input.tasks.map(t => ({
          task: t.task,
          name: t.name as SubAgentName | undefined,
          mode: t.mode,
          provider: t.provider,
          model: t.model,
          thinkingLevel: t.thinkingLevel,
        }));

        const parentContext = `Main agent spawned ${ taskList.length } parallel sub-agents. Each agent works independently on its assigned task. Do NOT mark the full project as complete — you are only doing YOUR assigned part.`;

        // Fire-and-forget: returns immediately
        const { agentNames, agents, notStartedTasks, message } = globalSubAgentSpawner.spawnParallelFireAndForget(
          taskList,
          context,
          parentContext,
          onTrace
        );

        return {
          mode: 'spawn',
          agents: agents.map(agent => ({ ...agent, status: 'spawning' })),
          message: message + '\n\nIMPORTANT: Continue Main work now. Do not wait, narrate a future check, or poll status/collect. Each worker reports automatically; collect a retained snapshot only after a meaningful handoff or when final synthesis actually needs it.',
          shouldPoll: false,
          nextRecommendedAction: 'Continue Main work on independent parts of the request.',
          spawnedAgentNames: agentNames,
          notStartedTasks,
        };
      }

      // ═══ STATUS: Check what sub-agents are doing ═══
      case 'status': {
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
        const queuedCount = hasPendingResults(context?.projectId) ? 'Usable retained reports are available for synthesis.' : '';
        
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

        const agents = Array.from(rosterNames).map((name) => {
          const key = name.toLowerCase();
          const data = statusByName.get(key);
          const presence = teamSnapshot.find(agent => agent.agentName.toLowerCase() === key);
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
          shouldPoll: false,
          nextRecommendedAction: 'Continue Main work; use direct communication only for a concrete coordination need.',
          message: agents.length > 0
            ? `${ agents.length } agents tracked. ${ agents.filter((a: any) => a.status === 'running').length } running, ${ agents.filter((a: any) => a.status === 'completed').length } completed. ${ queuedCount } Do not poll; workers report to Main automatically.`
            : 'No active sub-agents. Do not repeat this status check.'
        };
      }

      // ═══ COLLECT: Get final results from completed sub-agents ═══
      case 'collect': {
        // Collect is a snapshot, not a join barrier. Waiting for every agent
        // made one slow or stuck sub-agent freeze Main even though the response
        // format already supports reporting agents as still running.
        
        if (input.agentName) {
          const queuedResults = getPendingResults(context?.projectId, input.agentName, input.agentId);
          const status = await agentMessageBus.readAgentStatus(input.agentName, context?.projectId);
          const collectionPresence = interAgentMailbox.getTeamSnapshot(context?.projectId || '')
            .find(agent => agent.agentName.toLowerCase() === input.agentName!.toLowerCase() && (!input.agentId || !agent.agentId || agent.agentId === input.agentId));
          const statusMatchesRun = !input.agentId || status?.agentId === input.agentId;
          if (!status || !statusMatchesRun) {
            if (queuedResults.length > 0) {
              const payload = buildCollectionPayload(queuedResults.map(queuedResult => ({
                name: queuedResult.name,
                agentId: queuedResult.agentId,
                subAgentChatId: queuedResult.subAgentChatId,
                status: queuedResult.status,
                result: queuedResult.result,
                traceLog: [],
                task: queuedResult.task,
                durationMs: queuedResult.durationMs,
                completedAt: queuedResult.completedAt,
              })), `${input.agentName}: ${queuedResults.length} queued result(s) returned.`);
              return {
                mode: 'collect',
                ...payload,
              };
            }
            return { mode: 'collect', ...buildCollectionPayload([], `No data found for ${input.agentName}.`) };
          }
          const queuedAgents = queuedResults.map(queuedResult => ({
            name: queuedResult.name,
             agentId: queuedResult.agentId,
             subAgentChatId: queuedResult.subAgentChatId,
             status: queuedResult.status,
             result: queuedResult.result,
             traceLog: [],
             task: queuedResult.task || status.task,
             durationMs: queuedResult.durationMs,
             completedAt: queuedResult.completedAt,
          }));
          const latestStatusAgent = {
            name: input.agentName,
            agentId: status.agentId,
            subAgentChatId: status.subAgentChatId,
            status: collectionPresence?.status || status.status,
            result: status.result || 'No result yet',
            traceLog: status.traceLog || [],
            task: collectionPresence?.task || status.task,
            durationMs: status.completedAt ? status.completedAt - status.startedAt : null,
            completedAt: status.completedAt,
          };
          const collectedAgents = status.agentId && queuedAgents.some(agent => agent.agentId === status.agentId)
            ? queuedAgents
            : [...queuedAgents, latestStatusAgent];
          return {
            mode: 'collect',
            ...buildCollectionPayload(collectedAgents, `${input.agentName}: ${collectedAgents.length} distinct run record(s); latest status ${collectionPresence?.status || status.status}.`),
          };
        }

        // Collect ALL results — from both queue and disk
        const queuedResults = getPendingResults(context?.projectId);
        const agents: any[] = queuedResults.map(queued => ({
          name: queued.name,
          agentId: queued.agentId,
          subAgentChatId: queued.subAgentChatId,
          status: queued.status,
          result: queued.result,
          traceLog: [],
          task: queued.task,
          durationMs: queued.durationMs,
          completedAt: queued.completedAt,
        }));
        const queuedAgentIds = new Set(queuedResults.map(result => result.agentId));
        const queuedLegacyNames = new Set(queuedResults.map(result => result.name.toLowerCase()));
        const allStatuses = await agentMessageBus.readAllStatuses(context?.projectId);
        for (const [name, data] of Object.entries(allStatuses) as Array<[string, any]>) {
          const displayName = data.agentName || name;
          if ((data.agentId && queuedAgentIds.has(data.agentId)) || (!data.agentId && queuedLegacyNames.has(String(displayName).toLowerCase()))) {
            continue;
          }
          agents.push({
            name: displayName,
            agentId: data.agentId,
            subAgentChatId: data.subAgentChatId,
            status: data.status,
            result: data.result || 'No result yet',
            traceLog: data.traceLog || [],
            task: data.task,
            durationMs: data.startedAt
              ? Math.max(0, Number(data.completedAt || Date.now()) - Number(data.startedAt))
              : 0,
            completedAt: data.completedAt,
          });
        }

        const payload = buildCollectionPayload(
          agents,
          `Collected from ${agents.length} delegated agent${agents.length === 1 ? '' : 's'}.`,
        );

        return {
          mode: 'collect',
          ...payload,
          // Compatibility alias, now restricted to semantically usable payloads.
          completedResults: payload.usableResults,
        };
      }

      // ═══ CLEAR: Clean up agent files ═══
      case 'clear': {
        await agentMessageBus.clearAll(context?.projectId);
        if (context?.projectId) await interAgentMailbox.clearProject(context.projectId);
        clearPendingResults(context?.projectId);
        return { mode: 'clear', agents: [], message: 'All sub-agent data cleared.' };
      }

      // ═══ CONSENSUS: 3-Agent Debate Panel ═══
      case 'consensus': {
        if (!input.tasks || input.tasks.length === 0) {
          return { mode: 'consensus', agents: [], message: 'ERROR: No task provided. Pass tasks array with at least one {task} describing the analysis needed.' };
        }

        const consensusTask = input.tasks[0].task; // Use the first task as the consensus topic
        const consensusResult = await globalSubAgentSpawner.spawnConsensus(
          consensusTask,
          context,
          onTrace
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
          return { mode: 'debate', agents: [], message: 'ERROR: No task provided. Pass tasks array with at least one {task} describing the decision or analysis.' };
        }

        const debateResult = await globalSubAgentSpawner.spawnDebate(
          input.tasks[0].task,
          context,
          onTrace
        );

        const payload = buildCollectionPayload(debateResult.rounds.flatMap(round => round.results.map(result => ({
            round: round.round,
            name: result.agent,
            task: `Debate round ${round.round}: ${input.tasks![0].task}`,
            status: 'completed',
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
          return { mode: 'specialist', agents: [], message: `ERROR: specialistRole is required. Use one of: ${SPECIALIST_ROLES.join(', ')}.` };
        }
        if (!input.tasks || input.tasks.length === 0) {
          return { mode: 'specialist', agents: [], message: 'ERROR: No task provided. Pass tasks array with at least one {task}.' };
        }

        const specialistResult = await globalSubAgentSpawner.spawnSpecialist(
          input.specialistRole,
          input.tasks[0].task,
          context,
          onTrace
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
          return { mode: 'pause', agents: [], message: 'ERROR: agentName is required for pause mode.' };
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
          return { mode: 'resume', agents: [], message: 'ERROR: agentName is required for resume mode.' };
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
          return { mode: 'close', agents: [], message: 'ERROR: agentName is required for close mode.' };
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
        return { mode: input.mode, agents: [], message: `Unknown mode: ${ input.mode }` };
    }
  }
};
