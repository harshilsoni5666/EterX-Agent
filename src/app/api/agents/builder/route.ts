import { NextRequest } from 'next/server';
import { AgentOrchestrator } from '../../../../lib/agent/orchestrator';
import type { MainAgentMode } from '../../../../lib/agent/model-routing';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import {
  cleanString,
  isSafeAgentId,
  jsonError,
  normalizeRunnerMessages,
  readJsonObject,
  rejectCrossOrigin,
} from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Standalone Agent Builder endpoint.
 *
 * This intentionally uses the same orchestrated Builder runtime as Builder
 * chats so every configured model provider receives the real Builder tools.
 */
export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const {
      messages,
      agentId = 'standalone-builder',
      model,
      provider,
      selectedModel = null,
    } = await readJsonObject(req);
    const safeAgentId = cleanString(agentId, 96) || 'standalone-builder';
    if (!isSafeAgentId(safeAgentId)) {
      return jsonError('A valid agentId is required.', 400);
    }

    const normalized = normalizeRunnerMessages(messages);
    if (normalized.error || !normalized.messages) {
      return jsonError(normalized.error || 'Messages array is required.', 400);
    }
    const selectedModelName = cleanString(
      selectedModel && typeof selectedModel === 'object'
        ? (selectedModel as any).modelId || (selectedModel as any).modelName
        : model,
      200,
    );
    const requestedProvider = cleanString(
      selectedModel && typeof selectedModel === 'object'
        ? (selectedModel as any).provider
        : provider,
      40,
    ).toLowerCase();
    // Keep the original `{ model: "gemini-*" }` request compatible while
    // requiring an explicit provider for every non-Gemini model.
    const selectedProvider = requestedProvider
      || (/^(?:models\/)?gemini[-_]/i.test(selectedModelName) ? 'gemini' : '');
    if (!isModelProvider(selectedProvider) || !selectedModelName) {
      return jsonError('Select a concrete added model and provider before running the standalone builder.', 400);
    }

    const runtimeSettings = buildScopedRuntimeSettings();
    const orchestrator = new AgentOrchestrator();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const abortController = new AbortController();
        const abortRun = () => {
          closed = true;
          abortController.abort();
        };
        req.signal.addEventListener('abort', abortRun);

        try {
          const allMessages = normalized.messages!;
          let currentUserIndex = -1;
          for (let index = allMessages.length - 1; index >= 0; index -= 1) {
            if (allMessages[index].role === 'user') {
              currentUserIndex = index;
              break;
            }
          }
          if (currentUserIndex < 0) {
            throw new Error('Messages must include a user request.');
          }
          const currentRequest = allMessages[currentUserIndex].content;
          const history = allMessages.slice(0, currentUserIndex).map(message => ({
            role: message.role,
            parts: [{ text: message.content }],
          }));
          const selectedMode: MainAgentMode = selectedProvider === 'gemini'
            ? 'think'
            : selectedProvider;
          const result = await orchestrator.executePipeline(
            'default_user',
            `agent_builder_${safeAgentId}`,
            currentRequest,
            history,
            undefined,
            selectedMode,
            {
              agentRuntime: 'agent_builder',
              agentId: safeAgentId,
              selectedModelName,
              selectedModelProvider: selectedProvider,
              strictModelSelection: true,
              disableSubAgents: true,
              disableMemoryHydration: true,
              persistSession: false,
              disableLongTermMemory: true,
              disableTaskStore: true,
              disableWorkspaceInit: true,
              exportTranscript: false,
              runLocation: 'local',
              abortSignal: abortController.signal,
            },
            [],
            [],
            'Developer',
            runtimeSettings.preferredGeminiApiKey,
            runtimeSettings,
          );
          if (!closed && !req.signal.aborted) {
            controller.enqueue(encoder.encode(String(result.finalAnswer || 'Agent Builder returned no response.')));
          }
        } catch (error: any) {
          if (!closed) {
            controller.enqueue(encoder.encode(`\nAgent Builder failed: ${String(error?.message || error).slice(0, 500)}`));
          }
        } finally {
          req.signal.removeEventListener('abort', abortRun);
          closed = true;
          try { controller.close(); } catch { }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (error: any) {
    console.error('[AgentBuilder] Error:', error);
    return jsonError(error?.message || 'Agent Builder failed.', 500);
  }
}
