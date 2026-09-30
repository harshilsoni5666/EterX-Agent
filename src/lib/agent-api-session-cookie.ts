// Shared by the page middleware and Node API routes. Keep this module free
// of runtime/tool imports so the initial document can establish ownership.
export const AGENT_SESSION_COOKIE = 'eterx_agent_session';
export const AGENT_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export function isSafeAgentSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && /^[a-zA-Z0-9_.:-]+$/.test(value);
}

export function serializeAgentSessionCookie(sessionId: string, secure: boolean): string {
  return [
    `${AGENT_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${AGENT_SESSION_MAX_AGE}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}
