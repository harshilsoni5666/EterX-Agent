import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { withApiKeyRounds } from '../agent/api-retry';
import {
  externalServiceRequest, externalServiceJson, externalServiceKeys, externalServiceSignal, externalServiceSettings,
  throwIfExternalServiceCancelled, waitForExternalService, withExternalServiceContext,
  externalServiceJob, rememberExternalServiceJob, externalServiceJobFailed, externalServiceJobAccessError,
  downloadExternalServiceAsset, readFalModelCatalog,
  type ExternalServiceContext, type ExternalServiceJob,
} from '../external-service-runtime';
import {
  VIDEO_PROVIDER_IDS,
  VIDEO_PROVIDER_META,
  normalizeVideoSettings,
  type VideoProvider,
  type VideoSettings,
} from './video-generation-config';

export type VideoGenerationInput = {
  prompt: string;
  filePath: string;
  width?: number;
  height?: number;
  duration?: number;
  imageUrl?: string;
  model?: string;
  provider?: VideoProvider;
  jobId?: string;
};

export type VideoGenerationResult = {
  success: boolean;
  filePath: string;
  provider: string;
  model: string;
  providerActionMode: 'provider-native' | 'failed' | 'pending';
  message: string;
  attemptedProviders?: VideoProvider[];
  failedProviders?: Array<{ provider: VideoProvider; model: string; error: string }>;
  job?: ExternalServiceJob;
  downloadURL?: string;
};

type VideoSource = { url?: string; base64?: string; contentType?: string; headers?: Record<string, string> };

const runtimeGlobal = globalThis as typeof globalThis & {
  __eterxVideoSettings?: VideoSettings;
  __eterxVideoKeyCursor?: Partial<Record<VideoProvider, number>>;
};

const keyCursor = runtimeGlobal.__eterxVideoKeyCursor || (runtimeGlobal.__eterxVideoKeyCursor = {});

const environmentKeys: Record<VideoProvider, string[]> = {
  google: ['ETERX_VIDEO_GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['ETERX_VIDEO_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  runway: ['ETERX_VIDEO_RUNWAY_API_KEY', 'RUNWAYML_API_SECRET', 'RUNWAY_API_KEY'],
  luma: ['ETERX_VIDEO_LUMA_API_KEY', 'LUMA_API_KEY', 'LUMA_API_TOKEN'],
  minimax: ['ETERX_VIDEO_MINIMAX_API_KEY', 'MINIMAX_API_KEY'],
  volcengine: ['ETERX_VIDEO_VOLCENGINE_API_KEY', 'VOLCENGINE_API_KEY', 'ARK_API_KEY'],
  fal: ['ETERX_VIDEO_FAL_API_KEY', 'FAL_KEY', 'FAL_API_KEY'],
  replicate: ['ETERX_VIDEO_REPLICATE_API_KEY', 'REPLICATE_API_TOKEN', 'REPLICATE_API_KEY'],
  xai: ['ETERX_VIDEO_XAI_API_KEY', 'XAI_API_KEY'],
};

const environmentBaseURLs: Record<VideoProvider, string[]> = {
  google: ['ETERX_VIDEO_GOOGLE_BASE_URL'],
  openai: ['ETERX_VIDEO_OPENAI_BASE_URL'],
  runway: ['ETERX_VIDEO_RUNWAY_BASE_URL'],
  luma: ['ETERX_VIDEO_LUMA_BASE_URL'],
  minimax: ['ETERX_VIDEO_MINIMAX_BASE_URL'],
  volcengine: ['ETERX_VIDEO_VOLCENGINE_BASE_URL'],
  fal: ['ETERX_VIDEO_FAL_BASE_URL'],
  replicate: ['ETERX_VIDEO_REPLICATE_BASE_URL'],
  xai: ['ETERX_VIDEO_XAI_BASE_URL'],
};

const envValues = (names: string[]): string[] => Array.from(new Set(names.flatMap(name => [
  String(process.env[name] || '').trim(),
  ...Array.from({ length: 3 }, (_, index) => String(process.env[`${name}_${index + 1}`] || '').trim()),
].filter(Boolean))));

const envBaseURL = (provider: VideoProvider): string => environmentBaseURLs[provider]
  .map(name => String(process.env[name] || '').trim().replace(/\/+$/, ''))
  .find(Boolean) || '';

const readEnvironmentSettings = (): VideoSettings => normalizeVideoSettings({
  enabled: process.env.ETERX_VIDEO_ENABLED !== '0',
  provider: process.env.ETERX_VIDEO_PROVIDER,
  fallbackProviders: process.env.ETERX_VIDEO_FALLBACK_PROVIDERS === undefined ? undefined
    : process.env.ETERX_VIDEO_FALLBACK_PROVIDERS.split(',').map(value => value.trim()).filter(Boolean),
  modelByProvider: Object.fromEntries(VIDEO_PROVIDER_IDS.map(provider => [
    provider,
    String(process.env[`ETERX_VIDEO_MODEL_${provider.toUpperCase()}`] || '').trim(),
  ])),
  apiKeys: Object.fromEntries(VIDEO_PROVIDER_IDS.map(provider => [provider, envValues(environmentKeys[provider])])),
  baseURLs: Object.fromEntries(VIDEO_PROVIDER_IDS.map(provider => [provider, envBaseURL(provider)])),
});

const initialSettings = runtimeGlobal.__eterxVideoSettings || (runtimeGlobal.__eterxVideoSettings = readEnvironmentSettings());

export function getRuntimeVideoSettings(): VideoSettings {
  return normalizeVideoSettings(runtimeGlobal.__eterxVideoSettings || initialSettings);
}

export function applyRuntimeVideoSettings(raw: unknown): VideoSettings {
  const next = normalizeVideoSettings(raw);
  initialSettings.enabled = next.enabled;
  initialSettings.provider = next.provider;
  initialSettings.fallbackProviders = next.fallbackProviders;
  initialSettings.modelByProvider = next.modelByProvider;
  initialSettings.apiKeys = next.apiKeys;
  initialSettings.baseURLs = next.baseURLs;
  runtimeGlobal.__eterxVideoSettings = initialSettings;
  return getRuntimeVideoSettings();
}

const providerOrder = (settings: VideoSettings): VideoProvider[] => Array.from(new Set([
  settings.provider,
  ...settings.fallbackProviders,
]));

const keysForProvider = (provider: VideoProvider, settings: VideoSettings, context?: ExternalServiceContext): string[] => externalServiceKeys(
  settings.apiKeys[provider], envValues(environmentKeys[provider]),
  provider === 'google' ? 'gemini' : provider === 'xai' ? 'grok' : provider === 'openai' || provider === 'minimax' ? provider : undefined,
  context?.runtimeSettings,
);

const providerBaseURL = (provider: VideoProvider, settings = externalServiceSettings<VideoSettings>() || getRuntimeVideoSettings()): string => (
  settings.baseURLs[provider] || envBaseURL(provider) || VIDEO_PROVIDER_META[provider].defaultBaseURL
).replace(/\/+$/, '');

export function getVideoGenerationRouteBrief(context?: any): string {
  const settings = getRuntimeVideoSettings();
  if (!settings.enabled) return '[Video generation route]\nDisabled in External service settings. Do not call video_generator.';
  const meta = VIDEO_PROVIDER_META[settings.provider];
  const model = settings.modelByProvider[settings.provider] || meta.defaultModel;
  const fallbackText = settings.fallbackProviders
    .map(provider => `${VIDEO_PROVIDER_META[provider].label}/${settings.modelByProvider[provider] || VIDEO_PROVIDER_META[provider].defaultModel}`)
    .join(' -> ') || 'None';
  const fallbackCredentials = settings.fallbackProviders
    .map(provider => `${VIDEO_PROVIDER_META[provider].label} (${provider}): ${keysForProvider(provider, settings, context).length ? 'configured' : 'missing credentials'}`)
    .join(', ') || 'none';
  return [
    '[Video generation route]',
    `Active provider: ${meta.label} (${settings.provider}). Model: ${model}. Adapter: ${meta.available ? 'available' : 'unavailable'}. Credential: ${keysForProvider(settings.provider, settings, context).length ? 'configured' : 'missing'}.`,
    `Capabilities: ${meta.supportsTextToVideo ? 'text-to-video' : ''}${meta.supportsImageInput ? ', image-to-video' : ''}${meta.supportsAudioOutput ? ', synced audio where supported' : ''}.`,
    `Fallback order: ${fallbackText}.`,
    `Fallback credentials: ${fallbackCredentials}.`,
    'The video_generator tool reads this route for every call, rotates up to three keys per provider, fails over after a real provider error, and writes only validated video bytes. FAL and Replicate accept exact model IDs so current open-source catalogs can be used without an app release.',
    'Optional provider chooses an enabled route for this call. A pending result includes a job: resume with that provider, model, and jobId. Configured credentials are not proof of live model access.',
  ].join('\n');
}

const sleep = waitForExternalService;
const request = (url: string, init: RequestInit = {}, timeout = 90_000) => externalServiceRequest(url, init, timeout);
const jsonRequest = (url: string, init: RequestInit = {}, timeout = 90_000) => externalServiceJson(url, init, timeout);

const aspectRatioFor = (width: number, height: number): string => {
  const ratio = width / Math.max(1, height);
  if (ratio >= 1.55) return '16:9';
  if (ratio <= 0.72) return '9:16';
  return '1:1';
};

const runwayRatioFor = (width: number, height: number): string => aspectRatioFor(width, height) === '9:16' ? '720:1280' : '1280:720';

const openAiSizeFor = (width: number, height: number): string => aspectRatioFor(width, height) === '9:16' ? '720x1280' : '1280x720';

const clampDuration = (value: number | undefined): number => Math.min(12, Math.max(4, Math.round(value || 5)));

const modelPath = (model: string) => model.split('/').map(segment => encodeURIComponent(segment)).join('/');

const sourceFromPayload = (payload: any): VideoSource => {
  const find = (item: any, depth = 0): VideoSource | undefined => {
    if (!item || depth > 8) return undefined;
    if (typeof item === 'string') {
      if (/^data:video\/[^;]+;base64,/i.test(item)) return { base64: item };
      if (/^https?:\/\//i.test(item)) return { url: item };
      return undefined;
    }
    if (Array.isArray(item)) {
      for (const entry of item) { const source = find(entry, depth + 1); if (source) return source; }
      return undefined;
    }
    const base64 = item.videoBytes || item.b64_json || item.base64 || item.video_base64 || item.bytesBase64Encoded;
    if (typeof base64 === 'string' && base64.trim()) return { base64: base64.trim(), contentType: item.mimeType || item.content_type };
    for (const field of ['video', 'video_url', 'videoUrl', 'generatedVideos', 'assets', 'asset', 'content', 'output', 'result', 'data', 'task', 'response', 'url', 'uri', 'download_url', 'downloadUrl']) {
      const source = find(item[field], depth + 1);
      if (source) return source;
    }
    return undefined;
  };
  const source = find(payload);
  if (source) return source;
  throw new Error('Video provider returned no downloadable video asset.');
};

const videoBytes = async (source: VideoSource): Promise<Buffer> => {
  if (source.base64) {
    const clean = source.base64.replace(/^data:[^;]+;base64,/i, '');
    return Buffer.from(clean, 'base64');
  }
  if (!source.url) throw new Error('Video provider returned no video source.');
  const response = await downloadExternalServiceAsset(source.url, { method: 'GET', headers: { Accept: 'video/*,application/octet-stream', ...(source.headers || {}) } }, 180_000);
  return Buffer.from(await response.arrayBuffer());
};

export const assertVideo = (bytes: Buffer): void => {
  const isMp4 = bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  const isWebm = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const isOgg = bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS';
  if (!isMp4 && !isWebm && !isOgg) throw new Error('Provider response was not a supported MP4, WebM, or Ogg video.');
};

const videoExtension = (bytes: Buffer): string => bytes.subarray(4, 8).toString('ascii') === 'ftyp' ? '.mp4'
  : bytes.subarray(0, 4).toString('ascii') === 'OggS' ? '.ogv' : '.webm';

const executeGoogle = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const ai = new GoogleGenAI({ apiKey: key, httpOptions: { baseUrl: providerBaseURL('google').replace(/\/v1beta\/?$/, ''), timeout: 90_000 } });
  const config: Record<string, unknown> = { aspectRatio: width >= height ? '16:9' : '9:16', durationSeconds: duration <= 4 ? 4 : duration <= 6 ? 6 : 8, abortSignal: externalServiceSignal() };
  const requestBody: Record<string, unknown> = { model, prompt, config };
  if (imageUrl && !externalServiceJob()?.id) {
    let imageBytes = '';
    let mimeType = 'image/png';
    if (imageUrl.startsWith('data:')) {
      const match = imageUrl.match(/^data:([^;]+);base64,(.*)$/s);
      if (!match) throw new Error('Google Veo image input must be a base64 data URL or an HTTP(S) image URL.');
      mimeType = match[1] || mimeType;
      imageBytes = match[2];
    } else if (/^https?:\/\//i.test(imageUrl)) {
      const reference = await request(imageUrl, { headers: { Accept: 'image/*' } }, 45_000);
      mimeType = reference.headers.get('content-type')?.split(';')[0] || mimeType;
      imageBytes = Buffer.from(await reference.arrayBuffer()).toString('base64');
    } else if (/^gs:\/\//i.test(imageUrl)) {
      requestBody.image = { gcsUri: imageUrl, mimeType };
    } else {
      throw new Error('Google Veo image input must be a base64 data URL, HTTP(S) URL, or gs:// URI.');
    }
    if (imageBytes) requestBody.image = { imageBytes, mimeType };
  }
  let operation: any = externalServiceJob()?.id ? { name: externalServiceJob()!.id } : await (ai.models as any).generateVideos(requestBody);
  if (operation?.name) rememberExternalServiceJob('google', model, operation.name);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    if (operation?.error) throw externalServiceJobFailed(operation.error.message || 'Google video operation failed.');
    if (operation?.done || operation?.response?.generatedVideos?.length) {
      const source = sourceFromPayload(operation);
      if (source.url && new URL(source.url).origin === new URL(providerBaseURL('google')).origin) source.headers = { 'x-goog-api-key': key };
      return videoBytes(source);
    }
    await sleep(1000);
    operation = await (ai.operations as any).getVideosOperation({ operation, config: { abortSignal: externalServiceSignal() } });
  }
  throw new Error('Google video operation timed out while waiting for Veo output.');
};

const executeOpenAI = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('seconds', String([4, 8, 12].includes(duration) ? duration : duration <= 6 ? 4 : duration <= 10 ? 8 : 12));
  form.append('size', openAiSizeFor(width, height));
  if (imageUrl && !externalServiceJob()?.id) {
    const reference = await request(imageUrl, { headers: { Accept: 'image/*' } }, 45_000);
    const contentType = reference.headers.get('content-type') || 'image/png';
    form.append('input_reference', new Blob([await reference.arrayBuffer()], { type: contentType }), 'reference.png');
  }
  const created = externalServiceJob()?.id ? { id: externalServiceJob()!.id } : await jsonRequest(`${providerBaseURL('openai')}/videos`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, body: form }, 90_000);
  const id = String(created?.id || '').trim();
  if (!id) throw new Error('OpenAI did not return a video job id.');
  rememberExternalServiceJob('openai', model, id);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const status = attempt === 0 && created?.status ? created : await jsonRequest(`${providerBaseURL('openai')}/videos/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 45_000);
    const state = String(status?.status || '').toLowerCase();
    if (state === 'completed' || state === 'succeeded') {
      const response = await request(`${providerBaseURL('openai')}/videos/${encodeURIComponent(id)}/content`, { headers: { Authorization: `Bearer ${key}`, Accept: 'video/mp4' } }, 180_000);
      return Buffer.from(await response.arrayBuffer());
    }
    if (['failed', 'canceled', 'cancelled', 'expired'].includes(state)) throw externalServiceJobFailed(status?.error?.message || status?.error || `OpenAI video job ${state}.`);
    await sleep(1000);
  }
  throw new Error('OpenAI video job timed out while waiting for Sora output.');
};

const executeRunway = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const ratio = runwayRatioFor(width, height);
  const endpoint = imageUrl || /^gen4\.5$/i.test(model) ? `${providerBaseURL('runway')}/image_to_video` : `${providerBaseURL('runway')}/text_to_video`;
  const body: Record<string, unknown> = { model, promptText: prompt, ratio, duration: /^gen4\.5$/i.test(model) ? Math.min(10, duration) : duration <= 6 ? 5 : 10 };
  if (imageUrl) body.promptImage = imageUrl;
  const created = externalServiceJob()?.id ? { id: externalServiceJob()!.id } : await jsonRequest(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const taskId = String(created?.id || created?.taskId || '').trim();
  if (!taskId) throw new Error('Runway did not return a task id.');
  rememberExternalServiceJob('runway', model, taskId);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const task = await jsonRequest(`${providerBaseURL('runway')}/tasks/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06', Accept: 'application/json' } }, 45_000);
    const state = String(task?.status || '').toUpperCase();
    if (state === 'SUCCEEDED' || state === 'COMPLETED') return videoBytes(sourceFromPayload(task));
    if (['FAILED', 'CANCELED', 'CANCELLED'].includes(state)) throw externalServiceJobFailed(task?.failure || task?.failureCode || `Runway task ${state}.`);
    await sleep(1000);
  }
  throw new Error('Runway task timed out while waiting for video output.');
};

const executeLuma = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const body: Record<string, unknown> = { prompt, model, aspect_ratio: aspectRatioFor(width, height), resolution: '720p', duration: duration <= 5 ? '5s' : '9s' };
  if (imageUrl) body.keyframes = { frame0: { type: 'image', url: imageUrl } };
  const baseURL = providerBaseURL('luma');
  const created = externalServiceJob()?.id ? { id: externalServiceJob()!.id } : await jsonRequest(`${baseURL}/generations/video`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const id = String(created?.id || '').trim();
  if (!id) throw new Error('Luma did not return a generation id.');
  rememberExternalServiceJob('luma', model, id);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const status = await jsonRequest(`${baseURL}/generations/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 45_000);
    const state = String(status?.state || status?.status || '').toLowerCase();
    if (['completed', 'succeeded'].includes(state)) return videoBytes(sourceFromPayload(status));
    if (['failed', 'error', 'canceled', 'cancelled'].includes(state)) throw externalServiceJobFailed(status?.failure_reason || status?.error || `Luma generation ${state}.`);
    await sleep(1000);
  }
  throw new Error('Luma generation timed out while waiting for video output.');
};

const executeMiniMax = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const baseURL = providerBaseURL('minimax');
  const useH3 = model.toLowerCase().includes('h3');
  const useH3Max = /^minimax-h3-max$/i.test(model);
  const body: Record<string, unknown> = useH3
    ? { model, duration: Math.min(15, Math.max(useH3Max ? 5 : 4, duration)), resolution: useH3Max ? '768P' : '2K', ratio: imageUrl ? 'adaptive' : aspectRatioFor(width, height), content: [{ type: 'text', text: prompt }] }
    : { model, prompt, duration: 6, resolution: '1080P' };
  if (imageUrl) {
    if (useH3) (body.content as Array<Record<string, unknown>>).push({ type: 'image_url', image_url: { url: imageUrl }, role: 'first_frame' });
    else body.first_frame_image = imageUrl;
  }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const created = externalServiceJob()?.id ? { task_id: externalServiceJob()!.id } : await jsonRequest(`${baseURL}/${useH3 ? 'v2' : 'v1'}/video_generation`, { method: 'POST', headers, body: JSON.stringify(body) });
  const taskId = String(created?.task_id || '').trim();
  if (!taskId) throw new Error('MiniMax did not return a task id.');
  rememberExternalServiceJob('minimax', model, taskId);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const queryURL = new URL(`${baseURL}/v1/query/video_generation`);
    queryURL.searchParams.set('task_id', taskId);
    const task = useH3
      ? await jsonRequest(`${baseURL}/v2/query/video_generation/${encodeURIComponent(taskId)}`, { headers }, 45_000)
      : await jsonRequest(queryURL.toString(), { headers }, 45_000);
    const record = task?.task || task;
    const state = String(record?.status || '').toLowerCase();
    if (['success', 'succeeded', 'completed'].includes(state)) {
      if (!useH3 && record?.file_id) {
        const fileURL = new URL(`${baseURL}/v1/files/retrieve`);
        fileURL.searchParams.set('file_id', String(record.file_id));
        const file = await jsonRequest(fileURL.toString(), { headers }, 45_000);
        const downloadURL = String(file?.file?.download_url || file?.download_url || '').trim();
        if (!downloadURL) throw new Error('MiniMax returned a file id without a download URL.');
        return videoBytes({ url: downloadURL });
      }
      return videoBytes(sourceFromPayload(record));
    }
    if (['failed', 'cancelled', 'canceled', 'error'].includes(state)) throw externalServiceJobFailed(record?.error || `MiniMax task ${state}.`);
    await sleep(1000);
  }
  throw new Error('MiniMax video task timed out while waiting for output.');
};

const executeVolcengine = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const baseURL = providerBaseURL('volcengine');
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: `${prompt} --ratio ${aspectRatioFor(width, height)} --dur ${Math.min(12, duration)}` }];
  if (imageUrl) content.push({ type: 'image_url', image_url: { url: imageUrl } });
  const body = { model, content };
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const created = externalServiceJob()?.id ? { id: externalServiceJob()!.id } : await jsonRequest(`${baseURL}/contents/generations/tasks`, { method: 'POST', headers, body: JSON.stringify(body) });
  const taskId = String(created?.id || created?.task_id || '').trim();
  if (!taskId) throw new Error('Volcengine Ark did not return a Seedance task id.');
  rememberExternalServiceJob('volcengine', model, taskId);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const task = await jsonRequest(`${baseURL}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { headers }, 45_000);
    const state = String(task?.status || task?.task?.status || '').toLowerCase();
    if (['succeeded', 'success', 'completed'].includes(state)) return videoBytes(sourceFromPayload(task));
    if (['failed', 'canceled', 'cancelled', 'error', 'expired'].includes(state)) throw externalServiceJobFailed(task?.error?.message || task?.error || `Volcengine Ark task ${state}.`);
    await sleep(1000);
  }
  throw new Error('Volcengine Ark Seedance task timed out while waiting for output.');
};

const executeFal = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const baseURL = providerBaseURL('fal');
  const routedModel = imageUrl && /\/text-to-video$/i.test(model) ? model.replace(/\/text-to-video$/i, '/image-to-video') : model;
  const isWan = /wan-25/i.test(routedModel);
  const isSeedance = /seedance/i.test(routedModel);
  const isKling = /kling/i.test(routedModel);
  const body: Record<string, unknown> = { prompt };
  if (isWan) {
    body.aspect_ratio = aspectRatioFor(width, height);
    body.duration = String(duration <= 7 ? 5 : 10);
    body.resolution = Math.max(width, height) >= 1280 ? '1080p' : '480p';
  } else if (isSeedance || isKling) {
    body.aspect_ratio = aspectRatioFor(width, height);
    body.duration = Math.min(12, duration);
    if (isSeedance || isKling) body.generate_audio = true;
  }
  if (imageUrl) body.image_url = imageUrl;
  const submitted = externalServiceJob()?.id ? { request_id: externalServiceJob()!.id } : await jsonRequest(`${baseURL}/${modelPath(routedModel)}`, { method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const requestId = String(submitted?.request_id || '').trim();
  if (!requestId) return videoBytes(sourceFromPayload(submitted));
  rememberExternalServiceJob('fal', routedModel, requestId);
  const queuePath = modelPath(routedModel.split('/').slice(0, 2).join('/'));
  const statusURL = String(submitted?.status_url || `${baseURL}/${queuePath}/requests/${encodeURIComponent(requestId)}/status`);
  const responseURL = String(submitted?.response_url || `${baseURL}/${queuePath}/requests/${encodeURIComponent(requestId)}`);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const status = await jsonRequest(statusURL, { headers: { Authorization: `Key ${key}`, Accept: 'application/json' } }, 45_000);
    if (status?.status === 'COMPLETED') {
      try {
        return videoBytes(sourceFromPayload(await jsonRequest(responseURL, { headers: { Authorization: `Key ${key}`, Accept: 'application/json' } }, 90_000)));
      } catch (error: any) {
        if (error?.status === 422 && !error?.assetURL) throw externalServiceJobFailed(error.message);
        throw error;
      }
    }
    if (['FAILED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(String(status?.status || '').toUpperCase())) throw externalServiceJobFailed(status?.error || 'FAL video request failed.');
    await sleep(1000);
  }
  throw new Error('FAL video request timed out while waiting in the queue.');
};

const executeReplicate = async (model: string, prompt: string, key: string, _width: number, _height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const [owner, ...nameParts] = model.split('/');
  const name = nameParts.join('/');
  if (!owner || !name) throw new Error('Replicate model must use the exact owner/model format.');
  const input: Record<string, unknown> = { prompt };
  if (/^minimax\/video-01$/i.test(model)) {
    if (imageUrl) input.first_frame_image = imageUrl;
  } else if (/^bytedance\/seedance-1-(pro|lite)$/i.test(model)) {
    input.duration = Math.min(12, Math.max(2, duration));
    input.resolution = '1080p';
    input.aspect_ratio = aspectRatioFor(_width, _height);
    if (imageUrl) input.image = imageUrl;
  } else if (imageUrl) {
    // Custom/community schemas vary. The documented common field is `image`;
    // do not send both image and image_url and make the provider reject the body.
    input.image = imageUrl;
  }
  const baseURL = providerBaseURL('replicate');
  const created = externalServiceJob()?.id ? { id: externalServiceJob()!.id } : await jsonRequest(`${baseURL}/models/${encodeURIComponent(owner)}/${modelPath(name)}/predictions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'wait=1', Accept: 'application/json' }, body: JSON.stringify({ input }) });
  const id = String(created?.id || '').trim();
  if (!id) return videoBytes(sourceFromPayload(created));
  rememberExternalServiceJob('replicate', model, id);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const prediction = attempt === 0 && ['succeeded', 'completed'].includes(String(created?.status || '').toLowerCase())
      ? created
      : await jsonRequest(`${baseURL}/predictions/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 45_000);
    const state = String(prediction?.status || '').toLowerCase();
    if (['succeeded', 'completed'].includes(state)) return videoBytes(sourceFromPayload(prediction));
    if (['failed', 'canceled', 'cancelled'].includes(state)) throw externalServiceJobFailed(prediction?.error || `Replicate prediction ${state}.`);
    await sleep(1000);
  }
  throw new Error('Replicate prediction timed out while waiting for video output.');
};

const executeXai = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const body: Record<string, unknown> = { model, prompt, duration: Math.min(15, duration), aspect_ratio: aspectRatioFor(width, height), resolution: Math.max(width, height) >= 1280 ? '720p' : '480p' };
  if (imageUrl) body.image = { url: imageUrl };
  const baseURL = providerBaseURL('xai');
  const created = externalServiceJob()?.id ? { request_id: externalServiceJob()!.id } : await jsonRequest(`${baseURL}/videos/generations`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const id = String(created?.request_id || '').trim();
  if (!id) throw new Error('xAI did not return a video request id.');
  rememberExternalServiceJob('xai', model, id);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const status = await jsonRequest(`${baseURL}/videos/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 45_000);
    const state = String(status?.status || '').toLowerCase();
    if (state === 'done' || state === 'completed' || state === 'succeeded') return videoBytes(sourceFromPayload(status));
    if (['failed', 'expired', 'error', 'canceled', 'cancelled'].includes(state)) throw externalServiceJobFailed(status?.error || `xAI video request ${state}.`);
    await sleep(1000);
  }
  throw new Error('xAI video request timed out while waiting for output.');
};

const executeProvider = (provider: VideoProvider, model: string, input: VideoGenerationInput, key: string): Promise<Buffer> => {
  const width = Math.min(1920, Math.max(512, Math.round(input.width || 1280)));
  const height = Math.min(1920, Math.max(512, Math.round(input.height || 720)));
  const duration = clampDuration(input.duration);
  switch (provider) {
    case 'google': return executeGoogle(model, input.prompt, key, width, height, duration, input.imageUrl);
    case 'openai': return executeOpenAI(model, input.prompt, key, width, height, duration, input.imageUrl);
    case 'runway': return executeRunway(model, input.prompt, key, width, height, duration, input.imageUrl);
    case 'luma': return executeLuma(model, input.prompt, key, width, height, duration, input.imageUrl);
    case 'minimax': return executeMiniMax(model, input.prompt, key, width, height, duration, input.imageUrl);
    case 'volcengine': return executeVolcengine(model, input.prompt, key, width, height, duration, input.imageUrl);
    case 'fal': return executeFal(model, input.prompt, key, width, height, duration, input.imageUrl);
    case 'replicate': return executeReplicate(model, input.prompt, key, width, height, duration, input.imageUrl);
    case 'xai': return executeXai(model, input.prompt, key, width, height, duration, input.imageUrl);
  }
};

export async function executeVideoGeneration(input: VideoGenerationInput, context?: ExternalServiceContext): Promise<VideoGenerationResult> {
  const settings = getRuntimeVideoSettings();
  const preferred = input.provider || settings.provider;
  if (input.jobId && (!input.provider || !input.model?.trim())) throw new Error('Resuming a video requires the provider and model returned with the job ID.');
  if (!providerOrder(settings).includes(preferred)) throw new Error('The requested video provider is not enabled in the primary or fallback order.');
  const model = input.model?.trim() || settings.modelByProvider[preferred] || VIDEO_PROVIDER_META[preferred].defaultModel;
  return withExternalServiceContext({ ...context, serviceSettings: settings, job: input.jobId ? { id: input.jobId, provider: preferred, model } : undefined }, () => executeVideoRoute(input, settings, context));
}

async function executeVideoRoute(input: VideoGenerationInput, settings: VideoSettings, context?: ExternalServiceContext): Promise<VideoGenerationResult> {
  throwIfExternalServiceCancelled();
  if (!settings.enabled) return { success: false, filePath: '', provider: '', model: '', providerActionMode: 'failed', message: 'Video generation is disabled in External service settings.' };
  if (!input.prompt?.trim()) throw new Error('Video generation requires a non-empty prompt.');
  const attemptedProviders: VideoProvider[] = [];
  const failedProviders: NonNullable<VideoGenerationResult['failedProviders']> = [];
  const preferred = input.provider || settings.provider;
  const order = input.jobId ? [preferred] : [preferred, ...providerOrder(settings).filter(provider => provider !== preferred)];
  for (const provider of order) {
    throwIfExternalServiceCancelled();
    const meta = VIDEO_PROVIDER_META[provider];
    const model = input.model?.trim() && provider === preferred ? input.model.trim() : (settings.modelByProvider[provider] || meta.defaultModel);
    if (!meta.available || (input.imageUrl ? !meta.supportsImageInput : !meta.supportsTextToVideo)) {
      failedProviders.push({ provider, model, error: 'This route does not support the requested video operation.' }); continue;
    }
    const keys = keysForProvider(provider, settings);
    if (keys.length === 0) { failedProviders.push({ provider, model, error: 'No credential configured.' }); continue; }
    attemptedProviders.push(provider);
    const start = keyCursor[provider] || 0;
    const orderedKeys = keys.map((_, offset) => keys[(start + offset) % keys.length]);
    let bytes: Buffer;
    try {
      bytes = await withApiKeyRounds(orderedKeys, context?.runtimeSettings, async (key, attempt) => {
        let bytes: Buffer;
        try { bytes = await executeProvider(provider, model, input, key); }
        catch (error) { throw externalServiceJobAccessError(error); }
        assertVideo(bytes);
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
        return { success: false, filePath: '', provider, model: job.model, providerActionMode: 'pending', attemptedProviders, failedProviders, job,
          message: `Video job ${job.id} needs follow-up: ${error?.message || error}. Resume with provider="${provider}", model="${job.model}", and jobId="${job.id}"; do not submit a replacement generation.` };
      }
      if (error?.assetURL) return { success: false, filePath: '', provider, model, providerActionMode: 'failed', attemptedProviders, failedProviders, downloadURL: error.assetURL,
        message: `${error.message}. The provider returned a video URL; retry its download instead of generating another video.` };
      continue;
    }
    const outputPath = path.join(path.dirname(input.filePath), `${path.basename(input.filePath, path.extname(input.filePath))}${videoExtension(bytes)}`);
    try {
      throwIfExternalServiceCancelled();
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, bytes);
    } catch (error: any) {
      throwIfExternalServiceCancelled();
      return { success: false, filePath: '', provider, model, providerActionMode: 'failed', attemptedProviders, failedProviders, job: externalServiceJob(),
        message: `Video generation succeeded, but saving ${outputPath} failed: ${error?.message || error}. No additional generation was submitted.` };
    }
    const actualModel = externalServiceJob()?.model || model;
    return { success: true, filePath: outputPath, provider, model: actualModel, providerActionMode: 'provider-native', attemptedProviders, failedProviders,
      message: `Real video generated by ${meta.label} using ${actualModel}. Saved at ${outputPath}.` };
  }
  const job = externalServiceJob();
  return { success: false, filePath: '', provider: job?.provider || '', model: job?.model || '', providerActionMode: job ? 'pending' : 'failed', attemptedProviders, failedProviders, job,
    message: `${job ? `Existing video job ${job.id} could not be resumed; keep its provider, model, and jobId for a later retry.` : 'No video provider completed a real generation request.'} ${failedProviders.map(item => `${item.provider}/${item.model}: ${item.error}`).join(' | ')}` };
}

export async function testVideoProvider(provider: VideoProvider, key = '', model = '', endpoint = ''): Promise<{ provider: VideoProvider; model: string; message: string }> {
  const meta = VIDEO_PROVIDER_META[provider];
  const selectedModel = model.trim() || meta.defaultModel;
  if (!meta.available) throw new Error('Video provider is unavailable.');
  key = key.trim() || keysForProvider(provider, getRuntimeVideoSettings())[0] || '';
  if (!key) throw new Error(`${meta.authLabel} is required.`);
  const baseURL = (endpoint.trim() || providerBaseURL(provider)).replace(/\/+$/, '');
  if (provider === 'fal') {
    await readFalModelCatalog(baseURL, key, selectedModel);
    return { provider, model: selectedModel, message: `FAL advertised '${selectedModel}' in its public catalog. Credentials and video generation access remain unverified.` };
  }
  const headers = { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' };
  let response: Response;
  if (provider === 'google') response = await request(`${baseURL.replace(/\/v1beta$/, '')}/v1beta/models`, { headers: { 'x-goog-api-key': key } }, 20_000);
  else if (provider === 'openai') response = await request(`${baseURL}/models`, { headers }, 20_000);
  else if (provider === 'xai') response = await request(`${baseURL}/video-generation-models`, { headers }, 20_000);
  else if (provider === 'replicate') {
    const [owner, ...nameParts] = selectedModel.split('/');
    const name = nameParts.join('/');
    if (!owner || !name) throw new Error('Replicate selected model must use the exact owner/model format.');
    response = await request(`${baseURL}/models/${encodeURIComponent(owner)}/${modelPath(name)}`, { headers }, 20_000);
  }
  else if (provider === 'runway') response = await request(`${baseURL}/organization`, { headers: { ...headers, 'X-Runway-Version': '2024-11-06' } }, 20_000);
  else if (provider === 'luma') response = await request(`${baseURL}/generations?limit=1`, { headers }, 20_000);
  else if (provider === 'minimax') response = await request(`${baseURL}/v2/query/video_generation?page_num=1&page_size=1`, { headers }, 20_000);
  else if (provider === 'volcengine') response = await request(`${baseURL}/contents/generations/tasks`, { headers }, 20_000);
  else response = await request(`${baseURL}/${modelPath(selectedModel)}`, { headers }, 20_000);
  if ([401, 403].includes(response.status)) throw new Error(`${response.status} ${response.statusText}: credentials were rejected.`);
  if (response.status < 200 || response.status >= 300) throw new Error(`${response.status} ${response.statusText}: endpoint/model probe did not verify ${selectedModel}.`);
  const payload = await response.clone().json().catch(() => null);
  if (!payload || payload.error || Number(payload?.base_resp?.status_code || 0) !== 0) throw new Error(`${meta.label} did not return a successful JSON response to the read-only probe. Generation has not been exercised.`);
  if (provider === 'openai' || provider === 'xai' || provider === 'replicate' || provider === 'google') {
    const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : [];
    const ids: string[] = provider === 'replicate' && payload?.owner && payload?.name
      ? [`${payload.owner}/${payload.name}`]
      : entries.map((entry: any) => String(entry?.id || entry?.name || '').trim()).filter(Boolean);
    if (!ids.some((id: string) => id === selectedModel || id.endsWith(`/${selectedModel}`))) throw new Error(`${meta.label} did not advertise '${selectedModel}' in this catalog response; generation access is unverified.`);
  }
  return { provider, model: selectedModel, message: ['openai', 'xai', 'replicate', 'google'].includes(provider)
    ? `${meta.label} advertised '${selectedModel}' in its catalog. This does not establish video generation access.`
    : `${meta.label} responded to a read-only endpoint request. Model access and video generation have not been verified.` };
}
