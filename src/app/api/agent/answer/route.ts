import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/agent/answer
 * 
 * Receives the user's answer to an ask_user prompt.
 * The agent is polling globalThis.__pendingAskUser for responses.
 */
export async function POST(req: NextRequest) {
  try {
    const { responseKey, answer, selectedOption } = await req.json();

    if (!responseKey || answer === undefined) {
      return NextResponse.json(
        { error: 'responseKey and answer are required' },
        { status: 400 }
      );
    }

    // Store the answer in the global pending store
    const pending = (globalThis as any).__pendingAskUser;
    
    if (!pending || !pending[responseKey]) {
      return NextResponse.json(
        { error: 'No pending question found for this key. It may have timed out.' },
        { status: 404 }
      );
    }

    // Mark as answered
    pending[responseKey].status = 'answered';
    pending[responseKey].answer = answer;
    pending[responseKey].selectedOption = selectedOption || null;
    pending[responseKey].answeredAt = Date.now();

    console.log(`[API: ask_user] ✅ User answered question "${pending[responseKey].question?.substring(0, 50)}": "${answer}"`);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[API: ask_user] Error:', error);
    return NextResponse.json(
      { error: 'Failed to process answer', details: error.message },
      { status: 500 }
    );
  }
}

/**
 * GET /api/agent/answer
 * 
 * Check if there are any pending questions from the agent.
 * The frontend polls this to know when to show the ask_user UI.
 */
export async function GET() {
  try {
    const pending = (globalThis as any).__pendingAskUser || {};
    const pendingQuestions = Object.entries(pending)
      .filter(([_, v]: [string, any]) => v.status === 'pending')
      .map(([key, v]: [string, any]) => ({
        responseKey: key,
        question: v.question,
        mode: v.mode,
        options: v.options,
        context: v.context,
        defaultValue: v.defaultValue,
        urgent: v.urgent,
        createdAt: v.createdAt
      }));

    return NextResponse.json({ pending: pendingQuestions });
  } catch (error: any) {
    return NextResponse.json({ pending: [], error: error.message });
  }
}
