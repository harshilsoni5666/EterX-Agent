import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../agent/_shared';
import { GitError, mutateRepository, readGitView } from '@/lib/git/server';
import type { GitMutation } from '@/lib/git/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : 'Git could not complete this action.' }, {
    status: error instanceof GitError ? error.status : 500, headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try {
    const query = request.nextUrl.searchParams;
    return NextResponse.json(await readGitView(query.get('root'), query.get('view') || 'status', query), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  if (!request.headers.get('content-type')?.includes('application/json')) return NextResponse.json({ error: 'Expected a JSON request.' }, { status: 415 });
  try {
    const text = await request.text();
    if (text.length > 100_000) throw new GitError('This Git request is too large.', 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new GitError('Invalid JSON request.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GitError('Invalid Git action.');
    return NextResponse.json(await mutateRepository(body as GitMutation), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
