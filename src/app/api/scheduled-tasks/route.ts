import { NextRequest, NextResponse } from 'next/server';
import { loadScheduledTaskSnapshot, mutateScheduledTasks, saveScheduledTaskSnapshot } from '../../../lib/scheduled-task-store';
import { normalizeScheduledTask, queueScheduledTaskRunNow, rescheduleTask } from '../../../lib/scheduled-tasks';
import { rejectCrossOrigin } from '../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    return NextResponse.json(await loadScheduledTaskSnapshot(), { headers });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to load scheduled tasks.' }, { status: 500, headers });
  }
}

export async function PATCH(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const body = await req.json().catch(() => null);
  if (typeof body?.id !== 'string' || !body.id || !['reschedule', 'settle', 'restore'].includes(body.action)) {
    return NextResponse.json({ error: 'Choose a valid scheduled task and action.' }, { status: 400, headers });
  }
  const now = Date.now();
  const at = body.at === 'now' ? now : body.at;
  if (body.action === 'reschedule' && (!Number.isFinite(at) || at < now || at > 8640000000000000)) {
    return NextResponse.json({ error: 'Choose a future date and time.' }, { status: 400, headers });
  }

  let status = 500;
  try {
    const snapshot = await mutateScheduledTasks(tasks => {
      const index = tasks.findIndex(task => task.id === body.id);
      if (index < 0) {
        status = 404;
        throw new Error('This scheduled task no longer exists.');
      }
      const task = tasks[index];
      if (task.status === 'running') {
        status = 409;
        throw new Error('This task is already running.');
      }
      if (body.action === 'reschedule' && body.at === 'now') {
        queueScheduledTaskRunNow(task, now);
        return;
      }
      tasks[index] = body.action === 'reschedule'
        ? rescheduleTask(task, at, now)
        : { ...task, focusSettledAt: body.action === 'settle' ? now : null };
    });
    return NextResponse.json(snapshot, { headers });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update the scheduled task.' }, { status, headers });
  }
}

export async function PUT(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json();
    if (!Array.isArray(body?.tasks)) {
      return NextResponse.json({ error: 'tasks must be an array.' }, { status: 400, headers });
    }
    const snapshot = await saveScheduledTaskSnapshot(body.tasks.map(normalizeScheduledTask), Date.now());
    return NextResponse.json({ ok: true, ...snapshot }, { headers });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to save scheduled tasks.' }, { status: 500, headers });
  }
}
