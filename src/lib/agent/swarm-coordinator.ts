import path from 'path';
import fs from 'fs';
import { assessDelegatedAgent } from './delegation-evidence';
import { SUB_AGENT_MODEL_SELECTION_GUIDANCE } from './sub-agent-model-guidance';
import { SUB_AGENT_SPAWN_GUIDANCE } from './sub-agent-spawn-guidance';

export type WorkClaim = { path: string; access: 'read' | 'write' };
export type SwarmContract = {
  key?: string;
  dependsOn?: string[];
  acceptance?: string;
  rationale?: string;
  resources?: WorkClaim[];
  priority?: number;
};
export type SwarmNodeState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'blocked';
export type SwarmNode = SwarmContract & {
  id: string; name: string; task: string; projectId: string; scope: string;
  parentAgentId?: string; parentAgentName: string; depth: number;
  state: SwarmNodeState; reason?: string; createdAt: number; updatedAt: number;
  dependencies: string[]; claims: WorkClaim[]; resourceScope: boolean; fingerprint: string;
  resultSummary?: string; evidenceReady?: boolean; attempt: number;
  phaseStartedAt: number; queuedMs: number; runningMs: number; waitingMs: number;
};

const terminal = new Set<SwarmNodeState>(['completed', 'failed', 'cancelled', 'blocked']);
export const SWARM_LIMITS = { maxNodes: 1024, maxDepth: 8, globalConcurrency: 64, maxBatch: 64, maxAssignmentChars: 2_000_000, maxBatchAssignmentChars: 256_000 } as const;
const assignmentChars = (task: SwarmContract & { task: string }) => task.task.length + (task.acceptance?.length || 0)
  + (task.rationale?.length || 0) + (task.key?.length || 0) + (task.resources || []).reduce((sum, claim) => sum + claim.path.length, 0);
const scopeFor = (context: any) => `${context.projectId}:${context.swarmRunId || context.runId || context.turnId || 'session'}`;
const normalizePath = (value: string, root: string) => {
  let candidate = path.resolve(root, value);
  const missing: string[] = [];
  while (!fs.existsSync(candidate) && path.dirname(candidate) !== candidate) { missing.unshift(path.basename(candidate)); candidate = path.dirname(candidate); }
  try { candidate = fs.realpathSync.native(candidate); } catch { /* The tool's workspace policy reports inaccessible paths. */ }
  const resolved = path.join(candidate, ...missing).replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const contains = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
const overlaps = (a: WorkClaim, b: WorkClaim) => (a.access === 'write' || b.access === 'write') && (contains(a.path, b.path) || contains(b.path, a.path));

/** In-process coordination ledger. Provider slots and retained results stay in
 * SubAgentSpawner; this ledger owns admission, DAG readiness and edit claims.
 * All admission/claim transitions are synchronous, before any provider await. */
class SwarmCoordinator {
  private nodes = new Map<string, SwarmNode>();
  private scopes = new Map<string, Set<string>>();
  private children = new Map<string, Set<string>>();
  private listeners = new Map<string, Set<() => void>>();
  private revisions = new Map<string, number>();
  private generation = 0;
  private nextReady = new Map<string, { generation: number; id?: string }>();
  private writeLeases = new Map<symbol, { projectId: string; owner?: string; claims: WorkClaim[] }>();
  private clearingProjects = new Set<string>();

  get(id?: string) { return id ? this.nodes.get(id) : undefined; }
  isTerminal(id: string) { const node = this.get(id); return Boolean(node && terminal.has(node.state)); }
  private changed(node: SwarmNode) {
    this.generation++;
    node.updatedAt = Date.now();
    this.revisions.set(node.projectId, (this.revisions.get(node.projectId) || 0) + 1);
    for (const wake of this.listeners.get(node.projectId) || []) wake();
  }
  subscribe(projectId: string, wake: () => void) {
    const listeners = this.listeners.get(projectId) || new Set();
    listeners.add(wake); this.listeners.set(projectId, listeners);
    return () => { listeners.delete(wake); if (!listeners.size) this.listeners.delete(projectId); };
  }

  admit(plans: Array<SwarmContract & { id: string; name: string; task: string }>, context: any): SwarmNode[] {
    if (context.abortSignal?.aborted || (typeof context.isCancelled === 'function' && context.isCancelled())) throw new Error('This execution was cancelled; no new tasks were admitted.');
    if (this.clearingProjects.has(context.projectId)) throw new Error('Retained task data is being cleared. Wait for that operation to finish before delegating.');
    const scope = scopeFor(context);
    const parent = this.get(context.subAgentId);
    const depth = parent ? parent.depth + 1 : Number(context.agentDepth || 0) + 1;
    if (context.isSubAgent && (!parent || parent.scope !== scope || terminal.has(parent.state))) throw new Error('The delegating agent no longer owns an active swarm task.');
    if (depth > SWARM_LIMITS.maxDepth) throw new Error(`Delegation depth is limited to ${SWARM_LIMITS.maxDepth}; complete or consolidate this work locally.`);
    const members = this.scopes.get(scope) || new Set<string>();
    if (members.size + plans.length > SWARM_LIMITS.maxNodes) throw new Error(`This run has a ${SWARM_LIMITS.maxNodes}-task budget. Reuse existing workers or complete remaining work locally.`);
    if (plans.length > SWARM_LIMITS.maxBatch) throw new Error(`Admit at most ${SWARM_LIMITS.maxBatch} tasks per batch.`);
    const batchChars = plans.reduce((sum, plan) => sum + assignmentChars(plan), 0);
    const existingChars = [...members].reduce((sum, id) => sum + assignmentChars(this.nodes.get(id)!), 0);
    if (batchChars > SWARM_LIMITS.maxBatchAssignmentChars || existingChars + batchChars > SWARM_LIMITS.maxAssignmentChars) throw new Error('The assignment-text budget is exhausted for this frontier or run. Use concise task contracts and shared artifact references instead of copying entire documents into each task.');
    const root = String(context.workspacePath || context.workspaceRoot || context.scratchRoot || process.cwd());
    const keys = new Map<string, string>();
    for (const id of members) { const node = this.nodes.get(id)!; if (node.key) keys.set(node.key, id); keys.set(id, id); }
    for (const plan of plans) {
      if (keys.has(plan.id) || (plan.key && keys.has(plan.key))) throw new Error(`Task key already exists: ${plan.key || plan.id}. Reuse its run ID.`);
      keys.set(plan.id, plan.id); if (plan.key) keys.set(plan.key, plan.id);
    }
    const ancestors = new Set<string>();
    let ancestor = parent;
    while (ancestor) { ancestors.add(ancestor.id); ancestor = this.get(ancestor.parentAgentId); }
    const fingerprints = new Set([...members].map(id => this.nodes.get(id)!).filter(n => !terminal.has(n.state)).map(n => n.fingerprint));
    const admitted = plans.map(plan => {
      const fingerprint = plan.task.trim().replace(/\s+/g, ' ').toLowerCase();
      if (fingerprints.has(fingerprint)) throw new Error(`An active agent already owns this exact task. Send a scoped follow-up instead: ${plan.name}.`);
      fingerprints.add(fingerprint);
      const dependencies = [...new Set((plan.dependsOn || []).map(key => {
        const id = keys.get(key);
        if (!id) throw new Error(`Unknown dependency "${key}". Use a task key in this batch or an existing run ID in this run.`);
        if (id === plan.id || ancestors.has(id)) throw new Error('A task cannot depend on itself or an ancestor that must wait for it.');
        return id;
      }))];
      const resourceScope = plan.resources !== undefined || parent?.resourceScope === true;
      const claims = plan.resources === undefined && parent?.resourceScope
        ? parent.claims.map(claim => ({ ...claim }))
        : (plan.resources || []).map(claim => ({ ...claim, path: normalizePath(claim.path, root) }));
      if (parent?.resourceScope && claims.some(claim => !parent.claims.some(owned => contains(owned.path, claim.path) && (claim.access === 'read' || owned.access === 'write')))) {
        throw new Error('A child resource claim exceeds its parent assignment. Ask the parent owner to expand the scope explicitly.');
      }
      return { ...plan, projectId: context.projectId, scope, parentAgentId: parent?.id,
        parentAgentName: parent?.name || 'Main', depth,
        state: 'queued' as const, createdAt: Date.now(), updatedAt: Date.now(),
        phaseStartedAt: Date.now(), queuedMs: 0, runningMs: 0, waitingMs: 0, attempt: 0,
        claims, resourceScope, dependencies, fingerprint } satisfies SwarmNode;
    });
    const graph = new Map([...members].map(id => [id, this.nodes.get(id)!]));
    admitted.forEach(node => graph.set(node.id, node));
    // Kahn's algorithm avoids recursive stack growth on long dependency chains.
    const incoming = new Map<string, number>(); const downstream = new Map<string, string[]>();
    const childrenByParent = new Map<string, string[]>();
    for (const node of graph.values()) if (node.parentAgentId) childrenByParent.set(node.parentAgentId, [...(childrenByParent.get(node.parentAgentId) || []), node.id]);
    for (const node of graph.values()) {
      // Parent completion joins its children. Include those implicit edges to
      // reject sibling/ancestor wait cycles, not just explicit DAG cycles.
      const dependencies = [...new Set([...node.dependencies, ...(childrenByParent.get(node.id) || [])])];
      incoming.set(node.id, dependencies.length);
      for (const dependency of dependencies) downstream.set(dependency, [...(downstream.get(dependency) || []), node.id]);
    }
    const ready = [...incoming].filter(([, count]) => !count).map(([id]) => id);
    let visited = 0;
    for (let i = 0; i < ready.length; i++) {
      visited++;
      for (const id of downstream.get(ready[i]) || []) { const count = incoming.get(id)! - 1; incoming.set(id, count); if (!count) ready.push(id); }
    }
    if (visited !== graph.size) throw new Error('The task graph contains a dependency cycle. No tasks in this batch were admitted.');
    for (const node of admitted) {
      this.nodes.set(node.id, node); members.add(node.id);
      if (node.parentAgentId) { const children = this.children.get(node.parentAgentId) || new Set<string>(); children.add(node.id); this.children.set(node.parentAgentId, children); }
    }
    this.scopes.set(scope, members);
    admitted.forEach(node => this.changed(node));
    this.prune();
    return admitted;
  }

  private ready(node: SwarmNode): boolean {
    if (node.state !== 'queued') return false;
    for (const id of node.dependencies) {
      const dependency = this.get(id);
      if (dependency && terminal.has(dependency.state) && !dependency.evidenceReady) {
        this.settle(node.id, 'blocked', `Dependency ${dependency.name} ended without usable evidence.`); return false;
      }
      if (dependency?.state !== 'completed' || !dependency.evidenceReady) { node.reason = 'Waiting for dependency evidence'; return false; }
    }
    for (const other of this.nodes.values()) {
      if (other.id !== node.id && other.state === 'running' && node.claims.some(a => other.claims.some(b => overlaps(a, b)))) {
        node.reason = `Waiting for resource ownership held by ${other.name}`; return false;
      }
    }
    for (const lease of this.writeLeases.values()) if (node.claims.some(a => lease.claims.some(b => overlaps(a, b)))) {
      node.reason = 'Waiting for an in-flight file edit to finish'; return false;
    }
    node.reason = 'Waiting for execution capacity';
    return true;
  }

  canStart(id: string): boolean {
    const node = this.get(id);
    if (!node) return true; // Older direct conversation continuations.
    if (this.clearingProjects.has(node.projectId)) return false;
    if (node.state !== 'queued') return false;
    const cached = this.nextReady.get(node.projectId);
    if (cached?.generation === this.generation) return cached.id === id;
    // Priority plus age: old ready work eventually outranks fresh high priority work.
    const score = (item: SwarmNode) => (item.priority || 0) + (Date.now() - item.createdAt) / 30_000;
    const queue = [...this.nodes.values()].filter(candidate => candidate.projectId === node.projectId && candidate.state === 'queued')
      .sort((a, b) => score(b) - score(a) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const next = queue.find(candidate => this.ready(candidate));
    this.nextReady.set(node.projectId, { generation: this.generation, id: next?.id });
    return next?.id === id;
  }
  private transition(node: SwarmNode, state: SwarmNodeState, reason?: string) {
    const elapsed = Math.max(0, Date.now() - node.phaseStartedAt);
    if (node.state === 'queued') node.queuedMs += elapsed;
    else if (node.state === 'running') node.runningMs += elapsed;
    else if (node.state === 'waiting') node.waitingMs += elapsed;
    node.phaseStartedAt = Date.now(); node.state = state; node.reason = reason;
    this.changed(node);
  }
  start(id: string) { const node = this.get(id); if (node) this.transition(node, 'running'); }
  reopen(id: string) {
    const node = this.get(id);
    if (node && terminal.has(node.state)) {
      node.evidenceReady = false;
      node.resultSummary = undefined;
      node.attempt = (node.attempt || 0) + 1;
      this.transition(node, 'queued', 'Continuing a direct user conversation');
    }
  }
  suspend(id: string) { const node = this.get(id); if (node && !terminal.has(node.state)) this.transition(node, 'waiting', 'Joining delegated work'); }
  resume(id: string) { const node = this.get(id); if (node && node.state === 'waiting') this.transition(node, 'queued'); }
  settle(id: string, state: SwarmNodeState, reason?: string, result?: string) {
    const node = this.get(id); if (!node || terminal.has(node.state)) return;
    node.evidenceReady = state === 'completed' && assessDelegatedAgent({ status: state, result }).evidenceReady;
    node.resultSummary = result?.slice(0, 2000);
    this.transition(node, state, reason);
  }
  descendants(id: string): SwarmNode[] {
    const result: SwarmNode[] = []; const queue = [id];
    for (let i = 0; i < queue.length; i++) for (const child of this.children.get(queue[i]) || []) {
      const node = this.get(child); if (node) { result.push(node); queue.push(child); }
    }
    return result;
  }
  cancelBranch(id: string, reason: string): SwarmNode[] {
    const nodes = [this.get(id), ...this.descendants(id)].filter((n): n is SwarmNode => Boolean(n));
    for (const node of nodes) if (!terminal.has(node.state)) this.settle(node.id, 'cancelled', reason);
    return nodes;
  }
  cancelProject(projectId: string) { for (const node of this.nodes.values()) if (node.projectId === projectId && !terminal.has(node.state)) this.settle(node.id, 'cancelled', 'Stopped by user'); }
  beginResultCleanup(projectId: string): () => void {
    if (this.clearingProjects.has(projectId) || [...this.nodes.values()].some(node => node.projectId === projectId && !terminal.has(node.state))) throw new Error('Finish or close active tasks before clearing retained data.');
    this.clearingProjects.add(projectId);
    // Keep task-budget accounting and identity tombstones. Cleared evidence
    // cannot satisfy a future dependency or reset this run's admission budget.
    for (const node of this.nodes.values()) if (node.projectId === projectId) {
      node.evidenceReady = false; node.resultSummary = undefined; node.reason = 'Retained reports were cleared'; this.changed(node);
    }
    return () => {
      this.clearingProjects.delete(projectId);
      this.generation++;
      for (const wake of this.listeners.get(projectId) || []) wake();
    };
  }
  snapshot(context: any, offset = 0, limit = 50) {
    const all = [...(this.scopes.get(scopeFor(context)) || [])].map(id => this.nodes.get(id)!);
    const counts: Record<string, number> = {};
    all.forEach(node => { counts[node.state] = (counts[node.state] || 0) + 1; });
    const now = Date.now();
    const elapsed = (node: SwarmNode, state: SwarmNodeState) => node.state === state ? Math.max(0, now - node.phaseStartedAt) : 0;
    return { revision: this.revisions.get(context.projectId) || 0, total: all.length, counts,
      remainingTaskBudget: SWARM_LIMITS.maxNodes - all.length,
      remainingAssignmentChars: SWARM_LIMITS.maxAssignmentChars - all.reduce((sum, node) => sum + assignmentChars(node), 0),
      observedTiming: { queuedMs: all.reduce((sum, node) => sum + node.queuedMs + elapsed(node, 'queued'), 0), runningMs: all.reduce((sum, node) => sum + node.runningMs + elapsed(node, 'running'), 0), waitingMs: all.reduce((sum, node) => sum + node.waitingMs + elapsed(node, 'waiting'), 0), note: 'Accumulated worker time, not wall-clock speedup or verified quality.' },
      nodes: all.slice(offset, offset + limit).map(({ fingerprint: _, task, claims, ...node }) => ({ ...node, task: task.slice(0, 600), resources: claims })),
      nextOffset: offset + limit < all.length ? offset + limit : null };
  }

  /** Claims coordinate declared filesystem access; they are not an OS sandbox.
   * Existing permission and command policies remain authoritative. */
  writeConflict(context: any, targets: string[]): string | undefined {
    const root = String(context.workspacePath || context.workspaceRoot || context.scratchRoot || process.cwd());
    const owner = this.get(context.subAgentId);
    for (const target of targets) {
      const normalized = normalizePath(target, root);
      if (owner?.resourceScope && !owner.claims.some(claim => claim.access === 'write' && contains(claim.path, normalized))) return `This task has no write ownership for ${target}. Coordinate a new scoped assignment before editing.`;
      for (const node of this.nodes.values()) if (node.id !== owner?.id && node.state === 'running' && node.claims.some(claim => overlaps({ path: normalized, access: 'write' }, claim))) return `${target} is owned by ${node.name}. Coordinate or wait for that task to settle before editing.`;
    }
    return undefined;
  }
  holdWrites(context: any, targets: string[]): () => void {
    const conflict = this.writeConflict(context, targets);
    if (conflict) throw new Error(conflict);
    const root = String(context.workspacePath || context.workspaceRoot || context.scratchRoot || process.cwd());
    const key = Symbol('workspace-edit');
    this.writeLeases.set(key, { projectId: context.projectId, owner: context.subAgentId,
      claims: targets.map(target => ({ path: normalizePath(target, root), access: 'write' })) });
    this.generation++;
    return () => {
      if (!this.writeLeases.delete(key)) return;
      this.generation++;
      for (const listeners of this.listeners.values()) for (const wake of listeners) wake();
    };
  }
  private prune() {
    // Keep active graphs and a bounded tail of finished runs. No active result
    // or dependency is evicted to make room for another task in the same run.
    if (this.scopes.size <= 32) return;
    for (const [scope, ids] of this.scopes) {
      if (this.scopes.size <= 32) break;
      if ([...ids].some(id => !terminal.has(this.nodes.get(id)!.state))) continue;
      for (const id of ids) { this.nodes.delete(id); this.children.delete(id); }
      this.scopes.delete(scope);
    }
  }
}

const state = globalThis as typeof globalThis & { __eterxSwarmCoordinator?: SwarmCoordinator };
export const swarmCoordinator = state.__eterxSwarmCoordinator ||= new SwarmCoordinator();

export const SWARM_MODE_INSTRUCTION = `The user selected Swarm Mode. Deliberately organize this request as a coordinated task graph using spawn_sub_agent. Delegate at least one useful, bounded outcome when tools and the request permit it; explain a genuine inability instead of fabricating busywork. Team size is not a goal. Identify uncertainty, independent outcomes, critical dependencies, acceptance evidence and shared resources before expansion. Use task-specific roles, not a preset frontend/backend/reviewer team. Supply a rationale and acceptance condition for each assignment, task keys and dependsOn for ordered work, and read/write resources for shared files. Start a small frontier and expand only when new independent work justifies its cost. Every worker may delegate a narrower outcome and remains accountable for integrating its children. Use targeted messages and parent handoffs; broadcast only discoveries that change the whole team's work. Never treat lifecycle completion as proof of correctness. Reuse evidence, reconcile disagreements and integrate all required branches before answering. User restrictions, tool permissions and model selection remain in force.

${SUB_AGENT_MODEL_SELECTION_GUIDANCE}

${SUB_AGENT_SPAWN_GUIDANCE}`;
