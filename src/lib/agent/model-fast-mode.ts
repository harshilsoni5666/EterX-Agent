// Models listed by OpenAI for Fast processing. A live connection still
// determines which models and tiers the user's project is allowed to use.
const OPENAI_FAST_MODELS = new Set([
  'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-6.1-sol', 'gpt-6.1-terra',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
  'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5.1-codex', 'gpt-5-codex',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-mini',
  'gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20',
]);

export const FAST_TIER = 'priority';
const FAST_REQUEST_PREFIX = 'request-speed:fast:';

export function isOpenAiFastModel(model: string): boolean {
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (base === 'gpt-4o') return OPENAI_FAST_MODELS.has(model);
  return OPENAI_FAST_MODELS.has(base);
}

export function isNativeOpenAiEndpoint(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return url.protocol === 'https:'
      && (url.hostname === 'api.openai.com' || url.hostname.endsWith('.api.openai.com'));
  } catch {
    return false;
  }
}

export const openAiFastRequest = (model: string) => `${FAST_REQUEST_PREFIX}openai:${model}`;
const codexFastPrefix = (model: string) => `${FAST_REQUEST_PREFIX}codex:${model}:`;
export const codexFastRequest = (model: string, accountId: string) => `${codexFastPrefix(model)}${accountId}`;

export function withFastRequestTags(capabilities: string[], requestOptions: unknown): string[] {
  const tags = Array.isArray(requestOptions)
    ? requestOptions.filter((value): value is string => typeof value === 'string' && value.startsWith(FAST_REQUEST_PREFIX))
    : [];
  return [...new Set([...tags, ...capabilities.filter(value => !value.startsWith(FAST_REQUEST_PREFIX))])];
}

export function requestedCodexFastAccount(model: string, capabilities: string[]): string | undefined {
  const prefix = codexFastPrefix(model);
  for (const value of capabilities) {
    if (!value.startsWith(prefix)) continue;
    const id = value.slice(prefix.length);
    if (/^[a-f\d-]{36}$/i.test(id)) return id;
  }
}
