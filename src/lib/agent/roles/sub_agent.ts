import { ProjectContext, SubAgent } from '../schemas';
import path from 'path';
import fs from 'fs-extra';
import { apiKeyPool, KeyLease } from '../api-key-pool';

/**
 * Sub-Agent Spawner v5 — Parallel API Keys, Fire-and-Forget, Non-Blocking
 * 
 * v5 Critical upgrades:
 * - KEY ISOLATION: Each sub-agent gets its own GeminiAgentClient with a DIFFERENT
 *   API key offset, so parallel agents never collide on rate limits.
 * - FIRE-AND-FORGET SPAWN: spawnParallel returns immediately with agent names.
 *   The main agent continues working while sub-agents run in the background.
 * - RESULT QUEUE: Sub-agent results are silently queued until main agent calls 'collect'.
 * - NO ANSWER POLLUTION: Sub-agents never emit 'answer' type events — only 'sub_agent_result'.
 *   This prevents the typewriter animation from replaying when a sub-agent finishes.
 * - Global cancellation flag: user "stop" kills all sub-agents immediately.
 */

const AGENT_NAMES = [
  'Dave', 'Nova', 'Sam', 'Kai', 'Alex',
  'Mira', 'Leo', 'Zara', 'Finn', 'Ivy',
  'Max', 'Luna', 'Ash', 'Jade', 'Cole',
  'Aria', 'Rex', 'Sage', 'Blake', 'Sky'
] as const;

export type SubAgentName = typeof AGENT_NAMES[number];

const AGENTS_DIR = path.resolve(process.cwd(), '.workspaces', 'agents');

// === PER-CHAT CANCELLATION FLAGS ===
// Each chat has its own cancel flag. Stopping one chat doesn't kill another.
const cancelFlags: Map<string, boolean> = new Map();
let globalCancelFlag = false; // Emergency stop for ALL agents

/**
 * Cancel agents for a specific chat only.
 */
export function cancelAgent(chatId: string) {
  cancelFlags.set(chatId, true);
  console.log(`[SubAgent] 🛑 Cancel flag set for chat ${chatId.substring(0, 8)}...`);
}

/**
 * Emergency stop — cancel ALL agents across all chats.
 */
export function cancelAllSubAgents() {
  globalCancelFlag = true;
  for (const key of cancelFlags.keys()) {
    cancelFlags.set(key, true);
  }
  console.log('[SubAgent] 🛑 GLOBAL CANCEL — all sub-agents stopping');
}

/**
 * Reset cancel flag for a specific chat (called when starting a new task).
 * If no chatId provided, resets EVERYTHING including the global emergency flag.
 */
export function resetCancelFlag(chatId?: string) {
  if (chatId) {
    cancelFlags.set(chatId, false);
    // Also reset global flag if it was set — emergency is over if we're starting new work
    if (globalCancelFlag) {
      globalCancelFlag = false;
      console.log('[SubAgent] 🔄 Global cancel flag auto-cleared (new work started)');
    }
  } else {
    globalCancelFlag = false;
    cancelFlags.clear();
    console.log('[SubAgent] 🔄 All cancel flags cleared');
  }
}

/**
 * Check if a specific chat is cancelled.
 * CRITICAL: Does NOT check globalCancelFlag during normal operation.
 * Global flag is ONLY for emergency app shutdown — never for per-chat stops.
 * This prevents stopping Chat A from killing agents in Chat B.
 */
export function isCancelled(chatId?: string): boolean {
  if (chatId) return cancelFlags.get(chatId) === true;
  // Only return true for global if no chatId specified (legacy callers)
  return globalCancelFlag;
}

/**
 * Agent-to-Agent Message Bus
 */
class AgentMessageBus {
  async ensureDir() {
    await fs.ensureDir(AGENTS_DIR);
  }

  private statusFilePath(agentName: string, projectId?: string): string {
    const safeName = agentName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const safeProject = projectId ? `${projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}_` : '';
    return path.join(AGENTS_DIR, `${safeProject}${safeName}.json`);
  }

  async writeAgentStatus(agentName: string, data: {
    status: string;
    task: string;
    progress?: string;
    result?: string;
    traceLog?: string[];
    startedAt: number;
    completedAt?: number;
  }, projectId?: string) {
    await this.ensureDir();
    const filePath = this.statusFilePath(agentName, projectId);
    await fs.writeJson(filePath, { ...data, projectId, agentName, updatedAt: Date.now() }, { spaces: 2 });
  }

  async readAgentStatus(agentName: string, projectId?: string): Promise<any | null> {
    const filePath = this.statusFilePath(agentName, projectId);
    if (await fs.pathExists(filePath)) {
      return await fs.readJson(filePath);
    }
    return null;
  }

  async readAllStatuses(projectId?: string): Promise<Record<string, any>> {
    await this.ensureDir();
    const files = await fs.readdir(AGENTS_DIR);
    const statuses: Record<string, any> = {};
    const safeProjectPrefix = projectId ? `${projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}_` : '';
    for (const file of files) {
      if (file.endsWith('.json')) {
        if (projectId && !file.startsWith(safeProjectPrefix)) continue;
        try {
          const data = await fs.readJson(path.join(AGENTS_DIR, file));
          statuses[file.replace('.json', '')] = data;
        } catch { }
      }
    }
    return statuses;
  }

  async clearAll(projectId?: string) {
    if (await fs.pathExists(AGENTS_DIR)) {
      if (!projectId) {
        await fs.emptyDir(AGENTS_DIR);
        return;
      }
      const safeProjectPrefix = `${projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}_`;
      const files = await fs.readdir(AGENTS_DIR);
      await Promise.all(files
        .filter((file) => file.endsWith('.json') && file.startsWith(safeProjectPrefix))
        .map((file) => fs.remove(path.join(AGENTS_DIR, file))));
    }
  }
}

export const agentMessageBus = new AgentMessageBus();

interface SubAgentInstance {
  id: string;
  name: SubAgentName;
  task: string;
  deepBrief: string;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  traceLog: string[];
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  promise?: Promise<any>;
}

// === RESULT QUEUE: Sub-agent results are silently queued here ===
type PendingSubAgentResult = { projectId: string, name: SubAgentName, result: string, success: boolean, durationMs: number };
type BackgroundSubAgentRun = { projectId: string, name: SubAgentName, promise: Promise<any> };

const pendingResults: Map<string, PendingSubAgentResult> = new Map();

function queuePendingResult(result: PendingSubAgentResult) {
  const runKey = `${ result.projectId }:${ result.name }:${ Date.now() }:${ Math.random().toString(36).slice(2) }`;
  pendingResults.set(runKey, result);
}

export function getPendingResults(projectId?: string, agentName?: string): Array<{ name: SubAgentName, result: string, success: boolean, durationMs: number }> {
  const entries = Array.from(pendingResults.entries())
    .filter(([, value]) => (!projectId || value.projectId === projectId) && (!agentName || value.name === agentName));
  for (const [key] of entries) pendingResults.delete(key);
  const results = entries.map(([, value]) => ({
    name: value.name,
    result: value.result,
    success: value.success,
    durationMs: value.durationMs
  }));
  return results;
}

export function hasPendingResults(projectId?: string): boolean {
  if (!projectId) return pendingResults.size > 0;
  return Array.from(pendingResults.values()).some((value) => value.projectId === projectId);
}

export class SubAgentSpawner {
  private activeAgents: Map<string, SubAgentInstance> = new Map();
  private nameIndex: number = 0;
  private backgroundPromises: Map<string, BackgroundSubAgentRun> = new Map();

  private getNextName(): SubAgentName {
    const name = AGENT_NAMES[this.nameIndex % AGENT_NAMES.length];
    this.nameIndex++;
    return name;
  }

  private isAgentName(name?: string): name is SubAgentName {
    return AGENT_NAMES.includes(name as SubAgentName);
  }

  private isNameBusy(projectId: string, name: SubAgentName, reservedNames?: Set<SubAgentName>): boolean {
    if (reservedNames?.has(name)) return true;
    return Array.from(this.backgroundPromises.values())
      .some(run => run.projectId === projectId && run.name === name);
  }

  private resolveAgentName(projectId: string, preferredName?: string, reservedNames?: Set<SubAgentName>): SubAgentName {
    const preferred = this.isAgentName(preferredName) ? preferredName : undefined;
    if (preferred && !this.isNameBusy(projectId, preferred, reservedNames)) {
      return preferred;
    }

    for (let i = 0; i < AGENT_NAMES.length; i++) {
      const candidate = this.getNextName();
      if (!this.isNameBusy(projectId, candidate, reservedNames)) {
        return candidate;
      }
    }

    return preferred || this.getNextName();
  }

  /**
   * Build a LEAN task brief for a sub-agent.
   */
  private buildDeepBrief(task: string, agentName: SubAgentName, parentContext?: string): string {
    return `━━━ ${ agentName } — Sub-Agent Task ━━━
🎯 You are ${ agentName }, a parallel sub-agent on the EterX team. Complete this task independently:

${ task }

RULES:
1. Full tool access. Use workspace_write_file, web_search, system_shell, etc.
2. Work deeply — no shortcuts, no placeholders, no TODOs.
3. NEVER call task_decomposer or spawn_sub_agent — plan internally (3-5 steps max).
4. VERIFY your work with realtime_verify before finishing.
5. When done, output a structured report — do NOT announce completion of the whole project.
6. You are ONE of multiple parallel agents. Your report goes back to the MAIN AGENT for assembly.

REPORT FORMAT:
## ${ agentName } — Complete
**Task:** [what you did]
**Files:** [paths created/modified]
**Key Results:** [findings or deliverables]
**Verified:** [yes/no]

${ parentContext ? `CONTEXT: ${ parentContext }\n` : '' }
EXECUTE NOW.`.trim();
  }

  /**
   * Spawn a single sub-agent with its own API key.
   */
  public async spawnAgent(
    task: string,
    context: ProjectContext,
    _agentIndex: number,
    parentContext?: string,
    onTrace?: (trace: any) => void,
    customName?: SubAgentName
  ): Promise<{ agentId: string, name: SubAgentName, result: string, success: boolean, durationMs: number, traceLog: string[] }> {
    const name = customName || this.getNextName();
    const agentId = `${ name.toLowerCase().replace('-', '_') }_${ Date.now() }`;

    if (isCancelled(context.projectId)) {
      return { agentId, name, result: 'Cancelled by user', success: false, durationMs: 0, traceLog: ['Cancelled before start'] };
    }

    const deepBrief = this.buildDeepBrief(task, name, parentContext);
    const traceLog: string[] = [];

    const instance: SubAgentInstance = {
      id: agentId,
      name,
      task,
      deepBrief,
      status: 'spawning',
      traceLog,
      startedAt: Date.now()
    };
    this.activeAgents.set(agentId, instance);

    await agentMessageBus.writeAgentStatus(name, {
      status: 'running',
      task,
      progress: 'Starting execution...',
      startedAt: instance.startedAt
    }, context.projectId);

    // Emit spawn event to UI — shows the agent tab appearing
    if (onTrace) {
      onTrace({ type: 'command', text: `${ name } spawned`, secondary: task.substring(0, 60), subAgent: name });
    }

    instance.status = 'running';
    let lease: KeyLease | null = null;

    try {
      // Import createIsolatedClient dynamically to avoid circular deps
      const { createIsolatedClient } = await import('../gemini');
      lease = apiKeyPool.leaseSubAgentKey(context.projectId, name);
      if (!lease) throw new Error('No API keys available for sub-agent');
      const subAgentClient = createIsolatedClient(lease.apiKey, 'fast'); // Use fast model for sub-agents
      
      const result = await subAgentClient.executeMessageLoop(
        context,
        deepBrief,
        [],
        (trace) => {
          // Check cancellation on every trace event for this specific chat
          if (isCancelled(context.projectId)) {
            throw new Error('CANCELLED_BY_USER');
          }

          const logEntry = `[${ new Date().toISOString() }] ${ trace.type }: ${ trace.text || '' }${ trace.secondary ? ' | ' + trace.secondary : '' }`;
          traceLog.push(logEntry);

          // Write status every 8th event (reduced disk I/O for speed)
          if (traceLog.length % 8 === 0) {
            agentMessageBus.writeAgentStatus(name, {
              status: 'running',
              task,
              progress: trace.text || 'Working...',
              traceLog: traceLog.slice(-10),
              startedAt: instance.startedAt
            }, context.projectId).catch(() => { });
          }

          // Forward trace to UI with subAgent tag — BUT filter out 'answer' type
          // Sub-agents must NEVER emit 'answer' to the UI or it replays the typewriter
          if (onTrace && trace.type !== 'answer') {
            onTrace({
              ...trace,
              text: trace.text,
              subAgent: name
            });
          }
        }
      );

      const durationMs = Date.now() - instance.startedAt;
      instance.status = 'completed';
      instance.result = result.text;
      instance.completedAt = Date.now();
      instance.durationMs = durationMs;

      await agentMessageBus.writeAgentStatus(name, {
        status: 'completed',
        task,
        progress: 'Done',
        result: result.text,
        traceLog,
        startedAt: instance.startedAt,
        completedAt: instance.completedAt
      }, context.projectId);

      console.log(`[${ name }] ✅ Done ${ (durationMs / 1000).toFixed(1) }s`);

      // Queue result silently — main agent picks it up via 'collect'
      queuePendingResult({ projectId: context.projectId, name, result: result.text, success: true, durationMs });
      apiKeyPool.reportSuccess(`${context.projectId}_sub_${name}`);

      if (onTrace) {
        // Emit ONLY 'sub_agent_result' — NEVER 'answer'
        onTrace({
          type: 'sub_agent_result',
          text: `${ name } finished: ${ result.text.substring(0, 200) }`,
          subAgent: name,
          fullResult: result.text,
          durationMs,
          traceLog: traceLog.slice(-5)
        });
      }

      return { agentId, name, result: result.text, success: true, durationMs, traceLog };
    } catch (error: any) {
      const durationMs = Date.now() - instance.startedAt;
      const wasCancelled = error.message === 'CANCELLED_BY_USER' || isCancelled(context.projectId);
      if (!wasCancelled && lease) {
        apiKeyPool.reportFailure(`${context.projectId}_sub_${name}`, apiKeyPool.classifyError(error.message || ''), error.message || '');
      }

      instance.status = wasCancelled ? 'cancelled' : 'failed';
      instance.result = wasCancelled ? 'Cancelled by user' : error.message;
      instance.completedAt = Date.now();
      instance.durationMs = durationMs;

      await agentMessageBus.writeAgentStatus(name, {
        status: wasCancelled ? 'cancelled' : 'failed',
        task,
        progress: wasCancelled ? 'Cancelled' : `Failed: ${ error.message }`,
        result: instance.result,
        traceLog,
        startedAt: instance.startedAt,
        completedAt: instance.completedAt
      }, context.projectId);

      if (onTrace) {
        onTrace({
          type: wasCancelled ? 'command' : 'safety_warning',
          text: `${ name } ${ wasCancelled ? 'cancelled' : 'failed' }`,
          secondary: wasCancelled ? 'Stopped by user' : error.message.substring(0, 60),
          subAgent: name
        });
      }

      return { agentId, name, result: instance.result!, success: false, durationMs, traceLog };
    } finally {
      apiKeyPool.releaseSubAgentKey(context.projectId, name);
    }
  }

  /**
   * FIRE-AND-FORGET: Spawn multiple sub-agents in TRUE PARALLEL.
   * Returns IMMEDIATELY with agent names. Main agent continues working.
   * Sub-agents run in the background with their own API keys.
   * Main agent calls 'collect' later to get results.
   */
  public spawnParallelFireAndForget(
    tasks: Array<{ task: string, name?: SubAgentName }>,
    context: ProjectContext,
    parentContext?: string,
    onTrace?: (trace: any) => void
  ): { agentNames: string[], message: string } {
    // Reset cancel flag ONLY for this chat at start of parallel spawn
    resetCancelFlag(context.projectId);

    const teamSize = tasks.length;
    const reservedNames = new Set<SubAgentName>();
    const agentNames = tasks.map((t) => {
      const name = this.resolveAgentName(context.projectId, t.name, reservedNames);
      reservedNames.add(name);
      return name;
    });

    if (onTrace) {
      onTrace({
        type: 'command',
        text: `Spawning ${ teamSize } parallel agents`,
        secondary: agentNames.join(' + '),
        spawnedAgents: agentNames
      });
    }

    // Launch all agents in parallel — each with a staggered start and different API key
    tasks.forEach((t, index) => {
      const name = agentNames[index];
      const runKey = `${ context.projectId }:${ name }:${ Date.now() }:${ index }`;

      // Fire-and-forget: start without awaiting
      const promise = (async () => {
        if (isCancelled(context.projectId)) return;
        
        // Minimal stagger: 500ms (was 2s) — each agent has its own key, minimal collision risk
        if (index > 0) {
          await new Promise(r => setTimeout(r, index * 500));
          if (isCancelled(context.projectId)) return;
        }

        await this.spawnAgent(t.task, context, index, parentContext, onTrace, name);
      })()
        .catch((error) => {
          console.error(`[SubAgent] Background run failed for ${ name }:`, error);
        })
        .finally(() => {
          this.backgroundPromises.delete(runKey);
        });

      this.backgroundPromises.set(runKey, { projectId: context.projectId, name, promise });
    });

    return {
      agentNames,
      message: `${ teamSize } agents spawned and working in background. Continue YOUR work now. Call spawn_sub_agent with mode="collect" when you need their results.`
    };
  }

  /**
   * BLOCKING: Spawn multiple sub-agents and WAIT for all to complete.
   * Use this only when the main agent needs all results before continuing.
   */
  public async spawnParallel(
    tasks: Array<{ task: string, name?: SubAgentName }>,
    context: ProjectContext,
    parentContext?: string,
    onTrace?: (trace: any) => void
  ): Promise<{
    results: Array<{ name: SubAgentName, result: string, success: boolean, durationMs: number }>,
    totalDurationMs: number,
    successCount: number,
    failCount: number
  }> {
    resetCancelFlag(context.projectId);

    const startTime = Date.now();

    if (onTrace) {
      const spawnedAgents = tasks.map((t, i) => t.name || AGENT_NAMES[i % AGENT_NAMES.length]);
      onTrace({
        type: 'command',
        text: `Spawning ${ tasks.length } parallel agents`,
        secondary: spawnedAgents.join(' + '),
        spawnedAgents: spawnedAgents
      });
    }

    const promises = tasks.map((t, index) => {
      const name = t.name || this.getNextName();
      return new Promise<any>(async (resolve) => {
        if (isCancelled(context.projectId)) {
          resolve({ agentId: '', name, result: 'Cancelled', success: false, durationMs: 0, traceLog: [] });
          return;
        }
        // Minimal stagger: 500ms (was 2s) — each agent has its own key now
        if (index > 0) {
          await new Promise(r => setTimeout(r, index * 500));
          if (isCancelled(context.projectId)) {
            resolve({ agentId: '', name, result: 'Cancelled', success: false, durationMs: 0, traceLog: [] });
            return;
          }
        }
        const result = await this.spawnAgent(t.task, context, index, parentContext, onTrace, name as SubAgentName);
        resolve(result);
      });
    });

    const settled = await Promise.allSettled(promises);
    const totalDurationMs = Date.now() - startTime;

    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') {
        return {
          name: r.value.name,
          result: r.value.result,
          success: r.value.success,
          durationMs: r.value.durationMs
        };
      }
      return {
        name: (tasks[i].name || AGENT_NAMES[i % AGENT_NAMES.length]) as SubAgentName,
        result: (r as PromiseRejectedResult).reason?.message || 'Unknown error',
        success: false,
        durationMs: 0
      };
    });

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    if (onTrace) {
      onTrace({
        type: 'command',
        text: `${ successCount }/${ tasks.length } agents completed`,
        secondary: `${ (totalDurationMs / 1000).toFixed(1) }s total`
      });
    }

    return { results, totalDurationMs, successCount, failCount };
  }

  /**
   * Wait for all background (fire-and-forget) agents to finish.
   */
  public async waitForAll(projectId?: string): Promise<void> {
    const entries = Array.from(this.backgroundPromises.entries())
      .filter(([, run]) => !projectId || run.projectId === projectId);

    await Promise.allSettled(entries.map(([, run]) => run.promise));

    for (const [runKey, run] of entries) {
      if (!projectId || run.projectId === projectId) {
        this.backgroundPromises.delete(runKey);
      }
    }
  }

  /**
   * Check how many agents are still running in the background.
   */
  public getBackgroundCount(projectId?: string): number {
    if (!projectId) return this.backgroundPromises.size;
    return Array.from(this.backgroundPromises.values())
      .filter(run => run.projectId === projectId).length;
  }

  public getAgentStatus(): SubAgentInstance[] {
    return Array.from(this.activeAgents.values());
  }

  public getAgentNames(): readonly string[] {
    return AGENT_NAMES;
  }

  public clearCompleted(): void {
    for (const [id, agent] of this.activeAgents) {
      if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
        this.activeAgents.delete(id);
      }
    }
  }

  /**
   * MULTI-AGENT CONSENSUS MODE
   * 
   * Spawns 3 agents with different cognitive "lenses" to approach the SAME task:
   * - Agent-Alpha (Optimist): Focuses on opportunities, best-case scenarios, positive outcomes
   * - Agent-Nova (Skeptic): Focuses on risks, edge cases, what could go wrong
   * - Agent-Bolt (Realist): Focuses on practical execution, real constraints, balanced view
   * 
   * The main agent then synthesizes their outputs into a consensus answer,
   * eliminating hallucination and single-perspective bias.
   * 
   * Use for: high-stakes analysis, financial decisions, security audits, strategic planning.
   */
  public async spawnConsensus(
    task: string,
    context: ProjectContext,
    onTrace?: (trace: any) => void
  ): Promise<{
    perspectives: Array<{ perspective: string, agent: string, result: string, success: boolean }>,
    synthesisPrompt: string,
    totalDurationMs: number
  }> {
    const perspectives = [
      {
        name: 'Dave' as SubAgentName,
        lens: 'OPTIMIST',
        brief: `You are Dave, the OPTIMIST on the team. Approach this task with a focus on OPPORTUNITIES, best-case outcomes, strengths, and positive potential. Highlight what COULD go well and why.

TASK: ${task}

Your analysis should cover the optimistic angle: growth potential, advantages, strengths, positive trends, best-case scenarios. Be thorough but maintain your optimistic lens. Back your points with evidence.`
      },
      {
        name: 'Nova' as SubAgentName,
        lens: 'SKEPTIC', 
        brief: `You are Nova, the SKEPTIC on the team. Approach this task with a focus on RISKS, edge cases, weaknesses, and what could go wrong. Challenge assumptions and look for hidden problems.

TASK: ${task}

Your analysis should cover the skeptical angle: risks, weaknesses, threats, negative trends, worst-case scenarios, hidden costs. Be thorough and honest. Don't be contrarian for its own sake — identify REAL risks with evidence.`
      },
      {
        name: 'Sam' as SubAgentName,
        lens: 'REALIST',
        brief: `You are Sam, the REALIST on the team. Approach this task with a focus on PRACTICAL EXECUTION, real constraints, balanced trade-offs, and actionable recommendations.

TASK: ${task}

Your analysis should cover the realistic angle: practical constraints, balanced assessment, implementation challenges, realistic timelines, and concrete action items. Weigh both pros and cons fairly. Focus on what's actually achievable.`
      }
    ];

    if (onTrace) {
      onTrace({
        type: 'command',
        text: 'Spawning 3-agent consensus panel',
        secondary: 'Optimist + Skeptic + Realist',
        spawnedAgents: perspectives.map(p => p.name)
      });
    }

    const startTime = Date.now();

    const results = await this.spawnParallel(
      perspectives.map(p => ({ task: p.brief, name: p.name })),
      context,
      `This is a CONSENSUS PANEL analysis. You are the ${perspectives[0].lens} lens.`,
      onTrace
    );

    const perspectiveResults = results.results.map((r, i) => ({
      perspective: perspectives[i].lens,
      agent: perspectives[i].name,
      result: r.result,
      success: r.success
    }));

    // Build synthesis prompt for the main agent
    const synthesisPrompt = `━━━ MULTI-AGENT CONSENSUS RESULTS ━━━

Three independent agents analyzed this task from different perspectives. Synthesize their findings into a UNIFIED, balanced answer.

ORIGINAL TASK: "${task}"

📗 OPTIMIST (${perspectives[0].name}):
${perspectiveResults[0]?.result || 'No result'}

📕 SKEPTIC (${perspectives[1].name}):
${perspectiveResults[1]?.result || 'No result'}

📘 REALIST (${perspectives[2].name}):
${perspectiveResults[2]?.result || 'No result'}

━━━ YOUR JOB ━━━
Synthesize these three perspectives into ONE definitive, balanced answer. 
- Where all three agree → HIGH CONFIDENCE facts
- Where optimist and skeptic disagree → present BOTH sides with the realist's take as tiebreaker
- Highlight KEY RISKS the skeptic found that others missed
- Highlight KEY OPPORTUNITIES the optimist found that others missed
- End with ACTIONABLE RECOMMENDATIONS from the realist perspective

Do NOT just list what each agent said. SYNTHESIZE into a cohesive analysis.`;

    return {
      perspectives: perspectiveResults,
      synthesisPrompt,
      totalDurationMs: Date.now() - startTime
    };
  }

  /**
   * MULTI-ROUND DEBATE PROTOCOL (Consensus v2)
   * 
   * Unlike basic consensus which runs 3 agents once, debate runs MULTIPLE ROUNDS:
   * Round 1: Each agent independently analyzes the task
   * Round 2: Each agent reads the others' analysis and writes REBUTTALS
   * Round 3: A synthesis agent resolves disagreements with confidence scores
   * 
   * This catches blind spots that single-round consensus misses, because
   * agents can challenge each other's assumptions.
   * 
   * Use for: high-stakes decisions, security audits, financial analysis
   */
  public async spawnDebate(
    task: string,
    context: ProjectContext,
    onTrace?: (trace: any) => void
  ): Promise<{
    rounds: Array<{ round: number; results: Array<{ agent: string; result: string }> }>;
    synthesis: string;
    totalDurationMs: number;
    confidenceScore: number;
  }> {
    const startTime = Date.now();
    const rounds: Array<{ round: number; results: Array<{ agent: string; result: string }> }> = [];

    if (onTrace) {
      onTrace({
        type: 'command',
        text: 'Initiating multi-round debate protocol',
        secondary: 'Round 1: Independent Analysis → Round 2: Cross-Rebuttal → Synthesis'
      });
    }

    // === ROUND 1: Independent Analysis ===
    const round1 = await this.spawnParallel(
      [
        { task: `[DEBATE ROUND 1 - ANALYSIS] Analyze this task independently and thoroughly:\n\n${task}\n\nProvide your complete analysis with evidence. Be specific and detailed.`, name: 'Dave' as SubAgentName },
        { task: `[DEBATE ROUND 1 - ANALYSIS] Analyze this task independently and thoroughly:\n\n${task}\n\nProvide your complete analysis with evidence. Be specific and detailed.`, name: 'Nova' as SubAgentName },
      ],
      context,
      'Debate Round 1: Independent analysis. Be thorough.',
      onTrace
    );

    rounds.push({
      round: 1,
      results: round1.results.map(r => ({ agent: r.name, result: r.result }))
    });

    const r1Dave = round1.results[0]?.result || 'No result';
    const r1Nova = round1.results[1]?.result || 'No result';

    // === ROUND 2: Cross-Rebuttal ===
    if (onTrace) {
      onTrace({ type: 'command', text: 'Debate Round 2: Cross-Rebuttal', secondary: 'Agents challenge each other\'s findings' });
    }

    const round2 = await this.spawnParallel(
      [
        { 
          task: `[DEBATE ROUND 2 - REBUTTAL] 
ORIGINAL TASK: ${task}

YOUR ANALYSIS (Round 1): ${r1Dave.substring(0, 2000)}

OPPONENT'S ANALYSIS (Round 1): ${r1Nova.substring(0, 2000)}

Now REBUT the opponent's analysis:
1. What did they get WRONG? Provide evidence.
2. What did they MISS that you covered?
3. What points do you CONCEDE they got right?
4. What is your REVISED position after seeing their analysis?`,
          name: 'Dave' as SubAgentName 
        },
        { 
          task: `[DEBATE ROUND 2 - REBUTTAL]
ORIGINAL TASK: ${task}

YOUR ANALYSIS (Round 1): ${r1Nova.substring(0, 2000)}

OPPONENT'S ANALYSIS (Round 1): ${r1Dave.substring(0, 2000)}

Now REBUT the opponent's analysis:
1. What did they get WRONG? Provide evidence.
2. What did they MISS that you covered?
3. What points do you CONCEDE they got right?
4. What is your REVISED position after seeing their analysis?`,
          name: 'Nova' as SubAgentName 
        },
      ],
      context,
      'Debate Round 2: Challenge the other agent\'s findings.',
      onTrace
    );

    rounds.push({
      round: 2,
      results: round2.results.map(r => ({ agent: r.name, result: r.result }))
    });

    // === SYNTHESIS: Calculate consensus and confidence ===
    const r2Dave = round2.results[0]?.result || '';
    const r2Nova = round2.results[1]?.result || '';

    // Confidence estimation based on agreement patterns
    const concessions = [r2Dave, r2Nova].filter(r => 
      r.toLowerCase().includes('concede') || r.toLowerCase().includes('agree') || r.toLowerCase().includes('correct')
    ).length;
    const confidenceScore = Math.min(0.95, 0.5 + (concessions * 0.15) + (round1.successCount === 2 ? 0.1 : 0));

    const synthesis = `━━━ MULTI-ROUND DEBATE RESULTS (Confidence: ${(confidenceScore * 100).toFixed(0)}%) ━━━

ORIGINAL TASK: "${task}"

📗 ROUND 1 — Independent Analyses:
Dave: ${r1Dave.substring(0, 1500)}

Nova: ${r1Nova.substring(0, 1500)}

📕 ROUND 2 — Cross-Rebuttals:
Dave's Rebuttal: ${r2Dave.substring(0, 1000)}

Nova's Rebuttal: ${r2Nova.substring(0, 1000)}

━━━ SYNTHESIZE ━━━
Create a definitive answer that:
- Incorporates CONCEDED points (both agents agreed)
- Resolves DISPUTED points with evidence
- Highlights remaining UNCERTAINTIES
- Provides a CONFIDENCE SCORE for each major conclusion
- Ends with ACTIONABLE recommendations

Confidence threshold: ${(confidenceScore * 100).toFixed(0)}% — ${confidenceScore > 0.75 ? 'HIGH confidence synthesis' : 'Include caveats for low-confidence claims'}`;

    return {
      rounds,
      synthesis,
      totalDurationMs: Date.now() - startTime,
      confidenceScore,
    };
  }

  /**
   * SPECIALIST AGENT ROLES — Pre-configured expert profiles
   * 
   * Instead of generic sub-agents, these are deeply specialized agents
   * with domain-specific system prompts, tool preferences, and quality criteria.
   */
  public async spawnSpecialist(
    role: 'security_auditor' | 'performance_analyst' | 'architect' | 'qa_tester' | 'researcher',
    task: string,
    context: ProjectContext,
    onTrace?: (trace: any) => void
  ): Promise<{ name: string; result: string; success: boolean; durationMs: number; confidence: number }> {

    const specialistProfiles: Record<string, { name: SubAgentName; systemBrief: string; toolHints: string[] }> = {
      security_auditor: {
        name: 'Mira' as SubAgentName,
        systemBrief: `You are Mira, a SECURITY SPECIALIST. Your sole focus is identifying vulnerabilities, attack vectors, and security risks. You think like an attacker.
        
METHODOLOGY:
1. Check for injection vulnerabilities (SQL, XSS, command injection)
2. Analyze authentication and authorization flows
3. Check for secrets/credentials in code or config
4. Identify insecure dependencies
5. Check for CORS, CSRF, and header security issues
6. Analyze data validation and sanitization
7. Check for information disclosure

OUTPUT: Severity-rated findings (CRITICAL/HIGH/MEDIUM/LOW) with exact file locations and fix recommendations.`,
        toolHints: ['workspace_read_file', 'workspace_search_text', 'code_intelligence', 'system_shell']
      },
      performance_analyst: {
        name: 'Leo' as SubAgentName,
        systemBrief: `You are Leo, a PERFORMANCE SPECIALIST. Your focus is identifying bottlenecks, memory leaks, and optimization opportunities.
        
METHODOLOGY:
1. Analyze algorithmic complexity (O(n²) patterns, unnecessary loops)
2. Check for memory leaks (unclosed streams, event listener accumulation)
3. Identify N+1 query patterns and database inefficiencies
4. Check bundle sizes and lazy loading opportunities
5. Analyze caching strategies and cache invalidation
6. Profile CPU-intensive operations
7. Check for blocking I/O in async contexts

OUTPUT: Performance findings with impact estimates (ms saved, memory freed) and optimization code.`,
        toolHints: ['workspace_read_file', 'code_intelligence', 'system_shell', 'workspace_search_text']
      },
      architect: {
        name: 'Kai' as SubAgentName,
        systemBrief: `You are Kai, an ARCHITECTURE SPECIALIST. Your focus is design patterns, system structure, and long-term maintainability.
        
METHODOLOGY:
1. Analyze module boundaries and separation of concerns
2. Check for circular dependencies
3. Evaluate state management patterns
4. Assess error handling consistency
5. Review API contract design
6. Analyze scalability constraints
7. Check for anti-patterns (god objects, spaghetti code, tight coupling)

OUTPUT: Architecture assessment with diagrams (mermaid), specific refactoring recommendations, and migration paths.`,
        toolHints: ['workspace_list_directory', 'workspace_read_file', 'code_intelligence', 'workspace_analyze']
      },
      qa_tester: {
        name: 'Zara' as SubAgentName,
        systemBrief: `You are Zara, a QA TESTING SPECIALIST. Your focus is finding bugs, edge cases, and writing comprehensive tests.
        
METHODOLOGY:
1. Identify untested code paths
2. Find edge cases in input validation
3. Test error handling paths
4. Check for race conditions in async code
5. Verify API response contracts
6. Test boundary conditions
7. Write actual test code (Jest/Vitest)

OUTPUT: Bug report with reproduction steps, test files created, and coverage analysis.`,
        toolHints: ['workspace_read_file', 'workspace_write_file', 'system_shell', 'workspace_verify_code']
      },
      researcher: {
        name: 'Sage' as SubAgentName,
        systemBrief: `You are Sage, a DEEP RESEARCH SPECIALIST. Your focus is thorough, evidence-based research with source verification.
        
METHODOLOGY:
1. Search multiple sources for diverse perspectives
2. Cross-reference claims across sources
3. Identify primary sources vs secondary reporting
4. Check publication dates for currency
5. Evaluate source credibility
6. Synthesize findings into structured analysis
7. Highlight conflicting information

OUTPUT: Research report with cited sources, confidence levels per claim, and areas needing further investigation.`,
        toolHints: ['web_search', 'web_scraper', 'deep_research']
      }
    };

    const profile = specialistProfiles[role];
    if (!profile) throw new Error(`Unknown specialist role: ${role}`);

    const specialistBrief = `${profile.systemBrief}\n\n━━━ TASK ━━━\n${task}\n\nPrioritize tools: ${profile.toolHints.join(', ')}\nExecute thoroughly. No shortcuts.`;

    if (onTrace) {
      onTrace({
        type: 'command',
        text: `Deploying ${role.replace('_', ' ')} specialist: ${profile.name}`,
        secondary: task.substring(0, 60),
        subAgent: profile.name
      });
    }

    const result = await this.spawnAgent(
      specialistBrief,
      context,
      0,
      `Specialist role: ${role}`,
      onTrace,
      profile.name
    );

    // Estimate confidence based on tool usage and completion
    const toolsUsed = result.traceLog.filter(l => l.includes('tool_call') || l.includes('action')).length;
    const confidence = Math.min(0.95, 0.4 + (toolsUsed * 0.05) + (result.success ? 0.2 : 0));

    return {
      name: profile.name,
      result: result.result,
      success: result.success,
      durationMs: result.durationMs,
      confidence
    };
  }
}

export const globalSubAgentSpawner = new SubAgentSpawner();
