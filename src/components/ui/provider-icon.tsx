import { Key } from 'lucide-react';

// These are checked-in brand assets from the providers or established brand libraries.
const PROVIDER_ICON_PATH: Record<string, string> = {
  gemini: '/icons/providers/gemini.svg',
  openai: '/icons/providers/openai.svg',
  codex: '/icons/providers/openai.svg',
  anthropic: '/icons/providers/anthropic.svg',
  grok: '/icons/providers/grok.svg',
  deepseek: '/icons/providers/deepseek.ico',
  mistral: '/icons/providers/mistral.ico',
  groq: '/icons/providers/groq.svg',
  cerebras: '/icons/providers/cerebras.svg',
  sambanova: '/icons/providers/sambanova.ico',
  together: '/icons/providers/together-favicon.ico',
  fireworks: '/icons/providers/fireworks.ico',
  openrouter: '/icons/providers/openrouter.svg',
  perplexity: '/icons/providers/perplexity.svg',
  cohere: '/icons/providers/cohere.ico',
  deepinfra: '/icons/providers/deepinfra.ico',
  replicate: '/icons/providers/replicate.svg',
  novita: '/icons/providers/novita.ico',
  huggingface: '/icons/providers/huggingface.ico',
  elevenlabs: '/icons/providers/elevenlabs.svg',
  deepgram: '/icons/providers/deepgram.ico',
  hume: '/icons/providers/hume.ico',
  cartesia: '/icons/providers/cartesia.ico',
  playht: '/icons/providers/playht.ico',
  ollama: '/icons/providers/ollama.svg',
  lmstudio: '/icons/providers/lmstudio.ico',
  vllm: '/icons/providers/vllm.ico',
  llamacpp: '/icons/providers/llamacpp.svg',
  cloudflare: '/icons/providers/cloudflare.svg',
  nvidia: '/icons/providers/nvidia.ico',
  qwen: '/icons/providers/qwen.svg',
  mimo: '/icons/providers/mimo.ico',
  tokenhub: '/icons/providers/tokenhub.ico',
  zai: '/icons/providers/zai.svg',
  kimi: '/icons/providers/kimi.ico',
  stepfun: '/icons/providers/stepfun.svg',
  minimax: '/icons/providers/minimax.ico',
  ollamacloud: '/icons/providers/ollama.svg',
  arcee: '/icons/providers/arcee.ico',
  gmi: '/icons/providers/gmi.ico',
  kilo: '/icons/providers/kilo.ico',
  opencode: '/icons/providers/opencode.svg',
  upstage: '/icons/providers/upstage.png',
  custom: '/icons/providers/custom.svg',
};

const NEUTRAL_ICON_COLOR = 'var(--provider-icon-neutral, #D4D4D8)';

const PROVIDER_ICON_COLOR: Record<string, string> = {
  openai: '#10A37F',
  codex: '#10A37F',
  anthropic: '#D97757',
  grok: NEUTRAL_ICON_COLOR,
  deepseek: '#5786FE',
  mistral: '#FA520F',
  groq: '#F55036',
  openrouter: '#94A3B8',
  perplexity: '#1FB8CD',
  replicate: '#A3A3A3',
  elevenlabs: NEUTRAL_ICON_COLOR,
  ollama: NEUTRAL_ICON_COLOR,
  vllm: '#30A2FF',
  llamacpp: '#A6CE39',
  cloudflare: '#F38020',
  qwen: '#6950EF',
  kimi: '#F2488C',
  minimax: '#E73562',
  ollamacloud: NEUTRAL_ICON_COLOR,
  opencode: '#22C55E',
  custom: '#607D8B',
};

const PROVIDER_ICON_INTRINSIC_COLOR = new Set(['gemini', 'groq', 'cerebras', 'llamacpp', 'stepfun', 'zai', 'custom']);

const PROVIDER_ICON_MASK_SIZE: Record<string, string> = {
  gemini: '76%',
  mistral: '82%',
  openai: '86%',
  openrouter: '84%',
  groq: '86%',
  anthropic: '82%',
  llamacpp: '92% auto',
};

export function ProviderIconAsset({ provider, className = 'h-4 w-4' }: { provider: string; className?: string }) {
  const iconPath = PROVIDER_ICON_PATH[provider];
  if (!iconPath) return <Key aria-hidden="true" className={`shrink-0 ${className}`} />;
  if (/\.(?:ico|png|jpe?g|webp)$/i.test(iconPath) || PROVIDER_ICON_INTRINSIC_COLOR.has(provider)) {
    return <img aria-hidden="true" alt="" className={`shrink-0 object-contain ${className}`} src={iconPath} />;
  }
  const mask = `url(${iconPath}) center / ${PROVIDER_ICON_MASK_SIZE[provider] || '84%'} no-repeat`;
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{ color: PROVIDER_ICON_COLOR[provider], WebkitMask: mask, mask }}
    />
  );
}
