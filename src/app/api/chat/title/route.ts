import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getMainAgentModelConfig, normalizeMainAgentMode, isOpenAIReasoningModel, isAnthropicAdaptiveThinkingModel, type MainAgentMode, type MainAgentProvider } from '../../../../lib/agent/model-routing';
import { getProviderBaseURL, isLocalModelProvider } from '../../../../lib/agent/provider-runtime';
import {
  buildScopedRuntimeSettings,
  getScopedRuntimeApiKey,
  type ScopedRuntimeSettings,
} from '../../../../lib/agent/runtime-api-keys';
import { readJsonObject, rejectCrossOrigin } from '../../agent/_shared';

export const runtime = 'nodejs';

const DEFAULT_CHAT_TITLE = 'New chat';

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

async function generateTitleWithProvider(
  provider: MainAgentProvider,
  modelName: string,
  prompt: string,
  runtimeSettings: ScopedRuntimeSettings,
  safeHistory: any[]
): Promise<string> {
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
    return cleanTitle(titleText, safeHistory);
  }

  if (provider === 'gemini') {
    const apiKey = runtimeSettings.preferredGeminiApiKey || getScopedRuntimeApiKey(runtimeSettings, 'gemini');
    if (!apiKey) throw new Error('Missing Gemini API key');

    const genAI = new GoogleGenAI({ apiKey });
    let result;
    try {
      result = await genAI.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          thinkingConfig: {
            thinkingLevel: 'minimal' as any,
            includeThoughts: false,
          },
        },
      });
    } catch (err: any) {
      const errMsg = String(err.message || '').toLowerCase();
      if (
        errMsg.includes('thinking') ||
        errMsg.includes('config') ||
        errMsg.includes('parameter') ||
        errMsg.includes('invalid') ||
        errMsg.includes('unsupported') ||
        errMsg.includes('fields') ||
        errMsg.includes('argument')
      ) {
        console.log(`[Title] Model ${modelName} does not support thinkingConfig, retrying without it.`);
        result = await genAI.models.generateContent({
          model: modelName,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
      } else {
        throw err;
      }
    }
    const candidates = result.candidates || [];
    const titleText = candidates[0]?.content?.parts?.find(p => 'text' in p)?.text;
    return cleanTitle(titleText, safeHistory);
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
  return cleanTitle(result.choices?.[0]?.message?.content, safeHistory);
}

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    const { history, currentTitle, mode } = await readJsonObject(req);
    const runtimeSettings = buildScopedRuntimeSettings();
    const safeHistory = Array.isArray(history) ? history : [];
    const latestUserText = getLatestUserText(safeHistory);
    const safeMode = normalizeMainAgentMode(mode);
    const modelConfig = getMainAgentModelConfig(safeMode, runtimeSettings);

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

    // 1. Try primary provider first
    try {
      const title = await generateTitleWithProvider(
        modelConfig.provider,
        modelConfig.modelName,
        prompt,
        runtimeSettings,
        safeHistory
      );
      if (title && !isDefaultChatTitle(title)) {
        return NextResponse.json({ title });
      }
    } catch (e: any) {
      console.warn(`[Title] Primary provider ${modelConfig.provider} (${modelConfig.modelName}) failed:`, e.message || e);
    }

    // 2. Fallback: Loop through other providers to find one with an active key
    const fallbackProviders: { provider: MainAgentProvider; modelName: string }[] = [];
    
    // Add gemini as the preferred fallback if it wasn't the primary
    if (modelConfig.provider !== 'gemini') {
      const geminiConfig = getMainAgentModelConfig('think', runtimeSettings);
      fallbackProviders.push({ provider: 'gemini', modelName: geminiConfig.modelName });
    }
    
    // Add other potential providers in order
    const orderedProviders: { mode: MainAgentMode; provider: MainAgentProvider }[] = [
      { mode: 'openai', provider: 'openai' },
      { mode: 'anthropic', provider: 'anthropic' },
      { mode: 'openrouter', provider: 'openrouter' },
      { mode: 'groq', provider: 'groq' },
      { mode: 'mistral', provider: 'mistral' }
    ];
    
    for (const p of orderedProviders) {
      if (p.provider !== modelConfig.provider) {
        const config = getMainAgentModelConfig(p.mode, runtimeSettings);
        fallbackProviders.push({ provider: p.provider, modelName: config.modelName });
      }
    }

    for (const fb of fallbackProviders) {
      // Check if this provider has an API key in settings
      const key = fb.provider === 'gemini'
        ? (runtimeSettings.preferredGeminiApiKey || getScopedRuntimeApiKey(runtimeSettings, 'gemini'))
        : fb.provider === 'openai'
          ? getScopedRuntimeApiKey(runtimeSettings, 'openai')
          : fb.provider === 'anthropic'
            ? getScopedRuntimeApiKey(runtimeSettings, 'anthropic')
            : fb.provider === 'openrouter'
              ? getScopedRuntimeApiKey(runtimeSettings, 'openrouter')
              : fb.provider === 'groq'
                ? getScopedRuntimeApiKey(runtimeSettings, 'groq')
                : fb.provider === 'mistral'
                  ? getScopedRuntimeApiKey(runtimeSettings, 'mistral')
                  : null;
      
      if (!key) continue;

      try {
        console.log(`[Title] Attempting fallback with provider: ${fb.provider} (${fb.modelName})`);
        const title = await generateTitleWithProvider(
          fb.provider,
          fb.modelName,
          prompt,
          runtimeSettings,
          safeHistory
        );
        if (title && !isDefaultChatTitle(title)) {
          return NextResponse.json({ title });
        }
      } catch (e: any) {
        console.warn(`[Title] Fallback provider ${fb.provider} (${fb.modelName}) failed:`, e.message || e);
      }
    }

    // 3. Absolute fallback: generate from history locally (no API call)
    console.log('[Title] All API title generation attempts failed. Using local history-based fallback.');
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
