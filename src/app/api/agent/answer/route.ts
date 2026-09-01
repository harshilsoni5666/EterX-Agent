import { NextRequest, NextResponse } from 'next/server';
import { formatUnknownError } from '../../../../lib/agent/error-format';
import {
  attachAgentApiSessionCookie,
  cleanContextText,
  cleanString,
  ensureChatOwner,
  getOrCreateAgentApiSession,
  isSafeResponseKey,
  jsonError,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const { responseKey, answer, answers, selectedOption } = await readJsonObject(req);

    if (!isSafeResponseKey(responseKey) || (answer === undefined && !Array.isArray(answers))) {
      return attachAgentApiSessionCookie(
        jsonError('Valid responseKey and answer are required', 400),
        session,
      );
    }

    const cleanAnswers = Array.isArray(answers)
      ? answers.slice(0, 20).map((item: any) => ({
          id: cleanString(item?.id, 80),
          question: cleanString(item?.question, 500),
          mode: cleanString(item?.mode, 40),
          answer: cleanContextText(item?.answer).trim(),
          selectedOption: item?.selectedOption ?? null,
        }))
      : null;
    const cleanAnswer = cleanContextText(
      answer === undefined && cleanAnswers?.length
        ? cleanAnswers.map(item => item.answer || item.selectedOption?.value || item.selectedOption?.label || '').filter(Boolean).join('\n')
        : answer,
    ).trim();
    if (!cleanAnswer) {
      return attachAgentApiSessionCookie(jsonError('Answer must be a non-empty string.', 400), session);
    }

    const pending = (globalThis as any).__pendingAskUser;
    if (!pending || !pending[responseKey]) {
      return attachAgentApiSessionCookie(
        jsonError('No pending question found for this key. It may have timed out.', 404),
        session,
      );
    }

    const pendingRecord = pending[responseKey];
    if (pendingRecord.sessionId && pendingRecord.sessionId !== session.sessionId) {
      return attachAgentApiSessionCookie(jsonError('This browser session cannot answer that question.', 403), session);
    }
    if (pendingRecord.chatId) {
      const ownerError = requireChatOwner(pendingRecord.chatId, session.sessionId);
      if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
    }

    pendingRecord.status = 'answered';
    pendingRecord.answer = cleanAnswer;
    pendingRecord.answers = cleanAnswers;
    pendingRecord.selectedOption = selectedOption ?? null;
    pendingRecord.answeredAt = Date.now();

    console.log(`[API: ask_user] User answered question "${pendingRecord.question?.substring(0, 50)}": "${cleanAnswer.substring(0, 120)}"`);

    return attachAgentApiSessionCookie(NextResponse.json({ success: true }), session);
  } catch (error: any) {
    console.error('[API: ask_user] Error:', error);
    const response = NextResponse.json(
      { error: 'Failed to process answer', details: formatUnknownError(error, 'Failed to process answer') },
      { status: 500 },
    );
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}

export async function GET(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    session = getOrCreateAgentApiSession(req);
    const pending = (globalThis as any).__pendingAskUser || {};
    const pendingQuestions = Object.entries(pending)
      .filter(([_, value]: [string, any]) => {
        if (value.status !== 'pending') return false;
        if (value.sessionId) return value.sessionId === session!.sessionId;
        if (value.chatId) return ensureChatOwner(value.chatId, session!.sessionId);
        return false;
      })
      .map(([key, value]: [string, any]) => ({
        responseKey: key,
        question: value.question,
        mode: value.mode,
        options: value.options,
        questions: value.questions,
        context: value.context,
        defaultValue: value.defaultValue,
        urgent: value.urgent,
        createdAt: value.createdAt,
      }));

    return attachAgentApiSessionCookie(NextResponse.json({ pending: pendingQuestions }), session);
  } catch (error: any) {
    const response = NextResponse.json({
      pending: [],
      error: formatUnknownError(error, 'Failed to load pending questions'),
    });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
