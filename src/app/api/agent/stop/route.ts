import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { taskStore } from '../../../../lib/agent/task-store';
import { cancelAllSubAgents, cancelAgent } from '../../../../lib/agent/roles/sub_agent';
import { formatUnknownError } from '../../../../lib/agent/error-format';
import { isTerminalWorkTrace } from '../../../../lib/chat-feed-lifecycle';
import { stopAllTerminalTasks } from '../../../../lib/agent/tools/core/terminal_background';
import {
  attachAgentApiSessionCookie,
  getOrCreateAgentApiSession,
  isSafeChatId,
  jsonError,
  cleanString,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/agent/stop — Stop agent for a specific chat (or all).
 * 
 * Per-chat stop: { chatId: "xxx" } → only stops that chat's agent
 * Emergency stop: { all: true, confirm: "STOP_ALL_AGENTS" } → stops ALL agents
 * 
 * This is the key independence feature: stopping Chat A doesn't kill Chat B.
 */
export async function POST(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const body = await readJsonObject(req);
    const { chatId } = body;
    const expectedRunId = body.runId === undefined ? undefined : cleanString(body.runId, 160);
    const requestedAtValue = Number(body.requestedAt);
    const requestedAt = Number.isSafeInteger(requestedAtValue) && requestedAtValue > 0
      ? requestedAtValue
      : Number.POSITIVE_INFINITY;

    if (chatId !== undefined && chatId !== null && chatId !== '') {
      if (!isSafeChatId(chatId)) {
        return attachAgentApiSessionCookie(jsonError('Valid chatId is required.', 400), session);
      }
      const ownerError = requireChatOwner(chatId, session.sessionId);
      if (ownerError) {
        return attachAgentApiSessionCookie(ownerError, session);
      }
      if (body.runId !== undefined && !expectedRunId) {
        return attachAgentApiSessionCookie(jsonError('runId must be a valid string when provided.', 400), session);
      }
      const beforeStop = agentRegistry.getTraces(chatId, -1);
      if (expectedRunId && beforeStop.runId && beforeStop.runId !== expectedRunId) {
        return attachAgentApiSessionCookie(jsonError(
          'The active run changed before the stop request was applied.',
          409,
          { success: false, status: 'run_changed', chatId, runId: beforeStop.runId },
        ), session);
      }
      // Per-chat stop
      const stopped = agentRegistry.stopAgent(
        chatId,
        'Stopped by user.',
        undefined,
        expectedRunId,
        requestedAt,
      );
      if (stopped && beforeStop.status === 'running') cancelAgent(chatId);
      const afterStop = agentRegistry.getTraces(chatId, -1);
      const success = stopped || afterStop.status !== 'running';
      console.log(`[API] 🛑 Stop requested for chat ${chatId.substring(0, 8)}... — ${stopped ? 'stopped' : 'not running'}`);
      return attachAgentApiSessionCookie(NextResponse.json({
        success,
        chatId,
        runId: afterStop.runId,
        status: beforeStop.status === 'completed' ? 'already_completed' : stopped ? 'stopping' : 'already_stopped',
        message: beforeStop.status === 'completed' ? 'Agent already completed' : stopped ? 'Agent stopped' : 'Agent was already stopped',
        // Return the actual terminal outcome, not another client-generated
        // stop. Completion may have won the race before cancellation arrived.
        ...(['stopped', 'completed', 'failed'].includes(afterStop.status) ? {
          terminalState: {
            status: afterStop.status,
            runId: afterStop.runId,
            terminalTurnId: afterStop.terminalTurnId,
            completedAt: afterStop.completedAt,
            finalAnswer: afterStop.finalAnswer,
            error: afterStop.error,
            // Include the answer snapshot as well as lifecycle markers. Stop
            // can beat the poll carrying the last tokens to the renderer.
            traces: afterStop.traces.filter(trace =>
              (isTerminalWorkTrace(trace) || trace.type === 'answer' &&
                !trace.subAgent && !trace.subAgentId && !trace.subAgentChatId &&
                !trace.isSubAgent && !trace.auxiliaryRuntime) &&
              (!afterStop.terminalTurnId || trace.turnId === afterStop.terminalTurnId)),
          },
        } : {}),
      }), session);
    }

    if (body.all !== true || body.confirm !== 'STOP_ALL_AGENTS') {
      return attachAgentApiSessionCookie(jsonError('Global stop requires all=true and confirm="STOP_ALL_AGENTS".', 400), session);
    }

    if (body.desktopResume === true) {
      agentRegistry.resumeDesktopRuns();
      return attachAgentApiSessionCookie(NextResponse.json({ success: true }), session);
    }

    if (body.desktopClose === true) {
      const chatIds = agentRegistry.stopForDesktopClose({
        keepScheduled: body.keepScheduled === true,
        keepChannels: body.keepChannels === true,
      });
      if (body.stopTerminals === true) await stopAllTerminalTasks();
      // Complete authoritative task persistence before Electron terminates
      // the server. A renderer ACK alone cannot flush server-side traces.
      await taskStore.flushPendingWrites(chatIds);
      return attachAgentApiSessionCookie(NextResponse.json({ success: true, chatIds }), session);
    }

    // Emergency global stop
    agentRegistry.stopAll();
    cancelAllSubAgents();
    await stopAllTerminalTasks();
    await taskStore.flushPendingWrites();
    console.log('[API] 🛑 EMERGENCY STOP — all agents cancelled');
    return attachAgentApiSessionCookie(NextResponse.json({ success: true, message: 'All agents stopping' }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: formatUnknownError(error, 'Failed to stop agent') }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
