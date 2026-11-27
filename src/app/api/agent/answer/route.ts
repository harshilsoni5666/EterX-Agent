import { NextRequest, NextResponse } from 'next/server';
import { getPendingAskUser } from '../../../../lib/agent/tools/core/ask_user';
import { formatAskUserAnswers, getAskUserFields, type AskUserAnswer, type AskUserField } from '../../../../lib/ask-user';
import { formatUnknownError } from '../../../../lib/agent/error-format';
import {
  attachAgentApiSessionCookie,
  cleanContextText,
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

function readAnswer(field: AskUserField, item: any): AskUserAnswer {
  const text = cleanContextText(item?.answer).trim();
  const selection: unknown = item?.selectedOption;
  const selected: unknown[] = Array.isArray(selection) ? selection : [selection];
  const options = new Map(field.options.map(option => [option.value, option]));
  const selectedValues = selected.map(option => {
    if (option === null || typeof option !== 'object') return option;
    const { value, label } = option as { value?: unknown; label?: unknown };
    return value ?? label ?? option;
  });
  const selectedOptions = [...new Set(selectedValues)]
    .flatMap(value => typeof value === 'string' && options.has(value) ? [options.get(value)!] : []);
  const result: AskUserAnswer = { id: field.id, question: field.question, mode: field.mode, answer: text, selectedOption: null };
  switch (field.mode) {
    case 'confirm':
      result.answer = /^(yes|y|approve|approved|confirm|confirmed|allow|proceed|ok|true|send)$/i.test(text) ? 'Yes'
        : /^(no|n|decline|declined|deny|cancel|false)$/i.test(text) ? 'No' : '';
      break;
    case 'choice':
      if (selectedOptions.length === 1) {
        result.answer = selectedOptions[0].label;
        result.selectedOption = selectedOptions[0];
      }
      break;
    case 'multi_select':
    case 'rank':
      if (selectedOptions.length) {
        const complete = field.mode === 'multi_select' || selectedOptions.length === field.options.length;
        result.answer = complete ? selectedOptions.map(option => option.label).join(field.mode === 'rank' ? ' → ' : ', ') : '';
        result.selectedOption = complete ? selectedOptions : null;
      }
      break;
  }
  return result;
}

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const session = getOrCreateAgentApiSession(req);
  const respond = (response: NextResponse) => attachAgentApiSessionCookie(response, session);
  try {
    const { responseKey, answer, answers, selectedOption, dismiss } = await readJsonObject(req);
    if (!isSafeResponseKey(responseKey)) return respond(jsonError('A valid question key is required.', 400));

    const pending = getPendingAskUser();
    const record = Object.hasOwn(pending, responseKey) ? pending[responseKey] : undefined;
    if (!record) return respond(jsonError('This question is no longer open.', 404));
    if (record.sessionId && record.sessionId !== session.sessionId) {
      return respond(jsonError('This browser session cannot answer that question.', 403));
    }
    if (record.chatId) {
      const ownerError = requireChatOwner(record.chatId, session.sessionId);
      if (ownerError) return respond(ownerError);
    }

    const status = dismiss === true ? 'dismissed' : 'answered';
    let cleanAnswer: string | null = null;
    let cleanAnswers: AskUserAnswer[] | null = null;
    let cleanSelection: AskUserAnswer['selectedOption'] = null;
    if (status === 'answered') {
      const fields = getAskUserFields(record);
      if (Array.isArray(answers)) {
        const byId = new Map(answers.map(item => [item?.id, item]));
        cleanAnswers = fields.map(field => readAnswer(field, byId.get(field.id)));
        const missing = fields.find((field, index) => field.required && !cleanAnswers![index].answer);
        if (missing) return respond(jsonError('Complete the required questions before sending your reply.', 400));
        if (cleanAnswers.some(item => item.answer)) cleanAnswer = formatAskUserAnswers(cleanAnswers);
        if (cleanAnswers.length === 1) cleanSelection = cleanAnswers[0].selectedOption;
      } else if (fields.length === 1) {
        const result = readAnswer(fields[0], { answer, selectedOption });
        cleanAnswer = result.answer;
        cleanSelection = result.selectedOption;
      } else {
        // Older integrations can supply the whole reply as a single string.
        cleanAnswer = cleanContextText(answer).trim();
      }
      if (!cleanAnswer) return respond(jsonError('Enter a valid answer before submitting.', 400));
    }

    if (record.status !== 'pending') {
      if (record.status === status && record.answer === cleanAnswer &&
          JSON.stringify(record.answers) === JSON.stringify(cleanAnswers) &&
          JSON.stringify(record.selectedOption) === JSON.stringify(cleanSelection)) {
        return respond(NextResponse.json({ success: true, alreadyAccepted: true, answer: record.answer }));
      }
      return respond(jsonError('This question has already been resolved.', 409));
    }

    record.status = status;
    record.answer = cleanAnswer;
    record.answers = cleanAnswers;
    record.selectedOption = cleanSelection;
    record.answeredAt = Date.now();
    record.notify?.();
    return respond(NextResponse.json({ success: true, answer: cleanAnswer }));
  } catch (error: unknown) {
    const message = formatUnknownError(error, 'Failed to process answer');
    return respond(jsonError(message, 500));
  }
}

export async function GET(req: NextRequest) {
  const session = getOrCreateAgentApiSession(req);
  const pending = Object.entries(getPendingAskUser())
    .filter(([, record]) => record.status === 'pending' && (record.sessionId
      ? record.sessionId === session.sessionId
      : record.chatId && ensureChatOwner(record.chatId, session.sessionId)))
    .map(([responseKey, { question, mode, options, questions, context, defaultValue, placeholder, required, urgent, behavior, createdAt }]) => ({
      responseKey, question, mode, options, questions, context, defaultValue, placeholder, required, urgent, behavior, createdAt,
    }));
  return attachAgentApiSessionCookie(NextResponse.json({ pending }), session);
}
