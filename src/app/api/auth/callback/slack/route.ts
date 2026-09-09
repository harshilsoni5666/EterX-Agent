import { NextRequest, NextResponse } from 'next/server';
import { saveConnectorRecord } from '../../../../../lib/connectors/store';
import { requestJson } from '../../../../../lib/request-json';
import { timingSafeEqual } from 'node:crypto';

export const dynamic = 'force-dynamic';

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => (
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[character]
));

/**
 * GET /api/auth/callback/slack
 * Handles Slack OAuth callback — exchanges code for token, saves to disk.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/+$/, '');
  const redirectUri = `${ appUrl }/api/auth/callback/slack`;
  const finish = (response: NextResponse) => {
    response.cookies.set('eterx_slack_oauth_state', '', {
      httpOnly: true, sameSite: 'lax', secure: appUrl.startsWith('https://'),
      path: '/api/auth/callback/slack', maxAge: 0,
    });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  };
  const fail = (reason: string) => finish(NextResponse.redirect(`${appUrl}?connector_error=${reason}`));
  const state = searchParams.get('state') || '';
  const expectedState = req.cookies.get('eterx_slack_oauth_state')?.value || '';
  if (!/^[a-f0-9-]{36}$/i.test(state) || !/^[a-f0-9-]{36}$/i.test(expectedState)
    || !timingSafeEqual(Buffer.from(state, 'utf8'), Buffer.from(expectedState, 'utf8'))) {
    return fail('slack_state');
  }

  if (error || !code) {
    return fail('slack_denied');
  }
  if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) return fail('slack_config');

  try {
    // Exchange code for access token
    const tokenRes = await requestJson('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID!,
        client_secret: process.env.SLACK_CLIENT_SECRET!,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok || !data.ok) {
      console.error('[Slack OAuth] Token exchange failed:', data.error);
      return fail('slack_token');
    }

    // Use User Token (xoxp) if available, fallback to Bot Token
    const token = data.authed_user?.access_token || data.access_token;
    if (typeof token !== 'string' || !token.trim()) return fail('slack_token');

    saveConnectorRecord({
      id: 'slack',
      kind: 'oauth',
      connected: true,
      credentials: { accessToken: token, botToken: data.access_token },
      metadata: {
        teamId: data.team?.id,
        teamName: data.team?.name,
        teamIcon: data.team?.image_68,
        authedUser: data.authed_user?.id,
        scope: data.authed_user?.scope || data.scope,
      },
      connectedAt: Date.now(),
    });
    console.log(`[Slack OAuth] ✅ Connected workspace: ${ data.team?.name }`);

    // Return a simple success page instead of redirecting to the app
    return finish(new NextResponse(
      `<html>
        <body style="background: #0A0A0A; color: white; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0;">
          <div style="background: #161616; padding: 40px; border-radius: 24px; border: 1px solid rgba(255,255,255,0.1); text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
            <div style="font-size: 50px; margin-bottom: 20px;">✅</div>
            <h1 style="margin: 0 0 10px 0; font-size: 24px;">Connected Successfully!</h1>
            <p style="color: #8C8A88; margin-bottom: 30px;">You have connected <b>${ escapeHtml(data.team?.name || 'Slack') }</b> to EterX.</p>
            <p style="font-size: 14px; color: #555;">You can close this browser tab and return to the app.</p>
            <button onclick="window.close()" style="background: white; color: black; border: none; padding: 12px 24px; border-radius: 12px; font-weight: bold; cursor: pointer;">Close Window</button>
          </div>
        </body>
      </html>`,
      { headers: { 'Content-Type': 'text/html' } }
    ));
  } catch (err: any) {
    console.error('[Slack OAuth] Error:', err.message);
    return fail('slack_unknown');
  }
}
