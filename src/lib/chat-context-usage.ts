import { appStorage } from './client-storage';
import { resolveModelContextWindow } from './agent/model-context-window';
import { modelEntryKey } from './agent/model-selector-store';
import { readContextUsageMeter } from './context-usage-meter';
import { contextMeasurementModel, orderContextMeasurementLogs } from './context-usage-snapshot';
import { CONTEXT_BUDGET_REVISIONS_KEY, contextWindowLimitNote, normalizeContextWindow,
  resolveContextWindowBudget, resolveSavedContextBudget } from './context-window-policy';

type Model = { provider: string; modelId: string };
const readPreference = (key: string): any => {
  try { return JSON.parse(appStorage.getItem(key) || '{}') || {}; } catch { return {}; }
};

/** Shared presentation policy for main, worker, and side-chat context meters. */
export function readChatContextUsage({ logs, chatId, draft = '', selectedModel, fallbackModel, running = false }: {
  logs: any[];
  chatId?: string | null;
  draft?: string;
  selectedModel?: Model | null;
  fallbackModel?: Model;
  running?: boolean;
}) {
  const meter = readContextUsageMeter(logs, draft, selectedModel);
  const latestModel = [...orderContextMeasurementLogs(logs)].reverse().find(log =>
    ['model_selection', 'model_usage', 'context_usage'].includes(log?.type)
    && log?.auxiliaryRuntime !== true && log?.phase !== 'chat_title'
    && contextMeasurementModel(log));
  const model = selectedModel || (latestModel ? {
    provider: String(latestModel.provider), modelId: String(latestModel.model || latestModel.modelId),
  } : fallbackModel);
  if (!model) return null;
  const { provider, modelId } = model;
  const latestUsage = meter.latestContextUsage;
  const modelMatches = contextMeasurementModel(latestUsage) === contextMeasurementModel(model);
  const discoveredMaximum = normalizeContextWindow(readPreference('eterx_model_context_windows')[modelEntryKey(provider, modelId)]);
  const measuredMaximum = modelMatches ? normalizeContextWindow(latestUsage?.modelContextWindow) : 0;
  const modelMaximum = (running ? measuredMaximum || discoveredMaximum : discoveredMaximum || measuredMaximum)
    || resolveModelContextWindow(provider, modelId);
  const savedSettings = readPreference('eterx_settings');
  const override = readPreference('eterx_chat_context_window_overrides')[chatId || ''];
  const revisions = readPreference(CONTEXT_BUDGET_REVISIONS_KEY);
  const savedRevision = Math.max(Number(revisions.global || 0), Number(revisions.chats?.[chatId || ''] || 0));
  const budget = resolveContextWindowBudget(resolveSavedContextBudget(savedSettings, override), modelMaximum);
  const runtimeWindow = normalizeContextWindow(meter.contextWindow);
  const pinned = running && modelMatches && runtimeWindow > 0;
  let contextWindow = pinned ? Math.min(modelMaximum, runtimeWindow) : budget.configuredContextWindow;
  const compaction = meter.latestCompactionEvent;
  const compactionModel = contextMeasurementModel(compaction);
  // Failure recovery is local to its model and budget revision. A subsequent
  // setting/model change must not inherit the previous request's raised limit.
  if (modelMatches && compaction?.phase === 'failed'
    && (!compactionModel || compactionModel === contextMeasurementModel(model))
    && savedRevision <= Number(compaction.contextBudgetRevision || 0)) {
    const raised = normalizeContextWindow(compaction.nextContextWindow);
    if (raised) contextWindow = Math.min(modelMaximum, Math.max(contextWindow, raised));
  }
  const measured = meter.latestProviderUsage || latestUsage;
  return {
    ...meter,
    contextWindow,
    contextLimitNote: contextWindowLimitNote(
      pinned && normalizeContextWindow(latestUsage?.configuredContextWindow) ? latestUsage.requestedContextWindow : budget.requestedContextWindow,
      modelMaximum,
    ),
    utilizationPct: contextWindow > 0 ? Math.max(0, Math.min(100, meter.usedTokens / contextWindow * 100)) : 0,
    providerName: String(measured?.provider || provider).trim() || undefined,
    modelName: String(measured?.model || measured?.modelId || modelId).trim() || undefined,
    compaction: compaction ? {
      phase: compaction.phase,
      beforeTokens: Number(compaction.beforeTokens || 0),
      beforeTokensEstimated: compaction.beforeTokensEstimated !== false,
      afterTokens: compaction.afterTokens != null && Number.isFinite(Number(compaction.afterTokens))
        ? Number(compaction.afterTokens) : undefined,
      modelProvider: String(compaction.modelProvider || '').trim() || undefined,
      modelName: String(compaction.modelName || '').trim() || undefined,
      failureTier: Number(compaction.failureTier || 0) || undefined,
      nextAttemptTokens: Number(compaction.nextAttemptTokens || 0)
        ? Math.min(Number(compaction.nextAttemptTokens), Math.floor(modelMaximum * 0.96)) : undefined,
      nextContextWindow: Number(compaction.nextContextWindow || 0)
        ? Math.min(Number(compaction.nextContextWindow), modelMaximum) : undefined,
      summary: String(compaction.summary || '').trim() || undefined,
      timestamp: Number(compaction.timestamp || 0) || undefined,
    } : undefined,
  };
}
