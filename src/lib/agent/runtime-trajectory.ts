import type { RuntimeEvidenceLedger, RuntimeEvidenceNode } from './runtime-evidence';

export interface TrajectoryCycle {
  period: number;
  repetitions: number;
  evidenceIds: string[];
}

export interface RuntimeTrajectory {
  revision: number;
  lastActionSequence: number;
  freshObservationsSinceAction: number;
  repeatedObservations: number;
  pending: Array<{ evidenceId: string; toolName: string; workIds: string[]; summary: string }>;
  failures: Array<{ evidenceId: string; summary: string; targets: string[] }>;
  cycle?: TrajectoryCycle;
}

const completed = (node: RuntimeEvidenceNode) => node.success
  && (!node.outcome || node.outcome === 'completed');

/** Successful inspection is information, not a delivered implementation. */
export function isActionEvidence(node: RuntimeEvidenceNode): boolean {
  return completed(node) && (node.stateChanging || (
    node.materialProgress && ['command', 'artifact', 'external_action', 'verification'].includes(node.effect)
  ));
}

/**
 * Recognize repeated observed transitions, including A -> B -> A -> B loops.
 * Changed output or a completed state-changing action breaks the match. This
 * is a request to reconsider a tactic, never permission to skip or end work.
 */
function findCycle(nodes: RuntimeEvidenceNode[]): TrajectoryCycle | undefined {
  const window = nodes.filter(node => node.effect !== 'coordination'
    && node.outcome !== 'pending' && node.outcome !== 'noop').slice(-16);
  const identity = (node: RuntimeEvidenceNode): string | undefined => {
    if (node.stateChanging || isActionEvidence(node)) return undefined;
    if (!node.success) return `failure:${node.signature}:${node.summary}`;
    if (node.observation) return `read:${node.observation.key}:${node.observation.digest}`;
    return undefined;
  };
  const identities = window.map(identity);
  for (let period = 1; period <= Math.min(4, Math.floor(window.length / 2)); period++) {
    const suffix = identities.slice(-period);
    if (suffix.some(item => item === undefined)) continue;
    let repetitions = 1;
    while ((repetitions + 1) * period <= identities.length) {
      const start = identities.length - (repetitions + 1) * period;
      if (!suffix.every((item, index) => identities[start + index] === item)) break;
      repetitions++;
    }
    if (repetitions >= 2) {
      return { period, repetitions, evidenceIds: window.slice(-repetitions * period).map(node => node.id) };
    }
  }
  return undefined;
}

/** Reconstructed from durable evidence; no additional model or tool request. */
export function deriveRuntimeTrajectory(ledger: RuntimeEvidenceLedger): RuntimeTrajectory {
  const nodes = ledger.list();
  let lastActionSequence = 0;
  for (let index = nodes.length - 1; index >= 0; index--) {
    if (nodes[index].stateChanging || isActionEvidence(nodes[index])) {
      lastActionSequence = nodes[index].sequence;
      break;
    }
  }
  const recent = nodes.filter(node => node.sequence > lastActionSequence);
  return {
    revision: ledger.revision(),
    lastActionSequence,
    freshObservationsSinceAction: recent.filter(node => completed(node)
      && node.effect === 'observation' && !node.repeatedObservation).length,
    repeatedObservations: recent.slice(-8).filter(node => node.repeatedObservation).length,
    pending: ledger.pendingWork().map(node => ({
      evidenceId: node.id,
      toolName: node.toolName,
      workIds: [...new Set([...(node.pendingWorkIds || []), ...(node.workId ? [node.workId] : [])])],
      summary: node.summary,
    })),
    failures: ledger.unresolvedFailures().slice(-4).map(node => ({
      evidenceId: node.id, summary: node.summary, targets: [...node.targets],
    })),
    cycle: findCycle(recent),
  };
}
