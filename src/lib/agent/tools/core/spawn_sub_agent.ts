import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { globalSubAgentSpawner, agentMessageBus, SubAgentName, getPendingResults, hasPendingResults } from '../../roles/sub_agent';

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
  description: `Spawn full-power sub-agents for parallel execution, check their status, or collect results.

MODES:
- "spawn": FIRE-AND-FORGET launch. Returns immediately with agent names. Sub-agents run in the background with separate API keys. You MUST continue doing YOUR OWN work after spawning — do NOT wait.
- "status": Check what sub-agents are doing right now. Returns their current progress.
- "collect": Get final results from completed sub-agents. Call this ONLY when you need their output.
- "clear": Clean up completed agent data files.

NAMED AGENTS: Agent-Alpha, Agent-Nova, Agent-Bolt, Agent-Cipher, Agent-Forge, Agent-Pulse, Agent-Nexus, Agent-Arc, Agent-Sentinel, Agent-Echo

CRITICAL WORKFLOW:
1. Call with mode="spawn" — returns instantly with agent names
2. IMMEDIATELY continue YOUR OWN tasks (the whole point is parallel work!)
3. When you need their results, call mode="collect"
4. Merge sub-agent results with your own work for final output

WHEN TO SPAWN: Only when tasks are INDEPENDENT (don't need each other's output). Example: researching topic A while writing code for topic B.
WHEN TO USE CONSENSUS: For high-stakes analysis (stock comparison, security audits, strategic decisions). Spawns 3 agents with different cognitive lenses (Optimist/Skeptic/Realist) to eliminate bias.
IMPORTANT: After spawning, you MUST immediately start working on your own tasks. Do NOT call mode="status" in a loop — just keep working and collect when ready.`,
  category: 'core',
  inputSchema: z.object({
    mode: z.enum(['spawn', 'status', 'collect', 'clear', 'consensus'])
      .describe('spawn = fire-and-forget launch, status = check progress, collect = get results, clear = cleanup, consensus = 3-agent debate panel for high-stakes analysis'),
    tasks: z.array(z.object({
      task: z.string().describe('Detailed task description for this sub-agent'),
      name: z.string().optional().describe('Optional agent name (auto-assigned if not provided)')
    })).optional().describe('Array of tasks for spawn mode'),
    agentName: z.string().optional().describe('Specific agent name to check status/collect for (or omit for all)')
  }),
  outputSchema: z.object({
    mode: z.string(),
    agents: z.array(z.any()),
    message: z.string()
  }),
  execute: async (input: {
    mode: string,
    tasks?: Array<{ task: string, name?: string }>,
    agentName?: string
  }, context: any) => {
    // Extract the UI trace callback from context (injected by gemini.ts)
    const onTrace = context?._onTrace as ((t: any) => void) | undefined;

    switch (input.mode) {
      // ═══ SPAWN: Fire-and-forget launch ═══
      case 'spawn': {
        if (!input.tasks || input.tasks.length === 0) {
          return { mode: 'spawn', agents: [], message: 'ERROR: No tasks provided. Pass tasks array with {task, name?} objects.' };
        }

        const taskList = input.tasks.map(t => ({
          task: t.task,
          name: t.name as SubAgentName | undefined
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
          if (!status) {
            return { mode: 'status', agents: [], message: `No status found for ${ input.agentName }` };
          }
          return {
            mode: 'status',
            agents: [{
              name: input.agentName,
              status: status.status,
              progress: status.progress,
              task: status.task,
              recentActions: status.traceLog?.slice(-5) || []
            }],
            message: `${ input.agentName }: ${ status.status } — ${ status.progress || 'working...' }`
          };
        }

        // Check for queued results first
        const queuedCount = hasPendingResults(context?.projectId) ? 'Some agents have finished — call "collect" to get results.' : '';
        
        const allStatuses = await agentMessageBus.readAllStatuses(context?.projectId);
        const agents = Object.entries(allStatuses).map(([name, data]: [string, any]) => ({
          name: data.agentName || name,
          status: data.status,
          progress: data.progress,
          task: data.task?.substring(0, 80),
          recentActions: data.traceLog?.slice(-3) || []
        }));

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
        // First wait for this chat's background agents to finish.
        await globalSubAgentSpawner.waitForAll(context?.projectId);
        
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

      default:
        return { mode: input.mode, agents: [], message: `Unknown mode: ${ input.mode }` };
    }
  }
};
