import path from 'path';
import fs from 'fs/promises';
import { getEterxDataDir } from './storage-paths';
import { CONTEXT_BUDGET_REVISIONS_KEY, normalizeContextWindow, normalizeModelContextWindows, resolveSavedContextBudget } from '../context-window-policy';
import { rebaseContextCompactionWindow } from './model-context-window';

const preferencePath = () => path.join(getEterxDataDir(), 'settings', 'preferences.json');
let cached: { path: string; stamp: string; checkedAt: number; values: Record<string, string> } | null = null;
const objectValue = (raw: unknown): Record<string, any> => {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
};

/** Read only newer, explicitly saved budget edits at provider request boundaries. */
export async function refreshLiveContextBudget(raw: any, model: { provider: string; modelId: string }): Promise<any> {
  const owner = String(raw?.contextBudgetChatId || '');
  if (!owner) return raw;
  try {
    const file = preferencePath();
    if (!cached || cached.path !== file || Date.now() - cached.checkedAt > 500) {
      const stat = await fs.stat(file);
      if (stat.size > 64 * 1024 * 1024) return raw;
      const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (cached?.path === file && cached.stamp === stamp) cached.checkedAt = Date.now();
      else cached = { path: file, stamp, checkedAt: Date.now(), values: objectValue(await fs.readFile(file, 'utf8')) };
    }
    if (!cached) return raw;
    const values = cached.values;
    const revisions = objectValue(values[CONTEXT_BUDGET_REVISIONS_KEY]);
    const revision = Math.max(Number(revisions.global || 0), Number(objectValue(revisions.chats)[owner] || 0));
    // A delayed preferences write must never roll back the policy admitted
    // with this run. Unrelated preference changes have no budget authority.
    if (!Number.isFinite(revision) || revision <= Number(raw.contextBudgetRevision || 0)) return raw;
    const settings = objectValue(values.eterx_settings);
    const overrides = objectValue(values.eterx_chat_context_window_overrides);
    const selection = resolveSavedContextBudget(settings, overrides[owner]);
    const modelContextWindows = {
      ...normalizeModelContextWindows(raw.modelContextWindows),
      ...normalizeModelContextWindows(objectValue(values.eterx_model_context_windows)),
    };
    const maximum = rebaseContextCompactionWindow({ ...raw, modelContextWindows }, model.provider, model.modelId).activeModelContextWindow;
    if (!maximum) return raw;
    const requested = selection === 'model_max' ? undefined : normalizeContextWindow(selection) || undefined;
    return {
      ...raw, contextBudgetRevision: revision,
      modelContextWindows,
      requestedContextWindow: requested,
      activeContextWindowUsesModelMaximum: requested === undefined,
      activeContextWindow: Math.min(maximum, requested || maximum),
      activeModelContextWindow: maximum,
      activeContextModelProvider: model.provider, activeContextModelId: model.modelId,
    };
  } catch {
    // Temporary preference I/O does not authorize a smaller window or an
    // invented summary. Retain the already admitted policy and retry later.
    return raw;
  }
}
