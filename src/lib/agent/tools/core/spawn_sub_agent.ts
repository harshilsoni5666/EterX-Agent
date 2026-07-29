import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { globalSubAgentSpawner, agentMessageBus, SubAgentName, getPendingResults, hasPendingResults, pauseAgent, resumeAgent, closeAgent } from '../../roles/sub_agent';
import { interAgentMailbox } from '../../roles/inter_agent_comm';
import { buildSubAgentStrategy, type SpecialistRole } from '../../roles/sub_agent_strategy';
import { enforceToolCapability } from '../security/tool_policy';
import { MODEL_PROVIDER_ORDER } from '../../model-selector-store';
import type { MainAgentMode, MainAgentProvider } from '../../model-routing';

const SPECIALIST_ROLES = ['security_auditor', 'performance_analyst', 'architect', 'qa_tester', 'researcher'] as const;
const MODEL_PROVIDER_ENUM = MODEL_PROVIDER_ORDER as [MainAgentProvider, ...MainAgentProvider[]];
const MODEL_MODE_ENUM = ['think', 'fast', ...MODEL_PROVIDER_ORDER.filter(provider => provider !== 'gemini')] as [MainAgentMode, ...MainAgentMode[]];

/**
 * Spawn Sub-Agent Tool v2 — Fire-and-Forget Parallel Agent Spawner
 * 
 * KEY CHANGE: "spawn" mode now returns IMMEDIATELY with agent names.
 * The main agent continues working while sub-agents run in the background.
 * The main agent calls "collect" later to get results.
 * 
 * This means the main agent is NEVER blocked waiting for sub-agents.
 * It can do its own work in parallel.
 * 
 * MODES:
 * - spawn: Fire-and-forget launch. Returns immediately with agent names.
 * - status: Check what sub-agents are doing right now.
 * - collect: Get results from completed sub-agents (blocks until done).
 * - clear: Clean up completed agent files.
 */
export const spawnSubAgentTool: ToolDefinition = {
  name: 'spawn_sub_agent',
  description: `Spawn full-power sub-agents, ask for orchestration advice, check status, collect results, or run advanced panels.

MODES:
- "advise": Decide whether the current request should stay solo or use parallel agents, consensus, debate, or a specialist. Does not spawn anything.
- "spawn": FIRE-AND-FORGET launch. Returns immediately with agent names. Sub-agents run in the background with separate API keys. You MUST continue doing YOUR OWN work after spawning — do NOT wait.
- "status": Check what sub-agents are doing right now. Returns their current progress.
- "collect": Get final results from completed sub-agents. Call this ONLY when you need their output.
- "consensus": Run a 3-agent Optimist/Skeptic/Realist panel for high-stakes analysis.
- "debate": Run multi-round adversarial analysis for critical tradeoffs, security, financial, or strategic decisions.
- "specialist": Run one deeply profiled specialist: security_auditor, performance_analyst, architect, qa_tester, researcher.
- "pause", "resume", "close": Control a specific running agent.
- "clear": Clean up completed agent data files.

CRITICAL WORKFLOW:
1. If unsure, call mode="advise" with the user request.
2. If spawning, use independent tasks only. Launch with mode="spawn" and continue your own work.
3. Use mode="status" sparingly; do not poll in a loop.
4. Call mode="collect" when results are needed and synthesize them with your own work.

WHEN TO SPAWN: 2+ independent parts, each worth meaningful work.
WHEN NOT TO SPAWN: simple tasks, strictly sequential edits, or one shared mutable file that needs careful single-threaded changes.
WHEN TO USE DEBATE: high-stakes choices where assumptions need challenge and rebuttal.
WHEN TO USE SPECIALIST: focused security, performance, architecture, QA, or research tasks.`,
  category: 'core',
  inputSchema: z.object({
    mode: z.enum(['advise', 'spawn', 'status', 'collect', 'clear', 'consensus', 'debate', 'specialist', 'pause', 'resume', 'close'])
      .describe('advise = choose the right orchestration pattern without spawning, spawn = fire-and-forget launch, status = check progress, collect = get results, clear = cleanup, consensus = 3-agent panel, debate = multi-round adversarial panel, specialist = one expert role, pause/resume/close = control an agent'),
    tasks: z.array(z.object({
      task: z.string().min(1).max(200_000).describe('Detailed task description for this sub-agent'),
      name: z.string().optional().describe('Optional agent name (auto-assigned if not provided)'),
      mode: z.enum(MODEL_MODE_ENUM).optional()
        .describe('Optional provider mode for this worker; otherwise inherit the parent mode'),
      provider: z.enum(MODEL_PROVIDER_ENUM).optional()
        .describe('Optional exact provider; use together with model'),
      model: z.string().min(1).optional().describe('Optional exact model ID; use together with provider'),
      thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
        .describe('Optional thinking level for this worker')
    })).max(20).optional().describe('Array of tasks for spawn, consensus, debate, or specialist mode'),
    request: z.string().optional().describe('Original user request for advise mode. Falls back to the first task if omitted.'),
    specialistRole: z.enum(SPECIALIST_ROLES).optional().describe('Required for specialist mode.'),
    maxAgents: z.number().int().min(1).max(6).optional().describe('Maximum agents to recommend in advise mode.'),
    agentName: z.string().optional().describe('Specific agent name to check status/collect/control for (or omit for all)')
  }),
  outputSchema: z.object({
    mode: z.string(),
    agents: z.array(z.any()),
    message: z.string()
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
    agentName?: string
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
      globalSubAgentSpawner.getAgentStatus()
        .find(agent =>
          agent.projectId === context?.projectId &&
          agent.name === agentName &&
          agent.status !== 'completed' &&
          agent.status !== 'failed' &&
          agent.status !== 'cancelled'
        )?.id;

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
        const { agentNames, message } = globalSubAgentSpawner.spawnParallelFireAndForget(
          taskList,
          context,
          parentContext,
          onTrace
        );

        return {
          mode: 'spawn',
          agents: agentNames.map(name => ({ name, status: 'spawning' })),
          message: message + '\n\nIMPORTANT: You MUST now continue working on YOUR OWN tasks. Do NOT wait or poll for sub-agent status. They will work in the background with their own API keys. Call mode="collect" only when you need their output.',
          spawnedAgentNames: agentNames
        };
      }

      // ═══ STATUS: Check what sub-agents are doing ═══
      case 'status': {
        if (input.agentName) {
          const status = await agentMessageBus.readAgentStatus(input.agentName, context?.projectId);
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
                  status: presence?.status || 'registered',
                  progress: presence?.progress,
                  task: presence?.task,
                  unreadCount: mailboxSummary?.unreadCount || 0,
                  recentActions: []
                }],
                message: `${ input.agentName }: ${ presence?.status || 'registered' }`
              };
            }
            return { mode: 'status', agents: [], message: `No status found for ${ input.agentName }` };
          }
          return {
            mode: 'status',
            agents: [{
              name: input.agentName,
              status: status.status,
              progress: status.progress,
              task: status.task,
              unreadCount: mailboxSummary?.unreadCount || 0,
              recentActions: status.traceLog?.slice(-5) || []
            }],
            message: `${ input.agentName }: ${ status.status } — ${ status.progress || 'working...' }`
          };
        }

        // Check for queued results first
        const queuedCount = hasPendingResults(context?.projectId) ? 'Some agents have finished — call "collect" to get results.' : '';
        
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
            role: presence?.role || (key === 'main' ? 'main' : 'sub_agent'),
            status: data?.status || presence?.status || 'registered',
            progress: data?.progress || presence?.progress,
            task: (data?.task || presence?.task)?.substring(0, 120),
            unreadCount: mailbox?.unreadCount || 0,
            totalMessages: mailbox?.totalCount || 0,
            recentActions: data?.traceLog?.slice(-3) || []
          };
        });

        return {
          mode: 'status',
          agents,
          message: agents.length > 0
            ? `${ agents.length } agents tracked. ${ agents.filter((a: any) => a.status === 'running').length } running, ${ agents.filter((a: any) => a.status === 'completed').length } completed. ${ queuedCount }`
            : 'No active sub-agents.'
        };
      }

      // ═══ COLLECT: Get final results from completed sub-agents ═══
      case 'collect': {
        // Collect is a snapshot, not a join barrier. Waiting for every agent
        // made one slow or stuck sub-agent freeze Main even though the response
        // format already supports reporting agents as still running.
        
        if (input.agentName) {
          const queuedResults = getPendingResults(context?.projectId, input.agentName);
          const queuedResult = queuedResults[0];
          const status = await agentMessageBus.readAgentStatus(input.agentName, context?.projectId);
          if (!status) {
            if (queuedResult) {
              return {
                mode: 'collect',
                agents: [{
                  name: queuedResult.name,
                  status: queuedResult.success ? 'completed' : 'failed',
                  result: queuedResult.result,
                  traceLog: [],
                  task: null,
                  durationMs: queuedResult.durationMs
                }],
                message: `${ input.agentName }: queued result returned.`
              };
            }
            return { mode: 'collect', agents: [], message: `No data found for ${ input.agentName }` };
          }
          return {
            mode: 'collect',
            agents: [{
              name: input.agentName,
              status: queuedResult ? (queuedResult.success ? 'completed' : 'failed') : status.status,
              result: queuedResult?.result || status.result || 'No result yet',
              traceLog: status.traceLog || [],
              task: status.task,
              durationMs: queuedResult?.durationMs ?? (status.completedAt ? status.completedAt - status.startedAt : null)
            }],
            message: `${ input.agentName }: ${ status.status }. Full result and trace log returned.`
          };
        }

        // Collect ALL results — from both queue and disk
        const queuedResults = getPendingResults(context?.projectId);
        const queuedByName = new Map<string, typeof queuedResults>();
        for (const result of queuedResults) {
          const existing = queuedByName.get(result.name) || [];
          existing.push(result);
          queuedByName.set(result.name, existing);
        }

        const allStatuses = await agentMessageBus.readAllStatuses(context?.projectId);
        const agents = Object.entries(allStatuses).map(([name, data]: [string, any]) => {
          const displayName = data.agentName || name;
          const queued = queuedByName.get(displayName)?.shift();
          return {
            name: displayName,
            status: queued ? (queued.success ? 'completed' : 'failed') : data.status,
            result: queued?.result || data.result || 'No result yet',
            traceLog: data.traceLog || [],
            task: data.task,
            durationMs: queued?.durationMs ?? (data.completedAt ? data.completedAt - data.startedAt : null)
          };
        });

        for (const remaining of queuedByName.values()) {
          for (const queued of remaining) {
            agents.push({
              name: queued.name,
              status: queued.success ? 'completed' : 'failed',
              result: queued.result,
              traceLog: [],
              task: null,
              durationMs: queued.durationMs
            });
          }
        }

        const completedAgents = agents.filter((a: any) => a.status === 'completed');

        return {
          mode: 'collect',
          agents,
          message: `Collected from ${ agents.length } agents. ${ completedAgents.length } completed with results. ${ agents.filter((a: any) => a.status === 'running').length } still running.\n\nNow merge these results with your own work to create the final output.`,
          completedResults: completedAgents
        };
      }

      // ═══ CLEAR: Clean up agent files ═══
      case 'clear': {
        await agentMessageBus.clearAll(context?.projectId);
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

        return {
          mode: 'consensus',
          agents: consensusResult.perspectives,
          message: consensusResult.synthesisPrompt,
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

        return {
          mode: 'debate',
          agents: debateResult.rounds.flatMap(round => round.results.map(result => ({
            round: round.round,
            name: result.agent,
            result: result.result
          }))),
          message: debateResult.synthesis,
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

        return {
          mode: 'specialist',
          agents: [{
            role: input.specialistRole,
            name: specialistResult.name,
            status: specialistResult.success ? 'completed' : 'failed',
            result: specialistResult.result,
            durationMs: specialistResult.durationMs,
            confidence: specialistResult.confidence
          }],
          message: `${specialistResult.name} completed ${input.specialistRole.replace(/_/g, ' ')} specialist work.`,
          totalDurationMs: specialistResult.durationMs
        };
      }

      default:
        return { mode: input.mode, agents: [], message: `Unknown mode: ${ input.mode }` };

      // === PAUSE: Pause a specific sub-agent ===
      case 'pause': {
        if (!input.agentName) {
          return { mode: 'pause', agents: [], message: 'ERROR: agentName is required for pause mode.' };
        }
        const paused = pauseAgent(context?.projectId, input.agentName, onTrace, resolveActiveAgentId(input.agentName));
        return {
          mode: 'pause',
          agents: [{ name: input.agentName, status: paused ? 'paused' : 'already_paused' }],
          message: paused ? `${input.agentName} has been paused. Call mode="resume" to continue.` : `${input.agentName} is already paused.`
        };
      }

      // === RESUME: Resume a paused sub-agent ===
      case 'resume': {
        if (!input.agentName) {
          return { mode: 'resume', agents: [], message: 'ERROR: agentName is required for resume mode.' };
        }
        const resumed = resumeAgent(context?.projectId, input.agentName, onTrace, resolveActiveAgentId(input.agentName));
        return {
          mode: 'resume',
          agents: [{ name: input.agentName, status: resumed ? 'working' : 'not_paused' }],
          message: resumed ? `${input.agentName} has been resumed.` : `${input.agentName} was not paused.`
        };
      }

      // === CLOSE: Terminate a specific sub-agent ===
      case 'close': {
        if (!input.agentName) {
          return { mode: 'close', agents: [], message: 'ERROR: agentName is required for close mode.' };
        }
        const closed = closeAgent(context?.projectId, input.agentName, onTrace, resolveActiveAgentId(input.agentName));
        return {
          mode: 'close',
          agents: [{ name: input.agentName, status: 'closed' }],
          message: closed ? `${input.agentName} has been terminated.` : `${input.agentName} close signal sent.`
        };
      }
    }
  }
};
