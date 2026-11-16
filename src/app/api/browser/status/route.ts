import { NextRequest, NextResponse } from 'next/server';
import { browserEngine } from '../../../../lib/agent/browser/engine';
import { nativeCurrentBrowser } from '../../../../lib/agent/browser/native-current-browser';
import { disconnectBrowserSession, launchBrowserSession, withBrowserSessionLock } from '../../../../lib/agent/browser/runtime';
import { readStoredRuntimeSettings, updateStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function snapshot() {
  const settings = readStoredRuntimeSettings();
  const native = !browserEngine.connected && nativeCurrentBrowser.connected;
  const signedConnected = native || (browserEngine.connected && browserEngine.mode === 'cdp');
  // Settings polling must stay shallow. Full browser discovery touches the OS
  // process table and can take several seconds on a busy desktop; the signed
  // action itself is the authoritative readiness check.
  const signedReadinessPromise = Promise.resolve(signedConnected
    ? { available: true, reason: 'Signed browser control is connected.' }
    : process.env.ETERX_ALLOW_USER_CHROME === '0'
      ? { available: false, reason: 'Signed-in browser access is disabled on this device. Choose an isolated browser.' }
      : { available: true, reason: 'Signed-in browser will be verified when you connect it.' });
  const signedReadiness = await signedReadinessPromise;
  return {
    platform: process.platform,
    browserAccess: settings.browserAccess !== false,
    preferredMode: settings.browserMode || 'cdp',
    browser: native ? nativeCurrentBrowser.info : browserEngine.connectionInfo,
    signedBrowser: signedConnected,
    signedBrowserAvailable: signedReadiness.available,
    signedBrowserReason: signedReadiness.reason,
    managedBrowser: browserEngine.connected && browserEngine.mode === 'managed',
    remoteBrowser: browserEngine.connected && browserEngine.mode === 'remote',
  };
}

export async function GET(request: NextRequest) {
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  return NextResponse.json({ success: true, ...(await snapshot()) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  try {
    const body = await request.json().catch(() => null);
    const action = body?.action;
    if (!['status', 'disconnect', 'connect_signed', 'launch_managed'].includes(action)) {
      return NextResponse.json({ success: false, error: 'A valid browser action is required.' }, { status: 400 });
    }

    if (action === 'status') {
      return NextResponse.json({ success: true, ...(await snapshot()) }, { headers: { 'Cache-Control': 'no-store' } });
    }

    return await withBrowserSessionLock(async () => {
      request.signal.throwIfAborted();
      if (action === 'disconnect') {
        await disconnectBrowserSession();
        return NextResponse.json({ success: true, message: 'Browser control disconnected.', ...(await snapshot()) }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (readStoredRuntimeSettings().browserAccess === false) {
        return NextResponse.json({ success: false, error: 'Enable browser control in Settings before connecting.', ...(await snapshot()) }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
      }
      const mode = action === 'launch_managed' ? 'managed' : 'cdp';
      await updateStoredRuntimeSettings({ browserMode: mode });
      const session = await launchBrowserSession({ mode, headless: false }, request.signal);
      return NextResponse.json({
        success: true,
        message: mode === 'managed' ? 'Isolated browser connected. Agents will use this mode.' : 'Signed-in browser connected. Agents will use this mode.',
        url: session.nativeResult?.currentUrl || session.page?.url() || '',
        ...(await snapshot()),
      }, { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error: any) {
    const message = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 700);
    return NextResponse.json({
      success: false,
      error: message,
      ...(await snapshot()),
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
}
