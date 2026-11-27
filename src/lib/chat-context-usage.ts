import { appStorage } from './client-storage';
import { resolveModelContextWindow } from './agent/model-context-window';
import { modelEntryKey } from './agent/model-selector-store';
import { measureContextHistory, readContextUsageMeter } from './context-usage-meter';
import { contextMeasurementModel, isPendingContextCompaction } from './context-usage-snapshot';
import { contextTraceMatchesBoundary, isContextCompactionLive, isContextTurnBoundary } from './chat-feed-lifecycle';
import { CONTEXT_BUDGET_REVISIONS_KEY, contextWindowLimitNote, normalizeContextWindow,
  resolveContextWindowBudget, resolveSavedContextBudget } from './context-window-policy';

type Model = { provider: string; modelId: string };
const readPreference = (key: string): any => {
  try { return JSON.parse(appStorage.getItem(key) || '{}') || {}; } catch { return {}; }
};

/** Shared presentation policy for main, worker, and side-chat context meters. */
export function readChatContextUsage({ logs, chatId, draft = '', selectedModel, fallbackModel, running = false, activeRunId, history }: {
  logs: any[];
  chatId?: string | null;
  draft?: string;
  selectedModel?: Model | null;
  fallbackModel?: Model;
  running?: boolean;
  activeRunId?: string;
  history?: ReturnType<typeof measureContextHistory>;
}) {
  const measuredHistory = history ?? measureContextHistory(logs);
  const latestModelLog = measuredHistory.latestModelLog;
  const latestModel = latestModelLog?.type === 'context_compaction' && latestModelLog.usage
    ? latestModelLog.usage : latestModelLog;
  const model = selectedModel || (latestModel ? {
    provider: String(latestModel.provider), modelId: String(latestModel.model || latestModel.modelId),
  } : fallbackModel);
  if (!model) return null;
  const meter = readContextUsageMeter(logs, draft, model, measuredHistory, running);
  const { provider, modelId } = model;
  const latestUsage = meter.latestContextUsage;
  const modelMatches = contextMeasurementModel(latestUsage) === contextMeasurementModel(model);
  const discoveredMaximum = normalizeContextWindow(readPreference('eterx_model_context_windows')[modelEntryKey(provider, modelId)]);
  const measuredMaximum = modelMatches ? normalizeContextWindow(latestUsage?.modelContextWindow) : 0;
  const currentTurn = running && contextTraceMatchesBoundary(latestUsage, logs.findLast(isContextTurnBoundary), activeRunId);
  const modelMaximum = (currentTurn ? measuredMaximum || discoveredMaximum : discoveredMaximum || measuredMaximum)
    || resolveModelContextWindow(provider, modelId);
  const savedSettings = readPreference('eterx_settings');
  const override = readPreference('eterx_chat_context_window_overrides')[chatId || ''];
  const revisions = readPreference(CONTEXT_BUDGET_REVISIONS_KEY);
  const savedRevision = Math.max(Number(revisions.global || 0), Number(revisions.chats?.[chatId || ''] || 0));
  const budget = resolveContextWindowBudget(resolveSavedContextBudget(savedSettings, override), modelMaximum);
  const runtimeWindow = normalizeContextWindow(meter.contextWindow);
  const sameBudget = modelMatches && savedRevision <= Number(latestUsage?.contextBudgetRevision || 0);
  const pinned = currentTurn && sameBudget && runtimeWindow > 0;
  let contextWindow = pinned ? Math.min(modelMaximum, runtimeWindow) : budget.configuredContextWindow;
  const candidate = meter.latestCompactionEvent;
  const candidateModel = contextMeasurementModel(candidate);
  const compatible = !candidateModel || candidateModel === contextMeasurementModel(model);
  const recoveryEnded = candidate?.phase === 'failed' && (savedRevision > Number(candidate.contextBudgetRevision || 0)
    || (latestUsage?.contextRequestId && latestUsage.contextRequestId !== candidate.contextRequestId
      && (latestUsage.contextReplaced === true || (latestUsage.configuredContextWindow && runtimeWindow <= latestUsage.configuredContextWindow))));
  const compaction = compatible && !recoveryEnded
    && (!isPendingContextCompaction(candidate) || isContextCompactionLive(candidate, logs, running, activeRunId)) ? candidate : null;
  // A later payload carries the actual recovery window, including a return to
  // the configured budget after a successful manual compaction.
  if (sameBudget && latestUsage?.configuredContextWindow === budget.configuredContextWindow && runtimeWindow > contextWindow) {
    contextWindow = Math.min(modelMaximum, runtimeWindow);
  } else if (sameBudget && compaction?.phase === 'failed' && (!compaction.contextRequestId
    || compaction.contextRequestId === latestUsage?.contextRequestId)) {
    contextWindow = Math.min(modelMaximum, Math.max(contextWindow, normalizeContextWindow(compaction.nextContextWindow)));
  }
  return {
    ...meter,
    contextWindow,
    contextLimitNote: contextWindowLimitNote(
      pinned && normalizeContextWindow(latestUsage?.configuredContextWindow) ? latestUsage.requestedContextWindow : budget.requestedContextWindow,
      modelMaximum,
    ),
    utilizationPct: contextWindow > 0 ? Math.max(0, Math.min(100, meter.usedTokens / contextWindow * 100)) : 0,
    providerName: provider,
    modelName: modelId,
    compactionInProgress: isPendingContextCompaction(compaction),
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
