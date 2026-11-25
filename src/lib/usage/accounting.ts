import { readModelUsage } from '../model-usage';
import type { TokenRates } from './rate-catalog';

export type UsageSource = 'api' | 'sub' | 'unknown';
export type CostBasis = 'reported' | 'estimated' | 'unpriced';
export type UnpricedReason = 'missingUsage' | 'missingRate' | 'incompletePricing';
export type RateUnit = 'millionTokens' | 'image' | 'second';
export type ChargeKind = 'input' | 'cacheRead' | 'cacheWrite' | 'longCacheWrite' | 'output' | 'reasoning'
  | 'audioInput' | 'audioCacheRead' | 'audioOutput' | 'imageInput' | 'imageCacheRead' | 'imageOutput'
  | 'transcription' | 'imageGeneration' | 'videoGeneration';

export interface UsageRateLine {
  kind: ChargeKind;
  quantity: number;
  unit: RateUnit;
  rate: number;
  cost: number;
}

type ReceiptPrice = { saving: number } & (
  | { basis: 'reported'; cost: number }
  | { basis: 'estimated'; cost: number; lines?: UsageRateLine[] }
  | { basis: 'unpriced'; cost: null; reason: UnpricedReason }
);

function number(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
}

export function usageSource(provider: string): UsageSource {
  if (provider === 'codex') return 'sub';
  return provider && provider !== 'unknown' ? 'api' : 'unknown';
}

/** Only numerical measurements enter the ledger. Conversation and credential data stay out. */
export function receiptMetrics(provider: string, log: any, media = false) {
  const raw = log?.usageMetadata || log?.usage || log || {};
  const m = readModelUsage(log);
  const inputDetails = raw.input_token_details || raw.input_tokens_details || raw.prompt_tokens_details;
  const outputDetails = raw.output_token_details || raw.output_tokens_details || raw.completion_tokens_details;
  const googleModality = (list: any, modality: string) => Array.isArray(list)
    ? list.reduce((sum, detail) => sum + (detail?.modality === modality ? number(detail.tokenCount) || 0 : 0), 0) : undefined;
  const cached = number(inputDetails?.cached_tokens, m.cachedTokens) || 0;
  const outputModalities = raw.candidatesTokensDetails || raw.responseTokensDetails;
  const outputAudio = number(raw.outputAudioTokens, outputDetails?.audio_tokens, googleModality(outputModalities, 'AUDIO')) || 0;
  const outputImage = number(raw.outputImageTokens, outputDetails?.image_tokens, googleModality(outputModalities, 'IMAGE'),
    media && provider === 'openai' && /^gpt-image-|^chatgpt-image-/.test(String(log.model || '')) ? m.outputTokens : undefined) || 0;
  const reported = number(log?.reportedCostUsd, raw.reportedCostUsd, raw.cost_usd,
    provider === 'openrouter' ? raw.cost : undefined,
    provider === 'perplexity' ? raw.cost?.total_cost : undefined,
    provider === 'grok' && number(raw.cost_in_usd_ticks) !== undefined ? Number(raw.cost_in_usd_ticks) / 1e10 : undefined);
  return {
    total: Math.max(m.processedTokens, m.promptTokens + m.outputTokens), input: m.promptTokens, output: m.outputTokens, reasoning: m.reasoningTokens,
    cached: Math.min(cached, m.promptTokens), written: Math.min(m.cacheWriteTokens || 0, Math.max(0, m.promptTokens - cached)),
    longWrites: number(raw.cacheWriteLongTokens, raw.cache_creation?.ephemeral_1h_input_tokens, inputDetails?.cache_write_tokens_details?.ttl_12h_tokens) || 0,
    inputAudio: number(raw.inputAudioTokens, inputDetails?.audio_tokens, googleModality(raw.promptTokensDetails, 'AUDIO')) || 0,
    cachedAudio: number(raw.cachedAudioTokens, inputDetails?.cached_tokens_details?.audio_tokens, googleModality(raw.cacheTokensDetails, 'AUDIO')) || 0,
    inputImage: number(raw.inputImageTokens, inputDetails?.image_tokens, googleModality(raw.promptTokensDetails, 'IMAGE')) || 0,
    cachedImage: number(inputDetails?.cached_tokens_details?.image_tokens, googleModality(raw.cacheTokensDetails, 'IMAGE')) || 0,
    outputAudio, outputImage,
    hasModalityDetails: inputDetails?.text_tokens !== undefined || Array.isArray(raw.promptTokensDetails) || outputDetails?.audio_tokens !== undefined,
    images: number(raw.generatedImages), videoSeconds: number(raw.generatedSeconds),
    resolution: typeof raw.videoResolution === 'string' && /^\d+p$/.test(raw.videoResolution) ? raw.videoResolution : undefined,
    audioSeconds: raw.type === 'duration' ? number(raw.seconds) : undefined,
    media, inputMeasured: m.inputMeasured, outputMeasured: m.outputMeasured,
    measured: m.totalMeasured, cacheMeasured: m.cacheMeasured || inputDetails?.cached_tokens != null,
    ...(reported === undefined ? {} : { reported }),
  };
}
export type ReceiptMetrics = ReturnType<typeof receiptMetrics>;

export function priceReceipt(provider: string, m: ReceiptMetrics, rate: TokenRates | null, includeLines = false): ReceiptPrice {
  const saving = rate?.cache_read != null && rate.input !== undefined && m.cached > 0 && !m.media
    ? Math.max(0, rate.input - rate.cache_read) * m.cached / 1_000_000 : 0;
  const unpriced = (reason: UnpricedReason): ReceiptPrice => ({ basis: 'unpriced', reason, cost: null, saving });

  if (usageSource(provider) !== 'sub' && m.reported !== undefined) return { basis: 'reported', cost: m.reported, saving };
  if (!rate) return unpriced('missingRate');

  const lines = includeLines ? [] as UsageRateLine[] : undefined;
  let cost = 0;
  const charge = (kind: ChargeKind, quantity: number, price: number, unit: RateUnit = 'millionTokens') => {
    if (!quantity) return;
    const subtotal = quantity * price / (unit === 'millionTokens' ? 1_000_000 : 1);
    cost += subtotal;
    lines?.push({ kind, quantity, unit, rate: price, cost: subtotal });
  };
  const estimate = (): ReceiptPrice => ({ basis: 'estimated', cost, saving, lines });
  if (m.audioSeconds !== undefined && rate.per_audio_second !== undefined) {
    charge('transcription', m.audioSeconds, rate.per_audio_second, 'second');
    return estimate();
  }
  const videoRate = rate.video_resolution_rates?.[m.resolution || ''] ?? rate.per_video_second;
  if (m.videoSeconds !== undefined && videoRate !== undefined) {
    charge('videoGeneration', m.videoSeconds, videoRate, 'second');
    return estimate();
  }
  if (m.images !== undefined && rate.per_image !== undefined) {
    charge('imageGeneration', m.images, rate.per_image, 'image');
    return estimate();
  }
  if (!m.inputMeasured || !m.outputMeasured || m.total > m.input + m.output
      || (m.media && !m.hasModalityDetails && !m.inputAudio && !m.outputAudio && !m.outputImage)) {
    return unpriced('missingUsage');
  }
  if (rate.input === undefined || rate.output === undefined) return unpriced('incompletePricing');

  const cachedAudio = Math.min(m.cachedAudio, m.cached, m.inputAudio);
  const cachedImage = Math.min(m.cachedImage || 0, m.cached - cachedAudio, m.inputImage || 0);
  const cachedText = m.cached - cachedAudio - cachedImage;
  const uncached = Math.max(0, m.input - m.cached - m.written);
  const audio = Math.min(Math.max(0, m.inputAudio - cachedAudio), uncached);
  const image = Math.min(Math.max(0, (m.inputImage || 0) - cachedImage), uncached - audio);
  const longWrites = Math.min(m.longWrites, m.written);
  const writes = m.written - longWrites;
  const outputAudio = Math.min(m.output, m.outputAudio);
  const outputImage = Math.min(m.output - outputAudio, m.outputImage);
  const reasoning = Math.min(m.output - outputAudio - outputImage, m.reasoning);

  if ((audio > 0 && rate.input_audio === undefined)
      || (outputAudio > 0 && rate.output_audio === undefined)
      || (outputImage > 0 && rate.output_image === undefined)
      || (cachedAudio > 0 && rate.cached_audio === undefined)
      || (cachedText > 0 && rate.cache_read === undefined && rate.input > 0)
      || (writes > 0 && rate.cache_write === undefined && rate.input > 0)
      || (image > 0 && m.media && rate.input_image === undefined)
      || (cachedImage > 0 && (m.media ? rate.cached_image === undefined : rate.cached_image === undefined && rate.cache_read === undefined && rate.input > 0))
      || (longWrites > 0 && rate.long_write === undefined)) return unpriced('incompletePricing');

  charge('input', uncached - audio - image, rate.input);
  charge('audioInput', audio, rate.input_audio ?? 0);
  charge('imageInput', image, rate.input_image ?? rate.input);
  charge('cacheRead', cachedText, rate.cache_read ?? 0);
  charge('audioCacheRead', cachedAudio, rate.cached_audio ?? 0);
  charge('imageCacheRead', cachedImage, rate.cached_image ?? rate.cache_read ?? 0);
  charge('cacheWrite', writes, rate.cache_write ?? 0);
  charge('longCacheWrite', longWrites, rate.long_write ?? 0);
  charge('output', m.output - outputAudio - outputImage - reasoning, rate.output);
  charge('reasoning', reasoning, rate.reasoning ?? rate.output);
  charge('audioOutput', outputAudio, rate.output_audio ?? 0);
  charge('imageOutput', outputImage, rate.output_image ?? 0);
  return estimate();
}
