/** The requested budget is a preference; the effective budget is a model limit. */
export const CONTEXT_WINDOW_SIZE_OPTIONS = [
  { value: '64000', label: '64k · Compact', description: 'Lowest cost and fastest turnover' },
  { value: '128000', label: '128k · Standard', description: 'Balanced for ordinary work' },
  { value: '258000', label: '258k · Deep', description: 'Up to 258k, within the active model limit' },
  { value: '512000', label: '512k · Broad', description: 'Up to 512k, within the active model limit' },
  { value: '1000000', label: '1M · Extended', description: 'For models with very large windows' },
  { value: 'model_max', label: 'Model maximum · Default', description: 'Use the full supported model window' },
];

const validSelections = new Set(CONTEXT_WINDOW_SIZE_OPTIONS.map(option => option.value));
export const CONTEXT_BUDGET_REVISIONS_KEY = 'eterx_context_budget_revisions';

export const normalizeSavedContextBudget = (value: unknown): string => {
  const selection = String(value || '').trim();
  return validSelections.has(selection) ? selection : '';
};

export const normalizeContextWindow = (value: unknown): number => {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens >= 16_000 && tokens <= 4_000_000
    ? Math.floor(tokens) : 0;
};

/** Keep exact discovered model limits when a request later switches models. */
export const normalizeModelContextWindows = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap<[string, number]>(([key, raw]) => {
    const tokens = normalizeContextWindow(raw);
    return tokens && key.includes(':') && key.length <= 300 ? [[key, tokens]] : [];
  }));
};

export const resolveSavedContextBudget = (settings: any, chatOverride?: unknown): string => {
  const override = normalizeSavedContextBudget(chatOverride);
  if (override) return override;
  const selection = normalizeSavedContextBudget(settings?.contextWindowSizeSelection);
  // 258k was once the persisted untouched default. Preserve it only when the
  // user actually selected it; other legacy fixed selections were explicit.
  const touched = settings?.contextWindowSizeSelectionTouched === true
    || Boolean(selection && selection !== '258000' && selection !== 'model_max');
  return touched && selection ? selection : 'model_max';
};

export const resolveContextWindowBudget = (selection: string, modelMaximum: unknown) => {
  const modelContextWindow = normalizeContextWindow(modelMaximum);
  const requestedContextWindow = selection === 'model_max'
    ? undefined : normalizeContextWindow(selection) || undefined;
  // Unknown model capacity is not permission to call a requested budget
  // effective. Consumers can show "Not available yet" until it is known.
  const configuredContextWindow = modelContextWindow > 0
    ? Math.min(modelContextWindow, requestedContextWindow || modelContextWindow) : 0;
  return {
    modelContextWindow,
    requestedContextWindow,
    configuredContextWindow,
    activeContextWindowUsesModelMaximum: requestedContextWindow === undefined,
    isModelLimited: Boolean(requestedContextWindow && modelContextWindow && requestedContextWindow > modelContextWindow),
  };
};

export const formatExactContextTokens = (value: number) => Math.round(value).toLocaleString('en-US');

export const contextWindowLimitNote = (requested: unknown, modelMaximum: unknown): string | undefined => {
  const requestedTokens = normalizeContextWindow(requested);
  const maximumTokens = normalizeContextWindow(modelMaximum);
  return requestedTokens > maximumTokens && maximumTokens > 0
    ? `${formatExactContextTokens(requestedTokens)} selected · limited to ${formatExactContextTokens(maximumTokens)} by this model`
    : undefined;
};
