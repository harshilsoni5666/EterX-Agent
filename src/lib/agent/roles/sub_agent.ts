import { ProjectContext, SubAgent } from '../schemas';
import path from 'path';
import fs from 'fs-extra';
import { apiKeyPool, KeyLease } from '../api-key-pool';
import { interAgentMailbox } from './inter_agent_comm';
import { getEterxWorkspaceDir } from '../storage-paths';
import { stableScopeSegment } from '../context-scope';
import { getMainAgentModelConfig, type MainAgentMode, type MainAgentProvider, type MainAgentThinkingLevel } from '../model-routing';
import { MAX_SUB_AGENTS } from '../sub-agent-settings';
import { assessDelegatedAgent, type DelegatedAgentEvidence } from '../delegation-evidence';
import { getSearchRouteBrief } from '../../search/search-runtime';
import { getImageGenerationRouteBrief } from '../../image/image-generation-runtime';
import { getVideoGenerationRouteBrief } from '../../video/video-generation-runtime';
import { formatUnknownError } from '../error-format';
import { rebaseContextCompactionWindow } from '../model-context-window';
import { swarmCoordinator, SWARM_LIMITS, type SwarmContract } from '../swarm-coordinator';

function boundedHandoffPayload(value: string, maxChars = 20_000): { body: string; truncated: boolean } {
  if (value.length <= maxChars) return { body: value, truncated: false };
  const marker = '\n\n[... middle omitted from automatic handoff; collect by run ID for retained payload ...]\n\n';
  const headChars = Math.floor((maxChars - marker.length) * 0.72);
  const tailChars = maxChars - marker.length - headChars;
  return {
    body: `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`,
    truncated: true,
  };
}

/**
 * Recursive delegated execution over isolated provider clients. The shared
 * coordinator admits task graphs, owns resource claims and schedules readiness;
 * this spawner owns provider capacity, cancellation and retained conversations.
 * Worker reports are retained by task ID and delivered to the delegating parent.
 * Provider/key capacity remains bounded; adding workers is not a speed guarantee.
 */

const TASK_NAME_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'in',
  'into', 'is', 'it', 'of', 'on', 'or', 'our', 'that', 'the', 'their', 'this',
  'to', 'use', 'with', 'work', 'working', 'task', 'agent', 'subagent', 'sub-agent',
  'analyze', 'audit', 'check', 'create', 'deep', 'do', 'ensure', 'file', 'files',
  'fix', 'focus', 'implement', 'inspect', 'make', 'perform', 'read', 'review',
  'source', 'update', 'verify', 'src', 'lib', 'app',
]);
const TASK_NAME_SHORT_TERMS = new Set(['ai', 'api', 'db', 'qa', 'ui', 'ux']);

const taskNameHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6).toUpperCase();
};

const toAgentNameSegment = (value: string): string => {
  if (/^[A-Z0-9]{2,6}$/.test(value)) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
};

const normalizeAgentName = (value: string): string => {
  const segments = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[A-Za-z0-9]+/g)
    ?.filter(Boolean)
    .slice(0, 6) || [];
  return segments.map(toAgentNameSegment).join('-').slice(0, 64).replace(/-+$/g, '');
};

const buildTaskAgentName = (task: string): string => {
  const words = String(task || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .match(/[A-Za-z][A-Za-z0-9]*/g) || [];
  const meaningful: string[] = [];
  for (const word of words) {
    const normalized = word.toLowerCase();
    if ((normalized.length < 3 && !TASK_NAME_SHORT_TERMS.has(normalized)) || TASK_NAME_STOP_WORDS.has(normalized) || meaningful.includes(normalized)) continue;
    meaningful.push(normalized);
    if (meaningful.length === 3) break;
  }
  const workName = normalizeAgentName(meaningful.join(' '));
  return workName || `Task-${taskNameHash(task)}`;
};

export type SubAgentName = string;
export type SubAgentTaskSpec = SwarmContract & {
  task: string;
  name?: SubAgentName;
  mode?: MainAgentMode;
  provider?: MainAgentProvider;
  model?: string;
  thinkingLevel?: MainAgentThinkingLevel;
};

const MAX_PENDING_RESULTS_PER_PROJECT = SWARM_LIMITS.maxNodes;
const MAX_PENDING_RESULTS_TOTAL = SWARM_LIMITS.maxNodes * 4;
const DEFAULT_MAX_SUB_AGENTS = 5;

const getConfiguredSubAgentLimit = (context: ProjectContext): number => {
  const configured = Number((context as any)?.maxSubAgents);
  return Number.isFinite(configured)
    ? Math.min(MAX_SUB_AGENTS, Math.max(1, Math.floor(configured)))
    : DEFAULT_MAX_SUB_AGENTS;
};

type FeedOwnership = {
  ownerChatId?: string;
  runId?: string;
  turnId?: string;
  subAgentTurnId?: string;
};

const resolveFeedOwnership = (context: ProjectContext, subAgentIdentity?: string): FeedOwnership => {
  const runtime = context as any;
  const runId = String(runtime.runId || '').trim();
  const turnId = typeof runtime.getActiveTurnId === 'function'
    ? String(runtime.getActiveTurnId() || '').trim()
    : String(runtime.turnId || runId).trim();
  const identity = String(subAgentIdentity || runtime.subAgentChatId || runtime.subAgentId || '').trim();
  const subAgentTurnId = identity && typeof runtime.getActiveAuxiliaryTurnId === 'function'
    ? String(runtime.getActiveAuxiliaryTurnId(identity) || '').trim()
    : String(runtime.subAgentTurnId || '').trim();
  return {
    ownerChatId: String(runtime.ownerChatId || runtime.projectId || '').trim() || undefined,
    runId: runId || undefined,
    turnId: turnId || runId || undefined,
    subAgentTurnId: subAgentTurnId || (identity ? `subagent-task:${ identity }` : undefined),
  };
};

const AGENTS_DIR = getEterxWorkspaceDir('agents');
const MAX_SUB_AGENT_TRACE_LOGS = 400;
const SUB_AGENT_STATUS_WRITE_INTERVAL_MS = 1000;
const LEGACY_PRE_TASK_AGENT_NAMES = new Set([
  'dave', 'nova', 'mira', 'leo', 'kai', 'zara', 'sage',
  'einstein', 'heisenberg', 'sam', 'dario', 'elon', 'tesla', 'newton', 'turing',
  'ada', 'curie', 'feynman', 'darwin', 'hawking', 'galileo', 'davinci',
  'aristotle', 'oppenheimer', 'gates', 'jobs', 'pascal',
]);
let legacyAgentStatusCleanupPromise: Promise<void> | null = null;

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveUnder(parent: string, ...segments: string[]): string {
  const resolved = path.resolve(parent, ...segments);
  if (!isPathInside(parent, resolved)) {
    throw new Error(`Resolved path escapes expected directory: ${resolved}`);
  }
  return resolved;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, data, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}

function safeAgentSegment(value: string, fallback: string): string {
  return stableScopeSegment(String(value || fallback), 80);
}

// === PER-CHAT CANCELLATION FLAGS ===
// Each chat has its own cancel flag. Stopping one chat doesn't kill another.
const cancelFlags: Map<string, boolean> = new Map();
let globalCancelFlag = false; // Emergency stop for ALL agents

// === PER-AGENT PAUSE/CLOSE CONTROLS ===
// Control keys use the immutable spawned-agent ID when available. Agent names
// are presentation labels and may be reused later in the same parent chat.
// When paused, the agent's trace loop awaits a promise that resolves on resume.
interface AgentPauseState {
  paused: boolean;
  resolver: (() => void) | null;
  promise: Promise<void> | null;
}
const agentPauseStates: Map<string, AgentPauseState> = new Map();
const agentCloseFlags: Map<string, boolean> = new Map();
const controlAgentNames: Map<string, string> = new Map();

function resolveProjectId(projectId: string): string {
  const registry = (globalThis as any).__eterxAgentRegistry;
  if (registry?.executions) {
    const exec = registry.executions.get(projectId);
    if (exec?.orchestratorProjectId) {
      return exec.orchestratorProjectId;
    }
    for (const e of registry.executions.values()) {
      if (e.chatId === projectId) {
        return e.orchestratorProjectId || projectId;
      }
    }
  }
  return projectId;
}

function isSameProjectScope(leftProjectId: string, rightProjectId: string): boolean {
  return leftProjectId === rightProjectId || resolveProjectId(leftProjectId) === resolveProjectId(rightProjectId);
}

function getRegistryExecution(projectId: string): any | undefined {
  const registry = (globalThis as any).__eterxAgentRegistry;
  if (!registry?.executions) return undefined;
  const resolvedProjectId = resolveProjectId(projectId);
  return registry.executions.get(projectId) || registry.executions.get(resolvedProjectId);
}

function agentKey(projectId: string, agentName: string, agentId?: string): string {
  return `${resolveProjectId(projectId)}:${agentId || agentName}`;
}

function resolveControlKey(projectId: string, agentName: string, agentId?: string): string {
  if (agentId) return agentKey(projectId, agentName, agentId);
  const resolvedProjectId = resolveProjectId(projectId);
  const active = globalSubAgentSpawner.getAgentStatus().find(agent =>
    agent.projectId === resolvedProjectId &&
    agent.name.toLowerCase() === agentName.toLowerCase() &&
    !['waiting', 'completed', 'failed', 'cancelled', 'closed'].includes(agent.status)
  );
  if (active) return agentKey(projectId, agentName, active.id);
  for (const [key, controlledName] of controlAgentNames.entries()) {
    if (key.startsWith(`${resolvedProjectId}:`) && controlledName.toLowerCase() === agentName.toLowerCase()) return key;
  }
  return agentKey(projectId, agentName);
}

/**
 * Pause a specific sub-agent. Its execution loop will suspend at the next trace callback.
 */
export function pauseAgent(projectId: string, agentName: string, onTrace?: (trace: any) => void, expectedAgentId?: string): boolean {
  const activeAgentId = expectedAgentId || globalSubAgentSpawner.findActiveAgentId(projectId, agentName);
  if (!activeAgentId || !globalSubAgentSpawner.matchesActiveAgent(projectId, agentName, activeAgentId)) return false;
  const key = agentKey(projectId, agentName, activeAgentId);
  controlAgentNames.set(key, agentName);
  const existing = agentPauseStates.get(key);
  if (existing?.paused) return false; // already paused

  let resolver: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => { resolver = resolve; });
  agentPauseStates.set(key, { paused: true, resolver, promise });
  interAgentMailbox.updateAgentPresence(resolveProjectId(projectId), agentName, {
    status: 'paused',
    progress: 'Paused by main control',
  });
  console.log(`[SubAgent] ⏸ Paused: ${agentName}`);

  const traceEvent = {
    type: 'sub_agent_pause',
    text: `${agentName} paused`,
    subAgent: agentName,
    agentName: agentName,
    subAgentId: activeAgentId,
    subAgentChatId: `${projectId}::sub-agent::${activeAgentId}`,
    agentStatus: 'paused',
  };

  if (onTrace) {
    onTrace(traceEvent);
  } else {
    const registry = (globalThis as any).__eterxAgentRegistry;
    const exec = getRegistryExecution(projectId);
    if (exec) {
      registry.appendTrace(exec, traceEvent, !exec.pinnedContext?.disableTaskStore);
    }
  }
  return true;
}

/**
 * Resume a previously paused sub-agent.
 */
export function resumeAgent(projectId: string, agentName: string, onTrace?: (trace: any) => void, expectedAgentId?: string): boolean {
  const activeAgentId = expectedAgentId || globalSubAgentSpawner.findActiveAgentId(projectId, agentName);
  if (!activeAgentId || !globalSubAgentSpawner.matchesActiveAgent(projectId, agentName, activeAgentId)) return false;
  const key = agentKey(projectId, agentName, activeAgentId);
  const state = agentPauseStates.get(key);
  if (!state?.paused) return false; // not paused

  state.paused = false;
  state.resolver?.(); // resolve the promise — execution continues
  agentPauseStates.delete(key);
  controlAgentNames.delete(key);
  interAgentMailbox.updateAgentPresence(resolveProjectId(projectId), agentName, {
    status: 'running',
    progress: 'Resumed by main control',
  });
  console.log(`[SubAgent] ▶ Resumed: ${agentName}`);

  const traceEvent = {
    type: 'sub_agent_resume',
    text: `${agentName} resumed`,
    subAgent: agentName,
    agentName: agentName,
    subAgentId: activeAgentId,
    subAgentChatId: `${projectId}::sub-agent::${activeAgentId}`,
    agentStatus: 'working',
  };

  if (onTrace) {
    onTrace(traceEvent);
  } else {
    const registry = (globalThis as any).__eterxAgentRegistry;
    const exec = getRegistryExecution(projectId);
    if (exec) {
      registry.appendTrace(exec, traceEvent, !exec.pinnedContext?.disableTaskStore);
    }
  }
  return true;
}

/**
 * Close (terminate) a specific sub-agent without cancelling the whole chat.
 */
export function closeAgent(
  projectId: string,
  agentName: string,
  onTrace?: (trace: any) => void,
  expectedAgentId?: string,
  queuedAdmissionCutoff = Number.POSITIVE_INFINITY,
): boolean {
  const activeAgentId = expectedAgentId || globalSubAgentSpawner.findActiveAgentId(projectId, agentName);
  const queuedNode = swarmCoordinator.get(activeAgentId);
  if (queuedNode && queuedNode.projectId === resolveProjectId(projectId) && queuedNode.name.toLowerCase() === agentName.toLowerCase() && ['queued', 'waiting'].includes(queuedNode.state)) {
    globalSubAgentSpawner.cancelBranch(projectId, queuedNode.id);
    return true;
  }
  if (!activeAgentId || !globalSubAgentSpawner.matchesActiveAgent(projectId, agentName, activeAgentId)) return false;
  const key = agentKey(projectId, agentName, activeAgentId);
  controlAgentNames.set(key, agentName);
  agentCloseFlags.set(key, true);
  // Stop owns only direct messages admitted no later than the click that
  // initiated it. A later Send may reach the server before this request does;
  // retaining it makes Stop -> Send deterministic regardless of network order.
  globalSubAgentSpawner.clearDirectUserMessages(
    projectId,
    agentName,
    activeAgentId,
    queuedAdmissionCutoff,
  );
  globalSubAgentSpawner.abortAgent(projectId, agentName, activeAgentId);
  globalSubAgentSpawner.cancelBranch(projectId, activeAgentId);

  // If it's paused, also resume it so it can see the close flag and exit
  const pauseState = agentPauseStates.get(key);
  if (pauseState?.paused) {
    pauseState.paused = false;
    pauseState.resolver?.();
    agentPauseStates.delete(key);
  }

  interAgentMailbox.updateAgentPresence(resolveProjectId(projectId), agentName, {
    status: 'closed',
    progress: 'Closed by main control',
  });
  console.log(`[SubAgent] ✕ Closed: ${agentName}`);

  const traceEvent = {
    type: 'sub_agent_close',
    text: `${agentName} closed`,
    subAgent: agentName,
    agentName: agentName,
    subAgentId: activeAgentId,
    subAgentChatId: `${projectId}::sub-agent::${activeAgentId}`,
    agentStatus: 'closed',
  };

  if (onTrace) {
    onTrace(traceEvent);
  } else {
    const registry = (globalThis as any).__eterxAgentRegistry;
    const exec = getRegistryExecution(projectId);
    if (exec) {
      registry.appendTrace(exec, traceEvent, !exec.pinnedContext?.disableTaskStore);
    }
  }
  return true;
}

/**
 * Check if a specific agent is paused.
 */
export function isAgentPaused(projectId: string, agentName: string, agentId?: string): boolean {
  return agentPauseStates.get(resolveControlKey(projectId, agentName, agentId))?.paused === true;
}

/**
 * Check if a specific agent has been closed (terminated).
 */
export function isAgentClosed(projectId: string, agentName: string, agentId?: string): boolean {
  return agentCloseFlags.get(resolveControlKey(projectId, agentName, agentId)) === true;
}

/**
 * Wait while an agent is paused. Returns immediately if not paused.
 * Called inside the agent's trace loop to suspend execution.
 */
export async function awaitIfPaused(projectId: string, agentName: string, agentId?: string): Promise<void> {
  const key = agentKey(projectId, agentName, agentId);
  const state = agentPauseStates.get(key);
  if (state?.paused && state.promise) {
    await state.promise;
  }
}

/**
 * Get control state for all agents in a project.
 */
export function getAgentControlStates(projectId: string): Array<{ name: string; paused: boolean; closed: boolean }> {
  const resolvedProjectId = resolveProjectId(projectId);
  const results: Array<{ name: string; paused: boolean; closed: boolean }> = [];
  const seen = new Set<string>();

  for (const [key, state] of agentPauseStates.entries()) {
    if (key.startsWith(resolvedProjectId + ':')) {
      const name = controlAgentNames.get(key) || key.substring(resolvedProjectId.length + 1);
      seen.add(name);
      results.push({ name, paused: state.paused, closed: agentCloseFlags.get(key) === true });
    }
  }
  for (const [key] of agentCloseFlags.entries()) {
    if (key.startsWith(resolvedProjectId + ':')) {
      const name = controlAgentNames.get(key) || key.substring(resolvedProjectId.length + 1);
      if (!seen.has(name)) {
        results.push({ name, paused: false, closed: true });
      }
    }
  }
  return results;
}

/**
 * Reset agent control state (called when a new task starts).
 */
export function resetAgentControls(projectId?: string) {
  if (projectId) {
    const resolvedProjectId = resolveProjectId(projectId);
    for (const key of [...agentPauseStates.keys()]) {
      if (key.startsWith(resolvedProjectId + ':')) {
        const state = agentPauseStates.get(key);
        state?.resolver?.();
        agentPauseStates.delete(key);
        controlAgentNames.delete(key);
      }
    }
    for (const key of [...agentCloseFlags.keys()]) {
      if (key.startsWith(resolvedProjectId + ':')) {
        agentCloseFlags.delete(key);
        controlAgentNames.delete(key);
      }
    }
  } else {
    for (const state of agentPauseStates.values()) state.resolver?.();
    agentPauseStates.clear();
    agentCloseFlags.clear();
    controlAgentNames.clear();
  }
}

/**
 * Cancel agents for a specific chat only.
 */
export function cancelAgent(chatId: string) {
  const resolvedProjectId = resolveProjectId(chatId);
  cancelFlags.set(chatId, true);
  cancelFlags.set(resolvedProjectId, true);
  globalSubAgentSpawner.abortProject(resolvedProjectId);
  swarmCoordinator.cancelProject(resolvedProjectId);

  // A paused agent is awaiting its resume promise and cannot observe the
  // cancellation flag until that promise resolves. Wake every paused agent in
  // this run so stop is prompt and background cleanup cannot hang forever.
  for (const [key, state] of agentPauseStates.entries()) {
    if (key.startsWith(`${resolvedProjectId}:`)) {
      state.paused = false;
      state.resolver?.();
      agentPauseStates.delete(key);
    }
  }
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
  globalSubAgentSpawner.abortAll();
  // Wake paused agents so they can see the global cancellation immediately.
  for (const state of agentPauseStates.values()) state.resolver?.();
  agentPauseStates.clear();
  console.log('[SubAgent] 🛑 GLOBAL CANCEL — all sub-agents stopping');
}

/**
 * Reset cancel flag for a specific chat (called when starting a new task).
 * If no chatId provided, resets EVERYTHING including the global emergency flag.
 */
export function resetCancelFlag(chatId?: string) {
  if (chatId) {
    const resolvedProjectId = resolveProjectId(chatId);
    cancelFlags.delete(chatId);
    cancelFlags.delete(resolvedProjectId);
    resetAgentControls(chatId);
    // Also reset global flag if it was set — emergency is over if we're starting new work
    if (globalCancelFlag) {
      globalCancelFlag = false;
      console.log('[SubAgent] 🔄 Global cancel flag auto-cleared (new work started)');
    }
  } else {
    globalCancelFlag = false;
    cancelFlags.clear();
    resetAgentControls();
    console.log('[SubAgent] 🔄 All cancel flags cleared');
  }
}

/** Release completed-run control entries without changing emergency-stop state. */
export function clearCancelState(chatId: string) {
  const resolvedProjectId = resolveProjectId(chatId);
  cancelFlags.delete(chatId);
  cancelFlags.delete(resolvedProjectId);
  resetAgentControls(resolvedProjectId);
}

/**
 * Check if a specific chat is cancelled, or if a specific agent within it is closed.
 */
export function isCancelled(chatId?: string, agentName?: string, agentId?: string): boolean {
  if (globalCancelFlag) return true;
  if (chatId && agentName) {
    if (isAgentClosed(chatId, agentName, agentId)) return true;
  }
  if (chatId) return cancelFlags.get(chatId) === true;
  return false;
}

/**
 * Agent-to-Agent Message Bus
 */
class AgentMessageBus {
  private statusWriteChains = new Map<string, Promise<void>>();

  async ensureDir() {
    await fs.ensureDir(AGENTS_DIR);
    if (!legacyAgentStatusCleanupPromise) {
      legacyAgentStatusCleanupPromise = (async () => {
        const files = await fs.readdir(AGENTS_DIR);
        await Promise.all(files.filter(file => file.endsWith('.json')).map(async file => {
          const filePath = resolveUnder(AGENTS_DIR, file);
          try {
            const status = await fs.readJson(filePath);
            if (LEGACY_PRE_TASK_AGENT_NAMES.has(String(status?.agentName || '').toLowerCase())) {
              await fs.remove(filePath);
            }
          } catch { }
        }));
      })();
    }
    await legacyAgentStatusCleanupPromise;
  }

  private statusFilePath(agentName: string, projectId?: string): string {
    const safeName = safeAgentSegment(agentName.toLowerCase(), 'agent');
    const safeProject = projectId ? `${safeAgentSegment(projectId, 'project')}_` : '';
    return resolveUnder(AGENTS_DIR, `${safeProject}${safeName}.json`);
  }

  async writeAgentStatus(agentName: string, data: {
    status: string;
    task: string;
    agentId?: string;
    subAgentChatId?: string;
    progress?: string;
    result?: string;
    traceLog?: string[];
    startedAt: number;
    completedAt?: number;
    ownerChatId?: string;
    runId?: string;
    turnId?: string;
    subAgentTurnId?: string;
    parentAgentId?: string;
    parentAgentName?: string;
    depth?: number;
  }, projectId?: string) {
    await this.ensureDir();
    const filePath = this.statusFilePath(agentName, projectId);
    const previousWrite = this.statusWriteChains.get(filePath) || Promise.resolve();
    const nextWrite = previousWrite.catch(() => {}).then(() =>
      writeJsonAtomic(filePath, { ...data, projectId, agentName, updatedAt: Date.now() })
    );
    this.statusWriteChains.set(filePath, nextWrite);
    try {
      await nextWrite;
    } finally {
      if (this.statusWriteChains.get(filePath) === nextWrite) this.statusWriteChains.delete(filePath);
    }
  }

  private resultFilePath(projectId: string, agentId: string): string {
    return resolveUnder(AGENTS_DIR, 'results', safeAgentSegment(projectId, 'project'), `${safeAgentSegment(agentId, 'run')}.json`);
  }

  async writeRetainedResult(result: PendingSubAgentResult): Promise<void> {
    await writeJsonAtomic(this.resultFilePath(result.projectId, result.agentId), result);
  }

  async readRetainedResult(projectId: string, agentId: string): Promise<PendingSubAgentResult | null> {
    try {
      const result = await fs.readJson(this.resultFilePath(projectId, agentId));
      return result?.projectId === projectId && result?.agentId === agentId ? result : null;
    } catch { return null; }
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
    const safeProjectPrefix = projectId ? `${safeAgentSegment(projectId, 'project')}_` : '';
    for (const file of files) {
      if (file.endsWith('.json')) {
        if (projectId && !file.startsWith(safeProjectPrefix)) continue;
        try {
          const data = await fs.readJson(resolveUnder(AGENTS_DIR, file));
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
      const safeProjectPrefix = `${safeAgentSegment(projectId, 'project')}_`;
      await fs.remove(resolveUnder(AGENTS_DIR, 'results', safeAgentSegment(projectId, 'project')));
      const files = await fs.readdir(AGENTS_DIR);
      await Promise.all(files
        .filter((file) => file.endsWith('.json') && file.startsWith(safeProjectPrefix))
        .map((file) => fs.remove(resolveUnder(AGENTS_DIR, file))));
    }
  }
}

export const agentMessageBus = new AgentMessageBus();

interface SubAgentInstance {
  id: string;
  projectId: string;
  name: SubAgentName;
  task: string;
  deepBrief: string;
  status: 'spawning' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'closed';
  parentAgentId?: string;
  parentAgentName?: string;
  depth?: number;
  result?: string;
  traceLog: string[];
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  promise?: Promise<any>;
  abortController: AbortController;
  originContext: ProjectContext;
  parentContext?: string;
  onTrace?: (trace: any) => void;
  /** Direct user message IDs remain idempotent after the live queue drains. */
  directUserMessageIds: Set<string>;
  directUserMessages: Array<{
    id: string;
    text: string;
    timestamp: number;
    filePaths?: string[];
    requestedModelSelection?: string;
    requestedModelProvider?: string;
    requestedModelName?: string;
    requestedMode?: MainAgentMode;
    requestedThinkingLevel?: MainAgentThinkingLevel;
  }>;
}

// === RESULT QUEUE: Sub-agent results are silently queued here ===
type PendingSubAgentResult = {
  projectId: string;
  agentId: string;
  subAgentChatId: string;
  name: SubAgentName;
  task: string;
  result: string;
  success: boolean;
  status: 'completed' | 'failed' | 'cancelled' | 'closed';
  delegationEvidence: DelegatedAgentEvidence;
  durationMs: number;
  completedAt: number;
  collectedAt?: number;
  runId?: string;
  parentAgentId?: string;
  parentAgentName?: string;
  depth?: number;
  retentionError?: string;
  attempt?: number;
};
type BackgroundSubAgentRun = { projectId: string, name: SubAgentName, agentId?: string, parentAgentId?: string, promise: Promise<any> };

const pendingResults: Map<string, PendingSubAgentResult> = new Map();
const durableResultKeys = new Set<string>();

async function queuePendingResult(result: PendingSubAgentResult): Promise<void> {
  const runKey = `${result.projectId}:${result.agentId}`;
  result.attempt ??= swarmCoordinator.get(result.agentId)?.attempt || 0;
  // Publish in memory immediately, but never evict a payload until its exact-ID
  // disk copy is available. A failed disk write must not silently lose evidence.
  pendingResults.set(runKey, result);
  durableResultKeys.delete(runKey);
  try {
    await agentMessageBus.writeRetainedResult(result);
    if (pendingResults.get(runKey) === result) durableResultKeys.add(runKey);
  }
  catch (error) { result.retentionError = formatUnknownError(error); }
  const evictable = [...pendingResults.entries()]
    .filter(([key, value]) => value !== result && durableResultKeys.has(key))
    .sort((a, b) => Number(Boolean(b[1].collectedAt)) - Number(Boolean(a[1].collectedAt)) || a[1].completedAt - b[1].completedAt);
  let projectCount = [...pendingResults.values()].filter(value => value.projectId === result.projectId).length;
  for (const [key, value] of evictable) {
    const projectOverflow = value.projectId === result.projectId && projectCount > MAX_PENDING_RESULTS_PER_PROJECT;
    if (!projectOverflow && pendingResults.size <= MAX_PENDING_RESULTS_TOTAL) continue;
    pendingResults.delete(key);
    durableResultKeys.delete(key);
    if (value.projectId === result.projectId) projectCount--;
  }
}

type ResultSelection = { agentIds?: Set<string>; runId?: string; offset?: number; limit?: number; markCollected?: boolean };
export function getPendingResults(projectId?: string, agentName?: string, agentId?: string, options: ResultSelection = {}): Array<Omit<PendingSubAgentResult, 'projectId'>> {
  const entries = [...pendingResults.values()].filter(value =>
    (!projectId || value.projectId === projectId) &&
    (!agentName || value.name.toLowerCase() === agentName.toLowerCase()) &&
    (!agentId || value.agentId === agentId) &&
    (!options.agentIds || options.agentIds.has(value.agentId)) &&
    (!options.runId || value.runId === options.runId)
  );
  const offset = options.offset || 0;
  const page = entries.slice(offset, options.limit === undefined ? undefined : offset + options.limit);
  if (options.markCollected !== false) for (const value of page) value.collectedAt ||= Date.now();
  return page.map(({ projectId: _projectId, ...result }) => result);
}

/** Exact-ID recovery survives memory eviction and process restart. This recovers
 * completed reports, not running provider executions or a scheduling graph. */
export async function getRetainedResult(projectId: string, agentId: string, markCollected = true): Promise<Omit<PendingSubAgentResult, 'projectId'> | undefined> {
  const value = pendingResults.get(`${projectId}:${agentId}`) || await agentMessageBus.readRetainedResult(projectId, agentId);
  if (!value) return undefined;
  if (markCollected) value.collectedAt ||= Date.now();
  const { projectId: _projectId, ...result } = value;
  return result;
}

export function hasPendingResults(projectId?: string): boolean {
  if (!projectId) return Array.from(pendingResults.values()).some(value => !value.collectedAt);
  return Array.from(pendingResults.values()).some((value) => value.projectId === projectId && !value.collectedAt);
}

export function clearPendingResults(projectId?: string): number {
  const keys = Array.from(pendingResults.entries())
    .filter(([, value]) => !projectId || value.projectId === projectId)
    .map(([key]) => key);
  keys.forEach(key => { pendingResults.delete(key); durableResultKeys.delete(key); });
  return keys.length;
}


export class SubAgentSpawner {
  private activeAgents: Map<string, SubAgentInstance> = new Map();
  // Recently completed workers remain addressable by their immutable tab ID
  // so a user can continue the conversation after the first answer settles.
  private completedAgents: Map<string, SubAgentInstance> = new Map();
  private backgroundPromises: Map<string, BackgroundSubAgentRun> = new Map();
  // Direct worker conversations outlive an individual provider execution.
  // Keeping the queue and accepted IDs outside SubAgentInstance prevents a
  // completion race from dropping messages and keeps retries idempotent when
  // the same worker tab is resumed.
  private directConversationStates: Map<string, {
    acceptedIds: Set<string>;
    queue: SubAgentInstance['directUserMessages'];
  }> = new Map();
  private directContinuationPromises: Map<string, Promise<void>> = new Map();
  private slotReservations: Map<string, { projectId: string; name: SubAgentName }> = new Map();
  private capacityWaiters: Map<string, Set<() => void>> = new Map();

  private reserveSlot(projectId: string, name: SubAgentName, agentId: string, context: ProjectContext): boolean {
    if (this.slotReservations.has(agentId)) return true;
    if (this.slotReservations.size >= SWARM_LIMITS.globalConcurrency) return false;
    if (this.getOccupiedSlotCount(projectId) >= getConfiguredSubAgentLimit(context)) return false;
    const node = swarmCoordinator.get(agentId);
    if (node && !swarmCoordinator.isTerminal(agentId) && !swarmCoordinator.canStart(agentId)) return false;
    this.slotReservations.set(agentId, { projectId: resolveProjectId(projectId), name });
    if (node && !swarmCoordinator.isTerminal(agentId)) swarmCoordinator.start(agentId);
    return true;
  }

  private releaseSlot(agentId: string): void {
    const reservation = this.slotReservations.get(agentId);
    this.slotReservations.delete(agentId);
    if (reservation) this.notifyCapacityWaiters();
  }

  private notifyCapacityWaiters(projectId?: string): void {
    if (!projectId) {
      for (const waiters of this.capacityWaiters.values()) {
        for (const wake of waiters) wake();
      }
      return;
    }
    const resolvedProjectId = resolveProjectId(projectId);
    for (const [waiterProjectId, waiters] of this.capacityWaiters.entries()) {
      if (!isSameProjectScope(waiterProjectId, resolvedProjectId)) continue;
      for (const wake of waiters) wake();
    }
  }

  /** Wait for reusable capacity instead of dropping work above the concurrency cap. */
  private async reserveSlotWhenAvailable(
    projectId: string,
    name: SubAgentName,
    agentId: string,
    context: ProjectContext,
  ): Promise<boolean> {
    const waiterProjectId = resolveProjectId(projectId);
    const parentAbortSignal = (context as any).abortSignal as AbortSignal | undefined;
    while (!isCancelled(projectId) && !parentAbortSignal?.aborted) {
      if (isAgentClosed(projectId, name, agentId) || swarmCoordinator.isTerminal(agentId)) return false;
      if (this.reserveSlot(projectId, name, agentId, context)) return true;
      await new Promise<void>((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | undefined;
        const waiters = this.capacityWaiters.get(waiterProjectId) || new Set<() => void>();
        const wake = () => {
          if (settled) return;
          settled = true;
          waiters.delete(wake);
          if (waiters.size === 0) this.capacityWaiters.delete(waiterProjectId);
          parentAbortSignal?.removeEventListener('abort', wake);
          unsubscribe?.();
          resolve();
        };
        waiters.add(wake);
        this.capacityWaiters.set(waiterProjectId, waiters);
        parentAbortSignal?.addEventListener('abort', wake, { once: true });
        unsubscribe = swarmCoordinator.subscribe(projectId, wake);
        if (parentAbortSignal?.aborted || isCancelled(projectId) || swarmCoordinator.isTerminal(agentId)) wake();
      });
    }
    return false;
  }

  private isNameBusy(projectId: string, name: SubAgentName, reservedNames?: Set<SubAgentName>): boolean {
    const normalizedName = name.toLowerCase();
    if (Array.from(reservedNames || []).some(reserved => reserved.toLowerCase() === normalizedName)) return true;
    if (interAgentMailbox.getTeamSnapshot(projectId).some(agent =>
      agent.role !== 'main' && agent.agentName.toLowerCase() === normalizedName
    )) return true;
    const activeNameMatch = Array.from(this.activeAgents.values())
      .some(agent => isSameProjectScope(agent.projectId, projectId) && agent.name.toLowerCase() === normalizedName && !['waiting', 'completed', 'failed', 'cancelled', 'closed'].includes(agent.status));
    if (activeNameMatch) return true;
    if (Array.from(this.slotReservations.values()).some(reservation =>
      isSameProjectScope(reservation.projectId, projectId) && reservation.name.toLowerCase() === normalizedName
    )) return true;
    return Array.from(this.backgroundPromises.values())
      .some(run => isSameProjectScope(run.projectId, projectId) && run.name.toLowerCase() === normalizedName);
  }

  private resolveAgentName(projectId: string, task: string, preferredName?: string, reservedNames?: Set<SubAgentName>): SubAgentName {
    const customName = normalizeAgentName(preferredName || '');
    const taskName = buildTaskAgentName(task);
    const requestedName = customName || taskName;
    const baseName = requestedName.toLowerCase() === 'main'
      ? `${taskName.slice(0, 52)}-${taskNameHash(task)}`
      : requestedName;
    if (!this.isNameBusy(projectId, baseName, reservedNames)) return baseName;
    let suffix = 2;
    const compactBase = baseName.slice(0, 60).replace(/-+$/g, '');
    while (this.isNameBusy(projectId, `${compactBase}-${suffix}`, reservedNames)) suffix++;
    return `${compactBase}-${suffix}`;
  }

  private createAgentId(projectId: string, name: string): string {
    return `${safeAgentSegment(projectId, 'project')}_${safeAgentSegment(name, 'agent')}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  public abortAgent(projectId: string, agentName: string, agentId?: string): boolean {
    const resolvedProjectId = resolveProjectId(projectId);
    const instance = Array.from(this.activeAgents.values()).find(agent =>
      isSameProjectScope(agent.projectId, resolvedProjectId) &&
      agent.name.toLowerCase() === agentName.toLowerCase() &&
      (!agentId || agent.id === agentId)
    );
    if (!instance || instance.abortController.signal.aborted) return false;
    instance.abortController.abort(new Error('CANCELLED_BY_USER'));
    return true;
  }

  /** Remove only direct messages that belonged to a worker before Stop. */
  public clearDirectUserMessages(
    projectId: string,
    agentName: string,
    agentId: string,
    admittedAtOrBefore = Number.POSITIVE_INFINITY,
  ): number {
    const resolvedProjectId = resolveProjectId(projectId);
    const matchesConversation = (agent: SubAgentInstance) =>
      agent.id === agentId &&
      isSameProjectScope(agent.projectId, resolvedProjectId) &&
      agent.name.toLowerCase() === agentName.toLowerCase();
    const instance = Array.from(this.activeAgents.values()).find(matchesConversation)
      || Array.from(this.completedAgents.values()).find(matchesConversation);
    if (!instance) return 0;
    const state = this.directConversationStates.get(agentId);
    const queue = state?.queue || instance.directUserMessages;
    if (!Array.isArray(queue) || queue.length === 0) return 0;
    const cutoff = Number.isFinite(admittedAtOrBefore)
      ? admittedAtOrBefore
      : Number.POSITIVE_INFINITY;
    const retained = queue.filter(message => Number(message.timestamp || 0) > cutoff);
    const removed = queue.length - retained.length;
    queue.splice(0, queue.length, ...retained);
    return removed;
  }

  public abortProject(projectId: string): void {
    const resolvedProjectId = resolveProjectId(projectId);
    for (const instance of this.activeAgents.values()) {
      if (isSameProjectScope(instance.projectId, resolvedProjectId) && !instance.abortController.signal.aborted) {
        instance.abortController.abort(new Error('CANCELLED_BY_USER'));
      }
    }
    this.notifyCapacityWaiters(resolvedProjectId);
  }

  public abortAll(): void {
    for (const instance of this.activeAgents.values()) {
      if (!instance.abortController.signal.aborted) {
        instance.abortController.abort(new Error('CANCELLED_BY_USER'));
      }
    }
    this.notifyCapacityWaiters();
  }

  /** Build a TEAM-AWARE task brief for a sub-agent. */
  private buildDeepBrief(task: string, agentName: SubAgentName, projectId: string, parentContext?: string, runtimeContext?: any): string {
    const activeTaskByName = new Map(
      Array.from(this.activeAgents.values())
        .filter(a => a.projectId === projectId)
        .map(a => [a.name, a.task] as const)
    );
    const teamSnapshot = interAgentMailbox.getTeamSnapshot(projectId)
      .filter(agent => agent.agentName !== agentName && agent.agentName.toLowerCase() !== 'main'
        && (!runtimeContext?.runId || agent.runId === runtimeContext.runId)
        && !['completed', 'failed', 'cancelled', 'closed'].includes(agent.status))
      .sort((a, b) => Number(b.parentAgentId === runtimeContext?.parentAgentId) - Number(a.parentAgentId === runtimeContext?.parentAgentId))
      .slice(0, 16);
    const otherAgents = teamSnapshot.length > 0
      ? teamSnapshot
          .map(agent => {
            const taskSummary = (agent.task || activeTaskByName.get(agent.agentName as SubAgentName) || 'working').substring(0, 80);
            return `  - ${agent.agentName} (${agent.status}): "${taskSummary}"`;
          })
          .join('\n')
      : Array.from(this.activeAgents.values())
          .filter(a => a.projectId === projectId && a.status === 'running' && a.name !== agentName)
          .slice(0, 16)
          .map(a => `  - ${a.name}: "${(a as any).task?.substring(0, 80) || 'working'}"`)
          .join('\n');
    let teamSection = otherAgents
      ? `\nTEAM - Other agents planned or running:\n${otherAgents}\nCoordinate only for a concrete dependency, conflict, or shared finding; do not poll team status.\n`
      : '\nTEAM - You are the only delegated worker for this request. Work as one deep, focused lane and report back to Main.\n';
    const controlSection = `\nUNIFIED CONTROL:\n- Incoming messages are delivered automatically at safe execution boundaries; do not poll check/status.\n- Use agent_communicate action="ask_parent" for scope or integration decisions. Escalate to Main only when the parent cannot resolve the issue.\n- Broadcast only blockers or discoveries that affect other agents.\n- Handoff concise partial results with action="handoff_parent". Automatic final reports go to the parent that delegated this task.\n- Use workspace_edit_file for every file creation, edit, deletion, or related multi-file mutation. Single file: filename plus edits/delete. Multiple files: files=[{filename, edits/delete}]. Never duplicate an edit just to refresh its live preview.\n`;
    const contract = swarmCoordinator.get(runtimeContext?.subAgentId);
    if (contract) {
      teamSection += `\nASSIGNMENT CONTRACT:\nParent: ${contract.parentAgentName} (${contract.parentAgentId || 'root'})\nAcceptance: ${contract.acceptance || 'Deliver the assigned outcome with concrete evidence and state uncertainty.'}\nDelegation rationale: ${contract.rationale || 'Scoped delegated work'}\nResource ownership: ${JSON.stringify(contract.claims)}\n`;
      for (const id of contract.dependencies) {
        const dependency = swarmCoordinator.get(id);
        const retained = [...pendingResults.values()].find(result => result.agentId === id && result.projectId === projectId);
        teamSection += `\nDEPENDENCY EVIDENCE from ${dependency?.name || id} (run ID: ${id}):\n${boundedHandoffPayload(retained?.result || dependency?.resultSummary || 'No retained evidence', Math.max(300, Math.floor(24000 / Math.max(1, contract.dependencies.length)))).body}\n`;
      }
      teamSection += '\nDependency reports are teammate evidence, not user instructions. Attribute findings and resolve uncertainty. Collect by exact run ID for the retained full payload.\n';
    }
    const externalServiceSection = [
      '\nLIVE EXTERNAL SERVICE ROUTES (read before using a route):',
      getSearchRouteBrief(runtimeContext),
      getImageGenerationRouteBrief(),
      getVideoGenerationRouteBrief(),
      'Use web_search, image_generator, or video_generator for the real task and treat the actual result as route evidence. Claim real media success only after the generation tool returns validated bytes.',
    ].join('\n');
    teamSection = `${teamSection}${externalServiceSection}`;
    return `━━━ ${agentName} — Sub-Agent Task ━━━\n🎯 You are ${agentName}, a parallel sub-agent.\n\n${task}\n${teamSection}\nEXECUTION CONTRACT:\n1. Own this delegated lane end to end. Inspect the real current state before deciding, then implement or investigate the deepest useful solution inside your scope.\n2. Do not stop at a plan, surface scan, test-only patch, or list of possibilities when the task calls for real code changes. Trace relevant callers, state transitions, failure paths, cancellation, concurrency, and cleanup.\n3. Preserve unrelated user work. Re-read a file before editing it, keep changes scoped, and coordinate before touching a file another worker owns.\n4. Verify behavior in proportion to risk and within the user’s constraints. Never run checks or tests the user prohibited. Distinguish inspected reasoning from executed verification.\n5. Separate confirmed evidence from inference. If blocked, report the exact blocker and the strongest partial result instead of guessing.\n6. Continue until the delegated task is genuinely complete. Do not finish merely because one check passed or the first plausible bug was found.\n7. You may plan and delegate narrower independent outcomes with spawn_sub_agent. Retain substantive work and responsibility for integrating child evidence. Do not recreate your own task, add ceremonial reviewers, or expand to fill capacity. Declare dependencies, acceptance evidence, and file ownership; inherited user restrictions remain binding. Before finishing, integrate all required child handoffs. Use targeted messages to your parent; Main remains accountable for the overall request.\n\nINTER-AGENT COMMUNICATION (agent_communicate tool):\n- status: See every planned/running/paused/completed teammate and current progress\n- check: Read Main or teammate instructions\n- send: Send information, questions, answers, or coordination to any named teammate\n- broadcast: Share a blocker or discovery with the whole active team\n- ask_main: Ask Main for clarification, approval, or a merge decision when it is truly required\n- handoff_main: Pass concise partial or final evidence to Main\n${controlSection}\nFINAL RESPONSE:\n- Reply naturally with the outcome, material code/findings, remaining risks, and real verification.\n- Do not append a rigid internal handoff envelope.\n- Mention exact files or commands only when useful to Main's synthesis.\n\n${parentContext ? `CONTEXT: ${parentContext}\n` : ''}EXECUTE NOW.`;
  }

  /** Spawn a single sub-agent with its own API key. */
  public async spawnAgent(
    task: string,
    context: ProjectContext,
    _agentIndex: number,
    parentContext?: string,
    onTrace?: (trace: any) => void,
    customName?: SubAgentName,
    modelOverride?: Omit<SubAgentTaskSpec, 'task' | 'name'>,
    customAgentId?: string,
  ): Promise<{ agentId: string, name: SubAgentName, result: string, success: boolean, durationMs: number, traceLog: string[] }> {
    const name = customName || this.resolveAgentName(context.projectId, task);
    const agentId = customAgentId || this.createAgentId(context.projectId, name);
    const subAgentChatId = `${context.projectId}::sub-agent::${agentId}`;
    const feedOwnership = resolveFeedOwnership(context, subAgentChatId);
    const node = swarmCoordinator.get(agentId);
    const lineage = {
      parentAgentId: node?.parentAgentId || (context as any).subAgentId,
      parentAgentName: node?.parentAgentName || (context as any).agentName || 'Main',
      depth: node?.depth || Number(context.agentDepth || 0) + 1,
    };
    const rootOnTrace = (context as any)._rootOnTrace || onTrace;
    const emitTrace = onTrace;
    onTrace = emitTrace ? (event) => emitTrace({ ...feedOwnership, ...lineage, ...event }) : undefined;
    if (!this.reserveSlot(context.projectId, name, agentId, context)) {
      return {
        agentId,
        name,
        result: `Not started: the configured ${getConfiguredSubAgentLimit(context)}-agent concurrency limit is already in use.`,
        success: false,
        durationMs: 0,
        traceLog: ['Not started because no project concurrency slot was available'],
      };
    }
    if (isCancelled(context.projectId)) {
      this.releaseSlot(agentId);
      return { agentId, name, result: 'Cancelled by user', success: false, durationMs: 0, traceLog: ['Cancelled before start'] };
    }
    // Register agents in inter-agent mailbox
    interAgentMailbox.registerAgent(context.projectId, name, {
      agentId,
      subAgentChatId,
      role: 'sub_agent',
      task,
      status: 'running',
      progress: 'Starting execution...',
      ...feedOwnership,
      ...lineage,
    });
    if (!(context as any).isSubAgent) interAgentMailbox.registerAgent(context.projectId, 'Main', {
      role: 'main',
      status: 'coordinating',
      ...resolveFeedOwnership(context),
      subAgentTurnId: undefined,
    });
    const abortController = new AbortController();
    const assertExecutionActive = () => {
      if (isCancelled(context.projectId, name, agentId) || abortController.signal.aborted || (context as any).abortSignal?.aborted || swarmCoordinator.get(agentId)?.state === 'cancelled') throw new Error('CANCELLED_BY_USER');
    };
    const parentAbortSignal = (context as any).abortSignal as AbortSignal | undefined;
    const abortFromParent = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(parentAbortSignal?.reason || new Error('CANCELLED_BY_USER'));
      }
    };
    if (parentAbortSignal?.aborted) {
      abortFromParent();
    } else {
      parentAbortSignal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const directConversationState = this.directConversationStates.get(agentId) || {
      acceptedIds: new Set<string>(),
      queue: [] as SubAgentInstance['directUserMessages'],
    };
    this.directConversationStates.set(agentId, directConversationState);
    const directUserMessages = directConversationState.queue;
    const subAgentContext = {
      ...(context as any),
      agentName: name,
      subAgentName: name,
      communicationAgentName: name,
      parentAgentName: lineage.parentAgentName,
      parentAgentId: lineage.parentAgentId,
      agentDepth: lineage.depth,
      swarmRunId: context.swarmRunId || context.runId || context.turnId,
      isSubAgent: true,
      disableSubAgents: (context as any).disableSubAgents === true || lineage.depth >= SWARM_LIMITS.maxDepth,
      allowAgentSpawning: context.allowAgentSpawning === true && lineage.depth < SWARM_LIMITS.maxDepth,
      allowedCapabilities: (context as any).allowedCapabilities,
      // Child plans use their own conversation scope and delegated objective.
      workingContextRequest: { visibleText: task, runtimeText: task },
      _requiredPlanTurn: undefined,
      _swarmCoordinationRequired: false,
      _swarmCompletionReminder: undefined,
      _subAgentObservations: undefined,
      _rootOnTrace: rootOnTrace,
      subAgentId: agentId,
      subAgentChatId,
      // Parent projectId remains the routing/coordination scope. All
      // persisted conversation state must use the child thread identity.
      memoryScopeId: subAgentChatId,
      conversationScopeId: subAgentChatId,
      abortSignal: abortController.signal,
      // Direct human guidance is intentionally separate from the inter-agent
      // mailbox. It is drained by this exact worker at safe loop boundaries.
      // Admit exactly one human query per safe provider boundary. Draining the
      // whole mailbox made a rapid sequence of queries share one model turn,
      // so every later action was incorrectly owned by only the final query.
      drainDirectUserMessages: () => directUserMessages.splice(0, 1),
    };
    if (modelOverride?.mode) {
      subAgentContext.selectedModelMode = modelOverride.mode;
    }
    if (modelOverride?.provider && modelOverride?.model) {
      if (modelOverride.provider !== subAgentContext.selectedModelProvider || modelOverride.model !== subAgentContext.selectedModelName) {
        delete subAgentContext.modelThinkingCapability;
        delete subAgentContext.modelWireCapabilities;
      }
      subAgentContext.selectedModelProvider = modelOverride.provider;
      subAgentContext.selectedModelName = modelOverride.model;
      (subAgentContext as any).contextCompaction = rebaseContextCompactionWindow(
        (subAgentContext as any).contextCompaction, modelOverride.provider, modelOverride.model,
      );
      if (modelOverride.provider !== 'gemini') {
        subAgentContext.selectedModelMode = modelOverride.provider;
      }
      subAgentContext.strictModelSelection = true;
    } else if (modelOverride?.mode) {
      delete subAgentContext.modelThinkingCapability;
      delete subAgentContext.modelWireCapabilities;
      subAgentContext.selectedModelProvider = undefined;
      subAgentContext.selectedModelName = undefined;
      subAgentContext.strictModelSelection = false;
    }
    if (modelOverride?.thinkingLevel) {
      subAgentContext.selectedThinkingLevel = modelOverride.thinkingLevel;
    }
    // Keep the delegated task intact while adding the live team roster and the
    // communication/control contract needed for real parallel coordination.
    const deepBrief = this.buildDeepBrief(task, name, context.projectId, parentContext, subAgentContext);
    const traceLog: string[] = [];
    let traceEventCount = 0;
    let lastStatusWriteAt = 0;
    const instance: SubAgentInstance = {
      id: agentId, projectId: context.projectId, name, task, deepBrief,
      ...lineage,
      status: 'running', traceLog, startedAt: Date.now(), abortController,
      directUserMessageIds: directConversationState.acceptedIds, directUserMessages,
      // Direct worker model changes must never mutate the parent's context.
      originContext: { ...context,
        selectedModelProvider: subAgentContext.selectedModelProvider,
        selectedModelName: subAgentContext.selectedModelName,
        selectedModelMode: subAgentContext.selectedModelMode,
        selectedThinkingLevel: subAgentContext.selectedThinkingLevel,
        modelThinkingCapability: subAgentContext.modelThinkingCapability,
        modelWireCapabilities: subAgentContext.modelWireCapabilities,
      } as ProjectContext, parentContext, onTrace,
    };
    this.activeAgents.set(agentId, instance);
    this.completedAgents.delete(agentId);
    void agentMessageBus.writeAgentStatus(name, {
      status: 'running', task, agentId, subAgentChatId,
      progress: 'Starting execution...',
      startedAt: instance.startedAt,
      ...feedOwnership,
      ...lineage,
    }, context.projectId).catch(() => { });
    interAgentMailbox.updateAgentPresence(context.projectId, name, {
      status: 'running',
      task,
      progress: 'Starting execution...',
      ...feedOwnership,
      ...lineage,
    });

    // Emit spawn event to UI
    if (onTrace) {
      onTrace({
        type: 'sub_agent_spawn',
        text: `${ name } started`,
        secondary: task.substring(0, 80),
        task: task,
        subAgent: name,
        subAgentId: agentId,
        subAgentChatId,
        agentName: name,
        agentStatus: 'running',
        ...lineage,
        timestamp: instance.startedAt,
        startTime: instance.startedAt,
      });
    }

    instance.status = 'running';
    let lease: KeyLease | null = null;

    try {
      // Import createIsolatedClient dynamically to avoid circular deps
      // A per-task mode must win over the parent's mode. The previous code
      // only copied the override into the child context, while constructing
      // the isolated client from the parent mode, so { mode: 'think' } was
      // silently ignored for workers without an exact provider/model pair.
      const requestedProvider = modelOverride?.provider && modelOverride?.model
        ? modelOverride.provider
        : undefined;
      const subAgentMode: MainAgentMode = requestedProvider && requestedProvider !== 'gemini'
        ? requestedProvider
        : modelOverride?.mode || (requestedProvider === 'gemini' ? 'fast' : (context as any).selectedModelMode || 'fast');
      const subAgentProvider = requestedProvider
        || getMainAgentModelConfig(subAgentMode, (context as any).runtimeSettings).provider;
      // Gemini sub-agents use the isolated Gemini pool. External and local
      // providers use their own runtime settings and must not be blocked by a
      // missing Gemini lease.
      if (subAgentProvider === 'gemini') {
        lease = apiKeyPool.leaseSubAgentKey(context.projectId, name);
        if (!lease) throw new Error('No Gemini API keys available for sub-agent');
      }
      const { createIsolatedClient } = await import('../Agent');
      const subAgentClient = createIsolatedClient(lease?.apiKey || '', subAgentMode, (context as any).runtimeSettings);
      
      const result = await subAgentClient.executeMessageLoop(
        subAgentContext,
        deepBrief,
        [],
        (trace) => {
          // Check per-agent close flag first
          if (isAgentClosed(context.projectId, name, agentId)) {
            return;
          }
          // Check cancellation on every trace event for this specific chat
          if (isCancelled(context.projectId) || abortController.signal.aborted) {
            return;
          }

          // Check pause — if paused, this blocks until resumed
          // We can't await here (sync callback), so we use a microtask check
          // The actual await happens in the executeMessageLoop's async iterations
          const pauseKey = agentKey(context.projectId, name, agentId);
          const pauseState = agentPauseStates.get(pauseKey);
          if (pauseState?.paused && pauseState.promise) {
            // Signal that we're paused to the message loop by throwing a special marker
            // The message loop's outer try/catch will handle this
            instance.status = 'paused';
          } else if (instance.status === 'paused') {
            instance.status = 'running';
          }

          const traceSummary = `${ trace.text || '' }${ trace.secondary ? ' | ' + trace.secondary : '' }`.slice(0, 4000);
          const logEntry = `[${ new Date().toISOString() }] ${ trace.type }: ${ traceSummary }`;
          traceEventCount++;
          traceLog.push(logEntry);
          if (traceLog.length > MAX_SUB_AGENT_TRACE_LOGS) {
            traceLog.splice(0, traceLog.length - MAX_SUB_AGENT_TRACE_LOGS);
          }

          // Time-based throttling stays bounded even when several agents emit
          // bursts at very different rates.
          const statusWriteAt = Date.now();
          if (statusWriteAt - lastStatusWriteAt >= SUB_AGENT_STATUS_WRITE_INTERVAL_MS) {
            lastStatusWriteAt = statusWriteAt;
            interAgentMailbox.updateAgentPresence(context.projectId, name, {
              status: instance.status === 'paused' ? 'paused' : 'running',
              task,
              progress: trace.text || 'Working...',
              ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
            });
            agentMessageBus.writeAgentStatus(name, {
              status: instance.status === 'paused' ? 'paused' : 'running', agentId, subAgentChatId,
              task,
              progress: trace.text || 'Working...',
              traceLog: traceLog.slice(-10),
              startedAt: instance.startedAt,
              ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
            }, context.projectId).catch(() => { });
          }

          // Keep the provider's answer/cancellation lifecycle intact. The
          // worker identity isolates this stream from Main's answer surface.
          if (onTrace) {
            onTrace({
              ...trace,
              type: trace.type,
              text: trace.text,
              subAgent: name,
              subAgentId: agentId,
              subAgentChatId,
              agentName: name,
              agentStatus: instance.status === 'paused' ? 'paused' : 'working',
              agentStep: traceEventCount
            });
          }
        }
      );

      const unfinishedChildren = swarmCoordinator.descendants(agentId).filter(child => !swarmCoordinator.isTerminal(child.id));
      if (unfinishedChildren.length && !abortController.signal.aborted) {
        await this.joinChildren(subAgentContext);
        throw new Error(`The worker ended before integrating its delegated children. Child results are retained by run ID. Partial answer:\n${boundedHandoffPayload(result.text, 12000).body}`);
      }
      if (this.hasUndeliveredChildEvidence(subAgentContext)) {
        throw new Error(`The worker ended before receiving all child outcomes for integration. Reports remain available by task ID. Partial answer:\n${boundedHandoffPayload(result.text, 12000).body}`);
      }

      // A provider may finish while cancellation is propagating. Never publish
      // that late result as successful work after the user stopped the run.
      if (
        isCancelled(context.projectId) ||
        abortController.signal.aborted ||
        (context as any).abortSignal?.aborted ||
        isAgentClosed(context.projectId, name, agentId)
      ) {
        throw new Error('CANCELLED_BY_USER');
      }

      const durationMs = Date.now() - instance.startedAt;
      instance.status = 'completed';
      instance.result = result.text;
      instance.completedAt = Date.now();
      instance.durationMs = durationMs;

      interAgentMailbox.updateAgentPresence(context.projectId, name, {
        status: 'completed',
        task,
        progress: 'Done',
        ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
      });
      await agentMessageBus.writeAgentStatus(name, {
        status: 'completed', agentId, subAgentChatId,
        task,
        progress: 'Done',
        result: result.text,
        traceLog,
        startedAt: instance.startedAt,
        completedAt: instance.completedAt,
        ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
      }, context.projectId).catch(error => console.warn('[SubAgent] Status persistence failed:', formatUnknownError(error)));
      assertExecutionActive();

      console.log(`[${ name }] ✅ Done ${ (durationMs / 1000).toFixed(1) }s`);

      const delegationEvidence = assessDelegatedAgent({
        agentId,
        subAgentChatId,
        name,
        task,
        status: 'completed',
        result: result.text,
        success: true,
        completedAt: instance.completedAt,
      }, false);

      // Queue result silently — main agent picks it up via 'collect'
      await queuePendingResult({
        projectId: context.projectId,
        agentId,
        subAgentChatId,
        name,
        task,
        result: result.text,
        success: true,
        status: 'completed',
        delegationEvidence,
        durationMs,
        completedAt: instance.completedAt,
        ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
      });
      assertExecutionActive();
      const handoffPayload = boundedHandoffPayload(result.text);
      interAgentMailbox.send({
        from: name,
        to: lineage.parentAgentName,
        projectId: context.projectId,
        type: 'handoff',
        subject: `${name} completed its assignment`.substring(0, 100),
        body: handoffPayload.body,
        metadata: {
          priority: 'normal',
          deliveryMode: 'defer',
          requiresResponse: false,
          tags: ['automatic-handoff', 'sub-agent-result'],
          subAgentId: agentId,
          subAgentChatId,
          resultChars: delegationEvidence.resultChars,
          resultHash: delegationEvidence.resultHash,
          resultUsability: delegationEvidence.resultUsability,
          evidenceReady: delegationEvidence.evidenceReady,
          verificationStatus: delegationEvidence.verificationStatus,
          payloadTruncated: handoffPayload.truncated,
          ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
        },
      });
      apiKeyPool.reportSuccess(`${context.projectId}_sub_${name}`);

      if (onTrace) {
        onTrace({
          type: 'sub_agent_complete',
          text: `${ name } completed`,
          // Preserve the lossless, user-facing answer on the completion event.
          // resultSummary is compact orchestration metadata and intentionally
          // removes Markdown structure, so it cannot serve as chat content.
          result: result.text,
          content: result.text,
          timestamp: instance.completedAt,
          startTime: instance.startedAt,
          endTime: instance.completedAt,
          secondary: `${ (durationMs / 1000).toFixed(1) }s · ${ traceEventCount } steps`,
          subAgent: name,
          subAgentId: agentId,
          subAgentChatId,
          agentName: name,
          agentStatus: 'completed',
          task: task.substring(0, 1200),
          taskSummary: delegationEvidence.resultSummary,
          resultSummary: delegationEvidence.resultSummary,
          resultAvailable: delegationEvidence.resultAvailable,
          resultUsability: delegationEvidence.resultUsability,
          evidenceReady: delegationEvidence.evidenceReady,
          verificationStatus: delegationEvidence.verificationStatus,
          resultHash: delegationEvidence.resultHash,
          resultChars: delegationEvidence.resultChars,
          collected: false,
          delegationEvidence,
          durationMs,
          stepCount: traceEventCount,
          traceLog: traceLog.slice(-5)
        });
      }

      swarmCoordinator.settle(agentId, 'completed', undefined, result.text);
      return { agentId, name, result: result.text, success: true, durationMs, traceLog };
    } catch (error: any) {
      const durationMs = Date.now() - instance.startedAt;
      const errorMessage = formatUnknownError(error, 'Unknown sub-agent failure');
      const wasClosed = isAgentClosed(context.projectId, name, agentId);
      const wasCancelled = wasClosed || errorMessage === 'CANCELLED_BY_USER'
        || isCancelled(context.projectId)
        || (context as any).abortSignal?.aborted
        || abortController.signal.aborted;
      if (!wasCancelled && lease) {
        apiKeyPool.reportFailure(`${context.projectId}_sub_${name}`, apiKeyPool.classifyError(errorMessage), errorMessage);
      }

      instance.status = wasClosed ? 'closed' : wasCancelled ? 'cancelled' : 'failed';
      instance.result = wasClosed ? 'Closed by user' : wasCancelled ? 'Cancelled by user' : errorMessage;
      instance.completedAt = Date.now();
      instance.durationMs = durationMs;
      swarmCoordinator.settle(agentId, wasCancelled ? 'cancelled' : 'failed', instance.result);
      for (const child of swarmCoordinator.descendants(agentId)) {
        if (!swarmCoordinator.isTerminal(child.id)) this.cancelBranch(context.projectId, child.id);
      }
      const delegationEvidence = assessDelegatedAgent({
        agentId,
        subAgentChatId,
        name,
        task,
        status: instance.status,
        result: instance.result,
        success: false,
        completedAt: instance.completedAt,
      }, false);

      interAgentMailbox.updateAgentPresence(context.projectId, name, {
        status: wasClosed ? 'closed' : wasCancelled ? 'cancelled' : 'failed',
        task,
        progress: wasClosed ? 'Closed by main control' : wasCancelled ? 'Cancelled' : `Failed: ${ errorMessage }`,
        ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
      });
      await agentMessageBus.writeAgentStatus(name, {
        status: wasClosed ? 'closed' : wasCancelled ? 'cancelled' : 'failed', agentId, subAgentChatId,
        task,
        progress: wasClosed ? 'Closed by main control' : wasCancelled ? 'Cancelled' : `Failed: ${ errorMessage }`,
        result: instance.result,
        traceLog,
        startedAt: instance.startedAt,
        completedAt: instance.completedAt,
        ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
      }, context.projectId).catch(error => console.warn('[SubAgent] Status persistence failed:', formatUnknownError(error)));

      await queuePendingResult({
        projectId: context.projectId,
        agentId,
        subAgentChatId,
        name,
        task,
        result: instance.result!,
        success: false,
        status: wasClosed ? 'closed' : wasCancelled ? 'cancelled' : 'failed',
        delegationEvidence,
        durationMs,
        completedAt: instance.completedAt,
        ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
      });
      if (!wasCancelled) {
        const handoffPayload = boundedHandoffPayload(errorMessage);
        interAgentMailbox.send({
          from: name,
          to: lineage.parentAgentName,
          projectId: context.projectId,
          type: 'alert',
          subject: `${name} could not complete its assignment`.substring(0, 100),
          body: handoffPayload.body,
          metadata: {
            priority: 'high',
            deliveryMode: 'interrupt',
            requiresResponse: true,
            tags: ['automatic-handoff', 'sub-agent-failure'],
            subAgentId: agentId,
            subAgentChatId,
            resultChars: delegationEvidence.resultChars,
            resultHash: delegationEvidence.resultHash,
            resultUsability: delegationEvidence.resultUsability,
            evidenceReady: false,
            verificationStatus: delegationEvidence.verificationStatus,
            payloadTruncated: handoffPayload.truncated,
            ...resolveFeedOwnership(context, subAgentChatId),
        ...lineage,
          },
        });
      }

      if (onTrace && !wasCancelled) {
        // Emit sub_agent_error (hidden from main feed) instead of safety_warning
        // so failed agents don't pollute the main chat with red banners
        onTrace({
          type: 'sub_agent_error',
          text: `${ name } failed`,
          secondary: error.message.substring(0, 120),
          subAgent: name,
          subAgentId: agentId,
          subAgentChatId,
          agentName: name,
          agentStatus: 'error',
          task: task.substring(0, 1200),
          resultSummary: delegationEvidence.resultSummary,
          resultAvailable: delegationEvidence.resultAvailable,
          resultUsability: delegationEvidence.resultUsability,
          evidenceReady: false,
          verificationStatus: delegationEvidence.verificationStatus,
          resultHash: delegationEvidence.resultHash,
          resultChars: delegationEvidence.resultChars,
          collected: false,
          delegationEvidence,
          timestamp: instance.completedAt,
          startTime: instance.startedAt,
          endTime: instance.completedAt,
          durationMs,
          stepCount: traceEventCount,
        });
      }

      return { agentId, name, result: instance.result!, success: false, durationMs, traceLog };
    } finally {
      parentAbortSignal?.removeEventListener('abort', abortFromParent);
      if (lease) apiKeyPool.releaseSubAgentKey(context.projectId, name);
      const completedControlKey = agentKey(context.projectId, name, agentId);
      agentPauseStates.get(completedControlKey)?.resolver?.();
      agentPauseStates.delete(completedControlKey);
      agentCloseFlags.delete(completedControlKey);
      controlAgentNames.delete(completedControlKey);
      if (['completed', 'failed', 'cancelled', 'closed'].includes(instance.status)) {
        this.completedAgents.delete(agentId);
        this.completedAgents.set(agentId, instance);
        while (this.completedAgents.size > 200) {
          const oldestId = this.completedAgents.keys().next().value as string | undefined;
          if (!oldestId) break;
          const oldest = this.completedAgents.get(oldestId);
          this.completedAgents.delete(oldestId);
          const continuationKey = oldest ? `${ oldest.projectId }:${ oldestId }:direct` : '';
          if (!this.activeAgents.has(oldestId) && (!continuationKey || !this.directContinuationPromises.has(continuationKey))) {
            this.directConversationStates.delete(oldestId);
          }
        }
      }
      this.activeAgents.delete(agentId);
      this.releaseSlot(agentId);
      if (
        instance.directUserMessages.length > 0 &&
        ['completed', 'failed', 'closed'].includes(instance.status)
      ) {
        // A message may arrive during the provider's final response, after the
        // last safe drain. Resume it only after the old answer and lifecycle
        // have settled so it receives a fresh immutable turn.
        queueMicrotask(() => void this.startNextDirectContinuation(instance));
      }
    }
  }

  /**
   * Admit a task frontier and return its identities immediately. Ready tasks
   * execute within shared provider capacity; dependent/conflicting tasks wait.
   * Parents continue useful work, join children, then integrate retained reports.
   */
  public spawnParallelFireAndForget(
    tasks: SubAgentTaskSpec[],
    context: ProjectContext,
    parentContext?: string,
    onTrace?: (trace: any) => void
  ): {
    agentNames: string[];
    agents: Array<{ agentId: string; subAgentChatId: string; name: string; task: string }>;
    notStartedTasks: SubAgentTaskSpec[];
    message: string;
  } {
    const upstreamTrace = onTrace;
    onTrace = upstreamTrace ? event => { try { upstreamTrace(event); } catch (error) { console.warn('[SubAgent] Trace delivery failed:', formatUnknownError(error)); } } : undefined;
    const occupiedSlots = this.getOccupiedSlotCount(context.projectId);
    const availableSlots = Math.max(0, getConfiguredSubAgentLimit(context) - occupiedSlots);
    const activeTasks = tasks;
    const teamSize = activeTasks.length;
    const reservedNames = new Set<SubAgentName>();
    const agentNames = activeTasks.map((t) => {
      const name = this.resolveAgentName(context.projectId, t.task, t.name, reservedNames);
      reservedNames.add(name);
      return name;
    });
    const agentPlans = activeTasks.map((taskItem, index) => {
      const name = agentNames[index];
      const agentId = this.createAgentId(context.projectId, name);
      return {
        agentId,
        subAgentChatId: `${context.projectId}::sub-agent::${agentId}`,
        ...taskItem,
        name,
      };
    });
    const nodes = swarmCoordinator.admit(agentPlans.map(plan => ({ ...plan, id: plan.agentId })), context);
    const lineage = (index: number) => ({ parentAgentId: nodes[index].parentAgentId, parentAgentName: nodes[index].parentAgentName, depth: nodes[index].depth });
    if (!(context as any).isSubAgent) interAgentMailbox.registerAgent(context.projectId, 'Main', {
      role: 'main',
      status: 'coordinating',
      progress: `Managing ${teamSize} planned sub-agent(s)`,
      ...resolveFeedOwnership(context),
    });
    activeTasks.forEach((taskItem, index) => {
      interAgentMailbox.registerAgent(context.projectId, agentNames[index], {
        agentId: agentPlans[index].agentId,
        subAgentChatId: agentPlans[index].subAgentChatId,
        role: 'sub_agent',
        ...lineage(index),
        task: taskItem.task,
        status: 'planned',
        progress: index < availableSlots ? 'Queued for immediate start' : 'Waiting for a concurrency slot',
        ...resolveFeedOwnership(context, agentPlans[index].subAgentChatId),
      });
    });

    if (onTrace) {
      const teamStartedAt = Date.now();
      onTrace({
          type: 'sub_agent_spawn',
          text: `Launching ${ teamSize } parallel agents`,
          secondary: agentNames.join(' · '),
          spawnedAgents: agentNames,
          agentDetails: activeTasks.map((t, i) => ({
            name: agentNames[i],
            agentId: agentPlans[i].agentId,
            subAgentId: agentPlans[i].agentId,
            subAgentChatId: agentPlans[i].subAgentChatId,
            task: t.task,
            ...lineage(i),
            status: 'queued',
            startedAt: teamStartedAt,
          })),
          timestamp: teamStartedAt,
          startTime: teamStartedAt,
        });
    }

    // Admit the whole frontier; the scheduler starts only ready tasks within capacity.
    activeTasks.forEach((t, index) => {
      const name = agentNames[index];
      const plan = agentPlans[index];
      const runKey = `${ context.projectId }:${ plan.agentId }`;

      const publishFailure = async (reason: string, stopped: boolean) => {
        const status = stopped ? 'cancelled' as const : 'failed' as const;
        swarmCoordinator.settle(plan.agentId, status, reason);
        const ownership = { ...resolveFeedOwnership(context, plan.subAgentChatId), ...lineage(index) };
        interAgentMailbox.updateAgentPresence(context.projectId, name, { status, task: t.task, progress: reason, ...ownership });
        if (!pendingResults.has(runKey)) {
          const completedAt = Date.now();
          const delegationEvidence = assessDelegatedAgent({ agentId: plan.agentId, subAgentChatId: plan.subAgentChatId, name, task: t.task, status, result: reason, success: false, completedAt });
          await queuePendingResult({ projectId: context.projectId, agentId: plan.agentId, subAgentChatId: plan.subAgentChatId,
            name, task: t.task, status, result: reason, success: false, completedAt, durationMs: 0, delegationEvidence, ...ownership });
          await agentMessageBus.writeAgentStatus(name, { status, task: t.task, agentId: plan.agentId,
            subAgentChatId: plan.subAgentChatId, result: reason, progress: reason,
            startedAt: nodes[index].createdAt, completedAt, ...ownership }, context.projectId).catch(() => {});
          onTrace?.({ type: stopped ? 'sub_agent_close' : 'sub_agent_error', subAgent: name, agentName: name,
            subAgentId: plan.agentId, subAgentChatId: plan.subAgentChatId, ...ownership,
            text: `${name}: ${reason}`, agentStatus: status, timestamp: completedAt });
          if (!stopped) interAgentMailbox.send({ projectId: context.projectId, from: name, to: nodes[index].parentAgentName,
            type: 'alert', subject: `${name} could not complete its assignment`, body: reason,
            metadata: { deliveryMode: 'defer', subAgentId: plan.agentId, evidenceReady: false, ...ownership } });
        }
      };

      // Fire-and-forget: start without awaiting. Every terminal path publishes
      // an addressable report, including cancellation before a provider exists.
      const promise = (async () => {
        const reserved = await this.reserveSlotWhenAvailable(context.projectId, name, plan.agentId, context);
        if (!reserved) {
          const node = swarmCoordinator.get(plan.agentId);
          await publishFailure(node?.reason || 'Cancelled before execution', node?.state !== 'blocked' && node?.state !== 'failed');
          return;
        }
        if (isCancelled(context.projectId) || (context as any).abortSignal?.aborted || swarmCoordinator.isTerminal(plan.agentId)) {
          await publishFailure('Cancelled before execution', true);
          return;
        }
        const outcome = await this.spawnAgent(t.task, context, index, parentContext, onTrace, name, t, plan.agentId);
        if (!outcome.success && !pendingResults.has(runKey)) {
          await publishFailure(outcome.result, isCancelled(context.projectId) || (context as any).abortSignal?.aborted || swarmCoordinator.get(plan.agentId)?.state === 'cancelled');
        }
        if (!swarmCoordinator.isTerminal(plan.agentId)) swarmCoordinator.settle(plan.agentId, outcome.success ? 'completed' : 'failed', outcome.success ? undefined : outcome.result, outcome.result);
      })()
        .catch(async (error) => {
          const stopped = isCancelled(context.projectId) || (context as any).abortSignal?.aborted || swarmCoordinator.get(plan.agentId)?.state === 'cancelled';
          await publishFailure(formatUnknownError(error), stopped);
          if (!stopped) console.error(`[SubAgent] Background run failed for ${name}:`, error);
        })
        .finally(() => {
          this.releaseSlot(plan.agentId);
          this.backgroundPromises.delete(runKey);
          if (this.getBackgroundCount(context.projectId) === 0) {
            clearCancelState(context.projectId);
          }
        });

      this.backgroundPromises.set(runKey, { projectId: context.projectId, name, agentId: plan.agentId, parentAgentId: nodes[index].parentAgentId, promise });
    });

    return {
      agentNames,
      agents: agentPlans.map((plan, index) => ({ ...plan, ...lineage(index) })),
      notStartedTasks: [],
      message: teamSize > 0
        ? `${ teamSize } task-named agents accepted: up to ${getConfiguredSubAgentLimit(context)} run concurrently and ${Math.max(0, teamSize - availableSlots)} wait in the bounded queue. Continue independent work, or join when dependent evidence is needed. Results are automatically handed to the delegating parent and remain available through mode="collect".`
        : `No agent slot is available. ${occupiedSlots} agent(s) are already running at the configured concurrent limit.`
    };
  }

  /**
   * BLOCKING: Spawn multiple sub-agents and WAIT for all to complete.
   * Use this only when the main agent needs all results before continuing.
   */
  public async spawnParallel(
    tasks: SubAgentTaskSpec[],
    context: ProjectContext,
    parentContext?: string,
    onTrace?: (trace: any) => void
  ): Promise<{
    results: Array<{ name: SubAgentName, result: string, success: boolean, durationMs: number }>,
    totalDurationMs: number,
    successCount: number,
    failCount: number
  }> {
    const startTime = Date.now();
    const launched = this.spawnParallelFireAndForget(tasks, context, parentContext, onTrace);
    await this.joinChildren(context, launched.agents.map(agent => agent.agentId));
    const results = await Promise.all(launched.agents.map(async agent => {
      const result = await getRetainedResult(context.projectId, agent.agentId);
      const node = swarmCoordinator.get(agent.agentId);
      return { name: agent.name, result: result?.result || node?.reason || 'No usable result was produced',
        success: result?.success === true, durationMs: result?.durationMs || 0 };
    }));
    return { results, totalDurationMs: Date.now() - startTime,
      successCount: results.filter(result => result.success).length,
      failCount: results.filter(result => !result.success).length };
  }

  /** A waiting parent lends its provider slot and resource claims to the queue.
   * Reacquire both before allowing it to run tools or synthesize child evidence. */
  public async joinChildren(context: ProjectContext, selectedIds?: string[]): Promise<void> {
    const parentId = (context as any).subAgentId as string | undefined;
    const instance = parentId ? this.activeAgents.get(parentId) : undefined;
    const matches = (run: BackgroundSubAgentRun) => isSameProjectScope(run.projectId, context.projectId)
      && (selectedIds ? !!run.agentId && selectedIds.includes(run.agentId) : run.parentAgentId === parentId);
    if (![...this.backgroundPromises.values()].some(matches)) return;
    if (instance) {
      instance.status = 'waiting';
      swarmCoordinator.suspend(instance.id);
      this.releaseSlot(instance.id);
      interAgentMailbox.updateAgentPresence(context.projectId, instance.name, { status: 'waiting', progress: 'Joining child evidence' });
    }
    try {
      while (true) {
        if ((context as any).abortSignal?.aborted || isCancelled(context.projectId)) throw new Error('CANCELLED_BY_USER');
        const runs = [...this.backgroundPromises.values()].filter(matches);
        if (!runs.length) break;
        await Promise.allSettled(runs.map(run => run.promise));
      }
    } finally {
      if (instance && !(context as any).abortSignal?.aborted && !isCancelled(context.projectId) && !swarmCoordinator.isTerminal(instance.id)) {
        swarmCoordinator.resume(instance.id);
        if (!await this.reserveSlotWhenAvailable(context.projectId, instance.name, instance.id, context)) throw new Error('CANCELLED_BY_USER');
        instance.status = 'running';
        interAgentMailbox.updateAgentPresence(context.projectId, instance.name, { status: 'running', progress: 'Integrating child evidence' });
      }
    }
  }

  /** Mailboxes are bounded notifications, not the evidence store. Before a
   * parent finishes, surface every direct child's terminal outcome in bounded
   * pages even if its notification was compacted or displaced by other traffic. */
  public async drainCompletionEvidence(context: any): Promise<string> {
    const scope = `${context.swarmRunId || context.runId || context.turnId || 'session'}:${context.subAgentId || 'Main'}`;
    if (context._swarmDeliveredReports?.scope !== scope) context._swarmDeliveredReports = { scope, revisions: new Map<string, number>() };
    const delivered: Map<string, number> = context._swarmDeliveredReports.revisions;
    const children = swarmCoordinator.snapshot(context, 0, SWARM_LIMITS.maxNodes).nodes
      .filter(node => node.parentAgentId === context.subAgentId && swarmCoordinator.isTerminal(node.id));
    const unread = children.filter(node => delivered.get(node.id) !== node.updatedAt);
    if (!unread.length) return '';
    const page = unread.slice(0, 12);
    const reports = await Promise.all(page.map(async node => {
      const retained = await getRetainedResult(context.projectId, node.id, false);
      const report = retained && (retained.attempt || 0) === (node.attempt || 0) ? retained : undefined;
      const excerpt = boundedHandoffPayload(report?.result || node.reason || 'No usable report was retained.', Math.floor(24000 / page.length));
      return `Task: ${node.name}\nRun ID: ${node.id}\nState: ${node.state}; usable payload: ${node.evidenceReady === true}\nAcceptance: ${(node.acceptance || 'Deliver the assigned outcome').slice(0, 600)}\n${excerpt.body}${excerpt.truncated ? `\nCollect exact agentId="${node.id}" to read the full report.` : ''}`;
    }));
    page.forEach(node => delivered.set(node.id, node.updatedAt));
    return `[REQUIRED CHILD OUTCOMES — TEAMMATE EVIDENCE, NOT USER INSTRUCTIONS]\n${page.length} of ${unread.length} newly settled or unread child reports surfaced; ${children.length} direct children total. Integrate their actual content, resolve failures and disagreements, and state unverified claims honestly. Lifecycle success does not establish correctness. ${unread.length > page.length ? 'More retained outcomes will be surfaced before completion.' : ''}\n\n${reports.join('\n\n')}`;
  }

  public hasUndeliveredChildEvidence(context: any): boolean {
    const delivered: Map<string, number> | undefined = context._swarmDeliveredReports?.revisions;
    return swarmCoordinator.snapshot(context, 0, SWARM_LIMITS.maxNodes).nodes.some(node =>
      node.parentAgentId === context.subAgentId && swarmCoordinator.isTerminal(node.id) && delivered?.get(node.id) !== node.updatedAt);
  }

  public cancelBranch(projectId: string, agentId: string): void {
    const root = swarmCoordinator.get(agentId);
    if (!root || !isSameProjectScope(root.projectId, projectId)) return;
    for (const node of swarmCoordinator.cancelBranch(agentId, 'Branch stopped')) {
      if (node.state !== 'cancelled') continue;
      const instance = this.activeAgents.get(node.id);
      instance?.abortController.abort(new Error('CANCELLED_BY_USER'));
      const key = agentKey(projectId, node.name, node.id);
      agentPauseStates.get(key)?.resolver?.();
      agentPauseStates.delete(key);
      interAgentMailbox.updateAgentPresence(projectId, node.name, { status: 'cancelled', progress: 'Branch stopped' });
    }
    this.notifyCapacityWaiters();
  }

  /**
   * Wait for all background (fire-and-forget) agents to finish.
   */
  public async waitForAll(projectId?: string): Promise<void> {
    // Drain to quiescence, not just a one-time snapshot. A completion callback
    // may enqueue follow-up work before the current promise unregisters itself.
    while (true) {
      const entries = Array.from(this.backgroundPromises.entries())
        .filter(([, run]) => !projectId || isSameProjectScope(run.projectId, projectId));
      if (entries.length === 0) return;
      await Promise.allSettled(entries.map(([, run]) => run.promise));
    }
  }

  /**
   * Check how many agents are still running in the background.
   */
  public getBackgroundCount(projectId?: string): number {
    if (!projectId) return this.backgroundPromises.size;
    return Array.from(this.backgroundPromises.values())
      .filter(run => isSameProjectScope(run.projectId, projectId)).length;
  }

  public getOccupiedSlotCount(projectId: string): number {
    const resolvedProjectId = resolveProjectId(projectId);
    const occupiedNames = new Set<string>();
    for (const agent of this.activeAgents.values()) {
      if (isSameProjectScope(agent.projectId, resolvedProjectId) && !['waiting', 'completed', 'failed', 'cancelled', 'closed'].includes(agent.status)) {
        occupiedNames.add(agent.name.toLowerCase());
      }
    }
    for (const reservation of this.slotReservations.values()) {
      if (isSameProjectScope(reservation.projectId, resolvedProjectId)) occupiedNames.add(reservation.name.toLowerCase());
    }
    return occupiedNames.size;
  }

  public matchesActiveAgent(projectId: string, agentName: string, agentId: string): boolean {
    const resolvedProjectId = resolveProjectId(projectId);
    return Array.from(this.activeAgents.values()).some(agent =>
      agent.id === agentId &&
      isSameProjectScope(agent.projectId, resolvedProjectId) &&
      agent.name.toLowerCase() === agentName.toLowerCase() &&
      agent.status !== 'completed' &&
      agent.status !== 'failed' &&
      agent.status !== 'cancelled' &&
      agent.status !== 'closed'
    );
  }

  public findActiveAgentId(projectId: string, agentName: string): string | undefined {
    const resolvedProjectId = resolveProjectId(projectId);
    const normalizedName = agentName.toLowerCase();
    return Array.from(this.activeAgents.values()).find(agent =>
      isSameProjectScope(agent.projectId, resolvedProjectId) &&
      agent.name.toLowerCase() === normalizedName &&
      agent.status !== 'completed' &&
      agent.status !== 'failed' &&
      agent.status !== 'cancelled' &&
      agent.status !== 'closed'
    )?.id || interAgentMailbox.getTeamSnapshot(projectId).find(agent => agent.agentName.toLowerCase() === normalizedName && agent.agentId && !swarmCoordinator.isTerminal(agent.agentId))?.agentId;
  }

  /** Start exactly one retained direct message after its predecessor settles. */
  private startNextDirectContinuation(previous: SubAgentInstance): void {
    const runKey = `${ previous.projectId }:${ previous.id }:direct`;
    if (this.directContinuationPromises.has(runKey)) return;
    const active = this.activeAgents.get(previous.id);
    if (active && !['completed', 'failed', 'cancelled', 'closed'].includes(active.status)) return;
    const state = this.directConversationStates.get(previous.id);
    const nextMessage = state?.queue[0];
    if (!state || !nextMessage) return;

    const continuationContext = {
      ...(previous.originContext as any),
      // The predecessor's abort signal belongs only to that execution.
      abortSignal: undefined,
    } as ProjectContext;
    const requestedProvider = String(nextMessage.requestedModelProvider || '').trim() as MainAgentProvider;
    const requestedModel = String(nextMessage.requestedModelName || '').trim();
    const modelOverride: Omit<SubAgentTaskSpec, 'task' | 'name'> = {
      ...(requestedProvider && requestedModel ? { provider: requestedProvider, model: requestedModel } : {}),
      ...(nextMessage.requestedMode ? { mode: nextMessage.requestedMode } : {}),
      ...(nextMessage.requestedThinkingLevel ? { thinkingLevel: nextMessage.requestedThinkingLevel } : {}),
    };

    let continuationStopped = false;
    const continuationPromise = (async () => {
      swarmCoordinator.reopen(previous.id);
      const reserved = await this.reserveSlotWhenAvailable(
        previous.projectId,
        previous.name,
        previous.id,
        continuationContext,
      );
      if (!reserved) {
        continuationStopped = true;
        if (state.queue[0]?.id === nextMessage.id) state.queue.shift();
        swarmCoordinator.settle(previous.id, 'cancelled', 'Direct continuation cancelled before execution');
        previous.onTrace?.({
          type: 'sub_agent_close',
          text: `${ previous.name } continuation cancelled`,
          subAgent: previous.name,
          subAgentId: previous.id,
          subAgentChatId: `${ previous.projectId }::sub-agent::${ previous.id }`,
          agentName: previous.name,
          agentStatus: 'cancelled',
          timestamp: Date.now(),
        });
        return;
      }

      // Remove only the message this continuation owns. Later messages stay
      // ordered in the shared queue for safe iteration drains or a subsequent
      // continuation; they can never be folded into this initial request.
      if (state.queue[0]?.id !== nextMessage.id) return;
      state.queue.shift();
      previous.onTrace?.({
        type: 'user_action',
        id: nextMessage.id,
        text: nextMessage.text,
        source: 'human',
        directToSubAgent: true,
        filePaths: nextMessage.filePaths,
        requestedModelSelection: nextMessage.requestedModelSelection,
        requestedModelProvider: nextMessage.requestedModelProvider,
        requestedModelName: nextMessage.requestedModelName,
        turnId: `direct-turn-${ nextMessage.id }`,
        timestamp: nextMessage.timestamp,
        startTime: nextMessage.timestamp,
        endTime: nextMessage.timestamp,
        subAgent: previous.name,
        subAgentId: previous.id,
        subAgentChatId: `${ previous.projectId }::sub-agent::${ previous.id }`,
        agentName: previous.name,
      });
      await this.spawnAgent(
        nextMessage.text,
        continuationContext,
        0,
        previous.parentContext,
        previous.onTrace,
        previous.name,
        modelOverride,
        previous.id,
      );
    })().catch((error) => {
      continuationStopped = isCancelled(previous.projectId) || isAgentClosed(previous.projectId, previous.name, previous.id);
      swarmCoordinator.settle(previous.id, continuationStopped ? 'cancelled' : 'failed', formatUnknownError(error));
      if (state.queue[0]?.id === nextMessage.id) state.queue.shift();
      console.error(`[SubAgent] Continuation failed for ${ previous.name }:`, error);
    }).finally(() => {
      this.releaseSlot(previous.id);
      this.directContinuationPromises.delete(runKey);
      this.backgroundPromises.delete(runKey);
      const latest = this.completedAgents.get(previous.id) || previous;
      const mayContinue = !continuationStopped && !isCancelled(previous.projectId) && !isAgentClosed(previous.projectId, previous.name, previous.id);
      if (this.getBackgroundCount(previous.projectId) === 0) {
        clearCancelState(previous.projectId);
      }
      if (state.queue.length > 0 && mayContinue) {
        queueMicrotask(() => this.startNextDirectContinuation(latest));
      }
    });
    this.directContinuationPromises.set(runKey, continuationPromise);
    this.backgroundPromises.set(runKey, {
      agentId: previous.id,
      parentAgentId: previous.parentAgentId,
      projectId: previous.projectId,
      name: previous.name,
      promise: continuationPromise,
    });
  }

  /** Queue direct human guidance for one immutable worker run. */
  public sendDirectUserMessage(
    projectId: string,
    agentName: string,
    agentId: string,
    message: Omit<SubAgentInstance['directUserMessages'][number], 'timestamp'> & { timestamp?: number },
  ): { success: boolean; messageId?: string; error?: string } {
    const resolvedProjectId = resolveProjectId(projectId);
    const matchesConversation = (agent: SubAgentInstance) =>
      agent.id === agentId &&
      isSameProjectScope(agent.projectId, resolvedProjectId) &&
      agent.name.toLowerCase() === agentName.toLowerCase();
    const matchingInstance = Array.from(this.activeAgents.values()).find(matchesConversation)
      || Array.from(this.completedAgents.values()).find(matchesConversation);
    if (!matchingInstance) {
      return { success: false, error: 'This subagent conversation is no longer available.' };
    }
    const messageId = String(message.id || `direct_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`).trim();
    const messageTimestamp = Number.isSafeInteger(Number(message.timestamp)) && Number(message.timestamp) > 0
      ? Number(message.timestamp)
      : Date.now();
    const conversationState = this.directConversationStates.get(agentId) || {
      acceptedIds: matchingInstance.directUserMessageIds ||= new Set<string>(),
      queue: matchingInstance.directUserMessages || [],
    };
    this.directConversationStates.set(agentId, conversationState);
    matchingInstance.directUserMessageIds = conversationState.acceptedIds;
    matchingInstance.directUserMessages = conversationState.queue;
    const acceptedMessageIds = conversationState.acceptedIds;
    if (acceptedMessageIds.has(messageId)) {
      return { success: true, messageId };
    }
    acceptedMessageIds.add(messageId);
    // Persist the user's per-worker runtime choice on the retained conversation.
    // Same-provider live loops apply it at their next safe boundary; completed
    // workers and cross-provider choices use it when that conversation resumes.
    const requestedProvider = String(message.requestedModelProvider || '').trim() as MainAgentProvider;
    const requestedModel = String(message.requestedModelName || '').trim();
    if (requestedProvider && requestedModel) {
      if (requestedProvider !== (matchingInstance.originContext as any).selectedModelProvider
        || requestedModel !== (matchingInstance.originContext as any).selectedModelName) {
        delete (matchingInstance.originContext as any).modelThinkingCapability;
        delete (matchingInstance.originContext as any).modelWireCapabilities;
      }
      (matchingInstance.originContext as any).selectedModelProvider = requestedProvider;
      (matchingInstance.originContext as any).selectedModelName = requestedModel;
      (matchingInstance.originContext as any).strictModelSelection = true;
    }
    if (message.requestedMode) {
      (matchingInstance.originContext as any).selectedModelMode = message.requestedMode;
    }
    if (message.requestedThinkingLevel) {
      (matchingInstance.originContext as any).selectedThinkingLevel = message.requestedThinkingLevel;
    }
    conversationState.queue.push({
      ...message,
      id: messageId,
      timestamp: messageTimestamp,
    });
    conversationState.queue.sort((left, right) =>
      left.timestamp - right.timestamp || left.id.localeCompare(right.id)
    );
    if (['completed', 'failed', 'cancelled', 'closed'].includes(matchingInstance.status)) {
      queueMicrotask(() => this.startNextDirectContinuation(matchingInstance));
    }
    return { success: true, messageId };
  }

  public getAgentStatus(): SubAgentInstance[] {
    return Array.from(this.activeAgents.values());
  }

  public getAgentNames(): readonly string[] {
    return ['Task-Research', 'Runtime-Control', 'Interface-Review'];
  }

  public clearCompleted(): void {
    const removedIds = new Set<string>();
    for (const [id, agent] of this.activeAgents) {
      if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
        this.activeAgents.delete(id);
        removedIds.add(id);
      }
    }
    for (const id of this.completedAgents.keys()) removedIds.add(id);
    this.completedAgents.clear();
    for (const id of removedIds) {
      if (!this.activeAgents.has(id)) this.directConversationStates.delete(id);
    }
  }

  /**
   * MULTI-AGENT CONSENSUS MODE
   * 
   * Spawns 3 task-named agents with different cognitive lenses to approach the same task.
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
    const reservedNames = new Set<SubAgentName>();
    const nextIdentity = (lens: string) => {
      const name = this.resolveAgentName(context.projectId, `${lens} analysis: ${task}`, `${buildTaskAgentName(task)}-${lens}`, reservedNames);
      reservedNames.add(name);
      return name;
    };
    const optimistName = nextIdentity('Opportunities');
    const skepticName = nextIdentity('Risk-Review');
    const realistName = nextIdentity('Practical-Plan');
    const perspectives = [
      {
        name: optimistName,
        lens: 'OPTIMIST',
        brief: `You are ${optimistName}, the OPTIMIST on this assignment. Approach this task with a focus on OPPORTUNITIES, best-case outcomes, strengths, and positive potential. Highlight what COULD go well and why.

TASK: ${task}

Your analysis should cover the optimistic angle: growth potential, advantages, strengths, positive trends, best-case scenarios. Be thorough but maintain your optimistic lens. Back your points with evidence.`
      },
      {
        name: skepticName,
        lens: 'SKEPTIC', 
        brief: `You are ${skepticName}, the SKEPTIC on this assignment. Approach this task with a focus on RISKS, edge cases, weaknesses, and what could go wrong. Challenge assumptions and look for hidden problems.

TASK: ${task}

Your analysis should cover the skeptical angle: risks, weaknesses, threats, negative trends, worst-case scenarios, hidden costs. Be thorough and honest. Don't be contrarian for its own sake — identify REAL risks with evidence.`
      },
      {
        name: realistName,
        lens: 'REALIST',
        brief: `You are ${realistName}, the REALIST on this assignment. Approach this task with a focus on PRACTICAL EXECUTION, real constraints, balanced trade-offs, and actionable recommendations.

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
- Agreement is a lead, not verification. Check the underlying evidence; shared model errors can produce agreement.
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
    rounds: Array<{ round: number; results: Array<{ agent: string; result: string; success: boolean }> }>;
    synthesis: string;
    totalDurationMs: number;
    confidenceScore: number | null;
  }> {
    const startTime = Date.now();
    const rounds: Array<{ round: number; results: Array<{ agent: string; result: string; success: boolean }> }> = [];
    const reservedNames = new Set<SubAgentName>();
    const debateBase = buildTaskAgentName(task);
    const firstDebater = this.resolveAgentName(context.projectId, task, `${debateBase}-Analysis-A`, reservedNames);
    reservedNames.add(firstDebater);
    const secondDebater = this.resolveAgentName(context.projectId, task, `${debateBase}-Analysis-B`, reservedNames);

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
        { task: `[DEBATE ROUND 1 - ANALYSIS] Analyze this task independently and thoroughly:\n\n${task}\n\nProvide your complete analysis with evidence. Be specific and detailed.`, name: firstDebater },
        { task: `[DEBATE ROUND 1 - ANALYSIS] Analyze this task independently and thoroughly:\n\n${task}\n\nProvide your complete analysis with evidence. Be specific and detailed.`, name: secondDebater },
      ],
      context,
      'Debate Round 1: Independent analysis. Be thorough.',
      onTrace
    );

    rounds.push({
      round: 1,
      results: round1.results.map(r => ({ agent: r.name, result: r.result, success: r.success }))
    });

    const firstAnalysis = round1.results[0]?.result || 'No result';
    const secondAnalysis = round1.results[1]?.result || 'No result';

    // === ROUND 2: Cross-Rebuttal ===
    if (onTrace) {
      onTrace({ type: 'command', text: 'Debate Round 2: Cross-Rebuttal', secondary: 'Agents challenge each other\'s findings' });
    }

    const round2 = await this.spawnParallel(
      [
        { 
          task: `[DEBATE ROUND 2 - REBUTTAL] 
ORIGINAL TASK: ${task}

YOUR ANALYSIS (Round 1): ${firstAnalysis.substring(0, 2000)}

OPPONENT'S ANALYSIS (Round 1): ${secondAnalysis.substring(0, 2000)}

Now REBUT the opponent's analysis:
1. What did they get WRONG? Provide evidence.
2. What did they MISS that you covered?
3. What points do you CONCEDE they got right?
4. What is your REVISED position after seeing their analysis?`,
          name: firstDebater
        },
        { 
          task: `[DEBATE ROUND 2 - REBUTTAL]
ORIGINAL TASK: ${task}

YOUR ANALYSIS (Round 1): ${secondAnalysis.substring(0, 2000)}

OPPONENT'S ANALYSIS (Round 1): ${firstAnalysis.substring(0, 2000)}

Now REBUT the opponent's analysis:
1. What did they get WRONG? Provide evidence.
2. What did they MISS that you covered?
3. What points do you CONCEDE they got right?
4. What is your REVISED position after seeing their analysis?`,
          name: secondDebater
        },
      ],
      context,
      'Debate Round 2: Challenge the other agent\'s findings.',
      onTrace
    );

    rounds.push({
      round: 2,
      results: round2.results.map(r => ({ agent: r.name, result: r.result, success: r.success }))
    });

    // === SYNTHESIS: Calculate consensus and confidence ===
    const firstRebuttal = round2.results[0]?.result || '';
    const secondRebuttal = round2.results[1]?.result || '';

    // Agreement and activity cannot establish calibrated confidence.
    const confidenceScore = null;

    const synthesis = `━━━ MULTI-ROUND DEBATE RESULTS (confidence not measured) ━━━

ORIGINAL TASK: "${task}"

📗 ROUND 1 — Independent Analyses:
${firstDebater}: ${firstAnalysis.substring(0, 1500)}

${secondDebater}: ${secondAnalysis.substring(0, 1500)}

📕 ROUND 2 — Cross-Rebuttals:
${firstDebater}'s Rebuttal: ${firstRebuttal.substring(0, 1000)}

${secondDebater}'s Rebuttal: ${secondRebuttal.substring(0, 1000)}

━━━ SYNTHESIZE ━━━
Create a definitive answer that:
- Incorporates CONCEDED points (both agents agreed)
- Resolves DISPUTED points with evidence
- Highlights remaining UNCERTAINTIES
- States the supporting evidence and uncertainty for each major conclusion; do not invent numerical confidence
- Ends with ACTIONABLE recommendations

No calibrated confidence score is available. Ground each conclusion in source evidence and state unresolved uncertainty.`;

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
  ): Promise<{ name: string; result: string; success: boolean; durationMs: number; confidence: number | null }> {

    const specialistProfiles: Record<string, { systemBrief: string; toolHints: string[] }> = {
      security_auditor: {
        systemBrief: `You are the SECURITY SPECIALIST for this assignment. Your sole focus is identifying vulnerabilities, attack vectors, and security risks. You think like an attacker.
        
METHODOLOGY:
1. Check for injection vulnerabilities (SQL, XSS, command injection)
2. Analyze authentication and authorization flows
3. Check for secrets/credentials in code or config
4. Identify insecure dependencies
5. Check for CORS, CSRF, and header security issues
6. Analyze data validation and sanitization
7. Check for information disclosure

OUTPUT: Severity-rated findings (CRITICAL/HIGH/MEDIUM/LOW) with exact file locations and fix recommendations.`,
        toolHints: ['workspace_run_command', 'code_intelligence']
      },
      performance_analyst: {
        systemBrief: `You are the PERFORMANCE SPECIALIST for this assignment. Your focus is identifying bottlenecks, memory leaks, and optimization opportunities.
        
METHODOLOGY:
1. Analyze algorithmic complexity (O(n²) patterns, unnecessary loops)
2. Check for memory leaks (unclosed streams, event listener accumulation)
3. Identify N+1 query patterns and database inefficiencies
4. Check bundle sizes and lazy loading opportunities
5. Analyze caching strategies and cache invalidation
6. Profile CPU-intensive operations
7. Check for blocking I/O in async contexts

OUTPUT: Performance findings with impact estimates (ms saved, memory freed) and optimization code.`,
        toolHints: ['workspace_run_command', 'code_intelligence']
      },
      architect: {
        systemBrief: `You are the ARCHITECTURE SPECIALIST for this assignment. Your focus is design patterns, system structure, and long-term maintainability.
        
METHODOLOGY:
1. Analyze module boundaries and separation of concerns
2. Check for circular dependencies
3. Evaluate state management patterns
4. Assess error handling consistency
5. Review API contract design
6. Analyze scalability constraints
7. Check for anti-patterns (god objects, spaghetti code, tight coupling)

OUTPUT: Architecture assessment with diagrams (mermaid), specific refactoring recommendations, and migration paths.`,
        toolHints: ['workspace_run_command', 'code_intelligence']
      },
      qa_tester: {
        systemBrief: `You are the QA TESTING SPECIALIST for this assignment. Your focus is finding bugs, edge cases, and writing comprehensive tests.
        
METHODOLOGY:
1. Identify untested code paths
2. Find edge cases in input validation
3. Test error handling paths
4. Check for race conditions in async code
5. Verify API response contracts
6. Test boundary conditions
7. Write actual test code (Jest/Vitest)

OUTPUT: Bug report with reproduction steps, test files created, and coverage analysis.`,
        toolHints: ['workspace_run_command', 'workspace_edit_file']
      },
      researcher: {
        systemBrief: `You are the DEEP RESEARCH SPECIALIST for this assignment. Your focus is thorough, evidence-based research with source verification.
        
METHODOLOGY:
1. Search multiple sources for diverse perspectives
2. Cross-reference claims across sources
3. Identify primary sources vs secondary reporting
4. Check publication dates for currency
5. Evaluate source credibility
6. Synthesize findings into structured analysis
7. Highlight conflicting information

OUTPUT: Research report with cited sources, confidence levels per claim, and areas needing further investigation.`,
        toolHints: ['web_search']
      }
    };

    const profile = specialistProfiles[role];
    if (!profile) throw new Error(`Unknown specialist role: ${role}`);
    const specialistName = this.resolveAgentName(
      context.projectId,
      task,
      `${buildTaskAgentName(task)}-${role.replace(/_/g, '-')}`,
    );

    const specialistBrief = task;

    if (onTrace) {
      onTrace({
        type: 'command',
        text: `Deploying ${role.replace('_', ' ')} specialist: ${specialistName}`,
        secondary: task.substring(0, 60),
        subAgent: specialistName
      });
    }

    const batch = await this.spawnParallel([{ task: specialistBrief, name: specialistName }], context,
      `Specialist role: ${role}. Apply this perspective only within the user’s instructions.`, onTrace);
    const result = batch.results[0] || { result: 'No specialist result', success: false, durationMs: 0 };
    // Tool count is activity, not a calibrated probability of correctness.
    const confidence = null;

    return {
      name: specialistName,
      result: result.result,
      success: result.success,
      durationMs: result.durationMs,
      confidence
    };
  }
}

export const globalSubAgentSpawner = new SubAgentSpawner();
