import { NextResponse } from 'next/server';
import { nativeProviderAction, isNativeProviderAccountId } from '../../../../lib/agent/native-provider/accounts';
import { NativeProviderSetupError } from '../../../../lib/agent/native-provider/types';
import { isTrustedDesktopSubscriptionRequest } from '../../../../lib/agent/codex-subscription-runtime';
import { isNativeProvider, NATIVE_PROVIDER_ACTIONS, type NativeProviderAction } from '../../../../lib/native-provider-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isTrustedDesktopSubscriptionRequest(request)) return NextResponse.json({ error: 'Desktop authorization is required.' }, { status: 403 });
  try {
    const body = await request.json().catch(() => null);
    if (!body || !NATIVE_PROVIDER_ACTIONS.includes(body.action) ||
      (body.action !== 'watch' && !isNativeProvider(body.provider)) ||
      (body.accountId !== undefined && !isNativeProviderAccountId(body.accountId))) {
      return NextResponse.json({ error: 'Invalid provider request.' }, { status: 400 });
    }
    const action: NativeProviderAction = body.action;
    const value = (key: string, size: number) => typeof body[key] === 'string' ? body[key].slice(0, size) : undefined;
    const apiKey = action === 'sign-in' && body.provider === 'cursor' ? value('apiKey', 4096)?.trim() : undefined;
    if (apiKey && /[\s\x00-\x1f\x7f]/.test(apiKey)) return NextResponse.json({ error: 'Enter a valid Cursor API key.' }, { status: 400 });
    const snapshot = await nativeProviderAction({ action, provider: body.provider, accountId: body.accountId,
      label: value('label', 80), apiKey, binaryPath: value('binaryPath', 1024), revision: value('revision', 96) }, request.signal);
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof NativeProviderSetupError ? error.message : 'Could not update the provider connection.',
    }, { status: error instanceof NativeProviderSetupError ? 409 : 500 });
  }
}
