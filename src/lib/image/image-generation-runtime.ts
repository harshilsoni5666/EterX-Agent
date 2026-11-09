import fs from 'node:fs/promises';
import path from 'node:path';
import { withApiKeyRounds } from '../agent/api-retry';
import {
  externalServiceJson, externalServiceKeys, externalServiceSignal,
  throwIfExternalServiceCancelled, waitForExternalService, withExternalServiceContext,
  externalServiceJob, rememberExternalServiceJob, externalServiceJobFailed, externalServiceJobAccessError,
  downloadExternalServiceAsset, readFalModelCatalog,
  type ExternalServiceContext, type ExternalServiceJob,
} from '../external-service-runtime';
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
  provider?: ImageProvider;
  jobId?: string;
};

export type ImageGenerationResult = {
  success: boolean;
  filePath: string;
  provider: ImageProvider | '';
  model: string;
  providerActionMode: 'provider-native' | 'unavailable' | 'failed' | 'pending' | '';
  message: string;
  attemptedProviders?: ImageProvider[];
  failedProviders?: Array<{ provider: ImageProvider; model: string; error: string }>;
  job?: ExternalServiceJob;
  downloadURL?: string;
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
  fallbackProviders: process.env.ETERX_IMAGE_FALLBACK_PROVIDERS === undefined ? undefined
    : process.env.ETERX_IMAGE_FALLBACK_PROVIDERS.split(',').map(value => value.trim()).filter(Boolean),
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

const keysForProvider = (provider: ImageProvider, settings: ImageSettings, context?: ExternalServiceContext): string[] => externalServiceKeys(
  settings.apiKeys[provider], envValues(environmentKeys[provider]),
  provider === 'xai' ? 'grok' : provider === 'openai' || provider === 'openrouter' || provider === 'deepinfra' ? provider : undefined,
  context?.runtimeSettings,
);

const providerBaseURL = (provider: ImageProvider, settings: ImageSettings, override = '') =>
  (override || settings.baseURLs[provider] || envBaseURL(provider) || IMAGE_PROVIDER_META[provider].defaultBaseURL).replace(/\/+$/, '');

export function getImageGenerationRouteBrief(context?: any): string {
  const settings = getRuntimeImageSettings();
  if (!settings.enabled) return '[Image generation route]\nDisabled in External service settings. Do not call image_generator.';
  const provider = settings.provider;
  const meta = IMAGE_PROVIDER_META[provider];
  const model = settings.modelByProvider[provider] || meta.defaultModel;
  const activeCredentialReady = !meta.requiresKey || keysForProvider(provider, settings, context).length > 0;
  const fallbackCredentialState = settings.fallbackProviders.map(item => {
    const fallbackMeta = IMAGE_PROVIDER_META[item];
    return `${fallbackMeta.label} (${item}): ${!fallbackMeta.requiresKey || keysForProvider(item, settings, context).length > 0 ? 'configured' : 'missing credentials'}`;
  }).join(', ') || 'none';
  const fallbackText = settings.fallbackProviders
    .map(item => `${IMAGE_PROVIDER_META[item].label}/${settings.modelByProvider[item] || IMAGE_PROVIDER_META[item].defaultModel}`)
    .join(' -> ') || 'None';
  const status = meta.available ? 'available' : `unavailable: ${meta.unavailableReason || 'connection not installed'}`;
  return [
    '[Image generation route]',
    `Active provider: ${meta.label} (${provider}). Model: ${model}. Adapter: ${status}. Credential: ${activeCredentialReady ? 'configured' : 'missing'}.`,
    `Capabilities: text-to-image${meta.supportsEditing ? ', image editing' : ''}${meta.supportsAspectRatio ? ', aspect-ratio control' : ''}.`,
    `Fallback order: ${fallbackText}.`,
    `Fallback credentials: ${fallbackCredentialState}.`,
    'The image_generator tool reads this route again for every call. It uses the selected provider/model, rotates configured keys, switches through enabled fallbacks after a real request failure, and saves only returned raster bytes.',
    'Optional provider chooses an enabled route for this call. A pending result includes a job: resume with that provider, model, and jobId. Configured credentials are not proof of live model access.',
  ].join('\n');
}

const jsonRequest = (url: string, init: RequestInit, timeout = 60_000) => externalServiceJson(url, init, timeout);

const freepikAuthHeaders = (baseURL: string, key: string): Record<string, string> => ({
  [new URL(baseURL).hostname === 'api.magnific.com' ? 'x-magnific-api-key' : 'x-freepik-api-key']: key,
});

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
  const find = (item: any, depth = 0): ImageSource | undefined => {
    if (!item || depth > 8) return undefined;
    if (typeof item === 'string') {
      if (/^data:image\/[^;]+;base64,/i.test(item)) return { base64: item };
      if (item.length > 64 && /^(?:iVBORw0KGgo|\/9j\/|UklGR)/.test(item)) return { base64: item };
      if (/^https?:\/\//i.test(item)) return { url: item };
      return undefined;
    }
    if (Array.isArray(item)) {
      for (const entry of item) { const source = find(entry, depth + 1); if (source) return source; }
      return undefined;
    }
    const base64 = item.b64_json || item.b64Json || item.base64 || item.image_base64;
    if (typeof base64 === 'string' && base64.trim()) return { base64: base64.trim() };
    for (const field of ['data', 'images', 'image', 'result', 'urls', 'output', 'generated', 'choices', 'message', 'url', 'image_url', 'imageUrl']) {
      const source = find(item[field], depth + 1);
      if (source) return source;
    }
    return undefined;
  };
  const source = find(payload);
  if (source) return source;
  throw new Error('Image provider returned no image bytes or downloadable image URL.');
};

const imageBytes = async (source: ImageSource): Promise<Buffer> => {
  if (source.base64) {
    const clean = source.base64.replace(/^data:[^;]+;base64,/i, '');
    return Buffer.from(clean, 'base64');
  }
  if (!source.url) throw new Error('Image provider returned no image source.');
  const response = await downloadExternalServiceAsset(source.url, { method: 'GET', headers: { Accept: 'image/*' } }, 45_000);
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
  const body: Record<string, unknown> = { model, prompt };
  if (provider !== 'xai') body.size = sizeFor(width, height);
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
  const submit = externalServiceJob()?.id ? { request_id: externalServiceJob()!.id } : await jsonRequest(`${baseURL}/${modelPath(model)}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, image_size: { width, height } }),
  });
  const requestId = String(submit?.request_id || '').trim();
  if (!requestId) throw new Error('FAL did not return a request_id.');
  rememberExternalServiceJob('fal', model, requestId);
  const queuePath = modelPath(model.split('/').slice(0, 2).join('/'));
  const statusURL = String(submit?.status_url || `${baseURL}/${queuePath}/requests/${encodeURIComponent(requestId)}/status`);
  const responseURL = String(submit?.response_url || `${baseURL}/${queuePath}/requests/${encodeURIComponent(requestId)}`);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await waitForExternalService(1000);
    const status = await jsonRequest(statusURL, { headers: { Authorization: `Key ${key}`, Accept: 'application/json' } }, 30_000);
    if (status?.status === 'COMPLETED') {
      try {
        const result = await jsonRequest(responseURL, { headers: { Authorization: `Key ${key}`, Accept: 'application/json' } }, 45_000);
        return imageBytes(sourceFromPayload(result));
      } catch (error: any) {
        if (error?.status === 422 && !error?.assetURL) throw externalServiceJobFailed(error.message);
        throw error;
      }
    }
    if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status?.status)) throw externalServiceJobFailed(status?.error || 'FAL image request failed.');
  }
  throw new Error('FAL image request timed out while waiting in the queue.');
};

const executeKrea = async (model: string, prompt: string, key: string, settings: ImageSettings, width: number, height: number): Promise<Buffer> => {
  const baseURL = providerBaseURL('krea', settings);
  const aspect = aspectRatioFor(width, height);
  const payload = externalServiceJob()?.id ? { job_id: externalServiceJob()!.id } : await jsonRequest(`${baseURL}/generate/image/${modelPath(model)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, aspect_ratio: aspect === '3:4' ? '4:5' : aspect, resolution: '1K', creativity: 'medium' }),
  });
  const jobId = String(payload?.job_id || '').trim();
  if (!jobId) return imageBytes(sourceFromPayload(payload));
  rememberExternalServiceJob('krea', model, jobId);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await waitForExternalService(2000);
    const job = await jsonRequest(`${baseURL}/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 30_000);
    if (job?.status === 'completed') return imageBytes(sourceFromPayload(job));
    if (['failed', 'canceled', 'cancelled'].includes(job?.status)) throw externalServiceJobFailed(`Krea job ${job.status}: ${job?.result?.error || 'No result returned.'}`);
  }
  throw new Error('Krea image request timed out while waiting for the job.');
};

const executeFreepik = async (model: string, prompt: string, key: string, settings: ImageSettings, width: number, height: number): Promise<Buffer> => {
  const baseURL = providerBaseURL('freepik', settings);
  const endpoint = `${baseURL}/v1/ai/text-to-image/${encodeURIComponent(model)}`;
  const payload = externalServiceJob()?.id ? { data: { task_id: externalServiceJob()!.id } } : await jsonRequest(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...freepikAuthHeaders(baseURL, key), Accept: 'application/json' },
    body: JSON.stringify({ prompt, aspect_ratio: freepikAspectRatioFor(width, height) }),
  });
  const taskId = String(payload?.data?.task_id || '').trim();
  if (!taskId) throw new Error('Freepik did not return a task_id.');
  rememberExternalServiceJob('freepik', model, taskId);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await waitForExternalService(2000);
    const status = await jsonRequest(`${endpoint}/${encodeURIComponent(taskId)}`, { headers: { ...freepikAuthHeaders(baseURL, key), Accept: 'application/json' } }, 30_000);
    const state = String(status?.data?.status || '').toUpperCase();
    if (state === 'COMPLETED') return imageBytes(sourceFromPayload(status?.data?.generated?.[0] || status));
    if (['FAILED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(state)) throw externalServiceJobFailed('Freepik image task failed.');
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

export async function executeImageGeneration(input: ImageGenerationInput, context?: ExternalServiceContext): Promise<ImageGenerationResult> {
  const settings = getRuntimeImageSettings();
  const preferred = input.provider || settings.provider;
  if (input.jobId && (!input.provider || !input.model?.trim())) throw new Error('Resuming an image requires the provider and model returned with the job ID.');
  if (!providerOrder(settings).includes(preferred)) throw new Error('The requested image provider is not enabled in the primary or fallback order.');
  if (input.jobId && !['fal', 'krea', 'freepik'].includes(preferred)) throw new Error('This image provider does not expose resumable generation jobs.');
  const model = input.model?.trim() || settings.modelByProvider[preferred] || IMAGE_PROVIDER_META[preferred].defaultModel;
  return withExternalServiceContext({ ...context, serviceSettings: settings, job: input.jobId ? { id: input.jobId, provider: preferred, model } : undefined }, () => executeImageRoute(input, settings, context));
}

async function executeImageRoute(input: ImageGenerationInput, settings: ImageSettings, context?: ExternalServiceContext): Promise<ImageGenerationResult> {
  throwIfExternalServiceCancelled();
  if (!settings.enabled) return { success: false, filePath: '', provider: '', model: '', providerActionMode: 'failed', message: 'Image generation is disabled in External service settings.' };
  if (!input.prompt?.trim()) throw new Error('Image generation requires a non-empty prompt.');
  const width = Math.min(1920, Math.max(512, Math.round(input.width || 1024)));
  const height = Math.min(1920, Math.max(512, Math.round(input.height || 1024)));
  const attemptedProviders: ImageProvider[] = [];
  const failedProviders: NonNullable<ImageGenerationResult['failedProviders']> = [];
  const preferred = input.provider || settings.provider;
  const order = input.jobId ? [preferred] : [preferred, ...providerOrder(settings).filter(provider => provider !== preferred)];
  for (const provider of order) {
    throwIfExternalServiceCancelled();
    const meta = IMAGE_PROVIDER_META[provider];
    const model = input.model?.trim() && provider === preferred ? input.model.trim() : (settings.modelByProvider[provider] || meta.defaultModel);
    if (!meta.available) { failedProviders.push({ provider, model, error: 'Provider is unavailable.' }); continue; }
    const keys = meta.requiresKey ? keysForProvider(provider, settings) : ['__no_key__'];
    if (meta.requiresKey && keys.length === 0) {
      failedProviders.push({ provider, model, error: 'No credential configured.' });
      continue;
    }
    attemptedProviders.push(provider);
    const start = keyCursor[provider] || 0;
    const orderedKeys = keys.map((_, offset) => keys[(start + offset) % keys.length]);
    let bytes: Buffer;
    try {
      bytes = await withApiKeyRounds(orderedKeys, context?.runtimeSettings, async (key, attempt) => {
        let bytes: Buffer;
        try { bytes = await executeProvider(provider, model, input.prompt, key === '__no_key__' ? '' : key, settings, width, height); }
        catch (error) { throw externalServiceJobAccessError(error); }
        assertRaster(bytes);
        keyCursor[provider] = (start + attempt + 1) % keys.length;
        return bytes;
      }, externalServiceSignal(), (_attempt, _total, error) => {
        failedProviders.push({ provider, model, error: error instanceof Error ? error.message : String(error) });
      });
    } catch (error: any) {
      throwIfExternalServiceCancelled();
      failedProviders.push({ provider, model, error: error?.message || String(error) });
      const job = externalServiceJob();
      if (job) {
        return { success: false, filePath: '', provider, model, providerActionMode: 'pending', attemptedProviders, failedProviders, job,
          message: `Image job ${job.id} needs follow-up: ${error?.message || error}. Resume with provider="${provider}", model="${job.model}", and jobId="${job.id}"; do not submit a replacement generation.` };
      }
      if (error?.assetURL) return { success: false, filePath: '', provider, model, providerActionMode: 'failed', attemptedProviders, failedProviders, downloadURL: error.assetURL,
        message: `${error.message}. The provider returned an image URL; retry its download instead of generating another image.` };
      continue;
    }
    const outputPath = path.join(path.dirname(input.filePath), `${path.basename(input.filePath, path.extname(input.filePath))}${rasterExtension(bytes)}`);
    try {
      throwIfExternalServiceCancelled();
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, bytes);
    } catch (error: any) {
      throwIfExternalServiceCancelled();
      return { success: false, filePath: '', provider, model, providerActionMode: 'failed', attemptedProviders, failedProviders, job: externalServiceJob(),
        message: `Image generation succeeded, but saving ${outputPath} failed: ${error?.message || error}. No additional generation was submitted.` };
    }
    return { success: true, filePath: outputPath, provider, model, providerActionMode: 'provider-native', attemptedProviders, failedProviders,
      message: `Real raster image generated by ${meta.label} using ${model}. Saved at ${outputPath}.` };
  }
  const job = externalServiceJob();
  return {
    success: false,
    filePath: '',
    provider: job ? job.provider as ImageProvider : '',
    model: job?.model || '',
    providerActionMode: job ? 'pending' : 'failed',
    attemptedProviders, failedProviders, job,
    message: `${job ? `Existing image job ${job.id} could not be resumed; keep its provider, model, and jobId for a later retry.` : 'No image provider completed a real raster request.'} ${failedProviders.map(item => `${item.provider}/${item.model}: ${item.error}`).join(' | ')}`,
  };
}

export async function testImageProvider(provider: ImageProvider, key = '', model = '', endpoint = ''): Promise<{ provider: ImageProvider; model: string; message: string }> {
  const meta = IMAGE_PROVIDER_META[provider];
  const selectedModel = model.trim() || meta.defaultModel;
  if (!meta.available) throw new Error(meta.unavailableReason || 'Provider is unavailable.');
  const current = getRuntimeImageSettings();
  key = key.trim() || keysForProvider(provider, current)[0] || '';
  if (meta.requiresKey && !key) throw new Error(`${meta.authLabel} is required.`);
  const settings = normalizeImageSettings({
    ...current,
    provider,
    modelByProvider: { ...current.modelByProvider, [provider]: selectedModel },
    apiKeys: { ...current.apiKeys, [provider]: key ? [key] : current.apiKeys[provider] },
  });
  const baseURL = providerBaseURL(provider, settings, endpoint.trim());
  if (provider === 'fal') {
    await readFalModelCatalog(baseURL, key, selectedModel);
    return { provider, model: selectedModel, message: `FAL advertised '${selectedModel}' in its public catalog. Credentials and image generation access remain unverified.` };
  }
  if (provider === 'deepinfra') {
    const payload = await jsonRequest(`${baseURL}/models/list`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 20_000);
    const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    if (!entries.some((entry: any) => (entry?.model_name || entry?.id) === selectedModel)) throw new Error(`DeepInfra did not advertise '${selectedModel}' in its model catalog; generation access remains unverified.`);
    return { provider, model: selectedModel, message: `DeepInfra advertised '${selectedModel}' in its public catalog. Credentials and image generation access remain unverified.` };
  }
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
    await jsonRequest(provider === 'krea'
      ? `${baseURL}/jobs?limit=1`
      : `${baseURL}/v1/ai/text-to-image/${encodeURIComponent(selectedModel)}`, {
      headers: {
        ...(provider === 'freepik' ? freepikAuthHeaders(baseURL, key.trim()) : { Authorization: `Bearer ${key.trim()}` }),
        Accept: 'application/json',
      },
    }, 20_000);
  }
  return { provider, model: selectedModel, message: ['openai', 'openrouter', 'xai'].includes(provider)
    ? `${meta.label} advertised '${selectedModel}' in its catalog. This does not establish image generation access.`
    : `${meta.label} responded to a read-only endpoint request. Model access and image generation have not been verified.` };
}
