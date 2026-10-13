import type { MainAgentProvider } from './model-routing';

export type OpenAICompatibleProvider = Exclude<MainAgentProvider, 'gemini' | 'anthropic'>;

type ProviderRuntimeDefinition = {
  label: string;
  compactLabel: string;
  baseURL: string | (() => string);
  local?: boolean;
  visionModelPattern?: RegExp;
};

const LOCAL_OPENAI_PROVIDERS = new Set<MainAgentProvider>([
  'ollama',
  'lmstudio',
  'vllm',
  'llamacpp',
]);

const PROVIDER_ROOT_SUFFIX: Partial<Record<MainAgentProvider, string>> = {
  mistral: '/v1',
  openai: '/v1',
  openrouter: '/api/v1',
  groq: '/openai/v1',
  deepseek: '/v1',
  grok: '/v1',
  cerebras: '/v1',
  together: '/v1',
  fireworks: '/inference/v1',
  sambanova: '/v1',
  perplexity: '/v1',
  deepinfra: '/v1/openai',
  huggingface: '/v1',
  nvidia: '/v1',
  novita: '/openai/v1',
  qwen: '/compatible-mode/v1',
  mimo: '/v1',
  tokenhub: '/v1',
  zai: '/api/paas/v4',
  kimi: '/v1',
  stepfun: '/v1',
  minimax: '/v1',
  ollamacloud: '/v1',
  arcee: '/api/v1',
  gmi: '/v1',
  kilo: '/api/gateway',
  opencode: '/zen/v1',
  upstage: '/v1',
};

/**
 * Users commonly paste either a server root (`http://localhost:11434`), an
 * OpenAI base (`.../v1`), or the full endpoint (`.../v1/chat/completions`).
 * The OpenAI SDK expects the base only, so normalize all three forms at the
 * boundary. Local engines are deliberately normalized to `/v1`, which is the
 * documented OpenAI-compatible route for all four engines supported here.
 */
export function normalizeProviderBaseURL(provider: MainAgentProvider, value: unknown): string {
  if (typeof value !== 'string') return '';
  const clean = value.trim().replace(/[\r\n\t]/g, '');
  if (!clean || clean.length > 2048) return '';

  try {
    const url = new URL(clean);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

    let pathname = url.pathname.replace(/\/+$/, '');
    // Accept a full OpenAI endpoint in settings without causing the SDK to
    // request `/chat/completions/chat/completions` or `/models/models`.
    pathname = pathname.replace(/\/(?:chat\/completions|completions|responses|messages|models)$/i, '');
    // Repair the historical Novita preset and saved copies of that preset.
    if (provider === 'novita' && url.hostname === 'api.novita.ai' && pathname === '/openai') pathname = '/openai/v1';

    if (LOCAL_OPENAI_PROVIDERS.has(provider)) {
      // Ollama's native API uses `/api/tags`; its OpenAI-compatible API uses
      // `/v1`. Treat a pasted native discovery URL as the same server and use
      // the OpenAI route for actual chat/tool calls.
      pathname = pathname.replace(/\/api\/v1$/i, '');
      pathname = pathname.replace(/\/api(?:\/tags)?$/i, '');
      if (!pathname || pathname === '/') pathname = '/v1';
      else if (!/\/v1$/i.test(pathname)) pathname = `${pathname}/v1`;
    } else if (!pathname || pathname === '/') {
      pathname = PROVIDER_ROOT_SUFFIX[provider] || '';
    }

    url.pathname = pathname || '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

const globalForProviderRuntime = globalThis as typeof globalThis & {
  __eterxProviderBaseURLs?: Partial<Record<MainAgentProvider, string>>;
};
const runtimeBaseURLs = globalForProviderRuntime.__eterxProviderBaseURLs
  || (globalForProviderRuntime.__eterxProviderBaseURLs = {});

export function applyRuntimeProviderBaseURLs(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  Object.keys(runtimeBaseURLs).forEach(provider => {
    delete runtimeBaseURLs[provider as MainAgentProvider];
  });
  const statuses: Record<string, boolean> = {};
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (provider !== 'anthropic' && !(provider in OPENAI_COMPATIBLE_PROVIDERS)) continue;
    const normalized = normalizeProviderBaseURL(provider as MainAgentProvider, value);
    if (normalized) runtimeBaseURLs[provider as MainAgentProvider] = normalized;
    else delete runtimeBaseURLs[provider as MainAgentProvider];
    statuses[provider] = Boolean(normalized);
  }
  return statuses;
}

export function getRuntimeProviderBaseURLs(): Partial<Record<MainAgentProvider, string>> {
  return { ...runtimeBaseURLs };
}

const envOr = (provider: MainAgentProvider, name: string, fallback: string) => () =>
  normalizeProviderBaseURL(provider, String(process.env[name] || fallback));

export const OPENAI_COMPATIBLE_PROVIDERS: Record<OpenAICompatibleProvider, ProviderRuntimeDefinition> = {
  mistral: {
    label: 'Mistral AI',
    compactLabel: 'Mistral',
    baseURL: envOr('mistral', 'MISTRAL_BASE_URL', process.env.MISTRAL_API_BASE_URL || 'https://api.mistral.ai/v1'),
    visionModelPattern: /(pixtral|vision|ministral|mistral-(?:small|medium)-3)/i,
  },
  openai: {
    label: 'OpenAI',
    compactLabel: 'OpenAI',
    baseURL: envOr('openai', 'OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    visionModelPattern: /\b(gpt-4o|gpt-4\.1|gpt-5|o[134](?:\b|-)|chatgpt)/i,
  },
  openrouter: {
    label: 'OpenRouter',
    compactLabel: 'Router',
    baseURL: envOr('openrouter', 'OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    visionModelPattern: /(gemini|claude|gpt-4o|gpt-4\.1|gpt-5|grok|pixtral|qwen.*(?:3\.6|vl|vision)|llama-4|vision)/i,
  },
  groq: {
    label: 'Groq',
    compactLabel: 'Groq',
    baseURL: envOr('groq', 'GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
    visionModelPattern: /(qwen\/qwen3\.6|qwen.*(?:vl|vision)|llama-4|vision)/i,
  },
  deepseek: {
    label: 'DeepSeek',
    compactLabel: 'DeepSeek',
    baseURL: envOr('deepseek', 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
  },
  grok: {
    label: 'xAI Grok',
    compactLabel: 'Grok',
    baseURL: envOr('grok', 'XAI_BASE_URL', 'https://api.x.ai/v1'),
    visionModelPattern: /(grok-(?:4|3|2)|vision)/i,
  },
  cerebras: {
    label: 'Cerebras',
    compactLabel: 'Cerebras',
    baseURL: envOr('cerebras', 'CEREBRAS_BASE_URL', 'https://api.cerebras.ai/v1'),
  },
  together: {
    label: 'Together AI',
    compactLabel: 'Together',
    baseURL: envOr('together', 'TOGETHER_BASE_URL', 'https://api.together.ai/v1'),
    visionModelPattern: /(vision|vl|llama-4|gemma-4|qwen3\.6)/i,
  },
  fireworks: {
    label: 'Fireworks AI',
    compactLabel: 'Fireworks',
    baseURL: envOr('fireworks', 'FIREWORKS_BASE_URL', 'https://api.fireworks.ai/inference/v1'),
    visionModelPattern: /(vision|vl|llama-4|qwen3\.6)/i,
  },
  sambanova: {
    label: 'SambaNova',
    compactLabel: 'SambaNova',
    baseURL: envOr('sambanova', 'SAMBANOVA_BASE_URL', 'https://api.sambanova.ai/v1'),
  },
  perplexity: {
    label: 'Perplexity',
    compactLabel: 'Perplexity',
    baseURL: envOr('perplexity', 'PERPLEXITY_BASE_URL', 'https://api.perplexity.ai/v1'),
  },
  deepinfra: {
    label: 'DeepInfra',
    compactLabel: 'DeepInfra',
    baseURL: envOr('deepinfra', 'DEEPINFRA_BASE_URL', 'https://api.deepinfra.com/v1/openai'),
    visionModelPattern: /(vision|vl|llama-4|gemma-4|qwen3\.6)/i,
  },
  huggingface: {
    label: 'Hugging Face',
    compactLabel: 'HF',
    baseURL: envOr('huggingface', 'HUGGINGFACE_BASE_URL', 'https://router.huggingface.co/v1'),
    visionModelPattern: /(vision|vl|gemma-4|qwen3\.6|glm-.*v)/i,
  },
  nvidia: {
    label: 'NVIDIA NIM',
    compactLabel: 'NVIDIA',
    baseURL: envOr('nvidia', 'NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
    visionModelPattern: /(vision|vl|llama-4|nemotron.*vl)/i,
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    compactLabel: 'Cloudflare',
    baseURL: () => {
      const explicit = normalizeProviderBaseURL('cloudflare', String(process.env.CLOUDFLARE_AI_BASE_URL || ''));
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
    baseURL: envOr('ollama', 'OLLAMA_OPENAI_BASE_URL', 'http://127.0.0.1:11434/v1'),
    local: true,
    visionModelPattern: /(vision|llava|bakllava|moondream|qwen.*vl|gemma3|gemma4)/i,
  },
  lmstudio: {
    label: 'LM Studio Local',
    compactLabel: 'LM Studio',
    baseURL: envOr('lmstudio', 'LMSTUDIO_OPENAI_BASE_URL', 'http://127.0.0.1:1234/v1'),
    local: true,
    visionModelPattern: /(vision|vl|llava|gemma|qwen)/i,
  },
  vllm: {
    label: 'vLLM Local',
    compactLabel: 'vLLM',
    baseURL: envOr('vllm', 'VLLM_BASE_URL', 'http://127.0.0.1:8000/v1'),
    local: true,
    visionModelPattern: /(vision|vl|llava|gemma|qwen)/i,
  },
  llamacpp: {
    label: 'llama.cpp Local',
    compactLabel: 'llama.cpp',
    baseURL: envOr('llamacpp', 'LLAMACPP_BASE_URL', 'http://127.0.0.1:8080/v1'),
    local: true,
    visionModelPattern: /(vision|vl|llava|gemma|qwen)/i,
  },
  novita: {
    label: 'Novita AI',
    compactLabel: 'Novita',
    baseURL: envOr('novita', 'NOVITA_BASE_URL', 'https://api.novita.ai/openai/v1'),
    visionModelPattern: /(vision|vl|llava|qwen.*vl)/i,
  },
  qwen: {
    label: 'Qwen Cloud',
    compactLabel: 'Qwen',
    baseURL: envOr('qwen', 'QWEN_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    visionModelPattern: /(qwen.*vl|omni|vision)/i,
  },
  mimo: {
    label: 'Xiaomi MiMo',
    compactLabel: 'MiMo',
    baseURL: envOr('mimo', 'MIMO_BASE_URL', 'https://api.xiaomimimo.com/v1'),
    visionModelPattern: /(omni|vision|vl)/i,
  },
  tokenhub: {
    label: 'Tencent TokenHub',
    compactLabel: 'TokenHub',
    baseURL: envOr('tokenhub', 'TOKENHUB_BASE_URL', 'https://tokenhub.tencentmaas.com/v1'),
    visionModelPattern: /(vision|vl|omni)/i,
  },
  zai: {
    label: 'Z.AI / GLM',
    compactLabel: 'GLM',
    baseURL: envOr('zai', 'ZAI_BASE_URL', 'https://api.z.ai/api/paas/v4'),
    visionModelPattern: /(glm-.*v|vision|vl)/i,
  },
  kimi: {
    label: 'Kimi / Moonshot',
    compactLabel: 'Kimi',
    baseURL: envOr('kimi', 'KIMI_BASE_URL', 'https://api.moonshot.ai/v1'),
    visionModelPattern: /(kimi-k2\.[5-9]|vision|vl)/i,
  },
  stepfun: {
    label: 'StepFun Step Plan',
    compactLabel: 'StepFun',
    baseURL: envOr('stepfun', 'STEPFUN_BASE_URL', 'https://api.stepfun.com/v1'),
    visionModelPattern: /(vision|vl|omni)/i,
  },
  minimax: {
    label: 'MiniMax',
    compactLabel: 'MiniMax',
    baseURL: envOr('minimax', 'MINIMAX_BASE_URL', 'https://api.minimaxi.com/v1'),
    visionModelPattern: /(vision|vl|omni)/i,
  },
  ollamacloud: {
    label: 'Ollama Cloud',
    compactLabel: 'Ollama Cloud',
    baseURL: envOr('ollamacloud', 'OLLAMA_CLOUD_BASE_URL', 'https://ollama.com/v1'),
    visionModelPattern: /(vision|vl|llava|gemma|qwen)/i,
  },
  arcee: {
    label: 'Arcee AI',
    compactLabel: 'Arcee',
    baseURL: envOr('arcee', 'ARCEE_BASE_URL', 'https://api.arcee.ai/api/v1'),
  },
  gmi: {
    label: 'GMI Cloud',
    compactLabel: 'GMI',
    baseURL: envOr('gmi', 'GMI_BASE_URL', 'https://api.gmi-serving.com/v1'),
    visionModelPattern: /(vision|vl|omni)/i,
  },
  kilo: {
    label: 'Kilo Gateway',
    compactLabel: 'Kilo',
    baseURL: envOr('kilo', 'KILO_BASE_URL', 'https://api.kilo.ai/api/gateway'),
    visionModelPattern: /(vision|vl|omni|gemini|claude|gpt|grok)/i,
  },
  opencode: {
    label: 'OpenCode Zen',
    compactLabel: 'OpenCode',
    baseURL: envOr('opencode', 'OPENCODE_BASE_URL', 'https://opencode.ai/zen/v1'),
    visionModelPattern: /(vision|vl|omni|gemini|gpt|grok)/i,
  },
  upstage: {
    label: 'Upstage Solar',
    compactLabel: 'Upstage',
    baseURL: envOr('upstage', 'UPSTAGE_BASE_URL', 'https://api.upstage.ai/v1'),
    visionModelPattern: /(vision|document|ocr)/i,
  },
  custom: {
    label: 'Custom OpenAI-compatible endpoint',
    compactLabel: 'Custom',
    baseURL: envOr('custom', 'ETERX_CUSTOM_OPENAI_BASE_URL', ''),
    visionModelPattern: /(vision|vl|omni|gemini|claude|gpt|grok|llava)/i,
  },
};

export function getProviderRuntime(provider: MainAgentProvider): ProviderRuntimeDefinition | null {
  return provider === 'gemini' || provider === 'anthropic'
    ? null
    : OPENAI_COMPATIBLE_PROVIDERS[provider];
}

export function getProviderBaseURL(provider: MainAgentProvider, scopedOverrides?: Partial<Record<MainAgentProvider, string>>): string {
  const override = (scopedOverrides || runtimeBaseURLs)[provider];
  if (override) return override;
  if (provider === 'anthropic') {
    return normalizeProviderBaseURL('anthropic', String(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'))
      .replace(/\/v1$/i, '');
  }
  const value = getProviderRuntime(provider)?.baseURL;
  return typeof value === 'function'
    ? value()
    : normalizeProviderBaseURL(provider, value || '');
}

export function isLocalModelProvider(provider: MainAgentProvider): boolean {
  return getProviderRuntime(provider)?.local === true;
}

export function providerModelSupportsVision(provider: MainAgentProvider, modelName: string): boolean {
  return getProviderRuntime(provider)?.visionModelPattern?.test(String(modelName || '')) === true;
}
