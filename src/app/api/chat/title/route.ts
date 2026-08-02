import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getMainAgentModelConfig, normalizeMainAgentMode, isOpenAIReasoningModel, isAnthropicAdaptiveThinkingModel, type MainAgentMode, type MainAgentProvider } from '../../../../lib/agent/model-routing';
import { getProviderBaseURL, isLocalModelProvider } from '../../../../lib/agent/provider-runtime';
import { normalizeProviderCacheUsage } from '../../../../lib/agent/provider-prompt-cache';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import {
  buildScopedRuntimeSettings,
  getScopedRuntimeApiKey,
  type ScopedRuntimeSettings,
} from '../../../../lib/agent/runtime-api-keys';
import { readJsonObject, rejectCrossOrigin } from '../../agent/_shared';

export const runtime = 'nodejs';

const DEFAULT_CHAT_TITLE = 'New chat';

type RequestedTitleModel = {
  provider: MainAgentProvider;
  modelName: string;
};

const isDefaultChatTitle = (title: unknown) =>
  !String(title || '').trim() || String(title || '').trim().toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase();

const getTextFromPart = (part: any) => {
  if (!part || typeof part !== 'object') return '';
  if ('text' in part) return String(part.text || '');
  return '';
};

const getLatestUserText = (history: any[] = []) => {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.role !== 'user') continue;
    const text = Array.isArray(item.parts)
      ? item.parts.map(getTextFromPart).join(' ')
      : String(item.text || item.content || '');
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed) return trimmed;
  }
  return '';
};

const titleCase = (value: string) =>
  value.toLowerCase().replace(/\b[a-z0-9]/g, letter => letter.toUpperCase());

const fallbackTitleFromHistory = (history: any[] = []) => {
  const latestUserText = getLatestUserText(history);
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'make', 'making',
    'fix', 'issue', 'please', 'proper', 'fast', 'best', 'okay',
  ]);
  const seen = new Set<string>();
  const words = latestUserText
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word: string) => word.trim())
    .filter((word: string) => {
      const key = word.toLowerCase();
      if (word.length <= 2 || stopWords.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);

  if (words.length >= 2) return titleCase(words.join(' '));
  if (words.length === 1) return titleCase(`${words[0]} Task`);
  return 'New Task';
};

const cleanTitle = (rawTitle: unknown, history: any[] = []) => {
  const title = String(rawTitle || DEFAULT_CHAT_TITLE)
    .split(/\r?\n/)[0]
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const words = title.split(/\s+/).filter(Boolean);
  if (!isDefaultChatTitle(title) && words.length >= 2 && words.length <= 4) {
    return title;
  }
  if (!isDefaultChatTitle(title) && words.length > 4) {
    return words.slice(0, 4).join(' ');
  }
  return fallbackTitleFromHistory(history);
};

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

async function generateTitleWithProvider(
  provider: MainAgentProvider,
  modelName: string,
  prompt: string,
  runtimeSettings: ScopedRuntimeSettings,
  safeHistory: any[]
): Promise<{ title: string; provider: MainAgentProvider; model: string; usage?: Record<string, number> }> {
  if (provider === 'anthropic') {
    const apiKey = getScopedRuntimeApiKey(runtimeSettings, 'anthropic');
    if (!apiKey) throw new Error('Missing Anthropic API key');

    const client = new Anthropic({
      apiKey,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
    const params: any = {
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 24,
    };
    if (!isAnthropicAdaptiveThinkingModel(modelName)) {
      params.temperature = 0.2;
    }
    const result = await client.messages.create(params);
    const titleText = Array.isArray((result as any).content)
      ? (result as any).content
        .map((part: any) => part?.type === 'text' ? String(part.text || '') : '')
        .filter(Boolean)
        .join('')
      : '';
    return { title: cleanTitle(titleText, safeHistory), provider, model: modelName, usage: normalizeProviderCacheUsage(provider, (result as any).usage) };
  }

  if (provider === 'gemini') {
    const apiKey = runtimeSettings.preferredGeminiApiKey || getScopedRuntimeApiKey(runtimeSettings, 'gemini');
    if (!apiKey) throw new Error('Missing Gemini API key');

    const genAI = new GoogleGenAI({ apiKey });
    const result = await genAI.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const candidates = result.candidates || [];
    const titleText = candidates[0]?.content?.parts?.find(p => 'text' in p)?.text;
    return { title: cleanTitle(titleText, safeHistory), provider, model: modelName, usage: normalizeProviderCacheUsage(provider, (result as any).usageMetadata) };
  }

  // Other OpenAI-compatible providers: openai, openrouter, groq, mistral
  const apiKey = isLocalModelProvider(provider)
    ? (getScopedRuntimeApiKey(runtimeSettings, provider) || 'local-no-key-required')
    : getScopedRuntimeApiKey(runtimeSettings, provider);
  if (!apiKey) throw new Error(`Missing ${provider} API key`);

  const client = new OpenAI({
    apiKey,
    baseURL: getProviderBaseURL(provider),
    defaultHeaders: provider === 'openrouter'
      ? {
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000',
        'X-Title': 'EterX Agent',
      }
      : undefined,
  });
  const isReasoning = isOpenAIReasoningModel(modelName) && provider === 'openai';
  const completionsParams: any = {
    model: modelName,
    messages: [{ role: 'user', content: prompt }],
  };
  if (isReasoning) {
    completionsParams.max_completion_tokens = 24;
  } else {
    completionsParams.temperature = 0.2;
    completionsParams.max_tokens = 24;
  }
  const result = await client.chat.completions.create(completionsParams);
  return { title: cleanTitle(result.choices?.[0]?.message?.content, safeHistory), provider, model: modelName, usage: normalizeProviderCacheUsage(provider, (result as any).usage) };
}

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    const { history, currentTitle, mode, selectedModel } = await readJsonObject(req);
    const runtimeSettings = buildScopedRuntimeSettings();
    const safeHistory = Array.isArray(history) ? history : [];
    const latestUserText = getLatestUserText(safeHistory);
    const safeMode = normalizeMainAgentMode(mode);
    const modelConfig = getMainAgentModelConfig(safeMode, runtimeSettings);
    const requestedTitleModel = normalizeRequestedTitleModel(selectedModel);
    const primaryProvider = requestedTitleModel?.provider || modelConfig.provider;
    const primaryModelName = requestedTitleModel?.modelName || modelConfig.modelName;

    const prompt = `
      Generate a fresh short title for the CURRENT chat.

      STRICT RULES:
      1. Length: Exactly 2 to 4 words. 
      2. FORMAT: DO NOT use single words. Titles must be multi-word.
      3. Base the title primarily on the latest user request. Use older history only as supporting context.
      4. Never copy or preserve the previous title just because it exists. If the latest request changes the task, the title must change too.
      5. Do not use generic words like "chat", "conversation", or "agent" unless they are the actual task topic.
      6. If the current title is a default title, always replace it with something specific.
      7. Only return the title string. No punctuation at the end. No markdown.

      CURRENT TITLE:
      ${ isDefaultChatTitle(currentTitle) ? DEFAULT_CHAT_TITLE : String(currentTitle || '').slice(0, 80) }

      LATEST USER REQUEST:
      ${ latestUserText.slice(0, 1000) }

      CHAT HISTORY:
      ${ JSON.stringify(safeHistory.slice(-10)) }
    `.trim();

    // Use only the model that ran this chat. Title generation must not switch
    // providers or silently consume a different model's quota.
    try {
      const generated = await generateTitleWithProvider(
        primaryProvider,
        primaryModelName,
        prompt,
        runtimeSettings,
        safeHistory
      );
      if (generated.title && !isDefaultChatTitle(generated.title)) {
        return NextResponse.json(generated);
      }
    } catch (e: any) {
      console.warn(`[Title] Selected provider ${primaryProvider} (${primaryModelName}) failed:`, e.message || e);
    }

    // No alternate model: keep the chat usable with a deterministic local title.
    console.log('[Title] Selected model title generation failed. Using local history-based fallback.');
    const title = fallbackTitleFromHistory(safeHistory);
    return NextResponse.json({ title });
  } catch (error: any) {
    console.error('Title generation critical error:', error);
    // If anything fails critically, return a local history-based fallback rather than failing
    try {
      const { history } = await readJsonObject(req).catch(() => ({ history: [] }));
      const safeHistory = Array.isArray(history) ? history : [];
      const title = fallbackTitleFromHistory(safeHistory);
      return NextResponse.json({ title });
    } catch {
      return NextResponse.json({ title: DEFAULT_CHAT_TITLE });
    }
  }
}
