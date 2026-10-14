import { NextRequest, NextResponse } from 'next/server';
import {
  AGENT_SESSION_COOKIE,
  isSafeAgentSessionId,
  serializeAgentSessionCookie,
} from './lib/agent-api-session-cookie';

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (!isSafeAgentSessionId(request.cookies.get(AGENT_SESSION_COOKIE)?.value)) {
    // The browser stores document response cookies before running the app.
    // Parallel start/poll/discovery requests therefore share one owner from
    // their very first request instead of each minting a competing session.
    response.headers.append('Set-Cookie', serializeAgentSessionCookie(
      crypto.randomUUID(), request.nextUrl.protocol === 'https:',
    ));
    response.headers.set('Cache-Control', 'no-store');
  }
  return response;
}

export const config = {
  matcher: ['/', '/settings/:path*', '/live-overlay'],
};
