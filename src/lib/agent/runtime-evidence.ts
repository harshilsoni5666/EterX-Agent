import {
  classifyToolSemantics,
  extractToolTargets,
  getToolResultOutcome,
  toolResultChangedState,
  toolResultMadeProgress,
  toolResultSucceeded,
  type ToolEffect,
  type ToolResultOutcome,
} from './tool-semantics';

export type RuntimeEvidenceKind =
  | 'artifact'
  | 'browser'
  | 'command'
  | 'edit'
  | 'failure'
  | 'read'
  | 'research'
  | 'safety'
  | 'verification';

export interface RuntimeEvidenceNode {
  id: string;
  sequence: number;
  timestamp: number;
  toolName: string;
  effect: ToolEffect;
  kind: RuntimeEvidenceKind;
  success: boolean;
  materialProgress: boolean;
  stateChanging: boolean;
  mutationEpoch: number;
  signature: string;
  summary: string;
  targets: string[];
  metrics: Record<string, number>;
  outcome?: ToolResultOutcome;
  workId?: string;
  /** Pending children of a compound call, settled individually by task ID. */
  pendingWorkIds?: string[];
}

export interface RuntimeEvidenceSnapshot {
  scopeId: string;
  sequence: number;
  mutationEpoch: number;
  nodes: RuntimeEvidenceNode[];
}

function truncate(value: unknown, max = 180): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function extractNumericMetrics(result: any): Record<string, number> {
  if (!result || typeof result !== 'object') return {};
  const metrics: Record<string, number> = {};
  const visit = (value: any, prefix: string, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 2) return;
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = prefix ? `${prefix}.${rawKey}` : rawKey;
      if (typeof rawValue === 'number' && Number.isFinite(rawValue)
        && /(?:score|quality|accuracy|pass|coverage|success|fitness|reward|benchmark|latency|duration)/i.test(rawKey)) {
        metrics[key] = rawValue;
      } else if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        visit(rawValue, key, depth + 1);
      }
    }
  };
  visit(result, '', 0);
  return metrics;
}

function classifyKind(toolName: string, effect: ToolEffect): RuntimeEvidenceKind {
  if (effect === 'verification') return 'verification';
  if (effect === 'mutation') return 'edit';
  if (effect === 'observation') {
    if (/web|research|scrap|rss|transcript/i.test(toolName)) return 'research';
    if (/browser|screen|screenshot|computer/i.test(toolName)) return 'browser';
    return 'read';
  }
  if (effect === 'external_action' && /browser|screen|computer|desktop/i.test(toolName)) return 'browser';
  if (effect === 'command') return 'command';
  return 'artifact';
}

function summarizeToolResult(
  toolName: string,
  args: Record<string, any>,
  result: any,
  effect: ToolEffect,
  targets: string[],
): string {
  const outcome = getToolResultOutcome(result);
  if (outcome === 'pending') return `${toolName}: accepted, still pending completion`;
  if (outcome === 'noop') return `${toolName}: ${truncate(result?.message || 'no action performed')}`;
  if (result?.error) return `${toolName} failed: ${truncate(result.error)}`;
  if (Array.isArray(result?.errors) && result.errors.length > 0) {
    return `${toolName} failed: ${truncate(result.errors.join('; '))}`;
  }
  if (outcome === 'failed') return `${toolName} failed: ${truncate(result?.message || result?.status || 'unsuccessful result')}`;
  if (result?.summary) return truncate(result.summary);
  if (effect === 'verification') {
    const command = args?.command ? ` ${truncate(args.command, 90)}` : '';
    return `${toolName}${command} verified mutation epoch`;
  }
  if (effect === 'mutation') {
    return `${toolName} changed ${targets[0] ? truncate(targets[0], 100) : 'workspace state'}`;
  }
  if (effect === 'external_action') {
    return `${toolName} completed an external action${targets[0] ? ` for ${truncate(targets[0], 100)}` : ''}`;
  }
  const target = targets[0] || args?.query || args?.topic || args?.command || '';
  return target ? `${toolName}: ${truncate(target)}` : `${toolName} completed`;
}

/**
 * Immutable, causally ordered evidence for one run.
 *
 * A mutation advances the epoch. Verification only proves the epoch it
 * observed, so a later mutation automatically makes earlier checks stale.
 * This is the substrate used by the adaptive harness and is intentionally
 * independent of any model provider or prompt format.
 */
export class RuntimeEvidenceLedger {
  private nodes: RuntimeEvidenceNode[] = [];
  private sequence = 0;
  private mutationEpoch = 0;

  constructor(
    private readonly scopeId: string = 'default',
    snapshot?: RuntimeEvidenceSnapshot | null,
  ) {
    if (snapshot) this.restore(snapshot);
  }

  recordTool(toolName: string, args: Record<string, any> = {}, result: any = {}): RuntimeEvidenceNode {
    const semantics = classifyToolSemantics(toolName, args);
    const outcome = getToolResultOutcome(result);
    const success = toolResultSucceeded(result);
    const changedState = toolResultChangedState(result, semantics);
    if (changedState) this.mutationEpoch++;

    const targets = extractToolTargets(args, result);
    const workId = String(result?.taskId || result?.backgroundTaskId || args?.taskId || '').trim() || undefined;
    const pendingWorkIds = Array.isArray(result?.results)
      ? [...new Set<string>(result.results
        .filter((entry: any) => getToolResultOutcome(entry) === 'pending')
        .map((entry: any) => String(entry?.taskId || entry?.backgroundTaskId || '').trim())
        .filter(Boolean))]
      : [];
    const pendingOrigin = workId ? [...this.nodes].reverse().find(node =>
      node.toolName === toolName && (
        node.workId === workId && node.outcome === 'pending' || node.pendingWorkIds?.includes(workId)
      ),
    ) : undefined;
    const effect = pendingOrigin?.effect === 'verification' ? 'verification' : semantics.effect;
    const observedEpoch = pendingOrigin?.effect === 'verification' ? pendingOrigin.mutationEpoch : this.mutationEpoch;
    const node: RuntimeEvidenceNode = {
      id: `${this.scopeId}-${Date.now()}-${++this.sequence}`,
      sequence: this.sequence,
      timestamp: Date.now(),
      toolName,
      effect,
      kind: !success ? 'failure' : outcome === 'pending' ? 'command' : classifyKind(toolName, effect),
      success,
      materialProgress: toolResultMadeProgress(result, semantics),
      stateChanging: changedState,
      mutationEpoch: observedEpoch,
      signature: `${toolName}:${stableSerialize(args)}`,
      summary: summarizeToolResult(toolName, args, result, effect, targets),
      targets,
      metrics: extractNumericMetrics(result),
      outcome,
      workId,
      ...(pendingWorkIds.length ? { pendingWorkIds } : {}),
    };
    this.nodes.push(node);
    return node;
  }

  list(): RuntimeEvidenceNode[] {
    return [...this.nodes];
  }

  currentMutationEpoch(): number {
    return this.mutationEpoch;
  }

  hasVerificationEvidence(): boolean {
    return this.nodes.some(node => node.success && (!node.outcome || node.outcome === 'completed') && node.effect === 'verification');
  }

  hasFreshVerificationEvidence(): boolean {
    const lastMutation = this.lastSuccessfulMutation();
    if (!lastMutation) return this.hasVerificationEvidence();
    return this.nodes.some(node =>
      node.success
      && (!node.outcome || node.outcome === 'completed')
      && node.effect === 'verification'
      && node.mutationEpoch === this.mutationEpoch
      && node.sequence > lastMutation.sequence,
    );
  }

  hasWorkEvidence(): boolean {
    return this.nodes.some(node => node.success && node.materialProgress);
  }

  hasEffect(effect: ToolEffect): boolean {
    return this.nodes.some(node => node.success && (!node.outcome || node.outcome === 'completed') && node.effect === effect);
  }

  lastSuccessfulMutation(): RuntimeEvidenceNode | null {
    return [...this.nodes].reverse().find(node =>
      node.stateChanging === true,
    ) || null;
  }

  latestVerification(): RuntimeEvidenceNode | null {
    return [...this.nodes].reverse().find(node => node.effect === 'verification' && node.outcome !== 'pending' && node.outcome !== 'noop') || null;
  }

  unresolvedFailures(): RuntimeEvidenceNode[] {
    const resolvedSignatures = new Set<string>();
    const unresolved: RuntimeEvidenceNode[] = [];
    for (const node of [...this.nodes].reverse()) {
      if (node.success) {
        if (!node.outcome || node.outcome === 'completed') resolvedSignatures.add(node.signature);
        continue;
      }
      if (!resolvedSignatures.has(node.signature)) unresolved.push(node);
    }
    return unresolved.reverse();
  }

  pendingWork(): RuntimeEvidenceNode[] {
    const settled = new Set<string>();
    const pending: RuntimeEvidenceNode[] = [];
    for (const node of [...this.nodes].reverse()) {
      if (node.pendingWorkIds?.length) {
        const outstanding = node.pendingWorkIds.filter(id => !settled.has(`${node.toolName}:${id}`));
        outstanding.forEach(id => settled.add(`${node.toolName}:${id}`));
        if (outstanding.length) pending.push({ ...node, pendingWorkIds: outstanding });
        // Do not retain an unresolvable parent signature once its children
        // have all delivered terminal results under their individual IDs.
        if (!node.workId) continue;
      }
      const identity = node.workId ? `${node.toolName}:${node.workId}` : node.signature;
      if (settled.has(identity)) continue;
      settled.add(identity);
      if (node.outcome === 'pending') pending.push(node);
    }
    return pending.reverse();
  }

  successfulResearchCount(): number {
    return this.nodes.filter(node => node.success && (!node.outcome || node.outcome === 'completed') && node.kind === 'research').length;
  }

  materialProgressCount(): number {
    return this.nodes.filter(node => node.materialProgress).length;
  }

  summarize(maxItems = 6): string[] {
    return this.nodes
      .filter(node => node.success)
      .slice(-maxItems)
      .map(node => `${node.effect}: ${node.summary}`);
  }

  snapshot(): RuntimeEvidenceSnapshot {
    return {
      scopeId: this.scopeId,
      sequence: this.sequence,
      mutationEpoch: this.mutationEpoch,
      nodes: this.nodes.map(node => ({ ...node, targets: [...node.targets], metrics: { ...node.metrics }, ...(node.pendingWorkIds ? { pendingWorkIds: [...node.pendingWorkIds] } : {}) })),
    };
  }

  private restore(snapshot: RuntimeEvidenceSnapshot): void {
    this.sequence = Math.max(0, Number(snapshot.sequence) || 0);
    this.mutationEpoch = Math.max(0, Number(snapshot.mutationEpoch) || 0);
    this.nodes = Array.isArray(snapshot.nodes)
      ? snapshot.nodes.map(node => ({ ...node, targets: [...(node.targets || [])], metrics: { ...(node.metrics || {}) }, ...(node.pendingWorkIds ? { pendingWorkIds: [...node.pendingWorkIds] } : {}) }))
      : [];
  }
}
