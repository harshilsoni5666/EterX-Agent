import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/auth/slack
 * Initiates the Slack OAuth 2.0 flow — redirects user to Slack's login page.
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.SLACK_CLIENT_ID;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
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
  slackAuthUrl.searchParams.set('state', crypto.randomUUID());

  return NextResponse.redirect(slackAuthUrl.toString());
}
