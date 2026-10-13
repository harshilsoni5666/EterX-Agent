import { normalizeContextUsageBreakdown, type ContextUsageBreakdown } from './context-usage-breakdown';
import { contextMeasurementModel, contextMeasurementTime, orderContextMeasurementLogs } from './context-usage-snapshot';
import { readModelUsage, reconcileModelUsageLogs } from './model-usage';

const providerUsageMetricsFromTrace = (usage: any) => {
  if (!usage || usage.type !== 'model_usage') return undefined;
  const measured = readModelUsage(usage);
  return {
    cacheHitRatio: measured.cacheMeasured && measured.inputMeasured
      ? (measured.promptTokens > 0 ? measured.cachedTokens / measured.promptTokens : 0) : undefined,
    cachedInputTokens: measured.cacheMeasured ? measured.cachedTokens : undefined,
    uncachedInputTokens: measured.cacheMeasured ? measured.uncachedPromptTokens : undefined,
    outputTokens: measured.visibleOutputTokens,
    reasoningTokens: measured.reasoningMeasured ? measured.reasoningTokens : undefined,
    cacheWriteTokens: measured.cacheWriteTokens,
  };
};

const estimateLiveTraceTokens = (log: any, component: 'input' | 'output'): number => {
  if (!log) return 0;
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
  let chars = 0;
  const seen = new Set<string>();
  for (const fragment of fragments) {
    if (typeof fragment === 'string') {
      if (!seen.has(fragment)) {
        seen.add(fragment);
        chars += fragment.length;
      }
    }
    else if (fragment && typeof fragment === 'object') {
      try {
        const serialized = JSON.stringify(fragment);
        if (!seen.has(serialized)) {
          seen.add(serialized);
          chars += serialized.length;
        }
      } catch { }
    }
  }
  return chars > 0 ? Math.ceil(chars / 4) + 4 : 0;
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
  return `${String(log?.runId || log?.turnId || '')}|${toolId ? 'tool' : String(log?.type || '')}|${toolId || eventId}`;
};

/**
 * One context meter for every agent surface. Input measurements replace prior
 * payloads; response and draft estimates only extend the latest measurement.
 * This is deliberately not a lifetime high-water mark.
 */
export const readContextUsageMeter = (logs: any[], draft = '', selectedModel?: { provider: string; modelId: string } | null) => {
  const orderedLogs = orderContextMeasurementLogs(reconcileModelUsageLogs(logs)).filter(log => log?.auxiliaryRuntime !== true);
  const validPayload = (log: any) => log?.type === 'context_usage'
    && log.usedTokens !== undefined && log.usedTokens !== null
    && Number.isFinite(Number(log.usedTokens)) && Number(log.usedTokens) >= 0;
  const committedPayload = (log: any) => log?.type === 'context_compaction' && log.phase === 'compacted'
    && log.afterTokens !== undefined && log.afterTokens !== null
    && Number.isFinite(Number(log.afterTokens)) && Number(log.afterTokens) >= 0;
  const terminalPayload = (log: any) => log?.type === 'context_compaction'
    && (log.phase === 'compacted' || log.phase === 'failed')
    && log.usage && validPayload({ ...log.usage, type: 'context_usage' });
  const calibratedPayload = (log: any) => log?.providerCalibrationApplied !== undefined
    ? log.providerCalibrationApplied === true
    : Number.isFinite(Number(log?.providerInputTokens)) && Number(log?.providerInputTokens) > 0;
  let baselineIndex = -1;
  let latestCompactionEvent: any = null;
  for (let index = orderedLogs.length - 1; index >= 0; index -= 1) {
    const log = orderedLogs[index];
    if (!latestCompactionEvent && log?.type === 'context_compaction') latestCompactionEvent = log;
    if (baselineIndex < 0 && (validPayload(log) || committedPayload(log) || terminalPayload(log))) baselineIndex = index;
    if (baselineIndex >= 0 && latestCompactionEvent) break;
  }
  // A model switch has no provider count until that model answers. Recover
  // the preceding measurement so an uncalibrated preflight estimate cannot
  // make retained history appear to shrink immediately. A real compaction
  // or a count from the new model always ends this pending display state.
  const baselineLog = orderedLogs[baselineIndex];
  const baselinePayload = terminalPayload(baselineLog) ? baselineLog.usage : baselineLog;
  if (validPayload({ ...baselinePayload, type: baselinePayload?.type || 'context_usage' })
    && baselineLog?.phase !== 'compacted' && baselinePayload?.contextReplaced !== true
    && !calibratedPayload(baselinePayload)) {
    const baselineModel = contextMeasurementModel(baselinePayload);
    if (baselineModel) {
      let crossesModelChange = false;
      for (let index = baselineIndex - 1; index >= 0; index -= 1) {
        const previous = orderedLogs[index];
        const previousPayload = terminalPayload(previous) ? { ...previous.usage, type: 'context_usage' } : previous;
        const replacedContext = committedPayload(previous) || previousPayload?.contextReplaced === true
          || (terminalPayload(previous) && previous.phase === 'compacted');
        const previousProviderCount = previous?.type === 'model_usage' && previous.phase !== 'chat_title'
          && readModelUsage(previous).inputMeasured;
        if (!validPayload(previousPayload) && !previousProviderCount && !replacedContext) continue;
        const previousModel = contextMeasurementModel(previousPayload);
        if (previousModel && previousModel !== baselineModel) crossesModelChange = true;
        if (crossesModelChange) baselineIndex = index;
        // Follow an unmeasured A -> B -> A sequence back to its last count,
        // but never reach through a real measurement or committed compaction.
        if (replacedContext || previousProviderCount || calibratedPayload(previousPayload)) break;
      }
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
  let updatedAt = 0;
  let awaitingModelCount = false;
  const estimatedByIdentity = new Map<string, number>();
  const providerCoveredEstimateIdentities = new Set<string>();
  const seenProviderUsage = new Set<string>();
  const resetPayload = (log: any, usedTokens: number, allowPendingModelCount = false) => {
    const previousModel = contextMeasurementModel(authoritative);
    const nextModel = contextMeasurementModel(log);
    awaitingModelCount = allowPendingModelCount && log.contextReplaced !== true && !calibratedPayload(log)
      && (awaitingModelCount || Boolean(previousModel && nextModel && previousModel !== nextModel));
    if (!awaitingModelCount) displayTokens = usedTokens;
    const window = Number(log.contextWindow || 0);
    if (Number.isFinite(window) && window > 0) measuredContextWindow = window;
    authoritative = log;
    latestProviderUsage = null;
    providerMeasured = false;
    hasEstimatedDelta = false;
    liveEstimateTokens = 0;
    retainedProviderOutputTokens = 0;
    liveOutputEstimateTokens = 0;
    estimatedByIdentity.clear();
    providerCoveredEstimateIdentities.clear();
    updatedAt = contextMeasurementTime(log);
  };

  // The current baseline already includes everything before it. Replaying a
  // lifetime billing ledger or old tool-result previews adds no information.
  for (const log of orderedLogs.slice(Math.max(0, baselineIndex))) {
    if (log?.type === 'context_compaction') {
      latestCompactionEvent = log;
      if (terminalPayload(log)) {
        const payload = { ...log, ...log.usage, type: 'context_usage' };
        resetPayload(payload, Number(payload.usedTokens), log.phase !== 'compacted');
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
      resetPayload(log, tokens, true);
      latestContextUsage = log;
      latestBreakdown = Number(log.breakdownVersion) === 3 && log.breakdown
        ? log.breakdown : null;
      continue;
    }
    if (log?.type === 'model_usage') {
      if (log.phase === 'chat_title') continue;
      const measuredUsage = readModelUsage(log);
      if (!measuredUsage.inputMeasured) continue;
      const inputTokens = measuredUsage.promptTokens;
      // A delayed usage report for the old request is billing data, not the
      // current context. Keep it in the trace ledger but out of this meter.
      if (authoritative?.contextRequestId && log.contextRequestId
        && authoritative.contextRequestId !== log.contextRequestId) continue;
      const measuredModel = contextMeasurementModel(latestContextUsage);
      const incomingModel = contextMeasurementModel(log);
      if (measuredModel && incomingModel && measuredModel !== incomingModel) continue;
      if (latestContextUsage?.contextRequestId && latestContextUsage.runId && log.runId
        && latestContextUsage.runId !== log.runId) continue;
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
      displayTokens = inputTokens + retainedProviderOutputTokens + liveEstimateTokens;
      authoritative = log;
      awaitingModelCount = false;
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
      const delta = identity ? Math.max(0, estimate - previous) : estimate;
      if (component === 'output') {
        // Completion usage covers the whole response, not a token allowance
        // against differently tokenized UI text. Its final rendered duplicate
        // must not add the local-estimate/provider-count difference a second time.
        if (providerMeasured && providerUsageMetricsFromTrace(latestProviderUsage)?.outputTokens !== undefined) {
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

  const draftTokens = draft.trim() ? Math.ceil(draft.length / 4) + 4 : 0;
  const selectedModelKey = contextMeasurementModel(selectedModel);
  const measurementModelKey = contextMeasurementModel(authoritative);
  const awaitingSelectedModelMeasurement = awaitingModelCount
    || Boolean(selectedModelKey && authoritative && selectedModelKey !== measurementModelKey);
  const cacheMetrics = providerUsageMetricsFromTrace(latestProviderUsage);
  const cacheMode = String(latestProviderUsage?.cacheMode || latestContextUsage?.cacheMode || '');
  const cacheStatus = awaitingSelectedModelMeasurement
    ? { label: 'Cache pending', detail: 'Waiting for a cache measurement from the selected model.' }
    : cacheMetrics?.cacheHitRatio !== undefined && (cacheMetrics.cachedInputTokens || 0) > 0
      ? { label: `Cache hit ${cacheMetrics.cacheHitRatio < 0.01 ? '<1' : Math.round(cacheMetrics.cacheHitRatio * 100)}%`, detail: `${Math.round(cacheMetrics.cachedInputTokens!).toLocaleString('en-US')} input tokens served from cache on this request. Cached tokens still occupy context.` }
      : cacheMode === 'disabled'
        ? { label: 'Cache controls off', detail: 'Application-managed caching is disabled. The provider may still apply automatic caching; no measured hit is reported here.' }
        : (cacheMetrics?.cacheWriteTokens || 0) > 0
          ? { label: 'Cache written', detail: 'The provider reports writing cache entries. This is not a measured cache hit.' }
          : cacheMetrics?.cacheHitRatio !== undefined
            ? { label: 'Cache miss', detail: 'The provider reported zero cached input tokens for this request.' }
            : latestProviderUsage
              ? { label: 'Cache unreported', detail: 'The provider did not report cached input usage. Cache support or a stable prefix alone does not prove a hit.' }
              : { label: 'Cache pending', detail: 'Waiting for this request’s provider cache usage. Previous requests do not establish a hit for this request.' };
  const usedTokens = Math.max(0, Math.round(displayTokens + draftTokens));
  const measuredBaseTokens = Math.max(0, Math.round(displayTokens - liveEstimateTokens - retainedProviderOutputTokens));
  const measuredBreakdown = latestBreakdown
    ? normalizeContextUsageBreakdown(latestBreakdown, measuredBaseTokens) : undefined;
  const breakdown = measuredBreakdown ? {
    ...measuredBreakdown,
    conversation: measuredBreakdown.conversation + retainedProviderOutputTokens + liveEstimateTokens + draftTokens,
  } : undefined;
  const aggregateSource: 'provider' | 'provider_plus_live_estimate' | 'runtime_estimate' = providerMeasured
    ? (draftTokens > 0 || liveEstimateTokens > 0 || hasEstimatedDelta ? 'provider_plus_live_estimate' : 'provider')
    : 'runtime_estimate';
  return {
    usedTokens, breakdown, draftTokens, liveEstimateTokens, providerMeasured, hasEstimatedDelta, updatedAt,
    authoritative, latestContextUsage, latestProviderUsage, latestCompactionEvent,
    contextWindow: measuredContextWindow,
    modelContextWindow: Number(latestContextUsage?.modelContextWindow || 0) || undefined,
    requestedContextWindow: Number(latestContextUsage?.requestedContextWindow || 0) || undefined,
    isEstimated: awaitingSelectedModelMeasurement || !providerMeasured || draftTokens > 0 || hasEstimatedDelta,
    awaitingSelectedModelMeasurement,
    aggregateSource,
    breakdownSource: latestBreakdown ? 'serialized_payload' as const : 'unavailable' as const,
    providerMetrics: cacheMetrics,
    cacheStatus,
    providerInputTokens: providerMeasured ? readModelUsage(latestProviderUsage).promptTokens : undefined,
    localEstimatedTokens: Number(latestContextUsage?.localEstimatedTokens || 0) || undefined,
    hasDraftEstimate: draftTokens > 0,
  };
};
