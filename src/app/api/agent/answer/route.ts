import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { responseKey, answer, answers, selectedOption } = await req.json();

    if (!responseKey || answer === undefined) {
      return NextResponse.json(
        { error: 'responseKey and answer are required' },
        { status: 400 },
      );
    }

    const pending = (globalThis as any).__pendingAskUser;
    if (!pending || !pending[responseKey]) {
      return NextResponse.json(
        { error: 'No pending question found for this key. It may have timed out.' },
        { status: 404 },
      );
    }

    pending[responseKey].status = 'answered';
    pending[responseKey].answer = answer;
    pending[responseKey].answers = answers ?? null;
    pending[responseKey].selectedOption = selectedOption ?? null;
    pending[responseKey].answeredAt = Date.now();

    console.log(`[API: ask_user] User answered question "${pending[responseKey].question?.substring(0, 50)}": "${answer}"`);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[API: ask_user] Error:', error);
    return NextResponse.json(
      { error: 'Failed to process answer', details: error.message },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const pending = (globalThis as any).__pendingAskUser || {};
    const pendingQuestions = Object.entries(pending)
      .filter(([_, value]: [string, any]) => value.status === 'pending')
      .map(([key, value]: [string, any]) => ({
        responseKey: key,
        question: value.question,
        mode: value.mode,
        options: value.options,
        context: value.context,
        defaultValue: value.defaultValue,
        urgent: value.urgent,
        createdAt: value.createdAt,
      }));

    return NextResponse.json({ pending: pendingQuestions });
  } catch (error: any) {
    return NextResponse.json({ pending: [], error: error.message });
  }
}
