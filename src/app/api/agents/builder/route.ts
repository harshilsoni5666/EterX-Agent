import { NextRequest } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { apiKeyPool } from '../../../../lib/agent/api-key-pool';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import fs from 'fs';
import path from 'path';

const BASE_BUILDER_SYSTEM_PROMPT = `You are the EterX Agent Builder Core. 
You configure, fine-tune, and set up new autonomous agent personas based on the user's requirements.

CRITICAL COMMUNICATION RULES:
1. EXTREME BREVITY: Keep it punchy and direct. Never write paragraphs.
2. POINT-TO-POINT: Always format your ideas, suggestions, and answers as short, crisp bullet points.
3. NO FLUFF: Do not use polite filler, preambles, or intros. Just answer the question directly.
4. BRAINSTORM SHARPLY: You can give ideas and architect agents, but present them strictly as concise bullets.
5. You do NOT have tools. You ONLY configure other agents by chatting with the user.

UI AND ALL-PURPOSE TRAINING:
- Always prioritize modern, premium, and beautiful UI/UX designs when suggesting frontend configurations.
- Be highly versatile (all-purpose) in your architecture recommendations, covering a wide range of use cases from web apps to automation tools.
- Suggest rich aesthetics, modern typography, smooth gradients, and interactive micro-animations.
- Utilize the available inner skills listed below to properly equip agents with the right capabilities.`;

function getAvailableSkills() {
  try {
    const skillsPath = path.join(process.cwd(), 'src', 'lib', 'agent', 'skills');
    if (!fs.existsSync(skillsPath)) return '\n\nNo skills available at the moment.';
    
    const entries = fs.readdirSync(skillsPath, { withFileTypes: true });
    
    const skillNames: string[] = [];
    for (const dirent of entries) {
      if (dirent.isDirectory()) {
        skillNames.push(dirent.name);
      } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
        skillNames.push(dirent.name.replace('.md', ''));
      }
    }
      
    if (skillNames.length === 0) return '\n\nNo skills available at the moment.';

    let skillsContext = '\n\nAVAILABLE SKILLS:\n';
    skillsContext += 'The following skills are available in the system and can be attached to new agents:\n';
    skillNames.forEach(skill => {
      skillsContext += `- ${skill}\n`;
    });
    return skillsContext;
  } catch (error) {
    console.error('[AgentBuilder] Error reading skills:', error);
    return '\n\nError loading skills.';
  }
}

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'Messages array is required' }), { status: 400 });
    }

    // Use our global API key pool to perfectly load balance without hitting 429s!
    apiKeyPool.initialize();
    const sessionId = `builder-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const lease = apiKeyPool.leaseKey(sessionId, 'main_agent');
    
    if (!lease) {
      return new Response(JSON.stringify({ error: 'No API keys available right now.' }), { status: 503 });
    }

    const ai = new GoogleGenAI({ apiKey: lease.apiKey });
    
    // Format messages for Gemini SDK
    const formattedMessages = messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    // We stream the response back using Next.js Response stream
    const encoder = new TextEncoder();
    
    const stream = new ReadableStream({
      async start(controller) {
        let currentSessionId = sessionId;
        let currentLease = lease;
        let aiInstance = ai;
        let responseStream;

        try {
          // Auto-retry loop to automatically switch AI keys on 503 errors
          let retries = 0;
          while (retries < 3) {
            try {
              responseStream = await aiInstance.models.generateContentStream({
                model: 'gemini-2.5-flash',
                contents: formattedMessages,
                config: {
                  systemInstruction: BASE_BUILDER_SYSTEM_PROMPT + getAvailableSkills(),
                  temperature: 0.7,
                }
              });
              break; // Success!
            } catch (err: any) {
              retries++;
              console.warn(`[AgentBuilder] Stream start failed, retrying (${retries}/3)...`, err.message);
              apiKeyPool.releaseKey(currentSessionId);
              
              if (retries >= 3) throw err;
              
              // Auto key change
              currentSessionId = `${sessionId}-retry${retries}`;
              const newLease = apiKeyPool.leaseKey(currentSessionId, 'main_agent');
              if (!newLease) throw new Error('No keys for retry');
              currentLease = newLease;
              aiInstance = new GoogleGenAI({ apiKey: currentLease.apiKey });
            }
          }

          if (responseStream) {
            for await (const chunk of responseStream) {
              if (chunk.text) {
                controller.enqueue(encoder.encode(chunk.text));
              }
            }
          }
          
          apiKeyPool.reportSuccess(currentSessionId);
          apiKeyPool.releaseKey(currentSessionId);
          controller.close();
        } catch (error: any) {
          console.error('[AgentBuilder] Stream error:', error);
          // Removed reportFailure to avoid cooldown penalties on transient issues
          apiKeyPool.releaseKey(currentSessionId);
          // Silently fail the stream so the UI doesn't get flooded with error text
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });

  } catch (error: any) {
    console.error('[AgentBuilder] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
