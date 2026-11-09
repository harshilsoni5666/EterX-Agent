import { NextResponse } from 'next/server';
import { browserEngine } from '../../../../lib/agent/browser/engine';
import { nativeCurrentBrowser } from '../../../../lib/agent/browser/native-current-browser';
import { isUnsafeHostControlEnabled } from '../../../../lib/agent/computer/computer-session';
import { cuaDriverProvider, getCuaDriverStatus } from '../../../../lib/agent/computer/cua-driver';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function resolveWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  const guarded = promise.then(value => value).catch(() => fallback);
  return Promise.race([
    guarded,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

async function snapshot() {
  const native = nativeCurrentBrowser.connected;
  const signedConnected = native || (browserEngine.connected && browserEngine.mode === 'cdp');
  // Settings polling must stay shallow. Full browser discovery touches the OS
  // process table and can take several seconds on a busy desktop; the signed
  // action itself is the authoritative readiness check.
  const signedReadinessPromise = Promise.resolve(signedConnected
    ? { available: true, reason: 'Signed browser control is connected.' }
    : { available: true, reason: 'Signed-in browser will be verified when you connect it.' });
  const [signedReadiness, cuaStatus] = await Promise.all([
    signedReadinessPromise,
    resolveWithin(getCuaDriverStatus(), 4500, {
      installed: false,
      version: null,
      daemonRunning: false,
      healthy: false,
      overall: 'checking',
      platform: process.platform,
      message: 'Computer-use driver status is still being checked.',
    }),
  ]);
  return {
    platform: process.platform,
    browser: native ? nativeCurrentBrowser.info : browserEngine.connectionInfo,
    signedBrowser: signedConnected,
    signedBrowserAvailable: signedReadiness.available,
    signedBrowserReason: signedReadiness.reason,
    managedBrowser: browserEngine.connected && browserEngine.mode === 'managed',
    computer: {
      hostControlEnabled: isUnsafeHostControlEnabled(),
      screenProvider: cuaStatus.installed ? cuaDriverProvider() : 'Not configured',
      inputProvider: cuaStatus.installed ? cuaDriverProvider() : 'Not configured',
      cuaDriver: cuaStatus,
      note: process.platform === 'win32'
        ? 'Native desktop control requires Computer Use enabled for the task and a running Cua Driver in the signed-in Windows session.'
        : 'Native window control requires a running Cua Driver. macOS also requires Accessibility and Screen Recording permissions.'
    },
  };
}

export async function GET() {
  return NextResponse.json({ success: true, ...(await snapshot()) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || 'status');

    if (action === 'disconnect') {
      nativeCurrentBrowser.disconnect();
      await browserEngine.disconnect();
      return NextResponse.json({ success: true, message: 'Browser control disconnected.', ...(await snapshot()) });
    }

    if (action === 'connect_signed') {
      if (nativeCurrentBrowser.connected) {
        return NextResponse.json({ success: true, message: 'Signed-in browser control is already connected.', ...(await snapshot()) });
      }
      const page = await browserEngine.launch({ mode: 'cdp', headless: false });
      return NextResponse.json({ success: true, message: 'Signed-in browser connected.', url: page?.url?.() || '', ...(await snapshot()) });
    }

    if (action === 'launch_managed') {
      const page = await browserEngine.launch({ mode: 'managed', headless: false });
      return NextResponse.json({ success: true, message: 'Managed browser started.', url: page?.url?.() || '', ...(await snapshot()) });
    }

    return NextResponse.json({ success: false, error: `Unknown browser action: ${action}` }, { status: 400 });
  } catch (error: any) {
    const message = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 700);
    const native = nativeCurrentBrowser.connected;
    const signedConnected = native || (browserEngine.connected && browserEngine.mode === 'cdp');
    return NextResponse.json({
      success: false,
      error: message,
      platform: process.platform,
      browser: native ? nativeCurrentBrowser.info : browserEngine.connectionInfo,
      signedBrowser: signedConnected,
      signedBrowserAvailable: signedConnected,
      signedBrowserReason: signedConnected ? 'Signed browser control is connected.' : message,
      managedBrowser: browserEngine.connected && browserEngine.mode === 'managed',
      computer: {
        hostControlEnabled: isUnsafeHostControlEnabled(),
        screenProvider: 'Unknown',
        inputProvider: 'Unknown',
        note: 'Refresh desktop status in Settings > Computer. Native desktop control requires a running Cua Driver.'
      },
    }, { status: 409 });
  }
}
