import { contextMeasurementTime, contextUsageCursor } from './context-usage-snapshot';

const metric = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
};

/** Read both current provider receipts and older saved SDK usage shapes. */
export function readModelUsage(log: any) {
  const usage = log?.usageMetadata || log?.usage || log || {};
  const read = (...keys: string[]) => metric(...keys.map(key => log?.[key]), ...keys.map(key => usage[key]));
  const measured = (flag: string, value: number | undefined) => (log?.[flag] ?? usage[flag]) != null
    ? Number(log?.[flag] ?? usage[flag]) > 0 : value !== undefined;
  let prompt = read('promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens',
    'totalInputTokens', 'total_input_tokens', 'promptTokenCount', 'prompt_token_count', 'inputTokenCount');
  const cacheRead = read('cache_read_input_tokens', 'cacheReadInputTokens');
  const cacheWrite = read('cacheWriteTokens', 'cache_write_tokens', 'cacheCreationTokens',
    'cache_creation_input_tokens', 'cacheCreationInputTokens')
    ?? metric(usage.prompt_tokens_details?.cache_write_tokens, usage.input_tokens_details?.cache_write_tokens,
      usage.cache_creation ? (metric(usage.cache_creation.ephemeral_5m_input_tokens) || 0)
        + (metric(usage.cache_creation.ephemeral_1h_input_tokens) || 0) : undefined);
  // Native Anthropic input excludes cache reads/writes; normalized promptTokens includes them.
  if ((String(log?.provider || '').toLowerCase() === 'anthropic'
      || cacheRead !== undefined || read('cache_creation_input_tokens') !== undefined)
    && read('promptTokens', 'prompt_tokens') === undefined) {
    if (prompt !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
      prompt = (prompt || 0) + (cacheRead || 0) + (cacheWrite || 0);
    }
  }
  if (prompt === undefined) {
    const hit = read('prompt_cache_hit_tokens'), miss = read('prompt_cache_miss_tokens');
    if (hit !== undefined && miss !== undefined) prompt = hit + miss;
  }
  const reasoning = metric(read('reasoningTokens', 'reasoning_tokens', 'totalThoughtTokens',
    'total_thought_tokens', 'thoughtsTokenCount', 'thoughts_token_count', 'thoughtTokenCount'),
    usage.completion_tokens_details?.reasoning_tokens, usage.output_tokens_details?.reasoning_tokens);
  const visible = read('visibleOutputTokens', 'visible_output_tokens', 'candidatesTokenCount',
    'candidates_token_count', 'responseTokenCount', 'response_token_count',
    ...(String(log?.provider || '').toLowerCase() === 'gemini' ? ['totalOutputTokens', 'total_output_tokens'] : []));
  const generated = read('generatedTokens', 'generated_tokens', 'completionTokens', 'completion_tokens',
    'outputTokens', 'output_tokens', 'outputTokenCount');
  const output = generated ?? (visible !== undefined ? visible + (reasoning || 0)
    : read('totalOutputTokens', 'total_output_tokens') ?? reasoning);
  const inputMeasured = measured('promptTokensMeasured', prompt);
  const outputMeasured = measured('completionTokensMeasured', output);
  const reasoningMeasured = measured('reasoningTokensMeasured', reasoning);
  const promptTokens = inputMeasured ? prompt || 0 : 0;
  const outputTokens = outputMeasured ? output || 0 : reasoningMeasured ? reasoning || 0 : 0;
  const cached = metric(read('prompt_cache_hit_tokens'), read('cachedTokens', 'cached_tokens', 'totalCachedTokens', 'total_cached_tokens',
    'cacheReadTokens', 'cachedContentTokenCount', 'cached_content_token_count'), cacheRead,
    usage.prompt_tokens_details?.cached_tokens, usage.input_tokens_details?.cached_tokens);
  const explicitUncached = read('uncachedPromptTokens', 'uncached_prompt_tokens');
  const ratio = read('cacheHitRatio');
  const cacheMeasured = measured('cacheTokensMeasured', cached ?? ratio ?? explicitUncached);
  const cachedTokens = cacheMeasured ? Math.min(promptTokens, cached
    ?? (ratio !== undefined ? promptTokens * Math.min(1, ratio)
      : Math.max(0, promptTokens - (explicitUncached ?? promptTokens)))) : 0;
  const total = read('totalTokens', 'total_tokens', 'totalTokenCount', 'total_token_count');
  return {
    processedTokens: total !== undefined && total > 0 ? total : promptTokens + outputTokens,
    promptTokens,
    outputTokens,
    visibleOutputTokens: outputMeasured ? visible ?? Math.max(0, outputTokens - (reasoning || 0)) : undefined,
    reasoningTokens: reasoningMeasured ? reasoning || 0 : 0,
    cachedTokens,
    uncachedPromptTokens: Math.max(0, promptTokens - cachedTokens),
    cacheWriteTokens: measured('cacheWriteTokensMeasured', cacheWrite) ? cacheWrite : undefined,
    toolUsePromptTokens: read('toolUsePromptTokens', 'tool_use_prompt_tokens', 'totalToolUseTokens',
      'total_tool_use_tokens', 'toolUsePromptTokenCount', 'tool_use_prompt_token_count') || 0,
    inputMeasured,
    outputMeasured,
    reasoningMeasured,
    cacheMeasured,
    totalMeasured: total !== undefined || inputMeasured || outputMeasured || reasoningMeasured,
  };
}

export function modelUsageReceiptKey(log: any): string | null {
  const usageId = String(log?.usageId || '').trim();
  if (usageId) return `usage:${usageId}`;
  const run = String(log?.runId || log?.turnId || '').trim();
  const worker = String(log?.subAgentChatId || log?.subAgentId || log?.agentId || log?.subAgent || '').trim();
  const scope = [String(log?.ownerChatId || log?.chatId || ''), run, worker,
    log?.provider || '', log?.model || log?.modelId || '', log?.phase || ''];
  const cursor = contextUsageCursor(log);
  if (run && cursor !== null) return JSON.stringify([...scope, 'cursor', cursor]);
  const timestamp = contextMeasurementTime(log);
  if (timestamp || log?.contextRequestId) {
    return JSON.stringify([...scope, log?.contextRequestId || '', log?.interaction ?? '', timestamp]);
  }
  // With no receipt identity or request time, equal counts can be separate calls.
  return null;
}

export function mergeModelUsageReceipt(previous: any, incoming: any): any {
  if (!previous) return incoming;
  const previousCursor = contextUsageCursor(previous), incomingCursor = contextUsageCursor(incoming);
  const sameRun = previous.runId && previous.runId === incoming.runId;
  const older = sameRun && previousCursor !== null && incomingCursor !== null && previousCursor !== incomingCursor
    ? incomingCursor < previousCursor
    : contextMeasurementTime(incoming) < contextMeasurementTime(previous);
  const earlier = older ? incoming : previous;
  const later = older ? previous : incoming;
  const merged = { ...earlier };
  for (const [key, value] of Object.entries(later)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  for (const key of ['usage', 'usageMetadata']) {
    if (earlier[key] && later[key]) merged[key] = { ...earlier[key], ...later[key] };
    if (earlier[key] && later[key]) for (const detail of ['prompt_tokens_details', 'input_tokens_details', 'completion_tokens_details', 'output_tokens_details']) {
      if (earlier[key][detail] && later[key][detail]) merged[key][detail] = { ...earlier[key][detail], ...later[key][detail] };
    }
  }
  // Normalization fills absent stream fields with zero plus a measured=0
  // flag. Those placeholders must not erase a measured earlier snapshot.
  const groups: Record<string, string[]> = {
    promptTokensMeasured: ['promptTokens', 'inputTokens'],
    completionTokensMeasured: ['completionTokens', 'outputTokens', 'visibleOutputTokens', 'generatedTokens'],
    reasoningTokensMeasured: ['reasoningTokens'],
    cacheTokensMeasured: ['cachedTokens', 'cacheReadTokens', 'uncachedPromptTokens', 'cacheHitRatio'],
    cacheWriteTokensMeasured: ['cacheWriteTokens', 'cacheCreationTokens'],
  };
  for (const container of [null, 'usage', 'usageMetadata'] as const) {
    const before = container ? earlier[container] : earlier;
    const after = container ? later[container] : later;
    const target = container ? merged[container] : merged;
    if (!before || !after || !target) continue;
    let restoredComponents = false;
    for (const [flag, fields] of Object.entries(groups)) {
      if (Number(before[flag]) !== 1 || Number(after[flag]) !== 0) continue;
      target[flag] = before[flag];
      restoredComponents = true;
      for (const field of fields) if (before[field] !== undefined) target[field] = before[field];
    }
    if (restoredComponents && !Number(after.providerReportedTotalTokens)) {
      target.totalTokens = Math.max(Number(before.totalTokens) || 0,
        (Number(target.promptTokens) || 0) + (Number(target.completionTokens) || 0));
    }
  }
  return merged;
}

export function upsertModelUsageReceipt(logs: any[], incoming: any): void {
  const key = modelUsageReceiptKey(incoming);
  const index = key ? logs.findIndex(log => log?.type === 'model_usage' && modelUsageReceiptKey(log) === key) : -1;
  if (index < 0) logs.push(incoming);
  else logs[index] = mergeModelUsageReceipt(logs[index], incoming);
}

/** A replay is one receipt. A newer snapshot of that receipt can fill missing fields. */
export function reconcileModelUsageLogs(logs: any[]): any[] {
  const receipts = new Map<string, { log: any; index: number }>();
  const result: any[] = [];
  for (const log of logs) {
    const key = log?.type === 'model_usage' ? modelUsageReceiptKey(log) : null;
    const previous = key ? receipts.get(key) : undefined;
    if (!previous) {
      if (key) receipts.set(key, { log, index: result.length });
      result.push(log);
      continue;
    }
    const merged = mergeModelUsageReceipt(previous.log, log);
    result[previous.index] = merged;
    receipts.set(key!, { log: merged, index: previous.index });
  }
  return result;
}

export const uniqueModelUsageLogs = (logs: any[]): any[] =>
  reconcileModelUsageLogs(logs).filter(log => log?.type === 'model_usage');

/** Billing totals include reasoning once and use provider totals when reported. */
export function summarizeModelUsage(logs: any[]) {
  let input = 0, output = 0, total = 0, cached = 0, cacheMeasuredInput = 0, receipts = 0;
  let cacheMeasuredRequests = 0, cacheHitRequests = 0, cacheWrites = 0;
  let latestCacheHitRate: number | null = null, latestCacheAt = -1;
  let inputMeasured = false, outputMeasured = false;
  for (const log of uniqueModelUsageLogs(logs)) {
    const usage = readModelUsage(log);
    const at = contextMeasurementTime(log);
    if (at >= latestCacheAt) {
      latestCacheAt = at;
      latestCacheHitRate = usage.cacheMeasured && usage.inputMeasured && usage.promptTokens > 0
        ? usage.cachedTokens / usage.promptTokens : null;
    }
    if (!usage.totalMeasured) continue;
    receipts += 1;
    input += usage.promptTokens;
    output += usage.outputTokens;
    total += usage.processedTokens;
    inputMeasured ||= usage.inputMeasured;
    outputMeasured ||= usage.outputMeasured || usage.reasoningMeasured;
    if (usage.cacheMeasured && usage.inputMeasured) {
      cached += usage.cachedTokens;
      cacheMeasuredInput += usage.promptTokens;
      if (usage.promptTokens > 0) {
        cacheMeasuredRequests += 1;
        if (usage.cachedTokens > 0) cacheHitRequests += 1;
      }
    }
    cacheWrites += usage.cacheWriteTokens || 0;
  }
  return { input, output, total, cached, receipts, inputMeasured, outputMeasured,
    cacheMeasuredInput, cacheMeasuredRequests, cacheHitRequests, cacheWrites, latestCacheHitRate,
    cacheReportingCoverage: input > 0 ? cacheMeasuredInput / input : null,
    cacheHitRate: cacheMeasuredInput > 0 ? cached / cacheMeasuredInput : null };
}
