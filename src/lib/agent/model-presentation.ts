/** Display-only names. Always retain the original ID for routing and storage. */
export function formatModelName(modelId: string): string {
  const name = (modelId.trim().split('/').filter(Boolean).pop() || modelId.trim())
    .replace(/:(?:free|online|nitro|extended|exacto)(?=:|$)/gi, '');
  const tagStart = name.indexOf(':');
  const tag = tagStart < 0 ? '' : name.slice(tagStart);
  const base = tagStart < 0 ? name : name.slice(0, tagStart);
  return base
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .map(word => {
      const brands: Record<string, string> = {
        gpt: 'GPT', oss: 'OSS', glm: 'GLM', ox: 'OX', ai: 'AI', it: 'IT',
        minimax: 'MiniMax', deepseek: 'DeepSeek', chatgpt: 'ChatGPT',
        qwen: 'Qwen', llama: 'Llama', gemma: 'Gemma', gemini: 'Gemini',
      };
      return brands[word.toLowerCase()]
        || (/^\d+(?:\.\d+)?b$/i.test(word) ? word.toUpperCase()
          : /^o\d/i.test(word) ? word.toLowerCase()
          : word.charAt(0).toUpperCase() + word.slice(1));
    }).join(' ') + tag;
}

/** Group by the serving provider, preserving saved order inside each group. */
export function groupModelsByProvider<T extends { provider: string }>(models: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  return Array.from(groups, ([provider, models]) => ({ provider: models[0].provider as T['provider'], models }));
}
