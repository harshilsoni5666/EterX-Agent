import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { getMainAgentModelConfig, normalizeMainAgentMode } from '../../../../lib/agent/model-routing';

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

export async function POST(req: NextRequest) {
  try {
    const { history, currentTitle, mode } = await req.json();
    const safeHistory = Array.isArray(history) ? history : [];
    const latestUserText = getLatestUserText(safeHistory);
    const safeMode = normalizeMainAgentMode(mode);
    const modelConfig = getMainAgentModelConfig(safeMode);

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

    if (modelConfig.provider === 'mistral') {
      const apiKey = process.env.MISTRAL_API_KEY || process.env.MISTRAL_AI_API_KEY || process.env.MISTRALAI_API_KEY || '';
      if (!apiKey) return NextResponse.json({ error: 'Missing MISTRAL_API_KEY' }, { status: 500 });

      const client = new OpenAI({
        apiKey,
        baseURL: process.env.MISTRAL_BASE_URL || process.env.MISTRAL_API_BASE_URL || 'https://api.mistral.ai/v1',
      });
      const result = await client.chat.completions.create({
        model: process.env.MISTRAL_MODEL || process.env.MISTRAL_MODEL_NAME || modelConfig.modelName,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 24,
      });
      const title = cleanTitle(result.choices?.[0]?.message?.content, safeHistory);
      return NextResponse.json({ title });
    }

    // Auto-discover valid Google API key from the environment
    let apiKey = '';
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && value.startsWith('AIza')) {
        apiKey = value;
        break;
      }
    }
    if (!apiKey) apiKey = process.env.GEMINI_API_KEY || '';

    if (!apiKey) {
      return NextResponse.json({ error: 'Missing API Key' }, { status: 500 });
    }

    const genAI = new GoogleGenAI({ apiKey });

    const result = await genAI.models.generateContent({
      model: modelConfig.modelName,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        thinkingConfig: {
          thinkingLevel: 'minimal' as any,
          includeThoughts: false,
        },
      },
    });

    const candidates = result.candidates || [];
    const titleText = candidates[0]?.content?.parts?.find(p => 'text' in p)?.text;
    const title = cleanTitle(titleText, safeHistory);

    return NextResponse.json({ title });
  } catch (error: any) {
    console.error('Title generation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
