import { NextResponse } from 'next/server';
import { browserEngine } from '../../../../lib/agent/browser/engine';
import { nativeCurrentBrowser } from '../../../../lib/agent/browser/native-current-browser';
import { isUnsafeHostControlEnabled } from '../../../../lib/agent/computer/computer-session';
import { platformScreenProvider } from '../../../../lib/agent/computer/platform-screen';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function snapshot() {
  const native = nativeCurrentBrowser.connected;
  const signedReadiness = native || (browserEngine.connected && browserEngine.mode === 'cdp')
    ? { available: true, reason: 'Signed browser control is connected.' }
    : await browserEngine.getSignedBrowserReadiness();
  return {
    platform: process.platform,
    browser: native ? nativeCurrentBrowser.info : browserEngine.connectionInfo,
    signedBrowser: native,
    signedBrowserAvailable: signedReadiness.available,
    signedBrowserReason: signedReadiness.reason,
    managedBrowser: browserEngine.connected && browserEngine.mode === 'managed',
    computer: {
      hostControlEnabled: isUnsafeHostControlEnabled(),
      screenProvider: platformScreenProvider(),
      note: process.platform === 'win32'
        ? 'Windows isolated computer backend available.'
        : 'Cross-platform screen capture available; full isolated desktop control requires a platform backend.'
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
      const page = await browserEngine.launch({ mode: 'cdp', headless: false });
      return NextResponse.json({ success: true, message: 'Signed-in browser connected.', url: page?.url?.() || '', ...(await snapshot()) });
    }

    if (action === 'launch_managed') {
      const page = await browserEngine.launch({ mode: 'managed', headless: false });
      return NextResponse.json({ success: true, message: 'Managed browser started.', url: page?.url?.() || '', ...(await snapshot()) });
    }

    return NextResponse.json({ success: false, error: `Unknown browser action: ${action}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 700),
      ...(await snapshot()),
    }, { status: 409 });
  }
}
