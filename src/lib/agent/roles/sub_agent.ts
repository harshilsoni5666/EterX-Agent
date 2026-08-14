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
export type SubAgentTaskSpec = {
  task: string;
  name?: SubAgentName;
  mode?: MainAgentMode;
  provider?: MainAgentProvider;
  model?: string;
  thinkingLevel?: MainAgentThinkingLevel;
};

const MAX_PENDING_RESULTS_PER_PROJECT = 100;
const MAX_PENDING_RESULTS_TOTAL = 1000;
const DEFAULT_MAX_SUB_AGENTS = 5;

const getConfiguredSubAgentLimit = (context: ProjectContext): number => {
  const configured = Number((context as any)?.maxSubAgents);
  return Number.isFinite(configured)
    ? Math.min(MAX_SUB_AGENTS, Math.max(1, Math.floor(configured)))
    : DEFAULT_MAX_SUB_AGENTS;
};

const limitConfiguredTasks = (tasks: SubAgentTaskSpec[], context: ProjectContext): SubAgentTaskSpec[] => {
  return tasks.slice(0, getConfiguredSubAgentLimit(context));
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
    !['completed', 'failed', 'cancelled'].includes(agent.status)
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
export function closeAgent(projectId: string, agentName: string, onTrace?: (trace: any) => void, expectedAgentId?: string): boolean {
  const activeAgentId = expectedAgentId || globalSubAgentSpawner.findActiveAgentId(projectId, agentName);
  if (!activeAgentId || !globalSubAgentSpawner.matchesActiveAgent(projectId, agentName, activeAgentId)) return false;
  const key = agentKey(projectId, agentName, activeAgentId);
  controlAgentNames.set(key, agentName);
  agentCloseFlags.set(key, true);
  globalSubAgentSpawner.abortAgent(projectId, agentName, activeAgentId);

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
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  traceLog: string[];
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  promise?: Promise<any>;
  abortController: AbortController;
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
  status: 'completed' | 'failed' | 'cancelled';
  delegationEvidence: DelegatedAgentEvidence;
  durationMs: number;
  completedAt: number;
  collectedAt?: number;
};
type BackgroundSubAgentRun = { projectId: string, name: SubAgentName, promise: Promise<any> };

const pendingResults: Map<string, PendingSubAgentResult> = new Map();

function queuePendingResult(result: PendingSubAgentResult) {
  const runKey = `${ result.projectId }:${ result.agentId }`;
  pendingResults.set(runKey, result);
  const projectEntries = Array.from(pendingResults.entries())
    .filter(([, queued]) => queued.projectId === result.projectId);
  while (projectEntries.length > MAX_PENDING_RESULTS_PER_PROJECT) {
    const [oldestKey] = projectEntries.shift()!;
    pendingResults.delete(oldestKey);
  }
  while (pendingResults.size > MAX_PENDING_RESULTS_TOTAL) {
    const oldestKey = pendingResults.keys().next().value as string | undefined;
    if (!oldestKey) break;
    pendingResults.delete(oldestKey);
  }
}

export function getPendingResults(projectId?: string, agentName?: string, agentId?: string): Array<Omit<PendingSubAgentResult, 'projectId'>> {
  const entries = Array.from(pendingResults.entries())
    .filter(([, value]) =>
      (!projectId || value.projectId === projectId) &&
      (!agentName || value.name.toLowerCase() === agentName.toLowerCase()) &&
      (!agentId || value.agentId === agentId)
    );
  const collectedAt = Date.now();
  for (const [, value] of entries) value.collectedAt = value.collectedAt || collectedAt;
  const results = entries.map(([, value]) => {
    const { projectId: _projectId, ...result } = value;
    return result;
  });
  return results;
}

export function hasPendingResults(projectId?: string): boolean {
  if (!projectId) return Array.from(pendingResults.values()).some(value => !value.collectedAt);
  return Array.from(pendingResults.values()).some((value) => value.projectId === projectId && !value.collectedAt);
}

export function clearPendingResults(projectId?: string): number {
  const keys = Array.from(pendingResults.entries())
    .filter(([, value]) => !projectId || value.projectId === projectId)
    .map(([key]) => key);
  keys.forEach(key => pendingResults.delete(key));
  return keys.length;
}


export class SubAgentSpawner {
  private activeAgents: Map<string, SubAgentInstance> = new Map();
  private backgroundPromises: Map<string, BackgroundSubAgentRun> = new Map();
  private slotReservations: Map<string, { projectId: string; name: SubAgentName }> = new Map();

  private reserveSlot(projectId: string, name: SubAgentName, agentId: string, context: ProjectContext): boolean {
    if (this.slotReservations.has(agentId)) return true;
    if (this.getOccupiedSlotCount(projectId) >= getConfiguredSubAgentLimit(context)) return false;
    this.slotReservations.set(agentId, { projectId: resolveProjectId(projectId), name });
    return true;
  }

  private releaseSlot(agentId: string): void {
    this.slotReservations.delete(agentId);
  }

  private isNameBusy(projectId: string, name: SubAgentName, reservedNames?: Set<SubAgentName>): boolean {
    const normalizedName = name.toLowerCase();
    if (Array.from(reservedNames || []).some(reserved => reserved.toLowerCase() === normalizedName)) return true;
    if (interAgentMailbox.getTeamSnapshot(projectId).some(agent =>
      agent.role !== 'main' && agent.agentName.toLowerCase() === normalizedName
    )) return true;
    const activeNameMatch = Array.from(this.activeAgents.values())
      .some(agent => isSameProjectScope(agent.projectId, projectId) && agent.name.toLowerCase() === normalizedName && agent.status !== 'completed' && agent.status !== 'failed' && agent.status !== 'cancelled');
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

  public abortProject(projectId: string): void {
    const resolvedProjectId = resolveProjectId(projectId);
    for (const instance of this.activeAgents.values()) {
      if (isSameProjectScope(instance.projectId, resolvedProjectId) && !instance.abortController.signal.aborted) {
        instance.abortController.abort(new Error('CANCELLED_BY_USER'));
      }
    }
  }

  public abortAll(): void {
    for (const instance of this.activeAgents.values()) {
      if (!instance.abortController.signal.aborted) {
        instance.abortController.abort(new Error('CANCELLED_BY_USER'));
      }
    }
  }

  /** Build a TEAM-AWARE task brief for a sub-agent. */
  private buildDeepBrief(task: string, agentName: SubAgentName, projectId: string, parentContext?: string, runtimeContext?: any): string {
    const activeTaskByName = new Map(
      Array.from(this.activeAgents.values())
        .filter(a => a.projectId === projectId)
        .map(a => [a.name, a.task] as const)
    );
    const teamSnapshot = interAgentMailbox.getTeamSnapshot(projectId)
      .filter(agent => agent.agentName !== agentName && agent.agentName.toLowerCase() !== 'main');
    const otherAgents = teamSnapshot.length > 0
      ? teamSnapshot
          .map(agent => {
            const taskSummary = (agent.task || activeTaskByName.get(agent.agentName as SubAgentName) || 'working').substring(0, 80);
            return `  - ${agent.agentName} (${agent.status}): "${taskSummary}"`;
          })
          .join('\n')
      : Array.from(this.activeAgents.values())
          .filter(a => a.projectId === projectId && a.status === 'running' && a.name !== agentName)
          .map(a => `  - ${a.name}: "${(a as any).task?.substring(0, 80) || 'working'}"`)
          .join('\n');
    let teamSection = otherAgents
      ? `\nTEAM - Other agents planned or running:\n${otherAgents}\nCoordinate only for a concrete dependency, conflict, or shared finding; do not poll team status.\n`
      : '\nTEAM - You are the only delegated worker for this request. Work as one deep, focused lane and report back to Main.\n';
    const controlSection = `\nUNIFIED CONTROL:\n- Incoming messages are delivered automatically at safe execution boundaries; do not poll check/status.\n- Use agent_communicate with to="Main" when you need clarification, approval, a merge decision, or user-facing escalation.\n- Broadcast only blockers or discoveries that affect other agents.\n- Handoff concise partial results to Main when your lane is complete.\n`;
    const externalServiceSection = [
      '\nLIVE EXTERNAL SERVICE ROUTES (read before using a route):',
      getSearchRouteBrief(runtimeContext),
      getImageGenerationRouteBrief(),
      getVideoGenerationRouteBrief(),
      'Use web_search, image_generator, or video_generator for the real task and treat the actual result as route evidence. Claim real media success only after the generation tool returns validated bytes.',
    ].join('\n');
    teamSection = `${teamSection}${externalServiceSection}`;
    return `━━━ ${agentName} — Sub-Agent Task ━━━\n🎯 You are ${agentName}, a parallel sub-agent.\n\n${task}\n${teamSection}\nRULES:\n1. Full tool access. Work deeply — no shortcuts.\n2. NEVER call task_decomposer or spawn_sub_agent.\n3. VERIFY your work before finishing.\n4. You are ONE of multiple parallel agents.\n\nINTER-AGENT COMMUNICATION (agent_communicate tool):\n- status: See every planned/running/paused/completed teammate and current progress\n- check: Read Main or teammate instructions\n- send: Send information, questions, answers, or coordination to any named teammate\n- broadcast: Share a blocker or discovery with the whole active team\n- ask_main: Ask Main for clarification or a decision at any time\n- handoff_main: Pass partial or final results to Main\n${controlSection}\n## ${agentName} — Report Format\n**Task:** [what you did]\n**Files:** [paths]\n**Key Results:** [findings]\n**Verified:** [yes/no]\n\n${parentContext ? `CONTEXT: ${parentContext}\n` : ''}EXECUTE NOW.`;
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
    });
    interAgentMailbox.registerAgent(context.projectId, 'Main', {
      role: 'main',
      status: 'coordinating',
    });
    const abortController = new AbortController();
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
    const subAgentContext = {
      ...(context as any),
      agentName: name,
      subAgentName: name,
      parentAgentName: 'Main',
      isSubAgent: true,
      // A worker may use the parent's normal workspace, browser, research,
      // and communication tools, but delegation is intentionally a root-only
      // capability. Enforce this in the runtime context as well as the brief;
      // inherited allowedCapabilities previously made recursive spawning
      // possible despite the prompt rule.
      disableSubAgents: true,
      allowAgentSpawning: false,
      allowedCapabilities: Array.isArray((context as any).allowedCapabilities)
        ? (context as any).allowedCapabilities.filter((capability: unknown) => String(capability) !== 'agent.spawn')
        : undefined,
      subAgentId: agentId,
      subAgentChatId,
      // Parent projectId remains the routing/coordination scope. All
      // persisted conversation state must use the child thread identity.
      memoryScopeId: subAgentChatId,
      conversationScopeId: subAgentChatId,
      abortSignal: abortController.signal,
    };
    if (modelOverride?.mode) {
      subAgentContext.selectedModelMode = modelOverride.mode;
    }
    if (modelOverride?.provider && modelOverride?.model) {
      subAgentContext.selectedModelProvider = modelOverride.provider;
      subAgentContext.selectedModelName = modelOverride.model;
      if (modelOverride.provider !== 'gemini') {
        subAgentContext.selectedModelMode = modelOverride.provider;
      }
      subAgentContext.strictModelSelection = true;
    } else if (modelOverride?.mode) {
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
      status: 'running', traceLog, startedAt: Date.now(), abortController,
    };
    this.activeAgents.set(agentId, instance);
    void agentMessageBus.writeAgentStatus(name, {
      status: 'running', task, agentId, subAgentChatId,
      progress: 'Starting execution...',
      startedAt: instance.startedAt
    }, context.projectId).catch(() => { });
    interAgentMailbox.updateAgentPresence(context.projectId, name, {
      status: 'running',
      task,
      progress: 'Starting execution...',
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
        agentStatus: 'running'
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
          if (isCancelled(context.projectId)) {
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
            instance.status = 'paused' as any;
          } else if (instance.status === ('paused' as any)) {
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
              status: instance.status === ('paused' as any) ? 'paused' : 'running',
              task,
              progress: trace.text || 'Working...',
            });
            agentMessageBus.writeAgentStatus(name, {
              status: instance.status === ('paused' as any) ? 'paused' : 'running', agentId, subAgentChatId,
              task,
              progress: trace.text || 'Working...',
              traceLog: traceLog.slice(-10),
              startedAt: instance.startedAt
            }, context.projectId).catch(() => { });
          }

          // Forward trace to UI with subAgent tag
          // Sub-agents must NEVER emit 'answer' to the UI or it replays the typewriter
          if (onTrace && trace.type !== 'answer') {
            onTrace({
              ...trace,
              type: trace.type,
              text: trace.text,
              subAgent: name,
              subAgentId: agentId,
              subAgentChatId,
              agentName: name,
              agentStatus: instance.status === ('paused' as any) ? 'paused' : 'working',
              agentStep: traceEventCount
            });
          }
        }
      );

      // A provider may finish while cancellation is propagating. Never publish
      // that late result as successful work after the user stopped the run.
      if (
        isCancelled(context.projectId) ||
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
      });
      await agentMessageBus.writeAgentStatus(name, {
        status: 'completed', agentId, subAgentChatId,
        task,
        progress: 'Done',
        result: result.text,
        traceLog,
        startedAt: instance.startedAt,
        completedAt: instance.completedAt
      }, context.projectId);

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
      queuePendingResult({
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
      });
      const handoffPayload = boundedHandoffPayload(result.text);
      interAgentMailbox.send({
        from: name,
        to: 'Main',
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
        },
      });
      apiKeyPool.reportSuccess(`${context.projectId}_sub_${name}`);

      if (onTrace) {
        onTrace({
          type: 'sub_agent_complete',
          text: `${ name } completed`,
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

      return { agentId, name, result: result.text, success: true, durationMs, traceLog };
    } catch (error: any) {
      const durationMs = Date.now() - instance.startedAt;
      const wasCancelled = error.message === 'CANCELLED_BY_USER'
        || isCancelled(context.projectId)
        || (context as any).abortSignal?.aborted
        || isAgentClosed(context.projectId, name, agentId);
      if (!wasCancelled && lease) {
        apiKeyPool.reportFailure(`${context.projectId}_sub_${name}`, apiKeyPool.classifyError(error.message || ''), error.message || '');
      }

      instance.status = wasCancelled ? 'cancelled' : 'failed';
      instance.result = wasCancelled ? 'Cancelled by user' : error.message;
      instance.completedAt = Date.now();
      instance.durationMs = durationMs;
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
        status: wasCancelled ? 'cancelled' : 'failed',
        task,
        progress: wasCancelled ? 'Cancelled' : `Failed: ${ error.message }`,
      });
      await agentMessageBus.writeAgentStatus(name, {
        status: wasCancelled ? 'cancelled' : 'failed', agentId, subAgentChatId,
        task,
        progress: wasCancelled ? 'Cancelled' : `Failed: ${ error.message }`,
        result: instance.result,
        traceLog,
        startedAt: instance.startedAt,
        completedAt: instance.completedAt
      }, context.projectId);

      queuePendingResult({
        projectId: context.projectId,
        agentId,
        subAgentChatId,
        name,
        task,
        result: instance.result!,
        success: false,
        status: wasCancelled ? 'cancelled' : 'failed',
        delegationEvidence,
        durationMs,
        completedAt: instance.completedAt,
      });
      if (!wasCancelled) {
        const handoffPayload = boundedHandoffPayload(String(error.message || 'Unknown sub-agent failure'));
        interAgentMailbox.send({
          from: name,
          to: 'Main',
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
      this.activeAgents.delete(agentId);
      this.releaseSlot(agentId);
    }
  }

  /**
   * FIRE-AND-FORGET: Spawn multiple sub-agents in TRUE PARALLEL.
   * Returns IMMEDIATELY with agent names. Main agent continues working.
   * Sub-agents run in the background with their own API keys.
   * Main agent calls 'collect' later to get results.
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
    const occupiedSlots = this.getOccupiedSlotCount(context.projectId);
    const availableSlots = Math.max(0, getConfiguredSubAgentLimit(context) - occupiedSlots);
    const activeTasks = tasks.slice(0, availableSlots);
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
        name,
        task: taskItem.task,
      };
    });
    for (const plan of agentPlans) {
      this.slotReservations.set(plan.agentId, {
        projectId: resolveProjectId(context.projectId),
        name: plan.name,
      });
    }

    interAgentMailbox.registerAgent(context.projectId, 'Main', {
      role: 'main',
      status: 'coordinating',
      progress: `Managing ${teamSize} planned sub-agent(s)`,
    });
    activeTasks.forEach((taskItem, index) => {
      interAgentMailbox.registerAgent(context.projectId, agentNames[index], {
        agentId: agentPlans[index].agentId,
        subAgentChatId: agentPlans[index].subAgentChatId,
        role: 'sub_agent',
        task: taskItem.task,
        status: 'planned',
        progress: index === 0 ? 'Queued for immediate start' : 'Queued for parallel start',
      });
    });

    if (onTrace) {
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
            task: t.task.substring(0, 100),
            status: 'running'
          }))
        });
    }

    // Launch all agents in parallel — each with a staggered start and different API key
    activeTasks.forEach((t, index) => {
      const name = agentNames[index];
      const plan = agentPlans[index];
      const runKey = `${ context.projectId }:${ plan.agentId }`;

      // Fire-and-forget: start without awaiting
      const promise = (async () => {
        if (isCancelled(context.projectId)) {
          interAgentMailbox.updateAgentPresence(context.projectId, name, {
            status: 'cancelled',
            task: t.task,
            progress: 'Cancelled before start',
          });
          return;
        }
        
        // Minimal stagger: 500ms (was 2s) — each agent has its own key, minimal collision risk
        await this.spawnAgent(t.task, context, index, parentContext, onTrace, name, t, plan.agentId);
      })()
        .catch((error) => {
          console.error(`[SubAgent] Background run failed for ${ name }:`, error);
        })
        .finally(() => {
          this.releaseSlot(plan.agentId);
          this.backgroundPromises.delete(runKey);
          if (this.getBackgroundCount(context.projectId) === 0) {
            clearCancelState(context.projectId);
          }
        });

      this.backgroundPromises.set(runKey, { projectId: context.projectId, name, promise });
    });

    return {
      agentNames,
      agents: agentPlans,
      // Preserve every unlaunched task, including tasks beyond the configured
      // per-run limit. The old pre-slice silently discarded this tail.
      notStartedTasks: tasks.slice(activeTasks.length),
      message: teamSize > 0
        ? `${ teamSize } task-named agents spawned and working in background. ${activeTasks.length < tasks.length ? `${tasks.length - activeTasks.length} task(s) were not started because the configured concurrent-agent limit is already in use; spawn them after a slot opens. ` : ''}Continue YOUR work now. Results are automatically handed to Main and remain available through mode="collect".`
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
    const configuredTasks = limitConfiguredTasks(tasks, context);
    const availableSlots = Math.max(0, getConfiguredSubAgentLimit(context) - this.getOccupiedSlotCount(context.projectId));
    const activeTasks = configuredTasks.slice(0, availableSlots);
    const reservedNames = new Set<SubAgentName>();
    const agentNames = activeTasks.map((t) => {
      const name = this.resolveAgentName(context.projectId, t.task, t.name, reservedNames);
      reservedNames.add(name);
      return name;
    });
    const agentPlans = activeTasks.map((taskItem, index) => ({
      agentId: this.createAgentId(context.projectId, agentNames[index]),
      name: agentNames[index],
      task: taskItem,
    }));
    for (const plan of agentPlans) {
      this.slotReservations.set(plan.agentId, {
        projectId: resolveProjectId(context.projectId),
        name: plan.name,
      });
    }

    interAgentMailbox.registerAgent(context.projectId, 'Main', {
      role: 'main',
      status: 'coordinating',
      progress: `Waiting for ${activeTasks.length} parallel sub-agent(s)`,
    });
    activeTasks.forEach((taskItem, index) => {
      interAgentMailbox.registerAgent(context.projectId, agentNames[index], {
        role: 'sub_agent',
        task: taskItem.task,
        status: 'planned',
        progress: index === 0 ? 'Queued for immediate start' : 'Queued for parallel start',
      });
    });

    if (onTrace) {
      onTrace({
        type: 'command',
        text: `Spawning ${ activeTasks.length } parallel agents`,
        secondary: agentNames.join(' + '),
        spawnedAgents: agentNames
      });
    }

    const promises = activeTasks.map((t, index) => {
      const name = agentNames[index];
      const plan = agentPlans[index];
      return Promise.resolve().then(async () => {
        if (isCancelled(context.projectId)) {
          return { agentId: '', name, result: 'Cancelled', success: false, durationMs: 0, traceLog: [] };
        }
        // Minimal stagger: 500ms (was 2s) — each agent has its own key now
        return this.spawnAgent(t.task, context, index, parentContext, onTrace, name, t, plan.agentId);
      }).finally(() => this.releaseSlot(plan.agentId));
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
        name: agentNames[i],
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
        text: `${ successCount }/${ activeTasks.length } agents completed`,
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
      .filter(([, run]) => !projectId || isSameProjectScope(run.projectId, projectId));

    await Promise.allSettled(entries.map(([, run]) => run.promise));

    for (const [runKey, run] of entries) {
      if (!projectId || isSameProjectScope(run.projectId, projectId)) {
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
      .filter(run => isSameProjectScope(run.projectId, projectId)).length;
  }

  public getOccupiedSlotCount(projectId: string): number {
    const resolvedProjectId = resolveProjectId(projectId);
    const occupiedNames = new Set<string>();
    for (const agent of this.activeAgents.values()) {
      if (isSameProjectScope(agent.projectId, resolvedProjectId) && !['completed', 'failed', 'cancelled'].includes(agent.status)) {
        occupiedNames.add(agent.name.toLowerCase());
      }
    }
    for (const run of this.backgroundPromises.values()) {
      if (isSameProjectScope(run.projectId, resolvedProjectId)) occupiedNames.add(run.name.toLowerCase());
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
      agent.status !== 'cancelled'
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
      agent.status !== 'cancelled'
    )?.id;
  }

  public getAgentStatus(): SubAgentInstance[] {
    return Array.from(this.activeAgents.values());
  }

  public getAgentNames(): readonly string[] {
    return ['Task-Research', 'Runtime-Control', 'Interface-Review'];
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
      results: round1.results.map(r => ({ agent: r.name, result: r.result }))
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
      results: round2.results.map(r => ({ agent: r.name, result: r.result }))
    });

    // === SYNTHESIS: Calculate consensus and confidence ===
    const firstRebuttal = round2.results[0]?.result || '';
    const secondRebuttal = round2.results[1]?.result || '';

    // Confidence estimation based on agreement patterns
    const concessions = [firstRebuttal, secondRebuttal].filter(r =>
      r.toLowerCase().includes('concede') || r.toLowerCase().includes('agree') || r.toLowerCase().includes('correct')
    ).length;
    const confidenceScore = Math.min(0.95, 0.5 + (concessions * 0.15) + (round1.successCount === 2 ? 0.1 : 0));

    const synthesis = `━━━ MULTI-ROUND DEBATE RESULTS (Confidence: ${(confidenceScore * 100).toFixed(0)}%) ━━━

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

    const result = await this.spawnAgent(
      specialistBrief,
      context,
      0,
      `Specialist role: ${role}`,
      onTrace,
      specialistName
    );

    // Estimate confidence based on tool usage and completion
    const toolsUsed = result.traceLog.filter(l => l.includes('tool_call') || l.includes('action')).length;
    const confidence = Math.min(0.95, 0.4 + (toolsUsed * 0.05) + (result.success ? 0.2 : 0));

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
