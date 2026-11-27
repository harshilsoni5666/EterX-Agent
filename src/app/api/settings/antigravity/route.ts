import { NextRequest, NextResponse } from 'next/server';
import { antigravityAction } from '../../../../lib/agent/antigravity/provider';
import { isAntigravityAccountId } from '../../../../lib/agent/antigravity/profiles';
import { isTrustedDesktopSubscriptionRequest } from '../../../../lib/agent/codex-subscription-runtime';
import { ANTIGRAVITY_ACTIONS } from '../../../../lib/antigravity-contract';
import { jsonError, readJsonObject } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  if (!isTrustedDesktopSubscriptionRequest(request)) return jsonError('Desktop authorization is required.', 403);
  const { action, accountId, label, code, revision } = await readJsonObject(request);
  if (!ANTIGRAVITY_ACTIONS.includes(action) || (accountId !== undefined && !isAntigravityAccountId(accountId))) return jsonError('Invalid Antigravity connection action.');
  try {
    return NextResponse.json(await antigravityAction({
      action, accountId,
      label: typeof label === 'string' ? label.trim().slice(0, 80) : undefined,
      code: typeof code === 'string' && code.length <= 8192 ? code : undefined,
      revision: typeof revision === 'string' ? revision.slice(0, 96) : undefined,
    }, request.signal), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'The Antigravity connection is unavailable.', 409);
  }
}
