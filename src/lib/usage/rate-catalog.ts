/** Public list prices in USD per million tokens, indexed by the provider actually contacted. */
export interface TokenRates {
  input?: number;
  output?: number;
  per_image?: number;
  per_audio_second?: number;
  per_video_second?: number;
  video_resolution_rates?: Record<string, number>;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
  input_audio?: number;
  output_audio?: number;
  cached_audio?: number;
  cached_image?: number;
  long_write?: number;
  input_image?: number;
  output_image?: number;
}

export interface ModelRates extends TokenRates {
  tiers?: Array<{ from: number; rates: Partial<TokenRates> }>;
}
export type RateTable = Record<string, Record<string, ModelRates>>;
export interface RateCatalog { asOf: string; providers: RateTable }

export const MODELS_URL = 'https://models.dev/api.json';
export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

const providerIds: Record<string, string> = {
  openai: 'openai', anthropic: 'anthropic', gemini: 'google', openrouter: 'openrouter',
  mistral: 'mistral', groq: 'groq', deepseek: 'deepseek', grok: 'xai', cerebras: 'cerebras',
  together: 'togetherai', fireworks: 'fireworks-ai', sambanova: 'sambanova', perplexity: 'perplexity',
  deepinfra: 'deepinfra', huggingface: 'huggingface', nvidia: 'nvidia', cloudflare: 'cloudflare-workers-ai',
  novita: 'novita-ai', qwen: 'alibaba-cn', mimo: 'xiaomi', tokenhub: 'tencent-tokenhub', zai: 'zai',
  kimi: 'moonshotai', stepfun: 'stepfun', minimax: 'minimax-cn', ollamacloud: 'ollama-cloud',
  arcee: 'arcee', gmi: 'gmicloud', kilo: 'kilo', opencode: 'opencode', upstage: 'upstage',
  bedrock: 'amazon-bedrock',
};

function amount(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const modelKeys = { input: 'input', output: 'output', cache_read: 'cache_read', cache_write: 'cache_write',
  reasoning: 'reasoning', input_audio: 'input_audio', output_audio: 'output_audio' } as const;
const routerKeys = { input: 'prompt', output: 'completion', cache_read: 'input_cache_read', cache_write: 'input_cache_write',
  reasoning: 'internal_reasoning', input_audio: 'audio', output_audio: 'output_audio', cached_audio: 'input_audio_cache' } as const;

function readRates(raw: any, router = false): Partial<TokenRates> {
  const result: Partial<TokenRates> = {};
  for (const [key, source] of Object.entries(router ? routerKeys : modelKeys)) {
    const value = amount(raw?.[source]);
    if (value !== undefined) result[key as keyof typeof modelKeys | keyof typeof routerKeys] = router ? value * 1_000_000 : value;
  }
  return result;
}

function parseRates(raw: any, router = false): ModelRates | undefined {
  const base = readRates(raw, router);
  if (base.input === undefined || base.output === undefined) return;
  const rates = base as ModelRates;
  const tiers: NonNullable<ModelRates['tiers']> = [];
  if (router) {
    for (const x of raw.overrides || []) {
      const from = amount(x.min_prompt_tokens);
      if (from !== undefined) tiers.push({ from, rates: readRates(x, true) });
    }
  } else {
    for (const x of raw.tiers || []) {
      const size = amount(x.tier?.size);
      if (x.tier?.type === 'context' && size !== undefined) tiers.push({ from: size + 1, rates: readRates(x) });
    }
    if (!tiers.length && raw.context_over_200k) tiers.push({ from: 200001, rates: readRates(raw.context_over_200k) });
  }
  if (tiers.length) rates.tiers = tiers.sort((a, b) => a.from - b.from);
  return rates;
}

const liteProviders: Record<string, string> = {
  openai: 'openai', anthropic: 'anthropic', gemini: 'gemini', xai: 'grok', mistral: 'mistral',
  deepseek: 'deepseek', groq: 'groq', cerebras: 'cerebras', together_ai: 'together', fireworks_ai: 'fireworks',
  sambanova: 'sambanova', perplexity: 'perplexity', deepinfra: 'deepinfra', nvidia_nim: 'nvidia', cloudflare: 'cloudflare',
  novita: 'novita', xiaomi_mimo: 'mimo', moonshot: 'kimi', zai: 'zai', gmi: 'gmi', openrouter: 'openrouter', bedrock: 'bedrock',
  fal_ai: 'fal', replicate: 'replicate', runwayml: 'runway', deepgram: 'deepgram', elevenlabs: 'elevenlabs',
};
const liteKeys = { input: 'input_cost_per_token', output: 'output_cost_per_token', cache_read: 'cache_read_input_token_cost',
  cache_write: 'cache_creation_input_token_cost', input_audio: 'input_cost_per_audio_token', output_audio: 'output_cost_per_audio_token',
  cached_audio: 'cache_read_input_audio_token_cost', input_image: 'input_cost_per_image_token', output_image: 'output_cost_per_image_token',
  cached_image: 'cache_read_input_image_token_cost', reasoning: 'output_cost_per_reasoning_token' } as const;

function readLiteRates(model: any, suffix = '') {
  const rates: Partial<TokenRates> = {};
  for (const [key, field] of Object.entries(liteKeys)) {
    const price = amount(model[field + suffix]);
    if (price !== undefined) rates[key as keyof typeof liteKeys] = price * 1_000_000;
  }
  return rates;
}

export function extractRateTable(models: any, router: any, lite: any): RateTable {
  const table: RateTable = {};
  for (const [qualifiedId, model] of Object.entries<any>(lite || {})) {
    const upstream = model.litellm_provider;
    const provider = liteProviders[upstream];
    if (!provider || qualifiedId.includes('*')) continue;
    const id = qualifiedId.startsWith(upstream + '/') ? qualifiedId.slice(upstream.length + 1) : qualifiedId;
    const base = readLiteRates(model);
    if (base.output === undefined && model.mode === 'image_generation') base.output = base.output_image;
    if (model.mode === 'audio_transcription') base.per_audio_second = amount(model.input_cost_per_second);
    if (model.mode === 'image_generation' && model.output_cost_per_pixel == null && model.output_cost_per_image_token == null
        && !Object.keys(model).some(key => key.startsWith('output_cost_per_image_'))) base.per_image = amount(model.output_cost_per_image);
    if (model.mode === 'video_generation') {
      const variants = Object.keys(model).filter(key => key.startsWith('output_cost_per_second_'));
      if (!variants.length) base.per_video_second = amount(model.output_cost_per_second);
      else if (variants.every(key => /^output_cost_per_second_\d+p$/.test(key))) {
        base.video_resolution_rates = Object.fromEntries(variants.filter(key => amount(model[key]) !== undefined)
          .map(key => [key.slice('output_cost_per_second_'.length), Number(model[key])]));
      }
    }
    if ((base.input === undefined || base.output === undefined) && base.per_audio_second === undefined
        && base.per_video_second === undefined && base.per_image === undefined && !base.video_resolution_rates) continue;
    const rates = base as ModelRates;
    const thresholds = Object.keys(model).flatMap(key => /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key)?.[1] || []);
    for (const threshold of thresholds) (rates.tiers ??= []).push({
      from: Number(threshold) * 1_000 + 1, rates: readLiteRates(model, '_above_' + threshold + 'k_tokens'),
    });
    rates.tiers?.sort((a, b) => a.from - b.from);
    (table[provider] ??= {})[id] = rates;
  }
  for (const [provider, source] of Object.entries(providerIds)) {
    const entries: Record<string, ModelRates> = table[provider] || {};
    for (const [id, model] of Object.entries<any>(models?.[source]?.models || {})) {
      const rates = parseRates(model.cost);
      if (rates) entries[id] = { ...entries[id], ...rates };
    }
    if (Object.keys(entries).length) table[provider] = entries;
  }
  for (const model of router?.data || []) {
    const rates = parseRates(model.pricing, true);
    if (model.id && rates) {
      const entries = table.openrouter ??= {};
      entries[model.id] = { ...entries[model.id], ...rates };
    }
  }
  return table;
}

export function findRates(table: RateTable, provider: string, model: string, prompt: number): TokenRates | null {
  const route = provider === 'codex' ? 'openai' : provider;
  const id = route === 'gemini' ? model.replace(/^models\//, '') : model;
  const models = table[route];
  if (!models) return null;
  // A dated first-party snapshot may share the published price of its exact base model.
  const base = models[id] ?? (['openai', 'anthropic'].includes(route)
    ? models[id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '')] : undefined);
  if (!base || typeof base !== 'object') return null;
  const { tiers, ...rates } = base;
  const tier = tiers?.findLast(t => prompt >= t.from);
  const matched = tier ? { ...rates, ...tier.rates } : rates;
  if (matched.cache_write !== undefined && matched.input !== undefined) {
    if (route === 'anthropic') matched.long_write = matched.input * 2;
    if (route === 'openai') matched.long_write = matched.input * 2.5;
  }
  return matched;
}
