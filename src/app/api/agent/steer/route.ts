import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { formatUnknownError } from '../../../../lib/agent/error-format';
import { taskStore } from '../../../../lib/agent/task-store';
import { steeringMessageIds } from '../../../../lib/steering-delivery';
import { resolveChatMediaForRequest } from '../../../../lib/chat-media-store';
import {
  attachAgentApiSessionCookie,
  cleanString,
  normalizeMediaAttachments,
  getOrCreateAgentApiSession,
  isSafeChatId,
  jsonError,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/agent/steer
 *
 * Accepts a live steering message while an agent is running.
 * The message is appended to a per-chat queue that is drained by the
 * ReAct loop on the next free iteration — so the agent is never
 * interrupted mid-action; it sees the comment when it naturally becomes
 * ready to decide its next step.
 *
 * Body: { chatId: string; message: string; id?: string }
 * Returns:
 *   { success: true }  — queued successfully
 *   { success: false, reason: string }
 */
export async function POST(req: NextRequest) {
  const desktopAdmissionEpoch = agentRegistry.getDesktopAdmissionEpoch();
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const body = await readJsonObject(req);
    const { chatId, message, id, runId, createdAt } = body as {
      chatId?: string;
      message?: string;
      id?: string;
      runId?: string;
      createdAt?: number;
    };
    const mediaAttachments = normalizeMediaAttachments(body.mediaAttachments);
    const cleanMessage = (typeof message === 'string'
      ? message.replace(/\u0000/g, '').trim()
      : '') || (mediaAttachments.length ? 'Please review the attached files.' : '');
    const cleanId = id === undefined ? undefined : cleanString(id, 120);
    const cleanRunId = runId === undefined ? undefined : cleanString(runId, 160);

    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('Valid chatId is required', 400, { reason: 'Valid chatId is required' }), session);
    }
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) {
      return attachAgentApiSessionCookie(ownerError, session);
    }
    if (!cleanMessage) {
      return attachAgentApiSessionCookie(jsonError('message must be a non-empty string', 400, { reason: 'message must be a non-empty string' }), session);
    }
    if (id !== undefined && !cleanId) {
      return attachAgentApiSessionCookie(jsonError('id must be a valid string when provided', 400, { reason: 'id must be a valid string when provided' }), session);
    }
    if (runId !== undefined && !cleanRunId) {
      return attachAgentApiSessionCookie(jsonError('runId must be a valid string when provided', 400, { reason: 'runId must be a valid string when provided' }), session);
    }

    const closeRejection = () => attachAgentApiSessionCookie(NextResponse.json({
      success: false, accepted: false, status: 'cancelled',
      reason: 'This message was stopped when the app window closed.',
    }, { status: 409 }), session!);
    if (agentRegistry.isDesktopHumanAdmissionBlocked(desktopAdmissionEpoch)) return closeRejection();

    const cancelledReceipt = () => attachAgentApiSessionCookie(NextResponse.json({
      success: false, accepted: false, status: 'cancelled',
      reason: 'This message was removed from the queue.',
    }, { status: 409 }), session!);
    if (cleanId && agentRegistry.hasCancelledFollowUp(chatId, cleanId)) return cancelledReceipt();

    if (cleanId && agentRegistry.hasAcceptedSteering(chatId, cleanId, cleanRunId)) {
      return attachAgentApiSessionCookie(NextResponse.json({ success: true, id: cleanId, alreadyAccepted: true }), session);
    }
    const currentRun = agentRegistry.getTraces(chatId, -1);
    if (cleanId && (currentRun.status !== 'running' || (cleanRunId && cleanRunId !== currentRun.runId))) {
      const saved = await taskStore.getTask(chatId);
      const accepted = saved?.traceLogs?.some((log: any) =>
        ['steering_received', 'steering_applied', 'steering_cancelled', 'user_action'].includes(log?.type) &&
        (!cleanRunId || log.runId === cleanRunId) && steeringMessageIds(log).includes(cleanId));
      if (accepted) {
        return attachAgentApiSessionCookie(NextResponse.json({ success: true, id: cleanId, alreadyAccepted: true }), session);
      }
    }
    if (currentRun.status !== 'running' || !currentRun.runId) {
      return attachAgentApiSessionCookie(jsonError(
        'No running agent found for this chat. The message was not queued.',
        409,
        { accepted: false, reason: 'No running agent found for this chat. The message was not queued.' },
      ), session);
    }

    // Bind even legacy callers that omit runId to the run observed in this
    // request. addSteeringMessage re-checks this identity synchronously, so a
    // finish/restart between the read above and admission cannot redirect the
    // message into a successor run.
    const admissionRunId = cleanRunId || currentRun.runId;
    if (currentRun.runId !== admissionRunId) {
      return attachAgentApiSessionCookie(jsonError(
        'The active run changed before this steering message could be delivered.',
        409,
        { accepted: false, reason: 'The active run changed. The message was not queued.' },
      ), session);
    }

    const requestedCreatedAt = Number(createdAt);
    const resolvedMedia = await resolveChatMediaForRequest(chatId, cleanMessage, mediaAttachments);
    if (agentRegistry.isDesktopHumanAdmissionBlocked(desktopAdmissionEpoch)) return closeRejection();
    if (cleanId && agentRegistry.hasCancelledFollowUp(chatId, cleanId)) return cancelledReceipt();
    const queued = agentRegistry.addSteeringMessage(
      chatId,
      cleanMessage,
      cleanId,
      { attachments: resolvedMedia, ...(Number.isFinite(requestedCreatedAt) && requestedCreatedAt > 0
        ? { createdAt: requestedCreatedAt } : {}) },
      admissionRunId,
    );

    if (!queued) {
      const stillRunning = agentRegistry.isRunning(chatId);
      return attachAgentApiSessionCookie(NextResponse.json(
        {
          success: false,
          accepted: false,
          reason: stillRunning
            ? 'The live steering queue is full. The message was not accepted by this queue.'
            : 'No running agent found for this chat. The message was not queued.',
        },
        { status: stillRunning ? 429 : 409 }
      ), session);
    }

    console.log(`[API/steer] 🧭 Steering queued for chat ${chatId.substring(0, 8)}...`);
    return attachAgentApiSessionCookie(NextResponse.json({ success: true, message: 'Steering message queued' }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: formatUnknownError(error, 'Failed to steer agent') }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
