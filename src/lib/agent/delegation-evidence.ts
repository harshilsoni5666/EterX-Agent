import { createHash } from 'crypto';

export type DelegationResultUsability = 'pending' | 'usable' | 'empty' | 'failed' | 'cancelled';
export type DelegationVerificationStatus = 'verified' | 'unverified' | 'unspecified';

export interface DelegatedAgentEvidence {
  agentId: string;
  subAgentChatId: string;
  name: string;
  task: string;
  status: string;
  collected: boolean;
  resultAvailable: boolean;
  resultUsability: DelegationResultUsability;
  evidenceReady: boolean;
  verificationStatus: DelegationVerificationStatus;
  resultChars: number;
  resultHash: string;
  resultSummary: string;
  payloadTruncated?: boolean;
  completedAt?: number;
}

export interface DelegationCollectionSummary {
  expectedCount: number;
  terminalCount: number;
  usableCount: number;
  pendingCount: number;
  emptyCount: number;
  failedCount: number;
  cancelledCount: number;
  evidenceReady: boolean;
  fullyGrounded: boolean;
  unresolvedAgents: Array<{ name: string; state: DelegationResultUsability }>;
  collectedAt: number;
}

export interface DelegationTelemetry {
  kind: 'spawn' | 'result' | 'collection';
  summary: string;
  agents: DelegatedAgentEvidence[];
  collection?: DelegationCollectionSummary;
}

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value).trim(); } catch { return String(value).trim(); }
};

const compact = (value: unknown, max = 1600): string => {
  const text = textOf(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const head = Math.max(240, Math.floor(max * 0.72));
  const tail = Math.max(120, max - head - 24);
  return `${text.slice(0, head)} … ${text.slice(-tail)}`;
};

const resultHash = (value: string): string => value
  ? createHash('sha256').update(value).digest('hex').slice(0, 20)
  : '';

function isPlaceholderResult(value: string): boolean {
  const normalized = value.replace(/[\s.!_*`#:-]+/g, ' ').trim().toLowerCase();
  if (!normalized) return true;
  return /^(?:ok|done|complete|completed|success|successful|no result(?: yet)?|no data(?: found)?|pending|still running|n\/a|none|unknown|cancelled(?: by user)?)$/.test(normalized);
}

function verificationStatus(value: string): DelegationVerificationStatus {
  if (/\bverified\s*[:=-]?\s*(?:yes|true|passed|complete)|\btests?\s+(?:passed|succeeded)|\bvalidation\s+(?:passed|succeeded)\b/i.test(value)) {
    return 'verified';
  }
  if (/\bverified\s*[:=-]?\s*(?:no|false|not)|\bnot\s+verified\b|\btests?\s+(?:failed|not run)\b/i.test(value)) {
    return 'unverified';
  }
  return 'unspecified';
}

export function assessDelegatedAgent(input: any, collected = false): DelegatedAgentEvidence {
  const status = String(input?.status || (input?.success === false ? 'failed' : '')).toLowerCase();
  const result = textOf(input?.result);
  const pending = ['spawning', 'planned', 'queued', 'running', 'paused', 'waiting'].includes(status);
  const failed = status === 'failed' || input?.success === false;
  const cancelled = status === 'cancelled';
  // Semantic payloads can legitimately be terse ("Use Redis", a number, a
  // path, or a single identifier). Reject known lifecycle placeholders rather
  // than imposing a length threshold that would erase concise real evidence.
  const substantive = !isPlaceholderResult(result);
  const usability: DelegationResultUsability = pending
    ? 'pending'
    : cancelled
      ? 'cancelled'
      : failed
        ? 'failed'
        : substantive
          ? 'usable'
          : 'empty';
  return {
    agentId: String(input?.agentId || input?.subAgentId || ''),
    subAgentChatId: String(input?.subAgentChatId || ''),
    name: String(input?.name || input?.agentName || input?.subAgent || 'Sub-agent'),
    task: compact(input?.task || input?.secondary || '', 800),
    status: status || (substantive ? 'completed' : 'unknown'),
    // A collect attempt while a worker is still running does not consume a
    // future payload. Only a terminal snapshot can be considered collected.
    collected: Boolean(collected || input?.collected) && !pending,
    resultAvailable: Boolean(result) && !isPlaceholderResult(result),
    resultUsability: usability,
    evidenceReady: usability === 'usable',
    verificationStatus: ['verified', 'unverified', 'unspecified'].includes(String(input?.verificationStatus))
      ? input.verificationStatus
      : verificationStatus(result),
    resultChars: Number.isFinite(Number(input?.resultChars)) ? Number(input.resultChars) : result.length,
    resultHash: String(input?.resultHash || resultHash(result)),
    resultSummary: substantive ? compact(result, 1800) : compact(result || 'No usable result payload.', 300),
    payloadTruncated: input?.payloadTruncated === true,
    completedAt: Number(input?.completedAt) || undefined,
  };
}

export function summarizeDelegationCollection(
  evidence: DelegatedAgentEvidence[],
  collectedAt = Date.now(),
): DelegationCollectionSummary {
  const count = (state: DelegationResultUsability) => evidence.filter(item => item.resultUsability === state).length;
  const pendingCount = count('pending');
  const usableCount = count('usable');
  const emptyCount = count('empty');
  const failedCount = count('failed');
  const cancelledCount = count('cancelled');
  const terminalCount = evidence.length - pendingCount;
  return {
    expectedCount: evidence.length,
    terminalCount,
    usableCount,
    pendingCount,
    emptyCount,
    failedCount,
    cancelledCount,
    evidenceReady: usableCount > 0,
    fullyGrounded: evidence.length > 0 && usableCount === evidence.length,
    unresolvedAgents: evidence
      .filter(item => item.resultUsability !== 'usable')
      .map(item => ({ name: item.name, state: item.resultUsability })),
    collectedAt,
  };
}

export function formatDelegationCollection(summary: DelegationCollectionSummary): string {
  if (summary.expectedCount === 0) {
    return 'No delegated result was available. This collection contains no delegation evidence.';
  }
  const parts = [
    `${summary.usableCount}/${summary.expectedCount} delegated result payloads are usable`,
    summary.pendingCount ? `${summary.pendingCount} still pending` : '',
    summary.emptyCount ? `${summary.emptyCount} completed without usable content` : '',
    summary.failedCount ? `${summary.failedCount} failed` : '',
    summary.cancelledCount ? `${summary.cancelledCount} cancelled` : '',
  ].filter(Boolean);
  return `${parts.join('; ')}. ${summary.fullyGrounded
    ? 'The returned payloads may be integrated according to their actual content.'
    : 'Use only payloads marked usable; never infer findings for unresolved agents.'}`;
}

export function delegationTelemetryFromTrace(trace: any): DelegationTelemetry | null {
  const type = String(trace?.type || '');
  const tool = String(trace?.tool || trace?.toolName || trace?.name || '');
  const args = trace?.toolArgs || trace?.args || trace?.input || {};
  const result = trace?.result ?? trace?.toolResult ?? trace?.output;

  if (type === 'sub_agent_spawn') {
    const details = Array.isArray(trace?.agentDetails)
      ? trace.agentDetails
      : [{
          agentId: trace?.subAgentId,
          subAgentChatId: trace?.subAgentChatId,
          name: trace?.subAgent || trace?.agentName,
          task: trace?.task || trace?.secondary,
          status: 'running',
        }];
    const agents = details.map((item: any) => assessDelegatedAgent({ ...item, status: item?.status || 'running' }, false));
    return { kind: 'spawn', agents, summary: `${agents.length} delegated assignment${agents.length === 1 ? '' : 's'} started.` };
  }

  if (type === 'inter_agent_message' && trace?.automaticHandoff === true) {
    const failed = String(trace?.messageType || '') === 'alert'
      || (Array.isArray(trace?.tags) && trace.tags.includes('sub-agent-failure'));
    const agent = assessDelegatedAgent({
      agentId: trace?.senderSubAgentId || trace?.subAgentId,
      subAgentChatId: trace?.senderSubAgentChatId || trace?.subAgentChatId,
      name: trace?.from,
      task: trace?.subject,
      status: failed ? 'failed' : 'completed',
      success: !failed,
      result: trace?.body,
      resultChars: trace?.resultChars,
      resultHash: trace?.resultHash,
      verificationStatus: trace?.verificationStatus,
      payloadTruncated: trace?.payloadTruncated,
    }, true);
    const collection = summarizeDelegationCollection([agent]);
    return {
      kind: 'collection',
      agents: [agent],
      collection,
      summary: `${agent.name}'s automatic handoff reached Main: ${formatDelegationCollection(collection)}`,
    };
  }

  if (type === 'sub_agent_complete' || type === 'sub_agent_error') {
    const source = {
      ...trace,
      name: trace?.subAgent || trace?.agentName,
      status: type === 'sub_agent_error' ? 'failed' : 'completed',
      result: trace?.resultSummary || trace?.taskSummary || trace?.secondary || '',
    };
    const agent = trace?.delegationEvidence || assessDelegatedAgent(source, false);
    return {
      kind: 'result',
      agents: [agent],
      summary: `${agent.name} ${agent.resultUsability === 'usable' ? 'produced a usable result payload' : `ended with ${agent.resultUsability} evidence`}.`,
    };
  }

  if (tool === 'spawn_sub_agent' && (
    String(args?.mode || result?.mode || '') === 'collect' ||
    (result?.collection && Array.isArray(result?.agents))
  )) {
    const agents = Array.isArray(result?.agents)
      ? result.agents.map((item: any) => item?.delegationEvidence || assessDelegatedAgent(item, true))
      : [];
    const collection = result?.collection || summarizeDelegationCollection(agents);
    return {
      kind: 'collection',
      agents,
      collection,
      summary: formatDelegationCollection(collection),
    };
  }
  return null;
}
