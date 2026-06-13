import { NextRequest } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { apiKeyPool } from '../../../../lib/agent/api-key-pool';
import { buildAgentBuilderStandaloneSystemInstruction } from '../../../../lib/agent/builder-agent';
import { resolveModelName } from '../../../../lib/agent/model-routing';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
import { cleanString, isSafeAgentId, jsonError, normalizeRunnerMessages, readJsonObject, rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import fs from 'fs';
import path from 'path';

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
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const { messages, agentId = 'standalone-builder', apiKeys = null, modelOverrides = null } = await readJsonObject(req);
    const safeAgentId = cleanString(agentId, 96) || 'standalone-builder';
    if (!isSafeAgentId(safeAgentId)) {
      return jsonError('A valid agentId is required.', 400);
    }

    const normalized = normalizeRunnerMessages(messages);
    if (normalized.error || !normalized.messages) {
      return jsonError(normalized.error || 'Messages array is required.', 400);
    }

    const runtimeSettings = buildScopedRuntimeSettings(apiKeys, modelOverrides);

    // Use our global API key pool to perfectly load balance without hitting 429s!
    apiKeyPool.initialize();
    const sessionId = `builder-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const scopedGeminiKeys = runtimeSettings.apiKeys.gemini || [];
    let lease = runtimeSettings.preferredGeminiApiKey
      ? apiKeyPool.leaseSpecificKey(sessionId, runtimeSettings.preferredGeminiApiKey, 'main_agent')
      : null;
    if (!lease) {
      for (const key of scopedGeminiKeys) {
        lease = apiKeyPool.leaseSpecificKey(sessionId, key, 'main_agent');
        if (lease) break;
      }
    }
    if (!lease) {
      lease = apiKeyPool.leaseKey(sessionId, 'main_agent');
    }
    
    if (!lease) {
      return new Response(JSON.stringify({ error: 'No API keys available right now.' }), { status: 503 });
    }

    const initialLease = lease;
    const ai = new GoogleGenAI({ apiKey: initialLease.apiKey });
    
    // Format messages for Gemini SDK
    const formattedMessages = normalized.messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    // We stream the response back using Next.js Response stream
    const encoder = new TextEncoder();
    
    const stream = new ReadableStream({
      async start(controller) {
        let currentSessionId = sessionId;
        let currentLease = initialLease;
        let aiInstance = ai;
        let responseStream;
        let closed = false;
        const abort = () => {
          closed = true;
          apiKeyPool.releaseKey(currentSessionId);
          try { controller.close(); } catch { }
        };
        req.signal.addEventListener('abort', abort);

        try {
          // Auto-retry loop to automatically switch AI keys on 503 errors
          let retries = 0;
          while (retries < 3) {
            try {
              responseStream = await aiInstance.models.generateContentStream({
                model: resolveModelName('think', runtimeSettings),
                contents: formattedMessages,
                config: {
                  systemInstruction: buildAgentBuilderStandaloneSystemInstruction(safeAgentId) + getAvailableSkills(),
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
              let newLease: typeof currentLease | null = null;
              for (const key of scopedGeminiKeys) {
                newLease = apiKeyPool.leaseSpecificKey(currentSessionId, key, 'main_agent');
                if (newLease) break;
              }
              if (!newLease) newLease = apiKeyPool.leaseKey(currentSessionId, 'main_agent');
              if (!newLease) throw new Error('No keys for retry');
              currentLease = newLease;
              aiInstance = new GoogleGenAI({ apiKey: currentLease.apiKey });
            }
          }

          if (responseStream) {
            let lastUsageMetadata: any = null;
            for await (const chunk of responseStream) {
              if (closed || req.signal.aborted) break;
              if (chunk.usageMetadata) {
                lastUsageMetadata = chunk.usageMetadata;
              }
              if (chunk.text) {
                controller.enqueue(encoder.encode(chunk.text));
              }
            }
            if (lastUsageMetadata) {
              const promptTokens = lastUsageMetadata.promptTokenCount ?? lastUsageMetadata.inputTokenCount ?? 0;
              const completionTokens = lastUsageMetadata.candidatesTokenCount ?? lastUsageMetadata.outputTokenCount ?? 0;
              const totalTokens = lastUsageMetadata.totalTokenCount ?? (promptTokens + completionTokens);
              console.log(`[AgentBuilder] 📊 Token Usage: Input: ${promptTokens} | Output: ${completionTokens} | Total: ${totalTokens}`);
            }
          }
          
          if (!closed) apiKeyPool.reportSuccess(currentSessionId);
          apiKeyPool.releaseKey(currentSessionId);
          if (!closed) controller.close();
        } catch (error: any) {
          console.error('[AgentBuilder] Stream error:', error);
          // Removed reportFailure to avoid cooldown penalties on transient issues
          apiKeyPool.releaseKey(currentSessionId);
          if (!closed) {
            controller.enqueue(encoder.encode(`\nAgent Builder failed: ${String(error.message || error).slice(0, 300)}`));
            controller.close();
          }
        } finally {
          req.signal.removeEventListener('abort', abort);
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
