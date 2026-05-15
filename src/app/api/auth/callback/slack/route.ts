import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';

const CONNECTORS_FILE = path.resolve(process.cwd(), '.workspaces', '.connectors.json');

/**
 * GET /api/auth/callback/slack
 * Handles Slack OAuth callback — exchanges code for token, saves to disk.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const redirectUri = `${ appUrl }/api/auth/callback/slack`;

  if (error || !code) {
    return NextResponse.redirect(`${ appUrl }?connector_error=slack_denied`);
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
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

    if (!data.ok) {
      console.error('[Slack OAuth] Token exchange failed:', data.error);
      return NextResponse.redirect(`${ appUrl }?connector_error=slack_token`);
    }

    // Save connector data
    await fs.ensureDir(path.dirname(CONNECTORS_FILE));
    let connectors: Record<string, any> = {};
    try {
      if (await fs.pathExists(CONNECTORS_FILE)) {
        connectors = await fs.readJson(CONNECTORS_FILE);
      }
    } catch { }

    // Use User Token (xoxp) if available, fallback to Bot Token
    const token = data.authed_user?.access_token || data.access_token;

    connectors.slack = {
      connected: true,
      accessToken: token,
      botToken: data.access_token,
      teamId: data.team?.id,
      teamName: data.team?.name,
      teamIcon: data.team?.image_68,
      authedUser: data.authed_user?.id,
      scope: data.authed_user?.scope || data.scope,
      connectedAt: Date.now(),
    };

    await fs.writeJson(CONNECTORS_FILE, connectors, { spaces: 2 });
    console.log(`[Slack OAuth] ✅ Connected workspace: ${ data.team?.name }`);

    // Return a simple success page instead of redirecting to the app
    return new NextResponse(
      `<html>
        <body style="background: #0A0A0A; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0;">
          <div style="background: #161616; padding: 40px; border-radius: 24px; border: 1px solid rgba(255,255,255,0.1); text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
            <div style="font-size: 50px; margin-bottom: 20px;">✅</div>
            <h1 style="margin: 0 0 10px 0; font-size: 24px;">Connected Successfully!</h1>
            <p style="color: #8C8A88; margin-bottom: 30px;">You have connected <b>${ data.team?.name || 'Slack' }</b> to EterX.</p>
            <p style="font-size: 14px; color: #555;">You can close this browser tab and return to the app.</p>
            <button onclick="window.close()" style="background: white; color: black; border: none; padding: 12px 24px; border-radius: 12px; font-weight: bold; cursor: pointer;">Close Window</button>
          </div>
        </body>
      </html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  } catch (err: any) {
    console.error('[Slack OAuth] Error:', err.message);
    return NextResponse.redirect(`${ appUrl }?connector_error=slack_unknown`);
  }
}
