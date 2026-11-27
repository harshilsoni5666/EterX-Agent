import { contextTraceMatchesBoundary, isContextTurnBoundary } from './chat-feed-lifecycle';
import { estimateContextValueTokens, formatContextUsagePercent, normalizeContextUsageBreakdown, type ContextUsageBreakdown } from './context-usage-breakdown';
import { contextMeasurementModel, contextMeasurementTime, contextPayloadSuperseded, contextRequestTime,
  isPendingContextCompaction, isTerminalContextCompaction, orderContextMeasurementLogs } from './context-usage-snapshot';
import { describeModelCacheChange, readModelUsage, reconcileModelUsageLogs } from './model-usage';

const providerUsageMetricsFromTrace = (usage: any) => {
  if (!usage || usage.type !== 'model_usage') return undefined;
  const measured = readModelUsage(usage);
  return {
    cacheHitRatio: measured.cacheMeasured && measured.inputMeasured && measured.promptTokens > 0
      ? measured.cachedTokens / measured.promptTokens : undefined,
    cachedInputTokens: measured.cacheMeasured ? measured.cachedTokens : undefined,
    uncachedInputTokens: measured.cacheMeasured ? measured.uncachedPromptTokens : undefined,
    outputTokens: measured.visibleOutputTokens,
    reasoningTokens: measured.reasoningMeasured ? measured.reasoningTokens : undefined,
    cacheWriteTokens: measured.cacheWriteTokens,
  };
};

const estimateLiveTraceTokens = (log: any, component: 'input' | 'output'): number => {
  if (!log || log.uiOnly || log._queuedFollowUp === true) return 0;
  const type = String(log.type || '');
  if ([
    'context_usage',
    'context_compaction',
    'answer_cancel',
    'work_note',
    'work_note_cancel',
    'progress',
    'tool_result_preview',
    'agent_decision',
    'done',
    'console_output',
    'file_preview',
    'thought_stream',
  ].includes(type)) return 0;
  const action = ['tool_call', 'command', 'exploration', 'file_edit', 'browser'].includes(type);
  const fragments = component === 'output' ? [
    ['answer', 'ask_user'].includes(type) ? log.text : null,
    type === 'ask_user' ? log.question : null,
    action ? log.toolArgs ?? log.args ?? log.command : null,
  ] : [
    ['user_action', 'steering_applied'].includes(type) ? log.text : null,
    // A settled action can contain BOTH the assistant's arguments and the
    // tool's result. Only the former belongs to provider output usage.
    log.toolResult ?? log.result ?? log.output ?? (type === 'tool_result' ? log.text : null),
    log.answeredWith,
  ];
  let tokens = 0;
  const seen = new Set<unknown>();
  for (const fragment of fragments) {
    if (fragment == null || fragment === '' || seen.has(fragment)) continue;
    seen.add(fragment);
    tokens += estimateContextValueTokens(fragment);
  }
  return tokens > 0 ? tokens + 4 : 0;
};

const contextTraceEstimateIdentity = (log: any): string => {
  const eventId = String(
    log?.thoughtId ||
    log?.answerId ||
    log?.toolCallId ||
    log?.callId ||
    log?.questionId ||
    log?.id ||
    '',
  ).trim();
  if (!eventId) return '';
  const toolId = String(log?.toolCallId || log?.callId || '').trim();
  return JSON.stringify([log?.runId || '', log?.subAgentTurnId || log?.turnId || '',
    toolId ? 'tool' : log?.type || '', toolId || eventId]);
};

const sameContextRequest = (left: any, right: any): boolean => {
  if (!left?.contextRequestId || left.contextRequestId !== right?.contextRequestId) return false;
  if (left.runId && right.runId && left.runId !== right.runId) return false;
  const leftModel = contextMeasurementModel(left), rightModel = contextMeasurementModel(right);
  return !leftModel || !rightModel || leftModel === rightModel;
};

/**
 * One context meter for every agent surface. Input measurements replace prior
 * payloads; response and draft estimates only extend the latest measurement.
 * This is deliberately not a lifetime high-water mark.
 */
const calibratedPayload = (log: any) => log?.providerCalibrationApplied !== undefined
  ? log.providerCalibrationApplied === true
  : Number.isFinite(Number(log?.providerInputTokens)) && Number(log?.providerInputTokens) > 0;

const isContextUsageReceipt = (log: any) => log?.type === 'model_usage' && log.phase !== 'chat_title' && log.usageScope !== 'turn';

export const measureContextHistory = (logs: any[]) => {
  let latestRequestTime = 0;
  let latestPayload: any = null;
  const settledTransactions = new Set<string>();
  const ordered = orderContextMeasurementLogs(reconcileModelUsageLogs(logs));
  const admittedRuns = new Map<string, number>();
  for (const log of ordered) {
    if (log?.type === 'user_action' && log.runId && !log._queuedFollowUp && !admittedRuns.has(log.runId)) {
      admittedRuns.set(log.runId, admittedRuns.size);
    }
  }
  let currentRunOrder = -1;
  const orderedLogs = ordered.filter(log => {
    if (!log || log.auxiliaryRuntime === true || log.phase === 'chat_title') return false;
    const runOrder = admittedRuns.get(log.runId);
    if (runOrder !== undefined) {
      if (runOrder < currentRunOrder) return false;
      if (log.type === 'user_action' && !log._queuedFollowUp) currentRunOrder = runOrder;
    }
    if (!['context_compaction', 'context_usage', 'model_usage'].includes(log.type)) return true;
    const issuedAt = contextRequestTime(log);
    if (issuedAt && issuedAt < latestRequestTime) return false;
    if (issuedAt) latestRequestTime = issuedAt;
    if (log.type === 'context_compaction') {
      if (isPendingContextCompaction(log) && settledTransactions.has(log.compactionId)) return false;
      if (isTerminalContextCompaction(log)) {
        if (log.compactionId) settledTransactions.add(log.compactionId);
        if (log.phase === 'compacted') latestPayload = { ...log, ...log.usage, contextReplaced: true };
      }
    } else if (log.type === 'context_usage') {
      if (contextPayloadSuperseded(latestPayload, log)) return false;
      latestPayload = log;
    }
    return true;
  });
  const latestModelLog = orderedLogs.findLast(log =>
    ['model_selection', 'context_usage', 'model_usage', 'context_compaction'].includes(log?.type)
    && log.phase !== 'chat_title' && contextMeasurementModel(log));
  const validPayload = (log: any) => log?.type === 'context_usage'
    && log.usedTokens !== undefined && log.usedTokens !== null
    && Number.isFinite(Number(log.usedTokens)) && Number(log.usedTokens) >= 0;
  const committedPayload = (log: any) => log?.type === 'context_compaction' && log.phase === 'compacted'
    && log.afterTokens !== undefined && log.afterTokens !== null
    && Number.isFinite(Number(log.afterTokens)) && Number(log.afterTokens) >= 0;
  const terminalPayload = (log: any) => log?.type === 'context_compaction'
    && (log.phase === 'compacted' || log.phase === 'failed')
    && log.usage && validPayload({ ...log.usage, type: 'context_usage' });
  let baselineIndex = -1;
  let latestCompactionEvent: any = null;
  for (let index = orderedLogs.length - 1; index >= 0; index -= 1) {
    const log = orderedLogs[index];
    if (!latestCompactionEvent && log?.type === 'context_compaction') latestCompactionEvent = log;
    if (baselineIndex < 0 && (validPayload(log) || committedPayload(log) || terminalPayload(log))) baselineIndex = index;
    if (baselineIndex >= 0 && latestCompactionEvent) break;
  }
  // A retained older turn can have a preflight while a newer turn kept only
  // its provider receipt. The current admission distinguishes that receipt
  // from a delayed report for an earlier run.
  const boundary = orderedLogs.findLast(log => log?.type === 'user_action' && !log._queuedFollowUp);
  const baseline = orderedLogs[baselineIndex];
  const receipt = orderedLogs.findLastIndex(log => isContextUsageReceipt(log) && readModelUsage(log).inputMeasured);
  if (receipt > baselineIndex) {
    const received = orderedLogs[receipt];
    if (!baseline || (boundary?.runId && boundary.runId !== baseline.runId && received.runId === boundary.runId)
      || (contextRequestTime(baseline) && contextRequestTime(received) > contextRequestTime(baseline))) {
      baselineIndex = receipt;
    }
  }
  // A reconnect can deliver a request's estimate after its provider receipt.
  // Replay from that receipt so late preflight metadata cannot erase an exact
  // count or the tool results observed since that response.
  const replayBaseline = orderedLogs[baselineIndex];
  const replayPayload = terminalPayload(replayBaseline)
    ? { ...replayBaseline, ...replayBaseline.usage, type: 'context_usage' } : replayBaseline;
  for (let index = baselineIndex - 1; replayPayload?.contextRequestId && index >= 0; index -= 1) {
    const previous = orderedLogs[index];
    if (isContextUsageReceipt(previous)
      && sameContextRequest(replayPayload, previous) && readModelUsage(previous).inputMeasured) {
      baselineIndex = index;
      break;
    }
  }
  let displayTokens = 0;
  let measuredContextWindow = 0;
  let authoritative: any = null;
  let latestContextUsage: any = null;
  let latestProviderUsage: any = null;
  let latestBreakdown: ContextUsageBreakdown | null = null;
  let providerMeasured = false;
  let hasEstimatedDelta = false;
  let liveEstimateTokens = 0;
  let retainedProviderOutputTokens = 0;
  let liveOutputEstimateTokens = 0;
  let liveTokenScale = 1;
  let updatedAt = 0;
  const estimatedByIdentity = new Map<string, number>();
  const providerCoveredEstimateIdentities = new Set<string>();
  const seenProviderUsage = new Set<string>();
  const updateLiveTokenScale = (scale: number) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    const previousLiveTokens = liveEstimateTokens;
    const ratio = scale / liveTokenScale;
    liveEstimateTokens *= ratio;
    liveOutputEstimateTokens *= ratio;
    displayTokens += liveEstimateTokens - previousLiveTokens;
    liveTokenScale = scale;
  };
  const resetPayload = (log: any, usedTokens: number) => {
    const window = Number(log.contextWindow || 0);
    measuredContextWindow = Number.isFinite(window) && window > 0 ? window : 0;
    const localTokens = Number(log.localEstimatedTokens || 0);
    if (providerMeasured && sameContextRequest(latestProviderUsage, log)) {
      if (localTokens > 0) updateLiveTokenScale(readModelUsage(latestProviderUsage).promptTokens / localTokens);
      return;
    }
    displayTokens = usedTokens;
    authoritative = log;
    latestProviderUsage = null;
    providerMeasured = false;
    hasEstimatedDelta = false;
    liveEstimateTokens = 0;
    retainedProviderOutputTokens = 0;
    liveOutputEstimateTokens = 0;
    liveTokenScale = Number.isFinite(localTokens) && localTokens > 0 && usedTokens > 0 ? usedTokens / localTokens : 1;
    estimatedByIdentity.clear();
    providerCoveredEstimateIdentities.clear();
    updatedAt = contextMeasurementTime(log);
  };

  // The current baseline already includes everything before it. Replaying a
  // lifetime billing ledger or old tool-result previews adds no information.
  for (const log of orderedLogs.slice(Math.max(0, baselineIndex))) {
    if (log?.type === 'context_compaction') {
      if (terminalPayload(log)) {
        const payload = { ...log, ...log.usage, type: 'context_usage' };
        resetPayload(payload, Number(payload.usedTokens));
        latestContextUsage = payload;
        latestBreakdown = Number(payload.breakdownVersion) === 3 && payload.breakdown ? payload.breakdown : null;
      } else if (committedPayload(log)) {
        resetPayload(log, Number(log.afterTokens));
        // A terminal event can arrive before its companion usage snapshot.
        // Never rescale the pre-compaction category composition onto the capsule.
        latestBreakdown = null;
        latestContextUsage = null;
      }
      continue;
    }
    if (log?.type === 'context_usage') {
      const tokens = Number(log.usedTokens);
      if (!validPayload(log)) continue;
      resetPayload(log, tokens);
      latestContextUsage = log;
      latestBreakdown = Number(log.breakdownVersion) === 3 && log.breakdown
        ? log.breakdown : null;
      continue;
    }
    if (log?.type === 'model_usage') {
      if (!isContextUsageReceipt(log)) continue;
      const measuredUsage = readModelUsage(log);
      if (!measuredUsage.inputMeasured) continue;
      const inputTokens = measuredUsage.promptTokens;
      // A delayed usage report for the old request is billing data, not the
      // current context. Keep it in the trace ledger but out of this meter.
      if (authoritative?.contextRequestId
        && authoritative.contextRequestId !== log.contextRequestId) continue;
      const measuredModel = contextMeasurementModel(authoritative);
      const incomingModel = contextMeasurementModel(log);
      if (measuredModel && incomingModel && measuredModel !== incomingModel) continue;
      if (authoritative?.runId && log.runId && authoritative.runId !== log.runId) continue;
      const usageId = String(log.usageId || '');
      const usageKey = JSON.stringify([log.runId || '', usageId]);
      if (usageId && seenProviderUsage.has(usageKey)) continue;
      if (usageId) seenProviderUsage.add(usageKey);
      const metrics = providerUsageMetricsFromTrace(log);
      const outputMeasured = metrics?.outputTokens !== undefined;
      retainedProviderOutputTokens = outputMeasured ? Math.round(metrics!.outputTokens!) : 0;
      // Do not discard live tool/user input while replacing the streamed
      // assistant estimate with the provider's final output measurement.
      if (outputMeasured) {
        liveEstimateTokens = Math.max(0, liveEstimateTokens - liveOutputEstimateTokens);
        liveOutputEstimateTokens = 0;
      }
      const localTokens = Number(log.contextLocalEstimatedTokens
        ?? (sameContextRequest(log, latestContextUsage) ? latestContextUsage?.localEstimatedTokens : 0));
      if (localTokens > 0) updateLiveTokenScale(inputTokens / localTokens);
      displayTokens = inputTokens + retainedProviderOutputTokens + liveEstimateTokens;
      authoritative = log;
      providerMeasured = true;
      latestProviderUsage = log;
      hasEstimatedDelta = !outputMeasured || liveEstimateTokens > 0;
      updatedAt = contextMeasurementTime(log);
      continue;
    }

    for (const component of ['input', 'output'] as const) {
      const estimate = estimateLiveTraceTokens(log, component);
      if (estimate <= 0) continue;
      const baseIdentity = contextTraceEstimateIdentity(log);
      const identity = baseIdentity ? `${baseIdentity}:${component}` : '';
      const previous = identity ? estimatedByIdentity.get(identity) || 0 : 0;
      if (identity) estimatedByIdentity.set(identity, Math.max(previous, estimate));
      if (identity && providerCoveredEstimateIdentities.has(identity)) continue;
      const delta = (identity ? Math.max(0, estimate - previous) : estimate) * liveTokenScale;
      if (component === 'output') {
        // Completion usage covers the whole response, not a token allowance
        // against differently tokenized UI text. Its final rendered duplicate
        // must not add the local-estimate/provider-count difference a second time.
        if (providerMeasured && providerUsageMetricsFromTrace(latestProviderUsage)?.outputTokens !== undefined
          && (!log.runId || !latestProviderUsage.runId || log.runId === latestProviderUsage.runId)
          && (!log.turnId || !latestProviderUsage.turnId || log.turnId === latestProviderUsage.turnId)) {
          if (identity) providerCoveredEstimateIdentities.add(identity);
          continue;
        }
        liveOutputEstimateTokens += delta;
      }
      displayTokens += delta;
      liveEstimateTokens += delta;
      if (providerMeasured && delta > 0) hasEstimatedDelta = true;
    }
  }

  // Cache reporting is request-specific, even when the meter is still using
  // a prior request as its baseline. A turn receipt can report cache usage
  // without supplying a single-request context count.
  const cacheIndex = orderedLogs.findLastIndex(log => log.type === 'model_usage');
  const cacheReceipt = orderedLogs[cacheIndex];
  const followingPayload = cacheReceipt ? orderedLogs.findLast((log, index) => index > cacheIndex
    && (validPayload(log) || log.type === 'context_compaction')) : null;
  const latestCacheUsage = contextTraceMatchesBoundary(cacheReceipt, orderedLogs.findLast(isContextTurnBoundary))
    && (!followingPayload || sameContextRequest(cacheReceipt, followingPayload)) ? cacheReceipt : null;

  return { displayTokens, measuredContextWindow, authoritative, latestContextUsage, latestProviderUsage, latestCacheUsage,
    latestCompactionEvent, latestModelLog, latestBreakdown, providerMeasured, hasEstimatedDelta,
    liveEstimateTokens, retainedProviderOutputTokens, liveTokenScale, updatedAt };
};

function contextCacheStatus(usage: any, metrics: ReturnType<typeof providerUsageMetricsFromTrace>, mode: string,
  pending: boolean, followsCompaction: boolean) {
  const subject = usage?.usageScope === 'turn' ? 'this turn' : 'this request';
  const cacheHitRatio = metrics?.cacheHitRatio;
  if (cacheHitRatio !== undefined && cacheHitRatio > 0) {
    return {
      label: `Cache hit ${formatContextUsagePercent(cacheHitRatio * 100)}`,
      detail: `${Math.round(metrics!.cachedInputTokens!).toLocaleString()} input tokens served from cache for ${subject}.`,
    };
  }
  if (metrics?.cacheWriteTokens) {
    return { label: 'Cache written', detail: `${metrics.cacheWriteTokens.toLocaleString()} input tokens written to cache for ${subject}.` };
  }
  if (cacheHitRatio === 0) {
    const explanation = describeModelCacheChange(usage, followsCompaction);
    return { label: 'Cache miss', detail: `The provider reported zero cached input tokens for ${subject}.${explanation ? ` ${explanation}` : ''}` };
  }
  if (mode === 'disabled') {
    return { label: 'Cache controls off', detail: 'Application-managed cache controls are disabled.' };
  }
  if (usage) return { label: 'Cache unreported', detail: `The provider did not report usable cache counts for ${subject}.` };
  if (pending) return { label: 'Cache pending', detail: 'Waiting for cache usage from the provider.' };
  return { label: 'Cache unmeasured', detail: 'Cache usage appears after the selected model reports it.' };
}

export const readContextUsageMeter = (logs: any[], draft = '', selectedModel?: { provider: string; modelId: string } | null,
  history = measureContextHistory(logs), running = false) => {
  const { displayTokens, measuredContextWindow, authoritative, latestContextUsage, latestProviderUsage, latestCacheUsage,
    latestCompactionEvent, latestModelLog, latestBreakdown, hasEstimatedDelta,
    liveEstimateTokens, retainedProviderOutputTokens, liveTokenScale, updatedAt } = history;
  const selectedModelKey = contextMeasurementModel(selectedModel) || contextMeasurementModel(latestModelLog);
  const measurementModelKey = contextMeasurementModel(authoritative);
  const usingPreviousModel = Boolean(selectedModelKey && authoritative && selectedModelKey !== measurementModelKey);
  const providerMeasured = history.providerMeasured && !usingPreviousModel;
  const cachedUsage = contextMeasurementModel(latestCacheUsage) === selectedModelKey ? latestCacheUsage : null;
  const cacheMetrics = providerUsageMetricsFromTrace(cachedUsage);
  const cacheMode = String(cachedUsage?.cacheMode || (!usingPreviousModel ? latestContextUsage?.cacheMode : '') || '');
  const cacheStatus = contextCacheStatus(cachedUsage, cacheMetrics, cacheMode, running && !usingPreviousModel,
    latestCompactionEvent?.phase === 'compacted' && sameContextRequest(latestCompactionEvent, cachedUsage));

  const matchingPayload = sameContextRequest(latestProviderUsage, latestContextUsage);
  const localInputEstimate = Number(latestProviderUsage
    ? latestProviderUsage.contextLocalEstimatedTokens ?? (matchingPayload ? latestContextUsage?.localEstimatedTokens : 0)
    : latestContextUsage?.localEstimatedTokens);
  const measuredBaseTokens = Math.max(0, Math.round(displayTokens - liveEstimateTokens - retainedProviderOutputTokens));
  // Until the selected model supplies a preflight, use the tokenizer-neutral
  // estimate from the last payload when available and remove its live scale.
  const estimatedLiveTokens = usingPreviousModel ? liveEstimateTokens / liveTokenScale : liveEstimateTokens;
  const contextTokens = usingPreviousModel
    ? (Number.isFinite(localInputEstimate) && localInputEstimate > 0 ? localInputEstimate : measuredBaseTokens)
      + retainedProviderOutputTokens + estimatedLiveTokens
    : displayTokens;
  const draftScale = usingPreviousModel ? 1 : liveTokenScale;
  const draftTokens = draft.trim() ? Math.ceil((Math.ceil(draft.length / 4) + 4) * draftScale) : 0;
  const usedTokens = Math.max(0, Math.round(contextTokens + draftTokens));
  const measuredBreakdown = latestBreakdown && !usingPreviousModel
    ? normalizeContextUsageBreakdown(latestBreakdown, measuredBaseTokens) : undefined;
  const breakdown = measuredBreakdown ? {
    ...measuredBreakdown,
    conversation: measuredBreakdown.conversation + usedTokens - measuredBaseTokens,
  } : undefined;
  const aggregateSource: 'provider' | 'provider_plus_live_estimate' | 'runtime_estimate' = providerMeasured
    ? (draftTokens > 0 || liveEstimateTokens > 0 || hasEstimatedDelta ? 'provider_plus_live_estimate' : 'provider')
    : 'runtime_estimate';
  const requestEstimate = Number(latestProviderUsage?.contextEstimatedTokens
    ?? (matchingPayload ? latestContextUsage?.usedTokens : 0));
  const providerInput = providerMeasured ? readModelUsage(latestProviderUsage).promptTokens : 0;
  const formatTokens = (tokens: number) => Math.round(tokens).toLocaleString('en-US');
  const measurementNote = usingPreviousModel
    ? 'Estimated from the retained context. The selected model may count it differently.'
    : providerMeasured
      ? requestEstimate > 0 && Math.abs(requestEstimate - providerInput) >= Math.max(1_000, requestEstimate * 0.02)
        ? `The provider measured ${formatTokens(providerInput)} input tokens. The request estimate was ${formatTokens(requestEstimate)}.`
        : aggregateSource === 'provider_plus_live_estimate'
          ? 'Provider input count plus the response, with an estimate for new content.'
          : 'Provider input count plus the response.'
      : latestContextUsage?.contextReplaced === true || authoritative?.phase === 'compacted'
        ? 'Post-compaction estimate. The provider will measure the next request.'
        : calibratedPayload(latestContextUsage) && Number(latestContextUsage?.providerInputTokens) > 0
          ? `Estimate based on the provider’s last input count (${formatTokens(Number(latestContextUsage.providerInputTokens))} tokens) and the current context.`
          : 'Local estimate. The provider count may differ when the request completes.';
  return {
    usedTokens, breakdown, draftTokens, liveEstimateTokens: estimatedLiveTokens, providerMeasured, hasEstimatedDelta, updatedAt,
    authoritative, latestContextUsage, latestProviderUsage, latestCompactionEvent, latestModelLog,
    contextWindow: measuredContextWindow,
    modelContextWindow: Number(latestContextUsage?.modelContextWindow || 0) || undefined,
    requestedContextWindow: Number(latestContextUsage?.requestedContextWindow || 0) || undefined,
    isEstimated: !providerMeasured || draftTokens > 0 || hasEstimatedDelta,
    aggregateSource,
    measurementNote,
    breakdownSource: breakdown ? 'serialized_payload' as const : 'unavailable' as const,
    providerMetrics: cacheMetrics,
    cacheStatus,
    providerInputTokens: providerMeasured ? readModelUsage(latestProviderUsage).promptTokens : undefined,
    localEstimatedTokens: Number(latestContextUsage?.localEstimatedTokens || 0) || undefined,
    hasDraftEstimate: draftTokens > 0,
  };
};
