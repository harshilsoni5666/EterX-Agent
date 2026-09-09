import { normalizeContextWindow } from '../context-window-policy';

/**
 * Conservative context-window fallback for catalogs that do not report one.
 * Live provider metadata always wins; this table exists so the server
 * compaction boundary and client meter use the same safe value when discovery
 * is unavailable.
 */
export function resolveModelContextWindow(provider: string, modelName: string): number {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const model = String(modelName || '').trim().toLowerCase();

  // This free OpenRouter route has a smaller window than some other MiniMax
  // offerings. Do not show the generic 256k fallback while discovery loads.
  if (normalizedProvider === 'openrouter' && model === 'minimax/minimax-m2.7:free') return 196_608;

  if (normalizedProvider === 'gemini' || (normalizedProvider === 'openrouter' && /gemini/.test(model))) {
    return /gemini-(?:1\.5|2\.0|2\.5|3)/.test(model) ? 1_048_576 : 1_000_000;
  }

  if (normalizedProvider === 'anthropic' || /(?:^|\/)claude-/.test(model)) {
    return model.includes('1m') ? 1_000_000 : 200_000;
  }

  // OpenAI's model list endpoint does not currently include context-window
  // metadata, so documented model-family limits are the authoritative fallback.
  if (/gpt-6(?:[-.]|$)/.test(model)) return 1_050_000;
  if (/gpt-5\.6-cyber/.test(model)) return 400_000;
  if (/gpt-5\.(?:5|6)(?:[-.]|$)/.test(model)) return 1_050_000;
  if (/gpt-5\.4-(?:mini|nano)(?:[-.]|$)/.test(model)) return 400_000;
  if (/gpt-5\.4(?:[-.]|$)/.test(model)) return 1_050_000;
  if (/gpt-4\.1(?:[-.]|$)/.test(model)) return 1_047_576;
  if (/(?:^|\/)o[134](?:[-.]|$)/.test(model)) return 200_000;
  if (/gpt-5(?:[-.]|$)/.test(model)) return 400_000;
  if (/gpt-4o(?:[-.]|$)/.test(model)) return 128_000;

  if (normalizedProvider === 'mistral' || /(?:mistral|codestral|devstral|magistral|ministral)/.test(model)) {
    if (/(?:mistral-large-3|mistral-medium-3\.5|mistral-small-4|devstral-2|ministral-3)/.test(model)) {
      return 256_000;
    }
    // Codestral, Mistral Nemo, Magistral Medium 1.2, and Mistral Medium
    // 3.1 are 128k. Unknown Mistral IDs stay conservative until discovery
    // supplies a provider-reported limit.
    return 128_000;
  }

  if (normalizedProvider === 'groq') return 131_072;
  return 256_000;
}

/** Rebase chat policy when a live worker switches model, never its old limit. */
export function rebaseContextCompactionWindow(raw: any, provider: string, modelName: string) {
  const settings = raw && typeof raw === 'object' ? raw : {};
  const sameModel = settings.activeContextModelProvider === provider && settings.activeContextModelId === modelName;
  const modelMaximum = normalizeContextWindow(settings.modelContextWindows?.[`${provider}:${modelName}`])
    || (sameModel && normalizeContextWindow(settings.activeModelContextWindow))
    || resolveModelContextWindow(provider, modelName);
  const configuredBudget = Number(settings.requestedContextWindow || settings.activeContextWindow || 0);
  const previousMaximum = Number(settings.activeModelContextWindow || 0);
  const followsModelMaximum = settings.activeContextWindowUsesModelMaximum === true
    || (settings.activeContextWindowUsesModelMaximum === undefined
      && (!configuredBudget || configuredBudget === previousMaximum));
  return {
    ...settings,
    activeContextWindow: followsModelMaximum || !Number.isFinite(configuredBudget) || configuredBudget < 16_000
      ? modelMaximum
      : Math.min(modelMaximum, Math.floor(configuredBudget)),
    activeModelContextWindow: modelMaximum,
    activeContextModelProvider: provider,
    activeContextModelId: modelName,
    activeContextWindowUsesModelMaximum: followsModelMaximum,
  };
}
