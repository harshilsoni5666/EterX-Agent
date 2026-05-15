import { NextRequest } from 'next/server';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { globalToolRegistry } from '@/lib/agent/tools/registry';
import '@/lib/agent/tools/index';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getCodeAgentSystemPrompt, getToolEnhancements } from '@/lib/code/code-prompts';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

/**
 * Code Chat Route — THE connection between:
 *   1. EterX UI (code-chat.tsx) — sends POST here with SSE streaming
 *   2. Gemini API — LLM calls with tool declarations
 *   3. globalToolRegistry — our 64+ existing tools with execute()
 *   4. code/ folder — system prompt patterns read at runtime
 *
 * Architecture matches code/src/services/api/claude.ts queryModel() 
 * and code/src/query.ts ReAct loop, but adapted for Gemini + our registry.
 */

// Create fresh client per request (matches gemini.ts key rotation pattern)
function createAIClient(): GoogleGenAI {
  // Auto-discover ALL valid Google API keys from environment (same as gemini.ts lines 29-33)
  const keys: string[] = [];
  for (const [, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.startsWith('AIza')) {
      keys.push(value);
    }
  }
  if (keys.length === 0) {
    const fallback = process.env.GEMINI_API_KEY || process.env.VITE_OPENROUTER_API_KEY;
    if (fallback) keys.push(fallback);
  }

  // Pick a random key for load balancing (same as gemini.ts lines 43-46)
  const apiKey = keys[Math.floor(Math.random() * keys.length)] || '';
  console.log(`[CodeChat] Using API key: ${ apiKey.slice(0, 8) }... (${ keys.length } keys found)`);
  return new GoogleGenAI({ apiKey });
}

// ─── System Prompt — powered by full code/ engine knowledge ───
function buildSystemPrompt(workspacePath: string): string {
  const cwd = workspacePath || process.cwd();

  // Get the master coding agent prompt (extracted from 1888 code/ files)
  let prompt = getCodeAgentSystemPrompt(cwd);

  // Append tool enhancements from code/src/tools/*/prompt.ts
  const enhancements = getToolEnhancements();
  const allTools = globalToolRegistry.getAllTools();
  for (const tool of allTools) {
    if (enhancements[tool.name]) {
      prompt += `\n## Tool: ${ tool.name }\n${ enhancements[tool.name] }\n`;
    }
  }

  // Read CLAUDE.md / project config (matches code/src/memdir/)
  for (const fname of ['CLAUDE.md', '.claude/settings.json', 'README.md']) {
    const fpath = path.join(cwd, fname);
    if (fs.existsSync(fpath)) {
      try {
        const content = fs.readFileSync(fpath, 'utf-8');
        prompt += `\n## ${ fname }\n${ content.slice(0, 3000) }\n`;
      } catch { }
    }
  }

  // Git context
  try {
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf-8', timeout: 500 }).trim();
    prompt += `\n# Git Context\n- Branch: ${ branch }\n`;
  } catch { }

  return prompt;
}

// Helper to extract text between two function names in source
function extractBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return '';
  // Extract string literals from the section
  const section = source.slice(startIdx, endIdx);
  const strings: string[] = [];
  const regex = /`([^`]{20,})`/g;
  let match;
  while ((match = regex.exec(section)) !== null) {
    strings.push(match[1].replace(/\$\{[^}]+\}/g, '').replace(/\\n/g, '\n').trim());
  }
  return strings.join('\n');
}

// ─── Build Gemini tool declarations from globalToolRegistry ───
// Cache at module level for Performance
let _cachedToolDeclarations: any[] | null = null;
function buildToolDeclarations() {
  if (_cachedToolDeclarations) return _cachedToolDeclarations;

  const tools = globalToolRegistry.getAllTools();
  // Pick the most important coding tools to avoid hitting token limits
  const codingTools = [
    'workspace_read_file', 'workspace_write_file', 'workspace_edit_file',
    'workspace_list_directory', 'workspace_search_text',
    'workspace_run_command', 'system_shell', 'web_search',
    'workspace_verify_code', 'workspace_codegen', 'workspace_diff',
    'git_operations', 'smart_refactor', 'code_intelligence',
  ];

  const selectedTools = tools.filter(t => codingTools.includes(t.name));
  // If none matched, take first 12
  const finalTools = selectedTools.length > 0 ? selectedTools : tools.slice(0, 12);

  _cachedToolDeclarations = finalTools.map(tool => {
    let params: any = { type: 'object', properties: {}, required: [] };
    try {
      if (tool.inputSchema) {
        const jsonSchema = zodToJsonSchema(tool.inputSchema) as any;
        params = {
          type: 'object',
          properties: jsonSchema.properties || {},
          required: jsonSchema.required || [],
        };
        // Remove unsupported fields
        for (const key of Object.keys(params.properties)) {
          delete params.properties[key]?.['$schema'];
          delete params.properties[key]?.['additionalProperties'];
        }
      }
    } catch { }

    return {
      name: tool.name,
      description: tool.description.slice(0, 200),
      parameters: params,
    };
  });

  return _cachedToolDeclarations;
}

// ─── Execute tool from registry ───
async function executeRegistryTool(toolName: string, args: any, workspacePath: string): Promise<{ success: boolean; output: string }> {
  const tool = globalToolRegistry.getTool(toolName);
  if (!tool) {
    return { success: false, output: `Unknown tool: ${ toolName }` };
  }

  try {
    // Inject workspace path into args for workspace tools
    if (toolName.startsWith('workspace_') && workspacePath) {
      if (args.filename && !path.isAbsolute(args.filename)) {
        args.filename = path.resolve(workspacePath, args.filename);
      }
      if (args.directory && !path.isAbsolute(args.directory)) {
        args.directory = path.resolve(workspacePath, args.directory);
      }
      if (args.file_path && !path.isAbsolute(args.file_path)) {
        args.file_path = path.resolve(workspacePath, args.file_path);
      }
    }
    if (toolName === 'system_shell' && workspacePath) {
      args.cwd = args.cwd || workspacePath;
    }

    const result = await tool.execute(args, { workspacePath });
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { success: true, output: output.slice(0, 30000) };
  } catch (err: any) {
    return { success: false, output: `Tool error: ${ err.message }` };
  }
}

// ─── Main POST handler ───
export async function POST(req: NextRequest) {
  const { prompt, history, workspacePath } = await req.json();

  const systemPrompt = buildSystemPrompt(workspacePath || '');
  const toolDeclarations = buildToolDeclarations();

  // Convert UI history to Gemini format
  const geminiHistory = (history || []).map((m: any) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.parts?.[0]?.text || m.content || '' }],
  }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(data) + '\n\n'));
      };

      try {
        // ReAct loop — matches code/src/query.ts pattern
        let messages = [
          ...geminiHistory,
          { role: 'user', parts: [{ text: prompt }] },
        ];
        let iterations = 0;
        const MAX_ITERATIONS = 500; // Anti-loop from code/src/eterx-bridge.ts
        let accumulatedAnswer = ''; // Accumulate text across iterations

        // Pick exactly ONE API key to use for this entire interaction
        // If we randomize inside the loop, we might hit an invalid key mid-turn!
        const requestAiClient = createAIClient();

        while (iterations < MAX_ITERATIONS) {
          iterations++;

          // Call Gemini with tools
          const response = await requestAiClient.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: messages,
            config: {
              systemInstruction: systemPrompt,
              tools: [{ functionDeclarations: toolDeclarations }],
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.LOW,
                includeThoughts: false,
              },
              maxOutputTokens: 16384,
            },
          });

          const candidate = response.candidates?.[0];
          if (!candidate?.content?.parts) break;

          // Process each part
          let hasToolCalls = false;
          const toolResults: any[] = [];

          for (const part of candidate.content.parts) {
            // Thinking
            if (part.thought && part.text) {
              send({ type: 'trace', data: { type: 'thought_stream', text: part.text } });
            }
            // Text response — accumulate across ReAct iterations
            else if (part.text && !part.thought) {
              accumulatedAnswer += part.text;
              send({ type: 'trace', data: { type: 'answer', text: accumulatedAnswer } });
            }
            // Tool call
            else if (part.functionCall) {
              hasToolCalls = true;
              const fc = part.functionCall;
              send({
                type: 'trace',
                data: {
                  type: 'tool_start',
                  tool: fc.name,
                  args: fc.args,
                  uiActionText: 'Executing ' + fc.name + '...',
                },
              });

              // Execute using our EXISTING registry
              const result = await executeRegistryTool(fc.name!, fc.args || {}, workspacePath || '');

              if (result.success) {
                send({ type: 'trace', data: { type: 'tool_result', tool: fc.name, result: result.output } });
              } else {
                send({ type: 'trace', data: { type: 'tool_error', tool: fc.name, error: result.output } });
              }

              toolResults.push({
                functionResponse: {
                  name: fc.name,
                  response: { result: result.output },
                },
              });
            }
          }

          // If there were tool calls, add model response + tool results and loop
          if (hasToolCalls && toolResults.length > 0) {
            messages.push({ role: 'model', parts: candidate.content.parts });
            messages.push({ role: 'user', parts: toolResults });
            // Continue the ReAct loop
            continue;
          }

          // No tool calls -> done
          break;
        }

        if (iterations >= MAX_ITERATIONS) {
          send({ type: 'trace', data: { type: 'answer', text: '\n\n⚠️ Reached maximum iteration limit. Stopping to prevent infinite loops.' } });
        }
      } catch (err: any) {
        console.error('[CodeChat] Error:', err);
        send({ type: 'trace', data: { type: 'answer', text: 'Error: ' + err.message } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
