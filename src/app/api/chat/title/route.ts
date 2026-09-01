import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getMainAgentModelConfig, normalizeMainAgentMode, isOpenAIReasoningModel, getModelThinkingOptions, getGeminiThinkingConfig, type MainAgentMode, type MainAgentProvider } from '../../../../lib/agent/model-routing';
import { getProviderBaseURL, isLocalModelProvider } from '../../../../lib/agent/provider-runtime';
import { normalizeProviderCacheUsage } from '../../../../lib/agent/provider-prompt-cache';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import {
  buildScopedRuntimeSettings,
  getScopedRuntimeApiKeyValues,
  type RuntimeApiKeyProvider,
  type ScopedRuntimeSettings,
} from '../../../../lib/agent/runtime-api-keys';
import { withApiKeyRounds } from '../../../../lib/agent/api-retry';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { buildTitlePrompt, cleanGeneratedTitle, TITLE_SYSTEM_PROMPT } from '../../../../lib/chat/title-generation';
import { readJsonObject, rejectCrossOrigin } from '../../agent/_shared';

export const runtime = 'nodejs';

const DEFAULT_CHAT_TITLE = 'New chat';

type RequestedTitleModel = {
  provider: MainAgentProvider;
  modelName: string;
};

const STANDARD_TITLE_TOKENS = 256;
const REASONING_TITLE_TOKENS = 1_536;

const isTokenParameterCompatibilityError = (error: unknown) => {
  const status = Number((error as any)?.status || (error as any)?.statusCode || 0);
  const message = String((error as any)?.message || error || '');
  return (status === 400 || status === 422 || /invalid|unsupported|unknown|unrecognized/i.test(message))
    && /max_(?:completion_)?tokens|max output tokens/i.test(message);
};

const isLikelyReasoningModel = (provider: MainAgentProvider, modelName: string) =>
  (provider === 'openai' && isOpenAIReasoningModel(modelName)) ||
  /(?:^|[\/:_.-])(?:reasoner|reasoning|deepseek-r1|r1|magistral|qwq|qwen3|gpt-oss)(?:$|[\/:_.-])/i.test(modelName);

const isDefaultChatTitle = (title: unknown) =>
  !String(title || '').trim() || String(title || '').trim().toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase();

const normalizeRequestedTitleModel = (value: unknown): RequestedTitleModel | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const provider = String(source.provider || '').trim().toLowerCase();
  const modelName = String(source.modelId || source.modelName || source.model || '').trim();
  if (!isModelProvider(provider) || !modelName || modelName.length > 220 || /[\r\n\t]/.test(modelName)) {
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
    const lowestThinkingLevel = getModelThinkingOptions('gemini', modelName)[0]?.id;
    const thinkingConfig = lowestThinkingLevel
      ? getGeminiThinkingConfig(lowestThinkingLevel, modelName, false)
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
    const titleText = (result as any).text || candidates[0]?.content?.parts;
    const title = cleanGeneratedTitle(titleText);
    if (!title) throw new Error('Model returned an invalid chat title');
    return { title, provider, model: modelName, usage: normalizeProviderCacheUsage(provider, (result as any).usageMetadata) };
  }

  // Other OpenAI-compatible providers: openai, openrouter, groq, mistral
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
  const isReasoning = isLikelyReasoningModel(provider, modelName);
  const baseParams: any = {
    model: modelName,
    messages: [{ role: 'user', content: prompt }],
  };
  if (provider === 'openai' && isOpenAIReasoningModel(modelName)) {
    baseParams.reasoning_effort = 'low';
  }

  const tokenLimit = isReasoning ? REASONING_TITLE_TOKENS : STANDARD_TITLE_TOKENS;
  const preferredTokenField = provider === 'openai' && isOpenAIReasoningModel(modelName)
    ? 'max_completion_tokens'
    : 'max_tokens';
  const alternateTokenField = preferredTokenField === 'max_tokens'
    ? 'max_completion_tokens'
    : 'max_tokens';

  let result: any;
  try {
    result = await client.chat.completions.create({
      ...baseParams,
      [preferredTokenField]: tokenLimit,
    }, { signal });
  } catch (error) {
    if (!isTokenParameterCompatibilityError(error)) throw error;
    try {
      result = await client.chat.completions.create({
        ...baseParams,
        [alternateTokenField]: tokenLimit,
      }, { signal });
    } catch (alternateError) {
      if (!isTokenParameterCompatibilityError(alternateError)) throw alternateError;
      // A few local/OpenAI-compatible servers reject both optional token-limit
      // fields. The outer abort deadline still bounds an uncapped title call.
      result = await client.chat.completions.create(baseParams, { signal });
    }
  }
  const title = cleanGeneratedTitle(result.choices?.[0]?.message);
  if (!title) throw new Error('Model returned an invalid chat title');
  return { title, provider, model: modelName, usage: normalizeProviderCacheUsage(provider, (result as any).usage) };
}

async function generateTitleWithProvider(
  provider: MainAgentProvider,
  modelName: string,
  prompt: string,
  runtimeSettings: ScopedRuntimeSettings,
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
  const signal = AbortSignal.timeout(30_000);

  return withApiKeyRounds(
    keys,
    runtimeSettings,
    apiKey => generateTitleWithProviderOnce(provider, modelName, prompt, apiKey, signal),
    signal,
  );
}

export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    const { history, mode, selectedModel } = await readJsonObject(req);
    const runtimeSettings = buildScopedRuntimeSettings();
    const safeHistory = Array.isArray(history) ? history : [];
    const safeMode = normalizeMainAgentMode(mode);
    const modelConfig = getMainAgentModelConfig(safeMode, runtimeSettings);
    const requestedTitleModel = normalizeRequestedTitleModel(selectedModel);
    const primaryProvider = requestedTitleModel?.provider || modelConfig.provider;
    const primaryModelName = requestedTitleModel?.modelName || modelConfig.modelName;

    const prompt = buildTitlePrompt(safeHistory);

    // Use only the model that ran this chat. Title generation must not switch
    // providers or silently consume a different model's quota.
    try {
      const generated = await generateTitleWithProvider(
        primaryProvider,
        primaryModelName,
        prompt,
        runtimeSettings,
      );
      if (generated.title && !isDefaultChatTitle(generated.title)) {
        return NextResponse.json(generated);
      }
    } catch (e: any) {
      console.warn(`[Title] Selected provider ${primaryProvider} (${primaryModelName}) failed:`, e.message || e);
    }

    // Keep the neutral placeholder when the selected AI model fails. A local
    // string heuristic must never be presented as an AI-generated title.
    return NextResponse.json({ error: 'The selected model could not generate a valid title.' }, { status: 502 });
  } catch (error: any) {
    console.error('Title generation critical error:', error);
    return NextResponse.json({ error: 'Title generation failed.' }, { status: 500 });
  }
}
