import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/slack
 * Initiates the Slack OAuth 2.0 flow — redirects user to Slack's login page.
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.SLACK_CLIENT_ID;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/+$/, '');
  const redirectUri = `${appUrl}/api/auth/callback/slack`;

  if (!clientId) {
    return NextResponse.json({ error: 'SLACK_CLIENT_ID not configured' }, { status: 500 });
  }

  const userScopes = [
    'channels:read',
    'channels:history',
    'chat:write',
    'users:read',
    'files:write',
    'reactions:write',
    'im:read',
    'im:write',
    'im:history',
    'groups:read',
    'groups:history'
  ].join(',');

  const slackAuthUrl = new URL('https://slack.com/oauth/v2/authorize');
  slackAuthUrl.searchParams.set('client_id', clientId);
  slackAuthUrl.searchParams.set('user_scope', userScopes);
  slackAuthUrl.searchParams.set('redirect_uri', redirectUri);
  const state = crypto.randomUUID();
  slackAuthUrl.searchParams.set('state', state);

  const response = NextResponse.redirect(slackAuthUrl.toString());
  response.cookies.set('eterx_slack_oauth_state', state, {
    httpOnly: true,
    secure: appUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/api/auth/callback/slack',
    maxAge: 600,
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
