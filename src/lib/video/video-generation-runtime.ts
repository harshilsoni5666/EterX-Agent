import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import {
  DEFAULT_VIDEO_SETTINGS,
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
};

export type VideoGenerationResult = {
  success: boolean;
  filePath: string;
  provider: string;
  model: string;
  providerActionMode: 'provider-native' | 'failed';
  message: string;
};

type VideoSource = { url?: string; base64?: string; contentType?: string; headers?: Record<string, string> };

const runtimeGlobal = globalThis as typeof globalThis & {
  __eterxVideoSettings?: VideoSettings;
};

const keyCursor: Partial<Record<VideoProvider, number>> = {};

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
  fallbackProviders: String(process.env.ETERX_VIDEO_FALLBACK_PROVIDERS || '')
    .split(',').map(value => value.trim()).filter(Boolean),
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

const keysForProvider = (provider: VideoProvider, settings: VideoSettings): string[] => Array.from(new Set([
  ...(settings.apiKeys[provider] || []),
  ...envValues(environmentKeys[provider]),
].map(value => value.trim()).filter(Boolean))).slice(0, 3);

const providerBaseURL = (provider: VideoProvider, settings = getRuntimeVideoSettings()): string => (
  settings.baseURLs[provider] || envBaseURL(provider) || VIDEO_PROVIDER_META[provider].defaultBaseURL
).replace(/\/+$/, '');

export function getVideoGenerationRouteBrief(): string {
  const settings = getRuntimeVideoSettings();
  const meta = VIDEO_PROVIDER_META[settings.provider];
  const model = settings.modelByProvider[settings.provider] || meta.defaultModel;
  const fallbackText = settings.fallbackProviders
    .map(provider => `${VIDEO_PROVIDER_META[provider].label}/${settings.modelByProvider[provider] || VIDEO_PROVIDER_META[provider].defaultModel}`)
    .join(' -> ') || 'None';
  const fallbackCredentials = settings.fallbackProviders
    .map(provider => `${VIDEO_PROVIDER_META[provider].label}: ${keysForProvider(provider, settings).length ? 'ready' : 'missing credentials'}`)
    .join(', ') || 'none';
  return [
    '[Video generation route]',
    `Active provider: ${meta.label}. Model: ${model}. Status: ${meta.available ? 'available' : 'unavailable'}. Credential: ${keysForProvider(settings.provider, settings).length ? 'ready' : 'missing'}.`,
    `Capabilities: ${meta.supportsTextToVideo ? 'text-to-video' : ''}${meta.supportsImageInput ? ', image-to-video' : ''}${meta.supportsAudioOutput ? ', synced audio where supported' : ''}.`,
    `Fallback order: ${fallbackText}.`,
    `Fallback credentials: ${fallbackCredentials}.`,
    'The video_generator tool reads this route for every call, rotates up to three keys per provider, fails over after a real provider error, and writes only validated video bytes. FAL and Replicate accept exact model IDs so current open-source catalogs can be used without an app release.',
  ].join('\n');
}

const withTimeout = async <T,>(promise: Promise<T>, milliseconds = 90_000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Video provider request timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

const request = async (url: string, init: RequestInit = {}, timeout = 90_000): Promise<Response> => {
  const response = await withTimeout(fetch(url, init), timeout);
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  let detail = body;
  try {
    const parsed = body ? JSON.parse(body) : null;
    detail = parsed?.error?.message || parsed?.error || parsed?.message || body;
  } catch { }
  throw new Error(`${response.status} ${response.statusText}${detail ? `: ${String(detail).slice(0, 360)}` : ''}`);
};

const jsonRequest = async (url: string, init: RequestInit = {}, timeout = 90_000): Promise<any> => {
  const response = await request(url, init, timeout);
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error('Video provider returned a non-JSON response.'); }
};

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
  const candidates = [
    payload?.video,
    payload?.video_url,
    payload?.videoUrl,
    payload?.assets?.video,
    payload?.asset?.video,
    payload?.content,
    payload?.output,
    payload?.result?.video,
    payload?.result?.output,
    payload?.generatedVideos?.[0]?.video,
    payload?.response?.generatedVideos?.[0]?.video,
    payload,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && (/^https?:\/\//i.test(candidate) || /^data:video\//i.test(candidate))) return candidate.startsWith('data:') ? { base64: candidate } : { url: candidate };
    if (Array.isArray(candidate)) return sourceFromPayload(candidate);
    if (!candidate || typeof candidate !== 'object') continue;
    const url = candidate.url || candidate.uri || candidate.video_url || candidate.videoUrl || candidate.download_url || candidate.downloadUrl;
    const base64 = candidate.b64_json || candidate.base64 || candidate.video_base64 || candidate.bytesBase64Encoded;
    if (typeof base64 === 'string' && base64.trim()) return { base64: base64.trim(), contentType: candidate.mimeType || candidate.content_type };
    if (typeof url === 'string' && (/^https?:\/\//i.test(url) || /^data:video\//i.test(url))) return url.startsWith('data:') ? { base64: url, contentType: candidate.mimeType } : { url: url.trim(), contentType: candidate.mimeType || candidate.content_type };
  }
  if (Array.isArray(payload)) return sourceFromPayload(payload[0]);
  throw new Error('Video provider returned no downloadable video asset.');
};

const videoBytes = async (source: VideoSource): Promise<Buffer> => {
  if (source.base64) {
    const clean = source.base64.replace(/^data:[^;]+;base64,/i, '');
    return Buffer.from(clean, 'base64');
  }
  if (!source.url) throw new Error('Video provider returned no video source.');
  const response = await request(source.url, { method: 'GET', headers: { Accept: 'video/*,application/octet-stream', ...(source.headers || {}) } }, 180_000);
  return Buffer.from(await response.arrayBuffer());
};

export const assertVideo = (bytes: Buffer): void => {
  const isMp4 = bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  const isWebm = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const isOgg = bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS';
  if (!isMp4 && !isWebm && !isOgg) throw new Error('Provider response was not a supported MP4, WebM, or Ogg video.');
};

const executeGoogle = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const ai = new GoogleGenAI({ apiKey: key });
  const config: Record<string, unknown> = { aspectRatio: aspectRatioFor(width, height), durationSeconds: String(Math.min(8, duration)) };
  const requestBody: Record<string, unknown> = { model, prompt, config };
  if (imageUrl) {
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
  let operation: any = await (ai.models as any).generateVideos(requestBody);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (operation?.done || operation?.response?.generatedVideos?.length) {
      const source = sourceFromPayload(operation);
      if (source.url && !source.url.includes('generativelanguage.googleapis.com')) return videoBytes(source);
      if (source.url) source.headers = { 'x-goog-api-key': key };
      return videoBytes(source);
    }
    if (operation?.error) throw new Error(operation.error.message || 'Google video operation failed.');
    await sleep(1000);
    operation = await (ai.operations as any).getVideosOperation({ operation });
  }
  throw new Error('Google video operation timed out while waiting for Veo output.');
};

const executeOpenAI = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('seconds', String([4, 8, 12].includes(duration) ? duration : duration <= 6 ? 4 : duration <= 10 ? 8 : 12));
  form.append('size', openAiSizeFor(width, height));
  if (imageUrl) {
    const reference = await request(imageUrl, { headers: { Accept: 'image/*' } }, 45_000);
    const contentType = reference.headers.get('content-type') || 'image/png';
    form.append('input_reference', new Blob([await reference.arrayBuffer()], { type: contentType }), 'reference.png');
  }
  const created = await jsonRequest(`${providerBaseURL('openai')}/videos`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, body: form }, 90_000);
  const id = String(created?.id || '').trim();
  if (!id) throw new Error('OpenAI did not return a video job id.');
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = attempt === 0 ? created : await jsonRequest(`${providerBaseURL('openai')}/videos/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 45_000);
    const state = String(status?.status || '').toLowerCase();
    if (state === 'completed' || state === 'succeeded') {
      const response = await request(`${providerBaseURL('openai')}/videos/${encodeURIComponent(id)}/content`, { headers: { Authorization: `Bearer ${key}`, Accept: 'video/mp4' } }, 180_000);
      return Buffer.from(await response.arrayBuffer());
    }
    if (['failed', 'canceled', 'cancelled', 'expired'].includes(state)) throw new Error(status?.error?.message || status?.error || `OpenAI video job ${state}.`);
    await sleep(1000);
  }
  throw new Error('OpenAI video job timed out while waiting for Sora output.');
};

const executeRunway = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const ratio = runwayRatioFor(width, height);
  const endpoint = imageUrl ? `${providerBaseURL('runway')}/image_to_video` : `${providerBaseURL('runway')}/text_to_video`;
  const body: Record<string, unknown> = { model, promptText: prompt, ratio, duration: duration <= 6 ? 5 : 10 };
  if (imageUrl) body.promptImage = imageUrl;
  const created = await jsonRequest(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const taskId = String(created?.id || created?.taskId || '').trim();
  if (!taskId) throw new Error('Runway did not return a task id.');
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const task = await jsonRequest(`${providerBaseURL('runway')}/tasks/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06', Accept: 'application/json' } }, 45_000);
    const state = String(task?.status || '').toUpperCase();
    if (state === 'SUCCEEDED' || state === 'COMPLETED') return videoBytes(sourceFromPayload(task));
    if (['FAILED', 'CANCELED', 'CANCELLED'].includes(state)) throw new Error(task?.failure || task?.failureCode || `Runway task ${state}.`);
    await sleep(1000);
  }
  throw new Error('Runway task timed out while waiting for video output.');
};

const executeLuma = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const body: Record<string, unknown> = { prompt, model, aspect_ratio: aspectRatioFor(width, height), resolution: '720p', duration: `${Math.min(9, duration)}s` };
  if (imageUrl) body.keyframes = { frame0: { type: 'image', url: imageUrl } };
  const baseURL = providerBaseURL('luma');
  const created = await jsonRequest(`${baseURL}/generations/video`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const id = String(created?.id || '').trim();
  if (!id) throw new Error('Luma did not return a generation id.');
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = await jsonRequest(`${baseURL}/generations/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 45_000);
    const state = String(status?.state || status?.status || '').toLowerCase();
    if (['completed', 'succeeded'].includes(state)) return videoBytes(sourceFromPayload(status));
    if (['failed', 'error', 'canceled', 'cancelled'].includes(state)) throw new Error(status?.failure_reason || status?.error || `Luma generation ${state}.`);
    await sleep(1000);
  }
  throw new Error('Luma generation timed out while waiting for video output.');
};

const executeMiniMax = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const baseURL = providerBaseURL('minimax');
  const useH3 = model.toLowerCase().includes('h3');
  const body: Record<string, unknown> = useH3
    ? { model, duration: Math.min(15, duration), resolution: '2K', content: [{ type: 'text', text: prompt }] }
    : { model, prompt, duration: Math.min(6, duration), resolution: '1080P' };
  if (imageUrl) {
    if (useH3) (body.content as Array<Record<string, unknown>>).push({ type: 'image_url', image_url: { url: imageUrl }, role: 'first_frame' });
    else body.first_frame_image = imageUrl;
  }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const created = await jsonRequest(`${baseURL}/${useH3 ? 'v2' : 'v1'}/video_generation`, { method: 'POST', headers, body: JSON.stringify(body) });
  const taskId = String(created?.task_id || '').trim();
  if (!taskId) throw new Error('MiniMax did not return a task id.');
  for (let attempt = 0; attempt < 180; attempt += 1) {
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
    if (['failed', 'cancelled', 'canceled', 'error'].includes(state)) throw new Error(record?.error || `MiniMax task ${state}.`);
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
  const created = await jsonRequest(`${baseURL}/contents/generations/tasks`, { method: 'POST', headers, body: JSON.stringify(body) });
  const taskId = String(created?.id || created?.task_id || '').trim();
  if (!taskId) throw new Error('Volcengine Ark did not return a Seedance task id.');
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const task = await jsonRequest(`${baseURL}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { headers }, 45_000);
    const state = String(task?.status || task?.task?.status || '').toLowerCase();
    if (['succeeded', 'success', 'completed'].includes(state)) return videoBytes(sourceFromPayload(task));
    if (['failed', 'canceled', 'cancelled', 'error'].includes(state)) throw new Error(task?.error?.message || task?.error || `Volcengine Ark task ${state}.`);
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
  const submitted = await jsonRequest(`${baseURL}/${modelPath(routedModel)}`, { method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const requestId = String(submitted?.request_id || '').trim();
  if (!requestId) return videoBytes(sourceFromPayload(submitted));
  const statusURL = String(submitted?.status_url || `${baseURL}/${modelPath(routedModel)}/requests/${encodeURIComponent(requestId)}/status`);
  const responseURL = String(submitted?.response_url || `${baseURL}/${modelPath(routedModel)}/requests/${encodeURIComponent(requestId)}`);
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = await jsonRequest(statusURL, { headers: { Authorization: `Key ${key}`, Accept: 'application/json' } }, 45_000);
    if (status?.status === 'COMPLETED') return videoBytes(sourceFromPayload(await jsonRequest(responseURL, { headers: { Authorization: `Key ${key}`, Accept: 'application/json' } }, 90_000)));
    if (['FAILED', 'ERROR'].includes(String(status?.status || '').toUpperCase())) throw new Error(status?.error || 'FAL video request failed.');
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
  const created = await jsonRequest(`${baseURL}/models/${encodeURIComponent(owner)}/${modelPath(name)}/predictions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'wait=1', Accept: 'application/json' }, body: JSON.stringify({ input }) });
  const id = String(created?.id || '').trim();
  if (!id) return videoBytes(sourceFromPayload(created));
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const prediction = attempt === 0 && ['succeeded', 'completed'].includes(String(created?.status || '').toLowerCase())
      ? created
      : await jsonRequest(`${baseURL}/predictions/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 45_000);
    const state = String(prediction?.status || '').toLowerCase();
    if (['succeeded', 'completed'].includes(state)) return videoBytes(sourceFromPayload(prediction));
    if (['failed', 'canceled', 'cancelled'].includes(state)) throw new Error(prediction?.error || `Replicate prediction ${state}.`);
    await sleep(1000);
  }
  throw new Error('Replicate prediction timed out while waiting for video output.');
};

const executeXai = async (model: string, prompt: string, key: string, width: number, height: number, duration: number, imageUrl?: string): Promise<Buffer> => {
  const body: Record<string, unknown> = { model, prompt, duration: Math.min(15, duration), aspect_ratio: aspectRatioFor(width, height), resolution: Math.max(width, height) >= 1280 ? '720p' : '480p' };
  if (imageUrl) body.image = { url: imageUrl };
  const baseURL = providerBaseURL('xai');
  const created = await jsonRequest(`${baseURL}/videos/generations`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const id = String(created?.request_id || '').trim();
  if (!id) throw new Error('xAI did not return a video request id.');
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = await jsonRequest(`${baseURL}/videos/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 45_000);
    const state = String(status?.status || '').toLowerCase();
    if (state === 'done' || state === 'completed' || state === 'succeeded') return videoBytes(sourceFromPayload(status));
    if (['failed', 'expired', 'error'].includes(state)) throw new Error(status?.error || `xAI video request ${state}.`);
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

export async function executeVideoGeneration(input: VideoGenerationInput): Promise<VideoGenerationResult> {
  const settings = getRuntimeVideoSettings();
  if (!settings.enabled) return { success: false, filePath: '', provider: '', model: '', providerActionMode: 'failed', message: 'Video generation is disabled in External service settings.' };
  const attempted: string[] = [];
  const failures: string[] = [];
  for (const provider of providerOrder(settings)) {
    const meta = VIDEO_PROVIDER_META[provider];
    if (!meta.available) continue;
    const model = input.model && provider === settings.provider ? input.model.trim() : (settings.modelByProvider[provider] || meta.defaultModel);
    attempted.push(`${meta.label}/${model}`);
    const keys = keysForProvider(provider, settings);
    if (keys.length === 0) { failures.push(`${meta.label}: no credential configured`); continue; }
    const start = keyCursor[provider] || 0;
    const orderedKeys = keys.map((_, offset) => keys[(start + offset) % keys.length]);
    for (let index = 0; index < orderedKeys.length; index += 1) {
      try {
        const bytes = await executeProvider(provider, model, input, orderedKeys[index]);
        assertVideo(bytes);
        await fs.mkdir(path.dirname(input.filePath), { recursive: true });
        await fs.writeFile(input.filePath, bytes);
        keyCursor[provider] = (start + index + 1) % Math.max(1, keys.length);
        return { success: true, filePath: input.filePath, provider, model, providerActionMode: 'provider-native', message: `Real video generated by ${meta.label} using ${model}. Saved at ${input.filePath}.` };
      } catch (error: any) {
        failures.push(`${meta.label}/${model}: ${error?.message || String(error)}`);
      }
    }
  }
  return { success: false, filePath: '', provider: '', model: '', providerActionMode: 'failed', message: `No video provider completed a real generation request. Attempted ${attempted.join(', ') || 'none'}. ${failures.slice(0, 6).join(' | ')}` };
}

export async function testVideoProvider(provider: VideoProvider, key = '', model = ''): Promise<{ provider: VideoProvider; model: string; message: string }> {
  const meta = VIDEO_PROVIDER_META[provider];
  const selectedModel = model.trim() || meta.defaultModel;
  if (!meta.available) throw new Error('Video provider is unavailable.');
  if (!key.trim()) throw new Error(`${meta.authLabel} is required.`);
  const baseURL = providerBaseURL(provider);
  const headers = { Authorization: provider === 'fal' ? `Key ${key.trim()}` : `Bearer ${key.trim()}`, Accept: 'application/json' };
  let response: Response;
  if (provider === 'google') response = await fetch(`${baseURL}/v1beta/models?key=${encodeURIComponent(key.trim())}`);
  else if (provider === 'openai') response = await fetch(`${baseURL}/models`, { headers });
  else if (provider === 'xai') response = await fetch(`${baseURL}/video-generation-models`, { headers });
  else if (provider === 'replicate') {
    const [owner, ...nameParts] = selectedModel.split('/');
    const name = nameParts.join('/');
    if (!owner || !name) throw new Error('Replicate selected model must use the exact owner/model format.');
    response = await fetch(`${baseURL}/models/${encodeURIComponent(owner)}/${modelPath(name)}`, { headers });
  }
  else if (provider === 'runway') response = await fetch(`${baseURL}/tasks?limit=1`, { headers: { ...headers, 'X-Runway-Version': '2024-11-06' } });
  else if (provider === 'luma') response = await fetch(`${baseURL}/generations?limit=1`, { headers });
  else if (provider === 'minimax') response = await fetch(`${baseURL}/v1/query/video_generation?task_id=connection-test`, { headers });
  else if (provider === 'volcengine') response = await fetch(`${baseURL}/contents/generations/tasks`, { headers });
  else response = await fetch(`${baseURL}/${modelPath(selectedModel)}`, { headers });
  if ([401, 403].includes(response.status)) throw new Error(`${response.status} ${response.statusText}: credentials were rejected.`);
  if (response.status < 200 || response.status >= 300) throw new Error(`${response.status} ${response.statusText}: endpoint/model probe did not verify ${selectedModel}.`);
  const payload = await response.clone().json().catch(() => null);
  if (provider === 'openai' || provider === 'xai' || provider === 'replicate' || provider === 'google') {
    const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : [];
    const ids: string[] = entries.map((entry: any) => String(entry?.id || entry?.name || '').trim()).filter(Boolean);
    if (ids.length > 0 && !ids.some((id: string) => id === selectedModel || id.endsWith(`/${selectedModel}`))) throw new Error(`${meta.label} does not advertise the selected model '${selectedModel}'.`);
  }
  return { provider, model: selectedModel, message: `${meta.label} credentials and endpoint responded for the selected model '${selectedModel}' without creating a video.` };
}
