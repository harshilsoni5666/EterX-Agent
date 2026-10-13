import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { isOpenAIReasoningModel, getModelThinkingOptions, getGeminiThinkingConfig, type MainAgentProvider } from '../../../../lib/agent/model-routing';
import { readStoredModelMetadata } from '../../../../lib/agent/stored-model-metadata';
import { createProviderChatStream } from '../../../../lib/agent/provider-stream-adapter';
import { applyCompatibleThinkingParameters, assertSuccessfulCompatibleFinish, createCompatibleTaggedReasoningSplitter, splitCompatibleDeltaContent } from '../../../../lib/agent/provider-capabilities';
import { getProviderBaseURL, isLocalModelProvider } from '../../../../lib/agent/provider-runtime';
import { normalizeProviderCacheUsage } from '../../../../lib/agent/provider-prompt-cache';
import { isConcreteModelId, isModelProvider } from '../../../../lib/agent/model-selector-store';
import {
  buildScopedRuntimeSettings,
  getScopedRuntimeApiKeyValues,
  type RuntimeApiKeyProvider,
  type ScopedRuntimeSettings,
} from '../../../../lib/agent/runtime-api-keys';
import { withApiKeyRounds } from '../../../../lib/agent/api-retry';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { buildTitlePrompt, cleanGeneratedTitle, compactTitleHistory, TITLE_REQUEST_TIMEOUT_MS, TITLE_SYSTEM_PROMPT } from '../../../../lib/chat/title-generation';
import { readJsonObject, rejectCrossOrigin } from '../../agent/_shared';

export const runtime = 'nodejs';

const DEFAULT_CHAT_TITLE = 'New chat';

type RequestedTitleModel = {
  provider: MainAgentProvider;
  modelName: string;
};

const STANDARD_TITLE_TOKENS = 256;
const REASONING_TITLE_TOKENS = 4_096;

const isDefaultChatTitle = (title: unknown) =>
  !String(title || '').trim() || String(title || '').trim().toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase();

const normalizeRequestedTitleModel = (value: unknown): RequestedTitleModel | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const provider = String(source.provider || '').trim().toLowerCase();
  const modelName = String(source.modelId || source.modelName || source.model || '').trim();
  if (!isModelProvider(provider) || !isConcreteModelId(modelName) || modelName.length > 220 || /[\r\n\t]/.test(modelName)) {
    return null;
  }
  return { provider, modelName };
};

async function generateTitleWithProviderOnce(
  provider: MainAgentProvider,
  modelName: string,
  prompt: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ title: string; provider: MainAgentProvider; model: string; usage?: Record<string, number> }> {
  if (provider === 'anthropic') {
    const client = new Anthropic({
      apiKey,
      baseURL: getProviderBaseURL('anthropic'),
      maxRetries: 0,
    });
    const params: any = {
      model: modelName,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: STANDARD_TITLE_TOKENS,
    };
    const result = await client.messages.create(params, { signal });
    const titleText = Array.isArray((result as any).content)
      ? (result as any).content
        .map((part: any) => part?.type === 'text' ? String(part.text || '') : '')
        .filter(Boolean)
        .join('')
      : '';
    const title = cleanGeneratedTitle(titleText);
    if (!title) throw new Error('Model returned an invalid chat title');
    return { title, provider, model: modelName, usage: normalizeProviderCacheUsage(provider, (result as any).usage) };
  }

  if (provider === 'gemini') {
    const genAI = new GoogleGenAI({ apiKey });
    const metadata = readStoredModelMetadata('gemini', modelName);
    const lowestThinkingLevel = getModelThinkingOptions('gemini', modelName, metadata.thinking)[0]?.id;
    const thinkingConfig = lowestThinkingLevel
      ? getGeminiThinkingConfig(lowestThinkingLevel, modelName, false, metadata.thinking)
      : null;
    const result = await genAI.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        abortSignal: signal,
        systemInstruction: TITLE_SYSTEM_PROMPT,
        maxOutputTokens: thinkingConfig ? REASONING_TITLE_TOKENS : STANDARD_TITLE_TOKENS,
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    });
    const candidates = result.candidates || [];
    const titleText = candidates[0]?.content?.parts || (result as any).text;
    const title = cleanGeneratedTitle(titleText);
    if (!title) throw new Error('Model returned an invalid chat title');
    return { title, provider, model: modelName, usage: normalizeProviderCacheUsage(provider, (result as any).usageMetadata) };
  }

  // Use the same endpoint and reasoning contract as normal chat requests.
  const client = new OpenAI({
    apiKey,
    baseURL: getProviderBaseURL(provider),
    maxRetries: 0,
    defaultHeaders: provider === 'openrouter'
      ? {
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000',
        'X-Title': 'EterX Agent',
      }
      : undefined,
  });
  const metadata = readStoredModelMetadata(provider, modelName);
  const baseParams: any = {
    model: modelName,
    messages: [{ role: 'system', content: TITLE_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
    ...(provider === 'openai' && isOpenAIReasoningModel(modelName)
      ? { max_completion_tokens: REASONING_TITLE_TOKENS }
      : { max_tokens: REASONING_TITLE_TOKENS }),
  };
  const lowestThinkingLevel = getModelThinkingOptions(provider, modelName, metadata.thinking)[0]?.id;
  if (lowestThinkingLevel) {
    applyCompatibleThinkingParameters(baseParams, provider, modelName, { level: lowestThinkingLevel, capabilities: metadata.thinking });
  }
  let titleText = '';
  let usage: any;
  let finishReason: unknown;
  const taggedReasoning = createCompatibleTaggedReasoningSplitter();
  for await (const chunk of createProviderChatStream(client, provider, baseParams, signal, metadata.wire)) {
    const choice = chunk?.choices?.[0];
    titleText += splitCompatibleDeltaContent(choice?.delta?.content, taggedReasoning).text;
    if (chunk.usage) usage = chunk.usage;
    finishReason = choice?.finish_reason ?? finishReason;
  }
  titleText += taggedReasoning.flush().text;
  assertSuccessfulCompatibleFinish(finishReason, false);
  const title = cleanGeneratedTitle(titleText);
  if (!title) throw new Error('Model returned an invalid chat title');
  return { title, provider, model: modelName, usage: normalizeProviderCacheUsage(provider, usage) };
}

async function generateTitleWithProvider(
  provider: MainAgentProvider,
  modelName: string,
  prompt: string,
  runtimeSettings: ScopedRuntimeSettings,
  requestSignal: AbortSignal,
): Promise<{ title: string; provider: MainAgentProvider; model: string; usage?: Record<string, number> }> {
  const configuredKeys = getScopedRuntimeApiKeyValues(runtimeSettings, provider as RuntimeApiKeyProvider);
  const keys = configuredKeys.length > 0
    ? configuredKeys
    : isLocalModelProvider(provider)
      ? ['local-no-key-required']
      : [];
  if (keys.length === 0) throw new Error(`Missing ${provider} API key`);

  // Naming is optional metadata and must never occupy a request indefinitely.
  // One deadline covers key rotation as well as the provider call.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  const timeout = setTimeout(forwardAbort, TITLE_REQUEST_TIMEOUT_MS);
  requestSignal.addEventListener('abort', forwardAbort, { once: true });
  if (requestSignal.aborted) forwardAbort();
  try {
    return await withApiKeyRounds(
      keys,
      runtimeSettings,
      apiKey => generateTitleWithProviderOnce(provider, modelName, prompt, apiKey, controller.signal),
      controller.signal,
    );
  } finally {
    clearTimeout(timeout);
    requestSignal.removeEventListener('abort', forwardAbort);
  }
}

export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    const { history, selectedModel } = await readJsonObject(req);
    const runtimeSettings = buildScopedRuntimeSettings();
    const safeHistory = compactTitleHistory(history);
    if (!safeHistory.some(message => message.role === 'user')) {
      return NextResponse.json({ error: 'A user request is required to generate a title.' }, { status: 400 });
    }
    const requestedTitleModel = normalizeRequestedTitleModel(selectedModel);
    if (!requestedTitleModel) {
      return NextResponse.json({ error: 'The chat must supply its selected model for title generation.' }, { status: 400 });
    }
    const primaryProvider = requestedTitleModel.provider;
    const primaryModelName = requestedTitleModel.modelName;

    const prompt = buildTitlePrompt(safeHistory);

    // Use only the model that ran this chat. Title generation must not switch
    // providers or silently consume a different model's quota.
    try {
      const generated = await generateTitleWithProvider(
        primaryProvider,
        primaryModelName,
        prompt,
        runtimeSettings,
        req.signal,
      );
      if (generated.title && !isDefaultChatTitle(generated.title)) {
        return NextResponse.json(generated);
      }
    } catch (e: any) {
      console.warn(`[Title] Selected provider ${primaryProvider} (${primaryModelName}) failed:`, e.message || e);
    }

    // The client retains the query preview and its pending state for recovery.
    return NextResponse.json({ error: 'The selected model could not generate a valid title.' }, { status: 502 });
  } catch (error: any) {
    console.error('Title generation critical error:', error);
    return NextResponse.json({ error: 'Title generation failed.' }, { status: 500 });
  }
}
