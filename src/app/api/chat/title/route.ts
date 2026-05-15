import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { getMainAgentModelConfig, normalizeMainAgentMode } from '../../../../lib/agent/model-routing';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { history, currentTitle, mode } = await req.json();
    const safeMode = normalizeMainAgentMode(mode);
    const modelConfig = getMainAgentModelConfig(safeMode);

    const prompt = `
      Analyze the chat history below and generate a short, professional, and catchy title representing the CURRENT conversation goal.

      STRICT RULES:
      1. Length: Exactly 2 to 4 words. 
      2. FORMAT: DO NOT use single words. Titles must be multi-word.
      3. SMART UPDATE: If the current title is "New chat", ALWAYS replace it with something specific. 
         Otherwise, if the current title "${ currentTitle }" still accurately reflects the main agenda, return "${ currentTitle }" exactly.
      4. Only return the title string. No punctuation at the end. No markdown.

      CHAT HISTORY:
      ${ JSON.stringify(history.slice(-10)) }
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
      const titleText = String(result.choices?.[0]?.message?.content || 'New chat');
      const title = titleText.trim().replace(/^["']|["']$/g, '').replace(/[.!?]$/, '');
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
    const titleText = candidates[0]?.content?.parts?.find(p => 'text' in p)?.text || "New chat";
    const title = titleText.trim().replace(/^["']|["']$/g, '').replace(/[.!?]$/, '');

    return NextResponse.json({ title });
  } catch (error: any) {
    console.error('Title generation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
