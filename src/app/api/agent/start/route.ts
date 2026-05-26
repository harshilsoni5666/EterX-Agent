import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { normalizeMainAgentMode, normalizeMainAgentThinkingLevel } from '../../../../lib/agent/model-routing';
import {
  buildAgentBuilderPinnedContext,
  buildAgentBuilderUserRequest,
  getAgentBuilderMode,
  getAgentIdFromBuilderChatId,
  isAgentBuilderChatId,
} from '../../../../lib/agent/builder-agent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/agent/start — Fire-and-forget agent launch
 * 
 * Starts an agent for a specific chat. Returns immediately.
 * The agent runs in the background, fully independent of the UI.
 * The UI polls /api/agent/poll to get trace updates.
 * 
 * Body: { chatId, prompt, history, mode, userId, pinnedContext, mediaAttachments, userName }
 * Returns: { status: 'started' | 'already_running' | 'no_keys', chatId, message }
 */
export async function POST(req: NextRequest) {
  try {
    const { 
      chatId, 
      prompt, 
      history = [], 
      mode = 'think', 
      thinkingLevel = 'low',
      userId = 'default_user', 
      pinnedContext = null, 
      mediaAttachments = [], 
      userName = 'Developer' 
    } = await req.json();

    if (!chatId || !prompt) {
      return NextResponse.json(
        { error: 'chatId and prompt are required' }, 
        { status: 400 }
      );
    }

    const safeMode = normalizeMainAgentMode(mode);
    const safeThinkingLevel = normalizeMainAgentThinkingLevel(thinkingLevel);
    const isBuilderChat = isAgentBuilderChatId(chatId);
    const builderAgentId = isBuilderChat ? getAgentIdFromBuilderChatId(chatId) : '';
    const effectivePinnedContext = {
      ...(isBuilderChat ? buildAgentBuilderPinnedContext(chatId, pinnedContext) : (pinnedContext || {})),
      thinkingLevel: safeThinkingLevel,
    };
    const effectivePrompt = isBuilderChat ? buildAgentBuilderUserRequest(builderAgentId, prompt) : prompt;
    const effectiveMode = isBuilderChat ? getAgentBuilderMode(safeMode) : safeMode;

    const result = agentRegistry.startAgent(
      chatId,
      effectivePrompt,
      history,
      effectiveMode,
      userId,
      effectivePinnedContext,
      mediaAttachments,
      userName
    );

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[API: agent/start] Error:', error);
    return NextResponse.json(
      { error: 'Failed to start agent', details: error.message },
      { status: 500 }
    );
  }
}
