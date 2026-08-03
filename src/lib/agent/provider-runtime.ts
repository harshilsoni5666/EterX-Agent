import type { MainAgentProvider } from './model-routing';

export type OpenAICompatibleProvider = Exclude<MainAgentProvider, 'gemini' | 'anthropic'>;

type ProviderRuntimeDefinition = {
  label: string;
  compactLabel: string;
  defaultModel: string;
  baseURL: string | (() => string);
  local?: boolean;
  visionModelPattern?: RegExp;
};

const globalForProviderRuntime = globalThis as typeof globalThis & {
  __eterxProviderBaseURLs?: Partial<Record<MainAgentProvider, string>>;
};
const runtimeBaseURLs = globalForProviderRuntime.__eterxProviderBaseURLs
  || (globalForProviderRuntime.__eterxProviderBaseURLs = {});

const normalizeBaseURL = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const clean = value.trim().replace(/\/+$/, '');
  if (!clean || clean.length > 2048 || /[\r\n\t]/.test(clean)) return '';
  try {
    const url = new URL(clean);
    return url.protocol === 'http:' || url.protocol === 'https:' ? clean : '';
  } catch {
    return '';
  }
};

export function applyRuntimeProviderBaseURLs(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  Object.keys(runtimeBaseURLs).forEach(provider => {
    delete runtimeBaseURLs[provider as MainAgentProvider];
  });
  const statuses: Record<string, boolean> = {};
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (provider !== 'anthropic' && !(provider in OPENAI_COMPATIBLE_PROVIDERS)) continue;
    const normalized = normalizeBaseURL(value);
    if (normalized) runtimeBaseURLs[provider as MainAgentProvider] = normalized;
    else delete runtimeBaseURLs[provider as MainAgentProvider];
    statuses[provider] = Boolean(normalized);
  }
  return statuses;
}

export function getRuntimeProviderBaseURLs(): Partial<Record<MainAgentProvider, string>> {
  return { ...runtimeBaseURLs };
}

const envOr = (name: string, fallback: string) => () =>
  String(process.env[name] || fallback).replace(/\/+$/, '');

export const OPENAI_COMPATIBLE_PROVIDERS: Record<OpenAICompatibleProvider, ProviderRuntimeDefinition> = {
  mistral: {
    label: 'Mistral AI',
    compactLabel: 'Mistral',
    defaultModel: 'mistral-medium-3-5',
    baseURL: envOr('MISTRAL_BASE_URL', process.env.MISTRAL_API_BASE_URL || 'https://api.mistral.ai/v1'),
    visionModelPattern: /(pixtral|vision|ministral|mistral-(?:small|medium)-3)/i,
  },
  openai: {
    label: 'OpenAI',
    compactLabel: 'OpenAI',
    defaultModel: 'gpt-5.6-sol',
    baseURL: envOr('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    visionModelPattern: /\b(gpt-4o|gpt-4\.1|gpt-5|o[134](?:\b|-)|chatgpt)/i,
  },
  openrouter: {
    label: 'OpenRouter',
    compactLabel: 'Router',
    defaultModel: 'openai/gpt-oss-120b',
    baseURL: envOr('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    visionModelPattern: /(gemini|claude|gpt-4o|gpt-4\.1|gpt-5|grok|pixtral|qwen.*(?:3\.6|vl|vision)|llama-4|vision)/i,
  },
  groq: {
    label: 'Groq',
    compactLabel: 'Groq',
    defaultModel: 'openai/gpt-oss-120b',
    baseURL: envOr('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
    visionModelPattern: /(qwen\/qwen3\.6|qwen.*(?:vl|vision)|llama-4|vision)/i,
  },
  deepseek: {
    label: 'DeepSeek',
    compactLabel: 'DeepSeek',
    defaultModel: 'deepseek-v4-pro',
    baseURL: envOr('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
  },
  grok: {
    label: 'xAI Grok',
    compactLabel: 'Grok',
    defaultModel: 'grok-4.5',
    baseURL: envOr('XAI_BASE_URL', 'https://api.x.ai/v1'),
    visionModelPattern: /(grok-(?:4|3|2)|vision)/i,
  },
  cerebras: {
    label: 'Cerebras',
    compactLabel: 'Cerebras',
    defaultModel: 'gpt-oss-120b',
    baseURL: envOr('CEREBRAS_BASE_URL', 'https://api.cerebras.ai/v1'),
  },
  together: {
    label: 'Together AI',
    compactLabel: 'Together',
    defaultModel: 'openai/gpt-oss-120b',
    baseURL: envOr('TOGETHER_BASE_URL', 'https://api.together.xyz/v1'),
    visionModelPattern: /(vision|vl|llama-4|gemma-4|qwen3\.6)/i,
  },
  fireworks: {
    label: 'Fireworks AI',
    compactLabel: 'Fireworks',
    defaultModel: 'accounts/fireworks/models/gpt-oss-120b',
    baseURL: envOr('FIREWORKS_BASE_URL', 'https://api.fireworks.ai/inference/v1'),
    visionModelPattern: /(vision|vl|llama-4|qwen3\.6)/i,
  },
  sambanova: {
    label: 'SambaNova',
    compactLabel: 'SambaNova',
    defaultModel: 'DeepSeek-V4',
    baseURL: envOr('SAMBANOVA_BASE_URL', 'https://api.sambanova.ai/v1'),
  },
  perplexity: {
    label: 'Perplexity',
    compactLabel: 'Perplexity',
    defaultModel: 'sonar-pro',
    baseURL: envOr('PERPLEXITY_BASE_URL', 'https://api.perplexity.ai'),
  },
  deepinfra: {
    label: 'DeepInfra',
    compactLabel: 'DeepInfra',
    defaultModel: 'openai/gpt-oss-120b',
    baseURL: envOr('DEEPINFRA_BASE_URL', 'https://api.deepinfra.com/v1/openai'),
    visionModelPattern: /(vision|vl|llama-4|gemma-4|qwen3\.6)/i,
  },
  huggingface: {
    label: 'Hugging Face',
    compactLabel: 'HF',
    defaultModel: 'openai/gpt-oss-120b:fastest',
    baseURL: envOr('HUGGINGFACE_BASE_URL', 'https://router.huggingface.co/v1'),
    visionModelPattern: /(vision|vl|gemma-4|qwen3\.6|glm-.*v)/i,
  },
  nvidia: {
    label: 'NVIDIA NIM',
    compactLabel: 'NVIDIA',
    defaultModel: 'openai/gpt-oss-120b',
    baseURL: envOr('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
    visionModelPattern: /(vision|vl|llama-4|nemotron.*vl)/i,
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    compactLabel: 'Cloudflare',
    defaultModel: '@cf/openai/gpt-oss-120b',
    baseURL: () => {
      const explicit = String(process.env.CLOUDFLARE_AI_BASE_URL || '').replace(/\/+$/, '');
      if (explicit) return explicit;
      const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
      return accountId
        ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
        : '';
    },
    visionModelPattern: /(@cf\/.*(?:vision|gemma-4|kimi-k2\.6|glm-5)|vision|vl)/i,
  },
  ollama: {
    label: 'Ollama Local',
    compactLabel: 'Ollama',
    defaultModel: 'gpt-oss:20b',
    baseURL: envOr('OLLAMA_OPENAI_BASE_URL', 'http://127.0.0.1:11434/v1'),
    local: true,
    visionModelPattern: /(vision|llava|bakllava|moondream|qwen.*vl|gemma3|gemma4)/i,
  },
  lmstudio: {
    label: 'LM Studio Local',
    compactLabel: 'LM Studio',
    defaultModel: 'openai/gpt-oss-20b',
    baseURL: envOr('LMSTUDIO_OPENAI_BASE_URL', 'http://127.0.0.1:1234/v1'),
    local: true,
    visionModelPattern: /(vision|vl|llava|gemma|qwen)/i,
  },
  vllm: {
    label: 'vLLM Local',
    compactLabel: 'vLLM',
    defaultModel: 'openai/gpt-oss-20b',
    baseURL: envOr('VLLM_BASE_URL', 'http://127.0.0.1:8000/v1'),
    local: true,
    visionModelPattern: /(vision|vl|llava|gemma|qwen)/i,
  },
  llamacpp: {
    label: 'llama.cpp Local',
    compactLabel: 'llama.cpp',
    defaultModel: 'local-model',
    baseURL: envOr('LLAMACPP_BASE_URL', 'http://127.0.0.1:8080/v1'),
    local: true,
    visionModelPattern: /(vision|vl|llava|gemma|qwen)/i,
  },
  novita: {
    label: 'Novita AI',
    compactLabel: 'Novita',
    defaultModel: 'deepseek/deepseek-v3.2',
    baseURL: envOr('NOVITA_BASE_URL', 'https://api.novita.ai/openai'),
    visionModelPattern: /(vision|vl|llava|qwen.*vl)/i,
  },
  qwen: {
    label: 'Qwen Cloud',
    compactLabel: 'Qwen',
    defaultModel: 'qwen-plus',
    baseURL: envOr('QWEN_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    visionModelPattern: /(qwen.*vl|omni|vision)/i,
  },
  mimo: {
    label: 'Xiaomi MiMo',
    compactLabel: 'MiMo',
    defaultModel: 'mimo-v2.5-pro',
    baseURL: envOr('MIMO_BASE_URL', 'https://api.xiaomimimo.com/v1'),
    visionModelPattern: /(omni|vision|vl)/i,
  },
  tokenhub: {
    label: 'Tencent TokenHub',
    compactLabel: 'TokenHub',
    defaultModel: 'hy3-preview',
    baseURL: envOr('TOKENHUB_BASE_URL', 'https://tokenhub.tencentmaas.com/v1'),
    visionModelPattern: /(vision|vl|omni)/i,
  },
  zai: {
    label: 'Z.AI / GLM',
    compactLabel: 'GLM',
    defaultModel: 'glm-5',
    baseURL: envOr('ZAI_BASE_URL', 'https://api.z.ai/api/paas/v4'),
    visionModelPattern: /(glm-.*v|vision|vl)/i,
  },
  kimi: {
    label: 'Kimi / Moonshot',
    compactLabel: 'Kimi',
    defaultModel: 'kimi-k2.5',
    baseURL: envOr('KIMI_BASE_URL', 'https://api.moonshot.ai/v1'),
    visionModelPattern: /(kimi-k2\.[5-9]|vision|vl)/i,
  },
  stepfun: {
    label: 'StepFun Step Plan',
    compactLabel: 'StepFun',
    defaultModel: 'step-3.5-flash',
    baseURL: envOr('STEPFUN_BASE_URL', 'https://api.stepfun.ai/step_plan/v1'),
    visionModelPattern: /(vision|vl|omni)/i,
  },
  minimax: {
    label: 'MiniMax',
    compactLabel: 'MiniMax',
    defaultModel: 'MiniMax-M2.5',
    baseURL: envOr('MINIMAX_BASE_URL', 'https://api.minimax.io/v1'),
    visionModelPattern: /(vision|vl|omni)/i,
  },
  ollamacloud: {
    label: 'Ollama Cloud',
    compactLabel: 'Ollama Cloud',
    defaultModel: 'gpt-oss:120b-cloud',
    baseURL: envOr('OLLAMA_CLOUD_BASE_URL', 'https://ollama.com/v1'),
    visionModelPattern: /(vision|vl|llava|gemma|qwen)/i,
  },
  arcee: {
    label: 'Arcee AI',
    compactLabel: 'Arcee',
    defaultModel: 'trinity-mini',
    baseURL: envOr('ARCEE_BASE_URL', 'https://api.arcee.ai/api/v1'),
  },
  gmi: {
    label: 'GMI Cloud',
    compactLabel: 'GMI',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    baseURL: envOr('GMI_BASE_URL', ''),
    visionModelPattern: /(vision|vl|omni)/i,
  },
  kilo: {
    label: 'Kilo Gateway',
    compactLabel: 'Kilo',
    defaultModel: 'auto',
    baseURL: envOr('KILO_BASE_URL', ''),
    visionModelPattern: /(vision|vl|omni|gemini|claude|gpt|grok)/i,
  },
  opencode: {
    label: 'OpenCode Zen',
    compactLabel: 'OpenCode',
    defaultModel: 'deepseek-v4-flash-free',
    baseURL: envOr('OPENCODE_BASE_URL', 'https://opencode.ai/zen/v1'),
    visionModelPattern: /(vision|vl|omni|gemini|gpt|grok)/i,
  },
  upstage: {
    label: 'Upstage Solar',
    compactLabel: 'Upstage',
    defaultModel: 'solar-pro2',
    baseURL: envOr('UPSTAGE_BASE_URL', 'https://api.upstage.ai/v1'),
    visionModelPattern: /(vision|document|ocr)/i,
  },
  custom: {
    label: 'Custom OpenAI-compatible endpoint',
    compactLabel: 'Custom',
    defaultModel: 'default',
    baseURL: envOr('ETERX_CUSTOM_OPENAI_BASE_URL', ''),
    visionModelPattern: /(vision|vl|omni|gemini|claude|gpt|grok|llava)/i,
  },
};

export function getProviderRuntime(provider: MainAgentProvider): ProviderRuntimeDefinition | null {
  return provider === 'gemini' || provider === 'anthropic'
    ? null
    : OPENAI_COMPATIBLE_PROVIDERS[provider];
}

export function getProviderBaseURL(provider: MainAgentProvider): string {
  const override = runtimeBaseURLs[provider];
  if (override) return override;
  if (provider === 'anthropic') {
    return String(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  }
  const value = getProviderRuntime(provider)?.baseURL;
  return typeof value === 'function' ? value() : value || '';
}

export function isLocalModelProvider(provider: MainAgentProvider): boolean {
  return getProviderRuntime(provider)?.local === true;
}

export function providerModelSupportsVision(provider: MainAgentProvider, modelName: string): boolean {
  return getProviderRuntime(provider)?.visionModelPattern?.test(String(modelName || '')) === true;
}
