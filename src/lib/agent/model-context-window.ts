/**
 * Conservative context-window fallback for catalogs that do not report one.
 * Live provider metadata always wins; this table exists so the server
 * compaction boundary and client meter use the same safe value when discovery
 * is unavailable.
 */
export function resolveModelContextWindow(provider: string, modelName: string): number {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const model = String(modelName || '').trim().toLowerCase();

  if (normalizedProvider === 'gemini' || (normalizedProvider === 'openrouter' && /gemini/.test(model))) {
    return /gemini-(?:1\.5|2\.0|2\.5|3)/.test(model) ? 1_048_576 : 1_000_000;
  }

  if (normalizedProvider === 'anthropic' || /(?:^|\/)claude-/.test(model)) {
    return model.includes('1m') ? 1_000_000 : 200_000;
  }

  // OpenAI's model list endpoint does not currently include context-window
  // metadata, so documented model-family limits are the authoritative fallback.
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
