import fs from 'node:fs/promises';
import path from 'node:path';
import {
  IMAGE_PROVIDER_IDS,
  IMAGE_PROVIDER_META,
  normalizeImageSettings,
  type ImageProvider,
  type ImageSettings,
} from './image-generation-config';

export type ImageGenerationInput = {
  prompt: string;
  width?: number;
  height?: number;
  filePath: string;
  model?: string;
};

export type ImageGenerationResult = {
  success: boolean;
  filePath: string;
  provider: ImageProvider | '';
  model: string;
  providerActionMode: 'provider-native' | 'unavailable' | 'failed' | '';
  message: string;
};

type ImageRuntimeGlobal = typeof globalThis & {
  __eterxImageSettings?: ImageSettings;
  __eterxImageKeyCursor?: Partial<Record<ImageProvider, number>>;
};

const runtimeGlobal = globalThis as ImageRuntimeGlobal;
const keyCursor = runtimeGlobal.__eterxImageKeyCursor || (runtimeGlobal.__eterxImageKeyCursor = {});

const environmentKeys: Record<ImageProvider, string[]> = {
  deepinfra: ['ETERX_IMAGE_DEEPINFRA_API_KEY', 'DEEPINFRA_API_KEY', 'DEEPINFRA_TOKEN'],
  fal: ['ETERX_IMAGE_FAL_API_KEY', 'FAL_KEY', 'FAL_API_KEY'],
  krea: ['ETERX_IMAGE_KREA_API_KEY', 'KREA_API_TOKEN', 'KREA_API_KEY'],
  openai: ['ETERX_IMAGE_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  openrouter: ['ETERX_IMAGE_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  xai: ['ETERX_IMAGE_XAI_API_KEY', 'XAI_API_KEY'],
  freepik: ['ETERX_IMAGE_FREEPIK_API_KEY', 'FREEPIK_API_KEY', 'ETERX_FREEPIK_API_KEY'],
};

const environmentBaseURLs: Record<ImageProvider, string[]> = {
  deepinfra: ['DEEPINFRA_IMAGE_BASE_URL'],
  fal: ['FAL_IMAGE_BASE_URL'],
  krea: ['KREA_IMAGE_BASE_URL'],
  openai: ['OPENAI_IMAGE_BASE_URL'],
  openrouter: ['OPENROUTER_IMAGE_BASE_URL'],
  xai: ['XAI_IMAGE_BASE_URL'],
  freepik: ['FREEPIK_IMAGE_BASE_URL'],
};

const envValues = (names: string[]): string[] => Array.from(new Set(names.flatMap(name => [
  String(process.env[name] || '').trim(),
  ...Array.from({ length: 3 }, (_, index) => String(process.env[`${name}_${index + 1}`] || '').trim()),
].filter(Boolean))));

const envBaseURL = (provider: ImageProvider): string => environmentBaseURLs[provider]
  .map(name => String(process.env[name] || '').trim().replace(/\/+$/, ''))
  .find(Boolean) || '';

const readEnvironmentSettings = (): ImageSettings => normalizeImageSettings({
  enabled: process.env.ETERX_IMAGE_ENABLED !== '0',
  provider: process.env.ETERX_IMAGE_PROVIDER,
  fallbackProviders: String(process.env.ETERX_IMAGE_FALLBACK_PROVIDERS || '')
    .split(',').map(value => value.trim()).filter(Boolean),
  modelByProvider: Object.fromEntries(IMAGE_PROVIDER_IDS.map(provider => [
    provider,
    String(process.env[`ETERX_IMAGE_MODEL_${provider.toUpperCase()}`] || '').trim(),
  ])),
  apiKeys: Object.fromEntries(IMAGE_PROVIDER_IDS.map(provider => [provider, envValues(environmentKeys[provider])])),
  baseURLs: Object.fromEntries(IMAGE_PROVIDER_IDS.map(provider => [provider, envBaseURL(provider)])),
});

const initialSettings = runtimeGlobal.__eterxImageSettings || (runtimeGlobal.__eterxImageSettings = readEnvironmentSettings());

export function getRuntimeImageSettings(): ImageSettings {
  return normalizeImageSettings(runtimeGlobal.__eterxImageSettings || initialSettings);
}

export function applyRuntimeImageSettings(raw: unknown): ImageSettings {
  const next = normalizeImageSettings(raw);
  initialSettings.enabled = next.enabled;
  initialSettings.provider = next.provider;
  initialSettings.fallbackProviders = next.fallbackProviders;
  initialSettings.modelByProvider = next.modelByProvider;
  initialSettings.apiKeys = next.apiKeys;
  initialSettings.baseURLs = next.baseURLs;
  runtimeGlobal.__eterxImageSettings = initialSettings;
  return getRuntimeImageSettings();
}

const providerOrder = (settings: ImageSettings): ImageProvider[] => Array.from(new Set([
  settings.provider,
  ...settings.fallbackProviders,
]));

const keysForProvider = (provider: ImageProvider, settings: ImageSettings): string[] => Array.from(new Set([
  ...(settings.apiKeys[provider] || []),
  ...envValues(environmentKeys[provider]),
].map(value => value.trim()).filter(Boolean))).slice(0, 3);

const providerBaseURL = (provider: ImageProvider, settings: ImageSettings, override = '') =>
  (override || settings.baseURLs[provider] || envBaseURL(provider) || IMAGE_PROVIDER_META[provider].defaultBaseURL).replace(/\/+$/, '');

export function getImageGenerationRouteBrief(): string {
  const settings = getRuntimeImageSettings();
  const provider = settings.provider;
  const meta = IMAGE_PROVIDER_META[provider];
  const model = settings.modelByProvider[provider] || meta.defaultModel;
  const activeCredentialReady = !meta.requiresKey || keysForProvider(provider, settings).length > 0;
  const fallbackCredentialState = settings.fallbackProviders.map(item => {
    const fallbackMeta = IMAGE_PROVIDER_META[item];
    return `${fallbackMeta.label}: ${!fallbackMeta.requiresKey || keysForProvider(item, settings).length > 0 ? 'ready' : 'missing credentials'}`;
  }).join(', ') || 'none';
  const fallbackText = settings.fallbackProviders
    .map(item => `${IMAGE_PROVIDER_META[item].label}/${settings.modelByProvider[item] || IMAGE_PROVIDER_META[item].defaultModel}`)
    .join(' -> ') || 'None';
  const status = meta.available ? 'available' : `unavailable: ${meta.unavailableReason || 'connection not installed'}`;
  return [
    '[Image generation route]',
    `Active provider: ${meta.label}. Model: ${model}. Status: ${status}. Credential: ${activeCredentialReady ? 'ready' : 'missing'}.`,
    `Capabilities: text-to-image${meta.supportsEditing ? ', image editing' : ''}${meta.supportsAspectRatio ? ', aspect-ratio control' : ''}.`,
    `Fallback order: ${fallbackText}.`,
    `Fallback credentials: ${fallbackCredentialState}.`,
    'The image_generator tool reads this route again for every call. It uses the selected provider/model, rotates configured keys, switches through enabled fallbacks after a real request failure, and saves only returned raster bytes.',
  ].join('\n');
}

const withTimeout = async <T,>(promise: Promise<T>, milliseconds = 60_000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Image request timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const request = async (url: string, init: RequestInit, timeout = 60_000): Promise<Response> => {
  const response = await withTimeout(fetch(url, init), timeout);
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  let detail = body;
  try {
    const parsed = body ? JSON.parse(body) : null;
    detail = parsed?.error?.message || parsed?.error || parsed?.message || body;
  } catch { }
  throw new Error(`${response.status} ${response.statusText}${detail ? `: ${String(detail).slice(0, 320)}` : ''}`);
};

const jsonRequest = async (url: string, init: RequestInit, timeout = 60_000): Promise<any> => {
  const response = await request(url, init, timeout);
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error('Image provider returned a non-JSON response.'); }
};

const sizeFor = (width: number, height: number): string => {
  if (width > height) return '1536x1024';
  if (height > width) return '1024x1536';
  return '1024x1024';
};

const aspectRatioFor = (width: number, height: number): string => {
  const ratio = width / Math.max(1, height);
  if (ratio >= 1.7) return '16:9';
  if (ratio >= 1.25) return '4:3';
  if (ratio <= 0.6) return '9:16';
  if (ratio <= 0.82) return '3:4';
  return '1:1';
};

const freepikAspectRatioFor = (width: number, height: number): string => {
  switch (aspectRatioFor(width, height)) {
    case '16:9': return 'widescreen_16_9';
    case '4:3': return 'classic_4_3';
    case '9:16': return 'social_story_9_16';
    case '3:4': return 'portrait_3_4';
    default: return 'square_1_1';
  }
};

const modelPath = (model: string) => model.split('/').map(segment => encodeURIComponent(segment)).join('/');

type ImageSource = { base64?: string; url?: string; contentType?: string };

const sourceFromPayload = (payload: any): ImageSource => {
  const item = payload?.data?.[0] || payload?.images?.[0] || payload?.result?.images?.[0] || payload?.result?.urls?.[0] || payload?.result?.[0] || payload?.output?.[0] || payload;
  if (typeof item === 'string') return { url: item };
  const base64 = item?.b64_json || item?.b64Json || item?.base64 || item?.image_base64 || item?.image;
  const url = item?.url || item?.image_url || item?.imageUrl || item?.generated?.[0];
  const contentType = item?.content_type || item?.media_type;
  if (typeof base64 === 'string' && base64.trim()) return { base64: base64.trim(), contentType };
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return { url: url.trim(), contentType };
  throw new Error('Image provider returned no image bytes or downloadable image URL.');
};

const imageBytes = async (source: ImageSource): Promise<Buffer> => {
  if (source.base64) {
    const clean = source.base64.replace(/^data:[^;]+;base64,/i, '');
    return Buffer.from(clean, 'base64');
  }
  if (!source.url) throw new Error('Image provider returned no image source.');
  const response = await request(source.url, { method: 'GET', headers: { Accept: 'image/*' } }, 45_000);
  const contentType = response.headers.get('content-type') || source.contentType || '';
  if (/svg|html/i.test(contentType)) throw new Error('Image provider returned a non-raster asset.');
  return Buffer.from(await response.arrayBuffer());
};

const assertRaster = (bytes: Buffer) => {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('Provider response was not a supported PNG, JPEG, or WebP raster image.');
};

const rasterExtension = (bytes: Buffer): string => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
  return '.webp';
};

const executeOpenAICompatible = async (provider: ImageProvider, model: string, prompt: string, key: string, settings: ImageSettings, width: number, height: number): Promise<Buffer> => {
  const baseURL = providerBaseURL(provider, settings);
  const body: Record<string, unknown> = { model, prompt, size: sizeFor(width, height) };
  if (provider === 'xai') {
    body.aspect_ratio = aspectRatioFor(width, height);
    body.resolution = Math.max(width, height) >= 1536 ? '2k' : '1k';
    body.response_format = 'b64_json';
  }
  const endpoint = provider === 'openrouter' ? `${baseURL}/images` : `${baseURL}/images/generations`;
  const payload = await jsonRequest(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return imageBytes(sourceFromPayload(payload));
};

const executeDeepInfra = async (model: string, prompt: string, key: string, settings: ImageSettings, width: number, height: number): Promise<Buffer> => {
  const payload = await jsonRequest(`${providerBaseURL('deepinfra', settings)}/v1/inference/${modelPath(model)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, width, height }),
  });
  return imageBytes(sourceFromPayload(payload));
};

const executeFal = async (model: string, prompt: string, key: string, settings: ImageSettings, width: number, height: number): Promise<Buffer> => {
  const baseURL = providerBaseURL('fal', settings);
  const submit = await jsonRequest(`${baseURL}/${modelPath(model)}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, image_size: { width, height } }),
  });
  const requestId = String(submit?.request_id || '').trim();
  if (!requestId) throw new Error('FAL did not return a request_id.');
  const statusURL = String(submit?.status_url || `${baseURL}/${modelPath(model)}/requests/${encodeURIComponent(requestId)}/status`);
  const responseURL = String(submit?.response_url || `${baseURL}/${modelPath(model)}/requests/${encodeURIComponent(requestId)}`);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const status = await jsonRequest(statusURL, { headers: { Authorization: `Key ${key}`, Accept: 'application/json' } }, 30_000);
    if (status?.status === 'COMPLETED') {
      const result = await jsonRequest(responseURL, { headers: { Authorization: `Key ${key}`, Accept: 'application/json' } }, 45_000);
      return imageBytes(sourceFromPayload(result));
    }
    if (status?.status === 'FAILED' || status?.status === 'ERROR') throw new Error(status?.error || 'FAL image request failed.');
  }
  throw new Error('FAL image request timed out while waiting in the queue.');
};

const executeKrea = async (model: string, prompt: string, key: string, settings: ImageSettings, width: number, height: number): Promise<Buffer> => {
  const baseURL = providerBaseURL('krea', settings);
  const payload = await jsonRequest(`${baseURL}/generate/image/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, aspect_ratio: aspectRatioFor(width, height), resolution: '1K', creativity: 'medium' }),
  });
  const jobId = String(payload?.job_id || '').trim();
  if (!jobId) return imageBytes(sourceFromPayload(payload));
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const job = await jsonRequest(`${baseURL}/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 30_000);
    if (job?.status === 'completed') return imageBytes(sourceFromPayload(job));
    if (job?.status === 'failed' || job?.status === 'canceled') throw new Error(`Krea job ${job.status}.`);
  }
  throw new Error('Krea image request timed out while waiting for the job.');
};

const executeFreepik = async (model: string, prompt: string, key: string, settings: ImageSettings, width: number, height: number): Promise<Buffer> => {
  const baseURL = providerBaseURL('freepik', settings);
  const endpoint = `${baseURL}/v1/ai/text-to-image/${encodeURIComponent(model)}`;
  const payload = await jsonRequest(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-freepik-api-key': key, Accept: 'application/json' },
    body: JSON.stringify({ prompt, aspect_ratio: freepikAspectRatioFor(width, height) }),
  });
  const taskId = String(payload?.data?.task_id || '').trim();
  if (!taskId) throw new Error('Freepik did not return a task_id.');
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const status = await jsonRequest(`${endpoint}/${encodeURIComponent(taskId)}`, { headers: { 'x-freepik-api-key': key, Accept: 'application/json' } }, 30_000);
    const state = String(status?.data?.status || '').toUpperCase();
    if (state === 'COMPLETED') return imageBytes(sourceFromPayload(status?.data?.generated?.[0] || status));
    if (state === 'FAILED') throw new Error('Freepik image task failed.');
  }
  throw new Error('Freepik image task timed out.');
};

const executeProvider = async (provider: ImageProvider, model: string, prompt: string, key: string, settings: ImageSettings, width: number, height: number): Promise<Buffer> => {
  if (!IMAGE_PROVIDER_META[provider].available) throw new Error(IMAGE_PROVIDER_META[provider].unavailableReason || 'Provider is unavailable.');
  switch (provider) {
    case 'deepinfra': return executeDeepInfra(model, prompt, key, settings, width, height);
    case 'fal': return executeFal(model, prompt, key, settings, width, height);
    case 'krea': return executeKrea(model, prompt, key, settings, width, height);
    case 'openai': return executeOpenAICompatible(provider, model, prompt, key, settings, width, height);
    case 'openrouter': return executeOpenAICompatible(provider, model, prompt, key, settings, width, height);
    case 'xai': return executeOpenAICompatible(provider, model, prompt, key, settings, width, height);
    case 'freepik': return executeFreepik(model, prompt, key, settings, width, height);
  }
};

export async function executeImageGeneration(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const settings = getRuntimeImageSettings();
  if (!settings.enabled) return { success: false, filePath: '', provider: '', model: '', providerActionMode: 'failed', message: 'Image generation is disabled in External service settings.' };
  const width = Math.min(1920, Math.max(512, Math.round(input.width || 1024)));
  const height = Math.min(1920, Math.max(512, Math.round(input.height || 1024)));
  const attempted: string[] = [];
  const failures: string[] = [];
  for (const provider of providerOrder(settings)) {
    const meta = IMAGE_PROVIDER_META[provider];
    const model = input.model && provider === settings.provider ? input.model : (settings.modelByProvider[provider] || meta.defaultModel);
    attempted.push(`${meta.label}/${model}`);
    const keys = meta.requiresKey ? keysForProvider(provider, settings) : [''];
    if (meta.requiresKey && keys.length === 0) {
      failures.push(`${meta.label}: no credential configured`);
      continue;
    }
    const start = keyCursor[provider] || 0;
    const orderedKeys = keys.map((_, offset) => keys[(start + offset) % keys.length]);
    for (let index = 0; index < orderedKeys.length; index += 1) {
      const key = orderedKeys[index];
      try {
        const bytes = await executeProvider(provider, model, input.prompt, key, settings, width, height);
        assertRaster(bytes);
        await fs.mkdir(path.dirname(input.filePath), { recursive: true });
        const outputPath = path.join(path.dirname(input.filePath), `${path.basename(input.filePath, path.extname(input.filePath))}${rasterExtension(bytes)}`);
        await fs.writeFile(outputPath, bytes);
        keyCursor[provider] = (start + index + 1) % Math.max(1, keys.length);
        return {
          success: true,
          filePath: outputPath,
          provider,
          model,
          providerActionMode: 'provider-native',
          message: `Real raster image generated by ${meta.label} using ${model}. Saved at ${outputPath}.`,
        };
      } catch (error: any) {
        failures.push(`${meta.label}/${model}: ${error?.message || String(error)}`);
      }
    }
  }
  return {
    success: false,
    filePath: '',
    provider: '',
    model: '',
    providerActionMode: 'failed',
    message: `No image provider completed a real raster request. Attempted ${attempted.join(', ')}. ${failures.slice(0, 5).join(' | ')}`,
  };
}

export async function testImageProvider(provider: ImageProvider, key = '', model = ''): Promise<{ provider: ImageProvider; model: string; message: string }> {
  const meta = IMAGE_PROVIDER_META[provider];
  const selectedModel = model.trim() || meta.defaultModel;
  if (!meta.available) throw new Error(meta.unavailableReason || 'Provider is unavailable.');
  if (meta.requiresKey && !key.trim()) throw new Error(`${meta.authLabel} is required.`);
  const current = getRuntimeImageSettings();
  const settings = normalizeImageSettings({
    ...current,
    provider,
    modelByProvider: { ...current.modelByProvider, [provider]: selectedModel },
    apiKeys: { ...current.apiKeys, [provider]: key ? [key] : current.apiKeys[provider] },
  });
  const baseURL = providerBaseURL(provider, settings);
  if (provider === 'openai' || provider === 'xai') {
    const payload = await jsonRequest(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' } }, 20_000);
    const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const ids = entries.map((entry: any) => String(entry?.id || entry?.name || '').trim()).filter(Boolean);
    if (ids.length === 0) throw new Error(`${meta.label} returned no model catalog.`);
    if (!ids.includes(selectedModel)) throw new Error(`${meta.label} does not advertise the selected model '${selectedModel}'.`);
  } else if (provider === 'openrouter') {
    const payload = await jsonRequest(`${baseURL}/images/models`, { headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' } }, 20_000);
    const ids = Array.isArray(payload?.data) ? payload.data.map((entry: any) => String(entry?.id || '').trim()).filter(Boolean) : [];
    if (ids.length === 0) throw new Error('OpenRouter returned no image model catalog.');
    if (!ids.includes(selectedModel)) throw new Error(`OpenRouter does not advertise the selected model '${selectedModel}'.`);
  } else {
    const response = await withTimeout(fetch(provider === 'deepinfra'
      ? `${baseURL}/v1/models`
      : provider === 'fal'
        ? `${baseURL}/${modelPath(selectedModel)}`
        : provider === 'krea'
          ? `${baseURL}/jobs/connection-test`
          : `${baseURL}/v1/ai/text-to-image/${encodeURIComponent(selectedModel)}`, {
      headers: {
        ...(provider === 'fal' ? { Authorization: `Key ${key.trim()}` } : provider === 'freepik' ? { 'x-freepik-api-key': key.trim() } : { Authorization: `Bearer ${key.trim()}` }),
        Accept: 'application/json',
      },
    }), 20_000);
    if ([401, 403].includes(response.status)) throw new Error(`${response.status} ${response.statusText}: credentials were rejected.`);
    if (response.status < 200 || response.status >= 300) throw new Error(`${response.status} ${response.statusText}: endpoint/model probe did not verify ${selectedModel}.`);
  }
  return { provider, model: selectedModel, message: `${meta.label} credentials and the selected model '${selectedModel}' were verified without creating an image.` };
}
