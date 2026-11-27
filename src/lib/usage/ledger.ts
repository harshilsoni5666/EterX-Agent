import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openApplicationDatabase } from '../imports/sqlite-reader';
import { getEterxDataDir } from '../agent/storage-paths';
import { mergeProviderUsageSnapshots } from '../agent/provider-prompt-cache';
import { contextMeasurementTime } from '../context-usage-snapshot';
import { mergeModelUsageReceipt, modelUsageReceiptKey } from '../model-usage';
import { providerErrorCategory, recordProviderDispatch, recordProviderRequest } from '../telemetry/runtime';
import type { Dimensions, Measurements } from '../telemetry/protocol';
import { providerAvailabilitySignal } from '../app-presentation/posthog';
import { priceReceipt, receiptMetrics, usageSource, type ReceiptMetrics, type UsageRateLine } from './accounting';
import { currentRates, refreshRates } from './pricing-store';
import { findRates, type TokenRates } from './rate-catalog';
import { addRateLines, emptyTotals, type RecentUsage, type UsageBucket } from './summary';

const state = globalThis as typeof globalThis & { __eterxUsageLedger?: ReturnType<typeof openLedger> };
function openLedger() {
  const directory = path.join(getEterxDataDir(), 'usage');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = openApplicationDatabase(path.join(directory, 'receipts.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      metrics TEXT NOT NULL, rate TEXT
    );
    CREATE INDEX IF NOT EXISTS receipts_at ON receipts(at);
  `);
  return {
    insert: db.prepare('INSERT OR IGNORE INTO receipts (id, at, provider, model, metrics, rate) VALUES (?, ?, ?, ?, ?, ?)'),
    setRate: db.prepare('UPDATE receipts SET rate = ? WHERE id = ? AND rate IS NULL'),
    range: db.prepare('SELECT id, at, provider, model, metrics, rate FROM receipts WHERE at BETWEEN ? AND ? ORDER BY at'),
  };
}
const ledger = () => state.__eterxUsageLedger ??= openLedger();

function insertNative(id: string, at: number, provider: string, model: string, metrics: ReceiptMetrics, requestedModel = model) {
  const prices = currentRates().providers;
  const rates = findRates(prices, provider, model, metrics.input) ?? findRates(prices, provider, requestedModel, metrics.input);
  const savedRate = rates && priceReceipt(provider, metrics, rates).basis !== 'unpriced' ? JSON.stringify(rates) : null;
  ledger().insert.run(id, Math.trunc(at), provider, model, JSON.stringify(metrics), savedRate);
}

function providerMeasurements(metrics: ReceiptMetrics): Measurements {
  return {
    usageReports: Number(metrics.measured), inputReports: Number(metrics.inputMeasured),
    outputReports: Number(metrics.outputMeasured), cacheReports: Number(metrics.cacheMeasured),
    inputTokens: metrics.inputMeasured ? metrics.input : undefined,
    outputTokens: metrics.outputMeasured ? metrics.output : undefined,
    totalTokens: metrics.measured ? metrics.total : undefined,
    cachedTokens: metrics.cacheMeasured ? metrics.reportedCacheInput : undefined,
    cacheWriteTokens: metrics.reportedCacheWrite, reasoningTokens: metrics.reasoningMeasured ? metrics.reasoning : undefined,
    otherInputTokens: metrics.otherInput, otherOutputTokens: metrics.otherOutput,
    audioInputTokens: metrics.inputAudio, audioOutputTokens: metrics.outputAudio,
    imageInputTokens: metrics.inputImage, imageOutputTokens: metrics.outputImage,
    generatedImages: metrics.images,
    generatedVideoMs: metrics.videoSeconds === undefined ? undefined : metrics.videoSeconds * 1_000,
    audioMs: metrics.audioSeconds === undefined ? undefined : metrics.audioSeconds * 1_000,
  };
}

type ResponseOptions = {
  id?: string; responseModel?: string; media?: boolean; at?: number; durationMs?: number;
  serviceTier?: unknown;
  outcome?: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  error?: Dimensions['error'];
  feature?: NonNullable<Dimensions['feature']>;
};

/** Record a provider response before downstream validation, tool work, or UI persistence. */
export function recordModelResponse(provider: string, model: string, usage: any, options: ResponseOptions = {}): string {
  const id = options.id || usage?.eterxUsageId || randomUUID();
  try {
    const receipt = receiptMetrics(provider, { provider, model, usage: usage || {} }, options.media);
    recordProviderRequest({
      id: 'usage:' + id, provider, model, observedModel: options.responseModel, serviceTier: options.serviceTier,
      at: options.at, outcome: options.outcome ?? 'succeeded',
      feature: options.feature, error: options.error, measurements: { ...providerMeasurements(receipt), durationMs: options.durationMs },
    });
    void refreshRates();
    insertNative('usage:' + id, options.at || Date.now(), provider, options.responseModel || model, receipt, model);
  } catch (error) {
    // An accounting I/O failure must never replay a paid model request.
    console.warn('[Usage] Could not save model receipt', error);
  }
  return id;
}

export function saveLiveReceipt(
  provider: string, model: string, id: string, at: number, usage: any, outcome: NonNullable<ResponseOptions['outcome']> = 'succeeded',
) {
  void refreshRates();
  const key = 'live:' + provider + ':' + id;
  const receipt = receiptMetrics(provider, { provider, model, usage }, true);
  if (outcome === 'succeeded' || receipt.measured || receipt.audioSeconds !== undefined) {
    insertNative(key, at, provider, model, receipt);
  }
  return recordProviderRequest({ id: key, provider, model, at, feature: 'live', outcome, measurements: providerMeasurements(receipt) });
}

export function recordMediaResponse(provider: string, model: string, payload: any, kind: 'image' | 'video', jobId?: string) {
  const route = provider === 'google' ? 'gemini' : provider === 'xai' ? 'grok' : provider;
  const responseId = jobId || payload?.id || payload?.request_id;
  const id = responseId ? 'media:' + createHash('sha256').update(JSON.stringify([route, kind, responseId])).digest('hex') : undefined;
  const usage = payload?.usage ?? payload?.usageMetadata ?? payload?.response?.usageMetadata ?? {};
  recordModelResponse(route, model, { ...usage,
    ...(kind === 'image' ? { generatedImages: Array.isArray(payload?.data) ? payload.data.length || 1 : 1 }
      : { generatedSeconds: payload?.video?.duration ?? payload?.seconds ?? payload?.duration ?? payload?.input?.duration,
          videoResolution: payload?.video?.resolution ?? payload?.resolution ?? payload?.input?.resolution }),
  }, { id, media: true, feature: kind, responseModel: typeof payload?.model === 'string' ? payload.model : undefined });
}

type StreamFormat = 'compatible' | 'gemini' | 'anthropic';
type RequestTiming = { signal?: AbortSignal; startedAt?: number; dispatched?: boolean; serviceTier?: unknown };

function modelFailure(error: unknown, signal?: AbortSignal): { outcome: 'cancelled' | 'failed'; error?: Dimensions['error'] } {
  const cancelled = signal?.aborted && signal.reason?.name !== 'TimeoutError';
  return cancelled ? { outcome: 'cancelled' } : {
    outcome: 'failed', error: signal?.reason?.name === 'TimeoutError' ? 'timeout' : providerErrorCategory(error),
  };
}

export function recordModelFailure(provider: string, model: string, error: unknown, timing: RequestTiming) {
  const failure = modelFailure(error, timing.signal);
  recordProviderRequest({
    id: randomUUID(), provider, model, outcome: failure.outcome, error: failure.error,
    serviceTier: timing.serviceTier,
    measurements: { durationMs: timing.startedAt === undefined ? undefined : performance.now() - timing.startedAt },
  });
}

export async function meterModelResponse<T>(
  provider: string, model: string, request: () => Promise<T>,
  receipt: (response: T) => { usage: unknown; responseModel?: string }, signal?: AbortSignal,
) {
  const availability = await providerAvailabilitySignal(provider, signal);
  const startedAt = performance.now();
  let response: T;
  try {
    availability?.throwIfAborted();
    recordProviderDispatch(provider, model);
    response = await request();
  } catch (error) {
    recordModelFailure(provider, model, error, { startedAt, signal });
    throw error;
  }
  const { usage, responseModel } = receipt(response);
  const serviceTier = (response as { service_tier?: unknown } | null)?.service_tier;
  const usageId = recordModelResponse(provider, model, usage, { responseModel, serviceTier, durationMs: performance.now() - startedAt });
  return { response, usageId };
}

/** Each underlying request owns one ID. Stream snapshots are cumulative, including on cancellation. */
export async function* meterModelStream(provider: string, model: string,
  stream: AsyncIterable<any> | (() => Promise<AsyncIterable<any>>),
  format: StreamFormat = 'compatible', id = randomUUID() as string, timing: RequestTiming = {}): AsyncGenerator<any> {
  let usage: any;
  let responseModel = '';
  let serviceTier = timing.serviceTier;
  let outcome: NonNullable<ResponseOptions['outcome']> = 'cancelled';
  let errorCategory: Dimensions['error'];
  const availability = await providerAvailabilitySignal(provider, timing.signal);
  const startedAt = timing.startedAt ?? performance.now();
  try {
    if (!timing.dispatched) recordProviderDispatch(provider, model, serviceTier);
    for await (const event of typeof stream === 'function' ? await stream() : stream) {
      availability?.throwIfAborted();
      const raw = format === 'gemini' ? event?.usageMetadata
        : format === 'anthropic' ? event?.message?.usage || event?.usage : event?.usage || event?.x_groq?.usage;
      const reportedModel = event?.modelVersion || event?.model || event?.message?.model;
      if (typeof reportedModel === 'string' && reportedModel.trim()) responseModel = reportedModel.trim();
      if (typeof event?.service_tier === 'string') serviceTier = event.service_tier;
      if (!raw) { yield event; continue; }
      usage = mergeProviderUsageSnapshots(usage, raw);
      const tagged = { ...raw, eterxUsageId: id };
      if (format === 'gemini') yield { ...event, usageMetadata: tagged };
      else if (event.message?.usage) yield { ...event, message: { ...event.message, usage: tagged } };
      else yield { ...event, usage: tagged };
    }
    outcome = 'succeeded';
  } catch (error) {
    const failure = modelFailure(error, timing.signal);
    outcome = failure.outcome;
    errorCategory = failure.error;
    throw error;
  } finally {
    const durationMs = performance.now() - startedAt;
    if (usage || outcome === 'succeeded') {
      recordModelResponse(provider, model, usage, { id, responseModel, serviceTier, durationMs, outcome, error: errorCategory });
    } else {
      recordProviderRequest({ id: 'usage:' + id, provider, model, observedModel: responseModel, serviceTier, outcome, error: errorCategory,
        measurements: { durationMs } });
    }
  }
}

function savedUsageReceipts(chats: unknown[], start: number, end: number, recorded: Set<string>) {
  const receipts = new Map<string, any>();
  for (const chat of chats as any[]) {
    if (!Array.isArray(chat?.traceLogs)) continue;
    for (const log of chat.traceLogs) {
      if (log?.type !== 'model_usage') continue;
      const at = contextMeasurementTime(log) || (typeof log.timestamp === 'string' ? Date.parse(log.timestamp) : 0);
      if (!Number.isFinite(at) || at < start || at > end) continue;
      // A server run can appear in both a worker transcript and its parent.
      const owner = log.runId || log.turnId || log.contextRequestId ? '' : log.ownerChatId || log.chatId || chat.id;
      const receipt = { ...log, ownerChatId: owner, chatId: owner, measurementAt: at };
      const key = modelUsageReceiptKey(receipt);
      if (key && !recorded.has(key)) receipts.set(key, mergeModelUsageReceipt(receipts.get(key), receipt));
    }
  }
  return receipts.values();
}

const HOUR_MS = 3_600_000;
type UsageGroups = Map<string, { bucket: UsageBucket; rates: Map<string, UsageRateLine> }>;

function materializeGroups(groups: UsageGroups): UsageBucket[] {
  return Array.from(groups.values(), ({ bucket, rates }) => ({ ...bucket, rates: Array.from(rates.values()) }));
}

export function usageBuckets(start: number, end: number, timeZone: string, savedChats: unknown[]): { buckets: UsageBucket[]; recent: RecentUsage } {
  const store = ledger();
  const prices = currentRates().providers;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'iso8601' });
  const recentStart = Math.max(start, end - 24 * HOUR_MS);
  // Align buckets to the calendar's hour, including time zones offset by half hours.
  const localMinute = Number(new Intl.DateTimeFormat('en-US', { timeZone, minute: 'numeric', numberingSystem: 'latn' }).format(end));
  const hourOffset = ((Math.floor(end / 60_000) - localMinute) % 60) * 60_000;
  const firstHour = Math.floor((recentStart - hourOffset) / HOUR_MS) * HOUR_MS + hourOffset;
  const hours = Array.from({ length: Math.floor((end - firstHour) / HOUR_MS) + 1 },
    (_, index) => new Date(firstHour + index * HOUR_MS).toISOString());
  const dailyGroups: UsageGroups = new Map();
  const hourlyGroups: UsageGroups = new Map();
  const recorded = new Set<string>();
  const ratesToSave: Array<[string, string]> = [];
  let lastMinute = -1, day = '';

  function addToGroup(groups: UsageGroups, interval: string, provider: string, model: string,
    m: ReceiptMetrics, value: ReturnType<typeof priceReceipt>) {
    const key = JSON.stringify([interval, provider, model]);
    let group = groups.get(key);
    if (!group) {
      group = { bucket: { day: interval, provider, model, source: usageSource(provider), ...emptyTotals(), rates: [] }, rates: new Map() };
      groups.set(key, group);
    }
    const { bucket } = group;
    bucket.calls++;
    bucket.measured += Number(m.measured);
    bucket.inputReports += Number(m.inputMeasured);
    bucket.outputReports += Number(m.outputMeasured);
    bucket.cacheReports += Number(m.cacheMeasured);
    bucket.tokens += m.total;
    bucket.input += m.input;
    bucket.output += m.output;
    bucket.cached += m.cached;
    bucket.written += m.written;
    bucket.reasoning += m.reasoning;
    bucket.observedCacheInput += m.cacheMeasured ? m.input : 0;
    bucket[value.basis]++;
    bucket.cost += value.cost ?? 0;
    bucket.saving += value.saving;
    if (value.basis === 'reported') bucket.reportedCost += value.cost;
    if (value.basis === 'estimated') {
      bucket.estimatedCost += value.cost;
      if (value.lines) addRateLines(group.rates, value.lines);
    }
    if (value.basis === 'unpriced') bucket[value.reason]++;
  }

  function addReceipt(at: number, provider: string, model: string, metrics: ReceiptMetrics, rate: TokenRates | null) {
    const minute = Math.floor(at / 60_000);
    if (minute !== lastMinute) {
      const parts = formatter.formatToParts(at);
      day = ['year', 'month', 'day'].map(unit => parts.find(part => part.type === unit)?.value).join('-');
      lastMinute = minute;
    }
    const value = priceReceipt(provider, metrics, rate, true);
    addToGroup(dailyGroups, day, provider, model, metrics, value);
    if (at >= recentStart) {
      const index = Math.floor((at - firstHour) / HOUR_MS);
      addToGroup(hourlyGroups, hours[index], provider, model, metrics, value);
    }
    return value.basis;
  }

  for (const item of store.range.iterate(start, end)) {
    const { provider, model } = item as { provider: string; model: string };
    const metrics: ReceiptMetrics & { historical?: boolean } = JSON.parse(String(item.metrics));
    if (metrics.historical) continue;
    recorded.add(String(item.id));
    const rate: TokenRates | null = item.rate ? JSON.parse(String(item.rate)) : findRates(prices, provider, model, metrics.input);
    const basis = addReceipt(Number(item.at), provider, model, metrics, rate);
    if (!item.rate && rate && basis !== 'unpriced') ratesToSave.push([JSON.stringify(rate), String(item.id)]);
  }

  // Release the SELECT cursor before updating the same table.
  try {
    for (const [rate, id] of ratesToSave) store.setRate.run(rate, id);
  } catch (error) {
    console.warn('[Usage] Could not save matched rates', error);
  }

  // Saved measurements fill gaps in the ledger without rewriting chats or usage history.
  for (const receipt of savedUsageReceipts(savedChats, start, end, recorded)) {
    const provider = String(receipt.provider || 'unknown').trim().toLowerCase();
    const model = String(receipt.model || receipt.modelId || 'Unknown model');
    const metrics = receiptMetrics(provider, receipt);
    addReceipt(receipt.measurementAt, provider, model, metrics, findRates(prices, provider, model, metrics.input));
  }
  return {
    buckets: materializeGroups(dailyGroups),
    recent: { startAt: recentStart, endAt: end, hours, buckets: materializeGroups(hourlyGroups) },
  };
}
